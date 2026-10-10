import type { StreamFn } from "@earendil-works/pi-agent-core";
import { type AssistantMessage, createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { Database } from "bun:sqlite";
import { afterEach, expect, setSystemTime, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BotState } from "../src/core/bot-state.ts";
import { Conversation, type ConversationOptions } from "../src/core/conversation.ts";
import { ensureSessionTables } from "../src/core/db.ts";
import type { EventTracker } from "../src/core/events.ts";
import { MemberMemory } from "../src/core/memory.ts";
import type { MessageIndex, MessageKey } from "../src/core/message-index.ts";
import { type SoulScope, SoulStore } from "../src/core/soul.ts";
import type { InboundMessage, Persona, PlatformTransport, SpaceId } from "../src/core/types.ts";
import { assistantMessage, IMAGE, makeModel, makeRuntime, onSession, scriptedStream } from "./support/pi.ts";

const SPACE: SpaceId = "telegram:-100111";
const CHANNEL = "222";
const T0 = Date.UTC(2026, 0, 1, 12, 0, 0);
const MINUTE = 60_000;

interface Captured {
	persona: string;
	systemPrompt: string;
	messages: Array<{ role: string; content: string | Array<{ type: string; text?: string }> }>;
}

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
	setSystemTime();
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** Records what the core asks of the index; counts are whatever the test sets. */
class FakeIndex {
	readonly enqueued: string[] = [];
	readonly events: string[] = [];
	readonly relatedCalls: Array<{ messageId: string; before: number }> = [];
	counts = new Map<string, number | null>();
	enqueue(key: MessageKey) {
		this.enqueued.push(key.messageId);
	}
	async ensure(keys: readonly MessageKey[]) {
		this.events.push(`ensure:${keys.map((key) => key.messageId).join(",")}`);
	}
	relatedCount(key: MessageKey, before: number) {
		this.events.push(`count:${key.messageId}`);
		this.relatedCalls.push({ messageId: key.messageId, before });
		return this.counts.get(key.messageId) ?? null;
	}
	related() {
		return [];
	}
	async search() {
		return [];
	}
	forgetAuthor() {}
	async idle() {}
}

function fixture(options: { personas?: number; timeoutMs?: number; index?: boolean; imageInput?: boolean } = {}) {
	const model = makeModel({ input: options.imageInput ? ["text", "image"] : ["text"], contextWindow: 1_048_576 });
	const reply = (text = "hello"): AssistantMessage => assistantMessage(text, { model });
	const dataDir = mkdtempSync(join(tmpdir(), "jingmei-segment-"));
	const personaPath = join(dataDir, "persona.md");
	writeFileSync(personaPath, "Friendly companion.");
	const personas: Persona[] = ["luna", "sol"].slice(0, options.personas ?? 1).map((id, index) => ({
		id,
		name: id === "luna" ? "Luna" : "Sol",
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
		accounts: { telegram: { userId: String(900 + index), username: `${id}_bot` } },
	}));
	const sends: Array<Parameters<PlatformTransport["sendMessage"]>[0]> = [];
	const transport: PlatformTransport = {
		platform: "telegram",
		echoesOwnMessages: false,
		displayName: "telegram",
		promptLines: [],
		quickReactions: {},
		sendMessage: async (input) => {
			sends.push(input);
			return { id: String(1000 + sends.length) };
		},
		formatMention: (user) => `@${user.username}`,
		isValidReaction: () => true,
	};
	const db = new Database(":memory:");
	const soul = new SoulStore({ db, personaIds: personas.map((persona) => persona.id) });
	const index = options.index === false ? undefined : new FakeIndex();
	const coreOptions: ConversationOptions = {
		db,
		botState: new BotState(db),
		memberMemory: new MemberMemory(db),
		soulStore: soul,
		dataDir,
		routingSecret: "fixture",
		personas,
		modelRuntime: makeRuntime(model),
		transports: new Map([["telegram", transport]]),
		events: {
			assign: async () => 7,
			describe: () => ({ title: "Topic", description: "Chat", participants: [] }),
		} as unknown as EventTracker,
		turnTimeoutMs: options.timeoutMs ?? 5_000,
		...(index ? { messageIndex: index as unknown as MessageIndex } : {}),
	};
	const captured: Captured[] = [];
	const script: Array<AssistantMessage | StreamFn> = [];
	const build = () => {
		const core = new Conversation(coreOptions);
		const seam = onSession(core, (session, persona) => {
			session.agent.streamFunction = scriptedStream(script, reply, (context) =>
				captured.push({
					persona: persona.id,
					systemPrompt: context.systemPrompt ?? "",
					messages: JSON.parse(JSON.stringify(context.messages)),
				}),
			);
		});
		cleanups.push(() => core.close());
		return { core, seam };
	};
	cleanups.push(() => {
		db.close();
		rmSync(dataDir, { recursive: true, force: true });
	});
	const first = build();
	let now = T0;
	let messageId = 10;
	/** Advance the clock, then deliver one message (a human mention of the first persona unless overridden). */
	const send = (advanceMs: number, overrides: Partial<InboundMessage> = {}, core = first.core) => {
		now += advanceMs;
		setSystemTime(new Date(now));
		return core.handleMessage({
			platform: "telegram",
			spaceId: SPACE,
			channelId: CHANNEL,
			messageId: String(messageId++),
			authorId: "5",
			authorName: "Alice",
			isBot: false,
			content: "hi there",
			mentionedUserIds: ["900"],
			...overrides,
		});
	};
	const chat = (content: string, advanceMs = 1_000, overrides: Partial<InboundMessage> = {}) =>
		send(advanceMs, { content, mentionedUserIds: [], ...overrides });
	const row = (personaId = "luna") =>
		db
			.query(
				"SELECT session_file AS file, last_reply_at AS lastReplyAt, cursor_message_id AS cursor, segment_start_at AS start FROM sessions WHERE persona_id = ?",
			)
			.get(personaId) as {
			file: string;
			lastReplyAt: number | null;
			cursor: string | null;
			start: number | null;
		} | null;
	return {
		...first,
		build,
		send,
		chat,
		row,
		db,
		soul,
		persona: personas[0]!,
		personas,
		index,
		captured,
		script,
		reply,
		sends,
		now: () => now,
	};
}

const textOf = (message: Captured["messages"][number]) =>
	typeof message.content === "string"
		? message.content
		: message.content.map((part) => (part.type === "text" ? part.text : `<${part.type}>`)).join("\n");
const userTexts = (call: Captured) =>
	call.messages.filter((message) => message.role === "user").map((message) => textOf(message));
const imagesIn = (call: Captured) =>
	call.messages.flatMap((message) =>
		Array.isArray(message.content) ? message.content.filter((part) => part.type === "image") : [],
	).length;

test("untriggered messages are stored and indexed but never written to a session or sent to a model", async () => {
	const f = fixture();
	await f.chat("just chatting");
	await f.chat("still chatting");
	expect(f.captured).toEqual([]);
	expect((await f.seam.getSession(f.persona, SPACE, CHANNEL)).messages).toEqual([]);
	expect(f.db.query("SELECT COUNT(*) AS n FROM messages").get()).toEqual({ n: 2 });
	expect(f.index!.enqueued).toEqual(["10", "11"]);
	await f.send(1_000);
	// The stored bot reply is indexed too.
	expect(f.index!.enqueued).toEqual(["10", "11", "12", "1001"]);
});

test("a new segment is seeded with the latest 30 earlier messages as one context message", async () => {
	const f = fixture();
	for (let i = 1; i <= 35; i++) await f.chat(`chatter-${String(i).padStart(2, "0")}`);
	await f.send(1_000, { content: "the actual question" });
	expect(f.captured).toHaveLength(1);
	const texts = userTexts(f.captured[0]!);
	expect(texts).toHaveLength(2);
	const seed = texts[0]!;
	expect(seed).toContain("chatter-35");
	expect(seed).toContain("chatter-06");
	expect(seed).not.toContain("chatter-05");
	expect(seed).not.toContain("the actual question");
	expect(seed.indexOf("chatter-06")).toBeLessThan(seed.indexOf("chatter-35"));
	expect(texts[1]).toContain("the actual question");
});

test("related counts are computed once per line, against history older than the seed window", async () => {
	const f = fixture();
	await f.chat("old-1");
	await f.chat("old-2");
	await f.chat("old-3");
	const earliest = (f.db.query("SELECT MIN(timestamp) AS t FROM messages").get() as { t: number }).t;
	f.index!.counts = new Map([
		["10", 3],
		["11", 0],
		["12", 25],
		["13", 1],
	]);
	await f.send(1_000, { content: "question" });
	const call = f.captured[0]!;
	const [seed, trigger] = userTexts(call);
	expect(seed).toContain("（相关 3 条）");
	expect(seed).toContain("（相关 20+ 条）");
	expect(seed).not.toContain("（相关 0 条）");
	expect(trigger).toContain("（相关 1 条）");
	// Lines are embedded before they are counted, and every count looks only before the window start.
	expect(f.index!.events.slice(0, 2)).toEqual(["ensure:10,11,12", "count:10"]);
	expect(f.index!.relatedCalls.every((entry) => entry.before === earliest)).toBe(true);
	expect(f.index!.relatedCalls.map((entry) => entry.messageId).sort()).toEqual(["10", "11", "12", "13"]);
});

test("without an index no relatedness is written", async () => {
	const f = fixture({ index: false });
	await f.chat("old");
	await f.send(1_000);
	expect(userTexts(f.captured[0]!).join("\n")).not.toContain("相关");
});

test("continuing a segment appends only unseen messages and leaves everything already written untouched", async () => {
	const f = fixture();
	await f.chat("before-1");
	f.index!.counts = new Map([["10", 2]]);
	await f.send(1_000, { content: "first question" });
	const file = f.row()!.file;
	await f.chat("between-1");
	await f.chat("between-2");
	// Counts changing later must not rewrite lines that are already part of the prefix.
	f.index!.counts = new Map([
		["10", 9],
		["11", 9],
		["12", 9],
		["13", 4],
		["14", 4],
	]);
	await f.send(1_000, { content: "second question" });
	expect(f.row()!.file).toBe(file);
	const [first, second] = f.captured;
	expect(second!.messages.slice(0, first!.messages.length)).toEqual(first!.messages);
	const texts = userTexts(second!);
	// seed, first question, catch-up block, second question
	expect(texts).toHaveLength(4);
	expect(texts[2]).toContain("between-1");
	expect(texts[2]).toContain("between-2");
	expect(texts[2]).not.toContain("before-1");
	// The bot's own reply is the assistant message, not repeated in the catch-up block.
	expect(texts[2]).not.toContain("hello");
	// The event note is frozen with its message: the first question keeps it in later requests.
	expect(JSON.stringify(second!.messages.slice(0, first!.messages.length))).toContain("当前事件");
});

test("a reply older than five minutes starts a new segment; exactly five minutes continues", async () => {
	const f = fixture();
	await f.send(1_000, { content: "turn one" });
	const file = f.row()!.file;
	await f.send(5 * MINUTE, { content: "turn two" });
	expect(f.row()!.file).toBe(file);
	await f.send(5 * MINUTE + 1, { content: "turn three" });
	const next = f.row()!.file;
	expect(next).not.toBe(file);
	// The new segment is rebuilt from stored messages: earlier turns appear as lines, replies as bot lines.
	const seed = userTexts(f.captured[2]!)[0]!;
	expect(seed).toContain("turn one");
	expect(seed).toContain("turn two");
	expect(seed).toContain("luna_bot · bot");
	expect(f.captured[2]!.messages.some((message) => message.role === "assistant")).toBe(false);
});

test("more than 30 unseen messages start a new segment; 30 continue, ignoring the persona's own", async () => {
	const f = fixture();
	await f.send(1_000, { content: "turn one" });
	const file = f.row()!.file;
	for (let i = 0; i < 30; i++) await f.chat(`gap-${i}`);
	await f.send(1_000, { content: "turn two" });
	expect(f.row()!.file).toBe(file);
	expect(userTexts(f.captured[1]!)[1]).toContain("gap-29");
	for (let i = 0; i < 31; i++) await f.chat(`late-${i}`);
	await f.send(1_000, { content: "turn three" });
	expect(f.row()!.file).not.toBe(file);
	const seed = userTexts(f.captured[2]!)[0]!;
	expect(seed).toContain("late-30");
	expect(seed).not.toContain("gap-0");
});

test("a segment above 40,000 tokens is retired; at the limit it continues", async () => {
	const f = fixture();
	await f.send(1_000);
	const session = await f.seam.getSession(f.persona, SPACE, CHANNEL);
	const file = f.row()!.file;
	session.getContextUsage = () => ({ tokens: 40_000, contextWindow: 1_048_576, percent: 4 });
	await f.send(1_000);
	expect(f.row()!.file).toBe(file);
	session.getContextUsage = () => ({ tokens: 40_001, contextWindow: 1_048_576, percent: 4 });
	await f.send(1_000);
	expect(f.row()!.file).not.toBe(file);
	expect(f.captured).toHaveLength(3);
});

test("a timed-out turn retires its session so the next trigger starts a new segment", async () => {
	const f = fixture({ timeoutMs: 60 });
	await f.send(1_000, { content: "turn one" });
	const file = f.row()!.file;
	f.script.push(() => createAssistantMessageEventStream()); // never completes
	const stuck = await f.send(1_000, { content: "turn two" });
	expect(stuck.responseMessageId).toBeUndefined();
	expect(f.row()!.lastReplyAt).toBeNull();
	await f.send(1_000, { content: "turn three" });
	expect(f.row()!.file).not.toBe(file);
	const seed = userTexts(f.captured.at(-1)!)[0]!;
	expect(seed).toContain("turn one");
	expect(seed).toContain("turn two");
});

test("pending soul notes are promoted when a new segment starts and reach its system prompt", async () => {
	const f = fixture();
	const scope: SoulScope = { personaId: "luna", spaceId: SPACE, channelId: CHANNEL };
	await f.send(1_000);
	f.soul.update(scope, "Keep answers short.");
	await f.send(1_000);
	// Continuing: the note is only pending, shown in history rather than the system prompt.
	expect(f.soul.read(scope)).toBe("");
	expect(f.captured[1]!.systemPrompt).not.toContain("Keep answers short.");
	await f.send(6 * MINUTE);
	expect(f.soul.read(scope)).toBe("Keep answers short.\n");
	expect(f.soul.readPending(scope)).toBe("");
	expect(f.captured[2]!.systemPrompt).toContain("Keep answers short.");
});

test("after a restart the persisted state still decides between continuing and a new segment", async () => {
	const f = fixture();
	await f.send(1_000, { content: "turn one" });
	const file = f.row()!.file;
	await f.core.close();
	const second = f.build();
	await f.send(MINUTE, { content: "turn two" }, second.core);
	expect(f.row()!.file).toBe(file);
	// The reopened session still holds the first turn as real messages.
	expect(f.captured.at(-1)!.messages.some((message) => message.role === "assistant")).toBe(true);
	await second.core.close();
	const third = f.build();
	await f.send(6 * MINUTE, { content: "turn three" }, third.core);
	expect(f.row()!.file).not.toBe(file);
	expect(f.captured.at(-1)!.messages.some((message) => message.role === "assistant")).toBe(false);
});

test("a legacy session without segment state is left behind by the first trigger", async () => {
	const f = fixture();
	await f.send(1_000);
	const file = f.row()!.file;
	f.db.exec(
		"UPDATE sessions SET last_reply_at = NULL, cursor_timestamp = NULL, cursor_message_id = NULL, segment_start_at = NULL",
	);
	await f.send(1_000);
	expect(f.row()!.file).not.toBe(file);
});

test("an image sent earlier reaches the model when a later message asks about it", async () => {
	const f = fixture({ imageInput: true });
	await f.chat("look at this", 1_000, { images: [IMAGE] });
	await f.chat("so cute");
	await f.send(1_000, { content: "what is this?" });
	expect(imagesIn(f.captured[0]!)).toBe(1);
	// Continuing does not resend it: the image is already part of the written prefix.
	await f.send(1_000, { content: "and now?" });
	expect(imagesIn(f.captured[1]!)).toBe(1);
});

test("at most four of the newest images join a seed", async () => {
	const f = fixture({ imageInput: true });
	for (let i = 0; i < 6; i++) await f.chat(`pic-${i}`, 1_000, { images: [IMAGE] });
	await f.send(1_000);
	expect(imagesIn(f.captured[0]!)).toBe(4);
});

test("only the triggered persona's session is written; each persona rotates on its own state", async () => {
	const f = fixture({ personas: 2 });
	await f.chat("hello everyone");
	await f.send(1_000, { content: "luna question" });
	expect(f.captured.map((call) => call.persona)).toEqual(["luna"]);
	expect(f.row("sol")).toBeNull();
	await f.send(1_000, { content: "sol question", mentionedUserIds: ["901"] });
	expect(f.captured.map((call) => call.persona)).toEqual(["luna", "sol"]);
	const solSeed = userTexts(f.captured[1]!)[0]!;
	expect(solSeed).toContain("luna question");
	expect(solSeed).toContain("luna_bot · bot");
	// Luna's segment is unaffected by Sol's turn.
	expect(f.row("luna")!.lastReplyAt).not.toBeNull();
});

test("segment migration is idempotent and keeps pre-segment rows", () => {
	const db = new Database(":memory:");
	db.exec(`CREATE TABLE sessions (persona_id TEXT NOT NULL, space_id TEXT NOT NULL, channel_id TEXT NOT NULL,
		session_file TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (persona_id, space_id, channel_id));
		INSERT INTO sessions VALUES ('luna', 'discord:1', '2', '/old.jsonl', 1);`);
	ensureSessionTables(db);
	ensureSessionTables(db);
	expect(
		db.query("SELECT session_file, last_reply_at, cursor_timestamp, segment_start_at FROM sessions").all(),
	).toEqual([{ session_file: "/old.jsonl", last_reply_at: null, cursor_timestamp: null, segment_start_at: null }]);
	db.close();
});
