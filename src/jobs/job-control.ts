import { execFileSync } from "node:child_process";
import { closeSync, createReadStream, existsSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { stripVTControlCharacters } from "node:util";
import { closeRexSurface } from "../mux/rex.ts";
import {
	isJobId,
	type JobResult,
	type JobSpec,
	jobPaths,
	readJobResult,
	readJobRunner,
	readJobSpec,
	writeJsonAtomic,
} from "./job-files.ts";
import { isJobWatched, type LaunchedJob, loadLaunchedJob, watchRexJob } from "./job-launch.ts";

/**
 * Lists, reads, and stops the jobs of one parent session. Every lookup goes
 * through that session's jobs directory, so another parent's jobs and panes
 * are never reachable.
 */

type JobState = "running" | "lost" | JobResult["status"];

export interface JobSummary {
	spec: JobSpec;
	dir: string;
	state: JobState;
	durationMs: number;
	delivered: boolean;
	result: JobResult | null;
}

const JOB_LOG_DEFAULT_LINES = 100;
const JOB_LOG_MAX_LINES = 1000;
const JOB_LOG_MAX_CHARS = 16_000;
const STOP_WAIT_MS = 5000;

/** The job's directory, only when ID names a job of this session. */
export function findJobDir(jobsDir: string, id: string): string | null {
	if (!isJobId(id)) return null;
	const dir = join(jobsDir, id);
	return existsSync(jobPaths(dir).spec) ? dir : null;
}

/** True only for the live runner of the job in DIR, never for a reused pid. */
function isRunnerAlive(dir: string): boolean {
	const runner = readJobRunner(dir);
	if (!runner) return false;
	try {
		// An absolute ps, so a job's or test's PATH cannot hide or replace it.
		const ps = existsSync("/bin/ps") ? "/bin/ps" : "/usr/bin/ps";
		const command = execFileSync(ps, ["-ww", "-o", "command=", "-p", String(runner.pid)], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		});
		return command.includes("job-runner") && command.includes(dir);
	} catch {
		return false;
	}
}

export function summarizeJob(dir: string): JobSummary {
	const spec = readJobSpec(dir);
	const result = readJobResult(dir);
	const delivered = existsSync(jobPaths(dir).delivered);
	if (result) return { spec, dir, state: result.status, durationMs: result.durationMs, delivered, result };
	// A runner that has not started yet still counts as running; a vanished one is lost.
	const state = !existsSync(jobPaths(dir).runner) || isRunnerAlive(dir) ? "running" : "lost";
	return { spec, dir, state, durationMs: Date.now() - Date.parse(spec.createdAt), delivered, result };
}

export function listJobs(jobsDir: string): JobSummary[] {
	if (!existsSync(jobsDir)) return [];
	const jobs: JobSummary[] = [];
	for (const id of readdirSync(jobsDir)) {
		const dir = findJobDir(jobsDir, id);
		if (!dir) continue;
		try {
			jobs.push(summarizeJob(dir));
		} catch {
			// A half-written job directory is not a job yet.
		}
	}
	return jobs.sort((a, b) => a.spec.createdAt.localeCompare(b.spec.createdAt));
}

function formatDuration(ms: number): string {
	const seconds = Math.max(0, Math.round(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
	return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

export function formatJobList(jobs: JobSummary[]): string {
	if (jobs.length === 0) return "No background jobs in this session.";
	return jobs
		.map((job) => {
			const exit = job.result?.exitCode != null ? ` exit ${job.result.exitCode}` : "";
			const command = job.spec.command.split("\n")[0];
			const shown = command.length > 80 ? `${command.slice(0, 79)}…` : command;
			return `${job.spec.id}  ${job.state}${exit}  ${formatDuration(job.durationMs)}  ${job.spec.name}\n  $ ${shown}`;
		})
		.join("\n");
}

export interface JobLogRequest {
	/** Last N lines; the default when no range is given. */
	tail?: number;
	/** First line of a range, 1-based. */
	from?: number;
	/** Last line of a range, 1-based and inclusive. */
	to?: number;
}

export interface JobLogSlice {
	text: string;
	/** Number of returned lines. */
	count: number;
	/** 1-based number of the first returned line, when known. */
	first: number | null;
	/** Total lines, when the whole log was scanned. */
	total: number | null;
	truncated: boolean;
}

function clampLines(value: number | undefined, fallback: number): number {
	return Math.min(JOB_LOG_MAX_LINES, Math.max(1, Math.floor(value ?? fallback)));
}

/** Keep LINES within the character budget, dropping from the far end. */
function bound(lines: string[], keepEnd: boolean): { lines: string[]; truncated: boolean } {
	const ordered = keepEnd ? [...lines].reverse() : lines;
	const kept: string[] = [];
	let chars = 0;
	for (const line of ordered) {
		const shown = line.length > JOB_LOG_MAX_CHARS ? line.slice(0, JOB_LOG_MAX_CHARS) : line;
		chars += shown.length + 1;
		if (chars > JOB_LOG_MAX_CHARS && kept.length > 0) break;
		kept.push(shown);
	}
	if (keepEnd) kept.reverse();
	return { lines: kept, truncated: kept.length < lines.length };
}

function plain(line: string): string {
	return stripVTControlCharacters(line).replace(/\r$/, "");
}

/** Read the last COUNT lines of a possibly huge log from its end. */
function readLogEnd(path: string, count: number): JobLogSlice {
	const size = statSync(path).size;
	let length = Math.min(size, 64 * 1024);
	let lines: string[];
	while (true) {
		const buffer = Buffer.alloc(length);
		const fd = openSync(path, "r");
		try {
			readSync(fd, buffer, 0, length, size - length);
		} finally {
			closeSync(fd);
		}
		lines = buffer.toString("utf8").split("\n").map(plain);
		if (lines.at(-1) === "") lines.pop();
		// A partial read starts mid-line; it is enough once that line is not needed.
		if (length === size || lines.length > count) break;
		length = Math.min(size, length * 4);
	}
	const total = length === size ? lines.length : null;
	const bounded = bound(lines.slice(-count), true);
	return {
		text: bounded.lines.join("\n"),
		count: bounded.lines.length,
		first: total === null || bounded.lines.length === 0 ? null : total - bounded.lines.length + 1,
		total,
		truncated: bounded.truncated,
	};
}

async function readLogRange(path: string, from: number, to: number): Promise<JobLogSlice> {
	const stream = createReadStream(path, { encoding: "utf8" });
	const reader = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });
	const lines: string[] = [];
	let number = 0;
	let complete = true;
	for await (const line of reader) {
		number++;
		if (number > to) {
			complete = false;
			break;
		}
		if (number >= from) lines.push(plain(line));
	}
	reader.close();
	stream.destroy();
	const bounded = bound(lines, false);
	return {
		text: bounded.lines.join("\n"),
		count: bounded.lines.length,
		first: bounded.lines.length ? from : null,
		total: complete ? number : null,
		truncated: bounded.truncated,
	};
}

export async function readJobLog(dir: string, request: JobLogRequest = {}): Promise<JobLogSlice> {
	const path = jobPaths(dir).log;
	if (!existsSync(path)) return { text: "", count: 0, first: null, total: 0, truncated: false };
	if (request.from === undefined && request.to === undefined) {
		return readLogEnd(path, clampLines(request.tail, JOB_LOG_DEFAULT_LINES));
	}
	const from = Math.max(1, Math.floor(request.from ?? 1));
	const to = Math.min(Math.max(from, Math.floor(request.to ?? from + JOB_LOG_DEFAULT_LINES - 1)), from + JOB_LOG_MAX_LINES - 1);
	return readLogRange(path, from, to);
}

export function formatJobLog(summary: JobSummary, slice: JobLogSlice): string {
	const range = slice.count === 0 ? "no lines" : slice.first === null ? `last ${slice.count} lines` : `lines ${slice.first}-${slice.first + slice.count - 1}`;
	const total = slice.total === null ? "" : ` of ${slice.total}`;
	const header = `Job ${summary.spec.id} (${summary.spec.name}) ${summary.state} · ${range}${total}${slice.truncated ? " (truncated to fit)" : ""} · ${jobPaths(summary.dir).log}`;
	return `${header}\n${slice.text || "(no output)"}`;
}

export type JobStopOutcome =
	| { kind: "stopped"; result: JobResult }
	| { kind: "stopping" }
	| { kind: "finished"; summary: JobSummary };

async function waitForResult(dir: string, ms: number): Promise<JobResult | null> {
	const deadline = Date.now() + ms;
	while (true) {
		const result = readJobResult(dir);
		if (result || Date.now() >= deadline) return result;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
}

/**
 * Stop a running job: SIGTERM to its runner, which stops the whole process
 * group and records the interruption. A runner that cannot be verified is
 * hung up by closing the job's own pane instead. The result is delivered once
 * by the job's watcher, which is started here if this parent lost it.
 */
export async function stopJob(
	dir: string,
	deliver: (job: LaunchedJob, result: JobResult) => void,
): Promise<JobStopOutcome> {
	const summary = summarizeJob(dir);
	if (summary.state !== "running" && summary.state !== "lost") return { kind: "finished", summary };
	const job = loadLaunchedJob(dir);
	if (!existsSync(jobPaths(dir).stop)) writeJsonAtomic(jobPaths(dir).stop, { at: new Date().toISOString() });
	if (job && !isJobWatched(job.spec.id)) {
		void watchRexJob(job, deliver).catch(() => {
			// The pane and log remain; the result is still readable through the log.
		});
	}
	// A just-launched runner records its pid within moments.
	const deadline = Date.now() + 2000;
	while (!readJobRunner(dir) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
	const runner = readJobRunner(dir);
	if (runner && isRunnerAlive(dir)) {
		process.kill(runner.pid, "SIGTERM");
	} else if (job && !readJobResult(dir)) {
		try {
			closeRexSurface(job.blockId, job.target);
		} catch {
			// Already gone; the watcher reports it as interrupted.
		}
	}
	const result = await waitForResult(dir, STOP_WAIT_MS);
	return result ? { kind: "stopped", result } : { kind: "stopping" };
}
