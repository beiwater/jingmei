import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import type { JevClient } from "../src/decision/jev.ts";
import { ensureMessagesTable } from "../src/core/db.ts";
import type { Embedder } from "../src/core/embedding.ts";
import { createPiEventSummarizer, EventTracker, type EventSummarizer } from "../src/core/events.ts";
import type { InboundMessage } from "../src/core/types.ts";

const trackers: EventTracker[] = [];
const databases: Database[] = [];
afterEach(async () => {
	for (const tracker of trackers.splice(0)) await tracker.idle();
	for (const db of databases.splice(0)) db.close();
});

function setup() {
	const db = new Database(":memory:");
	databases.push(db);
	let time = 1_000_000_000;
	let serial = 0;
	let choice = "first";
	let failDecision = false;
	let failEmbedding = false;
	let failParticipation = false;
	const choices: Array<Parameters<JevClient["chooseEvent"]>[0]> = [];
	const summaries: string[][] = [];
	const embeddingInputs: string[][] = [];
	const participations: Array<{ members: readonly string[]; transcript: readonly string[] }> = [];
	const decision: JevClient = {
		async decideQuickReaction() {
			return { emoji: null, confidence: 0, strongEmotion: 0, funny: 0 };
		},
		async scoreRelevance(_query, candidates) {
			return candidates.map(() => 0);
		},
		async chooseEvent(input) {
			choices.push(input);
			if (failDecision) throw new Error("offline");
			return { choice: choice === "first" ? input.options[0]!.id : choice, confidence: 0.9 };
		},
		async scoreParticipation(input) {
			participations.push(input);
			if (failParticipation) throw new Error("offline");
			return input.members.map((name) => (name === "Alice" ? 0.9 : 0.3));
		},
	};
	const embedder: Embedder = {
		dimensions: 2,
		async embed(texts) {
			embeddingInputs.push([...texts]);
			if (failEmbedding) throw new Error("offline");
			return texts.map((text) => new Float32Array(text.includes("无关") ? [-1, 0] : [1, 0]));
		},
	};
	let summarizer: EventSummarizer = async () => ({ title: "数据库", description: "讨论向量数据库" });
	const tracker = new EventTracker({
		db,
		decision,
		embedder,
		now: () => time,
		summarize: async (transcript) => {
			summaries.push([...transcript]);
			return summarizer(transcript);
		},
	});
	trackers.push(tracker);
	return {
		db,
		tracker,
		choices,
		summaries,
		embeddingInputs,
		participations,
		advance(ms: number) {
			time += ms;
		},
		choose(value: string) {
			choice = value;
		},
		failDecision() {
			failDecision = true;
		},
		failEmbedding() {
			failEmbedding = true;
		},
		failParticipation() {
			failParticipation = true;
		},
		summarize(fn: EventSummarizer) {
			summarizer = fn;
		},
		async send(overrides: Partial<InboundMessage> = {}) {
			const message: InboundMessage = {
				platform: "discord",
				spaceId: "discord:test",
				channelId: "channel",
				messageId: String(++serial),
				authorId: "alice",
				authorName: "Alice",
				isBot: false,
				content: `消息${serial}`,
				timestamp: ++time,
				...overrides,
			};
			db.query(
				"INSERT INTO messages(space_id,channel_id,message_id,author_id,author_name,is_bot,content,reply_to_message_id,timestamp) VALUES (?,?,?,?,?,?,?,?,?)",
			).run(
				message.spaceId,
				message.channelId,
				message.messageId,
				message.authorId,
				message.authorName,
				Number(message.isBot),
				message.content,
				message.replyToMessageId ?? null,
				message.timestamp!,
			);
			return { message, eventId: await tracker.assign(message) };
		},
	};
}

test("first human creates a topic; subsequent humans choose from contextual options and new", async () => {
	const h = setup();
	const first = await h.send({ content: "讨论 SQLite" });
	expect(first.eventId).not.toBeNull();
	expect(h.choices).toEqual([]);
	expect(h.embeddingInputs).toEqual([]);
	const second = await h.send({ content: "SQLite 可以存向量吗" });
	expect(second.eventId).toBe(first.eventId);
	expect(h.choices[0]).toEqual({
		message: "SQLite 可以存向量吗",
		recent: ["Alice: 讨论 SQLite"],
		options: [
			{ id: `e${first.eventId}`, description: "Alice: 讨论 SQLite" },
			{ id: "new", description: "新的话题" },
		],
	});
	h.choose("new");
	const separate = await h.send({ content: "午饭吃什么" });
	expect(separate.eventId).not.toBe(first.eventId);
	expect(h.db.query("SELECT event_id FROM messages WHERE message_id = ?").get(separate.message.messageId)).toEqual({
		event_id: separate.eventId,
	});
	expect(await h.tracker.assign(separate.message)).toBe(separate.eventId);
	expect(h.db.query("SELECT message_count FROM events WHERE id = ?").get(separate.eventId!)).toEqual({
		message_count: 1,
	});
});

test("bots inherit only their reply's event and never call a decision model", async () => {
	const h = setup();
	const first = await h.send();
	h.choose("new");
	await h.send();
	const calls = h.choices.length;
	const reply = await h.send({ isBot: true, replyToMessageId: first.message.messageId });
	expect(reply.eventId).toBe(first.eventId);
	expect((await h.send({ isBot: true })).eventId).toBeNull();
	expect((await h.send({ isBot: true, replyToMessageId: "missing" })).eventId).toBeNull();
	expect(h.choices.length).toBe(calls);
});

test("failed decisions prefer reply topic, then latest active, then a new topic", async () => {
	const h = setup();
	const first = await h.send();
	h.choose("new");
	const latest = await h.send();
	h.failDecision();
	expect((await h.send({ replyToMessageId: first.message.messageId })).eventId).toBe(first.eventId);
	await h.tracker.idle();
	expect((await h.send()).eventId).toBe(first.eventId);
	h.advance(2 * 60 * 60 * 1000 + 1);
	h.failEmbedding();
	const fresh = await h.send();
	expect(fresh.eventId).not.toBe(first.eventId);
	expect(fresh.eventId).not.toBe(latest.eventId);
});

test("active options expire after two hours and are capped at five most recent topics", async () => {
	const h = setup();
	h.choose("new");
	const ids: Array<number | null> = [];
	for (let i = 0; i < 7; i++) ids.push((await h.send()).eventId);
	expect(h.choices.at(-1)!.options.map((option) => option.id)).toEqual([
		...ids
			.slice(1, 6)
			.reverse()
			.map((id) => `e${id}`),
		"new",
	]);
	h.advance(2 * 60 * 60 * 1000 + 1);
	const calls = h.choices.length;
	const fresh = await h.send();
	expect(h.choices.length).toBe(calls);
	expect(ids).not.toContain(fresh.eventId);
});

test("closed vector topics are channel-scoped, distance bounded, and reopen on selection", async () => {
	const h = setup();
	const first = await h.send();
	await h.send();
	await h.send();
	await h.tracker.idle();
	expect(h.tracker.describe(first.eventId!)?.title).toBe("数据库");
	h.advance(2 * 60 * 60 * 1000 + 1);
	const resumed = await h.send({ content: "继续讨论数据库" });
	expect(resumed.eventId).toBe(first.eventId);
	expect(h.choices.at(-1)!.options).toEqual([
		{ id: `e${first.eventId}`, description: "数据库：讨论向量数据库" },
		{ id: "new", description: "新的话题" },
	]);
	const calls = h.choices.length;
	expect((await h.send({ channelId: "elsewhere" })).eventId).not.toBe(first.eventId);
	expect((await h.send({ spaceId: "discord:other" })).eventId).not.toBe(first.eventId);
	expect(h.choices.length).toBe(calls);
	await h.send();
	expect(h.choices.at(-1)!.options[0]!.id).toBe(`e${first.eventId}`);
	h.advance(2 * 60 * 60 * 1000 + 1);
	const beforeUnrelated = h.choices.length;
	expect((await h.send({ content: "无关的午餐" })).eventId).not.toBe(first.eventId);
	expect(h.choices.length).toBe(beforeUnrelated);
});

test("summaries refresh at 3 and 6, ranking distinct humans and excluding bots", async () => {
	const h = setup();
	const first = await h.send();
	await h.send({ authorId: "bob", authorName: "Bob" });
	await h.send({ isBot: true, authorId: "bot", authorName: "Bot", replyToMessageId: first.message.messageId });
	await h.tracker.idle();
	expect(h.summaries.map((lines) => lines.length)).toEqual([3]);
	expect(h.tracker.describe(first.eventId!)?.participants).toEqual([
		{ userId: "alice", name: "Alice", score: 0.9 },
		{ userId: "bob", name: "Bob", score: 0.3 },
	]);
	await h.send();
	await h.tracker.idle();
	await h.send();
	await h.tracker.idle();
	expect(h.summaries.map((lines) => lines.length)).toEqual([3]);
	await h.send();
	await h.tracker.idle();
	expect(h.summaries.map((lines) => lines.length)).toEqual([3, 6]);
	expect(h.participations.at(-1)!.members).toEqual(["Alice", "Bob"]);
	expect(h.db.query("SELECT COUNT(*) AS count FROM event_vectors").get()).toEqual({ count: 1 });
});

test("refresh is single-flight with one catch-up for messages arriving during the first refresh", async () => {
	const h = setup();
	let release!: () => void;
	let started!: () => void;
	const start = new Promise<void>((resolve) => {
		started = resolve;
	});
	const blocked = new Promise<void>((resolve) => {
		release = resolve;
	});
	let running = 0;
	let maximum = 0;
	h.summarize(async () => {
		running++;
		maximum = Math.max(maximum, running);
		started();
		await blocked;
		running--;
		return { title: "数据库", description: "讨论向量数据库" };
	});
	await h.send();
	await h.send();
	await h.send();
	await start;
	await h.send();
	await h.send();
	await h.send();
	expect(h.summaries.map((lines) => lines.length)).toEqual([3]);
	release();
	await h.tracker.idle();
	expect(maximum).toBe(1);
	expect(h.summaries.map((lines) => lines.length)).toEqual([3, 6]);
});

test("old messages gain nullable event_id without losing rows and migration is idempotent", () => {
	const db = new Database(":memory:");
	databases.push(db);
	db.exec(
		"CREATE TABLE messages(space_id TEXT NOT NULL,channel_id TEXT NOT NULL,message_id TEXT NOT NULL,author_id TEXT NOT NULL,author_name TEXT NOT NULL,is_bot INTEGER NOT NULL,content TEXT NOT NULL,reply_to_message_id TEXT,timestamp INTEGER NOT NULL,PRIMARY KEY(space_id,channel_id,message_id)); INSERT INTO messages VALUES ('discord:old','c','m','u','Alice',0,'old',NULL,1)",
	);
	ensureMessagesTable(db);
	ensureMessagesTable(db);
	expect(db.query("SELECT content,event_id FROM messages").all()).toEqual([{ content: "old", event_id: null }]);
	db.query("UPDATE messages SET event_id=42").run();
	expect(db.query("SELECT event_id FROM messages").get()).toEqual({ event_id: 42 });
});

test("closed recall offers only the two nearest matching topics", async () => {
	const h = setup();
	const ids: number[] = [];
	for (const vector of [
		[1, 0],
		[0.9, 0.1],
		[0.8, 0.2],
		[-1, 0],
	]) {
		const row = h.db
			.query(
				"INSERT INTO events(space_id,channel_id,last_message_at,title,description) VALUES ('discord:test','channel',1,'旧话题','旧简介')",
			)
			.run();
		const id = Number(row.lastInsertRowid);
		ids.push(id);
		h.db.query("INSERT INTO event_vectors(rowid,embedding) VALUES (?,?)").run(id, new Float32Array(vector));
	}
	expect((await h.send()).eventId).toBe(ids[0]!);
	expect(h.choices[0]!.options.map((option) => option.id)).toEqual([`e${ids[0]}`, `e${ids[1]}`, "new"]);
});

test("background summary failure never prevents assigning subsequent messages", async () => {
	const h = setup();
	h.summarize(async () => {
		throw new Error("offline");
	});
	const first = await h.send();
	await h.send();
	expect((await h.send()).eventId).toBe(first.eventId);
	await h.tracker.idle();
	expect((await h.send()).eventId).toBe(first.eventId);
	expect(h.tracker.describe(first.eventId!)?.title).toBeNull();
});

test("participation scoring failure still stores the summary vector so the topic stays recallable", async () => {
	const h = setup();
	h.failParticipation();
	const first = await h.send();
	await h.send();
	await h.send();
	await h.tracker.idle();
	expect(h.tracker.describe(first.eventId!)).toMatchObject({ title: "数据库", participants: [] });
	h.advance(3 * 60 * 60 * 1000);
	h.choose("first");
	expect((await h.send()).eventId).toBe(first.eventId);
	expect(h.choices.at(-1)!.options.map((option) => option.id)).toEqual([`e${first.eventId}`, "new"]);
});

test("Pi summarizer bounds Unicode fields and rejects malformed structured responses", async () => {
	let text = JSON.stringify({ title: "题".repeat(41), description: "😀".repeat(201) });
	let stopReason = "stop";
	const runtime = {
		getModel: () => ({}),
		completeSimple: async () => ({ content: [{ type: "text", text }], stopReason }),
	} as unknown as ModelRuntime;
	const summarize = createPiEventSummarizer(runtime, { provider: "fixture", model: "fixture" });
	expect(await summarize(["Alice: 讨论数据库"])).toEqual({ title: "题".repeat(40), description: "😀".repeat(200) });
	for (const invalid of ["not JSON", '{"title":"标题"}', '{"title":null,"description":"简介"}']) {
		text = invalid;
		await expect(summarize(["Alice: 聊天"])).rejects.toThrow();
	}
	text = '{"title":"标题","description":"简介"}';
	stopReason = "error";
	await expect(summarize(["Alice: 聊天"])).rejects.toThrow("事件摘要生成失败");
});
