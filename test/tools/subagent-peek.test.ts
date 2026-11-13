import { rexChildTarget } from "../../src/mux/rex.ts";
import { completedSubagentResults, runningSubagents } from "../../src/runtime/state.ts";
import { cleanPeekScreen, PEEK_MAX_CHARS, peekSubagent } from "../../src/tools/subagent-peek.ts";
import { registerSubagentsView } from "../../src/tools/subagents-view.ts";
import {
	afterEach,
	assert,
	describe,
	it,
	resetSubagentStateForTest,
	setRunningSubagentForTest,
} from "../support/index.ts";
import { REX_CHILD, REX_PARENT, REX_SECOND_CHILD, REX_SESSION, useFakeRex } from "../support/rex.ts";

function runningChild(id: string, name: string, blockId?: string, extra: Record<string, unknown> = {}) {
	setRunningSubagentForTest({
		id,
		name,
		task: "Explore",
		mode: blockId ? "interactive" : "background",
		executionState: "running",
		deliveryState: "detached",
		parentClosePolicy: "terminate",
		startTime: Date.now(),
		sessionFile: `/tmp/${id}.jsonl`,
		...(blockId ? { surface: blockId, rexTarget: rexChildTarget({ sessionId: REX_SESSION, blockId: REX_PARENT }, blockId) } : {}),
		...extra,
	} as any);
}

const captureCalls = (f: ReturnType<typeof useFakeRex>) => f.calls().filter((args) => args[1] === "capture");

describe("subagent peek", () => {
	afterEach(() => {
		resetSubagentStateForTest();
	});

	it("returns the tail of a Rex child's screen through its saved block", async () => {
		const f = useFakeRex();
		runningChild("a1b2c3d4", "scout", REX_CHILD);
		runningChild("e5f6a7b8", "worker", REX_SECOND_CHILD);
		const lines = Array.from({ length: 60 }, (_, i) => `step ${i + 1}`);
		f.updateState(() => ({ screen: `${lines.join("\n")}\n${"─".repeat(80)}\n\u001b[1m> \u001b[0m` }));

		const text = await peekSubagent("scout", 3);
		assert.match(text, /^Last 3 screen lines of the subagent "scout" \(a1b2c3d4\):\n\nstep 59\nstep 60\n>\n\n/);
		assert.match(text, /still running; its result is delivered automatically/);
		assert.deepEqual(captureCalls(f), [["--autostart=false", "capture", "-b", REX_CHILD, "--trim", "--unwrap", "-s", REX_SESSION]]);

		assert.match(await peekSubagent("a1b2c3d4"), /^Last 40 screen lines/);
		assert.match(await peekSubagent("scout", 5000), /^Last 61 screen lines/);
		assert.match(await peekSubagent("scout", 0), /^Last 1 screen line of/);
	});

	it("drops decoration rows and terminal controls and caps the characters", () => {
		const screen = "\u001b[31mred\u001b[0m\r\n╭────╮\n\n\n│\n  ▀▀▀  \ntext   \n\n";
		assert.equal(cleanPeekScreen(screen, 40), "red\n\ntext");
		assert.equal(cleanPeekScreen(screen, 1), "text");
		const long = cleanPeekScreen("x".repeat(PEEK_MAX_CHARS * 2), 40);
		assert.equal(long.length, PEEK_MAX_CHARS);
		assert.ok(long.startsWith("…x"));
	});

	it("answers clearly for background, finished, gone, and unknown children", async () => {
		const f = useFakeRex();
		runningChild("bg000001", "headless", undefined, { activity: "running bash", lastAssistantText: "Checking the tests" });
		assert.equal(
			await peekSubagent("headless"),
			'The subagent "headless" (bg000001) runs in the background and has no terminal screen.\n' +
				"Current activity: running bash\nLatest assistant text:\nChecking the tests",
		);

		completedSubagentResults.set("d0d0d0d0", { id: "d0d0d0d0", name: "done-child" } as any);
		assert.match(await peekSubagent("done-child"), /"done-child" \(d0d0d0d0\) has already finished/);

		runningChild("d0d0d0d0", "done-child", REX_SECOND_CHILD);
		assert.match(await peekSubagent("d0d0d0d0"), /^Last 2 screen lines of the subagent "done-child"/, "a resumed child is read again");

		runningChild("a1b2c3d4", "scout", REX_CHILD);
		f.updateState(() => ({ closedBlocks: [REX_CHILD] }));
		assert.equal(await peekSubagent("scout"), 'The terminal pane of the subagent "scout" (a1b2c3d4) is gone.');

		f.updateState(() => ({ closedBlocks: [], captureFail: true }));
		await assert.rejects(peekSubagent("scout"), /Could not read the screen of the subagent "scout" \(a1b2c3d4\)/);
		await assert.rejects(peekSubagent("nobody"), /No running subagent matches "nobody"/);
	});

	it("reports a child that finished while its screen was being read", async () => {
		runningChild("a1b2c3d4", "scout", REX_CHILD);
		const text = await peekSubagent("scout", 10, async () => {
			runningSubagents.delete("a1b2c3d4");
			throw new Error("pane closed");
		});
		assert.match(text, /"scout" \(a1b2c3d4\) has already finished/);
	});

	it("/subagents peek shows the screen and rejects malformed arguments", async () => {
		const f = useFakeRex();
		runningChild("a1b2c3d4", "scout", REX_CHILD);
		f.updateState(() => ({ screen: "working on it" }));
		let handler: ((args: string, ctx: any) => Promise<void>) | undefined;
		registerSubagentsView(
			{ registerCommand: (_name: string, opts: any) => (handler = opts.handler), registerShortcut() {}, on() {} } as any,
			{} as any,
		);
		const notes: string[] = [];
		const ctx = { ui: { notify: (text: string) => notes.push(text) } };
		await handler!("peek scout", ctx);
		await handler!("peek scout 5", ctx);
		await handler!("peek scout lots", ctx);
		await handler!("peek", ctx);
		await handler!("peek nobody", ctx);
		assert.match(notes[0], /^Last 1 screen line of the subagent "scout" \(a1b2c3d4\):\n\nworking on it\n/);
		assert.match(notes[1], /^Last 1 screen line of/);
		assert.deepEqual(notes.slice(2), [
			"Usage: /subagents | /subagents focus <id|name> [--zoom] | /subagents peek <id|name> [lines]",
			"Usage: /subagents | /subagents focus <id|name> [--zoom] | /subagents peek <id|name> [lines]",
			'No running subagent matches "nobody".',
		]);
	});
});
