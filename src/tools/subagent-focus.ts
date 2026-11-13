import { focusRexChild, RexPaneGoneError, rexCaller } from "../mux/rex.ts";
import { runningSubagents } from "../runtime/state.ts";
import type { RunningSubagent } from "../types.ts";

/**
 * Focuses a running child's Rex pane for the user. Only children this parent launched
 * (its running registry) are reachable, and the target is their saved `rexTarget`.
 */

/** True when the overlay can offer focus for this child. */
export function canFocusSubagent(running: RunningSubagent): boolean {
	return Boolean(running.rexTarget && rexCaller());
}

/** A running child of this parent by ID, or by name when exactly one child has it. */
function findRunningSubagent(ref: string): RunningSubagent {
	const byId = runningSubagents.get(ref);
	if (byId) return byId;
	const named = [...runningSubagents.values()].filter((running) => running.name === ref);
	if (named.length === 1) return named[0];
	if (named.length > 1) throw new Error(`Several running subagents are named ${ref}; use the ID (${named.map((r) => r.id).join(", ")})`);
	throw new Error(`No running subagent ${ref || "(empty id)"} in this session`);
}

export function focusSubagent(ref: string, options: { zoom?: boolean } = {}): RunningSubagent {
	if (!rexCaller()) throw new Error("Focusing a subagent pane needs Rex");
	const running = findRunningSubagent(ref.trim());
	if (!running.rexTarget) throw new Error(`Subagent ${running.name} (${running.id}) has no Rex pane`);
	try {
		focusRexChild(running.rexTarget, options);
	} catch (error) {
		if (error instanceof RexPaneGoneError) throw new Error(`The pane of subagent ${running.name} (${running.id}) is gone`);
		throw error;
	}
	return running;
}
