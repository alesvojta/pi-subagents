import { spawn } from "node:child_process";
import { getJobRunnerPath } from "../../src/jobs/job-launch.ts";

/** Runs the real job runner for DIR, as Rex would inside the job's pane. */
export function startRunner(dir: string) {
	const child = spawn(process.execPath, [getJobRunnerPath(), dir], { stdio: ["ignore", "pipe", "pipe"] });
	let screen = "";
	child.stdout.on("data", (chunk) => {
		screen += chunk;
	});
	const exited = new Promise<number | null>((resolve) => child.once("close", (code) => resolve(code)));
	return { child, exited, screen: () => screen };
}

export function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

export async function until(condition: () => boolean, what: string, ms = 3000): Promise<void> {
	for (let i = 0; i < ms / 10; i++) {
		if (condition()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`Timed out waiting for ${what}`);
}
