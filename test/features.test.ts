import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError, FEATURE_NAMES, type FeatureName, validateConfig } from "../src/config.ts";
import { BotState } from "../src/core/bot-state.ts";
import { Conversation } from "../src/core/conversation.ts";
import { MemberMemory } from "../src/core/memory.ts";
import { MessageIndex } from "../src/core/message-index.ts";
import { SoulStore } from "../src/core/soul.ts";
import type { InboundMessage, Persona, PlatformTransport, Route, SpaceId } from "../src/core/types.ts";
import type { JevClient } from "../src/decision/jev.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function baseInput(dir: string, extra: Record<string, unknown> = {}) {
	const personaPath = join(dir, "persona.md");
	writeFileSync(personaPath, "Friendly companion.");
	return {
		telegram: { chatIds: ["-100111"] },
		personas: [
			{
				id: "luna",
				name: "Luna",
				personaPath,
				provider: "deepseek",
				model: "deepseek-flash",
				routingP: 0.1,
				telegram: { tokenEnv: "LUNA_TOKEN" },
			},
		],
		...extra,
	};
}

const env = { ROUTING_SECRET: "secret", LUNA_TOKEN: "token", DEEPSEEK_API_KEY: "deepseek-key" };

function configErrors(input: unknown): string[] {
	try {
		validateConfig(input, "/", env);
	} catch (error) {
		if (error instanceof ConfigError) return [...error.errors];
		throw error;
	}
	return [];
}

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "jingmei-features-"));
	dirs.push(dir);
	return dir;
}

test("every feature defaults to on and each flag can be switched off alone", () => {
	const dir = tempDir();
	const defaults = { history: true, memory: true, soul: true, search: true, audit: true };
	expect(validateConfig(baseInput(dir), dir, env).features).toEqual(defaults);
	expect(validateConfig(baseInput(dir, { features: {} }), dir, env).features).toEqual(defaults);
	for (const name of FEATURE_NAMES) {
		const config = validateConfig(baseInput(dir, { features: { [name]: false } }), dir, env);
		expect(config.features).toEqual({ ...defaults, [name]: false });
	}
});

test("features reports unknown keys and non-booleans together", () => {
	const dir = tempDir();
	expect(configErrors(baseInput(dir, { features: { histroy: false, memory: "no", soul: 0 } }))).toEqual([
		expect.stringContaining("features.histroy"),
		"features.memory must be a boolean",
		"features.soul must be a boolean",
	]);
	expect(configErrors(baseInput(dir, { features: true }))).toEqual(["features must be an object"]);
});

test("topics need the history index", () => {
	const dir = tempDir();
	const events = { summaryModel: "deepseek/deepseek-flash" };
	expect(configErrors(baseInput(dir, { events }))).toEqual([]);
	expect(configErrors(baseInput(dir, { events, features: { history: false } }))).toEqual([
		expect.stringContaining("events requires features.history"),
	]);
});

test("a celebrations section works with memory off because /birthday still stores birthdays", () => {
	const dir = tempDir();
	const celebrations = [
		{ space: "telegram:-100111", personaId: "luna", timeZone: "Australia/Sydney", calendar: "both" },
	];
	expect(configErrors(baseInput(dir, { celebrations, features: { memory: false } }))).toEqual([]);
});

const model = {
	id: "fixture",
	name: "fixture",
	api: "openai-responses" as const,
	provider: "fixture",
	baseUrl: "http://unused",
	reasoning: false,
	input: ["text" as const],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 65536,
	maxTokens: 4096,
};
const runtime = {
	getModel: () => model,
	hasConfiguredAuth: () => true,
	getAuth: async () => ({ auth: { apiKey: "fixture" } }),
} as unknown as ModelRuntime;
const transport: PlatformTransport = {
	platform: "telegram",
	echoesOwnMessages: false,
	displayName: "Telegram",
	promptLines: [],
	quickReactions: {},
	sendMessage: async () => ({ id: "1" }),
	formatMention: (user) => `@${user.username}`,
	isValidReaction: () => true,
};
const space: SpaceId = "telegram:-100111";

function core(flags: Record<FeatureName, boolean>, jev?: { audit: boolean; client: JevClient }) {
	const dataDir = tempDir();
	const personaPath = join(dataDir, "persona.md");
	writeFileSync(personaPath, "Friendly companion.");
	const persona: Persona = {
		id: "luna",
		name: "Luna",
		personaPath,
		provider: model.provider,
		model: model.id,
		routingP: 0,
		aliases: [],
		adminUserIds: [],
		reasoningEffort: "off",
		sendReactionImages: true,
		voiceEnabled: false,
		imageGenerationEnabled: false,
		accounts: { telegram: { userId: "900", username: "luna_bot" } },
	};
	const db = new Database(":memory:");
	// The same mapping bot.ts applies from AppConfig.features to the core's dependencies.
	const conversation = new Conversation({
		db,
		botState: new BotState(db),
		dataDir,
		routingSecret: "secret",
		personas: [persona],
		transports: new Map([["telegram", transport]]),
		modelRuntime: runtime,
		...(flags.memory ? { memberMemory: new MemberMemory(db) } : {}),
		...(flags.soul ? { soulStore: new SoulStore({ db, personaIds: ["luna"] }) } : {}),
		...(flags.history ? { messageIndex: new MessageIndex({ db }) } : {}),
		...(flags.search ? { webSearchApiKey: "deepseek-key" } : {}),
		...(jev
			? {
					jev: {
						client: jev.client,
						quickReactions: false,
						memoryScoring: false,
						replyDecision: false,
						audit: jev.audit,
						replyThreshold: 0.7,
						threshold: 0.8,
						minIntervalMs: 60_000,
					},
				}
			: {}),
	});
	return { conversation, persona };
}

async function toolsAndPrompt(flags: Record<FeatureName, boolean>) {
	const { conversation, persona } = core(flags);
	const seam = conversation as unknown as {
		getSession(
			persona: Persona,
			spaceId: SpaceId,
			channelId: string,
		): Promise<import("@earendil-works/pi-coding-agent").AgentSession>;
	};
	const session = await seam.getSession(persona, space, "-100111");
	return { names: session.getActiveToolNames().sort(), prompt: session.systemPrompt };
}

const allOn = Object.fromEntries(FEATURE_NAMES.map((name) => [name, true])) as Record<FeatureName, boolean>;
const ALWAYS = ["run_js", "send_reply"];
const TOOLS_BY_FEATURE: Record<FeatureName, string[]> = {
	history: ["related_messages", "search_history"],
	memory: ["recall_member_memory", "remember_member_fact"],
	soul: ["update_soul"],
	search: ["search_web"],
	audit: [],
};

test("a session registers exactly the tools its features enable", async () => {
	const everything = Object.values(TOOLS_BY_FEATURE).flat();
	const all = await toolsAndPrompt(allOn);
	expect(all.names).toEqual([...ALWAYS, ...everything].sort());
	for (const name of ["history", "memory", "soul", "search"] as const) {
		const off = await toolsAndPrompt({ ...allOn, [name]: false });
		expect(off.names).toEqual(
			[...ALWAYS, ...everything.filter((tool) => !TOOLS_BY_FEATURE[name].includes(tool))].sort(),
		);
		// A disabled tool is never named in the system prompt.
		for (const tool of TOOLS_BY_FEATURE[name]) expect(off.prompt).not.toContain(tool);
		for (const tool of everything.filter((tool) => !TOOLS_BY_FEATURE[name].includes(tool)))
			if (all.prompt.includes(tool)) expect(off.prompt).toContain(tool);
	}
	const none = await toolsAndPrompt({ history: false, memory: false, soul: false, search: false, audit: false });
	expect(none.names).toEqual(ALWAYS);
	for (const tool of everything) expect(none.prompt).not.toContain(tool);
});

test("features.audit off skips the final-text audit but still blocks leaks", async () => {
	let audits = 0;
	const client = {
		auditNatural: async () => {
			audits++;
			return 0;
		},
	} as unknown as JevClient;
	const message = { content: "hi", platform: "telegram" } as InboundMessage;
	const route: Route = { personaId: "luna", reason: "directed" };
	const audit = (c: Conversation, reply: string) =>
		(
			c as unknown as {
				auditReply(reply: string, message: InboundMessage, route: Route, recent: string[]): Promise<string | null>;
			}
		).auditReply(reply, message, route, []);
	expect(await audit(core(allOn, { audit: true, client }).conversation, "hello")).toBe("audit");
	expect(audits).toBe(1);
	const off = core({ ...allOn, audit: false }, { audit: false, client }).conversation;
	expect(await audit(off, "hello")).toBeNull();
	expect(await audit(off, "§E3 leaked")).toBe("leak_pattern");
	expect(audits).toBe(1);
});
