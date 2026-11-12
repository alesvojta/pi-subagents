import { assert, describe, it, writeExecutable, writeFileSync } from "../support/index.ts";
import { getMuxBackend, requireMuxBackend } from "../../src/mux/core.ts";
import { closeSurface, closeSurfaceAsync, readScreen, readScreenAsync, sendCommand, sendShellCommand } from "../../src/mux/io.ts";
import { createSurface, createSurfaceSplit, renameCurrentTab, renameWorkspace } from "../../src/mux/surfaces.ts";
import { createRexCommandSurface, waitForRexExit, rexChildTarget } from "../../src/mux/rex.ts";
import { pollForExit } from "../../src/mux/poll.ts";
import { REX_CHILD, REX_PARENT, REX_SESSION, useFakeRex } from "../support/rex.ts";

const mutations = (calls: string[][]) => calls.filter((args) => !args.includes("inspect") && !args.includes("capture") && !args.includes("events") &&
	!(args.includes("call") && (args.includes("size") || args.includes("process"))));

describe("native Rex backend", () => {
	it("selects Rex with only Rex caller markers even when Herdr is executable", () => {
		const f = useFakeRex();
		writeExecutable(f.dir, "herdr", "#!/bin/sh\necho 'must not probe Herdr' >&2\nexit 99\n");
		assert.equal(getMuxBackend(), "rex");
		process.env.PI_SUBAGENT_MUX = "rex";
		assert.equal(getMuxBackend(), "rex");
	});

	it("fails closed for mixed, incomplete, invalid, forced-conflicting and absent contexts", () => {
		for (const changes of [
			{ HERDR_ENV: "1" }, { HERDR_PANE_ID: "w1:p1" }, { HERDR_TAB_ID: "w1:t1" },
			{ REX_BLOCK: undefined }, { REX_SESSION: undefined }, { REX_BLOCK: "focused" },
			{ REX_SESSION: "work" }, { PI_SUBAGENT_MUX: "herdr" }, { PI_SUBAGENT_MUX: "tmux" },
			{ PI_SUBAGENT_MUX: "typo" }, { TMUX: "outer" },
			{ REX_SESSION: undefined, REX_BLOCK: undefined },
		]) {
			const f = useFakeRex();
			for (const [key, value] of Object.entries(changes)) {
				if (value === undefined) delete process.env[key]; else process.env[key] = value;
			}
			assert.equal(getMuxBackend(), null, JSON.stringify(changes));
			assert.throws(() => requireMuxBackend(), /No backend fallback/);
			assert.deepEqual(mutations(f.calls()), []);
		}
	});

	it("refuses stale, malformed, or wrong-owner caller lookup without mutation", () => {
		for (const state of [{ lookupFail: true }, { malformed: true }, { wrongBlock: true }, { wrongSession: true }]) {
			const f = useFakeRex();f.setState(state);
			assert.equal(getMuxBackend(), null);
			assert.throws(() => createRexCommandSurface("Child", ["pi"], "/project"));
			assert.deepEqual(mutations(f.calls()), []);
		}
	});

	it("creates exact argv beside explicit parent, preserving cwd and focus", () => {
		const f = useFakeRex();
		const argv = ["/path with spaces/node", "runner.mjs", "$(not shell); 'quoted'"];
		assert.equal(createRexCommandSurface("--Child label", argv, "/project with spaces"), REX_CHILD);
		const [call] = mutations(f.calls());
		assert.deepEqual(call, ["--autostart=false", "split", "-b", REX_PARENT, "--split", "right", "--ratio", "38", "--focus=false",
			"--keep-open", "--shell=none", "--label", "--Child label", "-c", "/project with spaces", "--json",
			"-s", REX_SESSION, "--", ...argv]);
	});

	it("never retries a failed or ambiguous creation in another backend", () => {
		for (const state of [{ splitFail: true }, { badAnchor: true }, { parentAsChild: true }]) {
			const f = useFakeRex();f.setState(state);
			assert.throws(() => createRexCommandSurface("Child", ["pi"], "/project"));
			assert.equal(mutations(f.calls()).length, 1);
		}
	});

	it("refuses shell-staged and pre-created surface paths rather than launching elsewhere", async () => {
		const f = useFakeRex();
		await assert.rejects(createSurface("Child"), /native command/);
		assert.throws(() => createSurfaceSplit("Child", "right"), /native command/);
		assert.throws(() => sendShellCommand(REX_CHILD, "pi"), /native argv/);
		assert.deepEqual(mutations(f.calls()), []);
	});

	it("scopes capture, input and close to child block and refuses parent control", async () => {
		const f = useFakeRex();
		assert.match(readScreen(REX_CHILD), /line two/);
		assert.match(await readScreenAsync(REX_CHILD), /line two/);
		sendCommand(REX_CHILD, "--text with quotes '");
		closeSurface(REX_CHILD);
		assert.throws(() => closeSurface(REX_PARENT), /caller's own block/);
		assert.throws(() => sendCommand(REX_PARENT, "oops"), /caller's own block/);
		assert.throws(() => closeSurface("--all"), /Invalid Rex/);
		for (const call of mutations(f.calls())) {
			assert.equal(call[0], "--autostart=false");
			assert.equal(call[call.indexOf("-s") + 1], REX_SESSION);
			assert.ok(call.includes(REX_CHILD));
			assert.ok(!call.includes(REX_PARENT));
		}
	});

	it("protects shared window/session names and only names an identified child block", () => {
		const f = useFakeRex();
		renameCurrentTab("Do not change manual parent title");renameWorkspace("Never rename project");
		assert.deepEqual(mutations(f.calls()), []);
		process.env.PI_SUBAGENT_NAME = "test-child";
		process.env.PI_SUBAGENT_SURFACE = REX_PARENT;
		process.env.PI_SUBAGENT_INITIAL_TITLE = "[worker] Initial task";
		f.setState({ label: "[s] [worker] Initial task" });
		renameCurrentTab("Child task");
		assert.deepEqual(mutations(f.calls()), [["--autostart=false", "block", "rename", "-s", REX_SESSION,
			"--", REX_PARENT, "[s] [worker] Child task"]]);
		f.setState({ label: "[o] [worker] Child task" });
		renameCurrentTab("Next task");
		assert.equal(mutations(f.calls()).at(-1)?.at(-1), "[o] [worker] Next task");
		f.setState({ label: "[o] My manual title" });
		renameCurrentTab("Overwrite manual title");
		assert.equal(mutations(f.calls()).length, 2);
	});

	it("uses native exit status and preserves completion sidecar semantics", async () => {
		const f = useFakeRex();
		for (const exitCode of [0, 42]) {
			f.setState({ lastExit: { [REX_CHILD]: { exit_code: exitCode } } });
			assert.equal(await waitForRexExit(REX_CHILD, new AbortController().signal), exitCode);
		}
		f.setState({});
		const sessionFile = `${f.dir}/session.jsonl`;
		writeFileSync(`${sessionFile}.exit`, JSON.stringify({ type: "ping", name: "worker", message: "Need decision" }));
		const result = await pollForExit(REX_CHILD, new AbortController().signal, { interval: 20, sessionFile });
		assert.equal(result.reason, "ping");
		assert.equal(result.ping?.message, "Need decision");
		assert.ok(!f.calls().some((call) => call.includes("capture")), "native exit wait must not poll terminal output");
	});

	it("uses recorded child ownership after parent disappears without backend discovery", async () => {
		const f = useFakeRex();
		const owned = rexChildTarget({ sessionId: REX_SESSION, blockId: REX_PARENT }, REX_CHILD);
		f.setState({ parentGone: true, lastExit: { [REX_CHILD]: { exit_code: 0 } } });
		delete process.env.REX_SESSION;delete process.env.REX_BLOCK;
		assert.match(readScreen(REX_CHILD, 50, owned), /line two/);
		sendCommand(REX_CHILD, "message", owned);
		assert.equal((await pollForExit(REX_CHILD, new AbortController().signal, { interval: 10, rexTarget: owned })).exitCode, 0);
		await closeSurfaceAsync(REX_CHILD, undefined, owned);
		assert.throws(() => closeSurface(REX_PARENT, owned), /match saved ownership/);
		assert.throws(() => rexChildTarget({ sessionId: REX_SESSION, blockId: REX_PARENT }, REX_PARENT), /ownership/);
		assert.ok(!f.calls().some((args) => args.includes(REX_PARENT)));
	});
});
