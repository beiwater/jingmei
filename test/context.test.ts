import { type AssistantMessage, type Context, createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { AgentSession, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BotState } from "../src/core/bot-state.ts";
import { Conversation } from "../src/core/conversation.ts";
import { WITHHELD_MESSAGE_TYPE } from "../src/core/context.ts";
import type { EventTracker } from "../src/core/events.ts";
import { MemberMemory } from "../src/core/memory.ts";
import { SoulStore } from "../src/core/soul.ts";
import type { InboundMessage, Persona, Platform, PlatformTransport, SpaceId } from "../src/core/types.ts";

type SessionSeam = { getSession(persona: Persona, spaceId: SpaceId, channelId: string): Promise<AgentSession> };
type Block = AssistantMessage["content"][number];

const SPACE: SpaceId = "discord:111";
const IMAGE = { mimeType: "image/png" as const, base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB" };
const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});

function fixture(options: {
	imageInput: boolean;
	vision?: boolean;
	observer?: boolean;
	platform?: Platform;
	events?: boolean;
}) {
	const platform = options.platform ?? "discord";
	const space: SpaceId = platform === "discord" ? SPACE : "telegram:-100111";
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
		imageGenerationEnabled: false,
		accounts: { [platform]: { userId: "900", username: "luna" } },
	};
	const observer: Persona = {
		...persona,
		id: "sol",
		name: "sol",
		accounts: { [platform]: { userId: "901", username: "sol" } },
	};
	let sends = 0;
	const transport: PlatformTransport = {
		platform,
		echoesOwnMessages: platform === "discord",
		displayName: platform,
		promptLines: [],
		quickReactions: {},
		sendMessage: async () => ({ id: String(++sends) }),
		formatMention: (user) => `@${user.username}`,
		isValidReaction: () => true,
	};
	const db = new Database(":memory:");
	const memory = new MemberMemory(db);
	const botState = new BotState(db);
	const core = new Conversation({
		db,
		botState,
		memberMemory: memory,
		soulStore: new SoulStore({ db, personaIds: [persona.id, observer.id] }),
		dataDir,
		routingSecret: "fixture",
		personas: options.observer ? [persona, observer] : [persona],
		modelRuntime: runtime,
		transports: new Map([[platform, transport]]),
		...(options.vision ? { visionModel: { provider: "fixture", model: "vision" } } : {}),
		...(options.events
			? {
					events: {
						assign: async () => 7,
						describe: () => ({ title: "猫咪", description: "聊猫", participants: [] }),
					} as unknown as EventTracker,
				}
			: {}),
	});
	cleanups.push(() => {
		void core.close();
		db.close();
		rmSync(dataDir, { recursive: true, force: true });
	});
	const contexts: Context[] = [];
	const observerContexts: Context[] = [];
	const script: AssistantMessage[] = [];
	const ready = (async () => {
		// Private seam: attach a deterministic provider stream to the real Pi session.
		const seam = core as unknown as SessionSeam;
		for (const [target, captured] of [
			[persona, contexts],
			...(options.observer ? [[observer, observerContexts] as const] : []),
		] as const) {
			const session = await seam.getSession(target, space, "222");
			session.agent.streamFunction = (_model, context) => {
				// Snapshot only the messages: the live context also carries non-cloneable tool handlers.
				captured.push({ messages: JSON.parse(JSON.stringify(context.messages)) });
				const stream = createAssistantMessageEventStream();
				const message = script.shift() ?? reply([{ type: "text", text: "ok" }]);
				stream.push({ type: "done", reason: message.stopReason as "stop", message });
				return stream;
			};
		}
	})();
	let id = 10;
	const send = async (overrides: Partial<InboundMessage> = {}) => {
		await ready;
		await core.handleMessage({
			platform,
			spaceId: space,
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
	return {
		send,
		core,
		persona,
		contexts,
		observerContexts,
		memory,
		space,
		script,
		reply,
		db,
		botState,
		sends: () => sends,
		visionCalls: () => visionCalls,
	};
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

test("a paused bot stores messages but runs no model turn and sends nothing until resumed", async () => {
	const f = fixture({ imageInput: false });
	f.botState.startRun();
	f.botState.pause();
	await f.send();
	expect(f.contexts).toHaveLength(0);
	expect(f.sends()).toBe(0);
	f.botState.resume();
	await f.send();
	expect(f.contexts).toHaveLength(1);
	expect(f.sends()).toBe(1);
	expect(f.botState.summary()).toMatchObject({ messages: 2, replies: 1, current: { replies: 1 } });
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

test("the current-event note reaches only the turn it was written for", async () => {
	const f = fixture({ imageInput: false, events: true });
	await f.send({ content: "first" });
	await f.send({ content: "second" });
	const [first, second] = f.contexts.map((context) =>
		context.messages.map((message) => JSON.stringify(message.content).includes("[当前事件 §E7「猫咪」")),
	);
	expect(first?.at(-1)).toBe(true);
	// The earlier message is now history: its note is gone, the latest input carries its own.
	expect(second?.filter(Boolean)).toHaveLength(1);
	expect(second?.at(-1)).toBe(true);
});

test("member memory is not attached automatically; the model recalls it on demand", async () => {
	const f = fixture({ imageInput: false });
	f.memory.observe({
		platform: "discord",
		spaceId: f.space,
		channelId: "222",
		messageId: "seed",
		authorId: "5",
		authorName: "alice",
		isBot: false,
		content: "hello",
	});
	f.memory.rememberFact({
		spaceId: f.space,
		memberId: "5",
		key: "interest",
		value: "author-music",
		sourceChannelId: "222",
		sourceMessageId: "seed",
	});
	await f.send();
	expect(JSON.stringify(f.contexts[0]!.messages)).not.toContain("author-music");
});

test("withheld markers persist but projection removes only their turn's assistants", async () => {
	const f = fixture({ imageInput: false, events: true });
	f.script.push(f.reply([{ type: "text", text: "visible-before" }]));
	await f.send({ content: "input-before" });
	f.script.push(
		f.reply([{ type: "toolCall", id: "withheld-calc", name: "run_js", arguments: { code: "1 + 1" } }], "toolUse"),
		f.reply([{ type: "text", text: "withheld-answer §E7" }]),
	);
	await f.send({ content: "input-withheld" });
	expect(f.sends()).toBe(1);
	const session = await (f.core as unknown as SessionSeam).getSession(f.persona, f.space, "222");
	const marker = session.messages.find(
		(message) => message.role === "custom" && message.customType === WITHHELD_MESSAGE_TYPE,
	);
	expect(marker).toMatchObject({ role: "custom", customType: WITHHELD_MESSAGE_TYPE, content: "", display: false });
	expect(
		session.messages.some(
			(message) =>
				message.role === "assistant" &&
				message.content.some((part) => part.type === "text" && part.text === "withheld-answer §E7"),
		),
	).toBe(true);

	f.script.push(f.reply([{ type: "text", text: "visible-after" }]));
	await f.send({ content: "input-after" });
	await f.send({ content: "input-final" });
	const projected = f.contexts.at(-1)!.messages;
	const assistants = projected.filter((message) => message.role === "assistant");
	expect(assistants.flatMap((message) => message.content.filter((part) => part.type === "text"))).toEqual([
		{ type: "text", text: "visible-before" },
		{ type: "text", text: "visible-after" },
	]);
	expect(assistants.flatMap((message) => message.content.filter((part) => part.type === "toolCall"))).toEqual([]);
	expect(JSON.stringify(projected)).not.toContain(WITHHELD_MESSAGE_TYPE);
	for (const text of ["input-before", "input-withheld", "input-after", "input-final"])
		expect(JSON.stringify(projected)).toContain(text);
	expect(projected.filter((message) => JSON.stringify(message.content).includes("[当前事件"))).toHaveLength(1);
});
