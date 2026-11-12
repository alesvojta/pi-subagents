import { pollForExit } from "../../src/mux/poll.ts";
import { waitForRexExit } from "../../src/mux/rex.ts";
import { liveRexEventStreams, RexChildGoneError } from "../../src/mux/rex-events.ts";
import { assert, describe, it, writeFileSync } from "../support/index.ts";
import { REX_CHILD, REX_SECOND_CHILD, REX_SESSION, useFakeRex } from "../support/rex.ts";

const REX_THIRD_CHILD = "block:33333333-3333-4333-8333-000000000002";

async function until(condition: () => boolean, what: string, ms = 3000): Promise<void> {
	const deadline = Date.now() + ms;
	while (!condition()) {
		if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/** Tracks whether a promise settled without consuming its rejection. */
function track<T>(promise: Promise<T>) {
	const state = { settled: false, value: undefined as T | undefined, error: undefined as unknown };
	promise.then(
		(value) => { state.settled = true; state.value = value; },
		(error) => { state.settled = true; state.error = error; },
	);
	return state;
}

describe("shared Rex event stream", () => {
	it("watches N children through one rex events process and reaps it after the last exit", async () => {
		const f = useFakeRex();
		const waits = [REX_CHILD, REX_SECOND_CHILD, REX_THIRD_CHILD].map((block) =>
			waitForRexExit(block, new AbortController().signal),
		);
		await until(() => f.eventPids().length === 1, "the shared stream");
		f.childExited(REX_SECOND_CHILD, 3);
		f.childExited(REX_CHILD, 0);
		f.childExited(REX_THIRD_CHILD, 300);
		assert.deepEqual(await Promise.all(waits), [0, 3, 300 % 256]);
		assert.equal(f.eventPids().length, 1, "no second subscription for the same session");
		assert.ok(!f.calls().some((call) => call.includes("wait")), "no per-child rex wait");
		assert.equal(liveRexEventStreams(), 0);
		assert.equal(isAlive(f.eventPids()[0]), false);
	});

	it("ends a wait only on events for the exact watched block in this session", async () => {
		const f = useFakeRex();
		const pending = track(waitForRexExit(REX_CHILD, new AbortController().signal));
		await until(() => f.eventPids().length === 1, "the stream");
		f.childExited(REX_SECOND_CHILD, 9);
		f.blockClosed(REX_SECOND_CHILD);
		f.rawEvent("not json");
		f.rawEvent(JSON.stringify({ type: "session_event", payload: { session_id: "session:other", event: {
			type: "block_closed", payload: { block_id: REX_CHILD } } } }));
		await new Promise((resolve) => setTimeout(resolve, 100));
		assert.equal(pending.settled, false);
		f.blockClosed(REX_CHILD);
		await until(() => pending.settled, "the closed block");
		assert.ok(pending.error instanceof RexChildGoneError);
		assert.match((pending.error as Error).message, /closed before reporting an exit status/);
	});

	it("rejects exit statuses that are not a valid terminal status", async () => {
		const f = useFakeRex();
		const signalled = waitForRexExit(REX_CHILD, new AbortController().signal);
		await until(() => f.eventPids().length === 1, "the stream");
		f.childExited(REX_CHILD, -1);
		await assert.rejects(signalled, /terminated by a signal/);
		f.setState({ lastExit: { [REX_CHILD]: { exit_code: "0" } } });
		await assert.rejects(waitForRexExit(REX_CHILD, new AbortController().signal), /valid terminal exit status/);
	});

	it("never treats a dropped stream as an exit and reads a missed exit after reconnecting", async () => {
		const f = useFakeRex();
		const pending = track(waitForRexExit(REX_CHILD, new AbortController().signal));
		await until(() => f.eventPids().length === 1, "the first stream");
		f.setState({ eventsError: true });
		process.kill(f.eventPids()[0], "SIGKILL");
		await new Promise((resolve) => setTimeout(resolve, 700));
		assert.equal(pending.settled, false, "an outage is not an exit");
		// The child exits while the stream is down; only the reconnect probe can see it.
		f.setState({ lastExit: { [REX_CHILD]: { exit_code: 5 } } });
		await until(() => pending.settled, "the reconnect probe");
		assert.equal(pending.value, 5);
		assert.ok(f.calls().filter((call) => call.includes("events")).length >= 2, "it reconnected");
		assert.equal(liveRexEventStreams(), 0);
	});

	it("treats only Rex's exact not-found answer for the block as a closed pane", async () => {
		const f = useFakeRex();
		f.setState({ probeError: true });
		const pending = track(waitForRexExit(REX_CHILD, new AbortController().signal));
		await new Promise((resolve) => setTimeout(resolve, 700));
		assert.equal(pending.settled, false, "a transport error in the probe is not a closed pane");
		f.setState({ closedBlocks: [REX_CHILD] });
		process.kill(f.eventPids()[0], "SIGKILL");
		await until(() => pending.settled, "the reconnect probe");
		assert.ok(pending.error instanceof RexChildGoneError);
	});

	it("ends waits when Rex reports the whole session missing", async () => {
		const f = useFakeRex();
		f.setState({ sessionGone: true });
		await assert.rejects(waitForRexExit(REX_CHILD, new AbortController().signal), RexChildGoneError);
		assert.equal(liveRexEventStreams(), 0);
		assert.ok(f.calls().some((call) => call.includes("events") && call.includes(REX_SESSION)));
	});

	it("abort reaps even a SIGTERM-ignoring stream before rejecting", async () => {
		const f = useFakeRex();
		f.setState({ ignoreTerm: true });
		const controller = new AbortController();
		const pending = waitForRexExit(REX_CHILD, controller.signal);
		await until(() => f.eventPids().length === 1, "the stream");
		controller.abort();
		await assert.rejects(pending, /Aborted/);
		assert.equal(isAlive(f.eventPids()[0]), false);
		assert.equal(liveRexEventStreams(), 0);
	});

	it("keeps completion and ping signals ahead of the process exit", async () => {
		const f = useFakeRex();
		const sessionFile = `${f.dir}/live.jsonl`;
		const ping = pollForExit(REX_CHILD, new AbortController().signal, { interval: 10, sessionFile });
		await until(() => f.eventPids().length === 1, "the stream");
		writeFileSync(`${sessionFile}.exit`, JSON.stringify({ type: "ping", name: "worker", message: "Need decision now" }));
		assert.equal((await ping).reason, "ping");
		assert.equal(liveRexEventStreams(), 0);

		const done = pollForExit(REX_CHILD, new AbortController().signal, { interval: 10_000, sessionFile });
		await until(() => f.eventPids().length === 2, "the next stream");
		// subagent_done publishes its outcome right before the process exits.
		writeFileSync(`${sessionFile}.exit`, JSON.stringify({ type: "done", outputTokens: 9 }));
		f.childExited(REX_CHILD, 0);
		const result = await done;
		assert.equal(result.reason, "done");
		assert.equal(result.outputTokens, 9);
		assert.ok(!f.calls().some((call) => call.includes("capture")));
	});
});
