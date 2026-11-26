import { existsSync, readdirSync } from "node:fs";
import {
	claimPendingSteerMessages,
	getSteerInboxDir,
	getSteerMessageState,
	markSteerMessageDelivered,
	takeUndeliveredSteerCount,
	writeSteerMessage,
} from "../../src/session/steer-inbox.ts";
import { assert, createTestDir, describe, it, join } from "../support/index.ts";

describe("steer inbox", () => {
	it("moves a message from pending through taken to delivered", () => {
		const sessionFile = join(createTestDir(), "child.jsonl");
		const key = writeSteerMessage(sessionFile, "Use the v2 API");
		assert.equal(getSteerMessageState(sessionFile, key), "pending");
		assert.deepEqual(
			readdirSync(getSteerInboxDir(sessionFile)).filter((name) => name.endsWith(".tmp")),
			[],
			"the temp file is renamed into place",
		);

		const [claimed] = claimPendingSteerMessages(sessionFile);
		assert.equal(claimed.key, key);
		assert.equal(claimed.text, "Use the v2 API");
		assert.equal(getSteerMessageState(sessionFile, key), "taken");
		assert.deepEqual(claimPendingSteerMessages(sessionFile), [], "a claimed message is handed out once");

		markSteerMessageDelivered(sessionFile, key);
		assert.equal(getSteerMessageState(sessionFile, key), "delivered");
	});

	it("hands messages out in the order they were written", () => {
		const sessionFile = join(createTestDir(), "child.jsonl");
		writeSteerMessage(sessionFile, "first", 1_000);
		writeSteerMessage(sessionFile, "second", 1_000);
		writeSteerMessage(sessionFile, "third", 2_000);
		assert.deepEqual(
			claimPendingSteerMessages(sessionFile).map((message) => message.text),
			["first", "second", "third"],
		);
	});

	it("counts pending and taken messages as undelivered and removes the inbox", () => {
		const sessionFile = join(createTestDir(), "child.jsonl");
		const delivered = writeSteerMessage(sessionFile, "read");
		claimPendingSteerMessages(sessionFile);
		markSteerMessageDelivered(sessionFile, delivered);
		writeSteerMessage(sessionFile, "taken but unread");
		claimPendingSteerMessages(sessionFile);
		writeSteerMessage(sessionFile, "never picked up");

		assert.equal(takeUndeliveredSteerCount(sessionFile), 2);
		assert.equal(existsSync(getSteerInboxDir(sessionFile)), false);
		assert.equal(takeUndeliveredSteerCount(sessionFile), 0, "a missing inbox has nothing undelivered");
	});
});
