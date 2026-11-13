import { readFileSync, writeFileSync } from "node:fs";
import { getSessionJobsDir, type JobResult, jobPaths, writeJsonAtomic } from "../../src/jobs/job-files.ts";
import { formatJobResult, getJobRunnerPath, type LaunchedJob, launchRexJob, watchRexJob } from "../../src/jobs/job-launch.ts";
import { registerJobTools } from "../../src/tools/job-tools.ts";
import { assert, createTestDir, describe, it } from "../support/index.ts";
import { until } from "../support/jobs.ts";
import { REX_PARENT, REX_SESSION, useFakeRex } from "../support/rex.ts";

function launch(command = "make test", name?: string): LaunchedJob {
	process.env.PI_ARTIFACT_PROJECT_ROOT = createTestDir();
	return launchRexJob({ command, cwd: createTestDir(), jobsDir: getSessionJobsDir(createTestDir(), "parent-session"), name });
}

function writeResult(job: LaunchedJob, patch: Partial<JobResult> = {}): JobResult {
	const result: JobResult = {
		version: 1,
		id: job.spec.id,
		status: "completed",
		exitCode: 0,
		signal: null,
		durationMs: 1200,
		tail: "all tests passed",
		finishedAt: new Date().toISOString(),
		...patch,
	};
	writeJsonAtomic(jobPaths(job.dir).result, result);
	return result;
}

interface FakeTool {
	name: string;
	execute: (...args: unknown[]) => Promise<{ content: { text: string }[]; details: Record<string, string> }>;
}

interface FakeMessage {
	message: { customType: string; details: Record<string, unknown> };
	options: unknown;
}

function fakePi() {
	const tools = new Map<string, FakeTool>();
	const commands = new Map<string, unknown>();
	const handlers = new Map<string, unknown>();
	const messages: FakeMessage[] = [];
	const pi = {
		registerTool: (tool: FakeTool) => tools.set(tool.name, tool),
		registerCommand: (name: string, command: unknown) => commands.set(name, command),
		on: (event: string, handler: unknown) => handlers.set(event, handler),
		sendMessage: (message: FakeMessage["message"], options: unknown) => messages.push({ message, options }),
	};
	return { pi: pi as unknown as Parameters<typeof registerJobTools>[0], tools, commands, handlers, messages };
}

describe("Rex background jobs", () => {
	it("registers the tool and command only inside Rex", () => {
		useFakeRex();
		const inside = fakePi();
		registerJobTools(inside.pi, () => true);
		assert.ok(inside.tools.has("rex_job_run"));
		// The model learns about the tool from the system prompt's tool list and guidelines.
		const listed = inside.tools.get("rex_job_run") as unknown as { promptSnippet?: string; promptGuidelines?: string[] };
		assert.match(listed.promptSnippet ?? "", /background job/);
		assert.match(listed.promptGuidelines?.join("\n") ?? "", /prefer rex_job_run over a blocking shell call/);
		assert.ok(inside.commands.has("job"));
		assert.ok(inside.commands.has("jobs"));
		for (const name of ["rex_job_list", "rex_job_log", "rex_job_stop"]) assert.ok(inside.tools.has(name), name);
		const denied = fakePi();
		registerJobTools(denied.pi, (name) => name !== "rex_job_run" && name !== "rex_job_stop");
		assert.equal(denied.tools.has("rex_job_run"), false);
		assert.equal(denied.tools.has("rex_job_stop"), false);
		assert.ok(denied.tools.has("rex_job_list"));

		delete process.env.REX_SESSION;
		delete process.env.REX_BLOCK;
		const outside = fakePi();
		registerJobTools(outside.pi, () => true);
		assert.equal(outside.tools.size, 0);
		assert.equal(outside.commands.size, 0);
		assert.equal(outside.handlers.size, 0);
	});

	it("opens jobs in the parent's own Jobs window, stacks later jobs there, and never splits the parent", () => {
		const f = useFakeRex();
		const first = launch("npm test", "unit tests");
		const second = launch("npm run build");
		const spec = JSON.parse(readFileSync(jobPaths(first.dir).spec, "utf8"));
		assert.equal(spec.command, "npm test");
		assert.equal(spec.name, "unit tests");
		const creations = f.calls().filter((call) => call[1] === "split" || (call[1] === "window" && call[2] === "new"));
		assert.equal(creations[0][1], "window");
		assert.equal(creations[0][3], "Jobs");
		assert.deepEqual(creations[0].slice(-2), [getJobRunnerPath(), first.dir]);
		assert.equal(creations[1][1], "split");
		assert.equal(creations[1][creations[1].indexOf("-b") + 1], first.blockId);
		assert.ok(!creations.some((call) => call.includes(REX_PARENT)), "the parent pane is never split");
		assert.ok(f.calls().some((call) => call.includes("rename") && call.at(-1) === "[job] unit tests"));
		assert.notEqual(second.blockId, first.blockId);
		assert.equal(first.target.sessionId, REX_SESSION);
	});

	it("delivers the result once after the pane's process exits, then closes the pane", async () => {
		const f = useFakeRex();
		const job = launch("npm test");
		const deliveries: JobResult[] = [];
		const watching = watchRexJob(job, (_job, result) => deliveries.push(result));
		await until(() => f.eventPids().length === 1, "the event stream");
		writeResult(job, { status: "failed", exitCode: 2, tail: "1 failing" });
		f.childExited(job.blockId, 2);
		const result = await watching;
		assert.equal(result?.status, "failed");
		assert.deepEqual(deliveries.map((value) => value.exitCode), [2]);
		assert.ok(f.calls().some((call) => call[1] === "block" && call[2] === "close" && call.includes(job.blockId)));

		const before = f.calls().length;
		assert.equal(await watchRexJob(job, () => assert.fail("delivered twice")), null);
		assert.equal(f.calls().length, before, "a delivered job never touches Rex again");
	});

	it("delivers an interruption once when the user closes the pane, without closing it again", async () => {
		const f = useFakeRex();
		const job = launch("sleep 600");
		const deliveries: JobResult[] = [];
		const watching = watchRexJob(job, (_job, result) => deliveries.push(result));
		await until(() => f.eventPids().length === 1, "the event stream");
		// The runner records the hang-up just before its pane disappears.
		writeResult(job, { status: "interrupted", exitCode: 143, signal: "SIGHUP", tail: "" });
		f.blockClosed(job.blockId);
		assert.equal((await watching)?.status, "interrupted");
		assert.equal(deliveries.length, 1);
		assert.ok(!f.calls().some((call) => call[1] === "block" && call[2] === "close"));
	});

	it("does not deliver during a Rex outage and delivers once it reads the missed exit", async () => {
		const f = useFakeRex();
		const job = launch("npm test");
		const deliveries: JobResult[] = [];
		const watching = watchRexJob(job, (_job, result) => deliveries.push(result));
		await until(() => f.eventPids().length === 1, "the event stream");
		f.updateState(() => ({ eventsError: true, probeError: true }));
		process.kill(f.eventPids()[0], "SIGKILL");
		writeResult(job);
		await new Promise((resolve) => setTimeout(resolve, 600));
		assert.equal(deliveries.length, 0, "an outage is not a finished job");
		f.updateState(() => ({ eventsError: false, probeError: false, lastExit: { [job.blockId]: { exit_code: 0 } } }));
		assert.equal((await watching)?.status, "completed");
		assert.equal(deliveries.length, 1);
	});

	it("tells the parent the status, exit code, bounded output, and full log path", () => {
		useFakeRex();
		const job = launch("npm test", "unit tests");
		const text = formatJobResult(job, writeResult(job, { status: "failed", exitCode: 1, tail: "AssertionError: boom" }));
		assert.match(text, new RegExp(`Background job ${job.spec.id} \\(unit tests\\) failed · exit 1 · 1\\.2s`));
		assert.match(text, /Command: npm test/);
		assert.ok(text.includes(`Full log: ${jobPaths(job.dir).log}`));
		assert.match(text, /AssertionError: boom/);
	});

	it("delivers through the tool as a steer message and returns at once", async () => {
		const f = useFakeRex();
		process.env.PI_ARTIFACT_PROJECT_ROOT = createTestDir();
		const { pi, tools, messages } = fakePi();
		registerJobTools(pi, () => true);
		const cwd = createTestDir();
		const ctx = { cwd, sessionManager: { getSessionId: () => "parent-session" } };
		const tool = tools.get("rex_job_run");
		assert.ok(tool);
		const launched = await tool.execute("call-1", { command: "npm test" }, undefined, undefined, ctx);
		assert.match(launched.content[0].text, /Started background job job-[0-9a-f]{8}/);
		assert.match(launched.content[0].text, /do not poll/);
		assert.equal(messages.length, 0);
		await until(() => f.eventPids().length === 1, "the event stream");
		const dir = launched.details.log.replace(/\/output\.log$/, "");
		writeJsonAtomic(jobPaths(dir).result, {
			version: 1, id: launched.details.id, status: "completed", exitCode: 0, signal: null, durationMs: 5, tail: "ok",
			finishedAt: new Date().toISOString(),
		});
		f.childExited(launched.details.block, 0);
		await until(() => messages.length === 1, "the delivery");
		assert.equal(messages[0].message.customType, "rex_job_result");
		assert.deepEqual(messages[0].options, { triggerTurn: true, deliverAs: "steer" });
		assert.equal(messages[0].message.details.status, "completed");
	});

	it("lists, reads, and stops jobs only within the calling session", async () => {
		useFakeRex();
		process.env.PI_ARTIFACT_PROJECT_ROOT = createTestDir();
		const { pi, tools, commands } = fakePi();
		registerJobTools(pi, () => true);
		const cwd = createTestDir();
		const mine = { cwd, sessionManager: { getSessionId: () => "parent-session" } };
		const other = { cwd, sessionManager: { getSessionId: () => "other-session" } };
		const run = tools.get("rex_job_run");
		const launched = await run?.execute("call-1", { command: "echo hi" }, undefined, undefined, mine);
		const id = launched?.details.id as string;
		const dir = launched?.details.log.replace(/\/output\.log$/, "") as string;
		writeFileSync(jobPaths(dir).log, "hi\n");
		writeJsonAtomic(jobPaths(dir).result, {
			version: 1, id, status: "completed", exitCode: 0, signal: null, durationMs: 5, tail: "hi", finishedAt: new Date().toISOString(),
		});

		const listed = await tools.get("rex_job_list")?.execute("call-2", {}, undefined, undefined, mine);
		assert.match(listed?.content[0].text ?? "", new RegExp(`${id} {2}completed exit 0`));
		const log = await tools.get("rex_job_log")?.execute("call-3", { id, tail: 5 }, undefined, undefined, mine);
		assert.match(log?.content[0].text ?? "", /lines 1-1 of 1[\s\S]*\nhi$/);
		const stop = await tools.get("rex_job_stop")?.execute("call-4", { id }, undefined, undefined, mine);
		assert.match(stop?.content[0].text ?? "", /already ended \(completed\); nothing to stop/);

		assert.match((await tools.get("rex_job_list")?.execute("call-5", {}, undefined, undefined, other))?.content[0].text ?? "", /No background jobs/);
		for (const name of ["rex_job_log", "rex_job_stop"]) {
			const denied = (await tools.get(name)?.execute("call-6", { id }, undefined, undefined, other)) as unknown as { isError?: boolean; content: { text: string }[] };
			assert.equal(denied.isError, true);
			assert.match(denied.content[0].text, new RegExp(`No background job ${id} in this session`));
		}

		const notes: [string, string][] = [];
		const ui = { ...mine, ui: { notify: (text: string, level: string) => notes.push([text, level]) } };
		const jobs = commands.get("jobs") as { handler: (args: string, ctx: unknown) => Promise<void> };
		await jobs.handler("", ui);
		await jobs.handler(`log ${id} 3`, ui);
		await jobs.handler("stop ../other-session", ui);
		await jobs.handler("kill everything", ui);
		assert.match(notes[0][0], new RegExp(id));
		assert.match(notes[1][0], /\nhi$/);
		assert.deepEqual(notes[2], ["No background job ../other-session in this session", "error"]);
		assert.equal(notes[3][1], "warning");
	});
});
