// `jingmei doctor`: a read-only self-check of a configured install. Every check is isolated and time-bounded, so one
// failure never hides the others. Output never contains token values, URLs or secret paths: failures are reported
// through `ProbeFailure` (messages safe by construction) or the repo's own config/model/sandbox error classes.

import { Database } from "bun:sqlite";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { type AppConfig, ConfigError, ensureDeepSeekModelsFile, loadConfig, piAgentDir } from "./config.ts";
import { loadVectorExtension, useExtensibleSqlite } from "./core/db.ts";
import {
	assertBotModelConfigured,
	createInstalledPiModelRuntime,
	PiModelConfigurationError,
} from "./core/model-runtime.ts";
import { inspectVideoTranscoder } from "./media/video-frames.ts";
import { errorCategory } from "./observability/log.ts";
import { assertRunJsSandbox, RunJsSandboxError } from "./tools/run-js.ts";

export type CheckStatus = "ok" | "warn" | "fail";

export interface CheckResult {
	name: string;
	status: CheckStatus;
	/** One-line reason. */
	detail: string;
	/** One-line hint, present on warn and fail. */
	fix?: string;
}

/** An error whose message and hint are safe to print as they are. */
export class ProbeFailure extends Error {
	constructor(
		message: string,
		readonly fix?: string,
	) {
		super(message);
		this.name = "ProbeFailure";
	}
}

/** Everything doctor touches outside its own logic, so tests run without network, processes or a real install. */
export interface DoctorProbes {
	loadConfig(): AppConfig;
	runJsSandbox(): Promise<void>;
	modelRuntime(config: AppConfig): Promise<Pick<ModelRuntime, "getModel" | "hasConfiguredAuth">>;
	/** `flags` are the Discord application flags, undefined when the response did not carry them. */
	discordBot(token: string): Promise<{ id: string; username: string; flags?: number }>;
	telegramBot(token: string): Promise<{ username: string; canReadAllGroupMessages?: boolean }>;
	telegramChat(token: string, chatId: string): Promise<{ title?: string }>;
	videoTranscoder(): { ffmpeg: boolean; ffprobe: boolean };
	cjkFontMissing(): Promise<boolean>;
	klineRender(): Promise<void>;
	vectorExtension(): void;
	embeddingModelCached(dataDir: string): boolean;
}

export interface DoctorOptions {
	/** Bound for each check, in milliseconds. */
	timeoutMs?: number;
}

const CHECK_TIMEOUT_MS = 20_000;
/** Application flags: GATEWAY_MESSAGE_CONTENT (1 << 18) and GATEWAY_MESSAGE_CONTENT_LIMITED (1 << 19). */
const MESSAGE_CONTENT_FLAGS = (1 << 18) | (1 << 19);
const INTENT_FIX =
	"Developer Portal > your application > Bot > Privileged Gateway Intents > enable Message Content Intent";

export type Attempt<T> = { ok: true; value: T } | { ok: false; reason: string; fix?: string };

function describe(error: unknown, timeoutMs: number): { reason: string; fix?: string } {
	if (error instanceof ProbeFailure) return { reason: error.message, ...(error.fix ? { fix: error.fix } : {}) };
	if (error instanceof ConfigError) return { reason: error.errors.join("\n") };
	if (error instanceof PiModelConfigurationError || error instanceof RunJsSandboxError)
		return { reason: error.message };
	if (error instanceof TimeoutError) return { reason: `timed out after ${Math.round(timeoutMs / 1000)}s` };
	return { reason: `unexpected ${errorCategory(error)}` };
}

class TimeoutError extends Error {}

export async function attempt<T>(timeoutMs: number, work: () => Promise<T> | T): Promise<Attempt<T>> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const value = await Promise.race([
			Promise.resolve().then(work),
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new TimeoutError()), timeoutMs);
			}),
		]);
		return { ok: true, value };
	} catch (error) {
		return { ok: false, ...describe(error, timeoutMs) };
	} finally {
		clearTimeout(timer);
	}
}

const ok = (name: string, detail: string): CheckResult => ({ name, status: "ok", detail });
const warn = (name: string, detail: string, fix: string): CheckResult => ({ name, status: "warn", detail, fix });
const fail = (name: string, detail: string, fix?: string): CheckResult => ({
	name,
	status: "fail",
	detail,
	...(fix ? { fix } : {}),
});

function modelFix(error: unknown): string | undefined {
	if (!(error instanceof PiModelConfigurationError)) return undefined;
	switch (error.category) {
		case "unsupported_reasoning_effort":
			return "lower reasoningEffort in jingmei.config.json, or pick another model with `bun run jingmei model`";
		case "image_input_unsupported":
			return "choose a vision-capable model for visionModel in jingmei.config.json";
		default:
			return `sign in with \`bun run jingmei login ${error.provider}\` or fix provider/model in jingmei.config.json`;
	}
}

/** Run every check and return results in a stable order. Never throws. */
export async function runDoctor(probes: DoctorProbes, options: DoctorOptions = {}): Promise<CheckResult[]> {
	const timeoutMs = options.timeoutMs ?? CHECK_TIMEOUT_MS;
	const groups: Array<Promise<CheckResult[]>> = [];
	const check = (run: () => Promise<CheckResult[]>) => groups.push(run());

	const loaded = await attempt(timeoutMs, () => probes.loadConfig());
	const config = loaded.ok ? loaded.value : undefined;
	if (loaded.ok) {
		const platforms = [config?.discord && "discord", config?.telegram && "telegram"].filter(Boolean).join(", ");
		const count = loaded.value.personas.length;
		groups.push(Promise.resolve([ok("config", `${count} ${count === 1 ? "persona" : "personas"} on ${platforms}`)]));
	} else {
		groups.push(
			Promise.resolve([fail("config", loaded.reason, loaded.fix ?? "edit jingmei.config.json / .env, then re-run")]),
		);
	}

	check(async () => {
		const result = await attempt(timeoutMs, () => probes.runJsSandbox());
		return [
			result.ok
				? ok("run_js sandbox", "bubblewrap works")
				: fail("run_js sandbox", result.reason, "install bubblewrap and allow user namespaces, see docs/deploy.md"),
		];
	});

	check(async () => {
		const transcoder = await attempt(timeoutMs, () => probes.videoTranscoder());
		if (!transcoder.ok) return [warn("ffmpeg", transcoder.reason, "install ffmpeg (includes ffprobe)")];
		const missing = [!transcoder.value.ffmpeg && "ffmpeg", !transcoder.value.ffprobe && "ffprobe"].filter(Boolean);
		return [
			missing.length
				? warn(
						"ffmpeg",
						`${missing.join(" and ")} missing: videos become a placeholder`,
						"sudo apt install ffmpeg (restart the bot afterwards)",
					)
				: ok("ffmpeg", "ffmpeg and ffprobe found"),
		];
	});

	if (config) {
		const checked = config;
		check(async () => {
			const runtime = await attempt(timeoutMs, () => probes.modelRuntime(checked));
			if (!runtime.ok)
				return [fail("models", runtime.reason, "check <dataDir>/pi-agent (models.json, auth.json) is readable")];
			const selections = [
				...checked.personas.map((persona) => ({
					name: `model ${persona.id}`,
					selection: {
						provider: persona.provider,
						model: persona.model,
						thinkingLevel: persona.reasoningEffort,
						purpose: persona.id,
					},
				})),
				...(checked.visionModel
					? [
							{
								name: "model vision",
								selection: { ...checked.visionModel, requireImageInput: true, purpose: "vision" },
							},
						]
					: []),
				...(checked.events
					? [{ name: "model events", selection: { ...checked.events.summaryModel, purpose: "events" } }]
					: []),
			];
			return selections.map(({ name, selection }) => {
				const label = `${selection.provider}/${selection.model}`;
				try {
					assertBotModelConfigured(selection, runtime.value);
					return ok(name, `${label} available and authenticated`);
				} catch (error) {
					const { reason } = describe(error, timeoutMs);
					const category = error instanceof PiModelConfigurationError ? error.category : reason;
					return fail(name, `${label}: ${category}`, modelFix(error));
				}
			});
		});

		for (const persona of checked.personas) {
			const token = persona.tokens.discord;
			if (token)
				check(async () => {
					const name = `discord ${persona.id}`;
					const bot = await attempt(timeoutMs, () => probes.discordBot(token));
					if (!bot.ok)
						return [
							fail(name, bot.reason, bot.fix ?? "check the bot token in .env (Developer Portal > Bot > Reset Token)"),
						];
					const intent = `${name} intent`;
					const { flags } = bot.value;
					return [
						ok(name, `token valid, bot ${bot.value.username}`),
						flags === undefined
							? warn(intent, "could not verify Message Content Intent", INTENT_FIX)
							: flags & MESSAGE_CONTENT_FLAGS
								? ok(intent, "Message Content Intent enabled")
								: fail(intent, "Message Content Intent is off: the bot cannot read messages", INTENT_FIX),
					];
				});
		}

		for (const persona of checked.personas) {
			const token = persona.tokens.telegram;
			if (!token) continue;
			check(async () => {
				const name = `telegram ${persona.id}`;
				const bot = await attempt(timeoutMs, () => probes.telegramBot(token));
				if (!bot.ok) return [fail(name, bot.reason, bot.fix ?? "check the bot token in .env (BotFather > /token)")];
				const results = [
					ok(name, `token valid, bot @${bot.value.username}`),
					bot.value.canReadAllGroupMessages === false
						? warn(
								`${name} privacy`,
								"privacy mode is on: the bot only sees commands and @mentions",
								"BotFather > /setprivacy > Disable (or make the bot a group admin), then remove and re-add the bot to the group",
							)
						: ok(`${name} privacy`, "bot can read all group messages"),
				];
				const chatIds = (checked.telegram?.chatIds ?? []).filter(
					(id) => !persona.spaces || persona.spaces.includes(`telegram:${id}`),
				);
				const chats = await Promise.all(
					chatIds.map(async (chatId) => {
						const chat = await attempt(timeoutMs, () => probes.telegramChat(token, chatId));
						return chat.ok
							? ok(`${name} chat ${chatId}`, "bot can see the group")
							: fail(
									`${name} chat ${chatId}`,
									chat.reason,
									"add the bot to the group, and check telegram.chatIds in jingmei.config.json",
								);
					}),
				);
				return [...results, ...chats];
			});
		}

		if (checked.features.search && !checked.webSearchApiKey)
			groups.push(
				Promise.resolve([
					warn(
						"web search",
						"DEEPSEEK_API_KEY is not set: the search_web tool is unavailable",
						'add "DEEPSEEK_API_KEY: ..." to .env, or set features.search to false',
					),
				]),
			);

		if (checked.textImage)
			check(async () => {
				const missing = await attempt(timeoutMs, () => probes.cjkFontMissing());
				if (!missing.ok)
					return [warn("text image", missing.reason, "check the Typst renderer installation (bun install)")];
				return [
					missing.value
						? warn(
								"text image",
								"no CJK font installed: Chinese text renders as empty boxes",
								"sudo apt install fonts-noto-cjk (restart the bot afterwards)",
							)
						: ok("text image", "CJK font found"),
				];
			});

		if (checked.kline)
			check(async () => {
				const probe = await attempt(timeoutMs, () => probes.klineRender());
				return [
					probe.ok
						? ok("kline", "chart renderer works")
						: warn("kline", `test render failed: ${probe.reason}`, "install the DejaVu Sans font (fonts-dejavu-core)"),
				];
			});

		if (checked.features.history) {
			check(async () => {
				const vector = await attempt(timeoutMs, () => probes.vectorExtension());
				return [
					vector.ok
						? ok("sqlite-vec", "vector extension loads")
						: fail(
								"sqlite-vec",
								"sqlite-vec cannot be loaded",
								"run `bun install`; on macOS `brew install sqlite`; or set features.history to false",
							),
				];
			});
			check(async () => {
				const cached = await attempt(timeoutMs, () => probes.embeddingModelCached(checked.dataDir));
				return [
					cached.ok && cached.value
						? ok("embedding model", "cached in the data directory")
						: warn(
								"embedding model",
								cached.ok ? "not downloaded yet: the first start downloads about 96 MB" : cached.reason,
								"make sure the first start has internet access, or set features.history to false",
							),
				];
			});
		}
	}

	return (await Promise.all(groups)).flat();
}

export function failureCount(results: readonly CheckResult[]): number {
	return results.filter((result) => result.status === "fail").length;
}

const LABELS: Record<CheckStatus, string> = { ok: "OK", warn: "WARN", fail: "FAIL" };

/** A compact table: one line per check (a multi-problem detail continues on indented lines), plus a `fix:` line under every warning and failure. */
export function formatReport(results: readonly CheckResult[]): string {
	const width = Math.max(0, ...results.map((result) => result.name.length));
	const indent = `${"".padEnd(5)} ${"".padEnd(width)}  `;
	const lines = results.flatMap((result) => {
		const [first = "", ...more] = result.detail.split("\n");
		return [
			`${LABELS[result.status].padEnd(5)} ${result.name.padEnd(width)}  ${first}`,
			...more.map((line) => `${indent}${line}`),
			...(result.fix ? [`${indent}fix: ${result.fix}`] : []),
		];
	});
	const count = (status: CheckStatus) => results.filter((result) => result.status === status).length;
	return [...lines, "", `${count("ok")} ok, ${count("warn")} warn, ${count("fail")} fail`].join("\n");
}

/** Wrap a platform call so only its safe message reaches the report; network errors may carry the token in the URL. */
async function platformCall<T>(work: () => Promise<T>): Promise<T> {
	try {
		return await work();
	} catch (error) {
		const message = error instanceof Error ? error.message : "";
		if (/^(Discord API request failed with HTTP|telegram api error) \d+/.test(message)) {
			throw new ProbeFailure(message.replace(/^telegram api error /, "Telegram error "));
		}
		throw new ProbeFailure("request failed (network error)", "check the server's internet access");
	}
}

/** The real probes. Heavy modules load only when their check runs. */
export function defaultProbes(rootDir: string): DoctorProbes {
	return {
		loadConfig: () => loadConfig(rootDir),
		runJsSandbox: assertRunJsSandbox,
		modelRuntime: async (config) => {
			const agentDir = piAgentDir(config.dataDir);
			// The same non-secret catalog the bot writes at startup, so a fresh install checks like a started one.
			ensureDeepSeekModelsFile(agentDir);
			if (config.webSearchApiKey) process.env.DEEPSEEK_API_KEY = config.webSearchApiKey;
			return createInstalledPiModelRuntime({ cwd: config.rootDir, agentDir });
		},
		discordBot: (token) =>
			platformCall(async () => {
				const { DiscordTransport } = await import("./platforms/discord/transport.ts");
				const client = new DiscordTransport({ token, applicationId: "10000000000000001" });
				const identity = await client.getCurrentUser();
				const flags = await client.getApplicationFlags().catch(() => undefined);
				return { id: identity.id, username: identity.username, ...(flags === undefined ? {} : { flags }) };
			}),
		telegramBot: (token) =>
			platformCall(async () => {
				const { BotApi } = await import("./platforms/telegram/api.ts");
				const me = await new BotApi(token).getMe();
				return {
					username: me.username,
					...(me.can_read_all_group_messages === undefined
						? {}
						: { canReadAllGroupMessages: me.can_read_all_group_messages }),
				};
			}),
		telegramChat: (token, chatId) =>
			platformCall(async () => {
				const { BotApi } = await import("./platforms/telegram/api.ts");
				const chat = await new BotApi(token).getChat(chatId);
				return chat.title === undefined ? {} : { title: chat.title };
			}),
		videoTranscoder: () => inspectVideoTranscoder(),
		cjkFontMissing: async () => (await import("./media/text-image.ts")).cjkFontMissing(),
		klineRender: async () => (await import("./media/kline-image.ts")).probeKlineRender(),
		vectorExtension: () => {
			useExtensibleSqlite();
			const db = new Database(":memory:");
			try {
				loadVectorExtension(db);
			} finally {
				db.close();
			}
		},
		// fastembed keeps each model in its own directory under `<dataDir>/models`; any cached *.onnx counts.
		embeddingModelCached: (dataDir) => {
			const root = join(dataDir, "models");
			try {
				return readdirSync(root, { withFileTypes: true }).some(
					(entry) => entry.isDirectory() && readdirSync(join(root, entry.name)).some((file) => file.endsWith(".onnx")),
				);
			} catch {
				return false;
			}
		},
	};
}
