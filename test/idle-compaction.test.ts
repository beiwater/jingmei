import { type AgentSession, type ModelRuntime, shouldCompact } from "@earendil-works/pi-coding-agent";
import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BotState } from "../src/core/bot-state.ts";
import { Conversation, type IdleCompactionClock } from "../src/core/conversation.ts";
import { MemberMemory } from "../src/core/memory.ts";
import { SoulStore } from "../src/core/soul.ts";
import type { Persona, PlatformTransport, SpaceId } from "../src/core/types.ts";

const SPACE: SpaceId = "discord:111";
const QUIET_MS = 600_000;
const model = {
	id: "fixture",
	name: "fixture",
	api: "openai-responses" as const,
	provider: "fixture",
	baseUrl: "http://unused",
	reasoning: false,
	input: ["text" as const],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1_048_576,
	maxTokens: 4096,
};
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

class Clock implements IdleCompactionClock {
	time = 0;
	unrefs = 0;
	readonly timers = new Map<NodeJS.Timeout, { at: number; callback: () => void }>();
	now() {
		return this.time;
	}
	setTimeout(callback: () => void, delayMs: number) {
		const timer = {
			unref: () => {
				this.unrefs++;
				return timer;
			},
		} as unknown as NodeJS.Timeout;
		this.timers.set(timer, { at: this.time + delayMs, callback });
		return timer;
	}
	clearTimeout(timer: NodeJS.Timeout | undefined) {
		if (timer) this.timers.delete(timer);
	}
	advance(ms: number) {
		this.time += ms;
		for (const [timer, task] of this.timers) {
			if (task.at > this.time) continue;
			this.timers.delete(timer);
			task.callback();
		}
	}
}

type SessionSeam = {
	getSession(persona: Persona, spaceId: SpaceId, channelId: string): Promise<AgentSession>;
	runInLane<T>(scope: string, fn: () => Promise<T>): Promise<T>;
};

async function fixture(tokens: number[]) {
	const dataDir = mkdtempSync(join(tmpdir(), "jingmei-idle-"));
	const personaPath = join(dataDir, "persona.md");
	writeFileSync(personaPath, "Friendly companion.");
	const db = new Database(":memory:");
	const personas: Persona[] = tokens.map((_, index) => ({
		id: `persona${index}`,
		name: `persona${index}`,
		personaPath,
		provider: model.provider,
		model: model.id,
		routingP: 0,
		aliases: [],
		adminUserIds: ["discord:999"],
		reasoningEffort: "off",
		sendReactionImages: false,
		voiceEnabled: false,
		imageGenerationEnabled: false,
		accounts: { discord: { userId: `${12345678901234560n + BigInt(index)}`, username: `persona${index}` } },
	}));
	const transport: PlatformTransport = {
		platform: "discord",
		echoesOwnMessages: true,
		displayName: "Discord",
		promptLines: [],
		quickReactions: {},
		sendMessage: async () => {
			throw new Error("No model reply should be sent");
		},
		formatMention: (user) => `@${user.username}`,
		isValidReaction: () => true,
	};
	const clock = new Clock();
	const state = new BotState(db);
	const soul = new SoulStore({ db, personaIds: personas.map((persona) => persona.id) });
	const core = new Conversation({
		db,
		botState: state,
		dataDir,
		routingSecret: "fixture",
		personas,
		soulStore: soul,
		memberMemory: new MemberMemory(db),
		modelRuntime: {
			getModel: () => model,
			hasConfiguredAuth: () => true,
			getAuth: async () => ({ auth: { apiKey: "fixture" } }),
		} as unknown as ModelRuntime,
		transports: new Map([["discord", transport]]),
		idleCompactionClock: clock,
	});
	cleanups.push(async () => {
		await core.close();
		db.close();
		rmSync(dataDir, { recursive: true, force: true });
	});
	const seam = core as unknown as SessionSeam;
	const sessions = await Promise.all(personas.map((persona) => seam.getSession(persona, SPACE, "222")));
	const compactions: number[] = [];
	for (const [index, session] of sessions.entries()) {
		session.getContextUsage = () => ({ tokens: tokens[index]!, contextWindow: model.contextWindow, percent: 20 });
		session.compact = async () => {
			const tokensBefore = tokens[index]!;
			tokens[index] = 100;
			compactions.push(index);
			return { summary: "fixture", firstKeptEntryId: "fixture", tokensBefore, estimatedTokensAfter: 100 };
		};
	}
	let messageId = 100;
	const send = () =>
		core.handleMessage({
			platform: "discord",
			spaceId: SPACE,
			channelId: "222",
			messageId: String(messageId++),
			authorId: "999",
			authorName: "fixture",
			isBot: true,
			content: "Hello",
			mentionedUserIds: [],
		});
	const advance = async (ms: number) => {
		clock.advance(ms);
		await seam.runInLane(`${SPACE}\u0000222`, async () => {});
	};
	return { core, clock, state, soul, sessions, personas, compactions, send, advance, seam };
}

test("above 200K, every persona waits for ten quiet minutes before compaction", async () => {
	const f = await fixture([200_001, 250_000, 199_999]);
	expect(f.sessions[0]!.model!.contextWindow).toBe(1_048_576);
	await f.send();
	expect(f.compactions).toEqual([]);
	expect(f.clock.unrefs).toBe(1);
	await f.advance(QUIET_MS - 1);
	expect(f.compactions).toEqual([]);
	await f.advance(1);
	expect(f.compactions).toEqual([0, 1]);
});

test("Pi threshold compaction remains a near-model-limit backstop rather than a 200K trigger", async () => {
	const f = await fixture([250_000]);
	const session = f.sessions[0]!;
	const settings = session.settingsManager.getCompactionSettings();
	expect(session.autoCompactionEnabled).toBe(true);
	expect(shouldCompact(250_000, session.model!.contextWindow, settings)).toBe(false);
	expect(shouldCompact(model.contextWindow - 16_384, session.model!.contextWindow, settings)).toBe(false);
	expect(shouldCompact(model.contextWindow - 16_383, session.model!.contextWindow, settings)).toBe(true);
});

test("a new channel message postpones compaction by a full quiet period", async () => {
	const f = await fixture([250_000]);
	await f.send();
	await f.advance(QUIET_MS - 1);
	await f.send();
	await f.advance(1);
	expect(f.compactions).toEqual([]);
	await f.advance(QUIET_MS - 2);
	expect(f.compactions).toEqual([]);
	await f.advance(1);
	expect(f.compactions).toEqual([0]);
});

test("sessions at or below 200K never schedule idle compaction", async () => {
	const f = await fixture([200_000, 199_999]);
	await f.send();
	expect(f.clock.timers.size).toBe(0);
	await f.advance(QUIET_MS * 2);
	expect(f.compactions).toEqual([]);
});

test("close cancels pending idle compaction timers", async () => {
	const f = await fixture([250_000]);
	await f.send();
	expect(f.clock.timers.size).toBe(1);
	await f.core.close();
	expect(f.clock.timers.size).toBe(0);
	await f.advance(QUIET_MS);
	expect(f.compactions).toEqual([]);
});

test("compaction queued behind the channel lane is invalidated by a new arrival", async () => {
	const f = await fixture([250_000]);
	await f.send();
	let release!: () => void;
	const blocked = f.seam.runInLane(
		`${SPACE}\u0000222`,
		() =>
			new Promise<void>((resolve) => {
				release = resolve;
			}),
	);
	await Promise.resolve();
	f.clock.advance(QUIET_MS);
	const message = f.send();
	release();
	await blocked;
	await message;
	expect(f.compactions).toEqual([]);
	await f.advance(QUIET_MS);
	expect(f.compactions).toEqual([0]);
});

test("busy or already compacting sessions are skipped", async () => {
	const f = await fixture([250_000, 250_000]);
	Object.defineProperty(f.sessions[0], "isIdle", { get: () => false });
	Object.defineProperty(f.sessions[1], "isCompacting", { get: () => true });
	await f.send();
	await f.advance(QUIET_MS);
	expect(f.compactions).toEqual([]);
});

test("idle compaction follows manual pause behavior and promotes only its pending soul", async () => {
	const f = await fixture([250_000, 100]);
	const scope = { personaId: f.personas[0]!.id, spaceId: SPACE, channelId: "222" };
	f.soul.update(scope, "A calm conversational style.");
	let reloads = 0;
	f.sessions[0]!.reload = async () => {
		reloads++;
	};
	f.state.pause();
	await f.send();
	await f.advance(QUIET_MS);
	expect(f.compactions).toEqual([0]);
	expect(f.soul.readPending(scope)).toBe("");
	expect(f.soul.read(scope)).toBe("A calm conversational style.\n");
	expect(reloads).toBe(1);
});

test("failed compaction preserves pending soul and permits other personas to compact", async () => {
	const f = await fixture([250_000, 250_000]);
	const scope = { personaId: f.personas[0]!.id, spaceId: SPACE, channelId: "222" };
	f.soul.update(scope, "A calm conversational style.");
	f.sessions[0]!.compact = async () => {
		throw new Error("fixture compaction failure");
	};
	await f.send();
	await f.advance(QUIET_MS);
	expect(f.compactions).toEqual([1]);
	expect(f.soul.readPending(scope)).toBe("A calm conversational style.\n");
	expect(f.soul.read(scope)).toBe("");
});
