import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/core/db.ts";
import { MemberMemory } from "../src/core/memory.ts";
import { SoulStore } from "../src/core/soul.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** The pre-rename Discord schema, as created by the old discord core/memory/soul/celebration modules. */
function writeLegacyDatabase(path: string): void {
	const db = new Database(path);
	db.exec(`
		CREATE TABLE discord_core_sessions (persona_id TEXT NOT NULL, guild_id TEXT NOT NULL, channel_id TEXT NOT NULL,
			session_file TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (persona_id, guild_id, channel_id));
		CREATE TABLE discord_core_messages (guild_id TEXT NOT NULL, channel_id TEXT NOT NULL, message_id TEXT NOT NULL,
			author_id TEXT NOT NULL, author_name TEXT NOT NULL, is_bot INTEGER NOT NULL, content TEXT NOT NULL,
			reply_to_message_id TEXT, timestamp INTEGER NOT NULL, PRIMARY KEY (guild_id, channel_id, message_id));
		CREATE TABLE discord_memory_profiles (guild_id TEXT NOT NULL, user_id TEXT NOT NULL, name TEXT NOT NULL,
			preferred_name INTEGER NOT NULL DEFAULT 0, first_seen_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL,
			message_count INTEGER NOT NULL DEFAULT 0, birthday_month INTEGER, birthday_day INTEGER,
			birthday_source_channel_id TEXT, birthday_source_message_id TEXT, birthday_updated_at INTEGER,
			PRIMARY KEY (guild_id, user_id));
		CREATE TABLE discord_memory_opt_out (guild_id TEXT NOT NULL, user_id TEXT NOT NULL, opted_out_at INTEGER NOT NULL,
			PRIMARY KEY (guild_id, user_id));
		CREATE TABLE discord_session_souls (persona_id TEXT NOT NULL, guild_id TEXT NOT NULL, channel_id TEXT NOT NULL,
			formal TEXT NOT NULL DEFAULT '', pending TEXT NOT NULL DEFAULT '', updated_at INTEGER NOT NULL,
			PRIMARY KEY (persona_id, guild_id, channel_id));
		INSERT INTO discord_core_sessions VALUES ('luna', '111', '222', '/sessions/a.jsonl', 1);
		INSERT INTO discord_core_messages VALUES ('111', '222', '333', '444', 'alice', 0, 'hi', NULL, 1);
		INSERT INTO discord_memory_profiles (guild_id, user_id, name, first_seen_at, last_seen_at, message_count, birthday_month, birthday_day)
			VALUES ('111', '444', 'Alice', 1, 1, 3, 3, 14);
		INSERT INTO discord_memory_opt_out VALUES ('111', '555', 1);
		INSERT INTO discord_session_souls VALUES ('luna', '111', '222', 'Calm.', '', 1);
	`);
	db.close();
}

test("adopts the legacy database file and migrates discord_* tables to space-keyed tables exactly once", () => {
	const dataDir = mkdtempSync(join(tmpdir(), "jingmei-migration-"));
	dirs.push(dataDir);
	writeLegacyDatabase(join(dataDir, "discord-agent.db"));

	let db = openDatabase(dataDir);
	expect(existsSync(join(dataDir, "discord-agent.db"))).toBe(false);
	const tables = () =>
		(
			db.query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>
		).map((row) => row.name);
	expect(tables()).toEqual(["memory_opt_out", "memory_profiles", "messages", "session_souls", "sessions"]);
	expect(db.query("SELECT space_id, session_file FROM sessions").all()).toEqual([
		{ space_id: "discord:111", session_file: "/sessions/a.jsonl" },
	]);
	expect(db.query("SELECT space_id, message_id FROM messages").all()).toEqual([
		{ space_id: "discord:111", message_id: "333" },
	]);
	db.close();

	// A second startup is a no-op: ids are not prefixed twice, and the migrated data is live for the new modules.
	db = openDatabase(dataDir);
	expect(db.query("SELECT space_id FROM memory_profiles").all()).toEqual([{ space_id: "discord:111" }]);
	const memory = new MemberMemory(db);
	expect(memory.getProfile("discord:111", "444")).toMatchObject({ name: "Alice", birthday: { month: 3, day: 14 } });
	expect(memory.listBirthdays("discord:111", 3, 14)).toEqual([{ userId: "444", name: "Alice" }]);
	memory.observe({
		platform: "discord",
		spaceId: "discord:111",
		channelId: "222",
		messageId: "999",
		authorId: "555",
		authorName: "opted-out",
		isBot: false,
		content: "我生日是1月2日",
	});
	expect(memory.getProfile("discord:111", "555")).toBeNull();
	const soul = new SoulStore({ db, personaIds: ["luna"] });
	expect(soul.read({ personaId: "luna", spaceId: "discord:111", channelId: "222" })).toBe("Calm.");
	db.close();
});

test("an existing jingmei.db wins over a stray legacy file", () => {
	const dataDir = mkdtempSync(join(tmpdir(), "jingmei-migration-"));
	dirs.push(dataDir);
	new Database(join(dataDir, "jingmei.db")).close();
	writeLegacyDatabase(join(dataDir, "discord-agent.db"));
	const db = openDatabase(dataDir);
	expect(db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all()).toEqual([]);
	expect(existsSync(join(dataDir, "discord-agent.db"))).toBe(true);
	db.close();
});
