import { stripVTControlCharacters } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readScreenAsync } from "../mux.ts";
import { findRunningSubagent, findTrackedSubagent } from "../runtime/running-registry.ts";
import { runningSubagents } from "../runtime/state.ts";
import type { RunningSubagent } from "../types.ts";
import { SUBAGENT_KILL_TOOL_NAME, SUBAGENT_PEEK_TOOL_NAME } from "./tool-names.ts";

/**
 * Reads the end of a running child's terminal screen for an occasional progress check.
 * Only children this parent launched (its running registry) are reachable, and a Rex
 * child is always read through its saved `rexTarget`, never the focused block.
 */

const PEEK_DEFAULT_LINES = 40;
const PEEK_MAX_LINES = 200;
export const PEEK_MAX_CHARS = 8000;

const PEEK_DESCRIPTION =
	"Read the last lines of a running subagent's terminal screen without waiting for it or interrupting it. " +
	"Use it for an occasional progress check on a long task, not as a substitute for the delivered result.";

/** Rules and frames (box drawing, block elements) carry no transcript text. */
const DECORATION_LINE = /^[\s─-▟]*$/;

type ScreenReader = typeof readScreenAsync;

function label(running: Pick<RunningSubagent, "name" | "id">): string {
	return `subagent "${running.name}" (${running.id})`;
}

function clampLines(lines: number | undefined): number {
	if (lines === undefined || !Number.isFinite(lines)) return PEEK_DEFAULT_LINES;
	return Math.min(PEEK_MAX_LINES, Math.max(1, Math.floor(lines)));
}

/** Screen text without terminal controls and decoration rows, as its last `lines` lines and at most PEEK_MAX_CHARS. */
export function cleanPeekScreen(screen: string, lines: number): string {
	const kept: string[] = [];
	for (const raw of stripVTControlCharacters(screen).split("\n")) {
		const line = raw.replace(/\r$/, "").trimEnd();
		if (line && DECORATION_LINE.test(line)) continue;
		if (!line && (kept.length === 0 || kept[kept.length - 1] === "")) continue;
		kept.push(line);
	}
	while (kept.length && kept[kept.length - 1] === "") kept.pop();
	const text = kept.slice(-lines).join("\n");
	return text.length > PEEK_MAX_CHARS ? `…${text.slice(-(PEEK_MAX_CHARS - 1))}` : text;
}

function finishedText(name: string, id: string): string {
	return `The subagent "${name}" (${id}) has already finished; its result is delivered to this session as a message.`;
}

function backgroundText(running: RunningSubagent): string {
	const lines = [`The ${label(running)} runs in the background and has no terminal screen.`];
	if (running.activity) lines.push(`Current activity: ${running.activity}`);
	const latest = running.lastAssistantText?.trim();
	if (latest) lines.push(`Latest assistant text:\n${latest.length > PEEK_MAX_CHARS ? `…${latest.slice(-(PEEK_MAX_CHARS - 1))}` : latest}`);
	return lines.join("\n");
}

function isPaneGone(error: unknown, surface: string): boolean {
	const stderr = String((error as { stderr?: unknown })?.stderr ?? "");
	return stderr.includes(`"${surface}" not found`);
}

export async function peekSubagent(ref: string, lines?: number, readScreen: ScreenReader = readScreenAsync): Promise<string> {
	const query = ref.trim();
	// A resumed child is running again under the ID of its cached completion, so running wins.
	const live = findRunningSubagent(query);
	const tracked = live.running ? undefined : findTrackedSubagent(query);
	if (tracked?.cached) return finishedText(tracked.cached.name, tracked.cached.id);
	const running = live.running;
	if (!running) throw new Error(live.error ?? `No running subagent matches "${query}".`);
	if (running.mode === "background" || !running.surface) return backgroundText(running);

	const count = clampLines(lines);
	const surface = running.surface;
	let screen: string;
	try {
		// Decoration rows are dropped after the read, so read extra to still return `count` text lines.
		screen = await readScreen(surface, Math.min(PEEK_MAX_LINES * 2, count * 2), running.rexTarget);
	} catch (error) {
		if (!runningSubagents.has(running.id)) return finishedText(running.name, running.id);
		if (isPaneGone(error, surface)) return `The terminal pane of the ${label(running)} is gone.`;
		throw new Error(`Could not read the screen of the ${label(running)}: ${error instanceof Error ? error.message : String(error)}`);
	}
	const text = cleanPeekScreen(screen, count);
	const shown = text ? text.split("\n").length : 0;
	return (
		`Last ${shown} screen ${shown === 1 ? "line" : "lines"} of the ${label(running)}:\n\n${text || "(empty screen)"}\n\n` +
		"The subagent is still running; its result is delivered automatically when it finishes."
	);
}

export function registerSubagentPeekTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: SUBAGENT_PEEK_TOOL_NAME,
		label: "Peek Subagent",
		description: PEEK_DESCRIPTION,
		promptSnippet: PEEK_DESCRIPTION,
		promptGuidelines: [
			`Use ${SUBAGENT_PEEK_TOOL_NAME} only for an occasional progress check, for example when the user asks how a child is doing. Do not call it in a loop or to wait for a child: the child's result is delivered automatically.`,
			`A peek shows unfinished work. Do not take over or redo the child's task because of what you see; let it finish, or stop it with ${SUBAGENT_KILL_TOOL_NAME}.`,
		],
		parameters: Type.Object({
			id: Type.String({ description: "Subagent ID, or its name when exactly one running subagent has it" }),
			lines: Type.Optional(
				Type.Number({ description: `Number of last screen lines (default ${PEEK_DEFAULT_LINES}, max ${PEEK_MAX_LINES})` }),
			),
		}),
		execute: async (_toolCallId, params) => {
			try {
				const text = await peekSubagent(params.id, params.lines);
				return { content: [{ type: "text" as const, text }], details: {} as Record<string, unknown> };
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return { content: [{ type: "text" as const, text: message }], details: { error: message }, isError: true };
			}
		},
	});
}
