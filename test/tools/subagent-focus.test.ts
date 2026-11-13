import { rexChildTarget } from "../../src/mux/rex.ts";
import { SubagentsOverlayController as SubagentsOverlay } from "../../src/tools/overlay/index.ts";
import { focusSubagent } from "../../src/tools/subagent-focus.ts";
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

function runningChild(id: string, name: string, blockId?: string) {
	setRunningSubagentForTest({
		id,
		name,
		task: "Explore",
		mode: "interactive",
		executionState: "running",
		deliveryState: "detached",
		parentClosePolicy: "terminate",
		startTime: Date.now(),
		sessionFile: `/tmp/${id}.jsonl`,
		...(blockId ? { surface: blockId, rexTarget: rexChildTarget({ sessionId: REX_SESSION, blockId: REX_PARENT }, blockId) } : {}),
	} as any);
}

const focusCalls = (f: ReturnType<typeof useFakeRex>) => f.calls().filter((args) => args[1] === "focus" || args[1] === "zoom");

describe("subagent pane focus", () => {
	afterEach(() => {
		resetSubagentStateForTest();
	});

	it("focuses a running child's saved Rex pane by ID or unique name", () => {
		const f = useFakeRex();
		runningChild("a1b2c3d4", "scout", REX_CHILD);
		runningChild("e5f6a7b8", "worker", REX_SECOND_CHILD);
		runningChild("c0ffee00", "worker", REX_SECOND_CHILD);
		runningChild("bg000001", "headless");

		focusSubagent("a1b2c3d4");
		focusSubagent("scout", { zoom: true });
		focusSubagent("e5f6a7b8");
		assert.deepEqual(focusCalls(f), [
			["--autostart=false", "focus", REX_CHILD, "-s", REX_SESSION],
			["--autostart=false", "focus", REX_CHILD, "-s", REX_SESSION],
			["--autostart=false", "zoom", "-b", REX_CHILD, "--on", "-s", REX_SESSION],
			["--autostart=false", "focus", REX_SECOND_CHILD, "-s", REX_SESSION],
		]);

		assert.throws(() => focusSubagent("worker"), /Several running subagents are named worker; use the ID \(e5f6a7b8, c0ffee00\)/);
		assert.throws(() => focusSubagent("headless"), /has no Rex pane/);
		assert.throws(() => focusSubagent("deadbeef"), /No running subagent deadbeef in this session/);
		f.updateState(() => ({ closedBlocks: [REX_CHILD] }));
		assert.throws(() => focusSubagent("scout"), /pane of subagent scout \(a1b2c3d4\) is gone/);
		delete process.env.REX_SESSION;
		assert.throws(() => focusSubagent("scout"), /needs Rex/);
		assert.equal(focusCalls(f).length, 5, "only the gone pane's focus attempt reaches Rex");
	});

	it("closes the overlay with a focus request for f and z on a child with a Rex pane", () => {
		useFakeRex();
		runningChild("a1b2c3d4", "scout", REX_CHILD);
		const results: unknown[] = [];
		const open = () =>
			new SubagentsOverlay(
				(result) => results.push(result),
				{ cwd: "/tmp", ui: { notify() {} }, sessionManager: { getSessionFile: () => null } } as any,
				{ fg: (_t, text) => text, bg: (_c, text) => text, bold: (text) => text },
				{ startWidgetRefresh() {}, pi: { on() {} } } as any,
				{ requestRender() {}, terminal: { columns: 80 } } as any,
			);
		const overlay = open();
		assert.match(overlay.render(100).join("\n"), /f\/z focus\/zoom/);
		overlay.handleInput("z");
		open().handleInput("f");
		assert.deepEqual(results, [
			{ kind: "focus", id: "a1b2c3d4", zoom: true },
			{ kind: "focus", id: "a1b2c3d4", zoom: false },
		]);

		resetSubagentStateForTest();
		runningChild("bg000001", "headless");
		const headless = open();
		assert.doesNotMatch(headless.render(100).join("\n"), /focus/);
		headless.handleInput("f");
		assert.equal(results.length, 2);
		headless.dispose();
	});

	it("/subagents focus focuses the child and rejects malformed arguments", async () => {
		const f = useFakeRex();
		runningChild("a1b2c3d4", "scout", REX_CHILD);
		let handler: ((args: string, ctx: any) => Promise<void>) | undefined;
		registerSubagentsView(
			{ registerCommand: (_name: string, opts: any) => (handler = opts.handler), registerShortcut() {}, on() {} } as any,
			{} as any,
		);
		const notes: string[] = [];
		const ctx = { ui: { notify: (text: string) => notes.push(text) } };
		await handler!("focus scout --zoom", ctx);
		await handler!("focus", ctx);
		await handler!("focus scout --zoom extra", ctx);
		await handler!("focus nobody", ctx);
		assert.deepEqual(focusCalls(f), [
			["--autostart=false", "focus", REX_CHILD, "-s", REX_SESSION],
			["--autostart=false", "zoom", "-b", REX_CHILD, "--on", "-s", REX_SESSION],
		]);
		assert.deepEqual(notes, [
			"Usage: /subagents | /subagents focus <id|name> [--zoom] | /subagents peek <id|name> [lines]",
			"Usage: /subagents | /subagents focus <id|name> [--zoom] | /subagents peek <id|name> [lines]",
			"No running subagent nobody in this session",
		]);
	});
});
