import { existsSync } from "node:fs";
import { formatUndeliveredSteerNotice, settleUndeliveredSteers } from "../../src/runtime/result-router.ts";
import { completedSubagentResults, runningSubagents } from "../../src/runtime/state.ts";
import {
	claimPendingSteerMessages,
	getSteerInboxDir,
	markSteerMessageDelivered,
	writeSteerMessage,
} from "../../src/session/steer-inbox.ts";
import {
	formatParentSteerContent,
	installParentSteerReceiver,
	PARENT_STEER_MESSAGE_TYPE,
} from "../../src/tools/parent-steer-receiver.ts";
import { STEER_MAX_CHARS, steerSubagent } from "../../src/tools/subagent-steer.ts";
import { registerSubagentsView } from "../../src/tools/subagents-view.ts";
import {
	afterEach,
	assert,
	createTestDir,
	describe,
	it,
	join,
	resetSubagentStateForTest,
	setRunningSubagentForTest,
} from "../support/index.ts";

function runningChild(id: string, name: string, extra: Record<string, unknown> = {}): string {
	const sessionFile = join(createTestDir(), `${id}.jsonl`);
	setRunningSubagentForTest({
		id,
		name,
		task: "Explore",
		mode: "background",
		executionState: "running",
		deliveryState: "detached",
		parentClosePolicy: "terminate",
		startTime: Date.now(),
		sessionFile,
		...extra,
	} as any);
	return sessionFile;
}

/** The child side: claims each pending message and records it as read. */
function childReads(sessionFile: string) {
	return async () => {
		for (const message of claimPendingSteerMessages(sessionFile)) markSteerMessageDelivered(sessionFile, message.key);
	};
}

function fakeChildPi() {
	const handlers = new Map<string, Array<(event: any, ctx?: any) => void>>();
	const sent: Array<{ message: any; options: any }> = [];
	const renderers = new Map<string, unknown>();
	const pi = {
		on(event: string, handler: (event: any, ctx?: any) => void) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		sendMessage(message: any, options: any) {
			sent.push({ message, options });
		},
		registerMessageRenderer(type: string, renderer: unknown) {
			renderers.set(type, renderer);
		},
	};
	const emit = (event: string, payload: unknown = {}) => {
		for (const handler of handlers.get(event) ?? []) handler(payload, {});
	};
	return { pi: pi as any, sent, renderers, emit, handlers };
}

describe("subagent steer", () => {
	afterEach(() => {
		resetSubagentStateForTest();
	});

	it("reports delivered once the child has read the message", async () => {
		const sessionFile = runningChild("a1b2c3d4", "scout");
		const { outcome, text } = await steerSubagent("scout", "  Skip the docs folder  ", { sleep: childReads(sessionFile) });
		assert.equal(outcome, "delivered");
		assert.match(text, /^Delivered to the subagent "scout" \(a1b2c3d4\)/);
		assert.match(text, /does not wait for a reply/);
	});

	it("reports queued when the child does not read the message in time", async () => {
		const sessionFile = runningChild("a1b2c3d4", "scout");
		const pending = await steerSubagent("a1b2c3d4", "Skip the docs folder", { ackTimeoutMs: 0 });
		assert.equal(pending.outcome, "queued");
		assert.match(pending.text, /has not picked it up yet/);

		claimPendingSteerMessages(sessionFile);
		writeSteerMessage(sessionFile, "unrelated");
		const taken = await steerSubagent("scout", "Also skip tests", {
			ackTimeoutMs: 50,
			sleep: async () => {
				claimPendingSteerMessages(sessionFile);
			},
		});
		assert.equal(taken.outcome, "queued");
		assert.match(taken.text, /reads it as soon as its current tool call finishes/);
		assert.match(taken.text, /reports the message as undelivered/);
	});

	it("reports a child that finished while the tool waited", async () => {
		runningChild("a1b2c3d4", "scout");
		const result = await steerSubagent("scout", "Skip the docs folder", {
			sleep: async () => {
				runningSubagents.delete("a1b2c3d4");
			},
		});
		assert.equal(result.outcome, "queued");
		assert.match(result.text, /finished before it read the message/);
	});

	it("rejects empty, oversized, unknown, finished, and wrapping-up targets", async () => {
		runningChild("a1b2c3d4", "scout");
		await assert.rejects(steerSubagent("scout", "   "), /The message is empty/);
		await assert.rejects(
			steerSubagent("scout", "x".repeat(STEER_MAX_CHARS + 1)),
			new RegExp(`limit is ${STEER_MAX_CHARS}\\. Write longer material to a file`),
		);
		await assert.rejects(steerSubagent("nobody", "hi"), /No running subagent matches "nobody"/);

		completedSubagentResults.set("d0d0d0d0", { id: "d0d0d0d0", name: "done-child" } as any);
		await assert.rejects(steerSubagent("done-child", "hi"), /has already finished.*use subagent_resume/s);

		runningChild("e5f6a7b8", "late", { timeoutWrapUp: { kind: "timeout", seconds: 900, threshold: 80 } });
		await assert.rejects(steerSubagent("late", "hi"), /only writing its final report/);
	});
});

describe("/subagents steer", () => {
	afterEach(() => {
		resetSubagentStateForTest();
	});

	it("sends the raw rest of the line and rejects malformed arguments", async () => {
		const sessionFile = runningChild("a1b2c3d4", "scout");
		let handler: ((args: string, ctx: unknown) => Promise<void>) | undefined;
		registerSubagentsView(
			{
				registerCommand: (_name: string, opts: { handler: typeof handler }) => {
					handler = opts.handler;
				},
				registerShortcut() {},
				on() {},
			} as any,
			{} as any,
		);
		const notes: Array<[string, string]> = [];
		const ctx = { ui: { notify: (text: string, level: string) => notes.push([text, level]) } };
		const received: string[] = [];
		const child = setInterval(() => {
			for (const message of claimPendingSteerMessages(sessionFile)) {
				received.push(message.text);
				markSteerMessageDelivered(sessionFile, message.key);
			}
		}, 10);
		try {
			await handler?.("steer scout  Keep   the spacing", ctx);
		} finally {
			clearInterval(child);
		}
		await handler?.("steer scout", ctx);
		await handler?.("steer nobody hello", ctx);

		assert.deepEqual(received, ["Keep   the spacing"]);
		assert.equal(notes[0][1], "info");
		assert.match(notes[0][0], /^Delivered to the subagent "scout"/);
		assert.match(notes[1][0], /\/subagents steer <id\|name> <message>/);
		assert.deepEqual(notes[2], ['No running subagent matches "nobody".', "error"]);
	});
});

describe("parent steer receiver", () => {
	it("hands inbox messages to Pi as steers and marks them delivered at message end", () => {
		const sessionFile = join(createTestDir(), "child.jsonl");
		const first = writeSteerMessage(sessionFile, "first", 1_000);
		writeSteerMessage(sessionFile, "second", 2_000);
		const child = fakeChildPi();
		installParentSteerReceiver(child.pi, sessionFile);
		assert.equal(child.handlers.has("input"), false, "a steer never reads as operator input");

		child.emit("session_start");
		try {
			assert.deepEqual(
				child.sent.map((entry) => entry.message.details.text),
				["first", "second"],
			);
			const [{ message, options }] = child.sent;
			assert.equal(message.customType, PARENT_STEER_MESSAGE_TYPE);
			assert.equal(message.content, formatParentSteerContent("first"));
			assert.match(message.content, /^<parent-steer>\n[\s\S]*\nfirst\n<\/parent-steer>$/);
			assert.deepEqual(options, { triggerTurn: true, deliverAs: "steer" });
			assert.ok(child.renderers.has(PARENT_STEER_MESSAGE_TYPE));

			child.emit("message_end", { message: { role: "custom", ...message } });
			assert.ok(existsSync(join(getSteerInboxDir(sessionFile), `${first}.delivered`)));
		} finally {
			child.emit("session_shutdown");
		}
	});

	it("stays off outside a subagent", () => {
		const child = fakeChildPi();
		installParentSteerReceiver(child.pi, undefined);
		assert.equal(child.handlers.size, 0);
	});
});

describe("undelivered steer notice", () => {
	it("counts once per run and words the notice by count", () => {
		const sessionFile = join(createTestDir(), "child.jsonl");
		writeSteerMessage(sessionFile, "never read");
		const running = { sessionFile } as any;
		assert.equal(settleUndeliveredSteers(running), 1);
		assert.equal(settleUndeliveredSteers(running), 1, "the routed and the awaited result see the same count");
		assert.equal(existsSync(getSteerInboxDir(sessionFile)), false);

		assert.equal(formatUndeliveredSteerNotice({}), "");
		assert.match(formatUndeliveredSteerNotice({ undeliveredSteers: 1 }), /1 message you sent with subagent_steer never reached/);
		assert.match(formatUndeliveredSteerNotice({ undeliveredSteers: 2 }), /2 messages .* without them\.$/);
	});
});
