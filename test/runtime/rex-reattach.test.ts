import { mkdirSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { routeSubagentOutcome } from "../../src/runtime/result-router.ts";
import {
	claimRexChildDelivery,
	getRexChildRecordsDir,
	readRexChildRecords,
	recordRexChild,
	setRexChildRecordScope,
} from "../../src/runtime/rex-child-records.ts";
import { reattachRexChildren } from "../../src/runtime/rex-reattach.ts";
import { shutdownSubagentsForParentExit } from "../../src/runtime/shutdown.ts";
import { runningSubagents } from "../../src/runtime/state.ts";
import {
	shutdownSubagentsForParentExit as shutdownWiredSubagents,
	startWidgetRefresh,
	watchSubagent,
	wireSubagentSteerBack,
} from "../../src/runtime/wiring.ts";
import type { RunningSubagent } from "../../src/types.ts";
import {
	ASSISTANT_MSG,
	afterEach,
	assert,
	createTestDir,
	describe,
	existsSync,
	it,
	join,
	resetSubagentStateForTest,
	SESSION_HEADER,
	writeFileSync,
} from "../support/index.ts";
import { REX_CHILD, REX_PARENT, REX_SESSION, useFakeRex } from "../support/rex.ts";

const PARENT = "parent-session-1";

async function until(condition: () => boolean, what: string, ms = 5000): Promise<void> {
	const deadline = Date.now() + ms;
	while (!condition()) {
		if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

function useParentScope(): string {
	process.env.PI_ARTIFACT_PROJECT_ROOT = createTestDir();
	const cwd = createTestDir();
	setRexChildRecordScope({ cwd, sessionId: PARENT });
	return cwd;
}

function rexChild(patch: Partial<RunningSubagent> = {}): RunningSubagent {
	const sessionFile = join(createTestDir(), "child.jsonl");
	writeFileSync(sessionFile, `${[SESSION_HEADER, ASSISTANT_MSG].map((entry) => JSON.stringify(entry)).join("\n")}\n`);
	return {
		id: "abcd1234",
		name: "probe",
		task: "Say hi",
		mode: "interactive",
		executionState: "running",
		deliveryState: "detached",
		parentClosePolicy: "terminate",
		async: true,
		autoExit: true,
		startTime: Date.now(),
		sessionFile,
		launchEntryCount: 1,
		surface: REX_CHILD,
		rexTarget: { sessionId: REX_SESSION, blockId: REX_CHILD, parentBlockId: REX_PARENT },
		...patch,
	};
}

function recordOf(running: RunningSubagent): string {
	assert.ok(running.rexRecordFile, "the child has a record");
	return running.rexRecordFile;
}

function fakePi() {
	const messages: Array<{ customType: string; content: string }> = [];
	const pi = { sendMessage: (message: { customType: string; content: string }) => messages.push(message) };
	return { pi: pi as unknown as ExtensionAPI, messages };
}

const wiredRuntime = {
	watchSubagent,
	wireSubagentSteerBack,
	getContextWindow: () => undefined,
	startWidgetRefresh,
	updateWidget() {},
};

/** Launch-path watch of a recorded child, as the subagent tool wires it. */
function watchLaunched(pi: ExtensionAPI, running: RunningSubagent): void {
	const abort = new AbortController();
	running.abortController = abort;
	running.completionPromise = watchSubagent(running, abort.signal);
	runningSubagents.set(running.id, running);
	wireSubagentSteerBack(pi, running, running.completionPromise);
}

describe("Rex child records", () => {
	afterEach(() => {
		setRexChildRecordScope(undefined);
		resetSubagentStateForTest();
	});

	it("records Rex pane children in the parent session's own directory and claims each once", () => {
		const cwd = useParentScope();
		const running = rexChild();
		recordRexChild(running);
		assert.equal(running.rexRecordFile, join(getRexChildRecordsDir(cwd, PARENT), "abcd1234.json"));
		assert.deepEqual(readRexChildRecords(cwd, PARENT).map(({ record }) => record.child.surface), [REX_CHILD]);
		assert.deepEqual(readRexChildRecords(cwd, "other-session"), []);
		assert.equal(claimRexChildDelivery(running), true);
		assert.equal(claimRexChildDelivery(running), false, "a second claim must lose");
		assert.deepEqual(readRexChildRecords(cwd, PARENT), []);
	});

	it("does not record children it could never reattach", () => {
		useParentScope();
		const background = rexChild({ mode: "background" });
		const otherMux = rexChild({ rexTarget: undefined, surface: "pane:1" });
		recordRexChild(background);
		recordRexChild(otherMux);
		assert.equal(background.rexRecordFile, undefined);
		assert.equal(otherMux.rexRecordFile, undefined);
		setRexChildRecordScope(undefined);
		const unscoped = rexChild();
		recordRexChild(unscoped);
		assert.equal(unscoped.rexRecordFile, undefined);
		assert.equal(claimRexChildDelivery(unscoped), true, "an unrecorded child always delivers");
	});

	it("never adopts a record another session wrote or whose pane ownership does not check out", () => {
		const cwd = useParentScope();
		const dir = getRexChildRecordsDir(cwd, PARENT);
		mkdirSync(dir, { recursive: true });
		const write = (file: string, parentSessionId: string, child: Partial<RunningSubagent>) =>
			writeFileSync(join(dir, file), JSON.stringify({ version: 1, parentSessionId, child: { ...rexChild(), ...child } }));
		write("aaaa0001.json", "someone-else", { id: "aaaa0001" });
		write("aaaa0002.json", PARENT, { id: "aaaa0003" });
		write("aaaa0004.json", PARENT, { id: "aaaa0004", surface: "block:33333333-3333-4333-8333-999999999999" });
		write("aaaa0005.json", PARENT, {
			id: "aaaa0005",
			rexTarget: { sessionId: REX_SESSION, blockId: REX_CHILD, parentBlockId: REX_CHILD },
		});
		write("../escape.json", PARENT, { id: "escape" });
		writeFileSync(join(dir, "aaaa0006.json"), "{not json");
		write("aaaa0007.json", PARENT, { id: "aaaa0007" });
		assert.deepEqual(readRexChildRecords(cwd, PARENT).map(({ record }) => record.child.id), ["aaaa0007"]);
	});
});

describe("Rex child handoff on parent shutdown", () => {
	afterEach(() => {
		setRexChildRecordScope(undefined);
		resetSubagentStateForTest();
	});

	async function shutDown(running: RunningSubagent, reason: string) {
		let closed = 0;
		const actions = await shutdownSubagentsForParentExit(
			{
				runningSubagents: new Map([[running.id, running]]),
				completedSubagentResults: new Map(),
				parentCloseEscalationMs: 10,
				updateWidget() {},
				async closeRunningSurface() {
					closed++;
				},
			},
			{ reason },
		);
		return { actions, closed };
	}

	it("keeps a recorded Rex child running across a reload whatever its close policy", async () => {
		useParentScope();
		const running = rexChild({ abortController: new AbortController() });
		recordRexChild(running);
		const { actions, closed } = await shutDown(running, "reload");
		assert.deepEqual(actions, [{ id: running.id, policy: "terminate", action: "continue" }]);
		assert.equal(closed, 0, "the pane must stay open");
		assert.equal(running.rexHandedOff, true);
		assert.equal(running.abortController?.signal.aborted, true, "this parent stops watching");
		assert.ok(existsSync(recordOf(running)), "the record waits for the reloaded parent");
	});

	it("terminates a recorded child on quit and drops its record, unless its policy is continue", async () => {
		useParentScope();
		const terminated = rexChild({ abortController: new AbortController() });
		recordRexChild(terminated);
		const quit = await shutDown(terminated, "quit");
		assert.equal(quit.closed, 1);
		assert.equal(existsSync(recordOf(terminated)), false);

		const kept = rexChild({ id: "abcd5678", parentClosePolicy: "continue", abortController: new AbortController() });
		recordRexChild(kept);
		const quitContinue = await shutDown(kept, "quit");
		assert.equal(quitContinue.closed, 0);
		assert.equal(kept.rexHandedOff, true);
		assert.ok(existsSync(recordOf(kept)));
	});

	it("still terminates unrecorded interactive children on reload", async () => {
		const running = rexChild({ rexTarget: undefined, surface: "pane:1", abortController: new AbortController() });
		const { closed } = await shutDown(running, "reload");
		assert.equal(closed, 1);
	});
});

describe("Rex child result routing", () => {
	afterEach(() => {
		setRexChildRecordScope(undefined);
		resetSubagentStateForTest();
	});

	const result = { name: "probe", task: "Say hi", summary: "hi", exitCode: 0, elapsed: 1 };

	it("delivers once and removes the record", () => {
		useParentScope();
		const { pi, messages } = fakePi();
		const running = rexChild();
		recordRexChild(running);
		routeSubagentOutcome({ pi, running, result, formatElapsed: String, updateWidget() {} });
		assert.equal(messages.length, 1);
		assert.equal(existsSync(recordOf(running)), false);
	});

	it("delivers nothing for a handed-off child or one another parent already delivered", () => {
		useParentScope();
		const { pi, messages } = fakePi();
		const handedOff = rexChild({ rexHandedOff: true });
		recordRexChild(handedOff);
		routeSubagentOutcome({ pi, running: handedOff, result, formatElapsed: String, updateWidget() {} });
		assert.ok(existsSync(recordOf(handedOff)), "the record stays for the next parent");

		const delivered = rexChild({ id: "abcd5678" });
		recordRexChild(delivered);
		claimRexChildDelivery(delivered);
		routeSubagentOutcome({ pi, running: delivered, result, formatElapsed: String, updateWidget() {} });
		assert.equal(messages.length, 0);
	});
});

describe("Rex child reattach", () => {
	afterEach(() => {
		setRexChildRecordScope(undefined);
		resetSubagentStateForTest();
	});

	it("delivers a child that finished while no parent watched, from Rex's last_exit, exactly once", async () => {
		const f = useFakeRex();
		const cwd = useParentScope();
		recordRexChild(rexChild());
		f.setState({ lastExit: { [REX_CHILD]: { exit_code: 0, error: null } } });
		const { pi, messages } = fakePi();
		const [running] = reattachRexChildren(pi, { cwd, sessionId: PARENT }, wiredRuntime);
		assert.equal(running?.blocking, false);
		assert.ok(runningSubagents.has("abcd1234"), "the reattached child is in the widget registry");
		await running.completionPromise;
		await until(() => messages.length === 1, "the delivery");
		assert.match(messages[0].content, /completed[\s\S]*Here is my outline/);
		assert.equal(runningSubagents.size, 0);
		assert.deepEqual(reattachRexChildren(pi, { cwd, sessionId: PARENT }, wiredRuntime), []);
		assert.equal(messages.length, 1);
	});

	it("reports a pane that disappeared only from Rex's exact not-found answer", async () => {
		const f = useFakeRex();
		const cwd = useParentScope();
		recordRexChild(rexChild({ autoExit: false }));
		f.setState({ probeError: true });
		const { pi, messages } = fakePi();
		const [running] = reattachRexChildren(pi, { cwd, sessionId: PARENT }, wiredRuntime);
		await new Promise((resolve) => setTimeout(resolve, 700));
		assert.equal(messages.length, 0, "a transport error is not an exit");
		assert.ok(runningSubagents.has(running.id));
		f.setState({ closedBlocks: [REX_CHILD] });
		f.blockClosed(REX_CHILD);
		await until(() => messages.length === 1, "the closed-pane report");
		assert.match(messages[0].content, /closed/);
		assert.deepEqual(readRexChildRecords(cwd, PARENT), []);
	});

	it("survives a reload mid-run: the old watcher leaves the pane, the new one delivers once", async () => {
		const f = useFakeRex();
		const cwd = useParentScope();
		const before = fakePi();
		const launched = rexChild();
		watchLaunched(before.pi, launched);
		assert.ok(launched.rexRecordFile, "the watch records the child");
		await until(() => f.eventPids().length === 1, "the first watcher's stream");

		await shutdownWiredSubagents({ reason: "reload" });
		await launched.completionPromise;
		assert.ok(!f.calls().some((call) => call.includes("close")), "the reload must not close the child's pane");

		const after = fakePi();
		const [reattached] = reattachRexChildren(after.pi, { cwd, sessionId: PARENT }, wiredRuntime);
		assert.equal(reattached?.id, launched.id);
		await until(() => f.eventPids().length === 2, "the reattached watcher's stream");
		f.childExited(REX_CHILD, 0);
		await until(() => after.messages.length === 1, "the delivery");
		await new Promise((resolve) => setTimeout(resolve, 50));
		assert.equal(before.messages.length, 0);
		assert.equal(after.messages.length, 1);
		assert.match(after.messages[0].content, /Here is my outline/);
	});
});
