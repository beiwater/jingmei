import { type AssistantMessage, createAssistantMessageEventStream, type Model } from "@earendil-works/pi-ai";
import type { AgentSession, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BotState } from "../src/core/bot-state.ts";
import { Conversation } from "../src/core/conversation.ts";
import { MemberMemory } from "../src/core/memory.ts";
import { SoulStore } from "../src/core/soul.ts";
import type { Persona, PlatformTransport, SpaceId } from "../src/core/types.ts";

type SessionSeam = { getSession(persona: Persona, spaceId: SpaceId, channelId: string): Promise<AgentSession> };

const SPACE: SpaceId = "discord:111";
const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});

const model = (provider: string, id: string): Model<"openai-responses"> => ({
	id,
	name: id,
	api: "openai-responses",
	provider,
	baseUrl: "http://unused",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 65536,
	maxTokens: 4096,
});

test("/model switches live sessions, survives restart, rejects bad refs and resets to the configured model", async () => {
	const models = [model("fixture", "alpha"), model("fixture", "beta"), model("locked", "gamma")];
	const authed = (provider: string) => provider === "fixture";
	const runtime = {
		getModel: (provider: string, id: string) => models.find((m) => m.provider === provider && m.id === id),
		hasConfiguredAuth: authed,
		checkAuth: async (provider: string) => (authed(provider) ? { ok: true } : undefined),
		getAvailable: async () => models.filter((m) => authed(m.provider)),
		getAuth: async () => ({ auth: { apiKey: "fixture" } }),
	} as unknown as ModelRuntime;
	const dataDir = mkdtempSync(join(tmpdir(), "jingmei-model-"));
	const db = new Database(join(dataDir, "test.db"));
	cleanups.push(() => {
		db.close();
		rmSync(dataDir, { recursive: true, force: true });
	});
	const personaPath = join(dataDir, "persona.md");
	writeFileSync(personaPath, "Friendly companion.");
	const persona: Persona = {
		id: "luna",
		name: "luna",
		personaPath,
		provider: "fixture",
		model: "alpha",
		routingP: 0,
		aliases: [],
		adminUserIds: ["discord:5"],
		reasoningEffort: "off",
		sendReactionImages: false,
		voiceEnabled: false,
		accounts: { discord: { userId: "900", username: "luna" } },
	};
	const transport: PlatformTransport = {
		platform: "discord",
		displayName: "discord",
		promptLines: [],
		quickReactions: {},
		sendMessage: async () => ({ id: "1" }),
		formatMention: (user) => `@${user.username}`,
		isValidReaction: () => true,
	};
	const used: string[] = [];
	let messageId = 10;
	const start = async () => {
		const core = new Conversation({
			db,
			botState: new BotState(db),
			memberMemory: new MemberMemory(db),
			soulStore: new SoulStore({ db, personaIds: [persona.id] }),
			dataDir,
			routingSecret: "fixture",
			personas: [persona],
			modelRuntime: runtime,
			transports: new Map([["discord", transport]]),
		});
		const session = await (core as unknown as SessionSeam).getSession(persona, SPACE, "222");
		session.agent.streamFunction = (streamModel) => {
			used.push(`${streamModel.provider}/${streamModel.id}`);
			const stream = createAssistantMessageEventStream();
			const message: AssistantMessage = {
				role: "assistant",
				content: [{ type: "text", text: "ok" }],
				api: streamModel.api,
				provider: streamModel.provider,
				model: streamModel.id,
				usage: {
					input: 1,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 2,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: Date.now(),
			};
			stream.push({ type: "done", reason: "stop", message });
			return stream;
		};
		return core;
	};
	const send = (core: Conversation) =>
		core.handleMessage({
			platform: "discord",
			spaceId: SPACE,
			channelId: "222",
			messageId: String(messageId++),
			authorId: "6",
			authorName: "alice",
			isBot: false,
			content: "hi luna",
			mentionedUserIds: ["900"],
		});

	let core = await start();
	await send(core);
	expect(used).toEqual(["fixture/alpha"]);

	await expect(core.selectModel("luna", "discord", SPACE, "6", "fixture/beta")).rejects.toThrow("not_persona_admin");
	await expect(core.selectModel("luna", "discord", SPACE, "5", "beta")).rejects.toThrow("invalid_model_ref");
	await expect(core.selectModel("luna", "discord", SPACE, "5", "fixture/missing")).rejects.toThrow("unknown_model");
	await expect(core.selectModel("luna", "discord", SPACE, "5", "locked/gamma")).rejects.toThrow(
		"unauthenticated_provider",
	);
	expect(await core.selectModel("luna", "discord", SPACE, "5", "fixture/beta")).toEqual({
		current: "fixture/beta",
		configured: "fixture/alpha",
		available: ["fixture/alpha", "fixture/beta"],
	});
	// The already-open session switches before its next turn.
	await send(core);
	expect(used.at(-1)).toBe("fixture/beta");

	await core.close();
	core = await start();
	expect((await core.getModelStatus("luna", "discord", SPACE, "5")).current).toBe("fixture/beta");
	await send(core);
	expect(used.at(-1)).toBe("fixture/beta");

	expect((await core.selectModel("luna", "discord", SPACE, "5", null)).current).toBe("fixture/alpha");
	await send(core);
	expect(used.at(-1)).toBe("fixture/alpha");
	await core.close();
	core = await start();
	await send(core);
	expect(used.at(-1)).toBe("fixture/alpha");
	await core.close();
});
