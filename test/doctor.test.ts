import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AppConfig, ConfigError, validateConfig } from "../src/config.ts";
import {
	type CheckResult,
	defaultProbes,
	type DoctorProbes,
	failureCount,
	formatReport,
	ProbeFailure,
	runDoctor,
} from "../src/doctor.ts";
import { RunJsSandboxError } from "../src/tools/run-js.ts";

const GUILD = "1552560014353506386";
const CHANNEL = "1552560015276113962";
const CHAT = "-1001234567890";
const TOKEN_D = "discord-token-fixture";
const TOKEN_T = "123456:telegram-token-fixture";
const env = { ROUTING_SECRET: "routing-fixture", DISCORD_LUNA_TOKEN: TOKEN_D, TELEGRAM_LUNA_TOKEN: TOKEN_T };

let root: string;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "jingmei-doctor-"));
	mkdirSync(join(root, "personas"));
	writeFileSync(join(root, "personas/luna.md"), "Luna");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function configOf(extra: Record<string, unknown> = {}, environment: Record<string, string> = env): AppConfig {
	return validateConfig(
		{
			discord: { guilds: [{ guildId: GUILD, channelIds: [CHANNEL] }] },
			telegram: { chatIds: [CHAT] },
			personas: [
				{
					id: "luna",
					name: "Luna",
					personaPath: "personas/luna.md",
					provider: "deepseek",
					model: "deepseek-flash",
					routingP: 0.5,
					discord: { tokenEnv: "DISCORD_LUNA_TOKEN" },
					telegram: { tokenEnv: "TELEGRAM_LUNA_TOKEN" },
				},
			],
			...extra,
		},
		root,
		{ DEEPSEEK_API_KEY: "deepseek-fixture", ...environment },
	);
}

/** Every probe succeeds; tests override only the one they break. */
function probes(config: AppConfig, overrides: Partial<DoctorProbes> = {}): DoctorProbes {
	const model = { input: ["text", "image"], reasoning: false };
	return {
		loadConfig: () => config,
		runJsSandbox: async () => {},
		modelRuntime: async () => ({ getModel: () => model as never, hasConfiguredAuth: () => true }),
		discordBot: async () => ({ id: GUILD, username: "Luna", flags: 1 << 18 }),
		telegramBot: async () => ({ username: "luna_bot", canReadAllGroupMessages: true }),
		telegramChat: async () => ({ title: "Group" }),
		videoTranscoder: () => ({ ffmpeg: true, ffprobe: true }),
		cjkFontMissing: async () => false,
		klineRender: async () => {},
		vectorExtension: () => {},
		embeddingModelCached: () => true,
		...overrides,
	};
}

function byName(results: readonly CheckResult[]): Record<string, CheckResult> {
	return Object.fromEntries(results.map((result) => [result.name, result]));
}

describe("doctor", () => {
	test("a healthy install reports only OK", async () => {
		const results = await runDoctor(probes(configOf({ textImage: { enabled: true }, kline: { enabled: true } })));
		expect(results.filter((result) => result.status !== "ok")).toEqual([]);
		expect(results.map((result) => result.name)).toEqual([
			"config",
			"run_js sandbox",
			"ffmpeg",
			"model luna",
			"discord luna",
			"discord luna intent",
			"telegram luna",
			"telegram luna privacy",
			`telegram luna chat ${CHAT}`,
			"text image",
			"kline",
			"sqlite-vec",
			"embedding model",
		]);
		expect(failureCount(results)).toBe(0);
	});

	test("config errors are listed and everything that needs the config is skipped", async () => {
		const bad = probes(configOf(), {
			loadConfig: () => {
				throw new ConfigError(["personas must contain at least one persona", "Missing environment variable X (y)"]);
			},
		});
		const results = await runDoctor(bad);
		expect(results.map((result) => result.name)).toEqual(["config", "run_js sandbox", "ffmpeg"]);
		expect(results[0]?.status).toBe("fail");
		expect(results[0]?.detail).toBe("personas must contain at least one persona\nMissing environment variable X (y)");
		expect(failureCount(results)).toBe(1);
	});

	test("each failing check is isolated and the others still run", async () => {
		const results = byName(
			await runDoctor(
				probes(configOf({ kline: { enabled: true } }), {
					runJsSandbox: async () => {
						throw new RunJsSandboxError("run_js sandbox unavailable (no bwrap)");
					},
					discordBot: async () => {
						throw new ProbeFailure("Discord API request failed with HTTP 401");
					},
					telegramBot: async () => {
						throw new Error("boom");
					},
					videoTranscoder: () => ({ ffmpeg: true, ffprobe: false }),
					klineRender: async () => {
						throw new Error("no font");
					},
					vectorExtension: () => {
						throw new Error("no extension");
					},
					embeddingModelCached: () => false,
				}),
			),
		);
		expect(results["run_js sandbox"]).toMatchObject({ status: "fail", detail: expect.stringContaining("no bwrap") });
		expect(results["discord luna"]).toMatchObject({
			status: "fail",
			detail: "Discord API request failed with HTTP 401",
		});
		expect(results["discord luna"]?.fix).toBeDefined();
		expect(results["telegram luna"]).toMatchObject({ status: "fail", detail: "unexpected error" });
		expect(results.ffmpeg).toMatchObject({ status: "warn", detail: expect.stringContaining("ffprobe") });
		expect(results.kline?.status).toBe("warn");
		expect(results["sqlite-vec"]?.status).toBe("fail");
		expect(results["embedding model"]?.status).toBe("warn");
		expect(results["model luna"]?.status).toBe("ok");
		expect(results.config?.status).toBe("ok");
	});

	test("a model that is unknown, unauthenticated or lacks image input fails with a sign-in hint", async () => {
		const config = configOf({ visionModel: "openrouter/some-model" });
		const results = byName(
			await runDoctor(
				probes(config, {
					modelRuntime: async () => ({
						getModel: (provider) =>
							provider === "deepseek" ? undefined : ({ input: ["text"], reasoning: false } as never),
						hasConfiguredAuth: () => false,
					}),
				}),
			),
		);
		expect(results["model luna"]).toMatchObject({ status: "fail", detail: "deepseek/deepseek-flash: unknown_model" });
		expect(results["model luna"]?.fix).toContain("bun run jingmei login deepseek");
		expect(results["model vision"]).toMatchObject({
			status: "fail",
			detail: "openrouter/some-model: image_input_unsupported",
		});
	});

	test("a model runtime that cannot be built is one failure, not a crash", async () => {
		const results = byName(
			await runDoctor(
				probes(configOf(), {
					modelRuntime: async () => {
						throw new Error("EACCES");
					},
				}),
			),
		);
		expect(results.models?.status).toBe("fail");
		expect(results["discord luna"]?.status).toBe("ok");
	});

	test("Message Content Intent: either privileged bit passes, none fails, unknown only warns", async () => {
		const status = async (flags: number | undefined) =>
			byName(
				await runDoctor(
					probes(configOf(), {
						discordBot: async () => ({ id: GUILD, username: "Luna", ...(flags === undefined ? {} : { flags }) }),
					}),
				),
			)["discord luna intent"]?.status;
		expect(await status(1 << 18)).toBe("ok");
		expect(await status(1 << 19)).toBe("ok");
		expect(await status((1 << 12) | (1 << 14))).toBe("fail");
		expect(await status(0)).toBe("fail");
		expect(await status(undefined)).toBe("warn");
	});

	test("Telegram privacy mode warns and each configured chat is checked", async () => {
		const config = configOf({ telegram: { chatIds: [CHAT, "-1009999999999"] } });
		const seen: string[] = [];
		const results = byName(
			await runDoctor(
				probes(config, {
					telegramBot: async () => ({ username: "luna_bot", canReadAllGroupMessages: false }),
					telegramChat: async (_token, chatId) => {
						seen.push(chatId);
						if (chatId === CHAT) throw new ProbeFailure("Telegram error 400: Bad Request: chat not found");
						return {};
					},
				}),
			),
		);
		expect(results["telegram luna privacy"]).toMatchObject({ status: "warn" });
		expect(results["telegram luna privacy"]?.fix).toContain("/setprivacy");
		expect(results[`telegram luna chat ${CHAT}`]?.status).toBe("fail");
		expect(results["telegram luna chat -1009999999999"]?.status).toBe("ok");
		expect(seen.sort()).toEqual([CHAT, "-1009999999999"].sort());
	});

	test("optional dependencies are checked only when their feature is on", async () => {
		const called: string[] = [];
		const results = await runDoctor(
			probes(configOf({ features: { history: false, search: false } }), {
				cjkFontMissing: async () => {
					called.push("font");
					return false;
				},
				klineRender: async () => void called.push("kline"),
				vectorExtension: () => void called.push("vec"),
				embeddingModelCached: () => {
					called.push("embedding");
					return false;
				},
			}),
		);
		expect(called).toEqual([]);
		expect(results.map((result) => result.name)).not.toContain("web search");
	});

	test("search without a DeepSeek key warns; a missing font warns", async () => {
		const config = validateConfig(
			{
				discord: { guilds: [{ guildId: GUILD, channelIds: [CHANNEL] }] },
				personas: [
					{
						id: "luna",
						name: "Luna",
						personaPath: "personas/luna.md",
						provider: "openai-codex",
						model: "gpt",
						routingP: 0.5,
						discord: { tokenEnv: "DISCORD_LUNA_TOKEN" },
					},
				],
				textImage: { enabled: true },
			},
			root,
			env,
		);
		const results = byName(await runDoctor(probes(config, { cjkFontMissing: async () => true })));
		expect(results["web search"]?.status).toBe("warn");
		expect(results["text image"]?.status).toBe("warn");
	});

	test("a hanging check times out instead of blocking the report", async () => {
		const results = byName(
			await runDoctor(probes(configOf(), { telegramBot: () => new Promise(() => {}) }), { timeoutMs: 20 }),
		);
		expect(results["telegram luna"]).toMatchObject({ status: "fail", detail: "timed out after 0s" });
		expect(results["discord luna"]?.status).toBe("ok");
	});

	test("the report never contains tokens, keys or the work directory, even when probes fail", async () => {
		const leaky = (message: string) => async (): Promise<never> => {
			throw new Error(`${message} https://api.telegram.org/bot${TOKEN_T}/getMe ${root}/.env`);
		};
		const results = await runDoctor(
			probes(configOf(), { discordBot: leaky(TOKEN_D), telegramBot: leaky(TOKEN_T), telegramChat: leaky(TOKEN_T) }),
		);
		const report = formatReport(results);
		for (const secret of [TOKEN_D, TOKEN_T, "routing-fixture", "deepseek-fixture", root, "api.telegram.org"])
			expect(report).not.toContain(secret);
		expect(report).toContain("FAIL");
	});

	test("the report has one line per check, a fix line under each non-OK check, and a summary", () => {
		const report = formatReport([
			{ name: "config", status: "ok", detail: "1 persona" },
			{ name: "sandbox", status: "fail", detail: "first problem\nsecond problem" },
			{ name: "ffmpeg", status: "warn", detail: "ffprobe missing", fix: "install ffmpeg" },
			{ name: "sqlite-vec", status: "fail", detail: "cannot load", fix: "bun install" },
		]);
		expect(report.split("\n")).toEqual([
			"OK    config      1 persona",
			"FAIL  sandbox     first problem",
			"                  second problem",
			"WARN  ffmpeg      ffprobe missing",
			"                  fix: install ffmpeg",
			"FAIL  sqlite-vec  cannot load",
			"                  fix: bun install",
			"",
			"1 ok, 1 warn, 2 fail",
		]);
	});

	test("only failures count toward a nonzero exit", () => {
		const warnOnly: CheckResult[] = [{ name: "a", status: "warn", detail: "", fix: "" }];
		expect(failureCount(warnOnly)).toBe(0);
		expect(failureCount([...warnOnly, { name: "b", status: "fail", detail: "" }])).toBe(1);
	});

	test("the real Discord and Telegram probes call the documented endpoints and hide failure details", async () => {
		const realFetch = globalThis.fetch;
		const urls: string[] = [];
		const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
		globalThis.fetch = (async (input: string | URL | Request) => {
			const url = String(input instanceof Request ? input.url : input);
			urls.push(url.replace(TOKEN_T, "<token>"));
			if (url.endsWith("/users/@me")) return json({ id: GUILD, username: "Luna" });
			if (url.endsWith("/applications/@me")) return json({ flags: (1 << 19) | 1 });
			if (url.endsWith("/getMe"))
				return json({ ok: true, result: { id: 1, username: "luna_bot", can_read_all_group_messages: false } });
			if (url.endsWith("/getChat"))
				return json({ ok: false, error_code: 400, description: "Bad Request: chat not found" }, 400);
			throw new Error(`network down at ${url}`);
		}) as typeof fetch;
		try {
			const real = defaultProbes(root);
			expect(await real.discordBot(TOKEN_D)).toEqual({ id: GUILD, username: "Luna", flags: (1 << 19) | 1 });
			expect(await real.telegramBot(TOKEN_T)).toEqual({ username: "luna_bot", canReadAllGroupMessages: false });
			await expect(real.telegramChat(TOKEN_T, CHAT)).rejects.toThrow("Telegram error 400: Bad Request: chat not found");
			globalThis.fetch = (async (input: string | URL | Request) => {
				throw new Error(`connect failed ${String(input)}`);
			}) as unknown as typeof fetch;
			const failure = await real.telegramBot(TOKEN_T).catch((error: unknown) => error);
			expect(failure).toBeInstanceOf(ProbeFailure);
			expect((failure as Error).message).not.toContain(TOKEN_T);
		} finally {
			globalThis.fetch = realFetch;
		}
		expect(urls).toEqual([
			"https://discord.com/api/v10/users/@me",
			"https://discord.com/api/v10/applications/@me",
			"https://api.telegram.org/bot<token>/getMe",
			"https://api.telegram.org/bot<token>/getChat",
		]);
	});
});
