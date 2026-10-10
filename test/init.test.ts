import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError, loadConfig, parseEnvFile } from "../src/config.ts";
import {
	buildInitFiles,
	discordInviteUrl,
	type InitAnswers,
	type InitDeps,
	type InitUi,
	runInit,
	writeInstall,
} from "../src/init.ts";

const GUILD = "1552560014353506386";
const CHANNEL = "1552560015276113962";
const CHAT = "-1001234567890";
const VOICE = "0123456789abcdef0123456789abcdef";
const SECRETS = {
	discord: "discord-token-fixture",
	telegram: "123456:telegram-token-fixture",
	deepseek: "deepseek-key-fixture",
	fish: "fish-key-fixture",
	jev: "jev-key-fixture",
	routing: "routing-secret-fixture",
};

let root: string;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "jingmei-init-"));
	mkdirSync(join(root, "personas"));
	for (const language of ["zh", "en"])
		copyFileSync(
			join(import.meta.dir, `../personas/template.${language}.md`),
			join(root, `personas/template.${language}.md`),
		);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function answers(extra: Partial<InitAnswers> = {}): InitAnswers {
	return {
		discord: { token: SECRETS.discord, guildId: GUILD, channelIds: [CHANNEL] },
		persona: { id: "luna", name: "Luna", template: "zh" },
		model: { provider: "deepseek", model: "deepseek-flash", deepseekApiKey: SECRETS.deepseek },
		routingSecret: SECRETS.routing,
		features: { history: true, memory: true, soul: true, search: true, audit: true },
		...extra,
	};
}

function everySecretIn(text: string): string[] {
	return Object.values(SECRETS).filter((secret) => text.includes(secret));
}

describe("buildInitFiles", () => {
	test("a minimal Discord install is a small valid config with secrets only in the env", () => {
		const { config, env } = buildInitFiles(answers(), root);
		expect(config).toEqual({
			discord: { guilds: [{ guildId: GUILD, channelIds: [CHANNEL] }] },
			personas: [
				{
					id: "luna",
					name: "Luna",
					personaPath: "personas/luna.md",
					provider: "deepseek",
					model: "deepseek-flash",
					routingP: 0.65,
					discord: { tokenEnv: "DISCORD_LUNA_TOKEN" },
				},
			],
		});
		expect(env).toEqual({
			ROUTING_SECRET: SECRETS.routing,
			DISCORD_LUNA_TOKEN: SECRETS.discord,
			DEEPSEEK_API_KEY: SECRETS.deepseek,
		});
		expect(everySecretIn(JSON.stringify(config))).toEqual([]);
	});

	test("both platforms and every add-on produce a config the bot accepts", () => {
		const { config, env } = buildInitFiles(
			answers({
				telegram: { token: SECRETS.telegram, chatIds: [CHAT] },
				persona: { id: "mei-2", name: "Mei", template: "en" },
				features: { history: true, memory: false, soul: false, search: true, audit: false },
				voice: { apiKey: SECRETS.fish, referenceId: VOICE },
				textImage: true,
				kline: true,
				jev: { apiKey: SECRETS.jev },
				events: { summaryModel: "deepseek/deepseek-flash" },
				celebrations: { timeZone: "Australia/Sydney", calendar: "both" },
			}),
			root,
		);
		expect(config.features).toEqual({ memory: false, soul: false, audit: false });
		expect(config.celebrations).toEqual([
			{
				space: `discord:${GUILD}`,
				channelId: CHANNEL,
				personaId: "mei-2",
				timeZone: "Australia/Sydney",
				calendar: "both",
			},
			{ space: `telegram:${CHAT}`, personaId: "mei-2", timeZone: "Australia/Sydney", calendar: "both" },
		]);
		expect(Object.keys(env).sort()).toEqual([
			"DEEPSEEK_API_KEY",
			"DISCORD_MEI_2_TOKEN",
			"FISH_AUDIO_API_KEY",
			"ROUTING_SECRET",
			"TELEGRAM_MEI_2_TOKEN",
			"TYPESAFE_API_KEY",
		]);
		expect(everySecretIn(JSON.stringify(config))).toEqual([]);
	});

	test("the in-process Jev wrapper needs a DeepSeek key, and events needs history", () => {
		expect(buildInitFiles(answers({ jev: {} }), root).config.jev).toEqual({});
		const noKey = answers({ jev: {}, model: { provider: "openai-codex", model: "gpt" } });
		expect(() => buildInitFiles(noKey, root)).toThrow(ConfigError);
		const noHistory = answers({
			features: { history: false, memory: true, soul: true, search: true, audit: true },
			events: { summaryModel: "deepseek/deepseek-flash" },
		});
		expect(() => buildInitFiles(noHistory, root)).toThrow(ConfigError);
	});

	test("an invalid answer is rejected before anything could be written", () => {
		expect(() => buildInitFiles(answers({ persona: { id: "Bad Id", name: "x", template: "zh" } }), root)).toThrow(
			ConfigError,
		);
		expect(() =>
			buildInitFiles(answers({ discord: { token: "t", guildId: "12", channelIds: [CHANNEL] } }), root),
		).toThrow(ConfigError);
	});

	test("the Discord invite link carries the permissions the bot needs and no Administrator bit", () => {
		const url = new URL(discordInviteUrl(GUILD));
		expect(url.searchParams.get("client_id")).toBe(GUILD);
		expect(url.searchParams.get("scope")).toBe("bot applications.commands");
		const permissions = BigInt(url.searchParams.get("permissions") ?? "0");
		for (const bit of [6n, 10n, 11n, 15n, 16n, 38n]) expect(permissions & (1n << bit)).not.toBe(0n);
		expect(permissions & (1n << 3n)).toBe(0n);
	});
});

describe("writeInstall", () => {
	test("creates the persona file, a 0600 .env and a config that loads", () => {
		const files = buildInitFiles(answers(), root);
		writeInstall(root, files, { id: "luna", template: "zh" });
		expect(statSync(join(root, ".env")).mode & 0o777).toBe(0o600);
		expect(readFileSync(join(root, "personas/luna.md"), "utf8")).toBe(
			readFileSync(join(root, "personas/template.zh.md"), "utf8"),
		);
		expect(everySecretIn(readFileSync(join(root, "jingmei.config.json"), "utf8"))).toEqual([]);
		const loaded = loadConfig(root);
		expect(loaded.personas[0]?.tokens.discord).toBe(SECRETS.discord);
		expect(loaded.routingSecret).toBe(SECRETS.routing);
	});

	test("never replaces an existing file and leaves nothing behind when a write fails", () => {
		writeFileSync(join(root, "jingmei.config.json"), "keep me");
		expect(() => writeInstall(root, buildInitFiles(answers(), root), { id: "luna", template: "zh" })).toThrow();
		expect(readFileSync(join(root, "jingmei.config.json"), "utf8")).toBe("keep me");
		expect(existsSync(join(root, ".env"))).toBe(false);
		expect(existsSync(join(root, "personas/luna.md"))).toBe(false);
	});
});

/** A scripted terminal: answers come from a queue, a rejected answer is followed by the next one like a re-prompt. */
function scriptedUi(script: unknown[]) {
	const asked: string[] = [];
	const output: string[] = [];
	const rejected: string[] = [];
	const next = (message: string): unknown => {
		asked.push(message);
		if (!script.length) throw new Error(`script exhausted at: ${message}`);
		return script.shift();
	};
	const validated = (message: string, validate?: (value: string) => string | undefined): string => {
		for (;;) {
			const value = next(message) as string;
			const problem = validate?.(value);
			if (!problem) return value;
			rejected.push(problem);
			asked.pop();
		}
	};
	const ui: InitUi = {
		select: async (message) => next(message) as never,
		text: async (message, options) => validated(message, options?.validate),
		password: async (message, validate) => validated(message, validate),
		confirm: async (message) => next(message) as boolean,
		multiselect: async (message) => next(message) as never,
		info: (message) => void output.push(message),
		warn: (message) => void output.push(message),
		raw: (message) => void output.push(message),
	};
	return { ui, asked, output, rejected, left: () => script.length };
}

function deps(overrides: Partial<InitDeps["probes"]> = {}): InitDeps {
	return {
		probes: {
			discordBot: async () => ({ id: GUILD, username: "Luna", flags: 1 << 18 }),
			telegramBot: async () => ({ username: "luna_bot", canReadAllGroupMessages: true }),
			...overrides,
		},
		randomSecret: () => SECRETS.routing,
		timeZone: () => "UTC",
	};
}

describe("runInit", () => {
	test("refuses to overwrite an existing config or .env and asks nothing", async () => {
		for (const name of ["jingmei.config.json", ".env"]) {
			writeFileSync(join(root, name), "keep me");
			const { ui, asked } = scriptedUi([]);
			await expect(runInit(root, ui, deps())).rejects.toThrow(`${name} already exists`);
			expect(asked).toEqual([]);
			expect(readFileSync(join(root, name), "utf8")).toBe("keep me");
			rmSync(join(root, name));
		}
	});

	test("the recommended path on Discord is short, verifies the token and writes a working install", async () => {
		const { ui, asked, output, left } = scriptedUi([
			"recommended",
			"discord",
			SECRETS.discord,
			GUILD,
			CHANNEL,
			"luna",
			"Luna",
			"zh",
			"deepseek",
			SECRETS.deepseek,
			true,
		]);
		const message = await runInit(root, ui, deps());
		expect(left()).toBe(0);
		expect(asked.length).toBe(11);
		const loaded = loadConfig(root);
		expect(loaded.features).toEqual({ history: true, memory: true, soul: true, search: true, audit: true });
		expect(loaded.discord?.guilds).toEqual([{ guildId: GUILD, channelIds: [CHANNEL] }]);
		expect(output.join("\n")).toContain("Discord bot: Luna");
		expect(output.join("\n")).toContain(discordInviteUrl(GUILD));
		expect(output.join("\n")).toContain("bun run jingmei doctor");
		expect(output.join("\n")).toContain("bun run start");
		expect([message, ...output, ...asked].flatMap(everySecretIn)).toEqual([]);
		expect(statSync(join(root, ".env")).mode & 0o777).toBe(0o600);
	});

	test("a rejected token can be retried; invalid ids are re-asked; privacy mode and intent are flagged", async () => {
		let calls = 0;
		const { ui, output, rejected, left } = scriptedUi([
			"minimal",
			"both",
			"wrong-token",
			true,
			SECRETS.discord,
			"12",
			GUILD,
			CHANNEL,
			SECRETS.telegram,
			"not-an-id",
			CHAT,
			"Bad Id",
			"mei",
			"Mei",
			"en",
			"later",
			"nope",
			"anthropic/claude",
			true,
		]);
		await runInit(
			root,
			ui,
			deps({
				discordBot: async (token) => {
					calls++;
					if (token === "wrong-token") throw new Error("Discord API request failed with HTTP 401");
					return { id: GUILD, username: "Luna", flags: 0 };
				},
				telegramBot: async () => ({ username: "luna_bot", canReadAllGroupMessages: false }),
			}),
		);
		expect(left()).toBe(0);
		expect(calls).toBe(2);
		expect(rejected.length).toBe(4);
		const printed = output.join("\n");
		expect(printed).toContain("did not accept the token");
		expect(printed).toContain("Message Content Intent is off");
		expect(printed).toContain("Privacy mode is on");
		expect(printed).toContain("bun run jingmei login anthropic");
		const loaded = loadConfig(root);
		expect(loaded.features).toEqual({ history: false, memory: false, soul: false, search: false, audit: false });
		expect(loaded.personas[0]).toMatchObject({ id: "mei", provider: "anthropic", model: "claude" });
		expect(parseEnvFile(join(root, ".env"))).toEqual({
			ROUTING_SECRET: SECRETS.routing,
			DISCORD_MEI_TOKEN: SECRETS.discord,
			TELEGRAM_MEI_TOKEN: SECRETS.telegram,
		});
		expect(readFileSync(join(root, "personas/mei.md"), "utf8")).toBe(
			readFileSync(join(root, "personas/template.en.md"), "utf8"),
		);
	});

	test("custom asks about add-ons only for the ones chosen", async () => {
		const { ui, asked, left } = scriptedUi([
			"custom",
			"telegram",
			SECRETS.telegram,
			CHAT,
			"luna",
			"Luna",
			"zh",
			"deepseek",
			SECRETS.deepseek,
			true,
			false,
			true,
			true,
			false,
			["voice", "events"],
			SECRETS.fish,
			VOICE,
			"deepseek/deepseek-flash",
			true,
		]);
		await runInit(root, ui, deps());
		expect(left()).toBe(0);
		expect(asked.some((message) => message.includes("Fish Audio API key"))).toBe(true);
		expect(asked.some((message) => message.includes("TypeSafe"))).toBe(false);
		expect(asked.some((message) => message.includes("Time zone"))).toBe(false);
		const loaded = loadConfig(root);
		expect(loaded.features).toEqual({ history: true, memory: false, soul: true, search: true, audit: false });
		expect(loaded.voice?.referenceId).toBe(VOICE);
		expect(loaded.events?.summaryModel).toEqual({ provider: "deepseek", model: "deepseek-flash" });
		expect(loaded.telegram?.chatIds).toEqual([CHAT]);
	});

	test("declining the final confirmation writes nothing", async () => {
		const { ui } = scriptedUi([
			"recommended",
			"discord",
			SECRETS.discord,
			GUILD,
			CHANNEL,
			"luna",
			"Luna",
			"zh",
			"deepseek",
			SECRETS.deepseek,
			false,
		]);
		await expect(runInit(root, ui, deps())).rejects.toThrow("nothing was written");
		expect(existsSync(join(root, ".env"))).toBe(false);
		expect(existsSync(join(root, "jingmei.config.json"))).toBe(false);
		expect(existsSync(join(root, "personas/luna.md"))).toBe(false);
	});

	test("a persona id that already has a file is rejected", async () => {
		writeFileSync(join(root, "personas/luna.md"), "mine");
		const { ui, rejected } = scriptedUi([
			"recommended",
			"discord",
			SECRETS.discord,
			GUILD,
			CHANNEL,
			"luna",
			"mei",
			"Mei",
			"zh",
			"deepseek",
			SECRETS.deepseek,
			true,
		]);
		await runInit(root, ui, deps());
		expect(rejected).toEqual(["personas/luna.md already exists"]);
		expect(readFileSync(join(root, "personas/luna.md"), "utf8")).toBe("mine");
	});
});
