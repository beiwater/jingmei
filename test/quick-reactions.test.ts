import { expect, test } from "bun:test";
import type { JevClient } from "../src/decision/jev.ts";
import { QuickReactions } from "../src/core/quick-reactions.ts";
import type { InboundMessage, Persona, Platform, PlatformTransport, Route } from "../src/core/types.ts";

const persona = (id: string): Persona => ({
	id,
	name: id,
	personaPath: "/unused",
	provider: "fixture",
	model: "fixture",
	reasoningEffort: "off",
	routingP: 0,
	aliases: [],
	adminUserIds: [],
	sendReactionImages: false,
	voiceEnabled: false,
	imageGenerationEnabled: false,
	accounts: { telegram: { userId: `${id}-id`, username: id } },
});
const personas = [persona("luna"), persona("mio")];
const nobody: Route = { personaId: null, reason: "nobody" };

function harness(decision: { emoji: string | null; strongEmotion: number; funny: number }) {
	let now = 1_000_000;
	let jevCalls = 0;
	const reactions: Array<{ personaId: string; channelId: string; messageId: string; emoji: string }> = [];
	const client: JevClient = {
		decideQuickReaction: async () => {
			jevCalls++;
			return { ...decision, confidence: 0.9 };
		},
		scoreRelevance: async () => [],
		chooseEvent: async () => {
			throw new Error("unused");
		},
		scoreParticipation: async () => [],
		decideParticipation: async () => {
			throw new Error("unused");
		},
		auditNatural: async () => {
			throw new Error("unused");
		},
	};
	const transport = {
		platform: "telegram",
		echoesOwnMessages: false,
		displayName: "Telegram",
		promptLines: [],
		quickReactions: { "👍": "赞同", "🤣": "好笑" },
		sendMessage: async () => ({ id: "1" }),
		formatMention: (user) => `@${user.username}`,
		isValidReaction: (emoji: string) => emoji !== "😂",
		addReaction: async (personaId: string, channelId: string, messageId: string, emoji: string) => {
			reactions.push({ personaId, channelId, messageId, emoji });
		},
	} satisfies PlatformTransport;
	const quick = new QuickReactions(
		{
			client,
			quickReactions: true,
			memoryScoring: false,
			replyDecision: false,
			replyThreshold: 0.7,
			threshold: 0.8,
			minIntervalMs: 60_000,
		},
		new Map<Platform, PlatformTransport>([["telegram", transport]]),
		() => now,
	);
	let id = 1;
	const message = (overrides: Partial<InboundMessage> = {}): InboundMessage => ({
		platform: "telegram",
		spaceId: "telegram:-100",
		channelId: "-100",
		messageId: String(id++),
		authorId: "7",
		authorName: "alice",
		isBot: false,
		content: "哈哈哈笑死",
		...overrides,
	});
	return {
		quick,
		message,
		reactions,
		jevCalls: () => jevCalls,
		advance: (ms: number) => {
			now += ms;
		},
	};
}

test("unaddressed reactions need a strong signal and are rate-limited per channel without spending Jev calls", async () => {
	const h = harness({ emoji: "🤣", strongEmotion: 0.1, funny: 0.95 });
	await h.quick.react(h.message(), nobody, personas, []);
	await h.quick.react(h.message(), nobody, personas, []);
	expect(h.reactions.map((reaction) => [reaction.personaId, reaction.emoji])).toEqual([["luna", "🤣"]]);
	expect(h.jevCalls()).toBe(1);
	// Another channel has its own slot; the first channel reopens after the interval.
	await h.quick.react(h.message({ spaceId: "telegram:-200", channelId: "-200" }), nobody, personas, []);
	h.advance(60_000);
	await h.quick.react(h.message(), nobody, personas, []);
	expect(h.reactions).toHaveLength(3);
});

test("concurrent unaddressed decisions in one channel share one reaction slot", async () => {
	const h = harness({ emoji: "🤣", strongEmotion: 0, funny: 0.9 });
	await Promise.all([
		h.quick.react(h.message(), nobody, personas, []),
		h.quick.react(h.message(), nobody, personas, []),
	]);
	expect(h.reactions).toHaveLength(1);
});

test("addressed messages react from the routed persona regardless of threshold and rate limit", async () => {
	const h = harness({ emoji: "👍", strongEmotion: 0, funny: 0 });
	await h.quick.react(h.message(), nobody, personas, []);
	expect(h.reactions).toEqual([]);
	for (let index = 0; index < 2; index++)
		await h.quick.react(h.message(), { personaId: "mio", reason: "reply" }, personas, []);
	expect(h.reactions.map((reaction) => [reaction.personaId, reaction.emoji])).toEqual([
		["mio", "👍"],
		["mio", "👍"],
	]);
});

test("bot messages and emojis outside the platform table never react", async () => {
	const bot = harness({ emoji: "👍", strongEmotion: 1, funny: 1 });
	await bot.quick.react(bot.message({ isBot: true }), { personaId: "luna", reason: "explicit" }, personas, []);
	expect(bot.jevCalls()).toBe(0);
	const invented = harness({ emoji: "😂", strongEmotion: 1, funny: 1 });
	await invented.quick.react(invented.message(), { personaId: "luna", reason: "explicit" }, personas, []);
	expect(invented.reactions).toEqual([]);
});

test("directed messages react from the directed persona even without a strong signal or a free slot", async () => {
	const decision = { emoji: "👍", strongEmotion: 1, funny: 0 };
	const h = harness(decision);
	await h.quick.react(h.message(), nobody, personas, []);
	decision.strongEmotion = 0;
	await h.quick.react(h.message(), { personaId: "mio", reason: "directed" }, personas, []);
	expect(h.reactions.map((reaction) => [reaction.personaId, reaction.emoji])).toEqual([
		["luna", "👍"],
		["mio", "👍"],
	]);
});
