import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError, ensureDeepSeekModelsFile, loadConfig, parseEnvFile, validateConfig } from "../src/config.ts";
import { DEFAULT_EMBEDDING_MODEL } from "../src/core/embedding.ts";
import { JEV_ENDPOINT } from "../src/decision/jev.ts";

const GUILD = "1552560014353506386";
const CHANNEL = "1552560015276113962";
const CHAT = "-1001234567890";
const env = {
	ROUTING_SECRET: "routing-fixture",
	DISCORD_LUNA_TOKEN: "discord-fixture",
	TELEGRAM_LUNA_TOKEN: "telegram-fixture",
	TYPESAFE_API_KEY: "jev-fixture",
};

let root: string;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "jingmei-config-"));
	mkdirSync(join(root, "personas"));
	writeFileSync(join(root, "personas/luna.md"), "Luna");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function luna(extra: Record<string, unknown> = {}) {
	return {
		id: "luna",
		name: "Luna",
		personaPath: "personas/luna.md",
		provider: "deepseek",
		model: "deepseek-flash",
		routingP: 0.6,
		discord: { tokenEnv: "DISCORD_LUNA_TOKEN" },
		telegram: { tokenEnv: "TELEGRAM_LUNA_TOKEN" },
		...extra,
	};
}

function base(extra: Record<string, unknown> = {}) {
	return {
		discord: { guilds: [{ guildId: GUILD, channelIds: [CHANNEL] }] },
		telegram: { chatIds: [CHAT] },
		personas: [luna()],
		...extra,
	};
}

function errorsOf(run: () => unknown): readonly string[] {
	try {
		run();
	} catch (error) {
		if (error instanceof ConfigError) return error.errors;
		throw error;
	}
	throw new Error("expected ConfigError");
}

describe("config", () => {
	test("kline charts are off unless enabled, and the switch must be a boolean", () => {
		expect(validateConfig(base(), root, env).kline).toBeUndefined();
		expect(validateConfig(base({ kline: { enabled: false } }), root, env).kline).toBeUndefined();
		expect(validateConfig(base({ kline: { enabled: true } }), root, env).kline).toEqual({});
		expect(errorsOf(() => validateConfig(base({ kline: { enabled: "yes" } }), root, env))).toEqual([
			"kline.enabled must be a boolean",
		]);
		expect(errorsOf(() => validateConfig(base({ kline: true }), root, env))).toEqual(["kline must be an object"]);
	});

	test("applies defaults and resolves secrets", () => {
		const config = validateConfig(base({ jev: { apiKeyEnv: "TYPESAFE_API_KEY" } }), root, env);
		expect(config.dataDir).toBe(join(root, "data"));
		expect(config.routingSecret).toBe("routing-fixture");
		expect(config.celebrations).toEqual([]);
		expect(config.webSearchApiKey).toBeUndefined();
		expect(config.jev).toEqual({
			endpoint: JEV_ENDPOINT,
			apiKey: "jev-fixture",
			model: "jev-latest",
			quickReactions: true,
			memoryScoring: true,
			replyDecision: true,
			replyThreshold: 0.7,
			threshold: 0.8,
			minIntervalMs: 60_000,
		});
		expect(config.personas[0]).toMatchObject({
			personaPath: join(root, "personas/luna.md"),
			reasoningEffort: "off",
			sendReactionImages: true,
			voiceEnabled: true,
			imageGenerationEnabled: true,
			aliases: [],
			adminUserIds: [],
			tokens: { discord: "discord-fixture", telegram: "telegram-fixture" },
		});
		expect(config.personas[0]?.spaces).toBeUndefined();
	});

	test("accepts reply-decision opt-out and threshold boundaries", () => {
		for (const replyThreshold of [0.0001, 0.7, 1]) {
			const config = validateConfig(
				base({ jev: { apiKeyEnv: "TYPESAFE_API_KEY", replyDecision: false, replyThreshold } }),
				root,
				env,
			);
			expect(config.jev?.replyDecision).toBe(false);
			expect(config.jev?.replyThreshold).toBe(replyThreshold);
		}
	});

	test("rejects invalid reply-decision settings even without a decision source", () => {
		for (const replyThreshold of [null, 0, -0.1, 1.01, Number.NaN, Infinity, "0.7", true])
			expect(errorsOf(() => validateConfig(base({ jev: { replyThreshold } }), root, env))).toContainEqual(
				"jev.replyThreshold must be in (0, 1]",
			);
		for (const replyDecision of [null, 0, "false", {}])
			expect(errorsOf(() => validateConfig(base({ jev: { replyDecision } }), root, env))).toContainEqual(
				"jev.replyDecision must be a boolean",
			);
	});

	test("accepts max reasoning and rejects unknown levels", () => {
		expect(
			validateConfig(base({ personas: [luna({ reasoningEffort: "max" })] }), root, env).personas[0]?.reasoningEffort,
		).toBe("max");
		expect(errorsOf(() => validateConfig(base({ personas: [luna({ reasoningEffort: "huge" })] }), root, env))).toEqual([
			expect.stringContaining("reasoningEffort"),
		]);
	});

	test("splits visionModel at the first slash", () => {
		expect(validateConfig(base({ visionModel: "openrouter/google/gemini" }), root, env).visionModel).toEqual({
			provider: "openrouter",
			model: "google/gemini",
		});
		for (const bad of ["gemini", "/gemini", "openrouter/", 3])
			expect(errorsOf(() => validateConfig(base({ visionModel: bad }), root, env))).toEqual([
				expect.stringContaining("visionModel"),
			]);
	});

	test("uses local decisions without implicitly enabling quick reactions or memory scoring", () => {
		const resolved = { ...env, DEEPSEEK_API_KEY: "deepseek-fixture" };
		const config = validateConfig(base({ events: { summaryModel: "openrouter/google/gemini" } }), root, resolved);
		expect(config.localJev).toEqual({
			baseUrl: "https://api.deepseek.com",
			model: "deepseek-flash",
			apiKey: "deepseek-fixture",
		});
		expect(config.jev).toBeUndefined();
		expect(config.events).toEqual({
			summaryModel: { provider: "openrouter", model: "google/gemini" },
			embeddingModel: DEFAULT_EMBEDDING_MODEL,
		});
		expect(validateConfig(base({ jev: {} }), root, resolved).jev?.apiKey).toBeUndefined();
		expect(validateConfig(base({ jev: {} }), root, resolved).jev?.quickReactions).toBe(true);
		expect(validateConfig(base({ jev: {} }), root, env).jev).toBeUndefined();
	});

	test("explicit local endpoints override DeepSeek and can run without credentials", () => {
		const config = validateConfig(
			base({
				jev: { endpoint: "http://localhost:8080/v1/systemone", apiKeyEnv: "TYPESAFE_API_KEY" },
				localJev: { baseUrl: "http://localhost:8000/v1", model: "local-model" },
				events: { summaryModel: "deepseek/deepseek-flash", embeddingModel: "fast-all-MiniLM-L6-v2" },
			}),
			root,
			{ ...env, DEEPSEEK_API_KEY: "unused-default" },
		);
		expect(config.localJev).toEqual({ baseUrl: "http://localhost:8000/v1", model: "local-model" });
		expect(config.jev?.endpoint).toBe("http://localhost:8080/v1/systemone");
		expect(config.jev?.apiKey).toBe("jev-fixture");
		expect(config.events?.embeddingModel).toBe("fast-all-MiniLM-L6-v2");
		const custom = validateConfig(
			base({ localJev: { baseUrl: "https://llm.example/v1", model: "custom", apiKeyEnv: "CUSTOM_LLM_KEY" } }),
			root,
			{ ...env, CUSTOM_LLM_KEY: "custom-fixture", DEEPSEEK_API_KEY: "unused-default" },
		);
		expect(custom.localJev?.apiKey).toBe("custom-fixture");
	});

	test("requires a decision client for events but accepts remote-only operation", () => {
		expect(errorsOf(() => validateConfig(base({ events: { summaryModel: "deepseek/flash" } }), root, env))).toEqual([
			expect.stringContaining("events requires"),
		]);
		const config = validateConfig(
			base({ jev: { apiKeyEnv: "TYPESAFE_API_KEY" }, events: { summaryModel: "deepseek/flash" } }),
			root,
			env,
		);
		expect(config.events?.summaryModel).toEqual({ provider: "deepseek", model: "flash" });
		expect(config.localJev).toBeUndefined();
	});

	test("collects event and endpoint validation failures without leaking credentials", () => {
		const errors = errorsOf(() =>
			validateConfig(
				base({
					jev: { endpoint: "ftp://secret-value@example.test", apiKeyEnv: "MISSING_REMOTE" },
					localJev: { baseUrl: "bad-secret-value", model: "", apiKeyEnv: "MISSING_LOCAL" },
					events: { summaryModel: "flash", embeddingModel: "not-an-embedding-model" },
				}),
				root,
				env,
			),
		);
		for (const field of [
			"jev.endpoint",
			"MISSING_REMOTE",
			"localJev.baseUrl",
			"localJev.model",
			"MISSING_LOCAL",
			"events.summaryModel",
			"events.embeddingModel",
			"events requires",
		])
			expect(errors).toContainEqual(expect.stringContaining(field));
		expect(errors.join("\n")).not.toContain("secret-value");
		for (const value of [null, [], 42])
			expect(errorsOf(() => validateConfig(base({ events: value, localJev: value }), root, env))).toContainEqual(
				"events must be an object",
			);
		for (const summaryModel of [undefined, "/flash", "deepseek/", 42])
			expect(
				errorsOf(() =>
					validateConfig(
						base({ events: { summaryModel }, localJev: { baseUrl: "http://localhost", model: "m" } }),
						root,
						env,
					),
				),
			).toContainEqual(expect.stringContaining("events.summaryModel"));
		for (const endpoint of [null, "", "ftp://example.test", 42])
			expect(errorsOf(() => validateConfig(base({ jev: { endpoint } }), root, env))).toContainEqual(
				expect.stringContaining("jev.endpoint"),
			);
		for (const embeddingModel of [null, "", "CUSTOM", 42])
			expect(
				errorsOf(() =>
					validateConfig(base({ events: { summaryModel: "deepseek/flash", embeddingModel } }), root, {
						...env,
						DEEPSEEK_API_KEY: "fixture",
					}),
				),
			).toContainEqual(expect.stringContaining("events.embeddingModel"));
	});

	test("normalizes admin ids per platform", () => {
		const config = validateConfig(
			base({
				personas: [
					luna({
						discord: { tokenEnv: "DISCORD_LUNA_TOKEN", adminUserIds: [CHANNEL, CHANNEL] },
						telegram: { tokenEnv: "TELEGRAM_LUNA_TOKEN", adminUserIds: ["12345"] },
					}),
				],
			}),
			root,
			env,
		);
		expect(config.personas[0]?.adminUserIds).toEqual([`discord:${CHANNEL}`, "telegram:12345"]);
		expect(
			errorsOf(() =>
				validateConfig(
					base({ personas: [luna({ discord: { tokenEnv: "DISCORD_LUNA_TOKEN", adminUserIds: ["12"] } })] }),
					root,
					env,
				),
			),
		).toEqual([expect.stringContaining("adminUserIds")]);
	});

	test("collects every error without echoing secret values", () => {
		const errors = errorsOf(() =>
			validateConfig(
				{
					discord: { guilds: [{ guildId: "123", channelIds: [CHANNEL] }] },
					telegram: { chatIds: ["chat"] },
					jev: { apiKeyEnv: "MISSING_JEV", threshold: 0, emojis: { discord: {} } },
					personas: [
						luna({ id: "Luna", routingP: 2, personaPath: "personas/missing.md" }),
						luna({ discord: undefined, telegram: { tokenEnv: "TELEGRAM_MISSING" } }),
					],
				},
				root,
				{ ...env, ROUTING_SECRET: "" },
			),
		);
		for (const fragment of [
			"Missing environment variable ROUTING_SECRET",
			"guildId",
			"telegram.chatIds[0]",
			"MISSING_JEV",
			"jev.threshold",
			"jev.emojis.discord",
			"personas[0].id",
			"personas[0].personaPath is not readable",
			"personas[0].routingP",
			"TELEGRAM_MISSING",
		])
			expect(errors.some((error) => error.includes(fragment))).toBe(true);
		expect(errors.join("\n")).not.toContain("fixture");
	});

	test("validates spaces, per-space routing and celebrations", () => {
		const ok = validateConfig(
			base({
				personas: [
					luna({ spaces: [`discord:${GUILD}`] }),
					luna({
						id: "sol",
						name: "Sol",
						routingP: 0.5,
						telegram: { tokenEnv: "TELEGRAM_LUNA_TOKEN" },
						discord: undefined,
					}),
				],
				celebrations: [
					{ space: `telegram:${CHAT}`, personaId: "sol", timeZone: "Asia/Shanghai", calendar: "china" },
					{ space: `discord:${GUILD}`, channelId: CHANNEL, personaId: "luna", timeZone: "UTC", calendar: "both" },
				],
			}),
			root,
			env,
		);
		expect(ok.personas[0]?.spaces).toEqual([`discord:${GUILD}`]);
		expect(ok.celebrations.map((target) => [target.spaceId, target.channelId])).toEqual([
			[`telegram:${CHAT}`, CHAT],
			[`discord:${GUILD}`, CHANNEL],
		]);

		const errors = errorsOf(() =>
			validateConfig(
				base({
					personas: [
						luna(),
						luna({ id: "sol", name: "Sol", routingP: 0.5 }),
						luna({
							id: "sky",
							routingP: 0,
							telegram: undefined,
							spaces: [`telegram:${CHAT}`, "discord:1111111111111111111", "slack:x"],
						}),
					],
					celebrations: [
						{
							space: `discord:${GUILD}`,
							channelId: "1111111111111111111",
							personaId: "luna",
							timeZone: "UTC",
							calendar: "both",
						},
						{ space: `telegram:${CHAT}`, personaId: "ghost", timeZone: "Nowhere/City", calendar: "moon" },
					],
				}),
				root,
				env,
			),
		);
		for (const fragment of [
			`needs a telegram account`,
			`"discord:1111111111111111111" is not a configured space`,
			`"slack:x" is not a configured space`,
			`routingP of personas in discord:${GUILD}`,
			"celebrations[0].channelId",
			"celebrations[1].personaId",
			"celebrations[1].timeZone",
			"celebrations[1].calendar",
		])
			expect(errors.some((error) => error.includes(fragment))).toBe(true);
	});

	test("requires platform sections for used accounts and accounts for configured sections", () => {
		const errors = errorsOf(() =>
			validateConfig({ telegram: { chatIds: [CHAT] }, personas: [luna({ telegram: undefined })] }, root, env),
		);
		expect(errors).toEqual([
			expect.stringContaining("top-level discord section is missing"),
			expect.stringContaining("no persona has a telegram account"),
		]);
		expect(
			errorsOf(() =>
				validateConfig({ ...base(), personas: [luna({ discord: undefined, telegram: undefined })] }, root, env),
			),
		).toContainEqual(expect.stringContaining("must have a discord or telegram account"));
	});

	test("loadConfig reads jingmei.config.json with process.env overriding .env", () => {
		writeFileSync(join(root, "jingmei.config.json"), JSON.stringify(base()));
		writeFileSync(
			join(root, ".env"),
			"# secrets\nROUTING_SECRET: from-file\nDISCORD_LUNA_TOKEN: d\nTELEGRAM_LUNA_TOKEN: t\n",
		);
		const previous = process.env.ROUTING_SECRET;
		process.env.ROUTING_SECRET = "from-process";
		try {
			expect(loadConfig(root).routingSecret).toBe("from-process");
		} finally {
			if (previous === undefined) delete process.env.ROUTING_SECRET;
			else process.env.ROUTING_SECRET = previous;
		}
	});

	test("env parser reports line numbers without values", () => {
		const path = join(root, ".env");
		writeFileSync(path, "# c\n\nA_KEY: one: two\nBAD=secret-value\n");
		expect(() => parseEnvFile(path)).toThrow(/line 4/);
		try {
			parseEnvFile(path);
		} catch (error) {
			expect(String(error)).not.toContain("secret-value");
		}
		writeFileSync(path, "1BAD: secret-value\n");
		expect(() => parseEnvFile(path)).toThrow(/Invalid \.env key at line 1/);
		writeFileSync(path, "A_KEY: one: two\n");
		expect(parseEnvFile(path)).toEqual({ A_KEY: "one: two" });
	});

	test("creates the DeepSeek model catalog once without secrets", () => {
		const path = ensureDeepSeekModelsFile(join(root, "agent"));
		const text = readFileSync(path, "utf8");
		expect(text).toContain("$DEEPSEEK_API_KEY");
		writeFileSync(path, "{}");
		expect(ensureDeepSeekModelsFile(join(root, "agent"))).toBe(path);
		expect(readFileSync(path, "utf8")).toBe("{}");
	});
});
