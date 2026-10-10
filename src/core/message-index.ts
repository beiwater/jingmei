import type { Database } from "bun:sqlite";
import { errorCategory, log } from "../observability/log.ts";
import { ensureMessagesTable, loadVectorExtension } from "./db.ts";
import type { Embedder } from "./embedding.ts";
import { hasSubstantiveText } from "./events.ts";
import { ensureMemorySchema } from "./memory.ts";
import type { SpaceId } from "./types.ts";

// fast-bge-small-zh-v1.5 归一化向量的 L2 距离，按真实群聊快照（5166 条向量、随机 400 条取近邻）标定：
// 阈值 1.0 时 92% 的消息有 20 条以上“相关”，条数失去意义；0.7 时中位数 1 条、仅 3% 超过 20，
// 0.6–0.7 的样例基本是同一件事（“我有bybit”/“你要不来上 bybit”），0.8 以上开始混入无关句。
export const RELATED_MAX_DISTANCE = 0.7;
/** 查询与消息措辞不同，距离整体偏大：样例中真相关的命中落在 0.6–0.88。 */
const SEARCH_MAX_DISTANCE = 0.9;
/** “好的”“111”“那买”这类极短消息的向量离什么都近，会挤占相关条数与检索结果，只进关键词索引；回复例外，它带着被回复的正文一起嵌入。 */
const MIN_VECTOR_CHARS = 4;
export const RELATED_CAP = 20;

/** 每个命中前后各带的相邻消息条数。 */
const CONTEXT_NEIGHBOURS = 2;
/** 回复消息入向量时拼在前面的被回复正文长度；嵌入只看前 128 token，引用必须短。 */
const QUOTE_CHARS = 60;
/** 嵌入前先截断正文，避免超长消息白白付 tokenizer 成本。 */
const EMBED_CHARS = 400;
/** 词条短于 trigram 窗口时 FTS5 匹配不到，改用 LIKE。 */
const TRIGRAM_MIN_CHARS = 3;

export interface MessageKey {
	spaceId: SpaceId;
	channelId: string;
	messageId: string;
}

export interface HistoryLine {
	messageId: string;
	timestamp: number;
	authorName: string;
	isBot: boolean;
	content: string;
	replyToMessageId: string | null;
}

/** One retrieval hit: the anchor plus up to 2 neighbouring lines on each side (chronological, includes anchor). */
export interface HistoryHit {
	anchor: HistoryLine;
	context: HistoryLine[];
}

interface MessageRow {
	rowid: number;
	space_id: SpaceId;
	channel_id: string;
	message_id: string;
	author_id: string;
	author_name: string;
	is_bot: number;
	content: string;
	reply_to_message_id: string | null;
	timestamp: number;
}

interface KnnFilter {
	before?: number;
	from?: number;
	to?: number;
}

const SELECT_ROW = "SELECT m.rowid AS rowid, m.* FROM messages m";

function keyId(key: MessageKey): string {
	return `${key.spaceId}\n${key.channelId}\n${key.messageId}`;
}

function scopeOf(spaceId: string, channelId: string): string {
	return `${spaceId}\n${channelId}`;
}

function truncate(text: string, limit: number): string {
	const chars = [...text];
	return chars.length > limit ? chars.slice(0, limit).join("") : text;
}

function likePattern(term: string): string {
	return `%${term.replace(/[\\%_]/g, "\\$&")}%`;
}

function toLine(row: MessageRow): HistoryLine {
	return {
		messageId: row.message_id,
		timestamp: row.timestamp,
		authorName: row.author_name,
		isBot: row.is_bot === 1,
		content: row.content,
		replyToMessageId: row.reply_to_message_id,
	};
}

/**
 * Per-message retrieval index over the `messages` table: an FTS5 trigram keyword table plus (when an
 * embedder exists) a sqlite-vec table, both keyed by the `messages` rowid. Indexing runs one message at
 * a time in the background; the host is a single core, so batches would only starve the bot.
 */
export class MessageIndex {
	private readonly db: Database;
	private readonly embedder: Embedder | undefined;
	private readonly pending = new Map<string, MessageKey>();
	private draining: Promise<void> | null = null;
	private chain: Promise<unknown> = Promise.resolve();

	constructor(options: { db: Database; embedder?: Embedder }) {
		this.db = options.db;
		this.embedder = options.embedder;
		ensureMessagesTable(this.db);
		ensureMemorySchema(this.db);
		this.db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS message_fts USING fts5(content, tokenize='trigram')");
		if (this.embedder) {
			loadVectorExtension(this.db);
			// scope（space+channel）作分区键、sent_at 作 metadata，KNN 在分区内按时间过滤，不用先取全局最近邻再丢弃。
			this.db.exec(
				`CREATE VIRTUAL TABLE IF NOT EXISTS message_vectors USING vec0(scope text partition key, sent_at integer, embedding float[${this.embedder.dimensions}])`,
			);
		}
	}

	enqueue(key: MessageKey): void {
		this.pending.set(keyId(key), key);
		this.draining ??= this.drain();
	}

	async ensure(keys: readonly MessageKey[]): Promise<void> {
		for (const key of keys) {
			this.pending.delete(keyId(key));
			const row = this.findRow(key);
			if (!row || !this.needsWork(row)) continue;
			await this.serial(() => this.indexSafely(key));
		}
	}

	relatedCount(key: MessageKey, before: number): number | null {
		if (!this.embedder) return null;
		const row = this.findRow(key);
		const vector = row ? this.vectorOf(row.rowid) : null;
		if (!row || !vector) return null;
		// 自身可能也满足 sent_at < before，多取一个再剔除，保证上限仍是 RELATED_CAP + 1。
		const near = this.knn(vector, scopeOf(row.space_id, row.channel_id), RELATED_CAP + 2, { before });
		const count = near.filter((hit) => hit.rowid !== row.rowid && hit.distance <= RELATED_MAX_DISTANCE).length;
		return Math.min(count, RELATED_CAP + 1);
	}

	related(key: MessageKey, limit: number): HistoryHit[] {
		if (!this.embedder) return [];
		const row = this.findRow(key);
		const vector = row ? this.vectorOf(row.rowid) : null;
		if (!row || !vector) return [];
		const near = this.knn(vector, scopeOf(row.space_id, row.channel_id), limit + 1, {});
		const rows = this.rowsOf(near.filter((hit) => hit.rowid !== row.rowid && hit.distance <= RELATED_MAX_DISTANCE));
		return this.toHits(row.space_id, rows.slice(0, limit));
	}

	async search(
		scope: { spaceId: SpaceId; channelId: string },
		query: string,
		range: { from?: number; to?: number },
		limit: number,
	): Promise<HistoryHit[]> {
		const text = query.trim();
		if (!text) return [];
		const keyword = this.keywordRows(scope, text, range, limit);
		const semantic = await this.semanticRows(scope, text, range, limit);
		// 关键词与向量交替取，去重后各自的最佳命中都能进入结果。
		const merged: MessageRow[] = [];
		const seen = new Set<number>();
		for (let i = 0; merged.length < limit && (i < keyword.length || i < semantic.length); i++) {
			for (const row of [keyword[i], semantic[i]]) {
				if (!row || seen.has(row.rowid) || merged.length >= limit) continue;
				seen.add(row.rowid);
				merged.push(row);
			}
		}
		return this.toHits(scope.spaceId, merged);
	}

	forgetAuthor(spaceId: SpaceId, authorId: string): void {
		try {
			const rows = this.db
				.query("SELECT rowid, channel_id, message_id FROM messages WHERE space_id = ? AND author_id = ?")
				.all(spaceId, authorId) as Array<{ rowid: number; channel_id: string; message_id: string }>;
			for (const row of rows)
				this.pending.delete(keyId({ spaceId, channelId: row.channel_id, messageId: row.message_id }));
			this.db.transaction(() => {
				for (const { rowid } of rows) {
					this.db.query("DELETE FROM message_fts WHERE rowid = ?").run(rowid);
					if (this.embedder) this.db.query("DELETE FROM message_vectors WHERE rowid = ?").run(BigInt(rowid));
				}
			})();
		} catch (error) {
			log.error("core", "message_index_forget_failed", { error_category: errorCategory(error) });
		}
	}

	async idle(): Promise<void> {
		while (this.draining) await this.draining;
		await this.chain;
	}

	private async drain(): Promise<void> {
		try {
			for (;;) {
				const next = this.pending.entries().next();
				if (next.done) break;
				this.pending.delete(next.value[0]);
				await this.serial(() => this.indexSafely(next.value[1]));
			}
		} finally {
			this.draining = null;
		}
	}

	/** 所有嵌入与写入共用一条链：任何时刻最多一个嵌入在跑。 */
	private serial<T>(task: () => Promise<T>): Promise<T> {
		const run = this.chain.then(task);
		this.chain = run.catch(() => undefined);
		return run;
	}

	private async indexSafely(key: MessageKey): Promise<void> {
		try {
			await this.index(key);
		} catch (error) {
			log.error("core", "message_index_failed", { error_category: errorCategory(error) });
		}
	}

	private async index(key: MessageKey): Promise<void> {
		const row = this.findRow(key);
		if (!row || !this.needsWork(row)) return;
		const hasFts = this.hasFts(row.rowid);
		let vector: Float32Array | undefined;
		if (this.wantsVector(row) && !this.hasVector(row.rowid)) {
			try {
				[vector] = await this.embedder!.embed([this.embedText(row)]);
			} catch (error) {
				vector = undefined;
				log.error("core", "message_embedding_failed", { error_category: errorCategory(error) });
			}
		}
		this.db.transaction(() => {
			// 嵌入期间作者可能刚执行了 /forget：写入前再看一次。
			if (this.isOptedOut(row.space_id, row.author_id)) return;
			if (!hasFts) this.db.query("INSERT INTO message_fts(rowid, content) VALUES (?, ?)").run(row.rowid, row.content);
			if (vector && !this.hasVector(row.rowid))
				this.db
					.query("INSERT INTO message_vectors(rowid, scope, sent_at, embedding) VALUES (?, ?, ?, ?)")
					.run(BigInt(row.rowid), scopeOf(row.space_id, row.channel_id), row.timestamp, vector);
		})();
	}

	private needsWork(row: MessageRow): boolean {
		if (this.isOptedOut(row.space_id, row.author_id)) return false;
		return !this.hasFts(row.rowid) || (this.wantsVector(row) && !this.hasVector(row.rowid));
	}

	private wantsVector(row: MessageRow): boolean {
		if (!this.embedder || !hasSubstantiveText(row.content)) return false;
		return row.reply_to_message_id !== null || row.content.replace(/\s/g, "").length >= MIN_VECTOR_CHARS;
	}

	private embedText(row: MessageRow): string {
		const body = truncate(row.content, EMBED_CHARS);
		if (!row.reply_to_message_id) return body;
		const quoted = this.db
			.query("SELECT author_id, content FROM messages WHERE space_id = ? AND channel_id = ? AND message_id = ?")
			.get(row.space_id, row.channel_id, row.reply_to_message_id) as { author_id: string; content: string } | null;
		if (!quoted || this.isOptedOut(row.space_id, quoted.author_id)) return body;
		return `${truncate(quoted.content.replace(/\s+/g, " ").trim(), QUOTE_CHARS)}\n${body}`;
	}

	private findRow(key: MessageKey): MessageRow | null {
		return this.db
			.query(`${SELECT_ROW} WHERE m.space_id = ? AND m.channel_id = ? AND m.message_id = ?`)
			.get(key.spaceId, key.channelId, key.messageId) as MessageRow | null;
	}

	private hasFts(rowid: number): boolean {
		return !!this.db.query("SELECT 1 FROM message_fts WHERE rowid = ?").get(rowid);
	}

	private hasVector(rowid: number): boolean {
		return !!this.vectorOf(rowid);
	}

	private vectorOf(rowid: number): Uint8Array | null {
		const found = this.db.query("SELECT embedding FROM message_vectors WHERE rowid = ?").get(BigInt(rowid)) as {
			embedding: Uint8Array;
		} | null;
		return found?.embedding ?? null;
	}

	private isOptedOut(spaceId: string, userId: string): boolean {
		return !!this.db.query("SELECT 1 FROM memory_opt_out WHERE space_id = ? AND user_id = ?").get(spaceId, userId);
	}

	private knn(
		vector: Float32Array | Uint8Array,
		scope: string,
		k: number,
		filter: KnnFilter,
	): Array<{ rowid: number; distance: number }> {
		const conditions = ["embedding MATCH ?", "k = ?", "scope = ?"];
		const params: Array<Float32Array | Uint8Array | string | number> = [vector, k, scope];
		if (filter.before !== undefined) {
			conditions.push("sent_at < ?");
			params.push(filter.before);
		}
		if (filter.from !== undefined) {
			conditions.push("sent_at >= ?");
			params.push(filter.from);
		}
		if (filter.to !== undefined) {
			conditions.push("sent_at <= ?");
			params.push(filter.to);
		}
		return this.db
			.query(`SELECT rowid, distance FROM message_vectors WHERE ${conditions.join(" AND ")} ORDER BY distance`)
			.all(...params) as Array<{ rowid: number; distance: number }>;
	}

	private rowsOf(hits: ReadonlyArray<{ rowid: number }>): MessageRow[] {
		const rows: MessageRow[] = [];
		for (const hit of hits) {
			const row = this.db.query(`${SELECT_ROW} WHERE m.rowid = ?`).get(hit.rowid) as MessageRow | null;
			if (row) rows.push(row);
		}
		return rows;
	}

	private async semanticRows(
		scope: { spaceId: SpaceId; channelId: string },
		query: string,
		range: { from?: number; to?: number },
		limit: number,
	): Promise<MessageRow[]> {
		if (!this.embedder) return [];
		try {
			const [vector] = await this.serial(() => this.embedder!.embed([truncate(query, EMBED_CHARS)]));
			if (!vector) return [];
			// 多取一倍：距离阈值之外与已退出成员的行会被丢掉。
			const near = this.knn(vector, scopeOf(scope.spaceId, scope.channelId), limit * 2, range);
			return this.rowsOf(near.filter((hit) => hit.distance <= SEARCH_MAX_DISTANCE));
		} catch (error) {
			log.error("core", "message_search_embedding_failed", { error_category: errorCategory(error) });
			return [];
		}
	}

	private keywordRows(
		scope: { spaceId: SpaceId; channelId: string },
		query: string,
		range: { from?: number; to?: number },
		limit: number,
	): MessageRow[] {
		try {
			const terms = [...new Set(query.split(/\s+/).filter(Boolean))];
			const long = terms.filter((term) => [...term].length >= TRIGRAM_MIN_CHARS);
			const short = terms.filter((term) => [...term].length < TRIGRAM_MIN_CHARS);
			const params: Array<string | number> = [];
			const conditions: string[] = [];
			let from = "messages m";
			let order = "m.timestamp DESC, m.rowid DESC";
			if (long.length) {
				from = "message_fts JOIN messages m ON m.rowid = message_fts.rowid";
				conditions.push("message_fts MATCH ?");
				params.push(long.map((term) => `"${term.replaceAll('"', '""')}"`).join(" AND "));
				order = "message_fts.rank";
			}
			conditions.push("m.space_id = ?", "m.channel_id = ?");
			params.push(scope.spaceId, scope.channelId);
			if (range.from !== undefined) {
				conditions.push("m.timestamp >= ?");
				params.push(range.from);
			}
			if (range.to !== undefined) {
				conditions.push("m.timestamp <= ?");
				params.push(range.to);
			}
			for (const term of short) {
				conditions.push("m.content LIKE ? ESCAPE '\\'");
				params.push(likePattern(term));
			}
			params.push(limit);
			return this.db
				.query(`SELECT m.rowid AS rowid, m.* FROM ${from} WHERE ${conditions.join(" AND ")} ORDER BY ${order} LIMIT ?`)
				.all(...params) as MessageRow[];
		} catch (error) {
			log.error("core", "message_search_keyword_failed", { error_category: errorCategory(error) });
			return [];
		}
	}

	/** 锚点与上下文行都不得出现已退出（opt-out）作者；锚点本身被退出则整条命中丢弃。 */
	private toHits(spaceId: string, anchors: readonly MessageRow[]): HistoryHit[] {
		const optedOut = new Set(
			(
				this.db.query("SELECT user_id FROM memory_opt_out WHERE space_id = ?").all(spaceId) as Array<{
					user_id: string;
				}>
			).map((row) => row.user_id),
		);
		const visible = (row: MessageRow) => !optedOut.has(row.author_id);
		const hits: HistoryHit[] = [];
		for (const anchor of anchors) {
			if (!visible(anchor)) continue;
			const before = this.db
				.query(
					`${SELECT_ROW} WHERE m.space_id = ? AND m.channel_id = ? AND (m.timestamp < ? OR (m.timestamp = ? AND m.rowid < ?))
					ORDER BY m.timestamp DESC, m.rowid DESC LIMIT ?`,
				)
				.all(
					anchor.space_id,
					anchor.channel_id,
					anchor.timestamp,
					anchor.timestamp,
					anchor.rowid,
					CONTEXT_NEIGHBOURS,
				) as MessageRow[];
			const after = this.db
				.query(
					`${SELECT_ROW} WHERE m.space_id = ? AND m.channel_id = ? AND (m.timestamp > ? OR (m.timestamp = ? AND m.rowid > ?))
					ORDER BY m.timestamp ASC, m.rowid ASC LIMIT ?`,
				)
				.all(
					anchor.space_id,
					anchor.channel_id,
					anchor.timestamp,
					anchor.timestamp,
					anchor.rowid,
					CONTEXT_NEIGHBOURS,
				) as MessageRow[];
			hits.push({
				anchor: toLine(anchor),
				context: [...before.reverse(), anchor, ...after].filter(visible).map(toLine),
			});
		}
		return hits;
	}
}
