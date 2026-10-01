import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BotState, HEARTBEAT_MS } from "../src/core/bot-state.ts";
import { openDatabase } from "../src/core/db.ts";

const MINUTE = 60_000;
const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function dataDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "jingmei-bot-state-"));
	dirs.push(dir);
	return dir;
}

test("a pause written by the CLI connection reaches the running bot's connection and keeps its first time", () => {
	const dir = dataDir();
	const botDb = openDatabase(dir);
	const cliDb = openDatabase(dir);
	const bot = new BotState(botDb);
	const cli = new BotState(cliDb);
	expect(bot.pausedAt()).toBeNull();
	expect(cli.pause(1_000)).toBe(true);
	expect(cli.pause(2_000)).toBe(false);
	expect(bot.pausedAt()).toBe(1_000);
	expect(cli.resume()).toBe(true);
	expect(cli.resume()).toBe(false);
	expect(bot.pausedAt()).toBeNull();
	botDb.close();
	cliDb.close();
});

test("runtime sums finished runs, counts a live run up to now, and stops counting a crashed run at its last heartbeat", () => {
	const db = openDatabase(dataDir());
	const state = new BotState(db);
	expect(state.summary(0)).toMatchObject({ current: null, lastSeenAt: null, runs: 0, runtimeMs: 0, messages: 0 });

	state.startRun(0);
	state.recordReply();
	state.stopRun(10 * MINUTE);

	const t = 100 * MINUTE;
	state.startRun(t);
	state.recordReply();
	state.recordReply();
	state.heartbeat(t + 5 * MINUTE);
	expect(state.summary(t + 5 * MINUTE + 30_000)).toMatchObject({
		current: { startedAt: t, replies: 2 },
		lastSeenAt: null,
		runs: 2,
		firstStartedAt: 0,
		runtimeMs: 15 * MINUTE + 30_000,
		replies: 3,
	});

	// No heartbeat for two beats: the process died without stopRun.
	const later = t + 5 * MINUTE + 2 * HEARTBEAT_MS;
	expect(state.summary(later)).toMatchObject({
		current: null,
		lastSeenAt: t + 5 * MINUTE,
		runtimeMs: 15 * MINUTE,
	});
	db.close();
});
