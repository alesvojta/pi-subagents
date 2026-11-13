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
const { jobPaths } = await import("../src/jobs/job-files.ts");
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

  const run = async (command) => {
    const job = launchRexJob({ command, cwd: root, sessionId: "smoke-session" });
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
  const job = launchRexJob({ command: `sleep 300 & echo $! > '${pidFile}'; wait`, cwd: root, sessionId: "smoke-session" });
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
