export type RexPlacementPolicy = "auto" | "right" | "down" | "tab";

export interface RexPlacementContext {
	policy?: RexPlacementPolicy;
	/** Title of the windows this group opens; defaults to "Agents". */
	windowTitle?: string;
	/** Never split the caller's block: the group lives only in its own windows. */
	ownWindow?: boolean;
}

export interface RexBlockGeometry {
	blockId: string;
	windowId: string;
	columns: number;
	rows: number;
}

/** `share` is the new block's percentage of the anchor, as `rex split --ratio` expects. */
export type RexPlacementPlan =
	| { kind: "split"; anchor: string; direction: "right" | "below"; share: number }
	| { kind: "window" };

type Rect = [x: number, y: number, width: number, height: number];

/** The parts of `rex session inspect --json` and `rex block call size` that placement reads. */
interface RexLayoutNode {
	block_id?: unknown;
	rect?: unknown;
	split?: { before?: RexLayoutNode; after?: RexLayoutNode };
}
interface RexSessionLayout {
	session_id?: unknown;
	windows?: { window_id?: unknown; layers?: { kind?: unknown; layout?: RexLayoutNode }[] }[];
}
interface RexBlockSize {
	columns?: unknown;
	rows?: unknown;
	desired?: unknown;
}

const isRect = (value: unknown): value is Rect =>
	Array.isArray(value) && value.length === 4 && value.every((n) => typeof n === "number" && Number.isFinite(n));

function collectTiledBlocks(node: RexLayoutNode | undefined, windowId: string, out: { blockId: string; windowId: string; rect: Rect }[]): void {
	if (!node || typeof node !== "object") return;
	if (typeof node.block_id === "string" && isRect(node.rect)) out.push({ blockId: node.block_id, windowId, rect: node.rect });
	collectTiledBlocks(node.split?.before, windowId, out);
	collectTiledBlocks(node.split?.after, windowId, out);
}

/**
 * Rex reports a default size for blocks no client has displayed, including every block in a window
 * created in the background. Measure the whole session against the caller's displayed size instead:
 * all windows share the client's viewport, and `session inspect` gives each tiled block as a fraction of it.
 * Returns no geometry when the caller is not displayed, so placement falls back to a window.
 */
export function rexLayoutGeometry(
	session: RexSessionLayout,
	caller: { sessionId: string; blockId: string },
	size: RexBlockSize,
): Map<string, RexBlockGeometry> {
	const geometry = new Map<string, RexBlockGeometry>();
	const { columns, rows } = size ?? {};
	if (session?.session_id !== caller.sessionId || !Array.isArray(size?.desired) || size.desired.length === 0 ||
		typeof columns !== "number" || typeof rows !== "number" || !Number.isSafeInteger(columns) ||
		!Number.isSafeInteger(rows)) return geometry;
	const blocks: { blockId: string; windowId: string; rect: Rect }[] = [];
	for (const window of Array.isArray(session.windows) ? session.windows : []) {
		if (typeof window?.window_id !== "string") continue;
		for (const layer of Array.isArray(window.layers) ? window.layers : []) {
			if (layer?.kind === "tiled") collectTiledBlocks(layer.layout, window.window_id, blocks);
		}
	}
	const parent = blocks.find((block) => block.blockId === caller.blockId);
	if (!parent || parent.rect[2] <= 0 || parent.rect[3] <= 0) return geometry;
	const viewport = { columns: columns / parent.rect[2], rows: rows / parent.rect[3] };
	for (const { blockId, windowId, rect } of blocks) {
		geometry.set(blockId, blockId === caller.blockId
			? { blockId, windowId, columns, rows }
			: { blockId, windowId, columns: Math.floor(viewport.columns * rect[2]), rows: Math.floor(viewport.rows * rect[3]) });
	}
	return geometry;
}

const DEFAULT_REX_MIN_COLUMNS = 50;
const DEFAULT_REX_MIN_ROWS = 12;

export function resolveRexPlacementPolicy(value = process.env.PI_SUBAGENT_REX_PLACEMENT): RexPlacementPolicy {
	const policy = value?.trim().toLowerCase() || "auto";
	if (policy === "auto" || policy === "right" || policy === "down" || policy === "tab") return policy;
	throw new Error(`Invalid PI_SUBAGENT_REX_PLACEMENT value "${value}". Expected auto, right, down, or tab.`);
}

function positiveInteger(name: string, fallback: number): number {
	const value = Number(process.env[name]);
	return Number.isInteger(value) && value > 0 ? value : fallback;
}

function rexMinimums(): { columns: number; rows: number } {
	return {
		columns: positiveInteger("PI_SUBAGENT_REX_MIN_COLUMNS", DEFAULT_REX_MIN_COLUMNS),
		rows: positiveInteger("PI_SUBAGENT_REX_MIN_ROWS", DEFAULT_REX_MIN_ROWS),
	};
}

function canSplit(
	block: RexBlockGeometry,
	direction: "right" | "below",
	share: number,
	minimums: { columns: number; rows: number },
): boolean {
	const span = direction === "right" ? block.columns : block.rows;
	const created = Math.floor((span * share) / 100);
	const kept = span - created;
	return direction === "right"
		? Math.min(created, kept) >= minimums.columns && block.rows >= minimums.rows
		: block.columns >= minimums.columns && Math.min(created, kept) >= minimums.rows;
}

/**
 * Same geometry rules as Herdr `auto`: the first child keeps 62% for the parent
 * when it can, later children halve the largest block this parent already owns,
 * and a window is used only when no split leaves both halves usable.
 */
export function planRexAutoPlacement(input: {
	parent: RexBlockGeometry | null;
	owned: RexBlockGeometry[];
	minimums?: { columns: number; rows: number };
}): RexPlacementPlan {
	const { parent, owned } = input;
	const minimums = input.minimums ?? rexMinimums();
	if (owned.length === 0) {
		if (!parent) return { kind: "window" };
		for (const direction of ["right", "below"] as const) {
			for (const share of [38, 50]) {
				if (canSplit(parent, direction, share, minimums)) return { kind: "split", anchor: parent.blockId, direction, share };
			}
		}
		return { kind: "window" };
	}
	const largestFirst = [...owned].sort((a, b) => b.columns * b.rows - a.columns * a.rows);
	for (const block of largestFirst) {
		const preferred = block.columns >= block.rows * 4 ? "right" : "below";
		for (const direction of [preferred, preferred === "right" ? "below" : "right"] as const) {
			if (canSplit(block, direction, 50, minimums)) return { kind: "split", anchor: block.blockId, direction, share: 50 };
		}
	}
	return { kind: "window" };
}
