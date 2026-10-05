import type { StreamFn } from "@earendil-works/pi-agent-core";
import { type AssistantMessage, createAssistantMessageEventStream, type Model } from "@earendil-works/pi-ai";
import type { AgentSession, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { Database } from "bun:sqlite";
import { afterEach, expect, spyOn, test, vi } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateConfig } from "../src/config.ts";
import { BotState } from "../src/core/bot-state.ts";
import { Conversation } from "../src/core/conversation.ts";
import { useExtensibleSqlite } from "../src/core/db.ts";
import { EventTracker } from "../src/core/events.ts";
import { MemberMemory } from "../src/core/memory.ts";
import { SoulStore } from "../src/core/soul.ts";
import type { InboundMessage, Persona, Platform, PlatformTransport, SpaceId } from "../src/core/types.ts";
import type { JevClient } from "../src/decision/jev.ts";
import { type LogRecord, setLogSink } from "../src/observability/log.ts";

interface SessionSeam {
	getSession(persona: Persona, spaceId: SpaceId, channelId: string): Promise<AgentSession>;
}

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function eventId(db: Database, messageId: string) {
	const row = db.query("SELECT event_id FROM messages WHERE message_id = ?").get(messageId);
	if (!row || typeof row !== "object" || !("event_id" in row) || typeof row.event_id !== "number")
		throw new Error("Expected a stored topic id");
	return row.event_id;
}

function fixture(
	options: {
		platform?: Platform;
		timeoutMs?: number;
		events?: boolean;
		voice?: boolean;
		reactionImages?: boolean;
	} = {},
) {
	useExtensibleSqlite();
	const platform = options.platform ?? "telegram";
	const space: SpaceId = platform === "telegram" ? "telegram:-100111" : "discord:111";
	const model: Model<"openai-responses"> = {
		id: "fixture",
		name: "fixture",
		api: "openai-responses",
		provider: "fixture",
		baseUrl: "http://unused",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 65536,
		maxTokens: 4096,
	};
	const reply = (
		content: AssistantMessage["content"] = [{ type: "text", text: "hello" }],
		stopReason: AssistantMessage["stopReason"] = "stop",
	): AssistantMessage => ({
		role: "assistant",
		content,
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: Date.now(),
	});
	const runtime = {
		getModel: () => model,
		hasConfiguredAuth: () => true,
		getAuth: async () => ({ auth: { apiKey: "fixture" } }),
	} as unknown as ModelRuntime;
	const dataDir = mkdtempSync(join(tmpdir(), "jingmei-turn-"));
	const db = new Database(":memory:");
	const personaPath = join(dataDir, "persona.md");
	writeFileSync(personaPath, "Friendly companion.");
	const persona: Persona = {
		id: "luna",
		name: "Luna",
		personaPath,
		provider: model.provider,
		model: model.id,
		routingP: 0,
		aliases: [],
		adminUserIds: [],
		reasoningEffort: "off",
		sendReactionImages: true,
		voiceEnabled: !!options.voice,
		imageGenerationEnabled: false,
		accounts: { [platform]: { userId: "900", username: "luna_bot" } },
	};
	if (options.reactionImages) {
		const directory = join(dataDir, "feiba");
		mkdirSync(directory);
		writeFileSync(
			join(directory, "001_innocent.png"),
			readFileSync(join(import.meta.dir, "../assets/reactions/hello.png")),
		);
		writeFileSync(
			join(directory, "catalog.json"),
			JSON.stringify({
				innocent: {
					id: "innocent",
					num: 1,
					file: "feiba/001_innocent.png",
					name: "Innocent",
					caption: "Who, me?",
					category: "reaction",
				},
			}),
		);
		persona.reactionImages = validateConfig(
			{
				telegram: { chatIds: ["-100111"] },
				personas: [
					{
						id: persona.id,
						name: persona.name,
						personaPath,
						provider: model.provider,
						model: model.id,
						routingP: 0,
						reactionImages: directory,
						telegram: { tokenEnv: "BOT_TOKEN" },
					},
				],
			},
			dataDir,
			{ ROUTING_SECRET: "fixture", BOT_TOKEN: "fixture" },
		).personas[0]!.reactionImages;
	}
	const sends: Array<Parameters<PlatformTransport["sendMessage"]>[0]> = [];
	const transport: PlatformTransport = {
		platform,
		echoesOwnMessages: platform === "discord",
		displayName: platform,
		promptLines: [],
		quickReactions: {},
		sendMessage: async (input) => {
			sends.push(input);
			return { id: String(1000 + sends.length) };
		},
		formatMention: (user) => `@${user.username}`,
		isValidReaction: () => true,
	};
	let decisions = 0;
	const decision = {
		chooseEvent: async () => {
			decisions++;
			return { choice: "new", confidence: 1 };
		},
		scoreParticipation: async () => [],
	} as unknown as JevClient;
	const events = options.events
		? new EventTracker({
				db,
				decision,
				embedder: { dimensions: 2, embed: async (texts) => texts.map(() => new Float32Array([1, 0])) },
				summarize: async () => ({ title: "Topic", description: "Discussion" }),
			})
		: undefined;
	const core = new Conversation({
		db,
		botState: new BotState(db),
		memberMemory: new MemberMemory(db),
		soulStore: new SoulStore({ db, personaIds: [persona.id] }),
		dataDir,
		routingSecret: "fixture",
		personas: [persona],
		modelRuntime: runtime,
		transports: new Map([[platform, transport]]),
		events,
		turnTimeoutMs: options.timeoutMs ?? 2_000,
		...(options.voice ? { voice: { apiKey: "fixture", referenceId: "fixture", model: "s2.1-pro-free" as const } } : {}),
	});
	const logs: LogRecord[] = [];
	cleanups.push(setLogSink((line) => logs.push(JSON.parse(line))));
	cleanups.push(async () => {
		await core.close();
		await events?.idle();
		db.close();
		rmSync(dataDir, { recursive: true, force: true });
	});
	const script: Array<AssistantMessage | StreamFn> = [];
	let calls = 0;
	const attached = new Set<AgentSession>();
	const seam = core as unknown as SessionSeam;
	const getSession = seam.getSession.bind(core);
	seam.getSession = async (...args) => {
		const session = await getSession(...args);
		if (!attached.has(session)) {
			attached.add(session);
			session.agent.streamFunction = (...streamArgs) => {
				calls++;
				const next = script.shift() ?? reply();
				if (typeof next === "function") return next(...streamArgs);
				const stream = createAssistantMessageEventStream();
				if (next.stopReason === "error" || next.stopReason === "aborted") {
					stream.push({ type: "error", reason: next.stopReason, error: next });
				} else {
					stream.push({ type: "done", reason: next.stopReason as "stop", message: next });
				}
				return stream;
			};
		}
		return session;
	};
	let messageId = 10;
	const send = (overrides: Partial<InboundMessage> = {}) =>
		core.handleMessage({
			platform,
			spaceId: space,
			channelId: "222",
			messageId: String(messageId++),
			authorId: "5",
			authorName: "Alice",
			isBot: false,
			content: "hi Luna",
			mentionedUserIds: ["900"],
			...overrides,
		});
	return {
		core,
		db,
		space,
		persona,
		script,
		reply,
		sends,
		logs,
		send,
		seam,
		calls: () => calls,
		decisions: () => decisions,
	};
}

test("a noncompleting provider is aborted at the deadline and a queued same-channel turn replies", async () => {
	const f = fixture({ timeoutMs: 80 });
	const retired = await f.seam.getSession(f.persona, f.space, "222");
	vi.useFakeTimers();
	cleanups.push(() => {
		vi.useRealTimers();
	});
	let started!: () => void;
	const providerStarted = new Promise<void>((resolve) => {
		started = resolve;
	});
	const stuck = createAssistantMessageEventStream();
	let signal: AbortSignal | undefined;
	f.script.push((_model, _context, options) => {
		signal = options?.signal;
		started();
		return stuck; // Deliberately ignores abort: the lane must not wait for provider cooperation.
	});
	const deadline = 80;
	const first = f.send();
	const second = f.send();
	// Wait for the actual provider-start signal before advancing the turn deadline.
	await providerStarted;
	vi.advanceTimersByTime(deadline);
	const failed = await first;
	expect(failed.responseMessageId).toBeUndefined();
	expect(signal?.aborted).toBe(true);
	expect(await second).toMatchObject({ responseMessageId: "1001", messageStored: true });
	expect(f.sends.map((send) => send.replyToMessageId)).toEqual(["11"]);
	expect(f.calls()).toBe(2);
	expect(f.logs.filter((record) => record.event === "turn_timeout")).toMatchObject([
		{
			component: "core",
			level: "warn",
			fields: { persona_id: "luna", platform: "telegram", error_category: "timeout" },
		},
	]);
	// Late provider completion cannot send a stale answer or mutate the retired durable session.
	const late = f.reply([{ type: "text", text: "late answer" }]);
	stuck.push({ type: "done", reason: "stop", message: late });
	await retired.agent.waitForIdle();
	expect(f.sends.map((send) => send.content)).toEqual(["hello"]);
});

for (const reason of ["error", "aborted"] as const) {
	test(`a final ${reason} is logged without provider text, sends no partial reply, and releases the lane`, async () => {
		const f = fixture();
		f.script.push({
			...f.reply([{ type: "text", text: "partial answer" }], reason),
			errorMessage: "private provider detail",
		});
		expect((await f.send()).responseMessageId).toBeUndefined();
		expect(f.sends).toEqual([]);
		expect(f.logs.filter((record) => record.event === "turn_failed")).toMatchObject([
			{ component: "core", fields: { persona_id: "luna", platform: "telegram", error_category: reason } },
		]);
		expect(JSON.stringify(f.logs)).not.toContain("private provider detail");
		expect(JSON.stringify(f.logs)).not.toContain("partial answer");
		expect((await f.send()).responseMessageId).toBe("1001");
	});
}

test("one transient retry can succeed without reporting the completed turn as failed", async () => {
	const f = fixture();
	const session = await f.seam.getSession(f.persona, f.space, "222");
	vi.useFakeTimers();
	cleanups.push(() => {
		vi.useRealTimers();
	});
	let retry!: () => void;
	const retryStarted = new Promise<void>((resolve) => {
		retry = resolve;
	});
	const unsubscribe = session.subscribe((event) => {
		if (event.type === "auto_retry_start") retry();
	});
	f.script.push({ ...f.reply([], "error"), errorMessage: "overloaded" }, f.reply());
	const pending = f.send();
	await retryStarted;
	vi.advanceTimersByTime(1_000);
	expect((await pending).responseMessageId).toBe("1001");
	unsubscribe();
	expect(f.calls()).toBe(2);
	expect(f.logs.filter((record) => record.event === "turn_failed")).toEqual([]);
});

test("non-echoed bot replies are stored and human replies inherit their original topic", async () => {
	const f = fixture({ events: true });
	await f.send();
	const source = eventId(f.db, "10");
	expect(source).toBeGreaterThan(0);
	const sent = f.db.query("SELECT * FROM messages WHERE message_id = '1001'").get();
	expect(sent).toMatchObject({
		space_id: f.space,
		channel_id: "222",
		author_id: "900",
		author_name: "luna_bot",
		is_bot: 1,
		content: "hello",
		reply_to_message_id: "10",
		event_id: source,
		timestamp: expect.any(Number),
	});
	await f.send({ content: "A completely different subject", mentionedUserIds: [] });
	expect(eventId(f.db, "11")).not.toBe(source);
	const decisions = f.decisions();
	await f.send({ content: "Tell me more", mentionedUserIds: [], replyToMessageId: "1001", replyToAuthorId: "900" });
	expect(eventId(f.db, "12")).toBe(source);
	expect(f.decisions()).toBe(decisions);
});

test("an echoing transport is not pre-inserted; its inbound bot echo is still processed", async () => {
	const f = fixture({ platform: "discord", events: true });
	await f.send();
	expect(f.db.query("SELECT * FROM messages WHERE message_id = '1001'").get()).toBeNull();
	const echo = await f.send({
		messageId: "1001",
		authorId: "900",
		authorName: "luna_bot",
		isBot: true,
		content: "hello",
		mentionedUserIds: [],
		replyToMessageId: "10",
	});
	expect(echo.messageStored).toBe(true);
	expect(f.db.query("SELECT is_bot, event_id FROM messages WHERE message_id = '1001'").get()).toMatchObject({
		is_bot: 1,
		event_id: expect.any(Number),
	});
	expect(f.sends).toHaveLength(1);
});

test("reaction-image tool sends are stored with their caption and source topic", async () => {
	const f = fixture({ events: true });
	f.script.push(
		f.reply(
			[
				{
					type: "toolCall",
					id: "image",
					name: "send_reaction_image",
					arguments: { asset_id: "hello", caption: "wave" },
				},
			],
			"toolUse",
		),
	);
	expect((await f.send()).responseMessageId).toBe("1001");
	expect(f.sends[0]?.attachments?.[0]?.contentType).toBe("image/png");
	expect(
		f.db.query("SELECT content, reply_to_message_id, event_id FROM messages WHERE message_id = '1001'").get(),
	).toEqual({
		content: "wave",
		reply_to_message_id: "10",
		event_id: eventId(f.db, "10"),
	});
});

test("a persona catalog image is sent with its default caption and ends the turn", async () => {
	const f = fixture({ events: true, reactionImages: true });
	f.script.push(
		f.reply(
			[{ type: "toolCall", id: "image", name: "send_reaction_image", arguments: { asset_id: "innocent" } }],
			"toolUse",
		),
	);
	expect((await f.send()).responseMessageId).toBe("1001");
	expect(f.sends).toHaveLength(1);
	expect(f.calls()).toBe(1);
	expect(f.sends[0]).toMatchObject({
		content: "Who, me?",
		replyToMessageId: "10",
		attachments: [
			{
				name: "001_innocent.png",
				data: readFileSync(f.persona.reactionImages!.innocent!.path),
				contentType: "image/png",
			},
		],
	});
	expect(f.db.query("SELECT content, event_id FROM messages WHERE message_id = '1001'").get()).toEqual({
		content: "Who, me?",
		event_id: eventId(f.db, "10"),
	});
});

for (const mode of ["tool", "explicit"] as const) {
	test(`${mode} voice replies store the transcript and source topic on non-echoing transports`, async () => {
		const f = fixture({ events: true, voice: true });
		const fetch = spyOn(globalThis, "fetch").mockImplementation((async (input: string | URL | Request) => {
			if (String(input) !== "https://api.fish.audio/v1/tts") throw new Error("unexpected network request");
			return new Response(new Uint8Array([73, 68, 51]), { headers: { "content-type": "audio/mpeg" } });
		}) as unknown as typeof globalThis.fetch);
		try {
			if (mode === "tool") {
				f.script.push(
					f.reply([{ type: "toolCall", id: "voice", name: "speak", arguments: { text: "hello" } }], "toolUse"),
				);
			}
			const sent = await f.send({ content: mode === "explicit" ? "Luna 用语音回复" : "hi Luna" });
			expect(sent.responseMessageId).toBe("1001");
			expect(f.sends[0]?.attachments?.[0]?.contentType).toBe("audio/mpeg");
			expect(
				f.db.query("SELECT content, reply_to_message_id, event_id FROM messages WHERE message_id = '1001'").get(),
			).toEqual({
				content: "🎙️ hello",
				reply_to_message_id: "10",
				event_id: eventId(f.db, "10"),
			});
		} finally {
			fetch.mockRestore();
		}
	});
}
