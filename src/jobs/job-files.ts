import { closeSync, existsSync, openSync, readFileSync, readSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * On-disk contract between the parent and the runner inside a job's Rex pane.
 * The runner only reads `job.json` and writes `output.log` and `result.json`;
 * the parent alone claims `delivered.json`, which makes delivery exactly-once.
 */

export interface JobSpec {
	version: 1;
	id: string;
	name: string;
	command: string;
	cwd: string;
	/** PATH of the parent; the pane does not inherit the parent's environment. */
	path?: string;
	createdAt: string;
}

export type JobStatus = "completed" | "failed" | "interrupted";

export interface JobResult {
	version: 1;
	id: string;
	status: JobStatus;
	exitCode: number | null;
	signal: string | null;
	durationMs: number;
	/** Bounded end of the combined output; the full output is in `output.log`. */
	tail: string;
	error?: string;
	finishedAt: string;
}

export const JOB_TAIL_MAX_LINES = 40;
const JOB_TAIL_MAX_CHARS = 4000;

export function jobPaths(dir: string) {
	return {
		spec: join(dir, "job.json"),
		log: join(dir, "output.log"),
		result: join(dir, "result.json"),
		delivered: join(dir, "delivered.json"),
	};
}

export function writeJsonAtomic(path: string, value: unknown): void {
	const temp = `${path}.${process.pid}.tmp`;
	writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
	renameSync(temp, path);
}

export function readJobSpec(dir: string): JobSpec {
	const spec = JSON.parse(readFileSync(jobPaths(dir).spec, "utf8"));
	if (spec?.version !== 1 || typeof spec.id !== "string" || typeof spec.command !== "string" || typeof spec.cwd !== "string") {
		throw new Error(`Invalid job spec in ${dir}`);
	}
	return spec;
}

export function readJobResult(dir: string): JobResult | null {
	try {
		const result = JSON.parse(readFileSync(jobPaths(dir).result, "utf8"));
		return result?.version === 1 && typeof result.status === "string" ? result : null;
	} catch {
		return null;
	}
}

/** Last lines of OUTPUT, bounded both by line count and by characters. */
export function boundedTail(output: string): string {
	const lines = output.replace(/\s+$/, "").split("\n");
	const tail = lines.slice(-JOB_TAIL_MAX_LINES).join("\n");
	return tail.length > JOB_TAIL_MAX_CHARS ? tail.slice(-JOB_TAIL_MAX_CHARS) : tail;
}

/** Bounded tail of the log for a job whose runner never wrote a result. */
export function readLogTail(dir: string, bytes = 16_384): string {
	const path = jobPaths(dir).log;
	if (!existsSync(path)) return "";
	const size = statSync(path).size;
	const length = Math.min(size, bytes);
	const buffer = Buffer.alloc(length);
	const fd = openSync(path, "r");
	try {
		readSync(fd, buffer, 0, length, size - length);
	} finally {
		closeSync(fd);
	}
	return boundedTail(buffer.toString("utf8"));
}

/** True for exactly one caller per job, across watchers and processes. */
export function claimJobDelivery(dir: string): boolean {
	try {
		writeFileSync(jobPaths(dir).delivered, `${JSON.stringify({ pid: process.pid, at: new Date().toISOString() })}\n`, {
			flag: "wx",
			mode: 0o600,
		});
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
		throw error;
	}
}
