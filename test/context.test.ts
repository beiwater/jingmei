import { type AssistantMessage, type Context, createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { AgentSession, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Conversation } from "../src/core/conversation.ts";
import { MemberMemory } from "../src/core/memory.ts";
import { SoulStore } from "../src/core/soul.ts";
import type { InboundMessage, Persona, PlatformTransport, SpaceId } from "../src/core/types.ts";

type SessionSeam = { getSession(persona: Persona, spaceId: SpaceId, channelId: string): Promise<AgentSession> };
type Block = AssistantMessage["content"][number];

const SPACE: SpaceId = "discord:111";
const IMAGE = { mimeType: "image/png" as const, base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB" };
const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});

function fixture(options: { imageInput: boolean; vision?: boolean }) {
	const model = {
		id: "fixture",
		name: "fixture",
		api: "openai-responses" as const,
		provider: "fixture",
		baseUrl: "http://unused",
		reasoning: false,
		input: options.imageInput ? (["text", "image"] as const) : (["text"] as const),
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 65536,
		maxTokens: 4096,
	};
	const reply = (content: Block[], stopReason: "stop" | "toolUse" = "stop"): AssistantMessage => ({
		role: "assistant",
		content,
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: Date.now(),
	});
	let visionCalls = 0;
	const runtime = {
		getModel: () => model,
		hasConfiguredAuth: () => true,
		getAuth: async () => ({ auth: { apiKey: "fixture" } }),
		completeSimple: async () => {
			visionCalls++;
			return reply([{ type: "text", text: "一只橘猫\n趴在键盘上" }]);
		},
	} as unknown as ModelRuntime;
	const dataDir = mkdtempSync(join(tmpdir(), "jingmei-context-"));
	const personaPath = join(dataDir, "persona.md");
	writeFileSync(personaPath, "Friendly companion.");
	const persona: Persona = {
		id: "luna",
		name: "luna",
		personaPath,
		provider: model.provider,
		model: model.id,
		routingP: 0,
		aliases: [],
		adminUserIds: [],
		reasoningEffort: "off",
		sendReactionImages: false,
		voiceEnabled: false,
		accounts: { discord: { userId: "900", username: "luna" } },
	};
	const transport: PlatformTransport = {
		platform: "discord",
		displayName: "Discord",
		promptLines: [],
		quickReactions: {},
		sendMessage: async () => ({ id: "1" }),
		formatMention: (user) => `@${user.username}`,
		isValidReaction: () => true,
	};
	const db = new Database(":memory:");
	const core = new Conversation({
		db,
		memberMemory: new MemberMemory(db),
		soulStore: new SoulStore({ db, personaIds: [persona.id] }),
		dataDir,
		routingSecret: "fixture",
		personas: [persona],
		modelRuntime: runtime,
		transports: new Map([["discord", transport]]),
		...(options.vision ? { visionModel: { provider: "fixture", model: "vision" } } : {}),
	});
	cleanups.push(() => {
		void core.close();
		db.close();
		rmSync(dataDir, { recursive: true, force: true });
	});
	const contexts: Context[] = [];
	const script: AssistantMessage[] = [];
	const ready = (async () => {
		// Private seam: attach a deterministic provider stream to the real Pi session.
		const seam = core as unknown as SessionSeam;
		const session = await seam.getSession(persona, SPACE, "222");
		session.agent.streamFunction = (_model, context) => {
			// Snapshot only the messages: the live context also carries non-cloneable tool handlers.
			contexts.push({ messages: JSON.parse(JSON.stringify(context.messages)) });
			const stream = createAssistantMessageEventStream();
			const message = script.shift() ?? reply([{ type: "text", text: "ok" }]);
			stream.push({ type: "done", reason: message.stopReason as "stop", message });
			return stream;
		};
	})();
	let id = 10;
	const send = async (overrides: Partial<InboundMessage> = {}) => {
		await ready;
		await core.handleMessage({
			platform: "discord",
			spaceId: SPACE,
			channelId: "222",
			messageId: String(id++),
			authorId: "5",
			authorName: "alice",
			isBot: false,
			content: "hi luna",
			mentionedUserIds: ["900"],
			...overrides,
		});
	};
	return { send, contexts, script, reply, visionCalls: () => visionCalls };
}

const thinkingOf = (context: Context) =>
	context.messages.flatMap((message) =>
		message.role === "assistant" ? message.content.filter((part) => part.type === "thinking") : [],
	);

test("thinking of completed turns is dropped while the in-progress tool loop keeps its own", async () => {
	const f = fixture({ imageInput: false });
	f.script.push(
		f.reply([
			{ type: "thinking", thinking: "turn one" },
			{ type: "text", text: "hello" },
		]),
	);
	await f.send();
	f.script.push(
		f.reply(
			[
				{ type: "thinking", thinking: "tool loop" },
				{ type: "toolCall", id: "calc", name: "run_js", arguments: { code: "1 + 1" } },
			],
			"toolUse",
		),
	);
	await f.send();
	// contexts: [turn one], [turn two before tool], [turn two after tool result]
	expect(f.contexts).toHaveLength(3);
	expect(thinkingOf(f.contexts[1]!)).toEqual([]);
	expect(thinkingOf(f.contexts[2]!)).toEqual([{ type: "thinking", thinking: "tool loop" }]);
	const completed = f.contexts[2]!.messages.find(
		(message) => message.role === "assistant" && message.content.some((part) => part.type === "text"),
	);
	expect(completed?.role === "assistant" && completed.content).toEqual([{ type: "text", text: "hello" }]);
});

test("images reach image-capable models as image blocks", async () => {
	const f = fixture({ imageInput: true, vision: true });
	await f.send({ images: [IMAGE] });
	const content = f.contexts[0]!.messages.at(-1)!.content;
	expect(Array.isArray(content) && content.map((part) => part.type)).toEqual(["text", "image"]);
	expect(f.visionCalls()).toBe(0);
});

test("text-only models get the auxiliary vision description instead of the image block", async () => {
	const f = fixture({ imageInput: false, vision: true });
	await f.send({ images: [IMAGE, IMAGE] });
	const content = f.contexts[0]!.messages.at(-1)!.content;
	expect(f.visionCalls()).toBe(2);
	expect(Array.isArray(content) && content.slice(1)).toEqual([
		{ type: "text", text: "[图片：一只橘猫 趴在键盘上]" },
		{ type: "text", text: "[图片：一只橘猫 趴在键盘上]" },
	]);
});

test("without a vision model the image block is left for Pi's own downgrade", async () => {
	const f = fixture({ imageInput: false });
	await f.send({ images: [IMAGE] });
	const content = f.contexts[0]!.messages.at(-1)!.content;
	expect(Array.isArray(content) && content.map((part) => part.type)).toEqual(["text", "image"]);
});
