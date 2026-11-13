import { mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getSessionArtifactDir } from "../artifact-storage.ts";
import { rexChildTarget } from "../mux/rex.ts";
import type { RunningSubagent } from "../types.ts";

/**
 * Durable records of the interactive Rex children one parent session owns.
 *
 * A record exists while the child's result is undelivered. Whoever delivers
 * the result first removes the record, and `unlink` succeeds for exactly one
 * caller, so a result is delivered once across reloads and processes. A
 * reloaded or restarted parent reads only its own session's records, which
 * keeps it from ever adopting a pane another session launched.
 */

export interface RexChildRecordScope {
	cwd: string;
	sessionId: string;
}

/** The plain-data part of a running child that a new parent needs to watch it again. */
const RECORDED_FIELDS = [
	"id",
	"name",
	"task",
	"title",
	"agent",
	"parentClosePolicy",
	"blocking",
	"async",
	"autoExit",
	"noSession",
	"reportContextUsage",
	"timeoutBudget",
	"timeoutBlocksResume",
	"timeoutWarnThreshold",
	"timeoutWrapUp",
	"timeoutWrapUpMode",
	"timeoutWrapUpDeadlineAt",
	"surface",
	"startTime",
	"sessionFile",
	"launchEntryCount",
	"modelRef",
	"launchMetadata",
	"doneSentinelFile",
	"rexTarget",
] as const satisfies readonly (keyof RunningSubagent)[];

type RecordedChild = Pick<RunningSubagent, (typeof RECORDED_FIELDS)[number]>;

export interface RexChildRecord {
	version: 1;
	parentSessionId: string;
	child: RecordedChild;
}

const CHILD_ID = /^[0-9a-f]{1,16}$/;

let scope: RexChildRecordScope | undefined;

/** Records are written for the parent session that is current when a child starts. */
export function setRexChildRecordScope(next: RexChildRecordScope | undefined): void {
	scope = next?.sessionId ? next : undefined;
}

export function getRexChildRecordsDir(cwd: string, sessionId: string): string {
	return join(getSessionArtifactDir(cwd, sessionId), "rex-children");
}

function writeRecord(path: string, record: RexChildRecord): void {
	const temp = `${path}.${process.pid}.tmp`;
	writeFileSync(temp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
	renameSync(temp, path);
}

function snapshot(running: RunningSubagent): RecordedChild {
	const child: Record<string, unknown> = {};
	for (const field of RECORDED_FIELDS) {
		if (running[field] !== undefined) child[field] = running[field];
	}
	return child as RecordedChild;
}

/**
 * Record a Rex pane child the first time it is watched. Recording is
 * best-effort: a child without a record is still watched and delivered by
 * this parent, it just cannot be reattached after a reload.
 */
export function recordRexChild(running: RunningSubagent): void {
	if (running.rexRecordFile || running.mode !== "interactive" || !running.rexTarget || !scope) return;
	if (!CHILD_ID.test(running.id)) return;
	try {
		const dir = getRexChildRecordsDir(scope.cwd, scope.sessionId);
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		const path = join(dir, `${running.id}.json`);
		writeRecord(path, { version: 1, parentSessionId: scope.sessionId, child: snapshot(running) });
		running.rexRecordFile = path;
	} catch {
		// Losing reattach for this child must not fail its launch.
	}
}

/** Rewrite the record after the child moved to a new pane (timeout wrap-up restart). */
export function refreshRexChildRecord(running: RunningSubagent): void {
	const path = running.rexRecordFile;
	if (!path) return;
	try {
		const record = JSON.parse(readFileSync(path, "utf8")) as RexChildRecord;
		writeRecord(path, { ...record, child: snapshot(running) });
	} catch {
		// Already delivered, or unreadable: nothing left to keep current.
	}
}

/**
 * True for exactly one caller per recorded child. A child without a record
 * always claims, so a failed record write never suppresses its result.
 */
export function claimRexChildDelivery(running: Pick<RunningSubagent, "rexRecordFile">): boolean {
	const path = running.rexRecordFile;
	if (!path) return true;
	try {
		unlinkSync(path);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== "ENOENT";
	}
}

/** Read this session's records. Unreadable or mismatched files are skipped, never adopted. */
export function readRexChildRecords(cwd: string, sessionId: string): Array<{ path: string; record: RexChildRecord }> {
	const dir = getRexChildRecordsDir(cwd, sessionId);
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return [];
	}
	const records: Array<{ path: string; record: RexChildRecord }> = [];
	for (const name of names.sort()) {
		const id = name.endsWith(".json") ? name.slice(0, -".json".length) : "";
		if (!CHILD_ID.test(id)) continue;
		const path = join(dir, name);
		try {
			const record = JSON.parse(readFileSync(path, "utf8")) as RexChildRecord;
			if (!isOwnedRecord(record, id, sessionId)) continue;
			records.push({ path, record });
		} catch {
			// Partial or foreign file.
		}
	}
	return records;
}

function isOwnedRecord(record: RexChildRecord, id: string, sessionId: string): boolean {
	if (record?.version !== 1 || record.parentSessionId !== sessionId) return false;
	const child = record.child;
	if (!child || child.id !== id || typeof child.sessionFile !== "string" || typeof child.startTime !== "number") {
		return false;
	}
	const target = child.rexTarget;
	if (!target || child.surface !== target.blockId) return false;
	try {
		rexChildTarget({ sessionId: target.sessionId, blockId: target.parentBlockId }, target.blockId);
	} catch {
		return false;
	}
	return true;
}
