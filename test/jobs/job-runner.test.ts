import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { JOB_TAIL_MAX_LINES, type JobSpec, jobPaths, readJobResult, writeJsonAtomic } from "../../src/jobs/job-files.ts";
import { assert, createTestDir, describe, it } from "../support/index.ts";
import { isAlive, startRunner } from "../support/jobs.ts";

function writeJob(command: string): string {
	const dir = join(createTestDir(), "job");
	mkdirSync(dir);
	const spec: JobSpec = { version: 1, id: "job-test", name: "test", command, cwd: dir, createdAt: new Date().toISOString() };
	writeJsonAtomic(jobPaths(dir).spec, spec);
	return dir;
}

describe("background job runner", () => {
	it("records a completed command with its output, log, and pane header and summary", async () => {
		const dir = writeJob("echo out-line; echo err-line >&2; pwd");
		const runner = startRunner(dir);
		assert.equal(await runner.exited, 0);
		const result = readJobResult(dir);
		assert.equal(result?.status, "completed");
		assert.equal(result?.exitCode, 0);
		assert.match(result?.tail ?? "", /out-line/);
		assert.match(result?.tail ?? "", /err-line/);
		assert.match(readFileSync(jobPaths(dir).log, "utf8"), new RegExp(dir));
		assert.match(runner.screen(), /cwd: /);
		assert.match(runner.screen(), /\$ echo out-line/);
		assert.match(runner.screen(), /completed · exit 0/);
	});

	it("exits with the command's status and marks it failed", async () => {
		const dir = writeJob("echo nope; exit 3");
		const runner = startRunner(dir);
		assert.equal(await runner.exited, 3);
		assert.equal(readJobResult(dir)?.status, "failed");
		assert.equal(readJobResult(dir)?.exitCode, 3);
		assert.match(runner.screen(), /failed · exit 3/);
	});

	it("bounds the delivered tail while keeping the full log", async () => {
		const dir = writeJob("i=1; while [ $i -le 100 ]; do echo line-$i; i=$((i+1)); done");
		await startRunner(dir).exited;
		const tail = readJobResult(dir)?.tail ?? "";
		assert.equal(tail.split("\n").length, JOB_TAIL_MAX_LINES);
		assert.match(tail, /line-100$/);
		assert.doesNotMatch(tail, /line-1\n/);
		assert.match(readFileSync(jobPaths(dir).log, "utf8"), /^line-1\n/);
	});

	it("stops the whole process group on a signal and records an interruption", async () => {
		const dir = writeJob("sleep 300 & echo $! > grandchild.pid; wait");
		const runner = startRunner(dir);
		const pidFile = join(dir, "grandchild.pid");
		for (let i = 0; i < 200 && !existsSync(pidFile); i++) await new Promise((resolve) => setTimeout(resolve, 10));
		const grandchild = Number(readFileSync(pidFile, "utf8"));
		assert.ok(isAlive(grandchild));
		// Closing a Rex pane hangs up its process.
		runner.child.kill("SIGHUP");
		await runner.exited;
		const result = readJobResult(dir);
		assert.equal(result?.status, "interrupted");
		assert.equal(result?.signal, "SIGHUP");
		for (let i = 0; i < 100 && isAlive(grandchild); i++) await new Promise((resolve) => setTimeout(resolve, 10));
		assert.equal(isAlive(grandchild), false);
	});
});
