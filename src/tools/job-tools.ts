import { resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	findJobDir,
	formatJobList,
	formatJobLog,
	type JobLogRequest,
	type JobStopOutcome,
	listJobs,
	readJobLog,
	stopJob,
	summarizeJob,
} from "../jobs/job-control.ts";
import { getSessionJobsDir, type JobResult, jobPaths } from "../jobs/job-files.ts";
import {
	formatJobResult,
	type LaunchedJob,
	launchRexJob,
	stopRexJobWatchers,
	watchRexJob,
} from "../jobs/job-launch.ts";
import { rexCaller } from "../mux/rex.ts";
import {
	REX_JOB_LIST_TOOL_NAME,
	REX_JOB_LOG_TOOL_NAME,
	REX_JOB_RUN_TOOL_NAME,
	REX_JOB_STOP_TOOL_NAME,
} from "./tool-names.ts";

const JOB_RUN_DESCRIPTION =
	"Run a long shell command (build, test suite, server, migration) as a background job in its own Rex pane. " +
	"Returns immediately; when the command ends, its status, exit code, last output lines, and full log path arrive automatically as a message. Do not poll.";
const JOB_LIST_DESCRIPTION = "List this session's background jobs with their state, command, and run time.";
const JOB_LOG_DESCRIPTION =
	"Read part of a background job's output log, running or finished: the last lines (default) or a 1-based line range. " +
	"Not for waiting on a job; its result arrives automatically.";
const JOB_STOP_DESCRIPTION =
	"Stop a running background job and its whole process group. The job's result, marked interrupted with the output so far, arrives once as a message.";

function deliverJobResult(pi: ExtensionAPI, job: LaunchedJob, result: JobResult): void {
	pi.sendMessage(
		{
			customType: "rex_job_result",
			content: formatJobResult(job, result),
			display: true,
			details: {
				id: job.spec.id,
				name: job.spec.name,
				status: result.status,
				exitCode: result.exitCode,
				log: jobPaths(job.dir).log,
			},
		},
		{ triggerTurn: true, deliverAs: "steer" },
	);
}

function sessionJobsDir(ctx: ExtensionContext): string {
	return getSessionJobsDir(ctx.cwd, ctx.sessionManager.getSessionId());
}

function startJob(pi: ExtensionAPI, ctx: ExtensionContext, command: string, cwd?: string, name?: string): LaunchedJob {
	const job = launchRexJob({ command, cwd: resolve(ctx.cwd, cwd ?? "."), jobsDir: sessionJobsDir(ctx), name });
	void watchRexJob(job, (launched, result) => deliverJobResult(pi, launched, result)).catch(() => {
		// Watching is best-effort past launch; the pane and its log remain for the user.
	});
	return job;
}

function describeLaunch(job: LaunchedJob): string {
	return `Started background job ${job.spec.id} (${job.spec.name}) in Rex pane ${job.blockId}. Log: ${jobPaths(job.dir).log}. The result will be delivered automatically when it ends; do not poll.`;
}

/** The job's directory in this session, or an error naming the unknown ID. */
function requireJobDir(ctx: ExtensionContext, id: string): string {
	const dir = findJobDir(sessionJobsDir(ctx), id.trim());
	if (!dir) throw new Error(`No background job ${id.trim() || "(empty id)"} in this session`);
	return dir;
}

async function showJobLog(ctx: ExtensionContext, id: string, request: JobLogRequest): Promise<string> {
	const dir = requireJobDir(ctx, id);
	return formatJobLog(summarizeJob(dir), await readJobLog(dir, request));
}

async function stopSessionJob(pi: ExtensionAPI, ctx: ExtensionContext, id: string): Promise<string> {
	const outcome: JobStopOutcome = await stopJob(requireJobDir(ctx, id), (job, result) => deliverJobResult(pi, job, result));
	switch (outcome.kind) {
		case "finished":
			return `Job ${outcome.summary.spec.id} already ended (${outcome.summary.state}); nothing to stop.`;
		case "stopped":
			return `Stopped job ${outcome.result.id}. Its interrupted result is delivered as a message.`;
		case "stopping":
			return `Stop requested for job ${id.trim()}; it is still shutting down. Its interrupted result is delivered as a message.`;
	}
}

function textResult(text: string, details: Record<string, unknown> = {}) {
	return { content: [{ type: "text" as const, text }], details };
}

function errorResult(prefix: string, error: unknown) {
	const message = error instanceof Error ? error.message : String(error);
	return { ...textResult(`${prefix}: ${message}`, { error: message }), isError: true };
}

const JOBS_USAGE = "Usage: /jobs | /jobs log <id> [lines] | /jobs stop <id>";

/** Background shell jobs exist only inside Rex; outside it neither the tools nor the commands are registered. */
export function registerJobTools(pi: ExtensionAPI, shouldRegister: (name: string) => boolean): void {
	if (!rexCaller()) return;

	pi.on("session_shutdown", (event) => {
		// A reasonless shutdown is the coordinator-only turn stop, not the end of the session.
		if (event?.reason) stopRexJobWatchers();
	});

	if (shouldRegister(REX_JOB_RUN_TOOL_NAME)) {
		pi.registerTool({
			name: REX_JOB_RUN_TOOL_NAME,
			label: "Run Background Job",
			description: JOB_RUN_DESCRIPTION,
			promptSnippet: JOB_RUN_DESCRIPTION,
			promptGuidelines: [
				`For long-running shell commands (full test suites, builds, dev servers), prefer ${REX_JOB_RUN_TOOL_NAME} over a blocking shell call and continue other work; the result arrives as a message.`,
			],
			parameters: Type.Object({
				command: Type.String({ description: "Shell command, run with /bin/sh -c" }),
				cwd: Type.Optional(Type.String({ description: "Working directory, relative to the session cwd" })),
				name: Type.Optional(Type.String({ description: "Short label for the job pane" })),
			}),
			execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
				try {
					const job = startJob(pi, ctx, params.command, params.cwd, params.name);
					return textResult(describeLaunch(job), { id: job.spec.id, block: job.blockId, log: jobPaths(job.dir).log });
				} catch (error) {
					return errorResult("Failed to start background job", error);
				}
			},
		});
	}

	if (shouldRegister(REX_JOB_LIST_TOOL_NAME)) {
		pi.registerTool({
			name: REX_JOB_LIST_TOOL_NAME,
			label: "List Background Jobs",
			description: JOB_LIST_DESCRIPTION,
			promptSnippet: JOB_LIST_DESCRIPTION,
			parameters: Type.Object({}),
			execute: async (_toolCallId, _params, _signal, _onUpdate, ctx) => {
				try {
					const jobs = listJobs(sessionJobsDir(ctx));
					return textResult(formatJobList(jobs), { jobs: jobs.map((job) => ({ id: job.spec.id, state: job.state })) });
				} catch (error) {
					return errorResult("Failed to list background jobs", error);
				}
			},
		});
	}

	if (shouldRegister(REX_JOB_LOG_TOOL_NAME)) {
		pi.registerTool({
			name: REX_JOB_LOG_TOOL_NAME,
			label: "Read Background Job Log",
			description: JOB_LOG_DESCRIPTION,
			promptSnippet: JOB_LOG_DESCRIPTION,
			parameters: Type.Object({
				id: Type.String({ description: "Job ID, e.g. job-1a2b3c4d" }),
				tail: Type.Optional(Type.Number({ description: "Number of last lines (default 100, max 1000)" })),
				from: Type.Optional(Type.Number({ description: "First line of a range, 1-based" })),
				to: Type.Optional(Type.Number({ description: "Last line of a range, inclusive (at most 1000 lines per call)" })),
			}),
			execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
				try {
					return textResult(await showJobLog(ctx, params.id, params));
				} catch (error) {
					return errorResult("Failed to read job log", error);
				}
			},
		});
	}

	if (shouldRegister(REX_JOB_STOP_TOOL_NAME)) {
		pi.registerTool({
			name: REX_JOB_STOP_TOOL_NAME,
			label: "Stop Background Job",
			description: JOB_STOP_DESCRIPTION,
			promptSnippet: JOB_STOP_DESCRIPTION,
			parameters: Type.Object({ id: Type.String({ description: "Job ID, e.g. job-1a2b3c4d" }) }),
			execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
				try {
					return textResult(await stopSessionJob(pi, ctx, params.id));
				} catch (error) {
					return errorResult("Failed to stop job", error);
				}
			},
		});
	}

	pi.registerCommand("job", {
		description: "Run a shell command as a background job in a Rex pane; the result is reported automatically",
		handler: async (args, ctx) => {
			const command = args.trim();
			if (!command) {
				ctx.ui.notify("Usage: /job <shell command>", "warning");
				return;
			}
			try {
				const job = startJob(pi, ctx, command);
				ctx.ui.notify(`Started ${job.spec.id}: ${job.spec.name}`, "info");
			} catch (error) {
				ctx.ui.notify(`Failed to start job: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		},
	});

	pi.registerCommand("jobs", {
		description: "List this session's background jobs, show a job's log, or stop a job",
		handler: async (args, ctx) => {
			const [action, id, lines, ...rest] = args.trim().split(/\s+/).filter(Boolean);
			try {
				if (!action) {
					ctx.ui.notify(formatJobList(listJobs(sessionJobsDir(ctx))), "info");
				} else if (action === "log" && id && !rest.length && (!lines || /^\d+$/.test(lines))) {
					ctx.ui.notify(await showJobLog(ctx, id, { tail: lines ? Number(lines) : 20 }), "info");
				} else if (action === "stop" && id && !lines) {
					ctx.ui.notify(await stopSessionJob(pi, ctx, id), "info");
				} else {
					ctx.ui.notify(JOBS_USAGE, "warning");
				}
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});
}
