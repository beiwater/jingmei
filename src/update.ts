import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, openSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

export const UPDATE_LOCK_FILE = ".jingmei-update.lock";
export const RELOAD_FILE = ".jingmei-reload";
const exec = promisify(execFile);

/** Keep subprocess output private: Git URLs and install errors can contain credentials. */
async function command(cwd: string, executable: string, args: string[], failure: string): Promise<string> {
	try {
		const { stdout } = await exec(executable, args, { cwd, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });
		return stdout.trim();
	} catch {
		throw new Error(failure);
	}
}

/** Update this checkout's tracking branch; never stash, reset or overwrite local changes. */
export async function updateProject(rootDir = process.cwd(), progress: (step: string) => void = () => {}) {
	const git = (args: string[], failure: string) => command(rootDir, "git", args, failure);
	const root = await git(["rev-parse", "--show-toplevel"], "Update requires a Git clone of jingmei and Git on PATH.");
	if (realpathSync(root) !== realpathSync(rootDir)) throw new Error("Run update from the jingmei repository root.");
	const lock = join(rootDir, UPDATE_LOCK_FILE);
	try {
		const fd = openSync(lock, "wx", 0o600);
		closeSync(fd);
	} catch {
		throw new Error(`Cannot lock update. If a previous update was interrupted, remove ${UPDATE_LOCK_FILE} and retry.`);
	}
	try {
		const dirty = await git(["status", "--porcelain", "--untracked-files=no"], "Cannot check local changes.");
		if (dirty) throw new Error("Commit or stash tracked local changes before updating; nothing was changed.");
		await git(["symbolic-ref", "--quiet", "HEAD"], "Switch to a branch with an upstream before updating.");
		await git(["rev-parse", "--verify", "@{upstream}"], "This branch has no upstream; set its tracking branch first.");
		const previous = await git(["rev-parse", "--short", "HEAD"], "Cannot read the current revision.");
		progress("Pulling the tracking branch (fast-forward only)");
		await git(
			["pull", "--ff-only"],
			"Git pull failed. Check connectivity, upstream and local divergence; no reload requested.",
		);
		progress("Installing locked dependencies");
		await command(
			rootDir,
			process.execPath,
			["install", "--frozen-lockfile"],
			"Dependency installation failed; no reload requested. Fix the cause and run update again.",
		);
		progress("Checking TypeScript");
		await command(
			rootDir,
			process.execPath,
			["run", "check"],
			"TypeScript check failed; no reload requested. Fix the cause and run update again.",
		);
		const current = await git(["rev-parse", "--short", "HEAD"], "Cannot read the updated revision.");
		// Notify only after every step succeeds, including an up-to-date retry after a failed install.
		writeFileSync(join(rootDir, RELOAD_FILE), randomUUID(), { mode: 0o600 });
		return { previous, current };
	} finally {
		unlinkSync(lock);
	}
}
