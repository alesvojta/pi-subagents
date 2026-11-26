import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { findRunningSubagent, findTrackedSubagent } from "../runtime/running-registry.ts";
import { runningSubagents } from "../runtime/state.ts";
import { getSteerMessageState, writeSteerMessage } from "../session/steer-inbox.ts";
import type { RunningSubagent } from "../types.ts";
import { SUBAGENT_RESUME_TOOL_NAME, SUBAGENT_STEER_TOOL_NAME } from "./tool-names.ts";

/**
 * Sends a short message to a running child. The message goes through the steer
 * inbox next to the child's session file (see `session/steer-inbox.ts`); the
 * child injects it at its next turn boundary. Only children this parent
 * launched are reachable. The tool never waits for the child's reply.
 */

export const STEER_MAX_CHARS = 4000;
const STEER_ACK_TIMEOUT_MS = 3000;
const STEER_ACK_POLL_MS = 100;

const STEER_DESCRIPTION =
	"Send a short message to a running subagent while it works: a correction, a new constraint, or extra context. " +
	"The child reads it at its next turn boundary. One-way: the child's reaction arrives with its normal result.";

export type SteerOutcome = "delivered" | "queued";

export interface SteerDeps {
	ackTimeoutMs?: number;
	sleep?: (ms: number) => Promise<void>;
}

function label(running: Pick<RunningSubagent, "name" | "id">): string {
	return `subagent "${running.name}" (${running.id})`;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function steerSubagent(
	ref: string,
	message: string,
	deps: SteerDeps = {},
): Promise<{ outcome: SteerOutcome; text: string }> {
	const text = message.trim();
	if (!text) throw new Error("The message is empty.");
	if (text.length > STEER_MAX_CHARS) {
		throw new Error(
			`The message has ${text.length} characters; the limit is ${STEER_MAX_CHARS}. ` +
				"Write longer material to a file and send only its path.",
		);
	}
	const query = ref.trim();
	const live = findRunningSubagent(query);
	const tracked = live.running ? undefined : findTrackedSubagent(query);
	if (tracked?.cached) {
		throw new Error(
			`The subagent "${tracked.cached.name}" (${tracked.cached.id}) has already finished, so it cannot be steered. ` +
				`To continue its work, use ${SUBAGENT_RESUME_TOOL_NAME} with a follow-up task.`,
		);
	}
	const running = live.running;
	if (!running) throw new Error(live.error ?? `No running subagent matches "${query}".`);
	if (running.timeoutWrapUp || running.timeoutWrapUpMode) {
		throw new Error(
			`The ${label(running)} hit its time limit and is only writing its final report; it takes no new instructions.`,
		);
	}

	const key = writeSteerMessage(running.sessionFile, text);
	const sleep = deps.sleep ?? defaultSleep;
	const deadline = Date.now() + (deps.ackTimeoutMs ?? STEER_ACK_TIMEOUT_MS);
	let state = getSteerMessageState(running.sessionFile, key);
	while (state !== "delivered" && Date.now() < deadline && runningSubagents.has(running.id)) {
		await sleep(STEER_ACK_POLL_MS);
		state = getSteerMessageState(running.sessionFile, key);
	}
	const noReply = "This tool does not wait for a reply; the child's reaction arrives with its result.";
	if (state === "delivered") {
		return { outcome: "delivered", text: `Delivered to the ${label(running)}; it is now in the child's context. ${noReply}` };
	}
	if (!runningSubagents.has(running.id)) {
		return {
			outcome: "queued",
			text: `The ${label(running)} finished before it read the message. Its result reports the message as undelivered.`,
		};
	}
	const why =
		state === "taken"
			? "The child received it and reads it as soon as its current tool call finishes."
			: "The child has not picked it up yet; it reads it at its next turn boundary.";
	return {
		outcome: "queued",
		text: `Queued for the ${label(running)}. ${why} If the child finishes first, its result reports the message as undelivered. ${noReply}`,
	};
}

export function registerSubagentSteerTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: SUBAGENT_STEER_TOOL_NAME,
		label: "Steer Subagent",
		description: STEER_DESCRIPTION,
		promptSnippet: STEER_DESCRIPTION,
		promptGuidelines: [
			`Use ${SUBAGENT_STEER_TOOL_NAME} when a running child needs a correction or information it lacks. Keep it short; for long material write a file and send its path.`,
			`${SUBAGENT_STEER_TOOL_NAME} does not return the child's answer. Do not wait or poll for one: the child's result is delivered automatically when it finishes.`,
			`A finished child cannot be steered; use ${SUBAGENT_RESUME_TOOL_NAME} with a follow-up task instead.`,
		],
		parameters: Type.Object({
			id: Type.String({ description: "Subagent ID, or its name when exactly one running subagent has it" }),
			message: Type.String({ description: `Message for the child (at most ${STEER_MAX_CHARS} characters)` }),
		}),
		execute: async (_toolCallId, params) => {
			try {
				const { outcome, text } = await steerSubagent(params.id, params.message);
				return { content: [{ type: "text" as const, text }], details: { outcome } as Record<string, unknown> };
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return { content: [{ type: "text" as const, text: message }], details: { error: message }, isError: true };
			}
		},
	});
}
