import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * On-disk contract for parent → child steer messages. The inbox sits next to
 * the child's session file, like the exit sidecar, so both processes derive it
 * from `PI_SUBAGENT_SESSION` without another env var. The model never sees it.
 *
 * Each message moves through three names inside the inbox:
 * - `<key>.json`      written by the parent (tmp + rename, so never partial)
 * - `<key>.taken`     claimed by the child and handed to Pi as a steer
 * - `<key>.delivered` the steer entered the child's context
 *
 * Keys sort by write time, so the child delivers messages in arrival order.
 */

export type SteerInboxState = "pending" | "taken" | "delivered";

export interface SteerInboxMessage {
	key: string;
	text: string;
	sentAt: number;
}

const SUFFIX: Record<SteerInboxState, string> = { pending: ".json", taken: ".taken", delivered: ".delivered" };

let sequence = 0;

export function getSteerInboxDir(sessionFile: string): string {
	return `${sessionFile}.steer`;
}

function messagePath(sessionFile: string, key: string, state: SteerInboxState): string {
	return join(getSteerInboxDir(sessionFile), `${key}${SUFFIX[state]}`);
}

function listNames(sessionFile: string): string[] {
	try {
		return readdirSync(getSteerInboxDir(sessionFile)).sort();
	} catch {
		return [];
	}
}

/** Parent side: write one message and return its key. */
export function writeSteerMessage(sessionFile: string, text: string, now = Date.now()): string {
	const dir = getSteerInboxDir(sessionFile);
	mkdirSync(dir, { recursive: true });
	sequence = (sequence + 1) % 1_000_000;
	const key = `${String(now).padStart(15, "0")}-${String(sequence).padStart(6, "0")}-${process.pid}`;
	const message: SteerInboxMessage = { key, text, sentAt: now };
	const tmp = join(dir, `.${key}.tmp`);
	writeFileSync(tmp, JSON.stringify(message), "utf8");
	renameSync(tmp, messagePath(sessionFile, key, "pending"));
	return key;
}

/** The furthest state a message reached, or undefined once the inbox is gone. */
export function getSteerMessageState(sessionFile: string, key: string): SteerInboxState | undefined {
	for (const state of ["delivered", "taken", "pending"] as const) {
		if (existsSync(messagePath(sessionFile, key, state))) return state;
	}
	return undefined;
}

/**
 * Child side: claim every pending message in arrival order. A rename is the
 * claim, so a message is handed to Pi at most once even with two readers.
 */
export function claimPendingSteerMessages(sessionFile: string): SteerInboxMessage[] {
	const claimed: SteerInboxMessage[] = [];
	for (const name of listNames(sessionFile)) {
		if (!name.endsWith(SUFFIX.pending)) continue;
		const key = name.slice(0, -SUFFIX.pending.length);
		const taken = messagePath(sessionFile, key, "taken");
		try {
			renameSync(messagePath(sessionFile, key, "pending"), taken);
			const message = JSON.parse(readFileSync(taken, "utf8")) as Partial<SteerInboxMessage>;
			if (typeof message.text !== "string") continue;
			claimed.push({ key, text: message.text, sentAt: typeof message.sentAt === "number" ? message.sentAt : 0 });
		} catch {
			// Another reader claimed it, or the parent cleared the inbox.
		}
	}
	return claimed;
}

/** Child side: the steer entered the child's context. */
export function markSteerMessageDelivered(sessionFile: string, key: string): void {
	try {
		renameSync(messagePath(sessionFile, key, "taken"), messagePath(sessionFile, key, "delivered"));
	} catch {
		// Already marked, or the inbox was cleared after the child finished.
	}
}

export function ensureSteerInbox(sessionFile: string): void {
	mkdirSync(getSteerInboxDir(sessionFile), { recursive: true });
}

/**
 * Parent side, once a child run is over: count the messages that never reached
 * the child's context and remove the inbox, so a later resume starts empty.
 */
export function takeUndeliveredSteerCount(sessionFile: string): number {
	const undelivered = listNames(sessionFile).filter(
		(name) => name.endsWith(SUFFIX.pending) || name.endsWith(SUFFIX.taken),
	).length;
	clearSteerInbox(sessionFile);
	return undelivered;
}

export function clearSteerInbox(sessionFile: string): void {
	rmSync(getSteerInboxDir(sessionFile), { recursive: true, force: true });
}
