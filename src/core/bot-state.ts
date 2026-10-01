import type { Database } from "bun:sqlite";

/** A run whose last heartbeat is older than two beats is treated as no longer running. */
export const HEARTBEAT_MS = 60_000;
const DAY_MS = 24 * 60 * 60_000;

const SCHEMA = `
	CREATE TABLE IF NOT EXISTS bot_runs (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		started_at INTEGER NOT NULL,
		last_seen_at INTEGER NOT NULL,
		stopped_at INTEGER,
		replies INTEGER NOT NULL DEFAULT 0
	);
	CREATE TABLE IF NOT EXISTS bot_pause (
		id INTEGER PRIMARY KEY CHECK (id = 1),
		paused_at INTEGER NOT NULL
	);
	CREATE TABLE IF NOT EXISTS persona_models (
		persona_id TEXT PRIMARY KEY,
		provider TEXT NOT NULL,
		model TEXT NOT NULL,
		updated_at INTEGER NOT NULL
	);
`;

export interface BotSummary {
	pausedAt: number | null;
	/** The live run, if a heartbeat arrived within two beats. */
	current: { startedAt: number; replies: number } | null;
	/** End of the latest finished or crashed run while nothing is live. */
	lastSeenAt: number | null;
	runs: number;
	firstStartedAt: number | null;
	runtimeMs: number;
	replies: number;
	messages: number;
	messagesLast24h: number;
	groups: number;
	members: number;
	topics: number;
	celebrations: number;
}

/**
 * Operator-visible bot state in SQLite, shared between the running bot and the CLI: a run history
 * (heartbeat, stop time, reply count), a pause flag and per-persona model overrides, all surviving restarts.
 */
export class BotState {
	private runId: number | null = null;

	constructor(private readonly db: Database) {
		db.exec(SCHEMA);
	}

	pausedAt(): number | null {
		return this.db.query<{ paused_at: number }, []>("SELECT paused_at FROM bot_pause").get()?.paused_at ?? null;
	}

	/** False when already paused; the original pause time is kept. */
	pause(now = Date.now()): boolean {
		return this.db.query("INSERT OR IGNORE INTO bot_pause (id, paused_at) VALUES (1, ?)").run(now).changes > 0;
	}

	/** False when not paused. */
	resume(): boolean {
		return this.db.query("DELETE FROM bot_pause").run().changes > 0;
	}

	/** The operator-selected model, or null when the persona runs its configured model. */
	modelOverride(personaId: string): { provider: string; model: string } | null {
		return this.db
			.query<{ provider: string; model: string }, [string]>(
				"SELECT provider, model FROM persona_models WHERE persona_id = ?",
			)
			.get(personaId);
	}

	setModelOverride(personaId: string, provider: string, model: string, now = Date.now()): void {
		this.db
			.query(`
			INSERT INTO persona_models (persona_id, provider, model, updated_at) VALUES (?, ?, ?, ?)
			ON CONFLICT(persona_id) DO UPDATE SET provider = excluded.provider, model = excluded.model, updated_at = excluded.updated_at
		`)
			.run(personaId, provider, model, now);
	}

	clearModelOverride(personaId: string): void {
		this.db.query("DELETE FROM persona_models WHERE persona_id = ?").run(personaId);
	}

	startRun(now = Date.now()): void {
		this.runId = Number(
			this.db.query("INSERT INTO bot_runs (started_at, last_seen_at) VALUES (?, ?)").run(now, now).lastInsertRowid,
		);
	}

	heartbeat(now = Date.now()): void {
		this.db.query("UPDATE bot_runs SET last_seen_at = ? WHERE id = ?").run(now, this.runId);
	}

	stopRun(now = Date.now()): void {
		this.db.query("UPDATE bot_runs SET last_seen_at = ?, stopped_at = ? WHERE id = ?").run(now, now, this.runId);
		this.runId = null;
	}

	/** Counts one sent reply against the current run; a no-op outside a run. */
	recordReply(): void {
		this.db.query("UPDATE bot_runs SET replies = replies + 1 WHERE id = ?").run(this.runId);
	}

	summary(now = Date.now()): BotSummary {
		const totals = this.db
			.query<{ runs: number; first_started_at: number | null; runtime_ms: number; replies: number }, []>(
				`SELECT COUNT(*) AS runs, MIN(started_at) AS first_started_at,
				COALESCE(SUM(COALESCE(stopped_at, last_seen_at) - started_at), 0) AS runtime_ms,
				COALESCE(SUM(replies), 0) AS replies
				FROM bot_runs`,
			)
			.get() ?? { runs: 0, first_started_at: null, runtime_ms: 0, replies: 0 };
		const latest = this.db
			.query<{ started_at: number; last_seen_at: number; stopped_at: number | null; replies: number }, []>(
				"SELECT started_at, last_seen_at, stopped_at, replies FROM bot_runs ORDER BY id DESC LIMIT 1",
			)
			.get();
		const live = latest !== null && latest.stopped_at === null && now - latest.last_seen_at < 2 * HEARTBEAT_MS;
		// Tables belong to modules that may never have run; a missing table counts as empty.
		const tables = new Set(
			this.db
				.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'")
				.all()
				.map((row) => row.name),
		);
		const count = (table: string, sql: string, ...params: number[]): number =>
			tables.has(table) ? (this.db.query<{ n: number }, number[]>(sql).get(...params)?.n ?? 0) : 0;
		return {
			pausedAt: this.pausedAt(),
			current: live ? { startedAt: latest.started_at, replies: latest.replies } : null,
			lastSeenAt: live ? null : (latest?.last_seen_at ?? null),
			runs: totals.runs,
			firstStartedAt: totals.first_started_at,
			// The live run is counted up to now, not just its last heartbeat.
			runtimeMs: totals.runtime_ms + (live ? now - latest.last_seen_at : 0),
			replies: totals.replies,
			messages: count("messages", "SELECT COUNT(*) AS n FROM messages"),
			messagesLast24h: count("messages", "SELECT COUNT(*) AS n FROM messages WHERE timestamp >= ?", now - DAY_MS),
			groups: count("messages", "SELECT COUNT(DISTINCT space_id) AS n FROM messages"),
			members: count("memory_profiles", "SELECT COUNT(*) AS n FROM memory_profiles"),
			topics: count("events", "SELECT COUNT(*) AS n FROM events"),
			celebrations: count(
				"celebration_deliveries",
				"SELECT COUNT(*) AS n FROM celebration_deliveries WHERE status = 'sent'",
			),
		};
	}
}
