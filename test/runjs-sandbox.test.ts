import { describe, expect, test } from "bun:test";
import { assertRunJsSandbox, RunJsSandboxError } from "../src/tools/run-js.ts";
import { buildRunJsBwrapArgs } from "../src/tools/run-js-sandbox.ts";

describe("run_js OS sandbox policy", () => {
	test("startup assertion passes when bwrap can run the sandbox", async () => {
		await assertRunJsSandbox();
	});

	test("startup assertion fails loudly when bwrap is unavailable", async () => {
		const path = process.env.PATH;
		process.env.PATH = "/nonexistent";
		try {
			await expect(assertRunJsSandbox()).rejects.toBeInstanceOf(RunJsSandboxError);
		} finally {
			process.env.PATH = path;
		}
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
