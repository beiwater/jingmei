import { createHash } from "node:crypto";
import { existsSync, type FSWatcher, readFileSync, statSync, watch } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { loadConfig, readPersonaPaths } from "./config.ts";
import { errorCategory, log } from "./observability/log.ts";
import { RELOAD_FILE, UPDATE_LOCK_FILE } from "./update.ts";

interface RuntimeOptions {
	rootDir?: string;
	command?: string[];
	settleMs?: number;
	graceMs?: number;
}

/** Hash only after filesystem events, to ignore duplicate notifications and same-content saves. */
function snapshot(paths: string[]): string {
	const hash = createHash("sha256");
	for (const path of paths) {
		hash.update(path).update("\0");
		try {
			hash.update(readFileSync(path));
		} catch {
			hash.update("\0unreadable");
		}
		hash.update("\0");
	}
	return hash.digest("hex");
}

/** One supervisor, one bot worker. Reloads drain the old worker before creating its replacement. */
export async function superviseBot(options: RuntimeOptions = {}): Promise<number> {
	const rootDir = resolve(options.rootDir ?? process.cwd());
	const lock = join(rootDir, UPDATE_LOCK_FILE);
	const fixed = [join(rootDir, "jingmei.config.json"), join(rootDir, ".env"), join(rootDir, RELOAD_FILE)];
	let paths = fixed;
	let baseline = "";
	let rejected: string | undefined;
	let stopping = false;
	let reloading = false;
	let watchFailed = false;
	let debounce: Timer | undefined;
	let forceStop: Timer | undefined;
	let wakeUpdateWait: (() => void) | undefined;
	let child: ReturnType<typeof Bun.spawn>;
	const watchers = new Map<string, { watcher: FSWatcher; dev: number; ino: number }>();
	const stopWorker = (signal: "SIGINT" | "SIGTERM") => {
		child.kill(signal);
		forceStop = setTimeout(() => {
			log.warn("runtime", "shutdown_timeout", {});
			child.kill("SIGKILL");
		}, options.graceMs ?? 210_000);
	};
	const stop = (signal: "SIGINT" | "SIGTERM") => {
		if (stopping) return;
		stopping = true;
		clearTimeout(debounce);
		wakeUpdateWait?.();
		if (!reloading) stopWorker(signal);
	};
	const schedule = () => {
		wakeUpdateWait?.();
		if (stopping || reloading) return;
		clearTimeout(debounce);
		debounce = setTimeout(reconcile, options.settleMs ?? 500);
	};
	const refreshWatches = () => {
		let next = paths;
		try {
			next = [...fixed, ...readPersonaPaths(rootDir)];
		} catch {
			// A partial JSON edit retains the last known targets until its next filesystem event.
		}
		const directories = new Set<string>();
		for (const path of next) {
			let directory = dirname(path);
			while (!existsSync(directory)) directory = dirname(directory);
			// Parent-directory watches survive atomic file saves; the extra parent handles directory replacement.
			directories.add(directory);
			directories.add(dirname(directory));
		}
		const added: string[] = [];
		try {
			for (const directory of directories) {
				const { dev, ino } = statSync(directory);
				const previous = watchers.get(directory);
				if (previous?.dev === dev && previous.ino === ino) continue;
				const watcher = watch(directory, (_event, filename) => {
					const changed = filename === null ? undefined : resolve(directory, filename);
					if (changed && ![...paths, lock].some((path) => path === changed || path.startsWith(changed + sep))) return;
					schedule();
				});
				watcher.on("error", (error) => {
					log.error("runtime", "watch_failed", { error_category: errorCategory(error) });
					watchFailed = true;
					stop("SIGTERM");
				});
				previous?.watcher.close();
				watchers.set(directory, { watcher, dev, ino });
				added.push(directory);
			}
		} catch (error) {
			for (const directory of added) {
				watchers.get(directory)?.watcher.close();
				watchers.delete(directory);
			}
			throw error;
		}
		for (const [directory, { watcher }] of watchers) {
			if (directories.has(directory)) continue;
			watcher.close();
			watchers.delete(directory);
		}
		paths = next;
	};
	function reconcile() {
		if (stopping || reloading || existsSync(lock)) return;
		try {
			// Discover new or missing targets even if full configuration validation will fail.
			refreshWatches();
			const current = snapshot(paths);
			if (current === baseline) return;
			loadConfig(rootDir);
			baseline = current;
			rejected = undefined;
			reloading = true;
			log.info("runtime", "reload_requested", {});
			stopWorker("SIGTERM");
		} catch (error) {
			const current = snapshot(paths);
			if (rejected !== current) log.warn("runtime", "reload_rejected", { error_category: errorCategory(error) });
			rejected = current;
		}
	}
	const onInterrupt = () => stop("SIGINT");
	const onTerminate = () => stop("SIGTERM");
	process.on("SIGINT", onInterrupt);
	process.on("SIGTERM", onTerminate);
	try {
		try {
			refreshWatches();
		} catch (error) {
			log.error("runtime", "watch_failed", { error_category: errorCategory(error) });
			return 1;
		}
		baseline = snapshot(paths);
		for (;;) {
			child = Bun.spawn(options.command ?? [process.execPath, join(import.meta.dir, "main.ts"), "--jingmei-worker"], {
				cwd: rootDir,
				stdin: "inherit",
				stdout: "inherit",
				stderr: "inherit",
			});
			const code = await child.exited;
			clearTimeout(forceStop);
			if (watchFailed) return 1;
			if (stopping) return code === 0 || child.signalCode === "SIGINT" || child.signalCode === "SIGTERM" ? 0 : code;
			if (!reloading) return code;
			// Wake on lock-directory events or shutdown, without polling while an update finishes.
			while (!stopping && existsSync(lock))
				await new Promise<void>((wake) => {
					wakeUpdateWait = wake;
				});
			wakeUpdateWait = undefined;
			if (watchFailed) return 1;
			if (stopping) return 0;
			try {
				refreshWatches();
			} catch (error) {
				log.error("runtime", "watch_failed", { error_category: errorCategory(error) });
				return 1;
			}
			baseline = snapshot(paths);
			reloading = false;
			log.info("runtime", "reloading", {});
		}
	} finally {
		clearTimeout(debounce);
		clearTimeout(forceStop);
		for (const { watcher } of watchers.values()) watcher.close();
		process.off("SIGINT", onInterrupt);
		process.off("SIGTERM", onTerminate);
	}
}
