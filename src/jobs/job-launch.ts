import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getSessionArtifactDir } from "../artifact-storage.ts";
import { closeRexSurface, createRexCommandSurface, type RexChildTarget, requireRexCaller, rexChildTarget, waitForRexExit } from "../mux/rex.ts";
import { RexChildGoneError } from "../mux/rex-events.ts";
import { resolveSupervisorRuntime } from "../vf/supervisor/spawn.ts";
import { claimJobDelivery, type JobResult, type JobSpec, jobPaths, readJobResult, readLogTail, writeJsonAtomic } from "./job-files.ts";

/**
 * Launches shell jobs into the parent's own `Jobs` Rex window and delivers
 * each result exactly once. The runner in the pane owns the process; the
 * parent only watches the pane through the shared Rex event stream.
 */

export interface LaunchedJob {
	spec: JobSpec;
	dir: string;
	blockId: string;
	target: RexChildTarget;
}

export interface JobLaunchRequest {
	command: string;
	cwd: string;
	sessionId: string;
	name?: string;
}

const RESULT_WAIT_MS = 3000;
const RETRY_MS = 1000;

const liveJobs = new Map<string, { job: LaunchedJob; controller: AbortController }>();

export function getJobRunnerPath(): string {
	return fileURLToPath(new URL("./job-runner.ts", import.meta.url));
}

export function launchRexJob(request: JobLaunchRequest): LaunchedJob {
	const command = request.command.trim();
	if (!command) throw new Error("Job command must not be empty");
	if (!existsSync(request.cwd)) throw new Error(`Job cwd does not exist: ${request.cwd}`);
	const caller = requireRexCaller();
	const id = `job-${randomBytes(4).toString("hex")}`;
	const dir = resolve(getSessionArtifactDir(request.cwd, request.sessionId), "jobs", id);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const name = request.name?.trim() || command.split("\n")[0].slice(0, 48);
	const spec: JobSpec = {
		version: 1,
		id,
		name,
		command,
		cwd: request.cwd,
		path: process.env.PATH,
		createdAt: new Date().toISOString(),
	};
	writeJsonAtomic(jobPaths(dir).spec, spec);
	const runtime = resolveSupervisorRuntime();
	const blockId = createRexCommandSurface(`[job] ${name}`, [runtime.command, ...runtime.preArgs, getJobRunnerPath(), dir], request.cwd, {
		policy: "auto",
		windowTitle: "Jobs",
		ownWindow: true,
	});
	return { spec, dir, blockId, target: rexChildTarget(caller, blockId) };
}

function isBlockNotFound(error: unknown, blockId: string): boolean {
	const text = `${(error as { stderr?: unknown })?.stderr ?? ""}${(error as Error)?.message ?? ""}`;
	return text.includes(`block target "${blockId}" not found`);
}

/** Resolves when the pane's process exited or the pane is gone; Rex outages only delay it. */
async function waitForPane(job: LaunchedJob, signal: AbortSignal): Promise<"exited" | "gone"> {
	while (true) {
		try {
			await waitForRexExit(job.blockId, signal, job.target);
			return "exited";
		} catch (error) {
			if (signal.aborted) throw error;
			if (error instanceof RexChildGoneError || isBlockNotFound(error, job.blockId)) return "gone";
			await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
		}
	}
}

async function readResultEventually(dir: string, ms: number): Promise<JobResult | null> {
	const deadline = Date.now() + ms;
	while (true) {
		const result = readJobResult(dir);
		if (result || Date.now() >= deadline) return result;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
}

/** A pane that vanished before its runner wrote a result was interrupted. */
function interruptedResult(job: LaunchedJob): JobResult {
	return {
		version: 1,
		id: job.spec.id,
		status: "interrupted",
		exitCode: null,
		signal: null,
		durationMs: Date.now() - Date.parse(job.spec.createdAt),
		tail: readLogTail(job.dir),
		error: "The job pane closed before the job reported a result.",
		finishedAt: new Date().toISOString(),
	};
}

/**
 * Watch JOB until it ends, deliver its result once, then close its pane.
 * Returns the delivered result, or null when aborted or already delivered.
 */
export async function watchRexJob(
	job: LaunchedJob,
	deliver: (job: LaunchedJob, result: JobResult) => void,
): Promise<JobResult | null> {
	// A delivered job is finished business; never touch its (closed) pane again.
	if (existsSync(jobPaths(job.dir).delivered)) return null;
	const controller = new AbortController();
	liveJobs.set(job.spec.id, { job, controller });
	try {
		const pane = await waitForPane(job, controller.signal);
		const result = (await readResultEventually(job.dir, RESULT_WAIT_MS)) ?? interruptedResult(job);
		if (!claimJobDelivery(job.dir)) return null;
		deliver(job, result);
		if (pane === "exited") {
			try {
				closeRexSurface(job.blockId, job.target);
			} catch {
				// The user may have closed it already; the result is delivered either way.
			}
		}
		return result;
	} catch (error) {
		if (controller.signal.aborted) return null;
		throw error;
	} finally {
		liveJobs.delete(job.spec.id);
	}
}

/** Stop watching every job; their panes keep running and keep their logs. */
export function stopRexJobWatchers(): void {
	for (const { controller } of liveJobs.values()) controller.abort();
}

export function formatJobResult(job: LaunchedJob, result: JobResult): string {
	const seconds = (result.durationMs / 1000).toFixed(1);
	const exit = result.exitCode === null ? "no exit code" : `exit ${result.exitCode}`;
	const lines = [
		`Background job ${job.spec.id} (${job.spec.name}) ${result.status} · ${exit}${result.signal ? ` (${result.signal})` : ""} · ${seconds}s`,
		`Command: ${job.spec.command}`,
		`Cwd: ${job.spec.cwd}`,
		`Full log: ${jobPaths(job.dir).log}`,
	];
	if (result.error) lines.push(`Note: ${result.error}`);
	lines.push(result.tail ? `Output (last lines):\n${result.tail}` : "Output: (none)");
	return lines.join("\n");
}
