import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { AgentSession, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DiscordConversationCore, type DiscordPersona } from "../src/discord/core.ts";
import { DiscordSoulStore, type DiscordSoulScope } from "../src/discord/soul.ts";

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
const scope: DiscordSoulScope = { personaId: "luna", guildId: "111", channelId: "222" };
const note = "A calm and curious conversational style.";

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
	const dataDir = mkdtempSync(join(tmpdir(), "discord-soul-session-"));
	const personaPath = join(dataDir, "persona.md");
	writeFileSync(personaPath, "Friendly companion.");
	const personas: DiscordPersona[] = ["luna", "mio"].map((id, index) => ({
		id,
		name: id,
		userId: `1234567890123456${index}`,
		personaPath,
		provider: model.provider,
		model: model.id,
		routingP: 0,
		adminUserIds: ["999"],
		reasoningEffort: "off",
	}));
	let db = new Database(join(dataDir, "discord-agent.db"));
	let soul = new DiscordSoulStore({ db, personaIds: personas.map((persona) => persona.id) });
	const createCore = () =>
		new DiscordConversationCore({
			db,
			dataDir,
			routingSecret: "fixture",
			personas,
			soulStore: soul,
			modelRuntime: runtime,
			transport: { sendMessage: async () => ({ id: "12345678901234567" }) },
		});
	let core = createCore();
	// Use real Pi sessions and tools; provider calls and the compaction result are deterministic fixtures.
	const getSession = (target: DiscordSoulScope): Promise<AgentSession> =>
		(core as any).getSession(
			personas.find((persona) => persona.id === target.personaId),
			target.guildId,
			target.channelId,
		);
	const otherScopes = [
		{ ...scope, personaId: "mio" },
		{ ...scope, guildId: "333" },
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
			guildId: scope.guildId,
			channelId: scope.channelId,
			messageId: "777",
			authorId: "999",
			authorName: "fixture",
			isBot: false,
			content: "Hello",
			mentionedUserIds: [personas[0]!.userId],
		});
		expect(calls).toBe(2);
		expect(soul.readPending(scope)).toBe(`${note}\n`);
		for (const target of otherScopes) expect(soul.readPending(target)).toBe("");
		session.compact = async () => {
			throw new Error("compaction aborted");
		};
		await expect(core.compactContext("luna", "111", "222", "999")).rejects.toThrow("compaction aborted");
		expect(soul.read(scope)).toBe("");
		expect(soul.readPending(scope)).toBe(`${note}\n`);
		session.compact = async () =>
			({ summary: "fixture summary", tokensBefore: 100, estimatedTokensAfter: 10 }) as never;
		await core.compactContext("luna", "111", "222", "999");
		expect(reloads).toBe(1);
		expect(soul.read(scope)).toBe(`${note}\n`);
		expect(soul.readPending(scope)).toBe("");
		for (const target of otherScopes) {
			expect(soul.read(target)).toBe("");
			await getSession(target); // No deferred reload of another conversation either.
		}
		await core.close();
		db.close();
		db = new Database(join(dataDir, "discord-agent.db"));
		soul = new DiscordSoulStore({ db, personaIds: personas.map((persona) => persona.id) });
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
