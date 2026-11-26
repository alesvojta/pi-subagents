import { type FSWatcher, watch } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	claimPendingSteerMessages,
	ensureSteerInbox,
	getSteerInboxDir,
	markSteerMessageDelivered,
} from "../session/steer-inbox.ts";

/**
 * Child side of `subagent_steer`: watches the inbox next to this child's
 * session file and hands each parent message to Pi as a steer. A custom
 * message never fires Pi's `input` event, so it does not count as operator
 * takeover and auto-exit stays armed.
 */

export const PARENT_STEER_MESSAGE_TYPE = "subagent_steer";

const POLL_INTERVAL_MS = 500;

interface ParentSteerDetails {
	steerKey: string;
	text: string;
}

export function formatParentSteerContent(text: string): string {
	return (
		"<parent-steer>\n" +
		"Your parent agent sent this message while you are working. Take it into account and continue your task; " +
		"it changes your task only where it says so. Do not answer it as a chat reply: your parent reads your final result.\n\n" +
		`${text}\n` +
		"</parent-steer>"
	);
}

function wrapPlain(text: string, width: number): string[] {
	const lines: string[] = [];
	for (const raw of text.split("\n")) {
		let line = raw;
		while (line.length > width) {
			const cut = line.lastIndexOf(" ", width);
			const at = cut > 0 ? cut : width;
			lines.push(line.slice(0, at));
			line = line.slice(at).trimStart();
		}
		lines.push(line);
	}
	return lines;
}

export function installParentSteerReceiver(pi: ExtensionAPI, sessionFile = process.env.PI_SUBAGENT_SESSION): void {
	if (!sessionFile) return;
	let watcher: FSWatcher | undefined;
	let timer: ReturnType<typeof setInterval> | undefined;

	const drain = () => {
		for (const message of claimPendingSteerMessages(sessionFile)) {
			pi.sendMessage(
				{
					customType: PARENT_STEER_MESSAGE_TYPE,
					content: formatParentSteerContent(message.text),
					display: true,
					details: { steerKey: message.key, text: message.text } satisfies ParentSteerDetails,
				},
				{ triggerTurn: true, deliverAs: "steer" },
			);
		}
	};

	const stop = () => {
		watcher?.close();
		watcher = undefined;
		if (timer) clearInterval(timer);
		timer = undefined;
	};

	pi.on("session_start", () => {
		stop();
		try {
			ensureSteerInbox(sessionFile);
			// Never keep the child alive just for the inbox.
			watcher = watch(getSteerInboxDir(sessionFile), { persistent: false }, () => drain());
			watcher.on("error", () => {
				watcher = undefined;
			});
		} catch {
			// The poll below still picks messages up.
		}
		// fs.watch can miss events (and is not available everywhere), so poll too.
		timer = setInterval(drain, POLL_INTERVAL_MS);
		timer.unref?.();
		drain();
	});

	pi.on("message_end", (event) => {
		const message = event.message as { role?: unknown; customType?: unknown; details?: Partial<ParentSteerDetails> };
		if (message.role !== "custom" || message.customType !== PARENT_STEER_MESSAGE_TYPE) return;
		if (typeof message.details?.steerKey === "string") markSteerMessageDelivered(sessionFile, message.details.steerKey);
	});

	pi.on("session_shutdown", stop);

	// Minimal hosts (and test doubles) may not render custom messages.
	pi.registerMessageRenderer?.(PARENT_STEER_MESSAGE_TYPE, (message, _options, theme) => {
		const details = message.details as Partial<ParentSteerDetails> | undefined;
		const text = details?.text ?? (typeof message.content === "string" ? message.content : "");
		return {
			invalidate() {},
			render(width: number): string[] {
				// Plain wrapping keeps this child-side module free of a pi-tui import.
				const header = `${theme.fg("accent", "↳")} ${theme.fg("toolTitle", theme.bold("Message from parent agent"))}`;
				return ["", header, ...wrapPlain(text, Math.max(10, width - 2)).map((line) => `  ${line}`)];
			},
		};
	});
}
