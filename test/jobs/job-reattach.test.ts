import { readFileSync, writeFileSync } from "node:fs";
import { stopJob } from "../../src/jobs/job-control.ts";
import { getSessionJobsDir, type JobResult, jobPaths, writeJsonAtomic } from "../../src/jobs/job-files.ts";
import { type LaunchedJob, launchRexJob, stopRexJobWatchers, watchRexJob } from "../../src/jobs/job-launch.ts";
import { reattachRexJobs } from "../../src/jobs/job-reattach.ts";
import { registerJobTools } from "../../src/tools/job-tools.ts";
import { afterEach, assert, createTestDir, describe, it } from "../support/index.ts";
import { until } from "../support/jobs.ts";
import { useFakeRex } from "../support/rex.ts";

const SESSION_CWD = createTestDir();

function jobsDir(sessionId = "parent-session"): string {
	return getSessionJobsDir(SESSION_CWD, sessionId);
}

function launch(command = "sleep 30; echo MARKER"): LaunchedJob {
	// One artifact root per test, so every job of the test shares the session's jobs directory.
	process.env.PI_ARTIFACT_PROJECT_ROOT ??= createTestDir();
	return launchRexJob({ command, cwd: createTestDir(), jobsDir: jobsDir() });
}

function writeResult(job: LaunchedJob, patch: Partial<JobResult> = {}): void {
	writeJsonAtomic(jobPaths(job.dir).result, {
		version: 1,
		id: job.spec.id,
		status: "completed",
		exitCode: 0,
		signal: null,
		durationMs: 30_000,
		tail: "MARKER",
		finishedAt: new Date().toISOString(),
		...patch,
	} satisfies JobResult);
}

function collector() {
	const deliveries: JobResult[] = [];
	return { deliveries, deliver: (_job: LaunchedJob, result: JobResult) => deliveries.push(result) };
}

const closes = (f: ReturnType<typeof useFakeRex>, block: string) =>
	f.calls().filter((call) => call[1] === "block" && call[2] === "close" && call.includes(block)).length;

describe("Rex job reattach", () => {
	afterEach(() => stopRexJobWatchers());

	it("delivers a job once when the parent reloads while it runs", async () => {
		const f = useFakeRex();
		const job = launch();
		const before = collector();
		const watching = watchRexJob(job, before.deliver);
		await until(() => f.eventPids().length === 1, "the event stream");
		stopRexJobWatchers();
		const after = collector();
		assert.deepEqual(reattachRexJobs(jobsDir(), after.deliver).map((value) => value.spec.id), [job.spec.id]);
		assert.equal(await watching, null, "the old watcher hands the job over");
		writeResult(job);
		// The handed-over stream may resubscribe after the event; Rex then reports the exit on probe.
		f.updateState(() => ({ lastExit: { [job.blockId]: { exit_code: 0 } } }));
		f.childExited(job.blockId, 0);
		await until(() => after.deliveries.length === 1, "the reattached delivery");
		assert.equal(before.deliveries.length, 0);
		await until(() => closes(f, job.blockId) === 1, "the pane close");
		assert.deepEqual(reattachRexJobs(jobsDir(), after.deliver), [], "a delivered job is never reattached");
	});

	it("delivers a job that ended while no parent ran as soon as the session starts", async () => {
		const f = useFakeRex();
		const job = launch();
		writeResult(job, { status: "failed", exitCode: 3 });
		f.updateState(() => ({ lastExit: { [job.blockId]: { exit_code: 3 } } }));
		const { deliveries, deliver } = collector();
		reattachRexJobs(jobsDir(), deliver);
		await until(() => deliveries.length === 1, "the delivery");
		assert.equal(deliveries[0].exitCode, 3);
		await until(() => closes(f, job.blockId) === 1, "the pane close");
	});

	it("never adopts another session's jobs or a record that does not match its directory", async () => {
		const f = useFakeRex();
		const job = launch();
		const { deliveries, deliver } = collector();
		assert.deepEqual(reattachRexJobs(jobsDir("other-session"), deliver), []);

		const pane = JSON.parse(readFileSync(jobPaths(job.dir).pane, "utf8"));
		writeFileSync(jobPaths(job.dir).pane, JSON.stringify({ ...pane, blockId: pane.target.parentBlockId }));
		assert.deepEqual(reattachRexJobs(jobsDir(), deliver), [], "a pane that is not the recorded child");
		writeFileSync(jobPaths(job.dir).pane, JSON.stringify(pane));
		const spec = JSON.parse(readFileSync(jobPaths(job.dir).spec, "utf8"));
		writeFileSync(jobPaths(job.dir).spec, JSON.stringify({ ...spec, id: "job-00000000" }));
		assert.deepEqual(reattachRexJobs(jobsDir(), deliver), [], "a spec that names another job");
		writeFileSync(jobPaths(job.dir).spec, JSON.stringify(spec));
		writeFileSync(jobPaths(job.dir).delivered, "{}\n");
		assert.deepEqual(reattachRexJobs(jobsDir(), deliver), [], "an already delivered job");
		assert.equal(f.eventPids().length, 0, "nothing was watched");
		assert.equal(deliveries.length, 0);
	});

	it("resolves a lost runner only on Rex's exact answer and waits through an outage", async () => {
		const f = useFakeRex();
		const exited = launch();
		const closed = launch();
		f.updateState(() => ({ eventsError: true, probeError: true }));
		const { deliveries, deliver } = collector();
		reattachRexJobs(jobsDir(), deliver);
		await new Promise((resolve) => setTimeout(resolve, 600));
		assert.equal(deliveries.length, 0, "an outage is not a lost job");
		f.updateState(() => ({
			eventsError: false,
			probeError: false,
			lastExit: { [exited.blockId]: { exit_code: 137 } },
			closedBlocks: [closed.blockId],
		}));
		await until(() => deliveries.length === 2, "both deliveries", 8000);
		const byId = new Map(deliveries.map((result) => [result.id, result]));
		assert.equal(byId.get(exited.spec.id)?.status, "interrupted");
		assert.match(byId.get(exited.spec.id)?.error ?? "", /runner ended without reporting a result/);
		assert.match(byId.get(closed.spec.id)?.error ?? "", /pane closed before the job reported a result/);
		await until(() => closes(f, exited.blockId) === 1, "the exited pane close");
		assert.equal(closes(f, closed.blockId), 0, "a gone pane is not closed again");
	});

	it("delivers once when a stop or a second parent races the reattached watcher", async () => {
		const f = useFakeRex();
		const job = launch();
		const { deliveries, deliver } = collector();
		reattachRexJobs(jobsDir(), deliver);
		// A second parent process of the same session watches the same job.
		const rival = watchRexJob({ ...job }, deliver);
		await until(() => f.eventPids().length >= 1, "the event stream");
		// A pid that is not this job's runner makes stop close only the job's pane.
		writeJsonAtomic(jobPaths(job.dir).runner, { pid: process.pid, pgid: null, startedAt: new Date().toISOString() });
		const stopping = stopJob(job.dir, deliver);
		await until(() => closes(f, job.blockId) === 1, "the stop closing the pane");
		writeResult(job, { status: "interrupted", exitCode: 143, signal: "SIGHUP" });
		f.blockClosed(job.blockId);
		assert.equal((await stopping).kind, "stopped");
		await until(() => deliveries.length === 1, "the delivery");
		await rival;
		await new Promise((resolve) => setTimeout(resolve, 100));
		assert.equal(deliveries.length, 1);
	});

	it("reattaches on an interactive session start and leaves print-mode runs alone", async () => {
		const f = useFakeRex();
		const job = launch();
		writeResult(job);
		f.updateState(() => ({ lastExit: { [job.blockId]: { exit_code: 0 } } }));
		const handlers = new Map<string, (event: unknown, ctx: unknown) => void>();
		const messages: { message: { customType: string }; options: unknown }[] = [];
		const pi = {
			registerTool: () => {},
			registerCommand: () => {},
			on: (event: string, handler: (event: unknown, ctx: unknown) => void) => handlers.set(event, handler),
			sendMessage: (message: { customType: string }, options: unknown) => messages.push({ message, options }),
		} as unknown as Parameters<typeof registerJobTools>[0];
		registerJobTools(pi, () => true);
		const ctx = (mode: string) => ({ mode, cwd: SESSION_CWD, sessionManager: { getSessionId: () => "parent-session" } });
		handlers.get("session_start")?.({ reason: "startup" }, ctx("print"));
		await new Promise((resolve) => setTimeout(resolve, 300));
		assert.equal(messages.length, 0);
		assert.equal(f.eventPids().length, 0);
		handlers.get("session_start")?.({ reason: "startup" }, ctx("interactive"));
		await until(() => messages.length === 1, "the delivery");
		assert.equal(messages[0].message.customType, "rex_job_result");
		assert.deepEqual(messages[0].options, { triggerTurn: true, deliverAs: "steer" });
	});
});
