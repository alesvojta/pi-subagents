import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { isJobId, type JobResult, jobPaths } from "./job-files.ts";
import { isJobWatched, type LaunchedJob, loadLaunchedJob, watchRexJob } from "./job-launch.ts";

/**
 * Watch this session's undelivered jobs again after a reload or restart.
 *
 * The usual watcher does the rest: the shared Rex event stream probes
 * `last_exit` on connect, so a job that ended while no parent watched is
 * delivered at once, and a pane counts as gone only on Rex's exact
 * "not found" answer. Delivery stays exactly-once through the
 * `delivered.json` claim, also against a second parent process or a stop.
 */
export function reattachRexJobs(
	jobsDir: string,
	deliver: (job: LaunchedJob, result: JobResult) => void,
): LaunchedJob[] {
	let names: string[];
	try {
		names = readdirSync(jobsDir);
	} catch {
		return [];
	}
	const reattached: LaunchedJob[] = [];
	for (const id of names.sort()) {
		if (!isJobId(id) || isJobWatched(id)) continue;
		const dir = join(jobsDir, id);
		if (existsSync(jobPaths(dir).delivered)) continue;
		// Only a job whose spec and recorded pane are consistent with its directory is adopted.
		const job = loadLaunchedJob(dir);
		if (!job) continue;
		void watchRexJob(job, deliver).catch(() => {
			// The pane and log remain; the next start tries again.
		});
		reattached.push(job);
	}
	return reattached;
}
