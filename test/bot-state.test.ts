import { afterEach, expect, setSystemTime, test } from "bun:test";
import { BotState, HEARTBEAT_MS } from "../src/core/bot-state.ts";
import { openDatabase } from "../src/core/db.ts";
import { useCleanups } from "./support/cleanup.ts";

const MINUTE = 60_000;
const cleanups = useCleanups();
afterEach(() => setSystemTime());

test("a pause written by the CLI connection reaches the running bot's connection and keeps its first time", () => {
	const dir = cleanups.tmpDir();
	const botDb = openDatabase(dir);
	const cliDb = openDatabase(dir);
	const bot = new BotState(botDb);
	const cli = new BotState(cliDb);
	expect(bot.pausedAt()).toBeNull();
	setSystemTime(new Date(1_000));
	expect(cli.pause()).toBe(true);
	setSystemTime(new Date(2_000));
	expect(cli.pause()).toBe(false);
	expect(bot.pausedAt()).toBe(1_000);
	expect(cli.resume()).toBe(true);
	expect(cli.resume()).toBe(false);
	expect(bot.pausedAt()).toBeNull();
	botDb.close();
	cliDb.close();
});

test("runtime sums finished runs, counts a live run up to now, and stops counting a crashed run at its last heartbeat", () => {
	const db = openDatabase(cleanups.tmpDir());
	const state = new BotState(db);
	expect(state.summary(0)).toMatchObject({ current: null, lastSeenAt: null, runs: 0, runtimeMs: 0, messages: 0 });

	setSystemTime(new Date(0));
	state.startRun();
	state.recordReply();
	setSystemTime(new Date(10 * MINUTE));
	state.stopRun();

	const t = 100 * MINUTE;
	setSystemTime(new Date(t));
	state.startRun();
	state.recordReply();
	state.recordReply();
	setSystemTime(new Date(t + 5 * MINUTE));
	state.heartbeat();
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
