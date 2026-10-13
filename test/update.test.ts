import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RELOAD_FILE, UPDATE_LOCK_FILE, updateProject } from "../src/update.ts";
import { useCleanups } from "./support/cleanup.ts";

const cleanups = useCleanups();

function run(cwd: string, command: string[]): string {
	const child = Bun.spawnSync(command, { cwd, stdout: "pipe", stderr: "pipe" });
	if (child.exitCode) throw new Error(child.stderr.toString());
	return child.stdout.toString().trim();
}

function git(cwd: string, ...args: string[]): string {
	return run(cwd, ["git", "-c", "commit.gpgsign=false", ...args]);
}

function identity(cwd: string) {
	git(cwd, "config", "user.name", "Jingmei test");
	git(cwd, "config", "user.email", "test@example.invalid");
}

function repository() {
	const dir = cleanups.tmpDir();
	const remote = join(dir, "remote.git");
	const source = join(dir, "source");
	const checkout = join(dir, "checkout");
	mkdirSync(source);
	git(dir, "init", "--bare", "--initial-branch=main", remote);
	git(source, "init", "--initial-branch=main");
	identity(source);
	writeFileSync(join(source, "package.json"), JSON.stringify({ name: "update-test", scripts: { check: "true" } }));
	writeFileSync(
		join(source, ".gitignore"),
		`${RELOAD_FILE}\n${UPDATE_LOCK_FILE}\n.env\ndata/\npersonas/\nnode_modules/\nrepaired\n`,
	);
	writeFileSync(join(source, "version.txt"), "old");
	run(source, [process.execPath, "install"]);
	git(source, "add", "package.json", ".gitignore", "version.txt");
	git(source, "commit", "-m", "Initial fixture");
	git(source, "remote", "add", "origin", remote);
	git(source, "push", "-u", "origin", "main");
	git(dir, "clone", remote, checkout);
	identity(checkout);
	return {
		source,
		checkout,
		push(file: string, value: string) {
			writeFileSync(join(source, file), value);
			git(source, "add", file);
			git(source, "commit", "-m", "Update fixture");
			git(source, "push");
		},
	};
}

test("update fast-forwards, installs and requests reload while preserving private files", async () => {
	const repo = repository();
	mkdirSync(join(repo.checkout, "data"));
	mkdirSync(join(repo.checkout, "personas"));
	const privateFiles = [".env", "jingmei.config.json", "personas/pet.md", "data/state.txt"];
	for (const file of privateFiles) writeFileSync(join(repo.checkout, file), "private fixture");
	repo.push("version.txt", "new");
	const result = await updateProject(repo.checkout);
	expect(result.previous).not.toBe(result.current);
	expect(readFileSync(join(repo.checkout, "version.txt"), "utf8")).toBe("new");
	for (const file of privateFiles) expect(readFileSync(join(repo.checkout, file), "utf8")).toBe("private fixture");
	expect(existsSync(join(repo.checkout, RELOAD_FILE))).toBe(true);
	expect(existsSync(join(repo.checkout, UPDATE_LOCK_FILE))).toBe(false);
});

test("tracked local changes block update without changing HEAD or requesting reload", async () => {
	const repo = repository();
	const before = git(repo.checkout, "rev-parse", "HEAD");
	repo.push("version.txt", "remote");
	writeFileSync(join(repo.checkout, "version.txt"), "local");
	await expect(updateProject(repo.checkout)).rejects.toThrow("tracked local changes");
	expect(git(repo.checkout, "rev-parse", "HEAD")).toBe(before);
	expect(readFileSync(join(repo.checkout, "version.txt"), "utf8")).toBe("local");
	expect(existsSync(join(repo.checkout, RELOAD_FILE))).toBe(false);
	expect(existsSync(join(repo.checkout, UPDATE_LOCK_FILE))).toBe(false);
});

test("divergent history is never merged or reset", async () => {
	const repo = repository();
	repo.push("version.txt", "remote");
	writeFileSync(join(repo.checkout, "local.txt"), "local");
	git(repo.checkout, "add", "local.txt");
	git(repo.checkout, "commit", "-m", "Local work");
	const before = git(repo.checkout, "rev-parse", "HEAD");
	await expect(updateProject(repo.checkout)).rejects.toThrow("Git pull failed");
	expect(git(repo.checkout, "rev-parse", "HEAD")).toBe(before);
	expect(existsSync(join(repo.checkout, RELOAD_FILE))).toBe(false);
});

test("a failed install never requests reload and releases the update lock", async () => {
	const repo = repository();
	repo.push("package.json", "{ invalid json");
	await expect(updateProject(repo.checkout)).rejects.toThrow("Dependency installation failed");
	expect(existsSync(join(repo.checkout, RELOAD_FILE))).toBe(false);
	expect(existsSync(join(repo.checkout, UPDATE_LOCK_FILE))).toBe(false);
});

test("failed checks can be retried at the same revision before a reload is requested", async () => {
	const repo = repository();
	repo.push("package.json", JSON.stringify({ name: "update-test", scripts: { check: "test -f repaired" } }));
	await expect(updateProject(repo.checkout)).rejects.toThrow("TypeScript check failed");
	expect(existsSync(join(repo.checkout, RELOAD_FILE))).toBe(false);
	expect(existsSync(join(repo.checkout, UPDATE_LOCK_FILE))).toBe(false);
	writeFileSync(join(repo.checkout, "repaired"), "ready");
	const result = await updateProject(repo.checkout);
	expect(result.previous).toBe(result.current);
	expect(existsSync(join(repo.checkout, RELOAD_FILE))).toBe(true);
	const signal = readFileSync(join(repo.checkout, RELOAD_FILE), "utf8");
	await updateProject(repo.checkout);
	expect(readFileSync(join(repo.checkout, RELOAD_FILE), "utf8")).not.toBe(signal);
});

test("a concurrent update, detached HEAD and a missing upstream all fail safely", async () => {
	const repo = repository();
	const lock = join(repo.checkout, UPDATE_LOCK_FILE);
	writeFileSync(lock, "another update");
	await expect(updateProject(repo.checkout)).rejects.toThrow("Cannot lock update");
	expect(readFileSync(lock, "utf8")).toBe("another update");
	// Remove only our test lock, then exercise Git branch preconditions.
	unlinkSync(lock);
	git(repo.checkout, "checkout", "--detach");
	await expect(updateProject(repo.checkout)).rejects.toThrow("Switch to a branch");
	git(repo.checkout, "checkout", "main");
	git(repo.checkout, "branch", "--unset-upstream");
	await expect(updateProject(repo.checkout)).rejects.toThrow("no upstream");
	expect(existsSync(join(repo.checkout, RELOAD_FILE))).toBe(false);
});

test("update rejects archives and subdirectories rather than updating a parent repository", async () => {
	const dir = cleanups.tmpDir();
	await expect(updateProject(dir)).rejects.toThrow("Git clone");
	const repo = repository();
	const nested = join(repo.checkout, "nested");
	mkdirSync(nested);
	await expect(updateProject(nested)).rejects.toThrow("repository root");
	expect(existsSync(join(repo.checkout, RELOAD_FILE))).toBe(false);
});
