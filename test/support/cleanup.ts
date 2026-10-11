import { afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Cleanup = () => void | Promise<void>;

/**
 * Registers an `afterEach` for the calling test file and returns the cleanup stack it drains, newest first.
 * Call once at the top of a file: `push` adds a teardown, `tmpDir` makes a temp directory removed last-in-first-out
 * with the rest (so anything pushed after the directory, such as closing a database inside it, runs first).
 */
export function useCleanups() {
	const cleanups: Cleanup[] = [];
	afterEach(async () => {
		for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	});
	return {
		push: (cleanup: Cleanup) => cleanups.push(cleanup),
		tmpDir(prefix = "jingmei-") {
			const dir = mkdtempSync(join(tmpdir(), prefix));
			cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
			return dir;
		},
	};
}
