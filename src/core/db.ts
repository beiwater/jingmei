import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { load } from "sqlite-vec";

const DB_FILE = "jingmei.db";

let extensibleSqlite: boolean | undefined;

/** macOS 的系统 SQLite 禁用扩展；必须在第一个数据库打开前选用 Homebrew SQLite。 */
export function useExtensibleSqlite(): boolean {
	extensibleSqlite ??= process.platform !== "darwin" || selectHomebrewSqlite();
	return extensibleSqlite;
}

function selectHomebrewSqlite(): boolean {
	for (const path of ["/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib", "/usr/local/opt/sqlite/lib/libsqlite3.dylib"])
		if (existsSync(path) && Database.setCustomSQLite(path)) return true;
	return false;
}

export function loadVectorExtension(db: Database): void {
	try {
		load(db);
	} catch {
		throw new Error("sqlite-vec 无法加载；macOS 需安装 Homebrew sqlite 并在打开数据库前调用 useExtensibleSqlite");
	}
}

/** 消息表与旧数据库的话题列迁移，共用一个幂等入口。 */
export function ensureMessagesTable(db: Database): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS messages (
			space_id TEXT NOT NULL,
			channel_id TEXT NOT NULL,
			message_id TEXT NOT NULL,
			author_id TEXT NOT NULL,
			author_name TEXT NOT NULL,
			is_bot INTEGER NOT NULL,
			content TEXT NOT NULL,
			reply_to_message_id TEXT,
			timestamp INTEGER NOT NULL,
			event_id INTEGER,
			PRIMARY KEY (space_id, channel_id, message_id)
		);
		CREATE TABLE IF NOT EXISTS inbound_pending (
			space_id TEXT NOT NULL,
			channel_id TEXT NOT NULL,
			message_id TEXT NOT NULL,
			payload TEXT NOT NULL,
			received_at INTEGER NOT NULL,
			PRIMARY KEY (space_id, channel_id, message_id)
		);
	`);
	const columns = db.query("PRAGMA table_info(messages)").all() as Array<{ name: string }>;
	if (!columns.some((column) => column.name === "event_id")) {
		db.exec("ALTER TABLE messages ADD COLUMN event_id INTEGER");
	}
	db.exec("CREATE INDEX IF NOT EXISTS messages_event ON messages(space_id, channel_id, event_id)");
	// 检索工具按频道时间取上下文与时间范围，不带它每次都要扫整个频道。
	db.exec("CREATE INDEX IF NOT EXISTS messages_channel_time ON messages(space_id, channel_id, timestamp)");
}

/**
 * 会话索引与对话段状态，以及带图消息的图片引用。`sessions` 在对话段机制前只有前五列；
 * 旧行的 `last_reply_at` 为空，因此第一次触发会开新段，离开旧的超长会话。
 */
export function ensureSessionTables(db: Database): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS sessions (
			persona_id TEXT NOT NULL,
			space_id TEXT NOT NULL,
			channel_id TEXT NOT NULL,
			session_file TEXT NOT NULL,
			updated_at INTEGER NOT NULL,
			PRIMARY KEY (persona_id, space_id, channel_id)
		);
		CREATE TABLE IF NOT EXISTS message_images (
			space_id TEXT NOT NULL,
			channel_id TEXT NOT NULL,
			message_id TEXT NOT NULL,
			images TEXT NOT NULL,
			PRIMARY KEY (space_id, channel_id, message_id)
		);
	`);
	const columns = new Set(
		(db.query("PRAGMA table_info(sessions)").all() as Array<{ name: string }>).map((column) => column.name),
	);
	for (const [name, type] of [
		["last_reply_at", "INTEGER"],
		["cursor_timestamp", "INTEGER"],
		["cursor_message_id", "TEXT"],
		["segment_start_at", "INTEGER"],
	] as const)
		if (!columns.has(name)) db.exec(`ALTER TABLE sessions ADD COLUMN ${name} ${type}`);
}

/** Open `data/jingmei.db`. */
export function openDatabase(dataDir: string): Database {
	useExtensibleSqlite();
	mkdirSync(dataDir, { recursive: true, mode: 0o700 });
	const path = join(dataDir, DB_FILE);
	const db = new Database(path);
	chmodSync(path, 0o600);
	// The operator CLI opens the same file while the bot runs; wait out its brief locks instead of failing.
	db.exec("PRAGMA busy_timeout = 5000");
	return db;
}
