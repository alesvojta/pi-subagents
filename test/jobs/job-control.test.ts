import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	findJobDir,
	focusJob,
	formatJobList,
	formatJobLog,
	listJobs,
	readJobLog,
	stopJob,
	summarizeJob,
} from "../../src/jobs/job-control.ts";
import { getSessionJobsDir, type JobResult, type JobSpec, jobPaths, writeJsonAtomic } from "../../src/jobs/job-files.ts";
import { formatJobResult, type LaunchedJob, launchRexJob, stopRexJobWatchers, watchRexJob } from "../../src/jobs/job-launch.ts";
import { afterEach, assert, createTestDir, describe, it } from "../support/index.ts";
import { isAlive, startRunner, until } from "../support/jobs.ts";
import { useFakeRex } from "../support/rex.ts";

function writeJob(jobsDir: string, id: string, command: string, createdAt = new Date().toISOString()): string {
	const dir = join(jobsDir, id);
	mkdirSync(dir, { recursive: true });
	const spec: JobSpec = { version: 1, id, name: command.slice(0, 20), command, cwd: dir, createdAt };
	writeJsonAtomic(jobPaths(dir).spec, spec);
	return dir;
}

function writeResult(dir: string, id: string, patch: Partial<JobResult> = {}): void {
	writeJsonAtomic(jobPaths(dir).result, {
		version: 1, id, status: "completed", exitCode: 0, signal: null, durationMs: 65_000, tail: "",
		finishedAt: new Date().toISOString(), ...patch,
	});
}

function deadPid(): number {
	return spawnSync(process.execPath, ["-e", ""]).pid as number;
}

function launchInSession(command: string): { job: LaunchedJob; jobsDir: string } {
	process.env.PI_ARTIFACT_PROJECT_ROOT = createTestDir();
	const jobsDir = getSessionJobsDir(createTestDir(), "parent-session");
	const job = launchRexJob({ command, cwd: createTestDir(), jobsDir });
	// The fake Rex is alone on PATH; the job itself needs the system tools.
	job.spec.path = "/usr/bin:/bin";
	writeJsonAtomic(jobPaths(job.dir).spec, job.spec);
	return { job, jobsDir };
}

describe("background job control", () => {
	const runners: ReturnType<typeof startRunner>[] = [];
	afterEach(() => {
		stopRexJobWatchers();
		// A failed assertion must not leave a job's process group running.
		for (const runner of runners.splice(0)) runner.child.kill("SIGTERM");
	});

	it("lists this session's jobs with state, command, and run time, oldest first", () => {
		const jobsDir = join(createTestDir(), "jobs");
		const done = writeJob(jobsDir, "job-00000001", "npm run build", "2026-11-13T08:00:00.000Z");
		writeResult(done, "job-00000001", { status: "failed", exitCode: 2 });
		writeJob(jobsDir, "job-00000002", "npm test -- --watch", new Date(Date.now() - 5000).toISOString());
		const lost = writeJob(jobsDir, "job-00000003", "make serve");
		writeJsonAtomic(jobPaths(lost).runner, { pid: deadPid(), pgid: null, startedAt: new Date().toISOString() });
		mkdirSync(join(jobsDir, "notes"));
		mkdirSync(join(jobsDir, "job-0000000f"));

		const jobs = listJobs(jobsDir);
		assert.deepEqual(jobs.map((job) => [job.spec.id, job.state]), [
			["job-00000001", "failed"],
			["job-00000002", "running"],
			["job-00000003", "lost"],
		]);
		const text = formatJobList(jobs);
		assert.match(text, /job-00000001 {2}failed exit 2 {2}1m05s {2}npm run build\n {2}\$ npm run build/);
		assert.match(text, /job-00000002 {2}running {2}[56]s/);
		assert.equal(formatJobList(listJobs(join(createTestDir(), "none"))), "No background jobs in this session.");
	});

	it("resolves only job IDs inside this session's jobs directory", () => {
		const root = createTestDir();
		const mine = join(root, "mine", "jobs");
		const theirs = join(root, "theirs", "jobs");
		writeJob(mine, "job-0000000a", "true");
		writeJob(theirs, "job-0000000b", "true");
		assert.ok(findJobDir(mine, "job-0000000a"));
		assert.equal(findJobDir(mine, "job-0000000b"), null, "another session's job");
		assert.equal(findJobDir(mine, "../../theirs/jobs/job-0000000b"), null);
		assert.equal(findJobDir(mine, "job-0000000a/.."), null);
	});

	it("reads the end of the log by default, a chosen tail, or a 1-based range, without terminal controls", async () => {
		const dir = writeJob(join(createTestDir(), "jobs"), "job-0000000c", "seq 250");
		const lines = Array.from({ length: 250 }, (_, i) => `line-${i + 1}`);
		lines[9] = "\x1b[31mline-10\x1b[0m";
		writeFileSync(jobPaths(dir).log, `${lines.join("\n")}\n`);
		writeResult(dir, "job-0000000c");
		const summary = summarizeJob(dir);

		const end = await readJobLog(dir);
		assert.equal(end.count, 100);
		assert.equal(end.first, 151);
		assert.match(formatJobLog(summary, end), /completed · lines 151-250 of 250 ·/);
		assert.match(end.text, /^line-151\n[\s\S]*line-250$/);

		assert.equal((await readJobLog(dir, { tail: 3 })).text, "line-248\nline-249\nline-250");
		const range = await readJobLog(dir, { from: 9, to: 11 });
		assert.equal(range.text, "line-9\nline-10\nline-11");
		assert.equal(range.total, null, "a range read stops early and does not count the rest");
		assert.match(formatJobLog(summary, range), /lines 9-11 ·/);
		assert.equal((await readJobLog(dir, { from: 249, to: 400 })).total, 250);
		assert.equal((await readJobLog(dir, { from: 300 })).count, 0);
	});

	it("bounds a huge log and reads its end without the whole file", async () => {
		const dir = writeJob(join(createTestDir(), "jobs"), "job-0000000d", "yes");
		const line = "x".repeat(199);
		writeFileSync(jobPaths(dir).log, `${`${line}\n`.repeat(20_000)}last\n`);
		const end = await readJobLog(dir, { tail: 1000 });
		assert.ok(end.text.length <= 16_000);
		assert.ok(end.truncated);
		assert.match(end.text, /\nlast$/);
		const empty = writeJob(join(createTestDir(), "jobs"), "job-0000000e", "true");
		assert.match(formatJobLog(summarizeJob(empty), await readJobLog(empty)), /no lines[\s\S]*\(no output\)/);
	});

	for (const watched of [true, false]) {
		it(`stops the whole process group and delivers the interruption once (${watched ? "watched" : "watcher lost after reload"})`, async () => {
			const f = useFakeRex();
			const { job, jobsDir } = launchInSession("echo started; sleep 300 & echo $! > grandchild.pid; wait");
			const runner = startRunner(job.dir);
			runners.push(runner);
			const pidFile = join(job.spec.cwd, "grandchild.pid");
			await until(() => existsSync(pidFile) && existsSync(jobPaths(job.dir).runner), "the job to start");
			const grandchild = Number(readFileSync(pidFile, "utf8"));
			const deliveries: JobResult[] = [];
			const deliver = (_job: LaunchedJob, result: JobResult) => deliveries.push(result);
			const watching = watched ? watchRexJob(job, deliver) : null;
			if (watching) await until(() => f.eventPids().length === 1, "the event stream");

			const outcome = await stopJob(findJobDir(jobsDir, job.spec.id) as string, deliver);
			assert.equal(outcome.kind, "stopped");
			assert.equal(await runner.exited, 143);
			await until(() => !isAlive(grandchild), "the grandchild to stop");
			await until(() => f.eventPids().length === 1, "a watcher");
			f.childExited(job.blockId, 143);
			await until(() => deliveries.length === 1, "the delivery");
			await watching;
			assert.equal(deliveries[0].status, "interrupted");
			assert.equal(deliveries[0].signal, "SIGTERM");
			assert.match(deliveries[0].tail, /started/);
			assert.match(formatJobResult(job, deliveries[0]), /Note: stopped on request\./);

			const again = await stopJob(job.dir, deliver);
			assert.equal(again.kind, "finished");
			await new Promise((resolve) => setTimeout(resolve, 100));
			assert.equal(deliveries.length, 1);
		});
	}

	it("never signals a reused pid; it hangs up only the job's own pane", async () => {
		const f = useFakeRex();
		const { job } = launchInSession("sleep 300");
		// This test process holds the recorded pid; signalling it would kill the suite.
		writeJsonAtomic(jobPaths(job.dir).runner, { pid: process.pid, pgid: process.pid, startedAt: new Date().toISOString() });
		const deliveries: JobResult[] = [];
		const stopping = stopJob(job.dir, (_job, result) => deliveries.push(result));
		await until(() => f.calls().some((call) => call[1] === "block" && call[2] === "close"), "the pane close");
		await until(() => f.eventPids().length === 1, "the event stream");
		const closes = f.calls().filter((call) => call[1] === "block" && call[2] === "close");
		assert.deepEqual(closes.map((call) => call.includes(job.blockId)), [true]);
		f.blockClosed(job.blockId);
		// No runner wrote a result, so the watcher gives it a moment before reporting the interruption.
		await until(() => deliveries.length === 1, "the delivery", 6000);
		assert.equal(deliveries[0].status, "interrupted");
		assert.equal((await stopping).kind, "stopping");
	});

	it("focuses a job's recorded pane and explains a pane that is gone", () => {
		const f = useFakeRex();
		const { job, jobsDir } = launchInSession("sleep 30");
		focusJob(job.dir, { zoom: true });
		assert.deepEqual(f.calls().filter((args) => args[1] === "focus" || args[1] === "zoom"), [
			["--autostart=false", "focus", job.blockId, "-s", job.target.sessionId],
			["--autostart=false", "zoom", "-b", job.blockId, "--on", "-s", job.target.sessionId],
		]);

		writeResult(job.dir, job.spec.id);
		f.updateState(() => ({ closedBlocks: [job.blockId] }));
		assert.throws(() => focusJob(job.dir), new RegExp(`Job ${job.spec.id} has no pane anymore \\(job completed\\); read its output with /jobs log`));
		const unlaunched = writeJob(jobsDir, "job-0000000a", "true");
		assert.throws(() => focusJob(unlaunched), /no recorded pane/);
	});
});
