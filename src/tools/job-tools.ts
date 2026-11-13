import { resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type JobResult, jobPaths } from "../jobs/job-files.ts";
import {
	formatJobResult,
	type LaunchedJob,
	launchRexJob,
	stopRexJobWatchers,
	watchRexJob,
} from "../jobs/job-launch.ts";
import { rexCaller } from "../mux/rex.ts";
import { REX_JOB_RUN_TOOL_NAME } from "./tool-names.ts";

const JOB_RUN_DESCRIPTION =
	"Run a long shell command (build, test suite, server, migration) as a background job in its own Rex pane. " +
	"Returns immediately; when the command ends, its status, exit code, last output lines, and full log path arrive automatically as a message. Do not poll.";

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

function startJob(pi: ExtensionAPI, ctx: ExtensionContext, command: string, cwd?: string, name?: string): LaunchedJob {
	const job = launchRexJob({
		command,
		cwd: resolve(ctx.cwd, cwd ?? "."),
		sessionId: ctx.sessionManager.getSessionId(),
		name,
	});
	void watchRexJob(job, (launched, result) => deliverJobResult(pi, launched, result)).catch(() => {
		// Watching is best-effort past launch; the pane and its log remain for the user.
	});
	return job;
}

function describeLaunch(job: LaunchedJob): string {
	return `Started background job ${job.spec.id} (${job.spec.name}) in Rex pane ${job.blockId}. Log: ${jobPaths(job.dir).log}. The result will be delivered automatically when it ends; do not poll.`;
}

/** Background shell jobs exist only inside Rex; outside it neither the tool nor the command is registered. */
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
					return {
						content: [{ type: "text" as const, text: describeLaunch(job) }],
						details: { id: job.spec.id, block: job.blockId, log: jobPaths(job.dir).log },
					};
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					return {
						content: [{ type: "text" as const, text: `Failed to start background job: ${message}` }],
						details: { error: message },
						isError: true,
					};
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
}
