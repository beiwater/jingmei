import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { ensureMessagesTable } from "../src/core/db.ts";
import type { Embedder } from "../src/core/embedding.ts";
import { MemberMemory } from "../src/core/memory.ts";
import { type MessageKey, MessageIndex, RELATED_CAP } from "../src/core/message-index.ts";
import type { SpaceId } from "../src/core/types.ts";

const SPACE = "discord:g1" as SpaceId;
const BASE = 1_700_000_000_000;
const databases: Database[] = [];
afterEach(() => {
	for (const db of databases.splice(0)) db.close();
});

// 关键词 → 正交单位向量：同主题距离 0，两个主题混合的消息与单主题距离约 0.77（超出 0.7 阈值），无关主题约 1.41。
const TOPICS = [["苹果", "水果"], ["香蕉"], ["天气"]];

function topicVector(text: string): Float32Array {
	const vector = new Float32Array(4);
	for (const [index, words] of TOPICS.entries()) if (words.some((word) => text.includes(word))) vector[index] = 1;
	if (!vector.some(Boolean)) vector[3] = 1;
	const norm = Math.hypot(...vector);
	return vector.map((value) => value / norm);
}

function setup(options: { embedder?: boolean } = {}) {
	const db = new Database(":memory:");
	databases.push(db);
	ensureMessagesTable(db);
	let inflight = 0;
	let maxInflight = 0;
	const state = { fail: false };
	const embedder: Embedder = {
		dimensions: 4,
		async embed(texts) {
			inflight++;
			maxInflight = Math.max(maxInflight, inflight);
			await new Promise<void>((resolve) => queueMicrotask(resolve));
			inflight--;
			if (state.fail) throw new Error("offline");
			return texts.map(topicVector);
		},
	};
	const index = new MessageIndex({ db, ...(options.embedder === false ? {} : { embedder }) });
	let serial = 0;
	const add = (
		text: string,
		at: number,
		extra: { channel?: string; author?: string; id?: string; replyTo?: string; bot?: boolean } = {},
	): MessageKey => {
		const key = { spaceId: SPACE, channelId: extra.channel ?? "c1", messageId: extra.id ?? `m${++serial}` };
		db.query(
			`INSERT INTO messages (space_id, channel_id, message_id, author_id, author_name, is_bot, content, reply_to_message_id, timestamp)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).run(
			key.spaceId,
			key.channelId,
			key.messageId,
			extra.author ?? "u1",
			extra.author ?? "alice",
			extra.bot ? 1 : 0,
			text,
			extra.replyTo ?? null,
			BASE + at,
		);
		index.enqueue(key);
		return key;
	};
	return { db, index, add, state, maxInflight: () => maxInflight };
}

test("related count applies the distance threshold, cap, time bound, self exclusion and channel isolation", async () => {
	const { index, add } = setup();
	const early: MessageKey[] = [];
	for (let i = 0; i < RELATED_CAP + 5; i++) early.push(add(`苹果话题${i}`, i));
	const banana = add("香蕉很香", 50);
	const mixed = add("苹果和香蕉", 100);
	const unrelated = add("香蕉很甜", 101);
	const otherChannel = add("苹果别的频道", 102, { channel: "c2" });
	const probe = add("苹果 probe", 200);
	await index.idle();

	expect(index.relatedCount(probe, BASE + 200)).toBe(RELATED_CAP + 1);
	expect(index.relatedCount(early[0]!, BASE + 0)).toBe(0);
	expect(index.relatedCount(early[3]!, BASE + 3)).toBe(3);
	// 混合消息与单主题距离约 0.77，超出阈值不计入；同主题（距离 0）计入，无关主题（≈1.41）不计入。
	expect(index.relatedCount(mixed, BASE + 100)).toBe(0);
	expect(index.relatedCount(unrelated, BASE + 300)).toBe(1);
	expect(index.relatedCount(banana, BASE + 50)).toBe(0);
	expect(index.relatedCount(otherChannel, BASE + 300)).toBe(0);
});

test("messages without a vector report null and are not related to anything", async () => {
	const { db, index, add } = setup();
	const media = add("[图片]", 1);
	db.query("INSERT INTO memory_opt_out (space_id, user_id, opted_out_at) VALUES (?, ?, ?)").run(SPACE, "gone", 1);
	const optedOutKey = add("苹果很好吃", 2, { author: "gone" });
	const normal = add("苹果很好吃", 3);
	await index.idle();

	expect(index.relatedCount(media, BASE + 10)).toBeNull();
	expect(index.relatedCount(optedOutKey, BASE + 10)).toBeNull();
	expect(index.relatedCount(normal, BASE + 10)).toBe(0);
	expect(index.related(media, 5)).toEqual([]);
	// 非实质文本仍可按关键词找到。
	const hits = await index.search({ spaceId: SPACE, channelId: "c1" }, "[图片]", {}, 5);
	expect(hits.map((hit) => hit.anchor.messageId)).toEqual([media.messageId]);
});

test("related returns neighbours with two lines of context on each side, never itself", async () => {
	const { index, add } = setup();
	add("闲聊一", 1);
	add("闲聊二", 2);
	const old = add("苹果旧消息", 3);
	add("闲聊三", 4);
	add("闲聊四", 5);
	add("闲聊五", 6);
	const probe = add("苹果新消息", 7);
	add("苹果别的频道", 8, { channel: "c2" });
	await index.idle();

	const hits = index.related(probe, 5);
	expect(hits.map((hit) => hit.anchor.messageId)).toEqual([old.messageId]);
	expect(hits[0]!.context.map((line) => line.content)).toEqual(["闲聊一", "闲聊二", "苹果旧消息", "闲聊三", "闲聊四"]);
});

test("search merges keyword and vector hits within a time range, with short-query fallback", async () => {
	const { index, add } = setup();
	add("今天吃了苹果派", 10);
	add("水果摊在路口", 20);
	add("苹果手机降价了", 30);
	add("香蕉很甜", 40);
	add("猫在睡觉", 50);
	add("别的频道的苹果", 60, { channel: "c2" });
	await index.idle();
	const scope = { spaceId: SPACE, channelId: "c1" };

	const all = await index.search(scope, "苹果", {}, 10);
	// 关键词命中两条；"水果摊"只靠向量命中；香蕉与其他频道不出现。
	expect(all.map((hit) => hit.anchor.content).sort()).toEqual(
		["今天吃了苹果派", "水果摊在路口", "苹果手机降价了"].sort(),
	);

	const ranged = await index.search(scope, "苹果", { from: BASE + 15, to: BASE + 35 }, 10);
	expect(ranged.map((hit) => hit.anchor.content).sort()).toEqual(["水果摊在路口", "苹果手机降价了"].sort());

	// 少于 3 个字符的查询 FTS5 trigram 匹配不到，走 LIKE。
	const short = await index.search(scope, "猫", {}, 10);
	expect(short.map((hit) => hit.anchor.content)).toEqual(["猫在睡觉"]);

	const limited = await index.search(scope, "苹果", {}, 1);
	expect(limited).toHaveLength(1);
});

test("search without an embedder uses keywords only and the index reports no vectors", async () => {
	const { index, add } = setup({ embedder: false });
	const a = add("水果摊在路口", 1);
	add("苹果手机降价了", 2);
	await index.idle();
	const scope = { spaceId: SPACE, channelId: "c1" };

	expect((await index.search(scope, "苹果", {}, 5)).map((hit) => hit.anchor.content)).toEqual(["苹果手机降价了"]);
	expect(index.relatedCount(a, BASE + 10)).toBeNull();
	expect(index.related(a, 5)).toEqual([]);
});

test("opted-out authors are never indexed and forgetAuthor removes existing rows and context lines", async () => {
	const { db, index, add } = setup();
	const scope = { spaceId: SPACE, channelId: "c1" };
	add("苹果 一", 1);
	add("苹果 退出者发言", 2, { author: "leaver" });
	add("苹果 三", 3);
	await index.idle();
	expect((await index.search(scope, "退出者", {}, 5)).map((hit) => hit.anchor.authorName)).toEqual(["leaver"]);

	new MemberMemory(db).forgetMember(SPACE, "leaver");
	index.forgetAuthor(SPACE, "leaver");
	expect(await index.search(scope, "退出者", {}, 5)).toEqual([]);
	const hits = await index.search(scope, "苹果", {}, 5);
	expect(hits.map((hit) => hit.anchor.content).sort()).toEqual(["苹果 一", "苹果 三"]);
	for (const hit of hits) expect(hit.context.map((line) => line.authorName)).not.toContain("leaver");

	// 退出之后的新消息不再入库。
	const later = add("苹果 退出者又说", 4, { author: "leaver" });
	await index.idle();
	expect(await index.search(scope, "退出者又说", {}, 5)).toEqual([]);
	expect(index.relatedCount(later, BASE + 10)).toBeNull();
});

test("forgetMember drops index rows through the registered listener", async () => {
	const { db, index, add } = setup();
	const memory = new MemberMemory(db);
	memory.onForget((spaceId, userId) => index.forgetAuthor(spaceId, userId));
	add("苹果 留下", 1);
	add("苹果 离开前", 2, { author: "leaver" });
	await index.idle();
	memory.forgetMember(SPACE, "leaver");
	const hits = await index.search({ spaceId: SPACE, channelId: "c1" }, "离开前", {}, 5);
	expect(hits).toEqual([]);
});

test("a short reply is embedded together with the message it quotes; a short plain message gets no vector", async () => {
	const { index, add } = setup();
	const quoted = add("苹果好吃", 1, { id: "q" });
	const reply = add("好的", 2, { replyTo: "q" });
	const plain = add("好的", 3);
	await index.idle();

	expect(index.relatedCount(reply, BASE + 10)).toBe(1);
	expect(index.relatedCount(plain, BASE + 10)).toBeNull();
	expect(index.related(reply, 5).map((hit) => hit.anchor.messageId)).toEqual([quoted.messageId]);
});

test("indexing is serial, ensure indexes queued keys on demand, and failures never throw", async () => {
	const { index, add, state, maxInflight } = setup();
	const keys = Array.from({ length: 5 }, (_, i) => add(`苹果话题${i}`, i));
	const last = add("苹果 最后", 10);
	await index.ensure([last]);
	expect(index.relatedCount(last, BASE + 100)).not.toBeNull();
	await index.idle();
	expect(maxInflight()).toBe(1);
	expect(index.relatedCount(keys[4]!, BASE + 4)).toBe(4);

	state.fail = true;
	const broken = add("苹果 嵌入失败", 20);
	await index.ensure([broken]);
	await index.idle();
	expect(index.relatedCount(broken, BASE + 100)).toBeNull();
	// 关键词仍然可用，嵌入恢复后 ensure 补齐向量。
	expect(await index.search({ spaceId: SPACE, channelId: "c1" }, "嵌入失败", {}, 5)).toHaveLength(1);
	state.fail = false;
	await index.ensure([broken]);
	expect(index.relatedCount(broken, BASE + 100)).toBeGreaterThan(0);
});
