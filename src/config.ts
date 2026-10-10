import {
	accessSync,
	constants,
	existsSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { DEFAULT_EMBEDDING_MODEL, isSupportedEmbeddingModel } from "./core/embedding-models.ts";
import { JEV_ENDPOINT } from "./decision/jev.ts";
import { TEXT_IMAGE_MAX_CHARS } from "./media/text-image.ts";
import { DEFAULT_IMAGE_MODEL } from "./tools/antigravity-image.ts";
import {
	BUILTIN_REACTION_IMAGE_IDS,
	type Persona,
	type Platform,
	type ReactionImageCatalog,
	type SpaceId,
} from "./core/types.ts";

const CONFIG_FILE = "jingmei.config.json";

export type ConfiguredPersona = Omit<Persona, "accounts"> & {
	/** Resolved secret bot tokens; never log. */
	tokens: Partial<Record<Platform, string>>;
};

export interface CelebrationTarget {
	spaceId: SpaceId;
	channelId: string;
	personaId: string;
	timeZone: string;
	calendar: "china" | "australia" | "both";
}

export interface JevSettings {
	endpoint: string;
	apiKey?: string;
	model: string;
	quickReactions: boolean;
	memoryScoring: boolean;
	replyDecision: boolean;
	replyThreshold: number;
	threshold: number;
	minIntervalMs: number;
	/** Overrides of the platform default quick-reaction tables (emoji → meaning). */
	emojis?: Partial<Record<Platform, Record<string, string>>>;
}

export const FEATURE_NAMES = ["history", "memory", "soul", "search", "audit"] as const;
export type FeatureName = (typeof FEATURE_NAMES)[number];
/** Install-time switches for optional capabilities; all default to on. */
export type Features = Record<FeatureName, boolean>;

export interface AppConfig {
	rootDir: string;
	dataDir: string;
	routingSecret: string;
	discord?: { guilds: Array<{ guildId: string; channelIds: string[] }> };
	/** Telegram group chat ids like "-1001234567890". */
	telegram?: { chatIds: string[] };
	voice?: { apiKey: string; referenceId: string; model: "s2.1-pro-free" | "s2.1-pro" };
	/** Antigravity image model for `send_reply` image parts; they exist only when that provider is signed in. */
	imageModel: string;
	/** Present when `textImage.enabled`: text replies over `thresholdChars` must be sent as a rendered image. */
	textImage?: { thresholdChars: number };
	/** Present when `kline.enabled`: personas may send live Binance candlestick charts. */
	kline?: Record<string, never>;
	features: Features;
	/** DEEPSEEK_API_KEY: server-side web search (unless `features.search` is off) and the default model's credential. */
	webSearchApiKey?: string;
	/** Optional image describer for personas whose main model is text-only. */
	visionModel?: { provider: string; model: string };
	jev?: JevSettings;
	/** In-process Jev wrapper over an OpenAI-compatible LLM with logprobs. */
	localJev?: { baseUrl: string; model: string; apiKey?: string };
	events?: { summaryModel: { provider: string; model: string }; embeddingModel: string };
	celebrations: CelebrationTarget[];
	personas: ConfiguredPersona[];
}

/** All validation problems of one load, listed together. Messages never contain secret values. */
export class ConfigError extends Error {
	constructor(public readonly errors: readonly string[]) {
		super(`invalid configuration:\n${errors.map((error) => `- ${error}`).join("\n")}`);
		this.name = "ConfigError";
	}
}

const PLATFORMS: readonly Platform[] = ["discord", "telegram"];
const THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PERSONA_ID = /^[a-z0-9_-]+$/;
const DISCORD_ID = /^\d{17,20}$/;
const TELEGRAM_CHAT_ID = /^-?\d+$/;
const TELEGRAM_USER_ID = /^\d+$/;
const FISH_REFERENCE_ID = /^[0-9a-f]{32}$/i;
const DEFAULT_ROUTING_SECRET_ENV = "ROUTING_SECRET";
const DEFAULT_JEV_MODEL = "jev-latest";
const DEFAULT_JEV_THRESHOLD = 0.8;
const DEFAULT_JEV_MIN_INTERVAL_MS = 60_000;
const DEFAULT_TEXT_IMAGE_THRESHOLD = 300;

/**
 * Parse this project's `key: value` secret format (not dotenv `KEY=value`).
 * Errors name the line only; values are never echoed. Missing file → `{}`.
 */
export function parseEnvFile(path: string): Record<string, string> {
	if (!existsSync(path)) return {};
	const env: Record<string, string> = {};
	for (const [index, raw] of readFileSync(path, "utf8").split(/\r?\n/).entries()) {
		const line = raw.trim();
		if (!line || line.startsWith("#")) continue;
		const colon = line.indexOf(":");
		if (colon <= 0) throw new ConfigError([`Invalid .env syntax at line ${index + 1}; expected key: value`]);
		const key = line.slice(0, colon).trim();
		if (!ENV_NAME.test(key)) throw new ConfigError([`Invalid .env key at line ${index + 1}`]);
		env[key] = line.slice(colon + 1).trim();
	}
	return env;
}

/** `.env` values overridden by `process.env`. */
function loadEnv(rootDir: string): Record<string, string> {
	const env = parseEnvFile(join(rootDir, ".env"));
	for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
	return env;
}

function readConfigFile(rootDir: string): unknown {
	const configPath = join(rootDir, CONFIG_FILE);
	if (!existsSync(configPath)) {
		throw new ConfigError([`Missing ${configPath}; copy jingmei.config.example.json`]);
	}
	try {
		return JSON.parse(readFileSync(configPath, "utf8"));
	} catch (error) {
		throw new ConfigError([`${CONFIG_FILE} is not valid JSON: ${(error as Error).message}`]);
	}
}

export function loadConfig(rootDir = process.cwd()): AppConfig {
	return validateConfig(readConfigFile(rootDir), rootDir, loadEnv(rootDir));
}

/** Pi's agent directory (`models.json`, `auth.json`) under the data dir. */
export function piAgentDir(dataDir: string): string {
	return join(dataDir, "pi-agent");
}

export interface OperatorConfig {
	dataDir: string;
	/** Configured chat models by persona, in config order; entries without all three strings are skipped. */
	personas: Array<{ id: string; provider: string; model: string }>;
}

/** Resolve only what operator commands need, so they work before bot tokens and secrets exist. */
export function loadOperatorConfig(rootDir = process.cwd()): OperatorConfig {
	const input = readConfigFile(rootDir);
	if (!isObject(input)) throw new ConfigError([`${CONFIG_FILE} must be a JSON object`]);
	const dataDir = resolveDataDir(input, rootDir);
	if (!dataDir) throw new ConfigError(["dataDir must be a nonempty string"]);
	const personas = (Array.isArray(input.personas) ? input.personas : []).flatMap((entry) =>
		isObject(entry) && nonEmptyString(entry.id) && nonEmptyString(entry.provider) && nonEmptyString(entry.model)
			? [{ id: entry.id.trim(), provider: entry.provider.trim(), model: entry.model.trim() }]
			: [],
	);
	return { dataDir, personas };
}

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function resolvePath(rootDir: string, path: string): string {
	if (isAbsolute(path)) return resolve(path);
	if (path.startsWith("~/")) return join(homedir(), path.slice(2));
	return resolve(rootDir, path);
}

function readReactionImages(
	value: unknown,
	rootDir: string,
	field: string,
	errors: string[],
): ReactionImageCatalog | undefined {
	if (value === undefined) return undefined;
	if (!nonEmptyString(value)) {
		errors.push(`${field} must be a nonempty directory path`);
		return undefined;
	}
	const directory = resolvePath(rootDir, value);
	let realDirectory: string;
	let catalog: unknown;
	try {
		realDirectory = realpathSync(directory);
		catalog = JSON.parse(readFileSync(join(directory, "catalog.json"), "utf8"));
	} catch {
		errors.push(`${field} must contain a readable, valid catalog.json`);
		return undefined;
	}
	if (!isObject(catalog)) {
		errors.push(`${field}.catalog.json must be an object`);
		return undefined;
	}
	const images: Record<string, ReactionImageCatalog[string]> = Object.create(null);
	for (const [id, entry] of Object.entries(catalog)) {
		const entryField = `${field}.catalog.${id}`;
		const before = errors.length;
		if (!/^[a-z0-9_]+$/.test(id)) errors.push(`${entryField} id must match [a-z0-9_]+`);
		if (BUILTIN_REACTION_IMAGE_IDS.some((builtin) => builtin === id))
			errors.push(`${entryField} duplicates a built-in reaction image id`);
		if (!isObject(entry)) {
			errors.push(`${entryField} must be an object`);
			continue;
		}
		for (const key of ["caption", "name"] as const)
			if (typeof entry[key] !== "string") errors.push(`${entryField}.${key} must be a string`);
		if (!nonEmptyString(entry.file)) {
			errors.push(`${entryField}.file must be a nonempty relative path`);
			continue;
		}
		const parts = entry.file.split("/");
		if (isAbsolute(entry.file) || entry.file.includes("\\") || parts.includes("..")) {
			errors.push(`${entryField}.file must stay inside the catalog directory`);
			continue;
		}
		// Existing feiba catalogs prefix files with "feiba/"; strip only this exact directory name.
		const file = parts[0] === basename(directory) ? parts.slice(1).join("/") : entry.file;
		const path = resolve(directory, file);
		const extension = extname(path).toLowerCase();
		if (![".png", ".jpg", ".jpeg"].includes(extension)) errors.push(`${entryField}.file must be PNG or JPEG`);
		try {
			const within = relative(realDirectory, realpathSync(path));
			if (within === ".." || within.startsWith(`..${sep}`) || isAbsolute(within))
				errors.push(`${entryField}.file must stay inside the catalog directory`);
			accessSync(path, constants.R_OK);
			if (!statSync(path).isFile()) errors.push(`${entryField}.file must be a readable file`);
		} catch {
			errors.push(`${entryField}.file is missing or unreadable`);
		}
		if (errors.length === before)
			images[id] = {
				path,
				caption: entry.caption as string,
				name: entry.name as string,
				contentType: extension === ".png" ? "image/png" : "image/jpeg",
			};
	}
	return images;
}

/** Undefined when `dataDir` is present but invalid. */
function resolveDataDir(input: Json, rootDir: string): string | undefined {
	if (input.dataDir === undefined) return resolve(rootDir, "data");
	return nonEmptyString(input.dataDir) ? resolvePath(rootDir, input.dataDir) : undefined;
}

function parseSpace(value: unknown): { platform: Platform; rawId: string } | null {
	if (typeof value !== "string") return null;
	const colon = value.indexOf(":");
	if (colon <= 0) return null;
	const platform = value.slice(0, colon);
	if (platform !== "discord" && platform !== "telegram") return null;
	return { platform, rawId: value.slice(colon + 1) };
}

/** Validate parsed JSON against resolved env. Collects every problem, then throws one ConfigError. */
export function validateConfig(input: unknown, rootDir: string, env: Readonly<Record<string, string>>): AppConfig {
	const errors: string[] = [];
	if (!isObject(input)) throw new ConfigError([`${CONFIG_FILE} must be a JSON object`]);

	const secret = (field: string, envName: unknown): string | undefined => {
		if (typeof envName !== "string" || !ENV_NAME.test(envName)) {
			errors.push(`${field} must name an environment variable`);
			return undefined;
		}
		const value = env[envName];
		if (!value) {
			errors.push(`Missing environment variable ${envName} (${field})`);
			return undefined;
		}
		return value;
	};

	const dataDir = resolveDataDir(input, rootDir) ?? "";
	if (!dataDir) errors.push("dataDir must be a nonempty string");
	const routingSecret = secret("routingSecretEnv", input.routingSecretEnv ?? DEFAULT_ROUTING_SECRET_ENV) ?? "";

	const modelSelection = (field: string, value: unknown): { provider: string; model: string } | undefined => {
		const ref = typeof value === "string" ? value.trim() : "";
		const slash = ref.indexOf("/");
		const provider = ref.slice(0, slash).trim();
		const model = ref.slice(slash + 1).trim();
		if (slash <= 0 || !provider || !model) errors.push(`${field} must be a "provider/model" string`);
		else return { provider, model };
	};
	const httpUrl = (field: string, value: unknown): string | undefined => {
		// Report only the field name; a malformed URL may contain credentials.
		if (typeof value === "string" && URL.canParse(value) && /^https?:$/.test(new URL(value).protocol)) return value;
		errors.push(`${field} must be an http(s) URL`);
		return undefined;
	};
	const visionModel = input.visionModel === undefined ? undefined : modelSelection("visionModel", input.visionModel);

	// Platform sections and the configured space set.
	const spaces = new Set<SpaceId>();
	let discord: AppConfig["discord"];
	if (input.discord !== undefined) {
		if (!isObject(input.discord) || !Array.isArray(input.discord.guilds) || input.discord.guilds.length === 0) {
			errors.push("discord.guilds must contain at least one guild");
		} else {
			const guilds: Array<{ guildId: string; channelIds: string[] }> = [];
			for (const [index, entry] of input.discord.guilds.entries()) {
				const field = `discord.guilds[${index}]`;
				if (!isObject(entry)) {
					errors.push(`${field} must be an object`);
					continue;
				}
				const guildId = entry.guildId;
				if (typeof guildId !== "string" || !DISCORD_ID.test(guildId)) {
					errors.push(`${field}.guildId must be a 17-20 digit Discord id string`);
					continue;
				}
				if (spaces.has(`discord:${guildId}`)) errors.push(`Duplicate Discord guild id: ${guildId}`);
				spaces.add(`discord:${guildId}`);
				const channelIds = entry.channelIds;
				if (
					!Array.isArray(channelIds) ||
					channelIds.length === 0 ||
					channelIds.some((id) => typeof id !== "string" || !DISCORD_ID.test(id))
				) {
					errors.push(`${field}.channelIds must be a nonempty array of 17-20 digit Discord id strings`);
					continue;
				}
				guilds.push({ guildId, channelIds: [...new Set(channelIds as string[])] });
			}
			discord = { guilds };
		}
	}
	let telegram: AppConfig["telegram"];
	if (input.telegram !== undefined) {
		const chatIds = isObject(input.telegram) ? input.telegram.chatIds : undefined;
		if (!Array.isArray(chatIds) || chatIds.length === 0) {
			errors.push("telegram.chatIds must contain at least one chat id");
		} else {
			const valid: string[] = [];
			for (const [index, id] of chatIds.entries()) {
				if (typeof id !== "string" || !TELEGRAM_CHAT_ID.test(id)) {
					errors.push(`telegram.chatIds[${index}] must be a Telegram chat id string like "-1001234567890"`);
					continue;
				}
				if (spaces.has(`telegram:${id}`)) errors.push(`Duplicate Telegram chat id: ${id}`);
				else valid.push(id);
				spaces.add(`telegram:${id}`);
			}
			telegram = { chatIds: valid };
		}
	}
	const sectionPresent: Record<Platform, boolean> = {
		discord: input.discord !== undefined,
		telegram: input.telegram !== undefined,
	};

	// Personas.
	const personas: ConfiguredPersona[] = [];
	if (!Array.isArray(input.personas) || input.personas.length === 0) {
		errors.push("personas must contain at least one persona");
	} else {
		const seenIds = new Set<string>();
		for (const [index, entry] of input.personas.entries()) {
			const field = `personas[${index}]`;
			if (!isObject(entry)) {
				errors.push(`${field} must be an object`);
				continue;
			}
			const before = errors.length;
			const id = entry.id;
			if (typeof id !== "string" || !PERSONA_ID.test(id)) errors.push(`${field}.id must match [a-z0-9_-]+`);
			else if (seenIds.has(id)) errors.push(`Duplicate persona id: ${id}`);
			else seenIds.add(id);
			for (const key of ["name", "personaPath", "provider", "model"] as const)
				if (!nonEmptyString(entry[key])) errors.push(`${field}.${key} is required`);
			let personaPath = "";
			if (nonEmptyString(entry.personaPath)) {
				personaPath = resolvePath(rootDir, entry.personaPath);
				try {
					accessSync(personaPath, constants.R_OK);
				} catch {
					errors.push(`${field}.personaPath is not readable: ${personaPath}`);
				}
			}
			const reactionImages = readReactionImages(entry.reactionImages, rootDir, `${field}.reactionImages`, errors);
			const reasoningEffort = entry.reasoningEffort ?? "off";
			if (!THINKING_LEVELS.includes(reasoningEffort as ThinkingLevel))
				errors.push(`${field}.reasoningEffort must be one of ${THINKING_LEVELS.join(", ")}`);
			const routingP = entry.routingP;
			if (typeof routingP !== "number" || !Number.isFinite(routingP) || routingP < 0 || routingP > 1)
				errors.push(`${field}.routingP must be a number between 0 and 1`);
			for (const key of ["sendReactionImages", "voiceEnabled", "imageGenerationEnabled"] as const)
				if (entry[key] !== undefined && typeof entry[key] !== "boolean")
					errors.push(`${field}.${key} must be a boolean`);
			let aliases: string[] = [];
			if (entry.aliases !== undefined) {
				if (
					!Array.isArray(entry.aliases) ||
					entry.aliases.some((alias) => !nonEmptyString(alias) || alias.trim().length > 64)
				)
					errors.push(`${field}.aliases must be nonempty strings up to 64 characters`);
				else aliases = [...new Set((entry.aliases as string[]).map((alias) => alias.trim()))];
			}
			const tokens: Partial<Record<Platform, string>> = {};
			const adminUserIds: string[] = [];
			for (const platform of PLATFORMS) {
				const account = entry[platform];
				if (account === undefined) continue;
				const accountField = `${field}.${platform}`;
				if (!isObject(account)) {
					errors.push(`${accountField} must be an object`);
					continue;
				}
				if (!sectionPresent[platform])
					errors.push(`${accountField} is set but the top-level ${platform} section is missing`);
				const token = secret(`${accountField}.tokenEnv`, account.tokenEnv);
				if (token) tokens[platform] = token;
				if (account.adminUserIds !== undefined) {
					const pattern = platform === "discord" ? DISCORD_ID : TELEGRAM_USER_ID;
					if (
						!Array.isArray(account.adminUserIds) ||
						account.adminUserIds.some((userId) => typeof userId !== "string" || !pattern.test(userId))
					)
						errors.push(
							`${accountField}.adminUserIds must be ${platform === "discord" ? "17-20 digit Discord" : "numeric Telegram"} user id strings`,
						);
					else for (const userId of account.adminUserIds as string[]) adminUserIds.push(`${platform}:${userId}`);
				}
			}
			const platforms = PLATFORMS.filter((platform) => entry[platform] !== undefined);
			if (platforms.length === 0) errors.push(`${field} must have a discord or telegram account`);
			let personaSpaces: SpaceId[] | undefined;
			if (entry.spaces !== undefined) {
				if (!Array.isArray(entry.spaces) || entry.spaces.length === 0) {
					errors.push(`${field}.spaces must be a nonempty array when set`);
				} else {
					personaSpaces = [];
					for (const space of entry.spaces) {
						const parsed = parseSpace(space);
						if (!parsed || !spaces.has(space as SpaceId)) {
							errors.push(`${field}.spaces entry ${JSON.stringify(space)} is not a configured space`);
							continue;
						}
						if (!platforms.includes(parsed.platform))
							errors.push(`${field}.spaces entry ${space} needs a ${parsed.platform} account on this persona`);
						personaSpaces.push(space as SpaceId);
					}
					personaSpaces = [...new Set(personaSpaces)];
				}
			}
			if (errors.length !== before) continue;
			personas.push({
				id: id as string,
				name: (entry.name as string).trim(),
				personaPath,
				provider: (entry.provider as string).trim(),
				model: (entry.model as string).trim(),
				reasoningEffort: reasoningEffort as ThinkingLevel,
				routingP: routingP as number,
				aliases,
				...(personaSpaces ? { spaces: personaSpaces } : {}),
				adminUserIds: [...new Set(adminUserIds)],
				sendReactionImages: entry.sendReactionImages !== false,
				...(reactionImages ? { reactionImages } : {}),
				voiceEnabled: entry.voiceEnabled !== false,
				imageGenerationEnabled: entry.imageGenerationEnabled !== false,
				tokens,
			});
		}
	}
	for (const platform of PLATFORMS)
		if (
			sectionPresent[platform] &&
			Array.isArray(input.personas) &&
			!input.personas.some((entry) => isObject(entry) && entry[platform] !== undefined)
		)
			errors.push(`${platform} section is configured but no persona has a ${platform} account`);

	// Cumulative routing probability per space, counting personas that can speak there.
	for (const space of spaces) {
		const platform = parseSpace(space)?.platform as Platform;
		const total = personas
			.filter((persona) => persona.tokens[platform] && (!persona.spaces || persona.spaces.includes(space)))
			.reduce((sum, persona) => sum + persona.routingP, 0);
		if (total > 1 + 1e-9) errors.push(`routingP of personas in ${space} sums to ${total}; must not exceed 1`);
	}

	// Celebrations.
	const celebrations: CelebrationTarget[] = [];
	if (input.celebrations !== undefined) {
		if (!Array.isArray(input.celebrations)) errors.push("celebrations must be an array");
		else {
			const seenTargets = new Set<string>();
			for (const [index, entry] of input.celebrations.entries()) {
				const field = `celebrations[${index}]`;
				if (!isObject(entry)) {
					errors.push(`${field} must be an object`);
					continue;
				}
				const before = errors.length;
				const space = parseSpace(entry.space);
				let channelId = typeof entry.channelId === "string" ? entry.channelId : "";
				if (!space || !spaces.has(entry.space as SpaceId)) {
					errors.push(`${field}.space must be a configured "discord:<guild>" or "telegram:<chat>" space`);
				} else if (space.platform === "discord") {
					const guild = discord?.guilds.find((candidate) => candidate.guildId === space.rawId);
					if (!guild?.channelIds.includes(channelId))
						errors.push(`${field}.channelId must be an allowed channel of ${entry.space}`);
				} else {
					if (entry.channelId === undefined) channelId = space.rawId;
					else if (channelId !== space.rawId) errors.push(`${field}.channelId must equal the Telegram chat id`);
				}
				const persona = personas.find((candidate) => candidate.id === entry.personaId);
				if (!persona) errors.push(`${field}.personaId must name a configured persona`);
				else if (
					space &&
					(!persona.tokens[space.platform] || (persona.spaces && !persona.spaces.includes(entry.space as SpaceId)))
				)
					errors.push(`${field}.personaId ${persona.id} cannot speak in ${entry.space}`);
				let timeZoneValid = typeof entry.timeZone === "string";
				if (timeZoneValid) {
					try {
						new Intl.DateTimeFormat("en", { timeZone: entry.timeZone as string });
					} catch {
						timeZoneValid = false;
					}
				}
				if (!timeZoneValid) errors.push(`${field}.timeZone must be an IANA time zone`);
				if (entry.calendar !== "china" && entry.calendar !== "australia" && entry.calendar !== "both")
					errors.push(`${field}.calendar must be china, australia, or both`);
				if (errors.length !== before) continue;
				const key = `${entry.space}:${channelId}`;
				if (seenTargets.has(key)) {
					errors.push(`Duplicate celebration target: ${key}`);
					continue;
				}
				seenTargets.add(key);
				celebrations.push({
					spaceId: entry.space as SpaceId,
					channelId,
					personaId: entry.personaId as string,
					timeZone: entry.timeZone as string,
					calendar: entry.calendar as CelebrationTarget["calendar"],
				});
			}
		}
	}

	// Voice.
	let voice: AppConfig["voice"];
	if (input.voice !== undefined) {
		if (!isObject(input.voice)) errors.push("voice must be an object");
		else {
			const apiKey = secret("voice.apiKeyEnv", input.voice.apiKeyEnv);
			const referenceId = input.voice.referenceId;
			if (typeof referenceId !== "string" || !FISH_REFERENCE_ID.test(referenceId))
				errors.push("voice.referenceId must be a 32-character Fish Audio voice id");
			const model = input.voice.model ?? "s2.1-pro-free";
			if (model !== "s2.1-pro-free" && model !== "s2.1-pro")
				errors.push("voice.model must be s2.1-pro-free or s2.1-pro");
			if (apiKey && typeof referenceId === "string")
				voice = { apiKey, referenceId, model: model as "s2.1-pro-free" | "s2.1-pro" };
		}
	}

	let imageModel = DEFAULT_IMAGE_MODEL;
	if (input.imageGeneration !== undefined) {
		if (!isObject(input.imageGeneration)) errors.push("imageGeneration must be an object");
		else if (input.imageGeneration.model !== undefined) {
			if (!nonEmptyString(input.imageGeneration.model)) errors.push("imageGeneration.model must be a nonempty string");
			else imageModel = input.imageGeneration.model.trim();
		}
	}

	let textImage: AppConfig["textImage"];
	if (input.textImage !== undefined) {
		if (!isObject(input.textImage)) errors.push("textImage must be an object");
		else {
			const { enabled, thresholdChars = DEFAULT_TEXT_IMAGE_THRESHOLD } = input.textImage;
			if (enabled !== undefined && typeof enabled !== "boolean") errors.push("textImage.enabled must be a boolean");
			if (
				typeof thresholdChars !== "number" ||
				!Number.isInteger(thresholdChars) ||
				thresholdChars < 50 ||
				thresholdChars > TEXT_IMAGE_MAX_CHARS
			)
				errors.push(`textImage.thresholdChars must be an integer from 50 to ${TEXT_IMAGE_MAX_CHARS}`);
			else if (enabled === true) textImage = { thresholdChars };
		}
	}

	let kline: AppConfig["kline"];
	if (input.kline !== undefined) {
		if (!isObject(input.kline)) errors.push("kline must be an object");
		else if (input.kline.enabled !== undefined && typeof input.kline.enabled !== "boolean")
			errors.push("kline.enabled must be a boolean");
		else if (input.kline.enabled === true) kline = {};
	}

	const features = Object.fromEntries(FEATURE_NAMES.map((name) => [name, true])) as Features;
	if (input.features !== undefined) {
		if (!isObject(input.features)) errors.push("features must be an object");
		else
			for (const [name, value] of Object.entries(input.features)) {
				if (!(FEATURE_NAMES as readonly string[]).includes(name))
					errors.push(`features.${name} is not a feature; expected ${FEATURE_NAMES.join(", ")}`);
				else if (typeof value !== "boolean") errors.push(`features.${name} must be a boolean`);
				else features[name as FeatureName] = value;
			}
	}

	const webSearchApiKey = env.DEEPSEEK_API_KEY || undefined;
	let localJev: AppConfig["localJev"];
	if (input.localJev !== undefined) {
		if (!isObject(input.localJev)) errors.push("localJev must be an object");
		else {
			const baseUrl = httpUrl("localJev.baseUrl", input.localJev.baseUrl);
			const model = input.localJev.model;
			if (!nonEmptyString(model)) errors.push("localJev.model must be a nonempty string");
			const apiKey =
				input.localJev.apiKeyEnv === undefined ? undefined : secret("localJev.apiKeyEnv", input.localJev.apiKeyEnv);
			if (baseUrl && nonEmptyString(model)) localJev = { baseUrl, model: model.trim(), ...(apiKey ? { apiKey } : {}) };
		}
	} else if (webSearchApiKey) {
		localJev = { baseUrl: "https://api.deepseek.com", model: "deepseek-flash", apiKey: webSearchApiKey };
	}

	// Jev decision model.
	let jev: JevSettings | undefined;
	if (input.jev !== undefined) {
		if (!isObject(input.jev)) errors.push("jev must be an object");
		else {
			const value = input.jev;
			const apiKey = value.apiKeyEnv === undefined ? undefined : secret("jev.apiKeyEnv", value.apiKeyEnv);
			const endpoint = httpUrl("jev.endpoint", value.endpoint === undefined ? JEV_ENDPOINT : value.endpoint);
			const model = value.model ?? DEFAULT_JEV_MODEL;
			if (!nonEmptyString(model)) errors.push("jev.model must be a nonempty string");
			for (const key of ["quickReactions", "memoryScoring", "replyDecision"] as const)
				if (value[key] !== undefined && typeof value[key] !== "boolean") errors.push(`jev.${key} must be a boolean`);
			const threshold = value.threshold ?? DEFAULT_JEV_THRESHOLD;
			if (typeof threshold !== "number" || !(threshold > 0 && threshold <= 1))
				errors.push("jev.threshold must be in (0, 1]");
			const replyThreshold = value.replyThreshold === undefined ? 0.7 : value.replyThreshold;
			if (typeof replyThreshold !== "number" || !(replyThreshold > 0 && replyThreshold <= 1))
				errors.push("jev.replyThreshold must be in (0, 1]");
			const minIntervalMs = value.minIntervalMs ?? DEFAULT_JEV_MIN_INTERVAL_MS;
			if (typeof minIntervalMs !== "number" || !Number.isFinite(minIntervalMs) || minIntervalMs < 0)
				errors.push("jev.minIntervalMs must be a number >= 0");
			let emojis: JevSettings["emojis"];
			if (value.emojis !== undefined) {
				if (!isObject(value.emojis)) errors.push("jev.emojis must be an object keyed by platform");
				else {
					emojis = {};
					for (const [platform, table] of Object.entries(value.emojis)) {
						if (platform !== "discord" && platform !== "telegram") {
							errors.push(`jev.emojis.${platform} is not a platform`);
							continue;
						}
						if (
							!isObject(table) ||
							Object.keys(table).length === 0 ||
							Object.entries(table).some(([emoji, meaning]) => !emoji.trim() || !nonEmptyString(meaning))
						) {
							errors.push(`jev.emojis.${platform} must be a nonempty emoji → meaning table`);
							continue;
						}
						if ("none" in table) errors.push(`jev.emojis.${platform} must not use the reserved key "none"`);
						emojis[platform] = { ...(table as Record<string, string>) };
					}
				}
			}
			if (apiKey || localJev)
				jev = {
					endpoint: endpoint ?? JEV_ENDPOINT,
					...(apiKey ? { apiKey } : {}),
					model: String(model).trim(),
					quickReactions: value.quickReactions !== false,
					memoryScoring: value.memoryScoring !== false,
					replyDecision: value.replyDecision !== false,
					replyThreshold: replyThreshold as number,
					threshold: threshold as number,
					minIntervalMs: minIntervalMs as number,
					...(emojis ? { emojis } : {}),
				};
			else if (value.apiKeyEnv === undefined)
				errors.push("jev needs apiKeyEnv, or a localJev section / DEEPSEEK_API_KEY for local decisions");
		}
	}
	let events: AppConfig["events"];
	if (input.events !== undefined) {
		if (!isObject(input.events)) errors.push("events must be an object");
		else {
			const summaryModel = modelSelection("events.summaryModel", input.events.summaryModel);
			const embeddingModel =
				input.events.embeddingModel === undefined ? DEFAULT_EMBEDDING_MODEL : input.events.embeddingModel;
			if (typeof embeddingModel !== "string" || !isSupportedEmbeddingModel(embeddingModel))
				errors.push("events.embeddingModel must be a supported fastembed model");
			if (summaryModel && typeof embeddingModel === "string") events = { summaryModel, embeddingModel };
		}
		if (!jev?.apiKey && !localJev) errors.push("events requires a Jev API key or a localJev LLM");
		if (!features.history) errors.push("events requires features.history, which supplies the embedding index");
	}

	if (errors.length > 0) throw new ConfigError(errors);
	return {
		rootDir,
		dataDir,
		routingSecret,
		...(discord ? { discord } : {}),
		...(telegram ? { telegram } : {}),
		...(voice ? { voice } : {}),
		features,
		imageModel,
		...(textImage ? { textImage } : {}),
		...(kline ? { kline } : {}),
		...(webSearchApiKey ? { webSearchApiKey } : {}),
		...(visionModel ? { visionModel } : {}),
		...(jev ? { jev } : {}),
		...(localJev ? { localJev } : {}),
		...(events ? { events } : {}),
		celebrations,
		personas,
	};
}

/** Create only a non-secret Pi model catalog. Credentials stay in the process environment. */
export function ensureDeepSeekModelsFile(agentDir: string): string {
	const modelsPath = join(agentDir, "models.json");
	if (!existsSync(modelsPath)) {
		mkdirSync(dirname(modelsPath), { recursive: true });
		const catalog = {
			providers: {
				deepseek: {
					baseUrl: "https://api.deepseek.com",
					api: "openai-completions",
					apiKey: "$DEEPSEEK_API_KEY",
					models: [
						{
							id: "deepseek-flash",
							name: "DeepSeek V4.1 Flash",
							reasoning: true,
							input: ["text", "image"],
							contextWindow: 65_536,
							maxTokens: 8_192,
							// USD per million tokens; documented as an estimate because provider pricing can change.
							cost: { input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0.3 },
						},
					],
				},
			},
		};
		writeFileSync(modelsPath, `${JSON.stringify(catalog, null, 2)}\n`, { mode: 0o600, flag: "wx" });
	}
	return modelsPath;
}
