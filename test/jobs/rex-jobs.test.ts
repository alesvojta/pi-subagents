import { readFileSync } from "node:fs";
import { type JobResult, jobPaths, writeJsonAtomic } from "../../src/jobs/job-files.ts";
import { formatJobResult, getJobRunnerPath, type LaunchedJob, launchRexJob, watchRexJob } from "../../src/jobs/job-launch.ts";
import { registerJobTools } from "../../src/tools/job-tools.ts";
import { assert, createTestDir, describe, it } from "../support/index.ts";
import { REX_PARENT, REX_SESSION, useFakeRex } from "../support/rex.ts";

function launch(command = "make test", name?: string): LaunchedJob {
	process.env.PI_ARTIFACT_PROJECT_ROOT = createTestDir();
	return launchRexJob({ command, cwd: createTestDir(), sessionId: "parent-session", name });
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

async function until(condition: () => boolean, what: string): Promise<void> {
	for (let i = 0; i < 300; i++) {
		if (condition()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`Timed out waiting for ${what}`);
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
		const denied = fakePi();
		registerJobTools(denied.pi, (name) => name !== "rex_job_run");
		assert.equal(denied.tools.has("rex_job_run"), false);

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
});
