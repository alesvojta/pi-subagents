import { spawn } from "node:child_process";
import { once } from "node:events";
import { createWriteStream, type WriteStream } from "node:fs";
import { constants } from "node:os";
import { finished } from "node:stream/promises";
import { stripVTControlCharacters } from "node:util";
import { boundedTail, type JobResult, type JobStatus, jobPaths, readJobSpec, writeJsonAtomic } from "./job-files.ts";

/**
 * Runner inside a job's Rex pane. Usage: `<runtime> job-runner.ts <jobDir>`.
 *
 * Runs the command in its own process group, streams its output to the pane
 * and to `output.log` with backpressure, and writes `result.json` before it
 * exits with the command's status. A signal to the runner (closing the pane
 * sends SIGHUP, a parent stop sends SIGTERM) stops the whole group and is
 * recorded as an interruption.
 */

const KILL_GRACE_MS = 2000;
const TAIL_BUFFER_CHARS = 16_000;

const dir = process.argv[2];
if (!dir) {
	process.stderr.write("usage: job-runner.ts <jobDir>\n");
	process.exit(2);
}
const job = readJobSpec(dir);
const paths = jobPaths(dir);
const startedAt = Date.now();
const blue = (text: string) => `\x1b[38;2;126;152;173m${text}\x1b[0m`;
// Command text is shown, never interpreted as terminal controls.
const isControl = (char: string) => {
	const code = char.codePointAt(0) ?? 0;
	return (code < 0x20 && char !== "\n" && char !== "\t") || (code >= 0x7f && code <= 0x9f);
};
const clean = (text: string) => [...stripVTControlCharacters(text)].filter((char) => !isControl(char)).join("");

let terminalOpen = true;
process.stdout.on("error", () => {
	terminalOpen = false;
});
process.stderr.on("error", () => {});

async function write(sink: WriteStream | NodeJS.WriteStream, text: string): Promise<void> {
	if (!sink.write(text)) await once(sink, "drain");
}

/** The pane is a convenience view; a gone terminal never fails the job. */
async function show(text: string): Promise<void> {
	if (!terminalOpen) return;
	try {
		await write(process.stdout, text);
	} catch {
		terminalOpen = false;
	}
}

const command = clean(job.command)
	.split("\n")
	.map((line, index) => `${index ? "> " : "$ "}${line}`)
	.join("\n");
await show(`\x1b]2;Job · ${clean(job.name)}\x1b\\${blue(`Job ${job.id}`)}\ncwd: ${clean(job.cwd)}\n${command}\n\n`);

const log = createWriteStream(paths.log, { mode: 0o600 });
let logError: string | undefined;
log.on("error", (error) => {
	logError ??= `Output log write failed: ${error.message}`;
});

const child = spawn("/bin/sh", ["-c", job.command], {
	cwd: job.cwd,
	detached: true,
	stdio: ["ignore", "pipe", "pipe"],
	env: { ...process.env, ...(job.path ? { PATH: job.path } : {}) },
});

if (child.pid) writeJsonAtomic(paths.runner, { pid: process.pid, pgid: child.pid, startedAt: new Date(startedAt).toISOString() });

let interrupted: NodeJS.Signals | null = null;
let escalation: ReturnType<typeof setTimeout> | undefined;
function killGroup(signal: NodeJS.Signals): void {
	try {
		if (child.pid) process.kill(-child.pid, signal);
	} catch {
		// The group is already gone.
	}
}
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
	process.on(signal, () => {
		interrupted ??= signal;
		killGroup("SIGTERM");
		escalation ??= setTimeout(() => killGroup("SIGKILL"), KILL_GRACE_MS);
	});
}

let tail = "";
const pumps = [child.stdout, child.stderr].map(async (stream) => {
	stream.setEncoding("utf8");
	for await (const text of stream as AsyncIterable<string>) {
		tail = (tail + text).slice(-TAIL_BUFFER_CHARS);
		// Wait for both sinks before reading more, so a slow pane or disk bounds memory.
		await Promise.all([logError ? undefined : write(log, text).catch(() => {}), show(text)]);
	}
});

const [code, signal] = await new Promise<[number | null, NodeJS.Signals | null]>((resolve) => {
	child.once("error", (error) => {
		logError ??= `Failed to start /bin/sh: ${error.message}`;
		resolve([127, null]);
	});
	child.once("close", (exitCode, exitSignal) => resolve([exitCode, exitSignal]));
});
await Promise.all(pumps);
clearTimeout(escalation);
log.end();
await finished(log).catch(() => {});

const status: JobStatus = interrupted || signal ? "interrupted" : code === 0 ? "completed" : "failed";
const exitCode = code ?? (signal ? 128 + (constants.signals[signal] ?? 0) : 1);
const durationMs = Date.now() - startedAt;
const result: JobResult = {
	version: 1,
	id: job.id,
	status,
	exitCode,
	signal: interrupted ?? signal,
	durationMs,
	tail: boundedTail(tail),
	...(logError ? { error: logError } : {}),
	finishedAt: new Date().toISOString(),
};
writeJsonAtomic(paths.result, result);

const summary = `${status} · exit ${exitCode}${result.signal ? ` (${result.signal})` : ""} · ${(durationMs / 1000).toFixed(1)}s`;
await show(`\n${tail ? "" : "(no output)\n"}${logError ? `${logError}\n` : ""}${blue(summary)}\n`);
process.exit(exitCode);
