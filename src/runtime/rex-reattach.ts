import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { RunningSubagent, SubagentResult } from "../types.ts";
import { readRexChildRecords } from "./rex-child-records.ts";
import {
	claimSpawnWidthSlot,
	getSpawnWidthLimit,
	releaseSpawnWidthSlotOnCompletion,
	tryAcquireSlots,
} from "./spawn-width.ts";
import { runningSubagents } from "./state.ts";

export interface RexReattachRuntime {
	watchSubagent(running: RunningSubagent, signal: AbortSignal): Promise<SubagentResult>;
	wireSubagentSteerBack(pi: ExtensionAPI, running: RunningSubagent, watchPromise: Promise<SubagentResult>): void;
	getContextWindow(modelRef: string | undefined): number | undefined;
	startWidgetRefresh(): void;
	updateWidget(): void;
}

/**
 * Watch this session's recorded Rex children again after a reload or restart.
 *
 * The usual watcher does the rest: the shared Rex event stream probes
 * `last_exit` on connect, so a child that finished while no parent watched
 * resolves at once, and a pane that is gone resolves only on Rex's exact
 * "not found" answer. Delivery stays exactly-once through the record claim.
 */
export function reattachRexChildren(
	pi: ExtensionAPI,
	scope: { cwd: string; sessionId: string },
	runtime: RexReattachRuntime,
): RunningSubagent[] {
	const reattached: RunningSubagent[] = [];
	for (const { path, record } of readRexChildRecords(scope.cwd, scope.sessionId)) {
		if (runningSubagents.has(record.child.id)) continue;
		const running: RunningSubagent = {
			...record.child,
			mode: "interactive",
			executionState: "running",
			deliveryState: "detached",
			// Nobody awaits a reattached child; its result steers in like an async one.
			blocking: false,
			async: true,
			modelContextWindow: runtime.getContextWindow(record.child.modelRef),
			rexRecordFile: path,
		};
		const watcherAbort = new AbortController();
		running.abortController = watcherAbort;
		if (tryAcquireSlots(1, getSpawnWidthLimit())) claimSpawnWidthSlot(running);
		running.completionPromise = releaseSpawnWidthSlotOnCompletion(
			running,
			runtime.watchSubagent(running, watcherAbort.signal),
		);
		runningSubagents.set(running.id, running);
		runtime.wireSubagentSteerBack(pi, running, running.completionPromise);
		reattached.push(running);
	}
	if (reattached.length > 0) {
		runtime.updateWidget();
		runtime.startWidgetRefresh();
	}
	return reattached;
}
