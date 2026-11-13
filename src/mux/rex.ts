import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { watchRexChildExit } from "./rex-events.ts";
import {
	planRexAutoPlacement,
	type RexBlockGeometry,
	type RexPlacementContext,
	type RexPlacementPolicy,
	resolveRexPlacementPolicy,
	rexLayoutGeometry,
} from "./rex-placement.ts";

const execAsync = promisify(execFile);
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const SESSION = new RegExp(`^session:${UUID}$`, "i");
const BLOCK = new RegExp(`^block:${UUID}$`, "i");
const WINDOW = new RegExp(`^window:${UUID}$`, "i");
const OPTIONS = { encoding: "utf8" as const, timeout: 15_000, maxBuffer: 16 * 1024 * 1024 };

export interface RexTarget {
	sessionId: string;
	blockId: string;
}

/** Captured at creation, never reconstructed from a focused block or a later caller. */
export interface RexChildTarget extends RexTarget {
	parentBlockId: string;
}

export function rexChildTarget(parent: RexTarget, blockId: string): RexChildTarget {
	if (!SESSION.test(parent.sessionId) || !BLOCK.test(parent.blockId) || !BLOCK.test(blockId) || blockId === parent.blockId) {
		throw new Error("Invalid Rex child ownership");
	}
	return { sessionId: parent.sessionId, blockId, parentBlockId: parent.blockId };
}

export function rexCaller(env: NodeJS.ProcessEnv = process.env): RexTarget | null {
	if (!SESSION.test(env.REX_SESSION ?? "") || !BLOCK.test(env.REX_BLOCK ?? "")) return null;
	if (["HERDR_ENV", "HERDR_PANE_ID", "HERDR_TAB_ID"].some((key) => env[key] !== undefined)) return null;
	return { sessionId: env.REX_SESSION!, blockId: env.REX_BLOCK! };
}

function scopedArgs(target: RexTarget, args: string[]): string[] {
	if (!SESSION.test(target.sessionId) || !BLOCK.test(target.blockId)) throw new Error("Invalid Rex session/block identity");
	return ["--autostart=false", ...args, "-s", target.sessionId];
}

function json(target: RexTarget, args: string[]): any {
	return JSON.parse(execFileSync("rex", scopedArgs(target, args), OPTIONS));
}

export function inspectRexBlock(target: RexTarget): { block_id: string; window_id: string; label?: string } {
	const value = json(target, ["block", "inspect", target.blockId, "--json"]);
	if (value?.session_id !== target.sessionId || value?.block?.block_id !== target.blockId ||
		!WINDOW.test(value?.block?.window_id ?? "")) {
		throw new Error("Rex did not return the requested block in its owning session");
	}
	return value.block;
}

export function requireRexCaller(): RexTarget {
	const target = rexCaller();
	if (!target) throw new Error("Rex requires an unambiguous REX_SESSION and REX_BLOCK; no backend fallback is allowed");
	inspectRexBlock(target);
	return target;
}

export function isRexRuntimeAvailable(hasCommand: (command: string) => boolean): boolean {
	if (!rexCaller() || !hasCommand("rex")) return false;
	try { requireRexCaller(); return true; } catch { return false; }
}

function childTarget(surface: string, owned?: RexChildTarget): RexTarget {
	let target: RexTarget;
	if (owned) {
		// Saved ownership allows cleanup after the parent has gone. Validate the child, not the parent.
		rexChildTarget({ sessionId: owned.sessionId, blockId: owned.parentBlockId }, owned.blockId);
		if (surface !== owned.blockId) throw new Error("Rex child surface does not match saved ownership");
		target = owned;
	} else {
		const caller = requireRexCaller();
		if (surface === caller.blockId) throw new Error("Refusing to control the Rex caller's own block as a child");
		target = { sessionId: caller.sessionId, blockId: surface };
	}
	inspectRexBlock(target);
	return target;
}

interface RexOwnedBlock {
	blockId: string;
	windowId: string;
}

interface RexPlacementGroup {
	blocks: RexOwnedBlock[];
	windows: number;
}

const placementGroups = new Map<string, RexPlacementGroup>();

function placementGroupKey(caller: RexTarget, policy: RexPlacementPolicy, windowTitle: string): string {
	const parentSession =
		process.env.PI_SUBAGENT_SESSION ?? process.env.PI_SUBAGENT_PARENT_SESSION ?? `process:${process.pid}`;
	return `${parentSession}\0${caller.sessionId}\0${caller.blockId}\0${policy}\0${windowTitle}`;
}

/**
 * Geometry only chooses placement; a failed lookup means "do not split", never "block is gone".
 * Stderr is captured because a failure here is an expected answer, not a launch error.
 */
function rexSessionGeometry(caller: RexTarget): Map<string, RexBlockGeometry> {
	const quiet = { ...OPTIONS, stdio: "pipe" as const };
	try {
		const session = JSON.parse(execFileSync("rex", ["--autostart=false", "session", "inspect", caller.sessionId, "--json"], quiet));
		const size = JSON.parse(execFileSync("rex", scopedArgs(caller, ["block", "call", "-b", caller.blockId, "size"]), quiet));
		return rexLayoutGeometry(session, caller, size);
	} catch {
		return new Map();
	}
}

function splitRexBlock(caller: RexTarget, anchor: string, direction: "right" | "below", share: number,
	name: string, argv: string[], cwd: string): string {
	const args = scopedArgs(caller, ["split", "-b", anchor, "--split", direction, "--ratio", String(share),
		"--focus=false", "--keep-open", "--shell=none", "--label", name, "-c", cwd, "--json"]);
	const result = JSON.parse(execFileSync("rex", [...args, "--", ...argv], OPTIONS));
	const surface = result?.block_ids?.[0];
	if (!BLOCK.test(surface ?? "") || surface === anchor || surface === caller.blockId || result?.anchor_id !== anchor ||
		(result.session_id !== undefined && result.session_id !== caller.sessionId)) {
		// Never guess a target or retry a creation with an ambiguous result.
		throw new Error("Rex split returned an invalid child/anchor identity; inspect Rex before retrying");
	}
	return surface;
}

function createRexWindowSurface(caller: RexTarget, title: string, name: string, argv: string[], cwd: string): RexOwnedBlock {
	const args = scopedArgs(caller, ["window", "new", title, "--focus=false", "--keep-open", "--shell=none",
		"-c", cwd, "--json"]);
	const result = JSON.parse(execFileSync("rex", [...args, "--", ...argv], OPTIONS));
	const surface = result?.block_ids?.[0];
	if (!BLOCK.test(surface ?? "") || surface === caller.blockId || !WINDOW.test(result?.window_id ?? "") ||
		(result.session_id !== undefined && result.session_id !== caller.sessionId)) {
		throw new Error("Rex window returned an invalid child identity; inspect Rex before retrying");
	}
	try {
		execFileSync("rex", [...scopedArgs(caller, ["block", "rename"]), "--", surface, name], OPTIONS);
	} catch {
		// The child is already running. A missing label is cosmetic; closing would kill the child.
	}
	return { blockId: surface, windowId: result.window_id };
}

/** Start the existing capsule runner directly. No shell input, startup delay, or focus transaction. */
export function createRexCommandSurface(
	name: string,
	argv: string[],
	cwd: string,
	placement?: RexPlacementContext,
): string {
	const caller = requireRexCaller();
	if (argv.length === 0) throw new Error("Rex child launch requires an explicit command");
	const policy = resolveRexPlacementPolicy(placement?.policy ?? process.env.PI_SUBAGENT_REX_PLACEMENT);
	if (policy === "tab") return createRexWindowSurface(caller, name, name, argv, cwd).blockId;
	if (policy !== "auto") return splitRexBlock(caller, caller.blockId, policy === "down" ? "below" : "right", 50, name, argv, cwd);

	const windowTitle = placement?.windowTitle ?? "Agents";
	const key = placementGroupKey(caller, policy, windowTitle);
	const group = placementGroups.get(key);
	const geometry = rexSessionGeometry(caller);
	// A block the user moved to another window is theirs now; never split it again.
	const owned = (group?.blocks ?? []).flatMap((block) => {
		const live = geometry.get(block.blockId);
		return live?.windowId === block.windowId ? [live] : [];
	});
	const parent = owned.length || placement?.ownWindow ? null : (geometry.get(caller.blockId) ?? null);
	const plan = planRexAutoPlacement({ parent, owned });
	// Window numbering restarts once every earlier child block is gone.
	let windows = owned.length ? (group?.windows ?? 0) : 0;
	let created: RexOwnedBlock;
	const anchor = plan.kind === "split" ? [parent, ...owned].find((block) => block?.blockId === plan.anchor) : undefined;
	if (plan.kind === "split" && anchor) {
		created = { blockId: splitRexBlock(caller, anchor.blockId, plan.direction, plan.share, name, argv, cwd), windowId: anchor.windowId };
	} else {
		windows += 1;
		created = createRexWindowSurface(caller, windows > 1 ? `${windowTitle} ${windows}` : windowTitle, name, argv, cwd);
	}
	placementGroups.set(key, { blocks: [...owned, created].map(({ blockId, windowId }) => ({ blockId, windowId })), windows });
	return created.blockId;
}

export function sendRexCommand(surface: string, command: string, owned?: RexChildTarget): void {
	const target = childTarget(surface, owned);
	if (command) execFileSync("rex", [...scopedArgs(target, ["send", "-b", surface]), "--", command], OPTIONS);
	execFileSync("rex", scopedArgs(target, ["send-key", "-b", surface, "enter"]), OPTIONS);
}

export function readRexScreen(surface: string, owned?: RexChildTarget): string {
	const target = childTarget(surface, owned);
	return execFileSync("rex", scopedArgs(target, ["capture", "-b", surface, "--trim", "--unwrap"]), OPTIONS);
}

export async function readRexScreenAsync(surface: string, owned?: RexChildTarget): Promise<string> {
	const target = childTarget(surface, owned);
	const { stdout } = await execAsync("rex", scopedArgs(target, ["capture", "-b", surface, "--trim", "--unwrap"]), OPTIONS);
	return stdout;
}

export function closeRexSurface(surface: string, owned?: RexChildTarget): void {
	const target = childTarget(surface, owned);
	execFileSync("rex", scopedArgs(target, ["block", "close", surface]), OPTIONS);
}

/** Event-driven: one shared `rex events` stream per session reports the exit, including with --keep-open. */
export async function waitForRexExit(surface: string, signal: AbortSignal, owned?: RexChildTarget): Promise<number> {
	const target = childTarget(surface, owned);
	return watchRexChildExit(target, signal);
}

const managedChildTitles = new Map<string, string>();
const titleBody = (title: string) => title.replace(/^(?:\[[^\]]+\]\s*)+/, "").trim();

/** Optional title tool changes only its launch-owned label, preserving manual edits and existing tags. */
export function renameRexChild(title: string): boolean {
	const caller = requireRexCaller();
	if (!process.env.PI_SUBAGENT_NAME || process.env.PI_SUBAGENT_SURFACE !== caller.blockId) return false;
	const current = inspectRexBlock(caller).label ?? "";
	const key = `${caller.sessionId}:${caller.blockId}`;
	const expected = managedChildTitles.get(key) ?? process.env.PI_SUBAGENT_INITIAL_TITLE;
	if (expected === undefined || titleBody(current) !== titleBody(expected)) return false;
	const tags = current.match(/^(?:\[[^\]]+\]\s*)+/)?.[0].trim();
	const next = tags ? `${tags} ${titleBody(title)}`.trim() : title.trim();
	execFileSync("rex", [...scopedArgs(caller, ["block", "rename"]), "--", caller.blockId, next], OPTIONS);
	managedChildTitles.set(key, next);
	return true;
}

/** The owned pane no longer exists: Rex answered `not found` for exactly that block. */
export class RexPaneGoneError extends Error {
	constructor(blockId: string) {
		super(`Rex pane ${blockId} no longer exists`);
		this.name = "RexPaneGoneError";
	}
}

/**
 * Focus an owned child or job pane, optionally zoomed to fill its window. The target is always
 * the saved full block ID with an explicit session, never a label, which can also name a window.
 * Placement is unaffected: later launches still anchor on the caller's REX_BLOCK.
 */
export function focusRexChild(owned: RexChildTarget, options: { zoom?: boolean } = {}): void {
	const caller = requireRexCaller();
	if (owned.sessionId !== caller.sessionId) throw new Error("Refusing to focus a pane from another Rex session");
	rexChildTarget({ sessionId: owned.sessionId, blockId: owned.parentBlockId }, owned.blockId);
	if (owned.blockId === caller.blockId) throw new Error("Refusing to focus the Rex caller's own block as a child");
	const quiet = { ...OPTIONS, stdio: "pipe" as const };
	const run = (args: string[]) => {
		try {
			execFileSync("rex", scopedArgs(owned, args), quiet);
		} catch (error) {
			const stderr = String((error as { stderr?: unknown })?.stderr ?? "");
			if (stderr.includes(`target "${owned.blockId}" not found`)) throw new RexPaneGoneError(owned.blockId);
			throw new Error(stderr.trim().replace(/^Error:\s*/, "") || (error as Error).message);
		}
	};
	run(["focus", owned.blockId]);
	if (options.zoom) run(["zoom", "-b", owned.blockId, "--on"]);
}
