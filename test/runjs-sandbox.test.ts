import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { setLogSink } from "../src/observability/log.ts";
import { runJs } from "../src/tools/run-js.ts";
import { buildRunJsBwrapArgs, createRunJsSandboxDetector } from "../src/tools/run-js-sandbox.ts";

describe("run_js OS sandbox policy", () => {
	test("missing bwrap selects vm once and computation still works", async () => {
		const records: string[] = [];
		const restore = setLogSink((line) => records.push(line));
		let probes = 0;
		const detect = createRunJsSandboxDetector(
			() =>
				new Promise<boolean>((resolve) => {
					probes++;
					const child = spawn("/nonexistent/runjs-no-such-bwrap", [], { stdio: "ignore" });
					child.on("error", () => resolve(false));
					child.on("close", () => resolve(false));
				}),
		);
		try {
			expect(await Promise.all([detect(), detect()])).toEqual(["vm", "vm"]);
			expect(await detect()).toBe("vm");
			expect(probes).toBe(1);
			expect(records.map((line) => JSON.parse(line).fields)).toEqual([{ kind: "vm" }]);
			const result = await runJs("6 * 7");
			expect(result.ok).toBe(true);
			expect(result.output).toBe("42");
		} finally {
			restore();
		}
	});

	test("a denied namespace probe falls back without logging the failure", async () => {
		const records: string[] = [];
		const restore = setLogSink((line) => records.push(line));
		try {
			const detect = createRunJsSandboxDetector(async () => {
				throw new Error("private path and stderr must not be logged");
			});
			expect(await detect()).toBe("vm");
			expect(records.map((line) => JSON.parse(line).fields)).toEqual([{ kind: "vm" }]);
			expect(records.join("")).not.toContain("private");
		} finally {
			restore();
		}
	});

	test("a usable probe selects bwrap once", async () => {
		let probes = 0;
		const detect = createRunJsSandboxDetector(async () => {
			probes++;
			return true;
		});
		expect(await Promise.all([detect(), detect()])).toEqual(["bwrap", "bwrap"]);
		expect(probes).toBe(1);
	});

	test("bind boundary exposes runtime files, never their home or working directory", () => {
		const home = "/home/service";
		const repo = `${home}/apps/jingmei`;
		const data = `${repo}/data`;
		const executable = `${home}/.bun/bin/bun`;
		const wrapper = `${repo}/temporary/wrapper.mjs`;
		const code = `${repo}/temporary/code.js`;
		const args = buildRunJsBwrapArgs(executable, wrapper, code);
		const binds = args.flatMap((arg, index) =>
			arg === "--ro-bind" || arg === "--ro-bind-try" ? [[args[index + 1], args[index + 2]]] : [],
		);
		expect(binds).toEqual([
			["/usr", "/usr"],
			["/lib", "/lib"],
			["/lib64", "/lib64"],
			["/etc/ld.so.cache", "/etc/ld.so.cache"],
			[executable, "/runjs/bun"],
			[wrapper, "/runjs/wrapper.mjs"],
			[code, "/runjs/code.js"],
		]);
		for (const forbidden of [home, `${home}/.bun`, repo, data, `${repo}/.env`, `${repo}/jingmei.config.json`]) {
			expect(binds.flat()).not.toContain(forbidden);
		}
		expect(args).not.toContain("--bind");
		expect(args).toContain("--unshare-all");
		expect(args).toContain("--die-with-parent");
		expect(args).toContain("--new-session");
		expect(args.slice(args.indexOf("--tmpfs"), args.indexOf("--") + 1)).toEqual([
			"--tmpfs",
			"/tmp",
			"--proc",
			"/proc",
			"--dev",
			"/dev",
			"--chdir",
			"/tmp",
			"--",
		]);
	});
});
