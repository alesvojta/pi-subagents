import { type ChildProcess, execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import type { RexTarget } from "./rex.ts";

/**
 * One `rex events` subscription per Rex session replaces a `rex wait` process
 * per child. The stream only ever ends a wait on an exact answer about the
 * watched block: `child_exited`, `block_closed`, a probe reporting the block
 * missing, or the session itself missing. A dropped stream is never an exit;
 * it reconnects with backoff and probes `last_exit` for what it may have missed.
 */

const execAsync = promisify(execFile);
const PROBE_OPTIONS = { encoding: "utf8" as const, timeout: 15_000, maxBuffer: 1024 * 1024 };
/** Rex does not acknowledge a subscription, so probe again once it has had time to start. */
const SUBSCRIBE_SETTLE_MS = 500;
const RECONNECT_MIN_MS = 250;
const RECONNECT_MAX_MS = 10_000;
const KILL_GRACE_MS = 250;

export class RexChildGoneError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "RexChildGoneError";
	}
}

interface Waiter {
	resolve: (exitCode: number) => void;
	reject: (error: Error) => void;
}

interface SessionStream {
	sessionId: string;
	waiters: Map<string, Set<Waiter>>;
	child: ChildProcess | null;
	closed: Promise<void> | null;
	reconnectTimer: ReturnType<typeof setTimeout> | null;
	settleTimer: ReturnType<typeof setTimeout> | null;
	failures: number;
}

const streams = new Map<string, SessionStream>();

/** The subset of `rex events --json` lines this stream reads. */
interface RexStreamLine {
	type?: string;
	payload?: {
		session_id?: string;
		event?: { type?: string; payload?: { block_id?: unknown; name?: string; payload?: unknown } };
	};
}

/** Rex reports a signal death as -1 and reduces statuses above 255 like a shell. */
function exitStatus(payload: unknown): number | Error {
	const code = (payload as { exit_code?: unknown } | null)?.exit_code;
	if (typeof code !== "number" || !Number.isSafeInteger(code)) return new Error("Rex did not report a valid terminal exit status");
	if (code < 0) return new Error("Rex child was terminated by a signal before reporting an exit status");
	return code % 256;
}

function settle(stream: SessionStream, blockId: string, outcome: number | Error): void {
	const waiters = stream.waiters.get(blockId);
	if (!waiters) return;
	stream.waiters.delete(blockId);
	const stopped = stream.waiters.size === 0 ? stopStream(stream) : Promise.resolve();
	// Deliver only after the last subscription is reaped, so a finished watcher leaves no process.
	void stopped.then(() => {
		for (const waiter of waiters) {
			if (typeof outcome === "number") waiter.resolve(outcome);
			else waiter.reject(outcome);
		}
	});
}

function blockClosed(blockId: string): RexChildGoneError {
	return new RexChildGoneError(`Rex child block ${blockId} closed before reporting an exit status`);
}

function handleEvent(stream: SessionStream, line: string): void {
	let value: RexStreamLine;
	try {
		value = JSON.parse(line);
	} catch {
		return;
	}
	if (value?.type !== "session_event" || value.payload?.session_id !== stream.sessionId) return;
	const event = value.payload.event;
	const blockId = event?.payload?.block_id;
	if (!event || typeof blockId !== "string" || !stream.waiters.has(blockId)) return;
	if (event.type === "block_event" && event.payload?.name === "child_exited") {
		settle(stream, blockId, exitStatus(event.payload.payload));
	} else if (event.type === "block_closed") {
		settle(stream, blockId, blockClosed(blockId));
	}
}

async function probe(stream: SessionStream, blockId: string): Promise<void> {
	if (streams.get(stream.sessionId) !== stream || !stream.waiters.has(blockId)) return;
	try {
		const { stdout } = await execAsync(
			"rex",
			["--autostart=false", "block", "call", "-b", blockId, "process", "-s", stream.sessionId],
			PROBE_OPTIONS,
		);
		const lastExit = JSON.parse(stdout)?.last_exit;
		if (lastExit != null) settle(stream, blockId, exitStatus(lastExit));
	} catch (error) {
		const stderr = String((error as { stderr?: unknown }).stderr ?? "");
		if (stderr.includes(`block target "${blockId}" not found`)) settle(stream, blockId, blockClosed(blockId));
		// Anything else is a transport problem; the stream or the next reconnect answers later.
	}
}

function probeAll(stream: SessionStream): void {
	for (const blockId of [...stream.waiters.keys()]) void probe(stream, blockId);
}

function startStream(stream: SessionStream): void {
	stream.reconnectTimer = null;
	const child = spawn("rex", ["--autostart=false", "events", "-s", stream.sessionId, "--json"], {
		stdio: ["ignore", "pipe", "pipe"],
	});
	stream.child = child;
	stream.closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
	let buffered = "";
	let stderr = "";
	let delivered = false;
	child.stdout?.setEncoding("utf8");
	child.stdout?.on("data", (chunk: string) => {
		delivered = true;
		buffered += chunk;
		const lines = buffered.split("\n");
		buffered = lines.pop() ?? "";
		for (const line of lines) if (line.trim()) handleEvent(stream, line);
	});
	child.stderr?.setEncoding("utf8");
	child.stderr?.on("data", (chunk: string) => {
		stderr = (stderr + chunk).slice(-4096);
	});
	child.once("error", () => {});
	child.once("close", () => {
		if (stream.child !== child) return;
		stream.child = null;
		if (stream.waiters.size === 0) return;
		if (stderr.includes(`session target "${stream.sessionId}" not found`)) {
			// The whole session is gone, and every block in it with it.
			for (const blockId of [...stream.waiters.keys()]) settle(stream, blockId, blockClosed(blockId));
			return;
		}
		stream.failures = delivered ? 1 : stream.failures + 1;
		const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_MIN_MS * 2 ** (stream.failures - 1));
		stream.reconnectTimer = setTimeout(() => startStream(stream), delay);
	});
	probeAll(stream);
	if (stream.settleTimer) clearTimeout(stream.settleTimer);
	stream.settleTimer = setTimeout(() => {
		stream.settleTimer = null;
		probeAll(stream);
	}, SUBSCRIBE_SETTLE_MS);
}

function stopStream(stream: SessionStream): Promise<void> {
	if (streams.get(stream.sessionId) === stream) streams.delete(stream.sessionId);
	if (stream.reconnectTimer) clearTimeout(stream.reconnectTimer);
	if (stream.settleTimer) clearTimeout(stream.settleTimer);
	stream.reconnectTimer = null;
	stream.settleTimer = null;
	const child = stream.child;
	const closed = stream.closed ?? Promise.resolve();
	stream.child = null;
	if (!child || child.exitCode !== null || child.signalCode !== null) return closed;
	child.kill("SIGTERM");
	const killTimer = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
	return closed.then(() => clearTimeout(killTimer));
}

/** Resolves with the child's exit status; rejects on abort or when the block is gone. */
export function watchRexChildExit(target: RexTarget, signal: AbortSignal): Promise<number> {
	if (signal.aborted) return Promise.reject(new Error("Aborted while waiting for Rex child"));
	let stream = streams.get(target.sessionId);
	const isNew = !stream;
	if (!stream) {
		stream = {
			sessionId: target.sessionId,
			waiters: new Map(),
			child: null,
			closed: null,
			reconnectTimer: null,
			settleTimer: null,
			failures: 0,
		};
		streams.set(target.sessionId, stream);
	}
	const owner = stream;
	const pending = new Promise<number>((resolve, reject) => {
		const waiter: Waiter = {
			resolve: (code) => {
				signal.removeEventListener("abort", onAbort);
				resolve(code);
			},
			reject: (error) => {
				signal.removeEventListener("abort", onAbort);
				reject(error);
			},
		};
		function onAbort() {
			const waiters = owner.waiters.get(target.blockId);
			waiters?.delete(waiter);
			if (waiters?.size === 0) owner.waiters.delete(target.blockId);
			const stopped = owner.waiters.size === 0 ? stopStream(owner) : Promise.resolve();
			void stopped.then(() => reject(new Error("Aborted while waiting for Rex child")));
		}
		signal.addEventListener("abort", onAbort, { once: true });
		const waiters = owner.waiters.get(target.blockId) ?? new Set<Waiter>();
		waiters.add(waiter);
		owner.waiters.set(target.blockId, waiters);
	});
	if (isNew) startStream(owner);
	else {
		// The stream may have started before this child; catch an exit it already missed.
		void probe(owner, target.blockId);
		setTimeout(() => void probe(owner, target.blockId), SUBSCRIBE_SETTLE_MS).unref?.();
	}
	return pending;
}

/** Test and shutdown visibility: how many `rex events` processes are alive. */
export function liveRexEventStreams(): number {
	return [...streams.values()].filter((stream) => stream.child).length;
}

process.once("exit", () => {
	for (const stream of streams.values()) stream.child?.kill("SIGKILL");
});
