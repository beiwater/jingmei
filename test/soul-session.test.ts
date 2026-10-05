import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { AgentSession, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BotState } from "../src/core/bot-state.ts";
import { Conversation } from "../src/core/conversation.ts";
import { MemberMemory } from "../src/core/memory.ts";
import { type SoulScope, SoulStore } from "../src/core/soul.ts";
import type { Persona, PlatformTransport } from "../src/core/types.ts";

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
const scope: SoulScope = { personaId: "luna", spaceId: "discord:111", channelId: "222" };
const note = "A calm and curious conversational style.";
type SessionSeam = {
	getSession(persona: Persona | undefined, spaceId: SoulScope["spaceId"], channelId: string): Promise<AgentSession>;
};

function result(tool = false) {
	return {
		role: "assistant" as const,
		content: tool
			? [{ type: "toolCall" as const, id: "soul-fixture", name: "update_soul", arguments: { text: note } }]
			: [{ type: "text" as const, text: "Hello." }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 100,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 101,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: tool ? ("toolUse" as const) : ("stop" as const),
		timestamp: Date.now(),
	};
}

test("soul tool, compaction and restart retain the owning conversation without reloading other sessions", async () => {
	const dataDir = mkdtempSync(join(tmpdir(), "jingmei-soul-session-"));
	const personaPath = join(dataDir, "persona.md");
	writeFileSync(personaPath, "Friendly companion.");
	const personas: Persona[] = ["luna", "mio"].map((id, index) => ({
		id,
		name: id,
		personaPath,
		provider: model.provider,
		model: model.id,
		routingP: 0,
		aliases: [],
		adminUserIds: ["discord:999"],
		reasoningEffort: "off",
		sendReactionImages: true,
		voiceEnabled: false,
		imageGenerationEnabled: false,
		accounts: { discord: { userId: `1234567890123456${index}`, username: id } },
	}));
	const transport: PlatformTransport = {
		platform: "discord",
		echoesOwnMessages: true,
		displayName: "Discord",
		promptLines: [],
		quickReactions: {},
		sendMessage: async () => ({ id: "12345678901234567" }),
		formatMention: (user) => `@${user.username}`,
		isValidReaction: () => true,
	};
	let db = new Database(join(dataDir, "jingmei.db"));
	let soul = new SoulStore({ db, personaIds: personas.map((persona) => persona.id) });
	const createCore = () =>
		new Conversation({
			db,
			botState: new BotState(db),
			dataDir,
			routingSecret: "fixture",
			personas,
			soulStore: soul,
			memberMemory: new MemberMemory(db),
			modelRuntime: runtime,
			transports: new Map([["discord", transport]]),
		});
	let core = createCore();
	// Use real Pi sessions and tools; provider calls and the compaction result are deterministic fixtures.
	const getSession = (target: SoulScope): Promise<AgentSession> => {
		// Private seam: tests drive real Pi sessions directly to inject deterministic provider streams.
		const seam = core as unknown as SessionSeam;
		return seam.getSession(
			personas.find((persona) => persona.id === target.personaId),
			target.spaceId,
			target.channelId,
		);
	};
	const otherScopes = [
		{ ...scope, personaId: "mio" },
		{ ...scope, spaceId: "discord:333" } as SoulScope,
		{ ...scope, channelId: "444" },
		{ ...scope, channelId: "555" },
	];
	try {
		const session = await getSession(scope);
		const others = await Promise.all(otherScopes.map(getSession));
		let reloads = 0;
		const reload = session.reload.bind(session);
		session.reload = async () => {
			reloads++;
			await reload();
		};
		for (const other of others)
			other.reload = async () => {
				throw new Error("Unrelated session reloaded");
			};
		let calls = 0;
		session.agent.streamFunction = () => {
			const stream = createAssistantMessageEventStream();
			const message = result(calls++ === 0);
			stream.push({ type: "done", reason: message.stopReason, message });
			return stream;
		};
		await core.handleMessage({
			platform: "discord",
			spaceId: scope.spaceId,
			channelId: scope.channelId,
			messageId: "777",
			authorId: "999",
			authorName: "fixture",
			isBot: false,
			content: "Hello",
			mentionedUserIds: [personas[0]!.accounts.discord!.userId],
		});
		expect(calls).toBe(2);
		expect(soul.readPending(scope)).toBe(`${note}\n`);
		for (const target of otherScopes) expect(soul.readPending(target)).toBe("");
		session.compact = async () => {
			throw new Error("compaction aborted");
		};
		await expect(core.compactContext("luna", "discord", "discord:111", "222", "999")).rejects.toThrow(
			"compaction aborted",
		);
		expect(soul.read(scope)).toBe("");
		expect(soul.readPending(scope)).toBe(`${note}\n`);
		session.compact = async () =>
			({ summary: "fixture summary", tokensBefore: 100, estimatedTokensAfter: 10 }) as never;
		await core.compactContext("luna", "discord", "discord:111", "222", "999");
		expect(reloads).toBe(1);
		expect(soul.read(scope)).toBe(`${note}\n`);
		expect(soul.readPending(scope)).toBe("");
		for (const target of otherScopes) {
			expect(soul.read(target)).toBe("");
			await getSession(target); // No deferred reload of another conversation either.
		}
		await core.close();
		db.close();
		db = new Database(join(dataDir, "jingmei.db"));
		soul = new SoulStore({ db, personaIds: personas.map((persona) => persona.id) });
		core = createCore();
		const restored = await getSession(scope);
		const other = await getSession(otherScopes[2]!);
		// Inspect the provider boundary through the normal stream callback to detect cross-session leaks.
		const observed: boolean[] = [];
		for (const target of [restored, other]) {
			target.agent.streamFunction = (_model, context) => {
				observed.push(context.systemPrompt?.includes(note) ?? false);
				const stream = createAssistantMessageEventStream();
				stream.push({ type: "done", reason: "stop", message: result() });
				return stream;
			};
			await target.prompt("Hello again.");
		}
		expect(observed).toEqual([true, false]);
	} finally {
		await core.close();
		db.close();
		rmSync(dataDir, { recursive: true, force: true });
	}
});
