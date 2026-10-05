import { log } from "../observability/log.ts";

export type RunJsSandboxKind = "bwrap" | "vm";

/** Only runtime files are imported; their parent directories never enter the sandbox. */
export function buildRunJsBwrapArgs(execPath: string, wrapperPath: string, codePath: string): string[] {
	return [
		"--unshare-all",
		"--die-with-parent",
		"--new-session",
		"--ro-bind",
		"/usr",
		"/usr",
		"--ro-bind-try",
		"/lib",
		"/lib",
		"--ro-bind-try",
		"/lib64",
		"/lib64",
		"--ro-bind-try",
		"/etc/ld.so.cache",
		"/etc/ld.so.cache",
		"--dir",
		"/runjs",
		"--ro-bind",
		execPath,
		"/runjs/bun",
		"--ro-bind",
		wrapperPath,
		"/runjs/wrapper.mjs",
		"--ro-bind",
		codePath,
		"/runjs/code.js",
		"--tmpfs",
		"/tmp",
		"--proc",
		"/proc",
		"--dev",
		"/dev",
		"--chdir",
		"/tmp",
		"--",
		"/runjs/bun",
		"--smol",
		"/runjs/wrapper.mjs",
		"/runjs/code.js",
	];
}

/** Cache the real usability result, including failures and concurrent first calls. */
export function createRunJsSandboxDetector(probe: () => Promise<boolean>): () => Promise<RunJsSandboxKind> {
	let detected: Promise<RunJsSandboxKind> | undefined;
	return () => {
		detected ??= Promise.resolve()
			.then(probe)
			.catch(() => false)
			.then((usable) => {
				const kind = usable ? "bwrap" : "vm";
				log.info("tools", "run_js_sandbox", { kind });
				return kind;
			});
		return detected;
	};
}
