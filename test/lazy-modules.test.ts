import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { EmbeddingModel } from "fastembed";
import { EMBEDDING_MODELS } from "../src/core/embedding-models.ts";

const root = resolve(import.meta.dir, "..");
const trace = join(import.meta.dir, "trace-heavy-modules.ts");
const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("the static embedding model list matches fastembed's built-in models", () => {
	const builtin = Object.values(EmbeddingModel).filter((model) => model !== EmbeddingModel.CUSTOM);
	expect([...EMBEDDING_MODELS].sort()).toEqual([...builtin].sort());
});

/** Heavy packages evaluated while `bun` runs `entry` (a script body, or a CLI path plus arguments) in an empty project. */
async function loadedPackages(entry: { script: string } | { args: string[] }): Promise<string[]> {
	const dir = mkdtempSync(join(tmpdir(), "jingmei-lazy-"));
	dirs.push(dir);
	writeFileSync(join(dir, "jingmei.config.json"), JSON.stringify({ dataDir: "data", personas: [] }));
	let args: string[];
	if ("script" in entry) {
		writeFileSync(join(dir, "probe.ts"), entry.script);
		args = [join(dir, "probe.ts")];
	} else args = entry.args;
	const child = Bun.spawn(["bun", "--preload", trace, ...args], {
		cwd: dir,
		stdout: "ignore",
		stderr: "pipe",
		stdin: "ignore",
		env: { PATH: Bun.env.PATH ?? "", HOME: dir },
	});
	const stderr = await new Response(child.stderr).text();
	await child.exited;
	return [...stderr.matchAll(/^LOADED (\S+)$/gm)].map((match) => match[1] as string);
}

test("the trace preload sees heavy packages when they are imported", async () => {
	const loaded = await loadedPackages({
		script: ["fastembed", "notjev", "lunar-typescript"]
			.map((name) => `await import(${JSON.stringify(join(root, "node_modules", name))});`)
			.join("\n"),
	});
	expect(loaded).toEqual(expect.arrayContaining(["fastembed", "notjev", "lunar-typescript"]));
});

test("operator commands and the bot module load no embedding, decision or calendar packages", async () => {
	expect(await loadedPackages({ args: [join(root, "src/cli.ts"), "stats"] })).toEqual([]);
	// Importing the bot (not starting it) is free too: its heavy parts load only when their features are used.
	expect(await loadedPackages({ script: `import ${JSON.stringify(join(root, "src/bot.ts"))};` })).toEqual([]);
});
