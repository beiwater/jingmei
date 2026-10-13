import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "./config.ts";
import { errorCategory, log } from "./observability/log.ts";
import { RELOAD_FILE, UPDATE_LOCK_FILE } from "./update.ts";

interface RuntimeOptions {
	rootDir?: string;
	command?: string[];
	/** Validate with the same config reader as the bot; return resolved persona paths to watch. */
	validate?: () => string[];
	pollMs?: number;
	settleMs?: number;
	graceMs?: number;
}

/** Content hashes handle editor atomic renames and creation/deletion without retaining secret text. */
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
	const rootDir = options.rootDir ?? process.cwd();
	const validate = options.validate ?? (() => loadConfig(rootDir).personas.map((persona) => persona.personaPath));
	const fixed = [join(rootDir, "jingmei.config.json"), join(rootDir, ".env"), join(rootDir, RELOAD_FILE)];
	let paths = fixed;
	try {
		paths = [...fixed, ...validate()];
	} catch {
		// Let the worker report initial configuration errors using the usual startup diagnostics.
	}
	let baseline = snapshot(paths);
	let pending = baseline;
	let changedAt = 0;
	let rejected: string | undefined;
	let stopping = false;
	let reloading = false;
	let forceStop: Timer | undefined;
	let child: ReturnType<typeof Bun.spawn>;
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
		if (!reloading) stopWorker(signal);
	};
	const onInterrupt = () => stop("SIGINT");
	const onTerminate = () => stop("SIGTERM");
	process.on("SIGINT", onInterrupt);
	process.on("SIGTERM", onTerminate);
	const poll = setInterval(() => {
		if (stopping || reloading || existsSync(join(rootDir, UPDATE_LOCK_FILE))) return;
		const current = snapshot(paths);
		if (current === baseline) {
			pending = baseline;
			rejected = undefined;
			return;
		}
		if (current !== pending) {
			pending = current;
			changedAt = Date.now();
			return;
		}
		if (Date.now() - changedAt < (options.settleMs ?? 500)) return;
		try {
			paths = [...fixed, ...validate()];
			baseline = pending = snapshot(paths);
			rejected = undefined;
			reloading = true;
			log.info("runtime", "reload_requested", {});
			stopWorker("SIGTERM");
		} catch (error) {
			// Retry incomplete edits (e.g. a newly configured persona file not yet created), without log spam.
			if (rejected !== current) log.warn("runtime", "reload_rejected", { error_category: errorCategory(error) });
			rejected = current;
		}
	}, options.pollMs ?? 500);
	try {
		for (;;) {
			child = Bun.spawn(options.command ?? [process.execPath, join(import.meta.dir, "main.ts"), "--jingmei-worker"], {
				cwd: rootDir,
				stdin: "inherit",
				stdout: "inherit",
				stderr: "inherit",
			});
			const code = await child.exited;
			clearTimeout(forceStop);
			if (stopping) return code === 0 || child.signalCode === "SIGINT" || child.signalCode === "SIGTERM" ? 0 : code;
			if (!reloading) return code;
			// An update may have started while the old worker was draining. Never boot into a partial install.
			while (!stopping && existsSync(join(rootDir, UPDATE_LOCK_FILE))) await Bun.sleep(options.pollMs ?? 500);
			if (stopping) return 0;
			try {
				paths = [...fixed, ...validate()];
			} catch {
				// The replacement worker reports any configuration errors introduced during the drain.
			}
			// The replacement reads all edits made during the drain, so do not immediately reload it again.
			baseline = pending = snapshot(paths);
			reloading = false;
			log.info("runtime", "reloading", {});
		}
	} finally {
		clearInterval(poll);
		clearTimeout(forceStop);
		process.off("SIGINT", onInterrupt);
		process.off("SIGTERM", onTerminate);
	}
}
