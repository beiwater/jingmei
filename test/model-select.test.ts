import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BotState } from "../src/core/bot-state.ts";
import { Conversation } from "../src/core/conversation.ts";
import type { SpaceId } from "../src/core/types.ts";
import { conversationOptions, makePersona, makeTransport } from "./support/core.ts";
import { assistantMessage, makeModel, makeRuntime, seamOf, streamOf } from "./support/pi.ts";

const SPACE: SpaceId = "discord:111";
const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});

test("a model chosen by the CLI connection switches the running bot's open session, survives restart and resets", async () => {
	// beta advertises a 1M window; the session uses the whole model window.
	const models = [makeModel({ id: "alpha" }), makeModel({ id: "beta", contextWindow: 1_048_576 })];
	// A provider whose catalog the CLI caches only after this process started (e.g. after `jingmei login`).
	const late = makeModel({ provider: "live", id: "delta" });
	let refreshes = 0;
	const runtime = makeRuntime((provider, id) => models.find((m) => m.provider === provider && m.id === id), {
		checkAuth: async () => ({ ok: true }),
		refresh: async () => {
			refreshes++;
			if (!models.includes(late)) models.push(late);
			return { aborted: false, errors: new Map() };
		},
	});
	const dataDir = mkdtempSync(join(tmpdir(), "jingmei-model-"));
	const db = new Database(join(dataDir, "test.db"));
	cleanups.push(() => {
		db.close();
		rmSync(dataDir, { recursive: true, force: true });
	});
	const personaPath = join(dataDir, "persona.md");
	writeFileSync(personaPath, "Friendly companion.");
	const persona = makePersona({
		personaPath,
		model: "alpha",
		adminUserIds: ["discord:5"],
		accounts: { discord: { userId: "900", username: "luna" } },
	});
	const transport = makeTransport();
	const used: string[] = [];
	let messageId = 10;
	const start = async () => {
		const core = new Conversation(
			conversationOptions({ db, dataDir, personas: [persona], modelRuntime: runtime, transports: [transport] }),
		);
		const session = await seamOf(core).getSession(persona, SPACE, "222");
		session.agent.streamFunction = (streamModel) => {
			used.push(`${streamModel.provider}/${streamModel.id}`);
			return streamOf(assistantMessage("ok", { model: streamModel }));
		};
		return core;
	};
	const send = (core: Conversation) =>
		core.handleMessage({
			platform: "discord",
			spaceId: SPACE,
			channelId: "222",
			messageId: String(messageId++),
			authorId: "6",
			authorName: "alice",
			isBot: false,
			content: "hi luna",
			mentionedUserIds: ["900"],
		});

	let core = await start();
	await send(core);
	expect(used).toEqual(["fixture/alpha"]);

	// The operator CLI writes through its own connection; the bot needs no restart.
	const cli = new Database(join(dataDir, "test.db"));
	const operator = new BotState(cli);
	operator.setModelOverride("luna", "fixture", "beta");
	await send(core);
	expect(used.at(-1)).toBe("fixture/beta");
	const status = await core.getContextStatus("luna", "discord", SPACE, "222", "5");
	expect(status.contextWindow).toBe(1_048_576);
	expect(status).toMatchObject({
		segmentMaxTokens: 40_000,
		segmentIdleMs: 300_000,
		segmentMaxPending: 30,
		windowMessages: 30,
	});
	expect(status.safetyCompactionAtTokens).toBe(1_048_576 - 16_384);

	operator.setModelOverride("luna", "live", "delta");
	await send(core);
	expect(used.at(-1)).toBe("live/delta");
	expect(refreshes).toBe(1);

	await core.close();
	core = await start();
	await send(core);
	expect(used.at(-1)).toBe("live/delta");

	// An override the catalog cannot resolve falls back to the configured model, refreshing only once.
	operator.setModelOverride("luna", "gone", "omega");
	await send(core);
	await send(core);
	expect(used.slice(-2)).toEqual(["fixture/alpha", "fixture/alpha"]);
	expect(refreshes).toBe(2);

	operator.setModelOverride("luna", "fixture", "beta");
	await send(core);
	expect(used.at(-1)).toBe("fixture/beta");
	operator.clearModelOverride("luna");
	await send(core);
	expect(used.at(-1)).toBe("fixture/alpha");
	await core.close();
	cli.close();
});
