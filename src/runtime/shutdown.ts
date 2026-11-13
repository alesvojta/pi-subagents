import { disposeSubagentLaunchCapsule } from "../launch/env-capsule.ts";
import type { CompletedSubagentResult, ParentClosePolicy, ParentShutdownAction, RunningSubagent } from "../types.ts";
import { claimRexChildDelivery } from "./rex-child-records.ts";
import { clearSubagentShutdownTimer } from "./state.ts";

export type ShutdownSubagentsOptions = {
	escalationMs?: number;
	/** Pi's shutdown reason; `reload` keeps recorded Rex children running for the reloaded parent. */
	reason?: string;
};

export interface ShutdownRuntime {
	runningSubagents: Map<string, RunningSubagent>;
	completedSubagentResults: Map<string, CompletedSubagentResult>;
	parentCloseEscalationMs: number;
	updateWidget(): void;
	closeRunningSurface(running: RunningSubagent): Promise<void>;
}

export function terminateBackgroundChildProcess(running: RunningSubagent, signal: NodeJS.Signals): void {
	if (!running.childProcess?.pid) return;
	try {
		process.kill(-running.childProcess.pid, signal);
	} catch {
		running.childProcess.kill(signal);
	}
}

function abortBackgroundSubagent(running: RunningSubagent, escalationMs: number): void {
	if (running.abortController) {
		running.abortController.abort();
		return;
	}

	terminateBackgroundChildProcess(running, "SIGTERM");
	if (!running.childProcess?.pid) return;
	clearSubagentShutdownTimer(running);
	running.shutdownTimer = setTimeout(() => {
		running.shutdownTimer = undefined;
		terminateBackgroundChildProcess(running, "SIGKILL");
	}, escalationMs);
	running.shutdownTimer.unref?.();
}

async function terminateInteractiveSubagent(running: RunningSubagent, runtime: ShutdownRuntime): Promise<void> {
	running.abortController?.abort();
	try {
		await runtime.closeRunningSurface(running);
	} catch {} finally {
		disposeSubagentLaunchCapsule(running);
	}
}

/**
 * A recorded Rex pane child outlives a reload (the parent process stays) and,
 * with `parent-close-policy: continue`, a quit; a later parent reattaches it.
 */
function shouldHandOffRexChild(agent: RunningSubagent, reason: string | undefined): boolean {
	if (agent.mode !== "interactive" || !agent.rexTarget || !agent.rexRecordFile) return false;
	return reason === "reload" || agent.parentClosePolicy === "continue";
}

export async function shutdownSubagentsForParentExit(
	runtime: ShutdownRuntime,
	options: ShutdownSubagentsOptions = {},
): Promise<
	Array<{
		id: string;
		policy: ParentClosePolicy;
		action: ParentShutdownAction;
	}>
> {
	const escalationMs = options.escalationMs ?? runtime.parentCloseEscalationMs;
	const actions: Array<{
		id: string;
		policy: ParentClosePolicy;
		action: ParentShutdownAction;
	}> = [];

	// Detach every child before the first await, so no result can steer into
	// a session that is already shutting down.
	for (const agent of runtime.runningSubagents.values()) {
		clearSubagentShutdownTimer(agent);
		agent.allowSteerDelivery = false;
		agent.resultOwner = undefined;
		agent.deliveryState = "detached";
		if (shouldHandOffRexChild(agent, options.reason)) agent.rexHandedOff = true;
	}

	for (const agent of runtime.runningSubagents.values()) {
		if (agent.rexHandedOff) {
			actions.push({ id: agent.id, policy: agent.parentClosePolicy, action: "continue" });
			// Stop watching without closing the pane; the record stays for the next parent.
			agent.abortController?.abort();
			continue;
		}

		if (agent.parentClosePolicy === "continue") {
			actions.push({
				id: agent.id,
				policy: agent.parentClosePolicy,
				action: "continue",
			});
			continue;
		}

		actions.push({
			id: agent.id,
			policy: agent.parentClosePolicy,
			action: "terminate",
		});
		// A terminated child has no result left to deliver to any parent.
		claimRexChildDelivery(agent);
		if (agent.mode === "interactive") {
			await terminateInteractiveSubagent(agent, runtime);
		} else {
			abortBackgroundSubagent(agent, escalationMs);
		}
	}

	runtime.runningSubagents.clear();
	runtime.completedSubagentResults.clear();
	runtime.updateWidget();
	return actions;
}
