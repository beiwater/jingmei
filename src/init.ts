// `jingmei init`: a prompt wizard that creates jingmei.config.json, .env and a persona file for a new install.
// `buildInitFiles` is pure and validates its result with the real `validateConfig`, so the wizard cannot emit a
// config the bot would reject. The prompt layer is a thin `InitUi` so the whole flow is testable without a terminal.

import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as p from "@clack/prompts";
import {
	DISCORD_ID,
	FISH_REFERENCE_ID,
	FEATURE_NAMES,
	type FeatureName,
	formatEnvFile,
	PERSONA_ID,
	TELEGRAM_CHAT_ID,
	validateConfig,
} from "./config.ts";
import { attempt, type DoctorProbes, defaultProbes } from "./doctor.ts";

const CONFIG_FILE = "jingmei.config.json";
const ENV_FILE = ".env";
const VERIFY_TIMEOUT_MS = 15_000;
const ROUTING_P = 0.65;

export interface InitAnswers {
	discord?: { token: string; guildId: string; channelIds: string[] };
	telegram?: { token: string; chatIds: string[] };
	persona: { id: string; name: string; template: "zh" | "en" };
	/** DeepSeek key for the `deepseek` provider; other providers sign in later with `jingmei login`. */
	model: { provider: string; model: string; deepseekApiKey?: string };
	routingSecret: string;
	/** Every core feature switch; only the ones turned off are written. */
	features: Record<FeatureName, boolean>;
	voice?: { apiKey: string; referenceId: string };
	textImage?: boolean;
	kline?: boolean;
	/** An empty `apiKey` selects the in-process wrapper, which needs `deepseekApiKey`. */
	jev?: { apiKey?: string };
	events?: { summaryModel: string };
	celebrations?: { timeZone: string; calendar: "china" | "australia" | "both" };
}

/** Env var name for a persona's bot token, e.g. `DISCORD_LUNA_TOKEN`. */
function tokenEnv(platform: "discord" | "telegram", personaId: string): string {
	return `${platform.toUpperCase()}_${personaId.toUpperCase().replaceAll("-", "_")}_TOKEN`;
}

/**
 * The config object and the secrets for `.env`. Validated with `validateConfig`; the persona path is checked
 * against the shipped template, because the persona file is created only after validation passes.
 */
export function buildInitFiles(
	answers: InitAnswers,
	rootDir: string,
): { config: Record<string, unknown>; env: Record<string, string> } {
	const { persona, model } = answers;
	const env: Record<string, string> = { ROUTING_SECRET: answers.routingSecret };
	const account: Record<string, unknown> = {};
	if (answers.discord) {
		env[tokenEnv("discord", persona.id)] = answers.discord.token;
		account.discord = { tokenEnv: tokenEnv("discord", persona.id) };
	}
	if (answers.telegram) {
		env[tokenEnv("telegram", persona.id)] = answers.telegram.token;
		account.telegram = { tokenEnv: tokenEnv("telegram", persona.id) };
	}
	if (model.deepseekApiKey) env.DEEPSEEK_API_KEY = model.deepseekApiKey;
	if (answers.voice) env.FISH_AUDIO_API_KEY = answers.voice.apiKey;
	if (answers.jev?.apiKey) env.TYPESAFE_API_KEY = answers.jev.apiKey;

	const disabled = FEATURE_NAMES.filter((name) => !answers.features[name]);
	const celebrations = answers.celebrations
		? [
				...(answers.discord
					? [
							{
								space: `discord:${answers.discord.guildId}`,
								channelId: answers.discord.channelIds[0],
								personaId: persona.id,
							},
						]
					: []),
				...(answers.telegram ? [{ space: `telegram:${answers.telegram.chatIds[0]}`, personaId: persona.id }] : []),
			].map((target) => ({
				...target,
				timeZone: answers.celebrations?.timeZone,
				calendar: answers.celebrations?.calendar,
			}))
		: undefined;
	const config: Record<string, unknown> = {
		...(answers.discord
			? { discord: { guilds: [{ guildId: answers.discord.guildId, channelIds: answers.discord.channelIds }] } }
			: {}),
		...(answers.telegram ? { telegram: { chatIds: answers.telegram.chatIds } } : {}),
		...(disabled.length ? { features: Object.fromEntries(disabled.map((name) => [name, false])) } : {}),
		...(answers.voice ? { voice: { apiKeyEnv: "FISH_AUDIO_API_KEY", referenceId: answers.voice.referenceId } } : {}),
		...(answers.textImage ? { textImage: { enabled: true } } : {}),
		...(answers.kline ? { kline: { enabled: true } } : {}),
		...(answers.jev ? { jev: answers.jev.apiKey ? { apiKeyEnv: "TYPESAFE_API_KEY" } : {} } : {}),
		...(answers.events ? { events: { summaryModel: answers.events.summaryModel } } : {}),
		...(celebrations ? { celebrations } : {}),
		personas: [
			{
				id: persona.id,
				name: persona.name,
				personaPath: `personas/${persona.id}.md`,
				provider: model.provider,
				model: model.model,
				routingP: ROUTING_P,
				...account,
			},
		],
	};
	validateConfig(
		{
			...config,
			personas: [{ ...(config.personas as object[])[0], personaPath: personaTemplate(persona.template) }],
		},
		rootDir,
		env,
	);
	return { config, env };
}

function personaTemplate(language: "zh" | "en"): string {
	return `personas/template.${language}.md`;
}

/** Names of the files `init` must never overwrite that already exist. */
export function existingInstallFiles(rootDir: string): string[] {
	return [CONFIG_FILE, ENV_FILE].filter((name) => existsSync(join(rootDir, name)));
}

/**
 * Create the persona file (from the template), `.env` (mode 0600) and the config, in that order, never replacing
 * an existing file. If a write fails, the files created so far are removed again.
 */
export function writeInstall(
	rootDir: string,
	files: { config: Record<string, unknown>; env: Record<string, string> },
	persona: { id: string; template: "zh" | "en" },
): void {
	const personaFile = join(rootDir, "personas", `${persona.id}.md`);
	const writes: Array<{ path: string; content: string | Buffer; mode: number }> = [
		{ path: personaFile, content: readFileSync(join(rootDir, personaTemplate(persona.template))), mode: 0o644 },
		{
			path: join(rootDir, ENV_FILE),
			content: formatEnvFile(files.env, "jingmei secrets, `key: value` format; created by `bun run jingmei init`."),
			mode: 0o600,
		},
		{ path: join(rootDir, CONFIG_FILE), content: `${JSON.stringify(files.config, null, "\t")}\n`, mode: 0o644 },
	];
	mkdirSync(join(rootDir, "personas"), { recursive: true });
	const created: string[] = [];
	try {
		for (const { path, content, mode } of writes) {
			writeFileSync(path, content, { flag: "wx", mode });
			created.push(path);
			chmodSync(path, mode);
		}
	} catch (error) {
		for (const path of created) unlinkSync(path);
		throw error;
	}
}

// Discord permission bits: Add Reactions, View Channels, Send Messages, Attach Files, Read Message History,
// Send Messages in Threads. Administrator is never needed.
const INVITE_PERMISSIONS = (1n << 6n) | (1n << 10n) | (1n << 11n) | (1n << 15n) | (1n << 16n) | (1n << 38n);

/** OAuth2 invite link for a bot; the application id of a bot equals its user id. */
export function discordInviteUrl(clientId: string): string {
	return `https://discord.com/oauth2/authorize?client_id=${clientId}&scope=bot%20applications.commands&permissions=${INVITE_PERMISSIONS}`;
}

export interface UiOption<T extends string> {
	value: T;
	label: string;
	hint?: string;
}

/** The prompts the wizard needs. Validators return an error message, or undefined to accept. */
export interface InitUi {
	select<T extends string>(message: string, options: UiOption<T>[], initial?: T): Promise<T>;
	text(
		message: string,
		options?: { initial?: string; placeholder?: string; validate?: (value: string) => string | undefined },
	): Promise<string>;
	/** Masked input, never echoed. */
	password(message: string, validate?: (value: string) => string | undefined): Promise<string>;
	confirm(message: string, initial?: boolean): Promise<boolean>;
	multiselect<T extends string>(message: string, options: UiOption<T>[], initial?: T[]): Promise<T[]>;
	info(message: string): void;
	warn(message: string): void;
	/** A line printed verbatim (links must not be wrapped by the frame). */
	raw(message: string): void;
}

export interface InitDeps {
	probes: Pick<DoctorProbes, "discordBot" | "telegramBot">;
	randomSecret(): string;
	timeZone(): string;
}

export function defaultInitDeps(rootDir: string): InitDeps {
	const probes = defaultProbes(rootDir);
	return {
		probes,
		randomSecret: () => randomBytes(32).toString("hex"),
		timeZone: () => Intl.DateTimeFormat().resolvedOptions().timeZone,
	};
}

const required = (value: string): string | undefined => (value.trim() ? undefined : "Required");
const idList = (value: string): string[] => value.split(/[\s,]+/).filter(Boolean);

function validIds(pattern: RegExp, what: string) {
	return (value: string): string | undefined => {
		const ids = idList(value);
		return ids.length && ids.every((id) => pattern.test(id)) ? undefined : what;
	};
}

function validTimeZone(value: string): string | undefined {
	try {
		new Intl.DateTimeFormat("en", { timeZone: value.trim() });
		return undefined;
	} catch {
		return "Use an IANA time zone such as Australia/Sydney or Asia/Shanghai";
	}
}

const CORE_FEATURES: Array<{ name: FeatureName; message: string }> = [
	{
		name: "history",
		message:
			"history: message search and related-message counts. Off saves the ~96 MB embedding model download and the vector store. Keep it?",
	},
	{
		name: "memory",
		message:
			"memory: remembers members' facts, preferences and birthdays. Off saves the extra tool calls and tokens. Keep it?",
	},
	{
		name: "soul",
		message: "soul: private persona notes injected into every prompt. Off saves those prompt tokens. Keep it?",
	},
	{
		name: "search",
		message: "search: web search through DeepSeek (needs DEEPSEEK_API_KEY). Off saves the search calls. Keep it?",
	},
	{
		name: "audit",
		message: "audit: one extra naturalness check call per reply. Off saves that call per reply. Keep it?",
	},
];

type AddOn = "voice" | "imageGeneration" | "kline" | "textImage" | "jev" | "events" | "celebrations";

/** A token that failed verification can be retried or kept anyway (offline install); doctor flags it later. */
async function verifiedToken<T>(
	ui: InitUi,
	label: string,
	verify: (token: string) => Promise<T>,
): Promise<{ token: string; info?: T }> {
	for (;;) {
		const token = (await ui.password(`${label} bot token`, required)).trim();
		const result = await attempt(VERIFY_TIMEOUT_MS, () => verify(token));
		if (result.ok) return { token, info: result.value };
		ui.warn(`${label} did not accept the token: ${result.reason}`);
		if (!(await ui.confirm("Enter the token again?", true))) {
			ui.warn("Keeping the token unverified; `bun run jingmei doctor` will check it again.");
			return { token };
		}
	}
}

/** Ask the questions. Returns the answers plus the platform-specific notes to print at the end. */
export async function collectAnswers(
	ui: InitUi,
	deps: InitDeps,
	rootDir: string,
): Promise<{ answers: InitAnswers; notes: string[] }> {
	const notes: string[] = [];
	const mode = await ui.select("How much do you want to set up?", [
		{ value: "recommended", label: "Recommended", hint: "all core features on, no add-ons" },
		{ value: "minimal", label: "Minimal", hint: "every core feature off: no model download, fewest extra calls" },
		{ value: "custom", label: "Custom", hint: "choose core features and add-ons" },
	]);
	const platforms = await ui.select("Platforms", [
		{ value: "discord", label: "Discord" },
		{ value: "telegram", label: "Telegram" },
		{ value: "both", label: "Both" },
	]);

	let discord: InitAnswers["discord"];
	if (platforms !== "telegram") {
		ui.info("Discord: create an application at https://discord.com/developers/applications, then Bot > Reset Token.");
		const { token, info } = await verifiedToken(ui, "Discord", (value) => deps.probes.discordBot(value));
		if (info) {
			ui.info(`Discord bot: ${info.username}`);
			if (info.flags !== undefined && !(info.flags & ((1 << 18) | (1 << 19))))
				ui.warn(
					"Message Content Intent is off. Enable it under Bot > Privileged Gateway Intents, or the bot cannot read messages.",
				);
		}
		ui.info("Ids: Discord settings > Advanced > Developer Mode, then right-click the server / channel > Copy ID.");
		const guildId = (
			await ui.text("Server (guild) id", {
				validate: (value) => (DISCORD_ID.test(value.trim()) ? undefined : "A 17-20 digit id"),
			})
		).trim();
		const channelIds = idList(
			await ui.text("Channel ids the bot may use (comma separated)", {
				validate: validIds(DISCORD_ID, "17-20 digit ids, separated by commas"),
			}),
		);
		discord = { token, guildId, channelIds: [...new Set(channelIds)] };
		notes.push(
			info
				? `Discord invite (opens in a browser): ${discordInviteUrl(info.id)}`
				: "Discord: invite the bot with Developer Portal > OAuth2 > URL Generator (scopes bot + applications.commands).",
		);
	}

	let telegram: InitAnswers["telegram"];
	if (platforms !== "discord") {
		ui.info("Telegram: create the bot with @BotFather (/newbot) and copy its token.");
		const { token, info } = await verifiedToken(ui, "Telegram", (value) => deps.probes.telegramBot(value));
		if (info) ui.info(`Telegram bot: @${info.username}`);
		if (info?.canReadAllGroupMessages === false)
			ui.warn(
				"Privacy mode is on: the bot only sees commands and @mentions. BotFather > /setprivacy > Disable (or make it a group admin).",
			);
		else if (!info) ui.warn("Remember to turn privacy mode off: BotFather > /setprivacy > Disable.");
		ui.info(
			"Group ids look like -1001234567890. Add the bot to the group, then read the id from the address bar of web.telegram.org (supergroup ids start with -100). Or start with any id and read chat_id from the chat_ignored log line.",
		);
		const chatIds = idList(
			await ui.text("Group chat ids (comma separated)", {
				validate: validIds(TELEGRAM_CHAT_ID, "Numeric ids like -1001234567890, separated by commas"),
			}),
		);
		telegram = { token, chatIds: [...new Set(chatIds)] };
	}

	const id = (
		await ui.text("Persona id (lowercase letters, digits, - and _)", {
			initial: "luna",
			validate: (value) =>
				!PERSONA_ID.test(value.trim())
					? "Use lowercase letters, digits, - and _"
					: existsSync(join(rootDir, "personas", `${value.trim()}.md`))
						? `personas/${value.trim()}.md already exists`
						: undefined,
		})
	).trim();
	const name = (
		await ui.text("Display name", { initial: id.charAt(0).toUpperCase() + id.slice(1), validate: required })
	).trim();
	const template = await ui.select("Persona file template", [
		{ value: "zh", label: "中文 (template.zh.md)" },
		{ value: "en", label: "English (template.en.md)" },
	]);

	const modelChoice = await ui.select("Model", [
		{ value: "deepseek", label: "DeepSeek (deepseek/deepseek-flash)", hint: "needs a DeepSeek API key" },
		{ value: "later", label: "Another provider", hint: "sign in later with `bun run jingmei login`" },
	]);
	let model: InitAnswers["model"];
	if (modelChoice === "deepseek") {
		model = {
			provider: "deepseek",
			model: "deepseek-flash",
			deepseekApiKey: (await ui.password("DeepSeek API key", required)).trim(),
		};
	} else {
		const ref = (
			await ui.text("Model as provider/model", {
				placeholder: "provider/model",
				validate: (value) => (/^[^/\s]+\/\S+$/.test(value.trim()) ? undefined : 'Write it as "provider/model"'),
			})
		).trim();
		const slash = ref.indexOf("/");
		model = { provider: ref.slice(0, slash), model: ref.slice(slash + 1) };
		notes.push(`Sign in to ${model.provider}: bun run jingmei login ${model.provider}`);
	}

	const features = Object.fromEntries(FEATURE_NAMES.map((name) => [name, mode !== "minimal"])) as Record<
		FeatureName,
		boolean
	>;
	const answers: InitAnswers = {
		...(discord ? { discord } : {}),
		...(telegram ? { telegram } : {}),
		persona: { id, name, template },
		model,
		routingSecret: deps.randomSecret(),
		features,
	};

	if (mode === "custom") {
		for (const { name: feature, message } of CORE_FEATURES) features[feature] = await ui.confirm(message, true);
		const chosen = new Set(
			await ui.multiselect<AddOn>("Add-ons (only the ones you pick are configured)", [
				{ value: "voice", label: "Voice replies", hint: "Fish Audio key and voice id" },
				{ value: "imageGeneration", label: "Image generation", hint: "Antigravity sign-in, no key" },
				{ value: "kline", label: "Candlestick charts", hint: "Binance public data, no key" },
				{ value: "textImage", label: "Long replies as an image", hint: "needs CJK fonts, no key" },
				{ value: "jev", label: "Jev decisions", hint: "quick reactions, memory scoring" },
				...(features.history
					? [{ value: "events" as const, label: "Topic tracking (events)", hint: "needs Jev or a DeepSeek key" }]
					: []),
				{ value: "celebrations", label: "Holiday and birthday greetings" },
			]),
		);
		if (chosen.has("voice")) {
			ui.info("Voice: copy the voice id (32 hex characters) from the Fish Audio voice page.");
			answers.voice = {
				apiKey: (await ui.password("Fish Audio API key", required)).trim(),
				referenceId: (
					await ui.text("Fish Audio voice id", {
						validate: (value) => (FISH_REFERENCE_ID.test(value.trim()) ? undefined : "32 hexadecimal characters"),
					})
				).trim(),
			};
		}
		if (chosen.has("imageGeneration")) notes.push("Image generation: bun run jingmei login antigravity");
		if (chosen.has("kline")) answers.kline = true;
		if (chosen.has("textImage")) {
			answers.textImage = true;
			notes.push("Long replies as an image: install CJK fonts (Debian/Ubuntu: sudo apt install fonts-noto-cjk).");
		}
		if (chosen.has("jev")) {
			const key = (
				await ui.password(
					model.deepseekApiKey
						? "TypeSafe API key (leave empty to use the built-in wrapper with your DeepSeek key)"
						: "TypeSafe API key",
					(value) => (value.trim() || model.deepseekApiKey ? undefined : "Required without a DeepSeek key"),
				)
			).trim();
			answers.jev = key ? { apiKey: key } : {};
		}
		if (chosen.has("events")) {
			if (model.deepseekApiKey || answers.jev?.apiKey) {
				answers.events = {
					summaryModel: (
						await ui.text("Model that summarizes topics (provider/model)", {
							initial: `${model.provider}/${model.model}`,
							validate: (value) => (/^[^/\s]+\/\S+$/.test(value.trim()) ? undefined : 'Write it as "provider/model"'),
						})
					).trim(),
				};
			} else ui.warn("Topic tracking needs a Jev key or a DeepSeek key; skipping it.");
		}
		if (chosen.has("celebrations")) {
			answers.celebrations = {
				timeZone: (
					await ui.text("Time zone for greetings", { initial: deps.timeZone(), validate: validTimeZone })
				).trim(),
				calendar: await ui.select("Holiday calendar", [
					{ value: "china", label: "China" },
					{ value: "australia", label: "Australia" },
					{ value: "both", label: "Both" },
				]),
			};
		}
	}
	if (features.search && !model.deepseekApiKey)
		notes.push("Web search needs DEEPSEEK_API_KEY in .env (optional; or turn features.search off).");
	return { answers, notes };
}

/** The whole wizard. Returns the closing message; throws before writing anything if the answers do not validate. */
export async function runInit(rootDir: string, ui: InitUi, deps: InitDeps): Promise<string> {
	const existing = existingInstallFiles(rootDir);
	if (existing.length)
		throw new Error(
			`${existing.join(" and ")} already exists; init never overwrites. Move or delete it first, or run \`bun run jingmei doctor\` to check the current install.`,
		);
	const { answers, notes } = await collectAnswers(ui, deps, rootDir);
	const files = buildInitFiles(answers, rootDir);
	ui.info(
		[
			"Will create (secrets go only to .env, mode 0600):",
			`- ${CONFIG_FILE}`,
			`- ${ENV_FILE}`,
			`- personas/${answers.persona.id}.md`,
		].join("\n"),
	);
	if (!(await ui.confirm("Create these files?", true))) throw new Error("Cancelled; nothing was written");
	writeInstall(rootDir, files, answers.persona);
	const steps = [
		`Edit personas/${answers.persona.id}.md: identity, voice and boundaries`,
		...notes,
		"Check the install: bun run jingmei doctor",
		"Start: bun run start",
	];
	for (const [index, step] of steps.entries()) ui.raw(`${index + 1}. ${step}`);
	return "Created the config; add more personas or add-ons later, see the README";
}

function unwrap<T>(value: T): Exclude<T, symbol> {
	if (typeof value === "symbol") throw new Error("Cancelled");
	return value as Exclude<T, symbol>;
}

/** The terminal UI. */
export const clackUi: InitUi = {
	select: async <T extends string>(message: string, options: UiOption<T>[], initial?: T) =>
		unwrap(
			await p.select<T>({ message, options: options as p.Option<T>[], ...(initial ? { initialValue: initial } : {}) }),
		),
	text: async (message, options = {}) =>
		unwrap(
			await p.text({
				message,
				...(options.placeholder ? { placeholder: options.placeholder } : {}),
				...(options.initial ? { initialValue: options.initial } : {}),
				validate: (value) => options.validate?.(value ?? ""),
			}),
		),
	password: async (message, validate) =>
		unwrap(await p.password({ message, validate: (value) => validate?.(value ?? "") })),
	confirm: async (message, initial = true) => unwrap(await p.confirm({ message, initialValue: initial })),
	multiselect: async <T extends string>(message: string, options: UiOption<T>[], initial?: T[]) =>
		unwrap(
			await p.multiselect<T>({
				message,
				options: options as p.Option<T>[],
				required: false,
				...(initial ? { initialValues: initial } : {}),
			}),
		),
	info: (message) => p.log.info(message),
	warn: (message) => p.log.warn(message),
	// Links go to stdout unframed: clack wraps long lines behind its guide bar, which breaks copy and link detection.
	raw: (message) => void process.stdout.write(`${message}\n`),
};
