import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";

export const DB_FILE = "jingmei.db";
const LEGACY_DB_FILE = "discord-agent.db";

/**
 * Open `data/jingmei.db`, adopting the pre-rename Discord database (and its WAL/SHM side files)
 * when the new file does not exist yet, then migrate legacy `discord_*` tables in place.
 */
export function openDatabase(dataDir: string): Database {
	mkdirSync(dataDir, { recursive: true, mode: 0o700 });
	const path = join(dataDir, DB_FILE);
	const legacy = join(dataDir, LEGACY_DB_FILE);
	if (!existsSync(path) && existsSync(legacy)) {
		for (const suffix of ["-wal", "-shm"]) if (existsSync(legacy + suffix)) renameSync(legacy + suffix, path + suffix);
		renameSync(legacy, path);
	}
	const db = new Database(path);
	chmodSync(path, 0o600);
	migrateLegacyTables(db);
	return db;
}

/**
 * Idempotent: every `discord_*` table becomes its platform-neutral name (`discord_core_` also
 * loses `core_`), `guild_id` becomes `space_id`, and raw guild ids gain the `discord:` space
 * prefix. One transaction per database, so a partial migration never becomes visible.
 */
export function migrateLegacyTables(db: Database): void {
	const tables = (
		db
			.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'discord\\_%' ESCAPE '\\'")
			.all() as Array<{
			name: string;
		}>
	).map((row) => row.name);
	if (!tables.length) return;
	db.transaction(() => {
		for (const table of tables) {
			const target = table.replace(/^discord_(?:core_)?/, "");
			const exists = db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(target);
			if (exists) throw new Error(`legacy table ${table} conflicts with existing ${target}`);
			db.exec(`ALTER TABLE "${table}" RENAME TO "${target}"`);
			const columns = db.query(`PRAGMA table_info("${target}")`).all() as Array<{ name: string }>;
			if (!columns.some((column) => column.name === "guild_id")) continue;
			db.exec(`ALTER TABLE "${target}" RENAME COLUMN guild_id TO space_id`);
			db.exec(`UPDATE "${target}" SET space_id = 'discord:' || space_id`);
		}
	})();
}
