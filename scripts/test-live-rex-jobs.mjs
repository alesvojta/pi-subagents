#!/usr/bin/env node
// Real Rex background-job smoke. No model requests; uses an isolated Rex session.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

if (process.env.PI_SUBAGENT_ALLOW_LIVE_WINDOWS !== "1") {
  console.log("SKIP: set PI_SUBAGENT_ALLOW_LIVE_WINDOWS=1 to create an isolated Rex test session.");
  process.exit(0);
}
const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-rex-jobs-smoke-")));
process.env.PI_ARTIFACT_PROJECT_ROOT = join(root, "artifacts");
const { launchRexJob, watchRexJob } = await import("../src/jobs/job-launch.ts");
const { getSessionJobsDir, jobPaths } = await import("../src/jobs/job-files.ts");
const { listJobs, readJobLog, stopJob } = await import("../src/jobs/job-control.ts");
const { reattachRexJobs } = await import("../src/jobs/job-reattach.ts");
const rex = (...args) => execFileSync("rex", ["--autostart=false", ...args], { encoding: "utf8", timeout: 15_000 });
const json = (...args) => JSON.parse(rex(...args));
const isAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const blockExists = (block) => {
  try { execFileSync("rex", ["--autostart=false", "block", "inspect", "-s", session, block, "--json"], { stdio: "pipe" }); return true; }
  catch { return false; }
};
const windowLabelOf = (block) => {
  const windowId = json("block", "inspect", "-s", session, block, "--json").block.window_id;
  return json("session", "inspect", session, "--json").windows.find((w) => w.window_id === windowId)?.label;
};
let session;
try {
  const created = json("new", `pi-rex-jobs-smoke-${process.pid}`, "--window", "Smoke anchor", "-c", root,
    "--shell=none", "--json", "--", process.execPath, "-e", "setInterval(()=>{},1000)");
  session = created.session_id;
  for (const key of ["HERDR_ENV", "HERDR_PANE_ID", "HERDR_TAB_ID", "TMUX", "ZELLIJ", "PI_SUBAGENT_MUX"]) delete process.env[key];
  process.env.REX_SESSION = session;
  process.env.REX_BLOCK = created.initial_windows[0].block_ids[0];

  const jobsDir = getSessionJobsDir(root, "smoke-session");
  const run = async (command) => {
    const job = launchRexJob({ command, cwd: root, jobsDir });
    const deliveries = [];
    const result = await watchRexJob(job, (_job, value) => deliveries.push(value));
    return { job, result, deliveries };
  };

  const ok = await run("echo hello from job; pwd; echo to-stderr >&2");
  assert.equal(ok.result.status, "completed");
  assert.equal(ok.result.exitCode, 0);
  assert.equal(ok.deliveries.length, 1);
  assert.match(ok.result.tail, /hello from job/);
  assert.match(ok.result.tail, new RegExp(root));
  assert.match(readFileSync(jobPaths(ok.job.dir).log, "utf8"), /to-stderr/);
  await delay(300);
  assert.equal(blockExists(ok.job.blockId), false, "pane closes after delivery");
  const windows = json("session", "inspect", session, "--json").windows ?? [];
  console.log(`PASS: successful job delivered once, log written, pane closed (windows now: ${windows.length})`);

  const failed = await run("echo about to fail; exit 7");
  assert.equal(failed.result.status, "failed");
  assert.equal(failed.result.exitCode, 7);
  assert.equal(failed.deliveries.length, 1);
  assert.match(failed.result.tail, /about to fail/);
  console.log("PASS: failing job reports exit 7 and its output");

  // Closing the pane stops the whole process group, including grandchildren.
  const pidFile = join(root, "grandchild.pid");
  const job = launchRexJob({ command: `sleep 300 & echo $! > '${pidFile}'; wait`, cwd: root, jobsDir });
  const deliveries = [];
  const watching = watchRexJob(job, (_job, value) => deliveries.push(value));
  for (let i = 0; i < 100 && !existsSync(pidFile); i++) await delay(50);
  const grandchild = Number(readFileSync(pidFile, "utf8"));
  assert.ok(isAlive(grandchild));
  assert.equal(windowLabelOf(job.blockId), "Jobs", "jobs open in the parent's own Jobs window");
  assert.notEqual(json("block", "inspect", "-s", session, job.blockId, "--json").block.window_id,
    json("block", "inspect", "-s", session, process.env.REX_BLOCK, "--json").block.window_id);
  rex("block", "close", "-s", session, job.blockId);
  const closed = await watching;
  assert.equal(closed.status, "interrupted");
  assert.equal(deliveries.length, 1);
  for (let i = 0; i < 60 && isAlive(grandchild); i++) await delay(50);
  assert.equal(isAlive(grandchild), false, "grandchild in the job's process group is gone");
  console.log("PASS: closing the pane interrupts the job, kills its process group, delivers once");

  // Stopping a long command stops its process group and delivers "interrupted" once, watched or not.
  for (const watched of [true, false]) {
    const stopPid = join(root, `stop-grandchild-${watched}.pid`);
    const long = launchRexJob({ command: `echo working; sleep 300 & echo $! > '${stopPid}'; wait`, cwd: root, jobsDir });
    const stopDeliveries = [];
    const deliver = (_job, value) => stopDeliveries.push(value);
    const watcher = watched ? watchRexJob(long, deliver) : null;
    for (let i = 0; i < 100 && !existsSync(stopPid); i++) await delay(50);
    const sleeper = Number(readFileSync(stopPid, "utf8"));
    assert.equal(listJobs(jobsDir).find((j) => j.spec.id === long.spec.id)?.state, "running");
    assert.match((await readJobLog(long.dir, { tail: 5 })).text, /working/);
    const outcome = await stopJob(long.dir, deliver);
    assert.equal(outcome.kind, "stopped");
    for (let i = 0; i < 60 && isAlive(sleeper); i++) await delay(50);
    assert.equal(isAlive(sleeper), false, "the stopped job's process group is gone");
    for (let i = 0; i < 100 && stopDeliveries.length === 0; i++) await delay(50);
    await watcher;
    await delay(500);
    assert.equal(stopDeliveries.length, 1);
    assert.equal(stopDeliveries[0].status, "interrupted");
    assert.equal(stopDeliveries[0].signal, "SIGTERM");
    assert.equal(listJobs(jobsDir).find((j) => j.spec.id === long.spec.id)?.state, "interrupted");
    assert.equal((await stopJob(long.dir, deliver)).kind, "finished");
    await delay(300);
    assert.equal(blockExists(long.blockId), false, "the stopped job's pane closes after delivery");
    console.log(`PASS: stopping a ${watched ? "watched" : "no longer watched"} job kills its process group and delivers interrupted once`);
  }

  // Program status: a pane nobody watches keeps its final state, and the next start delivers it.
  const statusOf = (block) => json("block", "call", "-s", session, "-b", block, "program_status").records?.[0];
  const waitFor = async (what, check) => {
    for (let i = 0; i < 100; i++) { const value = check(); if (value) return value; await delay(100); }
    throw new Error(`Timed out waiting for ${what}`);
  };
  const unwatched = (command, name) => launchRexJob({ command, cwd: root, jobsDir, name });
  const passing = unwatched("sleep 1.5; echo status-ok", "status ok");
  const failing = unwatched("sleep 1.5; exit 5", "status fail");
  const stopping = unwatched("sleep 300", "status stop");
  const working = await waitFor("working", () => statusOf(passing.blockId)?.state === "working" && statusOf(passing.blockId));
  assert.equal(working.app, "shell");
  assert.equal(working.title, "status ok");
  const runner = await waitFor("the runner pid", () => existsSync(jobPaths(stopping.dir).runner) && JSON.parse(readFileSync(jobPaths(stopping.dir).runner, "utf8")));
  process.kill(runner.pid, "SIGTERM");
  const done = await waitFor("done", () => statusOf(passing.blockId)?.state === "done" && statusOf(passing.blockId));
  assert.match(done.msg, /^completed · exit 0/);
  const error = await waitFor("error", () => statusOf(failing.blockId)?.state === "error" && statusOf(failing.blockId));
  assert.match(error.msg, /^failed · exit 5/);
  const idle = await waitFor("idle", () => statusOf(stopping.blockId)?.state === "idle" && statusOf(stopping.blockId));
  assert.equal(idle.msg, "stopped (SIGTERM)");
  assert.doesNotMatch(readFileSync(jobPaths(passing.dir).log, "utf8"), /7501/);
  console.log("PASS: job panes report working, then done / error / idle, and keep it while undelivered");

  const reattached = [];
  const adopted = reattachRexJobs(jobsDir, (_job, value) => reattached.push(value));
  assert.deepEqual(adopted.map((j) => j.spec.id).sort(), [passing, failing, stopping].map((j) => j.spec.id).sort());
  await waitFor("three reattached deliveries", () => reattached.length === 3);
  await delay(500);
  assert.equal(reattached.length, 3);
  assert.deepEqual(reattached.map((r) => r.status).sort(), ["completed", "failed", "interrupted"]);
  for (const j of [passing, failing, stopping]) assert.equal(blockExists(j.blockId), false, "a reattached pane closes after delivery");
  assert.deepEqual(reattachRexJobs(jobsDir, () => assert.fail("delivered twice")), []);
  console.log("PASS: a restarted parent delivers jobs that ended while unwatched, once, and closes their panes");

  // A second watcher of a delivered job never delivers again.
  assert.equal(await watchRexJob(ok.job, () => assert.fail("delivered twice")), null);
  console.log("PASS: delivery is claimed exactly once");
  console.log("REX_LIVE_JOBS_SMOKE_OK");
} finally {
  if (session) {
    const sessions = json("ls", "--json").sessions;
    if (sessions.some((s) => s.session_id === session)) rex("kill", session);
  }
  rmSync(root, { recursive: true, force: true });
}
