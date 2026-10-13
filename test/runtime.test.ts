import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { RELOAD_FILE, UPDATE_LOCK_FILE } from "../src/update.ts";
import { useCleanups } from "./support/cleanup.ts";

const cleanups = useCleanups();
const runtime = resolve(import.meta.dir, "../src/runtime.ts");

async function until(check: () => boolean) {
	const deadline = Date.now() + 4_000;
	while (!check()) {
		if (Date.now() > deadline) throw new Error("Worker lifecycle timed out");
		await Bun.sleep(20);
	}
}

async function running(options: { drainMs?: number | null; graceMs?: number } = {}) {
	const dir = cleanups.tmpDir();
	const config = join(dir, "jingmei.config.json");
	const persona = join(dir, "pet.md");
	const trace = join(dir, "trace");
	const putConfig = (path = persona) =>
		writeFileSync(
			config,
			JSON.stringify({
				routingSecretEnv: "JINGMEI_TEST_ROUTING",
				discord: { guilds: [{ guildId: "000000000000000000", channelIds: ["000000000000000001"] }] },
				personas: [
					{
						id: "pet",
						name: "Pet",
						provider: "fixture",
						model: "fixture",
						personaPath: path,
						routingP: 0,
						discord: { tokenEnv: "JINGMEI_TEST_TOKEN" },
					},
				],
			}),
		);
	const envText = (version: string) =>
		`JINGMEI_TEST_ROUTING: fixture\nJINGMEI_TEST_TOKEN: fixture\nVERSION: ${version}\n`;
	putConfig();
	writeFileSync(persona, "first");
	writeFileSync(join(dir, ".env"), envText("initial"));
	writeFileSync(
		join(dir, "worker.ts"),
		`
import { appendFileSync, readFileSync } from "node:fs";
import { parseEnvFile } from ${JSON.stringify(resolve(import.meta.dir, "../src/config.ts"))};
const record = (s: string) => appendFileSync("trace", s + "\\n");
const config = JSON.parse(readFileSync("jingmei.config.json", "utf8"));
record("start:" + readFileSync(config.personas[0].personaPath, "utf8") + ":" + parseEnvFile(".env").VERSION);
let draining = false;
const stop = () => {
  if (draining) return;
  draining = true;
  record("drain");
  const delay = ${JSON.stringify(options.drainMs === undefined ? 120 : options.drainMs)};
  if (delay !== null) setTimeout(() => { record("end"); process.exit(0); }, delay);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
setInterval(() => {}, 1000);
`,
	);
	writeFileSync(
		join(dir, "runner.ts"),
		`
import { superviseBot } from ${JSON.stringify(runtime)};
process.exitCode = await superviseBot({
  command: [process.execPath, "worker.ts"], settleMs: 75, graceMs: ${options.graceMs ?? 2000},
});
`,
	);
	const child = Bun.spawn([process.execPath, "runner.ts"], {
		cwd: dir,
		stdin: "ignore",
		stdout: "ignore",
		stderr: "ignore",
	});
	cleanups.push(async () => {
		child.kill("SIGTERM");
		await child.exited;
	});
	const lines = () => (existsSync(trace) ? readFileSync(trace, "utf8").trim().split("\n") : []);
	const starts = () => lines().filter((line) => line.startsWith("start:"));
	await until(() => starts().length === 1);
	return { dir, config, persona, putConfig, envText, child, lines, starts };
}

test("persona and atomic .env edits drain one worker before starting its replacement", async () => {
	const bot = await running();
	writeFileSync(bot.persona, "second");
	await until(() => bot.starts().length === 2);
	expect(bot.lines()).toEqual(["start:first:initial", "drain", "end", "start:second:initial"]);
	writeFileSync(join(bot.dir, "env.tmp"), bot.envText("changed"));
	renameSync(join(bot.dir, "env.tmp"), join(bot.dir, ".env"));
	await until(() => bot.starts().length === 3);
	expect(bot.starts().at(-1)).toBe("start:second:changed");
	bot.child.kill("SIGTERM");
	expect(await bot.child.exited).toBe(0);
	expect(bot.lines().slice(-2)).toEqual(["drain", "end"]);
});

test("invalid config preserves the worker; newly configured persona files are discovered and watched", async () => {
	const bot = await running();
	writeFileSync(bot.config, "{ incomplete");
	await Bun.sleep(250);
	expect(bot.starts()).toHaveLength(1);
	const nextPersona = join(bot.dir, "new-pet.md");
	bot.putConfig(nextPersona);
	await Bun.sleep(250);
	expect(bot.starts()).toHaveLength(1);
	writeFileSync(nextPersona, "new");
	await until(() => bot.starts().length === 2);
	expect(bot.starts().at(-1)).toBe("start:new:initial");
	writeFileSync(nextPersona, "newer");
	await until(() => bot.starts().length === 3);
	expect(bot.starts().at(-1)).toBe("start:newer:initial");
});

test("repeated atomic saves retain monitoring and unchanged contents never restart the worker", async () => {
	const bot = await running();
	writeFileSync(join(bot.dir, "unrelated.txt"), "unrelated");
	writeFileSync(bot.persona, "first");
	await Bun.sleep(300);
	expect(bot.starts()).toHaveLength(1);
	for (const [index, value] of ["second", "third"].entries()) {
		const temporary = join(bot.dir, "pet.tmp");
		writeFileSync(temporary, value);
		renameSync(temporary, bot.persona);
		await until(() => bot.starts().length === index + 2);
		expect(bot.starts().at(-1)).toBe(`start:${value}:initial`);
	}
	writeFileSync(bot.persona, "fourth");
	await until(() => bot.starts().length === 4);
	expect(bot.starts().at(-1)).toBe("start:fourth:initial");
});

test("missing external persona directories and replacement directories remain monitored", async () => {
	const bot = await running();
	const external = cleanups.tmpDir();
	const directory = join(external, "new");
	const persona = join(directory, "pet.md");
	bot.putConfig(persona);
	await Bun.sleep(250);
	expect(bot.starts()).toHaveLength(1);
	mkdirSync(directory);
	writeFileSync(persona, "external");
	await until(() => bot.starts().length === 2);
	renameSync(directory, join(external, "old"));
	mkdirSync(directory);
	writeFileSync(persona, "replacement");
	await until(() => bot.starts().length === 3);
	writeFileSync(persona, "later");
	await until(() => bot.starts().length === 4);
	expect(bot.starts().at(-1)).toBe("start:later:initial");
});

test("update lock defers reload; success marker reloads even without config changes", async () => {
	const bot = await running();
	const lock = join(bot.dir, UPDATE_LOCK_FILE);
	writeFileSync(lock, "");
	writeFileSync(join(bot.dir, RELOAD_FILE), "updated");
	await Bun.sleep(250);
	expect(bot.starts()).toHaveLength(1);
	unlinkSync(lock);
	await until(() => bot.starts().length === 2);
	expect(bot.lines()).toEqual(["start:first:initial", "drain", "end", "start:first:initial"]);
});

test("burst edits settle once and a stop during reload never launches another worker", async () => {
	const bot = await running();
	for (const value of ["a", "b", "final"]) {
		writeFileSync(bot.persona, value);
		await Bun.sleep(30);
	}
	await until(() => bot.starts().length === 2);
	expect(bot.starts().at(-1)).toBe("start:final:initial");
	writeFileSync(bot.persona, "stop");
	await until(() => bot.lines().filter((line) => line === "drain").length === 2);
	bot.child.kill("SIGTERM");
	expect(await bot.child.exited).toBe(0);
	expect(bot.starts()).toHaveLength(2);
	expect(bot.lines().at(-1)).toBe("end");
});

test("an update started during drain delays replacement until the install finishes", async () => {
	const bot = await running();
	writeFileSync(bot.persona, "updated");
	await until(() => bot.lines().includes("drain"));
	const lock = join(bot.dir, UPDATE_LOCK_FILE);
	writeFileSync(lock, "");
	await until(() => bot.lines().includes("end"));
	await Bun.sleep(100);
	expect(bot.starts()).toHaveLength(1);
	writeFileSync(join(bot.dir, RELOAD_FILE), "new-code");
	unlinkSync(lock);
	await until(() => bot.starts().length === 2);
	await Bun.sleep(250);
	expect(bot.starts()).toEqual(["start:first:initial", "start:updated:initial"]);
});

test("a stuck worker is terminated after the drain deadline before replacement", async () => {
	const bot = await running({ drainMs: null, graceMs: 100 });
	writeFileSync(bot.persona, "replacement");
	await until(() => bot.starts().length === 2);
	expect(bot.lines()).toEqual(["start:first:initial", "drain", "start:replacement:initial"]);
});

test("stopping while waiting for an update lock wakes the supervisor without another worker", async () => {
	const bot = await running();
	writeFileSync(bot.persona, "updated");
	await until(() => bot.lines().includes("drain"));
	writeFileSync(join(bot.dir, UPDATE_LOCK_FILE), "");
	await until(() => bot.lines().includes("end"));
	bot.child.kill("SIGTERM");
	const timer = setTimeout(() => bot.child.kill("SIGKILL"), 1000);
	try {
		expect(await bot.child.exited).toBe(0);
		expect(bot.starts()).toHaveLength(1);
	} finally {
		clearTimeout(timer);
	}
});

test("unrequested worker exits propagate so systemd retains its restart policy", async () => {
	const dir = cleanups.tmpDir();
	for (const code of [0, 7]) {
		writeFileSync(
			join(dir, "runner.ts"),
			`
import { superviseBot } from ${JSON.stringify(runtime)};
process.exitCode = await superviseBot({ command: [process.execPath, "-e", "process.exit(${code})"] });
`,
		);
		const child = Bun.spawn([process.execPath, "runner.ts"], { cwd: dir, stdout: "ignore", stderr: "ignore" });
		expect(await child.exited).toBe(code);
	}
});

test("every public entrypoint exits on invalid startup instead of leaving a half-started worker", async () => {
	const dir = cleanups.tmpDir();
	for (const args of [["src/main.ts"], ["src/discord/main.ts"], ["src/cli.ts", "start"]]) {
		const [entry, ...rest] = args;
		const child = Bun.spawn([process.execPath, resolve(import.meta.dir, "..", entry!), ...rest], {
			cwd: dir,
			stdout: "ignore",
			stderr: "pipe",
		});
		const timer = setTimeout(() => child.kill("SIGKILL"), 2000);
		try {
			const stderr = await new Response(child.stderr).text();
			expect(await child.exited).toBe(1);
			expect(stderr).toContain("jingmei init");
		} finally {
			clearTimeout(timer);
		}
	}
});
