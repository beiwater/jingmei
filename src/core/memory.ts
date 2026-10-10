import type { Database } from "bun:sqlite";
import { errorCategory, log } from "../observability/log.ts";
import type { InboundMessage, SpaceId } from "./types.ts";

/** Scores each candidate's relevance to `query` in [0,1], same order; throws on failure. */
export type RelevanceScorer = (query: string, candidates: readonly string[]) => Promise<number[]>;

/** The only fact keys the model may save; the tool schema is built from this list. */
export const FACT_KEYS = ["preference", "interest", "role", "project", "timezone", "language", "goal", "note"] as const;
export type FactKey = (typeof FACT_KEYS)[number];

export interface MemberFactInput {
	spaceId: SpaceId;
	memberId: string;
	key: FactKey;
	value: string;
	sourceChannelId: string;
	sourceMessageId: string;
	observedAt?: number;
}

export interface MemberProfile {
	spaceId: SpaceId;
	userId: string;
	name: string;
	firstSeenAt: number;
	lastSeenAt: number;
	messageCount: number;
	birthday: { month: number; day: number } | null;
	facts: Array<{ key: string; value: string; updatedAt: number }>;
	relationships: Array<{ userId: string; name: string; type: string; count: number }>;
}

type ProfileRow = {
	space_id: SpaceId;
	user_id: string;
	name: string;
	first_seen_at: number;
	last_seen_at: number;
	message_count: number;
	birthday_month: number | null;
	birthday_day: number | null;
};

const MAX_FACT_VALUE_LENGTH = 300;
const MAX_RECALL_MEMBERS = 20;
const MAX_RECALL_CHARS = 2_000;
const RECALL_FACTS = 5;
const RECALL_RELATIONSHIPS = 4;
/** With a scorer, fetch this many times the kept count as ranking candidates. */
const SCORED_CANDIDATES = 4;
const SENSITIVE_KEY = /password|secret|token|credential|medical|health|religion|politic|sexual|address|phone|email/i;
const UNSAFE_FACT_VALUE =
	/[\r\n\u0000-\u001f]|(?:ignore|disregard).{0,24}(?:instructions|prompt)|(?:忽略|无视).{0,12}(?:指令|提示词)|(?:api[_ -]?key|password|token|secret)\s*[:=]|\b(?:sk-[a-z0-9_-]{16,}|gh[pousr]_[a-z0-9]{20,})\b|[\w.+-]+@[\w.-]+\.[a-z]{2,}/i;

const SCHEMA = `
	CREATE TABLE IF NOT EXISTS memory_profiles (
		space_id TEXT NOT NULL,
		user_id TEXT NOT NULL,
		name TEXT NOT NULL,
		preferred_name INTEGER NOT NULL DEFAULT 0,
		first_seen_at INTEGER NOT NULL,
		last_seen_at INTEGER NOT NULL,
		message_count INTEGER NOT NULL DEFAULT 0,
		birthday_month INTEGER,
		birthday_day INTEGER,
		birthday_source_channel_id TEXT,
		birthday_source_message_id TEXT,
		birthday_updated_at INTEGER,
		PRIMARY KEY (space_id, user_id),
		CHECK ((birthday_month IS NULL AND birthday_day IS NULL) OR (birthday_month BETWEEN 1 AND 12 AND birthday_day BETWEEN 1 AND 31))
	);
	CREATE TABLE IF NOT EXISTS memory_facts (
		space_id TEXT NOT NULL,
		user_id TEXT NOT NULL,
		fact_key TEXT NOT NULL,
		value TEXT NOT NULL,
		source_channel_id TEXT NOT NULL,
		source_message_id TEXT NOT NULL,
		observed_at INTEGER NOT NULL,
		PRIMARY KEY (space_id, user_id, fact_key)
	);
	CREATE TABLE IF NOT EXISTS memory_relationships (
		space_id TEXT NOT NULL,
		member_a TEXT NOT NULL,
		member_b TEXT NOT NULL,
		relation_type TEXT NOT NULL,
		occurrence_count INTEGER NOT NULL DEFAULT 1,
		source_channel_id TEXT NOT NULL,
		source_message_id TEXT NOT NULL,
		updated_at INTEGER NOT NULL,
		PRIMARY KEY (space_id, member_a, member_b, relation_type),
		CHECK (member_a < member_b)
	);
	CREATE TABLE IF NOT EXISTS memory_observed_messages (
		space_id TEXT NOT NULL,
		channel_id TEXT NOT NULL,
		message_id TEXT NOT NULL,
		PRIMARY KEY (space_id, channel_id, message_id)
	);
	CREATE TABLE IF NOT EXISTS memory_opt_out (
		space_id TEXT NOT NULL,
		user_id TEXT NOT NULL,
		opted_out_at INTEGER NOT NULL,
		PRIMARY KEY (space_id, user_id)
	);
`;

/** Idempotent; also used by components that only read `memory_opt_out`. */
export function ensureMemorySchema(db: Database): void {
	db.exec(SCHEMA);
}

/** Small, space-scoped durable member memory shared by every platform. */
export class MemberMemory {
	private readonly db: Database;
	private readonly forgetListeners: Array<(spaceId: SpaceId, userId: string) => void> = [];

	constructor(db: Database) {
		this.db = db;
		ensureMemorySchema(db);
	}

	/** Called after `forgetMember` commits, so derived stores (message index) can drop that member's rows. */
	onForget(listener: (spaceId: SpaceId, userId: string) => void): void {
		this.forgetListeners.push(listener);
	}

	/** Record one message once, update profile activity, and maintain evidenced social edges. */
	observe(message: InboundMessage, botUserIds: ReadonlySet<string> = new Set()): void {
		if (message.isBot || botUserIds.has(message.authorId)) return;
		const at = finiteTimestamp(message.timestamp);
		this.db.transaction(() => {
			const inserted =
				this.db
					.query("INSERT OR IGNORE INTO memory_observed_messages (space_id, channel_id, message_id) VALUES (?, ?, ?)")
					.run(message.spaceId, message.channelId, message.messageId).changes > 0;
			if (!inserted) return;
			if (this.isOptedOut(message.spaceId, message.authorId)) return;
			this.upsertProfile(message.spaceId, message.authorId, message.authorName, at);
			const statedName = extractOwnName(message.content);
			if (statedName) {
				this.db
					.query("UPDATE memory_profiles SET name = ?, preferred_name = 1 WHERE space_id = ? AND user_id = ?")
					.run(statedName, message.spaceId, message.authorId);
			}
			const preference = extractOwnPreference(message.content);
			if (preference && !UNSAFE_FACT_VALUE.test(preference)) {
				this.db
					.query(`INSERT INTO memory_facts
					(space_id,user_id,fact_key,value,source_channel_id,source_message_id,observed_at)
					VALUES (?,?,?,?,?,?,?) ON CONFLICT(space_id,user_id,fact_key) DO UPDATE SET
					value=excluded.value,source_channel_id=excluded.source_channel_id,
					source_message_id=excluded.source_message_id,observed_at=excluded.observed_at`)
					.run(message.spaceId, message.authorId, "preference", preference, message.channelId, message.messageId, at);
			}
			const targets = new Set(message.mentionedUserIds ?? []);
			if (message.replyToAuthorId) targets.add(message.replyToAuthorId);
			for (const targetId of targets) {
				if (targetId === message.authorId || botUserIds.has(targetId) || this.isOptedOut(message.spaceId, targetId))
					continue;
				const targetName = this.lookupName(message.spaceId, targetId) ?? targetId;
				this.upsertRelationship(message.spaceId, message.authorId, targetId, "interaction", message, at);
				const declaration = message.mentionedUserIds?.includes(targetId) ? explicitRelationship(message.content) : null;
				if (declaration) this.upsertRelationship(message.spaceId, message.authorId, targetId, declaration, message, at);
				// Names are only refreshed when a member has previously spoken in this space.
				if (targetName !== targetId) this.upsertProfile(message.spaceId, targetId, targetName, at, false);
			}
			const birthday = extractOwnBirthday(message.content);
			if (birthday)
				this.writeBirthday(
					message.spaceId,
					message.authorId,
					birthday.month,
					birthday.day,
					message.channelId,
					message.messageId,
					at,
				);
		})();
	}

	rememberFact(input: MemberFactInput): void {
		const value = input.value.trim();
		if (!value || value.length > MAX_FACT_VALUE_LENGTH || UNSAFE_FACT_VALUE.test(value))
			throw new Error("invalid_memory_fact_value");
		const at = finiteTimestamp(input.observedAt);
		this.db.transaction(() => {
			if (this.isOptedOut(input.spaceId, input.memberId)) throw new Error("memory_opted_out");
			this.upsertProfile(
				input.spaceId,
				input.memberId,
				this.lookupName(input.spaceId, input.memberId) ?? input.memberId,
				at,
				false,
			);
			this.db
				.query(`
				INSERT INTO memory_facts
				(space_id, user_id, fact_key, value, source_channel_id, source_message_id, observed_at)
				VALUES (?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT(space_id, user_id, fact_key) DO UPDATE SET
				value=excluded.value, source_channel_id=excluded.source_channel_id,
				source_message_id=excluded.source_message_id, observed_at=excluded.observed_at
			`)
				.run(input.spaceId, input.memberId, input.key, value, input.sourceChannelId, input.sourceMessageId, at);
		})();
	}

	/** Resolve only names/ids of humans visible to the current channel turn; never expose candidates. */
	resolveMember(
		spaceId: SpaceId,
		member: string,
		visibleMemberIds: ReadonlySet<string>,
	): { userId: string } | { error: "member_not_recently_visible" | "member_ambiguous" } {
		const requested = member.trim();
		if (visibleMemberIds.has(requested)) return { userId: requested };
		const ids = [...visibleMemberIds];
		if (!ids.length) return { error: "member_not_recently_visible" };
		const visible = this.db
			.query(
				`SELECT user_id, name FROM memory_profiles WHERE space_id = ? AND user_id IN (${ids.map(() => "?").join(",")})`,
			)
			.all(spaceId, ...ids) as Array<{ user_id: string; name: string }>;
		const exact = visible.filter((profile) => profile.name === requested);
		const matches = exact.length
			? exact
			: visible.filter((profile) => profile.name.toLowerCase() === requested.toLowerCase());
		if (matches.length > 1) return { error: "member_ambiguous" };
		return matches[0] ? { userId: matches[0].user_id } : { error: "member_not_recently_visible" };
	}

	/**
	 * Return a compact, bounded memory snippet; every lookup is constrained to this space.
	 * With `relevance`, candidate facts/relationships are ranked against the query in one scorer
	 * call; without it (or when scoring fails) the most recent facts and strongest edges win.
	 */
	async recall(
		spaceId: SpaceId,
		memberIds: readonly string[],
		relevance?: { query: string; score: RelevanceScorer },
	): Promise<string> {
		const ids = [...new Set(memberIds)].slice(0, MAX_RECALL_MEMBERS).filter((id) => !this.isOptedOut(spaceId, id));
		if (!ids.length) return "";
		const marks = ids.map(() => "?").join(",");
		const profiles = this.db
			.query(`
			SELECT user_id, name, birthday_month, birthday_day, message_count FROM memory_profiles
			WHERE space_id = ? AND user_id IN (${marks}) ORDER BY last_seen_at DESC LIMIT ${MAX_RECALL_MEMBERS}
		`)
			.all(spaceId, ...ids) as Array<{
			user_id: string;
			name: string;
			birthday_month: number | null;
			birthday_day: number | null;
			message_count: number;
		}>;
		const candidateLimit = relevance ? SCORED_CANDIDATES : 1;
		const entries = profiles.map((profile) => {
			const facts = this.db
				.query(
					`SELECT fact_key, value FROM memory_facts WHERE space_id = ? AND user_id = ? ORDER BY observed_at DESC LIMIT ?`,
				)
				.all(spaceId, profile.user_id, RECALL_FACTS * candidateLimit) as Array<{ fact_key: string; value: string }>;
			const rels = this.db
				.query(`
				SELECT r.member_a, r.member_b, r.relation_type, p.name
				FROM memory_relationships r
				LEFT JOIN memory_profiles p ON p.space_id = r.space_id AND p.user_id = CASE WHEN r.member_a = ? THEN r.member_b ELSE r.member_a END
				WHERE r.space_id = ? AND (r.member_a = ? OR r.member_b = ?) ORDER BY r.occurrence_count DESC LIMIT ?
			`)
				.all(
					profile.user_id,
					spaceId,
					profile.user_id,
					profile.user_id,
					RECALL_RELATIONSHIPS * candidateLimit,
				) as Array<{
				member_a: string;
				member_b: string;
				relation_type: string;
				name: string | null;
			}>;
			return {
				profile,
				facts: facts.map((fact) => `${fact.fact_key}: ${fact.value}`),
				rels: rels.map(
					(rel) =>
						`${rel.relation_type}: ${rel.name ?? (rel.member_a === profile.user_id ? rel.member_b : rel.member_a)}`,
				),
			};
		});
		const scores = relevance ? await this.scoreCandidates(entries, relevance) : null;
		let offset = 0;
		const lines: string[] = [];
		for (const entry of entries) {
			const factScores = scores?.slice(offset, offset + entry.facts.length);
			offset += entry.facts.length;
			const relScores = scores?.slice(offset, offset + entry.rels.length);
			offset += entry.rels.length;
			const details = topByScore(entry.facts, factScores, RECALL_FACTS);
			if (entry.profile.birthday_month && entry.profile.birthday_day)
				details.push(`生日: ${entry.profile.birthday_month}月${entry.profile.birthday_day}日`);
			details.push(...topByScore(entry.rels, relScores, RECALL_RELATIONSHIPS));
			if (!details.length) details.push(`已在群里发言 ${entry.profile.message_count} 次`);
			lines.push(`${entry.profile.name}：${details.join("；")}`);
		}
		return truncate(lines.join("\n"), MAX_RECALL_CHARS);
	}

	private async scoreCandidates(
		entries: ReadonlyArray<{ profile: { name: string }; facts: string[]; rels: string[] }>,
		relevance: { query: string; score: RelevanceScorer },
	): Promise<number[] | null> {
		const candidates = entries.flatMap((entry) =>
			[...entry.facts, ...entry.rels].map((detail) => `${entry.profile.name}：${detail}`),
		);
		if (!candidates.length || !relevance.query.trim()) return null;
		try {
			return await relevance.score(relevance.query, candidates);
		} catch (error) {
			log.warn("core", "memory_scoring_failed", { error_category: errorCategory(error) });
			return null;
		}
	}

	getProfile(spaceId: SpaceId, userId: string): MemberProfile | null {
		if (this.isOptedOut(spaceId, userId)) return null;
		const row = this.db
			.query("SELECT * FROM memory_profiles WHERE space_id = ? AND user_id = ?")
			.get(spaceId, userId) as ProfileRow | null;
		if (!row) return null;
		const facts = this.db
			.query(
				"SELECT fact_key, value, observed_at FROM memory_facts WHERE space_id = ? AND user_id = ? ORDER BY fact_key",
			)
			.all(spaceId, userId) as Array<{ fact_key: string; value: string; observed_at: number }>;
		const relationships = this.db
			.query(`
			SELECT r.member_a, r.member_b, r.relation_type, r.occurrence_count, p.name
			FROM memory_relationships r
			LEFT JOIN memory_profiles p ON p.space_id = r.space_id AND p.user_id = CASE WHEN r.member_a = ? THEN r.member_b ELSE r.member_a END
			WHERE r.space_id = ? AND (r.member_a = ? OR r.member_b = ?)
		`)
			.all(userId, spaceId, userId, userId) as Array<{
			member_a: string;
			member_b: string;
			relation_type: string;
			occurrence_count: number;
			name: string | null;
		}>;
		return {
			spaceId: row.space_id,
			userId: row.user_id,
			name: row.name,
			firstSeenAt: row.first_seen_at,
			lastSeenAt: row.last_seen_at,
			messageCount: row.message_count,
			birthday: row.birthday_month && row.birthday_day ? { month: row.birthday_month, day: row.birthday_day } : null,
			facts: facts.map((fact) => ({ key: fact.fact_key, value: fact.value, updatedAt: fact.observed_at })),
			relationships: relationships.map((rel) => ({
				userId: rel.member_a === userId ? rel.member_b : rel.member_a,
				name: rel.name ?? (rel.member_a === userId ? rel.member_b : rel.member_a),
				type: rel.relation_type,
				count: rel.occurrence_count,
			})),
		};
	}

	setBirthday(
		spaceId: SpaceId,
		userId: string,
		month: number,
		day: number,
		sourceChannelId?: string,
		sourceMessageId?: string,
	): void {
		assertBirthday(month, day);
		this.db.transaction(() => {
			if (this.isOptedOut(spaceId, userId)) throw new Error("memory_opted_out");
			const name = this.lookupName(spaceId, userId) ?? userId;
			this.upsertProfile(spaceId, userId, name, Date.now(), false);
			this.writeBirthday(spaceId, userId, month, day, sourceChannelId ?? "", sourceMessageId ?? "", Date.now());
		})();
	}

	clearBirthday(spaceId: SpaceId, userId: string): void {
		this.db
			.query(`UPDATE memory_profiles SET birthday_month = NULL, birthday_day = NULL,
			birthday_source_channel_id = NULL, birthday_source_message_id = NULL, birthday_updated_at = NULL
			WHERE space_id = ? AND user_id = ?`)
			.run(spaceId, userId);
	}

	listBirthdays(spaceId: SpaceId, month: number, day: number): { userId: string; name: string }[] {
		assertBirthday(month, day);
		return this.db
			.query(`SELECT p.user_id AS userId, p.name FROM memory_profiles p
			WHERE p.space_id = ? AND p.birthday_month = ? AND p.birthday_day = ?
			AND NOT EXISTS (SELECT 1 FROM memory_opt_out o WHERE o.space_id = p.space_id AND o.user_id = p.user_id)
			ORDER BY p.name, p.user_id`)
			.all(spaceId, month, day) as Array<{ userId: string; name: string }>;
	}

	forgetMember(spaceId: SpaceId, userId: string): void {
		this.db.transaction(() => {
			this.db.query("DELETE FROM memory_profiles WHERE space_id = ? AND user_id = ?").run(spaceId, userId);
			this.db.query("DELETE FROM memory_facts WHERE space_id = ? AND user_id = ?").run(spaceId, userId);
			this.db
				.query("DELETE FROM memory_relationships WHERE space_id = ? AND (member_a = ? OR member_b = ?)")
				.run(spaceId, userId, userId);
			this.db
				.query(
					"INSERT INTO memory_opt_out (space_id,user_id,opted_out_at) VALUES (?,?,?) ON CONFLICT(space_id,user_id) DO UPDATE SET opted_out_at=excluded.opted_out_at",
				)
				.run(spaceId, userId, Date.now());
		})();
		for (const listener of this.forgetListeners) listener(spaceId, userId);
	}

	enableMember(spaceId: SpaceId, userId: string): void {
		this.db.query("DELETE FROM memory_opt_out WHERE space_id = ? AND user_id = ?").run(spaceId, userId);
	}

	private isOptedOut(spaceId: string, userId: string): boolean {
		return !!this.db
			.query("SELECT 1 AS found FROM memory_opt_out WHERE space_id = ? AND user_id = ?")
			.get(spaceId, userId);
	}

	private lookupName(spaceId: string, userId: string): string | null {
		const row = this.db
			.query("SELECT name FROM memory_profiles WHERE space_id = ? AND user_id = ?")
			.get(spaceId, userId) as { name: string } | null;
		return row?.name ?? null;
	}

	private upsertProfile(spaceId: string, userId: string, name: string, at: number, countMessage = true): void {
		const clean = cleanName(name) || userId;
		this.db
			.query(`INSERT INTO memory_profiles (space_id,user_id,name,first_seen_at,last_seen_at,message_count)
			VALUES (?,?,?,?,?,?) ON CONFLICT(space_id,user_id) DO UPDATE SET
			name=CASE WHEN memory_profiles.preferred_name = 1 THEN memory_profiles.name ELSE excluded.name END,
			last_seen_at=MAX(memory_profiles.last_seen_at,excluded.last_seen_at),
			message_count=memory_profiles.message_count + excluded.message_count`)
			.run(spaceId, userId, clean, at, at, countMessage ? 1 : 0);
	}

	private upsertRelationship(
		spaceId: string,
		left: string,
		right: string,
		type: string,
		message: InboundMessage,
		at: number,
	): void {
		const [a, b] = left < right ? [left, right] : [right, left];
		this.db
			.query(`INSERT INTO memory_relationships
			(space_id,member_a,member_b,relation_type,occurrence_count,source_channel_id,source_message_id,updated_at)
			VALUES (?,?,?,?,1,?,?,?) ON CONFLICT(space_id,member_a,member_b,relation_type) DO UPDATE SET
			occurrence_count=memory_relationships.occurrence_count+1,
			source_channel_id=excluded.source_channel_id, source_message_id=excluded.source_message_id, updated_at=excluded.updated_at`)
			.run(spaceId, a, b, type, message.channelId, message.messageId, at);
	}

	private writeBirthday(
		spaceId: string,
		userId: string,
		month: number,
		day: number,
		channelId: string,
		messageId: string,
		at: number,
	): void {
		this.db
			.query(`UPDATE memory_profiles SET birthday_month=?, birthday_day=?,
			birthday_source_channel_id=?, birthday_source_message_id=?, birthday_updated_at=?
			WHERE space_id=? AND user_id=?`)
			.run(month, day, channelId, messageId, at, spaceId, userId);
	}
}

function cleanName(name: string): string {
	return name
		.replace(/[\r\n\u0000-\u001f]/g, " ")
		.trim()
		.slice(0, 80);
}

function finiteTimestamp(value?: number): number {
	return value !== undefined && Number.isFinite(value) ? Math.trunc(value) : Date.now();
}

function assertBirthday(month: number, day: number): void {
	const max = month === 2 ? 29 : [4, 6, 9, 11].includes(month) ? 30 : 31;
	if (!Number.isInteger(month) || month < 1 || month > 12 || !Number.isInteger(day) || day < 1 || day > max)
		throw new Error("invalid_birthday");
}

function extractOwnBirthday(text: string): { month: number; day: number } | null {
	const value = text.trim();
	const chinese = value.match(
		/^(?:我(?:的)?生日(?:是|在)?|本人生日(?:是|在)?)\s*(\d{1,2})\s*月\s*(\d{1,2})\s*(?:日|号|號)?(?:[。.!！,，\s]|$)/i,
	);
	if (chinese) return validBirthday(Number(chinese[1]), Number(chinese[2]));
	const english = value.match(
		/^(?:my birthday is|i was born on|i celebrate my birthday on)\s+(?:([A-Za-z]+)\s+(\d{1,2})|(\d{1,2})[/-](\d{1,2}))(?:[,.!\s]|$)/i,
	);
	if (!english) return null;
	if (english[1]) {
		const month = monthNumber(english[1]);
		return month ? validBirthday(month, Number(english[2])) : null;
	}
	return validBirthday(Number(english[3]), Number(english[4]));
}

function extractOwnName(text: string): string | null {
	const value = text.trim();
	if (/[?？]$/.test(value) || /吗$/.test(value)) return null;
	const match = value.match(
		/^(?:我(?:叫|的名字是)|请叫我|call me|my name is)\s*([^，。,.!！?？\n]{1,40})(?:[，。,.!！?？\s]|$)/i,
	);
	if (!match) return null;
	const name = cleanName(match[1] ?? "");
	return name && !SENSITIVE_KEY.test(name) ? name : null;
}

function extractOwnPreference(text: string): string | null {
	const valueText = text.trim();
	const chinese = valueText.match(/^(?:我(?:很)?喜欢|我最喜欢|我偏好)\s*(.{1,200})$/);
	const english = valueText.match(/^i\s+(?:really\s+)?(?:like|love|prefer)\s+(.{1,200})$/i);
	const match = chinese ?? english;
	if (!match) return null;
	const value = (match[1] ?? "").replace(/[。.!！?？]+$/, "").trim();
	if (!value || value.length > 200 || /[?？]$/.test(text.trim()) || /吗$/.test(value) || SENSITIVE_KEY.test(value))
		return null;
	return value;
}

const MONTH_NAMES = Array.from({ length: 12 }, (_, month) =>
	new Date(Date.UTC(2000, month, 1)).toLocaleString("en", { month: "long", timeZone: "UTC" }).toLowerCase(),
);

function monthNumber(value: string): number | null {
	const index = MONTH_NAMES.findIndex((month) => month.startsWith(value.toLowerCase()));
	return index < 0 ? null : index + 1;
}

function validBirthday(month: number, day: number): { month: number; day: number } | null {
	try {
		assertBirthday(month, day);
		return { month, day };
	} catch {
		return null;
	}
}

/** Only called for members the adapter resolved as explicitly mentioned in this message. */
function explicitRelationship(text: string): string | null {
	if (/(?:是|就是)(?:我|本人)?的?(?:好)?朋友|my\s+(?:good\s+)?friend/i.test(text)) return "friend";
	if (/(?:是|就是)(?:我|本人)?的?同学|my\s+classmate/i.test(text)) return "classmate";
	return null;
}

function truncate(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** Keep `limit` items: highest score first when scored, else the caller's recency/strength order. */
function topByScore(items: readonly string[], scores: readonly number[] | undefined, limit: number): string[] {
	if (!scores) return items.slice(0, limit);
	return items
		.map((item, index) => ({ item, index, score: scores[index] ?? 0 }))
		.sort((a, b) => b.score - a.score || a.index - b.index)
		.slice(0, limit)
		.map((entry) => entry.item);
}
