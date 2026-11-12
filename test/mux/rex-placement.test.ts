import { createRexCommandSurface } from "../../src/mux/rex.ts";
import {
	planRexAutoPlacement,
	type RexBlockGeometry,
	resolveRexPlacementPolicy,
	rexLayoutGeometry,
} from "../../src/mux/rex-placement.ts";
import { assert, describe, it } from "../support/index.ts";
import { REX_CHILD, REX_PARENT, REX_SECOND_CHILD, REX_SESSION, REX_WINDOW, useFakeRex } from "../support/rex.ts";

const minimums = { columns: 50, rows: 12 };
const block = (blockId: string, columns: number, rows: number): RexBlockGeometry => ({ blockId, windowId: REX_WINDOW, columns, rows });
const CHILD_3 = "block:33333333-3333-4333-8333-000000000002";
const CHILD_4 = "block:33333333-3333-4333-8333-000000000003";

/** Creations only: geometry lookups never change the layout. */
const creations = (calls: string[][]) => calls.filter((args) => args[1] === "split" || args[1] === "window" || args.includes("rename"));
const placement = (call: string[]) => call.slice(1, call.indexOf("--focus=false"));

describe("Rex auto placement plan", () => {
	it("gives the first child 38% beside the parent when both halves stay usable", () => {
		assert.deepEqual(planRexAutoPlacement({ parent: block(REX_PARENT, 200, 50), owned: [], minimums }),
			{ kind: "split", anchor: REX_PARENT, direction: "right", share: 38 });
	});

	it("falls back to an even split, then below, then a window for a small parent", () => {
		assert.deepEqual(planRexAutoPlacement({ parent: block(REX_PARENT, 120, 50), owned: [], minimums }),
			{ kind: "split", anchor: REX_PARENT, direction: "right", share: 50 });
		assert.deepEqual(planRexAutoPlacement({ parent: block(REX_PARENT, 90, 50), owned: [], minimums }),
			{ kind: "split", anchor: REX_PARENT, direction: "below", share: 38 });
		assert.deepEqual(planRexAutoPlacement({ parent: block(REX_PARENT, 80, 20), owned: [], minimums }), { kind: "window" });
		assert.deepEqual(planRexAutoPlacement({ parent: null, owned: [], minimums }), { kind: "window" });
	});

	it("halves the largest owned block along its long side and never re-splits the parent", () => {
		assert.deepEqual(planRexAutoPlacement({ parent: null, owned: [block("tall", 76, 35), block("small", 60, 14)], minimums }),
			{ kind: "split", anchor: "tall", direction: "below", share: 50 });
		assert.deepEqual(planRexAutoPlacement({ parent: null, owned: [block("wide", 200, 40)], minimums }),
			{ kind: "split", anchor: "wide", direction: "right", share: 50 });
		assert.deepEqual(planRexAutoPlacement({ parent: block(REX_PARENT, 300, 80), owned: [block("full", 76, 18)], minimums }),
			{ kind: "window" });
	});

	it("resolves policies case-insensitively, defaults to auto, and rejects typos", () => {
		assert.equal(resolveRexPlacementPolicy(undefined), "auto");
		assert.equal(resolveRexPlacementPolicy(" TAB "), "tab");
		assert.throws(() => resolveRexPlacementPolicy("right-stack"), /PI_SUBAGENT_REX_PLACEMENT/);
	});
});

describe("Rex layout geometry", () => {
	const caller = { sessionId: REX_SESSION, blockId: REX_PARENT };
	const displayed = { columns: 124, rows: 40, desired: [{ client_id: "client:app" }] };
	const session = {
		session_id: REX_SESSION,
		windows: [
			{ window_id: REX_WINDOW, layers: [{ kind: "tiled", layout: { rect: [0, 0, 1, 1], split: {
				before: { rect: [0, 0, 0.62, 1], block_id: REX_PARENT },
				after: { rect: [0.62, 0, 0.38, 1], block_id: REX_CHILD },
			} } }] },
			{ window_id: "window:agents", layers: [
				{ kind: "tiled", layout: { rect: [0, 0, 1, 1], block_id: REX_SECOND_CHILD } },
				{ kind: "floating", layout: { rect: [0.2, 0.2, 0.5, 0.5], block_id: "block:floating" } },
			] },
		],
	};

	it("measures every tiled block, including background windows, against the caller's viewport", () => {
		const geometry = rexLayoutGeometry(session, caller, displayed);
		assert.deepEqual(geometry.get(REX_PARENT), { blockId: REX_PARENT, windowId: REX_WINDOW, columns: 124, rows: 40 });
		assert.deepEqual(geometry.get(REX_CHILD), { blockId: REX_CHILD, windowId: REX_WINDOW, columns: 76, rows: 40 });
		assert.deepEqual(geometry.get(REX_SECOND_CHILD), { blockId: REX_SECOND_CHILD, windowId: "window:agents", columns: 200, rows: 40 });
		assert.equal(geometry.has("block:floating"), false);
	});

	it("reports nothing when the caller is not displayed or the session does not match", () => {
		assert.equal(rexLayoutGeometry(session, caller, { columns: 80, rows: 24, desired: [] }).size, 0);
		assert.equal(rexLayoutGeometry({ ...session, session_id: "session:other" }, caller, displayed).size, 0);
		assert.equal(rexLayoutGeometry(session, { ...caller, blockId: "block:missing" }, displayed).size, 0);
	});
});

describe("Rex placement launches", () => {
	it("fills the parent window, then opens one shared Agents window", () => {
		const f = useFakeRex();
		f.setState({ viewport: { columns: 198, rows: 35 } });
		assert.equal(createRexCommandSurface("one", ["pi"], "/p"), REX_CHILD);
		assert.equal(createRexCommandSurface("two", ["pi"], "/p"), REX_SECOND_CHILD);
		assert.equal(createRexCommandSurface("three", ["pi"], "/p"), CHILD_3);
		assert.equal(createRexCommandSurface("four", ["pi"], "/p"), CHILD_4);
		const calls = creations(f.calls());
		assert.deepEqual(placement(calls[0]), ["split", "-b", REX_PARENT, "--split", "right", "--ratio", "38"]);
		assert.deepEqual(placement(calls[1]), ["split", "-b", REX_CHILD, "--split", "below", "--ratio", "50"]);
		assert.deepEqual(placement(calls[2]), ["window", "new", "Agents"]);
		assert.deepEqual(calls[3], ["--autostart=false", "block", "rename", "-s", REX_SESSION, "--", CHILD_3, "three"]);
		assert.deepEqual(placement(calls[4]), ["split", "-b", CHILD_3, "--split", "right", "--ratio", "50"]);
	});

	it("leaves a block the user moved to another window alone", () => {
		const f = useFakeRex();
		createRexCommandSurface("one", ["pi"], "/p");
		f.updateState((state) => ({ windows: { ...state.windows, [REX_CHILD]: "window:55555555-5555-4555-8555-555555555555" } }));
		createRexCommandSurface("two", ["pi"], "/p");
		const calls = creations(f.calls());
		// The parent kept 62% of 200 columns, so only an even split leaves both halves usable.
		assert.deepEqual(placement(calls[1]), ["split", "-b", REX_PARENT, "--split", "right", "--ratio", "50"]);
	});

	it("opens a window when the caller's size is unknown or not displayed, without guessing a split", () => {
		for (const state of [{ sizeFail: true }, { unseen: true }]) {
			const f = useFakeRex();f.setState(state);
			assert.equal(createRexCommandSurface("one", ["pi"], "/p"), REX_CHILD);
			assert.deepEqual(placement(creations(f.calls())[0]), ["window", "new", "Agents"]);
		}
	});

	it("honours explicit policies, with the per-launch policy over the parent default", () => {
		const f = useFakeRex();
		process.env.PI_SUBAGENT_REX_PLACEMENT = "down";
		createRexCommandSurface("down", ["pi"], "/p");
		createRexCommandSurface("own tab", ["pi"], "/p", { policy: "tab" });
		const calls = creations(f.calls());
		assert.deepEqual(placement(calls[0]), ["split", "-b", REX_PARENT, "--split", "below", "--ratio", "50"]);
		assert.deepEqual(placement(calls[1]), ["window", "new", "own tab"]);
		assert.ok(!f.calls().some((args) => args.includes("size") || args[1] === "session"), "explicit policies need no geometry");
	});

	it("never retries a failed or ambiguous window creation", () => {
		const f = useFakeRex();f.setState({ sizeFail: true, windowFail: true });
		assert.throws(() => createRexCommandSurface("one", ["pi"], "/p"));
		assert.equal(creations(f.calls()).length, 1);
	});
});
