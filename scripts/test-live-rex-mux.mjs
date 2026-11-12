#!/usr/bin/env node
// Real Rex contract smoke. No model requests, authentication copies, or user panes.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

if (process.env.PI_SUBAGENT_ALLOW_LIVE_WINDOWS !== "1") {
  console.log("SKIP: set PI_SUBAGENT_ALLOW_LIVE_WINDOWS=1 to create an isolated Rex test session.");
  process.exit(0);
}
const { createRexCommandSurface, closeRexSurface, rexChildTarget, waitForRexExit, readRexScreen, sendRexCommand, renameRexChild } = await import("../src/mux/rex.ts");
const { liveRexEventStreams } = await import("../src/mux/rex-events.ts");
const { getMuxBackend } = await import("../src/mux/core.ts");
const { pollForExit } = await import("../src/mux/poll.ts");
const { buildInteractiveShellCommand } = await import("../src/launch/shell-command.ts");
const { watchSubagent } = await import("../src/runtime/interactive-watch.ts");
const { registerSetTabTitleTool } = await import("../src/tools/set-tab-title.ts");
const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-rex-mux-smoke-")));
const children = new Map();
const rex = (...args) => execFileSync("rex", ["--autostart=false", ...args], { encoding: "utf8", timeout: 15_000 });
const json = (...args) => JSON.parse(rex(...args));
let session;
let anchor;
/** Counts real `rex events` processes for the smoke session, not just what the module believes. */
const liveRexEventProcesses = () => {
  try {
    return execFileSync("pgrep", ["-f", `events -s ${session} --json`], { encoding: "utf8" }).trim().split("\n").length;
  } catch { return 0; }
};
try {
  const created = json("new", `pi-rex-mux-smoke-${process.pid}`, "--window", "Smoke anchor", "-c", root,
    "--shell=none", "--json", "--", process.execPath, "-e", "setInterval(()=>{},1000)");
  session = created.session_id;
  anchor = created.initial_windows[0].block_ids[0];
  for (const key of ["HERDR_ENV", "HERDR_PANE_ID", "HERDR_TAB_ID", "TMUX", "CMUX_SOCKET_PATH", "ZELLIJ", "ZELLIJ_SESSION_NAME", "WEZTERM_UNIX_SOCKET", "PI_SUBAGENT_MUX"]) delete process.env[key];
  process.env.REX_SESSION = session;
  process.env.REX_BLOCK = anchor;
  assert.equal(getMuxBackend(), "rex");
  const parent = { sessionId: session, blockId: anchor };
  const create = (argv, label = "Smoke child") => {
    const block = createRexCommandSurface(label, argv, root);
    children.set(block, rexChildTarget(parent, block));
    return block;
  };
  const close = (block) => { closeRexSurface(block, children.get(block)); children.delete(block); };

  // Wait starts before process exit, then exercises the already-exited path too.
  for (const status of [0, 42]) {
    const block = create([process.execPath, "-e", `setTimeout(()=>process.exit(${status}),400)`]);
    assert.equal(await waitForRexExit(block, new AbortController().signal, children.get(block)), status);
    assert.equal(await waitForRexExit(block, new AbortController().signal, children.get(block)), status);
    close(block);
  }
  console.log("PASS: native split and live/already-exited wait payloads");

  const input = create([process.execPath, "-e", "process.stdin.setEncoding('utf8');process.stdin.once('data',d=>{console.log('INPUT:'+JSON.stringify(d));process.exit(0)})"]);
  sendRexCommand(input, "quotes ' and --literal", children.get(input));
  assert.equal(await waitForRexExit(input, new AbortController().signal, children.get(input)), 0);
  assert.match(readRexScreen(input, children.get(input)), /INPUT:.*quotes/);
  close(input);
  console.log("PASS: scoped literal input and capture");

  const running = create([process.execPath, "-e", "setInterval(()=>{},1000)"]);
  const waiterAbort = new AbortController();
  const waiter = waitForRexExit(running, waiterAbort.signal, children.get(running));
  setTimeout(() => waiterAbort.abort(), 100);
  await assert.rejects(waiter, /Aborted/);
  const sidecarSession = join(root, "child.jsonl");
  const pending = pollForExit(running, new AbortController().signal,
    { interval: 25, sessionFile: sidecarSession, rexTarget: children.get(running) });
  setTimeout(() => writeFileSync(`${sidecarSession}.exit`, JSON.stringify({ type: "ping", name: "smoke-worker", message: "Need decision" })), 100);
  const outcome = await pending;
  assert.equal(outcome.reason, "ping");
  assert.equal(outcome.ping?.message, "Need decision");
  assert.equal(json("block", "call", "-s", session, "-b", running, "process").last_exit, null);
  close(running);
  console.log("PASS: waiter cancellation and ping before process exit");

  // Several children share one subscription; a closed pane ends its wait without an exit status.
  const shared = [0, 3, 5].map((status) =>
    create([process.execPath, "-e", `setTimeout(()=>process.exit(${status}),800)`], `Shared ${status}`));
  const sharedWaits = shared.map((block) => waitForRexExit(block, new AbortController().signal, children.get(block)));
  assert.equal(liveRexEventStreams(), 1);
  await delay(200);
  assert.equal(liveRexEventProcesses(), 1, "one rex events process for three children");
  assert.deepEqual(await Promise.all(sharedWaits), [0, 3, 5]);
  assert.equal(liveRexEventProcesses(), 0);
  for (const block of shared) close(block);
  const doomed = create([process.execPath, "-e", "setInterval(()=>{},1000)"], "Closed pane");
  const doomedWait = waitForRexExit(doomed, new AbortController().signal, children.get(doomed));
  await delay(700);
  rex("block", "close", "-s", session, doomed);
  children.delete(doomed);
  await assert.rejects(doomedWait, /closed before reporting an exit status/);
  assert.equal(liveRexEventProcesses(), 0);
  console.log("PASS: one shared rex events stream, exact closed-pane outcome, nothing left running");

  // Exercise private capsule argv and actual child identity hydration without a model.
  const childScript = join(root, "child-probe.mjs");
  const resultFile = join(root, "identity.json");
  writeFileSync(childScript, `import fs from 'node:fs';fs.writeFileSync(process.env.PI_TEST_PROBE_FILE,JSON.stringify({cwd:process.cwd(),session:process.env.REX_SESSION,block:process.env.REX_BLOCK,surface:process.env.PI_SUBAGENT_SURFACE,herdr:process.env.HERDR_ENV,args:process.argv.slice(2)}));process.exit(0);`);
  process.env.PI_SUBAGENT_PI_COMMAND = `'${process.execPath.replaceAll("'", "'\\''")}' '${childScript.replaceAll("'", "'\\''")}'`;
  const launch = buildInteractiveShellCommand({ cwd: root, piArgs: ["quotes ' and --literal"],
    envOverrides: { PI_TEST_PROBE_FILE: resultFile, PI_SUBAGENT_SURFACE: anchor },
    doneSentinelFile: join(root, "done"), rexParent: parent });
  try {
    const block = create(launch.argv, "Capsule child");
    assert.equal(await waitForRexExit(block, new AbortController().signal, children.get(block)), 0);
    const identity = JSON.parse(readFileSync(resultFile, "utf8"));
    assert.deepEqual(identity, { cwd: root, session, block, surface: block, args: ["quotes ' and --literal"] });
    close(block);
  } finally { launch.dispose(); }
  console.log("PASS: exact capsule argv, cwd, and fresh child identity");

  const originalRuntime = process.execPath;
  const originalScript = process.argv[1];
  const originalOverride = process.env.PI_SUBAGENT_PI_COMMAND;
  const missingRuntime = join(root, "removed-cellar", "node");
  let recovered;
  try {
    process.execPath = missingRuntime;
    process.argv[1] = childScript;
    delete process.env.PI_SUBAGENT_PI_COMMAND;
    recovered = buildInteractiveShellCommand({ cwd: root, piArgs: ["runtime recovered"],
      envOverrides: { PI_TEST_PROBE_FILE: resultFile }, doneSentinelFile: join(root, "recovered-done"), rexParent: parent });
  } finally {
    process.execPath = originalRuntime;
    process.argv[1] = originalScript;
    if (originalOverride === undefined) delete process.env.PI_SUBAGENT_PI_COMMAND;
    else process.env.PI_SUBAGENT_PI_COMMAND = originalOverride;
  }
  try {
    assert.notEqual(recovered.argv[0], missingRuntime);
    assert.ok(existsSync(recovered.argv[0]));
    const block = create(recovered.argv, "Recovered runtime child");
    assert.equal(await waitForRexExit(block, new AbortController().signal, children.get(block)), 0);
    assert.deepEqual(JSON.parse(readFileSync(resultFile, "utf8")).args, ["runtime recovered"]);
    close(block);
  } finally { recovered?.dispose(); }
  console.log("PASS: removed runtime recovers through PATH for launcher and child");

  // A valid executable that exits before reading the capsule models a pre-runner failure.
  const failedRuntime = join(root, "pre-runner-failure");
  writeFileSync(failedRuntime, "#!/bin/sh\nprintf '%s\\n' 'intentional pre-runner failure' >&2\nexit 127\n", { mode: 0o700 });
  let failed;
  try {
    process.execPath = failedRuntime;
    failed = buildInteractiveShellCommand({ cwd: root, piArgs: [], envOverrides: {},
      doneSentinelFile: join(root, "failed-done"), rexParent: parent });
  } finally { process.execPath = originalRuntime; }
  try {
    const block = create(failed.argv, "Pre-runner failure child");
    assert.ok(existsSync(failed.capsulePath));
    const state = { name: "failure-probe", task: "Check cleanup", mode: "interactive", startTime: Date.now(),
      sessionFile: join(root, "failure-session.jsonl"), surface: block, rexTarget: children.get(block),
      doneSentinelFile: join(root, "failed-done"), disposeLaunchCapsule: failed.dispose };
    const result = await watchSubagent(state, {
      closeRunningSurface: async () => close(block), cleanupNoSessionSessionFile: () => {},
    }, new AbortController().signal);
    assert.equal(result.exitCode, 127);
    assert.match(result.summary, /intentional pre-runner failure/);
    assert.equal(existsSync(failed.capsulePath), false);
    assert.equal(state.disposeLaunchCapsule, undefined);
  } finally { failed?.dispose(); }
  console.log("PASS: pre-runner failure retains diagnostics and disposes capsule");

  const named = create([process.execPath, "-e", "setInterval(()=>{},1000)"], "[s] [worker] Launch task");
  process.env.REX_BLOCK = named;
  process.env.PI_SUBAGENT_NAME = "smoke-worker";
  process.env.PI_SUBAGENT_SURFACE = named;
  process.env.PI_SUBAGENT_INITIAL_TITLE = "[worker] Launch task";
  renameRexChild("Next task");
  assert.equal(json("block", "inspect", "-s", session, named, "--json").block.label, "[s] [worker] Next task");
  rex("block", "rename", "-s", session, named, "[s] [worker] Manual user title");
  renameRexChild("Do not overwrite");
  assert.equal(json("block", "inspect", "-s", session, named, "--json").block.label, "[s] [worker] Manual user title");
  const previousTitleOptIn = process.env.PI_SUBAGENT_ENABLE_SET_TAB_TITLE;
  try {
    process.env.PI_SUBAGENT_ENABLE_SET_TAB_TITLE = "1";
    let titleTool;
    registerSetTabTitleTool({ registerTool: (tool) => { titleTool = tool; } });
    const result = await titleTool.execute("manual-title-probe", { title: "Do not overwrite" });
    assert.equal(result.details.changed, false);
    assert.match(result.content[0].text, /^Title unchanged:/);
    assert.equal(json("block", "inspect", "-s", session, named, "--json").block.label, "[s] [worker] Manual user title");
  } finally {
    if (previousTitleOptIn === undefined) delete process.env.PI_SUBAGENT_ENABLE_SET_TAB_TITLE;
    else process.env.PI_SUBAGENT_ENABLE_SET_TAB_TITLE = previousTitleOptIn;
  }
  process.env.REX_BLOCK = anchor;
  for (const key of ["PI_SUBAGENT_NAME", "PI_SUBAGENT_SURFACE", "PI_SUBAGENT_INITIAL_TITLE"]) delete process.env[key];
  close(named);
  console.log("PASS: child title preserves model/agent tags and manual edits");

  const orphan = create([process.execPath, "-e", "setInterval(()=>{},1000)"]);
  const saved = children.get(orphan);
  rex("block", "close", "-s", session, anchor);
  delete process.env.REX_SESSION;
  delete process.env.REX_BLOCK;
  assert.match(readRexScreen(orphan, saved), /^/);
  close(orphan);
  console.log("PASS: owned child cleanup after parent block disappears");
  console.log("REX_LIVE_MUX_SMOKE_OK");
} finally {
  for (const [block, target] of children) {
    try { closeRexSurface(block, target); } catch (error) { console.error(`Cleanup ${block}: ${error.message}`); }
  }
  if (session) {
    // Closing the last block may already have removed the dedicated session.
    const sessions = json("ls", "--json").sessions;
    if (sessions.some((s) => s.session_id === session)) rex("kill", session);
  }
  await delay(20);
  rmSync(root, { recursive: true, force: true });
}
