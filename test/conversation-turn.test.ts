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
import { Conversation, type ConversationOptions } from "../src/core/conversation.ts";
import { WITHHELD_MESSAGE_TYPE } from "../src/core/context.ts";
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
		routingP?: number;
		jev?: boolean;
		replyDecision?: boolean;
		participation?: JevClient["decideParticipation"];
		audit?: JevClient["auditNatural"];
		typing?: { refreshMs: number; maxMs: number };
		quickReactions?: boolean;
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
		routingP: options.routingP ?? 0,
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
	const typingAt: number[] = [];
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
		...(options.typing
			? {
					typingRefreshMs: options.typing.refreshMs,
					startTyping: () => {
						typingAt.push(Date.now());
					},
				}
			: {}),
	};
	let decisions = 0;
	const participationRequests: Array<Parameters<JevClient["decideParticipation"]>[0]> = [];
	const auditRequests: Array<Parameters<JevClient["auditNatural"]>[0]> = [];
	const quickReactionRequests: Array<Parameters<JevClient["decideQuickReaction"]>[0]> = [];
	const decision: JevClient = {
		chooseEvent: async () => {
			decisions++;
			return { choice: "new", confidence: 1 };
		},
		scoreParticipation: async () => [],
		scoreRelevance: async () => [],
		decideQuickReaction: async (input) => {
			quickReactionRequests.push(input);
			return { emoji: null, confidence: 1, strongEmotion: 0, funny: 0 };
		},
		decideParticipation: async (input) => {
			participationRequests.push(input);
			return options.participation?.(input) ?? { directedPersonaId: null, chatIn: 1 };
		},
		auditNatural: async (input) => {
			auditRequests.push(input);
			return options.audit?.(input) ?? 1;
		},
	};
	const events = options.events
		? new EventTracker({
				db,
				decision,
				embedder: { dimensions: 2, embed: async (texts) => texts.map(() => new Float32Array([1, 0])) },
				summarize: async () => ({ title: "Topic", description: "Discussion" }),
			})
		: undefined;
	const coreOptions: ConversationOptions = {
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
		...(options.jev
			? {
					jev: {
						client: decision,
						quickReactions: options.quickReactions ?? false,
						memoryScoring: false,
						replyDecision: options.replyDecision ?? true,
						replyThreshold: 0.7,
						threshold: 0.8,
						minIntervalMs: 60_000,
					},
				}
			: {}),
		turnTimeoutMs: options.timeoutMs ?? 2_000,
		...(options.typing ? { typingMaxMs: options.typing.maxMs } : {}),
		...(options.voice ? { voice: { apiKey: "fixture", referenceId: "fixture", model: "s2.1-pro-free" as const } } : {}),
	};
	const core = new Conversation(coreOptions);
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
	const restart = () => {
		const recovered = new Conversation(coreOptions);
		const recoveredSeam = recovered as unknown as SessionSeam;
		const original = recoveredSeam.getSession.bind(recovered);
		recoveredSeam.getSession = async (...args) => {
			const session = await original(...args);
			session.agent.streamFunction = () => {
				const stream = createAssistantMessageEventStream();
				stream.push({ type: "done", reason: "stop", message: reply() });
				return stream;
			};
			return session;
		};
		cleanups.push(() => recovered.close());
		return recovered;
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
		events,
		participationRequests,
		quickReactionRequests,
		restart,
		auditRequests,
		typingAt,
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
	expect(f.db.query("SELECT message_id FROM inbound_pending WHERE message_id = '10'").get()).toBeNull();
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
		expect(f.db.query("SELECT * FROM inbound_pending").all()).toEqual([]);
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

test("gated participation still asks for directed intent but never asks for chat-in", async () => {
	const f = fixture({ routingP: 1, jev: true });
	await f.send({ isBot: true, authorId: "900", content: "earlier reply" });
	const dispatch = await f.send({ mentionedUserIds: [], content: "ordinary conversation" });
	expect(f.participationRequests).toHaveLength(1);
	expect(f.participationRequests[0]).toMatchObject({ message: "Alice: ordinary conversation", chatIn: false });
	expect(dispatch.route).toEqual({ personaId: null, reason: "nobody" });
	expect(f.calls()).toBe(0);
	expect(f.sends).toEqual([]);
});

test("directed intent beats a gated HMAC candidate and remains eligible without any candidate", async () => {
	for (const routingP of [0, 1]) {
		const f = fixture({
			routingP,
			jev: true,
			participation: async () => ({ directedPersonaId: "luna" }),
		});
		await f.send({ isBot: true, authorId: "900", content: "earlier reply" });
		const dispatch = await f.send({ mentionedUserIds: [], content: "what do you think?" });
		expect(f.participationRequests).toHaveLength(1);
		expect(f.participationRequests[0]?.chatIn).toBe(false);
		expect(dispatch.route).toEqual({ personaId: "luna", reason: "directed" });
		expect(f.sends).toHaveLength(1);
	}
});

test("only ungated HMAC candidates request chat-in and decision failures select nobody", async () => {
	for (const routingP of [0, 1]) {
		const f = fixture({
			routingP,
			jev: true,
			participation: async () => {
				throw new Error("decision unavailable");
			},
		});
		const dispatch = await f.send({ mentionedUserIds: [], content: "ordinary conversation" });
		expect(f.participationRequests[0]?.chatIn).toBe(routingP === 1);
		expect(dispatch.route).toEqual({ personaId: null, reason: "nobody" });
		expect(f.calls()).toBe(0);
		expect(f.auditRequests).toEqual([]);
		expect(f.logs).toContainEqual(
			expect.objectContaining({
				event: "participation_failed",
				fields: { error_category: expect.any(String) },
			}),
		);
	}
});

test("without reply decisions HMAC participation still obeys the cooldown", async () => {
	for (const jev of [false, true]) {
		const f = fixture({ routingP: 1, jev, replyDecision: false });
		const first = await f.send({ mentionedUserIds: [], content: "ordinary conversation" });
		expect(first.route).toEqual({ personaId: "luna", reason: "probability" });
		expect(f.sends).toHaveLength(1);
		const second = await f.send({ mentionedUserIds: [], content: "more conversation" });
		expect(second.route).toEqual({ personaId: null, reason: "nobody" });
		expect(f.sends).toHaveLength(1);
		expect(f.participationRequests).toEqual([]);
	}
});

test("each human message logs why it was or was not routed, without its text", async () => {
	const f = fixture({
		routingP: 1,
		jev: true,
		participation: async () => ({ directedPersonaId: null, chatIn: 0.4 }),
	});
	await f.send({ mentionedUserIds: [], content: "secret ordinary words" });
	await f.send({ content: "hi Luna" });
	await f.send({ isBot: true, authorId: "77", mentionedUserIds: [], content: "bot chatter" });
	new BotState(f.db).pause();
	await f.send({ mentionedUserIds: [], content: "while paused" });
	expect(f.logs.filter((record) => record.event === "route").map((record) => record.fields)).toEqual([
		{
			platform: "telegram",
			reason: "nobody",
			persona_id: null,
			candidate: "luna",
			gated: false,
			decision: "ok",
			chat_in: 0.4,
		},
		{ platform: "telegram", reason: "explicit", persona_id: "luna", candidate: null, gated: false, decision: "none" },
		{ platform: "telegram", reason: "paused" },
	]);
	expect(JSON.stringify(f.logs)).not.toContain("secret ordinary words");
});

/** Queues a provider call that stays open until `finish()`. */
function heldProvider(script: Array<AssistantMessage | StreamFn>, message: AssistantMessage) {
	let started!: () => void;
	const providerStarted = new Promise<void>((resolve) => {
		started = resolve;
	});
	const stream = createAssistantMessageEventStream();
	script.push(() => {
		started();
		return stream;
	});
	return {
		providerStarted,
		finish: () => stream.push({ type: "done", reason: "stop", message }),
		abort: () => stream.push({ type: "error", reason: "aborted", error: { ...message, stopReason: "aborted" } }),
	};
}

test("pending records are removed on completion, failed turns, pause and thrown processing", async () => {
	const f = fixture();
	await f.send();
	expect(f.db.query("SELECT * FROM inbound_pending").all()).toEqual([]);
	f.script.push(f.reply([], "error"));
	await f.send();
	expect(f.db.query("SELECT * FROM inbound_pending").all()).toEqual([]);
	new BotState(f.db).pause();
	await f.send();
	expect(f.db.query("SELECT * FROM inbound_pending").all()).toEqual([]);
	new BotState(f.db).resume();
	const original = f.seam.getSession;
	f.seam.getSession = async () => {
		throw new Error("session unavailable");
	};
	await expect(f.send()).rejects.toThrow("session unavailable");
	expect(f.db.query("SELECT * FROM inbound_pending").all()).toEqual([]);
	f.seam.getSession = original;
});

test("accepting history and pending work is atomic", async () => {
	const f = fixture();
	f.db.exec(`CREATE TRIGGER reject_pending BEFORE INSERT ON inbound_pending
		BEGIN SELECT RAISE(ABORT, 'pending unavailable'); END`);
	await expect(f.send({ messageId: "atomic" })).rejects.toThrow("pending unavailable");
	expect(f.db.query("SELECT * FROM messages WHERE message_id = 'atomic'").get()).toBeNull();
	expect(f.db.query("SELECT * FROM inbound_pending").all()).toEqual([]);
});

test("startup replays an interrupted turn exactly once and discards expired pending history", async () => {
	const f = fixture({ timeoutMs: 10_000 });
	const held = heldProvider(f.script, f.reply());
	const abandoned = f.send({ messageId: "10", images: [{ mimeType: "image/png", base64: "aGVsbG8=" }] });
	await held.providerStarted;
	const pending = f.db.query("SELECT payload, received_at FROM inbound_pending").get() as {
		payload: string;
		received_at: number;
	};
	expect(pending.payload).not.toContain("aGVsbG8=");
	const expired = { ...JSON.parse(pending.payload), messageId: "old", timestamp: Date.now() - 600_001 };
	f.db
		.query(`INSERT INTO messages
		(space_id,channel_id,message_id,author_id,author_name,is_bot,content,timestamp)
		VALUES (?, ?, ?, ?, ?, 0, ?, ?)`)
		.run(f.space, "222", "old", "5", "Alice", expired.content, expired.timestamp);
	f.db
		.query("INSERT INTO inbound_pending VALUES (?, ?, ?, ?, ?)")
		.run(f.space, "222", "old", JSON.stringify(expired), pending.received_at);
	const recovered = f.restart();
	await recovered.recoverPending();
	expect(f.sends).toHaveLength(1);
	const recoveredSession = await (recovered as unknown as SessionSeam).getSession(f.persona, f.space, "222");
	expect(
		recoveredSession.messages.some(
			(message) => message.role === "custom" && JSON.stringify(message).includes("图片在崩溃恢复后不可用"),
		),
	).toBe(true);
	expect(f.db.query("SELECT * FROM inbound_pending").all()).toEqual([]);
	expect(f.db.query("SELECT message_id FROM messages WHERE message_id = 'old'").get()).toEqual({ message_id: "old" });
	expect(f.logs).toContainEqual(
		expect.objectContaining({ event: "inbound_recovered", fields: { recovered: 1, expired: 1 } }),
	);
	const duplicate = await recovered.handleMessage({ ...JSON.parse(pending.payload), images: [] });
	expect(duplicate).toEqual({ route: { personaId: null, reason: "nobody" }, messageStored: false });
	await recovered.recoverPending();
	expect(f.sends).toHaveLength(1);
	held.abort();
	await abandoned;
});

test("stale traffic skips participation and quick reactions but remains observed; explicit addressing replies", async () => {
	const now = Date.now();
	const clock = spyOn(Date, "now").mockReturnValue(now);
	cleanups.push(() => clock.mockRestore());
	for (const routingP of [0, 1]) {
		const f = fixture({
			routingP,
			jev: true,
			quickReactions: true,
			events: true,
			participation: async () => ({ directedPersonaId: "luna", chatIn: 1 }),
		});
		const result = await f.send({ timestamp: now - 120_001, mentionedUserIds: [], content: "ordinary conversation" });
		expect(result.route).toEqual({ personaId: null, reason: "nobody" });
		expect(f.participationRequests).toEqual([]);
		expect(f.quickReactionRequests).toEqual([]);
		expect(f.calls()).toBe(0);
		expect(eventId(f.db, "10")).toBeGreaterThan(0);
		expect(f.db.query("SELECT * FROM memory_observed_messages WHERE message_id = '10'").get()).not.toBeNull();
		const session = await f.seam.getSession(f.persona, f.space, "222");
		expect(
			session.messages.some(
				(message) => message.role === "custom" && JSON.stringify(message).includes("ordinary conversation"),
			),
		).toBe(true);
		const explicit = await f.send({ timestamp: now - 120_001 });
		expect(explicit.route.reason).toBe("explicit");
		expect(f.sends).toHaveLength(1);
		expect(f.participationRequests).toEqual([]);
		expect(f.quickReactionRequests).toEqual([]);
		expect(f.logs.filter((record) => record.event === "route").every((record) => record.fields?.stale === true)).toBe(
			true,
		);
	}
});

test("exactly two minutes is fresh and still requests participation", async () => {
	const now = Date.now();
	const clock = spyOn(Date, "now").mockReturnValue(now);
	cleanups.push(() => clock.mockRestore());
	const f = fixture({ routingP: 1, jev: true });
	const result = await f.send({ timestamp: now - 120_000, mentionedUserIds: [], content: "ordinary conversation" });
	expect(result.route.reason).toBe("probability");
	expect(f.participationRequests).toHaveLength(1);
	expect(f.logs.find((record) => record.event === "route")?.fields?.stale).toBeUndefined();
});

test("later queued messages do not pollute recent lines or the current participation gate", async () => {
	const f = fixture({ routingP: 1, jev: true });
	const first = f.send({ messageId: "10", mentionedUserIds: [], content: "current conversation" });
	const later = f.send({
		messageId: "11",
		authorId: "900",
		isBot: true,
		mentionedUserIds: [],
		content: "future bot chatter",
	});
	// Both rows are durable before either lane task starts.
	expect(f.db.query("SELECT * FROM inbound_pending").all()).toHaveLength(2);
	const result = await first;
	await later;
	expect(result.route.reason).toBe("probability");
	expect(f.participationRequests[0]).toMatchObject({ recent: [], chatIn: true });
	expect(f.auditRequests[0]?.recent).toEqual([]);
});

test("typing is refreshed while the model works and stops once the reply is sent", async () => {
	const f = fixture({ typing: { refreshMs: 20, maxMs: 10_000 } });
	await f.seam.getSession(f.persona, f.space, "222");
	vi.useFakeTimers();
	cleanups.push(() => {
		vi.useRealTimers();
	});
	const provider = heldProvider(f.script, f.reply());
	const turn = f.send();
	await provider.providerStarted;
	vi.advanceTimersByTime(60);
	expect(f.typingAt).toHaveLength(4);
	provider.finish();
	await turn;
	expect(f.sends).toHaveLength(1);
	vi.advanceTimersByTime(100);
	expect(f.typingAt).toHaveLength(4);
});

test("typing never stays visible past the cap while the model keeps working", async () => {
	const f = fixture({ typing: { refreshMs: 20, maxMs: 50 } });
	await f.seam.getSession(f.persona, f.space, "222");
	vi.useFakeTimers();
	cleanups.push(() => {
		vi.useRealTimers();
	});
	const provider = heldProvider(f.script, f.reply());
	const turn = f.send();
	await provider.providerStarted;
	vi.advanceTimersByTime(200);
	// Pings at 0 and 20 ms; one more at 40 ms would stay visible until 60 ms.
	expect(f.typingAt).toHaveLength(2);
	provider.finish();
	await turn;
	expect(f.sends).toHaveLength(1);
});

test("explicit mention, reply and name bypass participation decisions and gates", async () => {
	for (const [reason, overrides] of [
		["explicit", { mentionedUserIds: ["900"], content: "hello" }],
		["reply", { mentionedUserIds: [], replyToAuthorId: "900", content: "hello" }],
		["name", { mentionedUserIds: [], content: "Luna hello" }],
	] as const) {
		const f = fixture({ routingP: 1, jev: true });
		await f.send({ isBot: true, authorId: "900" });
		const dispatch = await f.send(overrides);
		expect(dispatch.route).toEqual({ personaId: "luna", reason });
		expect(f.participationRequests).toEqual([]);
		expect(f.sends).toHaveLength(1);
	}
});

test("deterministic event leaks are withheld before Jev and persisted as non-triggering hidden markers", async () => {
	for (const text of ["oops §E7 leaked", "oops [当前事件 leaked"]) {
		const f = fixture({ jev: true, voice: true });
		const session = await f.seam.getSession(f.persona, f.space, "222");
		const custom = spyOn(session, "sendCustomMessage");
		cleanups.push(() => {
			custom.mockRestore();
		});
		f.script.push(f.reply([{ type: "text", text }]));
		const dispatch = await f.send({ content: "Luna 用语音回复我" });
		expect(dispatch.responseMessageId).toBeUndefined();
		expect(f.sends).toEqual([]);
		expect(f.auditRequests).toEqual([]);
		expect(custom).toHaveBeenLastCalledWith(
			{ customType: WITHHELD_MESSAGE_TYPE, content: "", display: false },
			{ triggerTurn: false },
		);
		expect(f.logs).toContainEqual(
			expect.objectContaining({
				event: "reply_withheld",
				fields: { persona_id: "luna", platform: "telegram", reason: "leak_pattern" },
			}),
		);
	}
});

test("natural audit withholds below one half and accepts the exact boundary", async () => {
	for (const score of [0.499, 0.5]) {
		const f = fixture({ jev: true, audit: async () => score });
		const dispatch = await f.send();
		expect(f.auditRequests).toHaveLength(1);
		expect(f.auditRequests[0]).toMatchObject({ reply: "hello", message: "hi Luna" });
		expect(f.sends).toHaveLength(score < 0.5 ? 0 : 1);
		expect(dispatch.responseMessageId === undefined).toBe(score < 0.5);
		if (score < 0.5)
			expect(f.logs).toContainEqual(
				expect.objectContaining({
					event: "reply_withheld",
					fields: { persona_id: "luna", platform: "telegram", reason: "audit" },
				}),
			);
	}
});

test("audit failure opens addressed turns but closes directed and probability turns", async () => {
	for (const reason of ["explicit", "reply", "name", "directed", "probability"] as const) {
		const f = fixture({
			routingP: 1,
			jev: true,
			participation: async () => ({ directedPersonaId: reason === "directed" ? "luna" : null, chatIn: 1 }),
			audit: async () => {
				throw new Error("audit unavailable");
			},
		});
		const dispatch = await f.send({
			content: reason === "name" ? "Luna hello" : "ordinary conversation",
			mentionedUserIds: reason === "explicit" ? ["900"] : [],
			...(reason === "reply" ? { replyToAuthorId: "900" } : {}),
		});
		expect(dispatch.route.reason).toBe(reason);
		expect(f.auditRequests).toHaveLength(1);
		const closed = reason === "directed" || reason === "probability";
		expect(f.sends).toHaveLength(closed ? 0 : 1);
		if (closed)
			expect(f.logs).toContainEqual(
				expect.objectContaining({
					event: "reply_withheld",
					fields: { persona_id: "luna", platform: "telegram", reason: "audit_failed" },
				}),
			);
	}
});

test("event assignment and participation decisions start concurrently in the same inbound lane", async () => {
	let signalStarted!: () => void;
	const firstStarted = new Promise<void>((resolve) => {
		signalStarted = resolve;
	});
	let resolveParticipation!: (value: { directedPersonaId: null; chatIn: number }) => void;
	const participation = new Promise<{ directedPersonaId: null; chatIn: number }>((resolve) => {
		resolveParticipation = resolve;
	});
	let participationStarted = false;
	const f = fixture({
		events: true,
		jev: true,
		routingP: 1,
		participation: async () => {
			participationStarted = true;
			signalStarted();
			return participation;
		},
	});
	let resolveAssignment!: (value: null) => void;
	const assignment = new Promise<null>((resolve) => {
		resolveAssignment = resolve;
	});
	let assignmentStarted = false;
	const assign = spyOn(f.events!, "assign").mockImplementation(async () => {
		assignmentStarted = true;
		signalStarted();
		return assignment;
	});
	cleanups.push(() => {
		assign.mockRestore();
	});
	const pending = f.send({ mentionedUserIds: [], content: "ordinary conversation" });
	try {
		// Observe launch without releasing either operation or depending on wall-clock time.
		await firstStarted;
		await Promise.resolve();
		expect(assignmentStarted).toBe(true);
		expect(participationStarted).toBe(true);
		expect(f.calls()).toBe(0);
		expect(f.sends).toEqual([]);
	} finally {
		resolveAssignment(null);
		resolveParticipation({ directedPersonaId: null, chatIn: 1 });
		await pending;
	}
	expect(f.sends).toHaveLength(1);
});
