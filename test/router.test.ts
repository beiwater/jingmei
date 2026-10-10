import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { ensureMessagesTable } from "../src/core/db.ts";
import {
	Conversation,
	explicitSearchQuery,
	explicitVoiceRequest,
	searchQueryForRoutedMessage,
} from "../src/core/conversation.ts";
import { participationGated, participationRoute, routeMessage } from "../src/core/router.ts";
import type { InboundMessage, Persona } from "../src/core/types.ts";
import { conversationOptions, makePersona, makeTransport } from "./support/core.ts";

function persona(id: string, name: string, userId: string, overrides: Partial<Persona> = {}): Persona {
	return makePersona({
		id,
		name,
		provider: "deepseek",
		model: "deepseek-flash",
		routingP: 0.2,
		sendReactionImages: true,
		voiceEnabled: true,
		accounts: { discord: { userId, username: name } },
		...overrides,
	});
}

const personas: Persona[] = [
	persona("luna", "Luna", "12345678901234567"),
	persona("mio", "Mio", "98765432109876543", {
		accounts: {
			discord: { userId: "98765432109876543", username: "mio" },
			telegram: { userId: "777", username: "mio_bot" },
		},
	}),
];

function message(overrides: Partial<InboundMessage> = {}): InboundMessage {
	return {
		platform: "discord",
		spaceId: "discord:11111111111111111",
		channelId: "22222222222222222",
		messageId: "18446744073709551615",
		authorId: "33333333333333333",
		authorName: "someone",
		isBot: false,
		content: "hello",
		...overrides,
	};
}

describe("routing", () => {
	test("explicit mention beats reply, reply beats name", () => {
		expect(
			routeMessage(
				message({ mentionedUserIds: ["98765432109876543"], replyToAuthorId: "12345678901234567", content: "Luna" }),
				personas,
				"secret",
			),
		).toEqual({ personaId: "mio", reason: "explicit" });
		expect(
			routeMessage(message({ replyToAuthorId: "12345678901234567", content: "hey Mio" }), personas, "secret"),
		).toEqual({ personaId: "luna", reason: "reply" });
		expect(routeMessage(message({ content: "hey LUNA, what do you think?" }), personas, "secret")).toEqual({
			personaId: "luna",
			reason: "name",
		});
	});

	test("matches mentions by the account on the message's own platform", () => {
		const telegram = message({
			platform: "telegram",
			spaceId: "telegram:-1001",
			channelId: "-1001",
			mentionedUserIds: ["12345678901234567", "777"],
		});
		// Luna has no Telegram account: out of scope there, so her Discord id is not a mention.
		expect(routeMessage(telegram, personas, "secret")).toEqual({ personaId: "mio", reason: "explicit" });
	});

	test("names and aliases only route within each persona's configured spaces", () => {
		const stanley = persona("shize", "许诗泽", "12345678901234567", {
			aliases: ["Stanley", "Stanley Xu"],
			spaces: ["discord:11111111111111111"],
			routingP: 0,
		});
		expect(routeMessage(message({ content: "Stanley 在吗" }), [stanley], "secret")).toEqual({
			personaId: "shize",
			reason: "name",
		});
		expect(
			routeMessage(message({ spaceId: "discord:44444444444444444", content: "Stanley 在吗" }), [stanley], "secret"),
		).toEqual({ personaId: null, reason: "nobody" });
	});

	test("bot messages never trigger; probability sampling is stable and pinned to the HMAC input", () => {
		expect(routeMessage(message({ isBot: true, mentionedUserIds: ["12345678901234567"] }), personas, "secret")).toEqual(
			{ personaId: null, reason: "nobody" },
		);
		const all = personas.map((candidate) => ({ ...candidate, routingP: 0.4 }));
		// Golden values: changing the HMAC input or sampling would silently reshuffle live routing.
		expect(routeMessage(message({ messageId: "1" }), all, "secret")).toEqual({
			personaId: "luna",
			reason: "probability",
		});
		expect(routeMessage(message({ messageId: "3" }), all, "secret")).toEqual({
			personaId: "mio",
			reason: "probability",
		});
		expect(routeMessage(message(), all, "secret")).toEqual({ personaId: null, reason: "nobody" });
		const never = personas.map((candidate) => ({ ...candidate, routingP: 0 }));
		expect(routeMessage(message(), never, "secret")).toEqual({ personaId: null, reason: "nobody" });
	});
});

describe("participation gates", () => {
	const now = 1_000_000;
	const rows = (own: number, total: number, otherAuthors = 2, timestamp = now - 60_000) =>
		Array.from({ length: total }, (_, index) => ({
			authorId: index < own ? "bot" : `human-${(index - own) % otherAuthors}`,
			timestamp,
		}));

	test("the cooldown closes below thirty seconds and opens exactly at the boundary", () => {
		expect(participationGated("bot", [], now - 29_999, now)).toBe(true);
		expect(participationGated("bot", [], now - 30_000, now)).toBe(false);
		expect(participationGated("bot", [], null, now)).toBe(false);
	});

	test("share gating requires three own messages, two other authors, and at least twenty-five percent", () => {
		expect(participationGated("bot", rows(2, 8), null, now)).toBe(false);
		expect(participationGated("bot", rows(3, 12, 1), null, now)).toBe(false);
		expect(participationGated("bot", rows(3, 13), null, now)).toBe(false);
		expect(participationGated("bot", rows(3, 12), null, now)).toBe(true);
		expect(participationGated("bot", rows(3, 11), null, now)).toBe(true);
	});

	test("the ten-minute boundary is inclusive and only the thirty newest rows count", () => {
		expect(participationGated("bot", rows(3, 12, 2, now - 600_000), null, now)).toBe(true);
		expect(participationGated("bot", rows(3, 12, 2, now - 600_001), null, now)).toBe(false);
		expect(participationGated("bot", [...rows(0, 30), ...rows(3, 3)], null, now)).toBe(false);
		expect(participationGated("bot", [...rows(8, 30), ...rows(0, 30)], null, now)).toBe(true);
	});

	test("directed decisions beat the gate and HMAC candidate; chat-in cannot bypass either", () => {
		const sampled = { personaId: "luna", reason: "probability" } as const;
		const nobody = { personaId: null, reason: "nobody" } as const;
		expect(participationRoute(sampled, true, "mio", undefined, 0.7, true)).toEqual({
			personaId: "mio",
			reason: "directed",
		});
		expect(participationRoute(nobody, true, "mio", undefined, 0.7, true)).toEqual({
			personaId: "mio",
			reason: "directed",
		});
		expect(participationRoute(sampled, true, null, 1, 0.7, true)).toEqual(nobody);
		expect(participationRoute(nobody, false, null, 1, 0.7, true)).toEqual(nobody);
		expect(participationRoute(sampled, false, null, 0.699, 0.7, true)).toEqual(nobody);
		expect(participationRoute(sampled, false, null, undefined, 0.7, true)).toEqual(nobody);
		expect(participationRoute(sampled, false, null, 0.7, 0.7, true)).toEqual(sampled);
		expect(participationRoute(sampled, false, null, undefined, 0.7, false)).toEqual(sampled);
		expect(participationRoute(sampled, true, null, undefined, 0.7, false)).toEqual(nobody);
	});
});

describe("search and voice triggers", () => {
	test("prefetches an explicit lookup while ignoring a search availability question", () => {
		expect(explicitSearchQuery("<@1552581470013362197> 你查一下 HSC EAL/D Module D 是什么")).toBe(
			"你查一下 HSC EAL/D Module D 是什么",
		);
		expect(explicitSearchQuery("@mio_bot 帮我查 明天天气")).toBe("帮我查 明天天气");
		expect(explicitSearchQuery("为什么还是没有联网搜索？")).toBeNull();
		expect(explicitSearchQuery("早上好")).toBeNull();
	});

	test("a separate mention searches the same author's immediately preceding request", () => {
		const db = new Database(":memory:");
		db.exec(`CREATE TABLE messages (
			space_id TEXT, channel_id TEXT, message_id TEXT, author_id TEXT, is_bot INTEGER, content TEXT, timestamp INTEGER
		)`);
		ensureMessagesTable(db);
		const insert = db.query(
			"INSERT INTO messages (space_id, channel_id, message_id, author_id, is_bot, content, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)",
		);
		const current = message({
			content: "<@98765432109876543>",
			mentionedUserIds: ["98765432109876543"],
			timestamp: 1_000_011,
		});
		const request = "你搜一下2025年的HSCEALD题目，按这个的Model D写完整英文文章";
		insert.run(current.spaceId, current.channelId, "18446744073709551614", current.authorId, 0, request, 1_000_000);
		const route = routeMessage(current, personas, "secret");
		expect(searchQueryForRoutedMessage(db, current, route)).toBe(request);
		insert.run(current.spaceId, current.channelId, "18446744073709551613", "44444444444444444", 0, "hi", 1_000_010);
		expect(searchQueryForRoutedMessage(db, current, route)).toBeNull();
		insert.run(current.spaceId, current.channelId, "18446744073709551612", current.authorId, 0, request, 1_000_010);
		expect(searchQueryForRoutedMessage(db, { ...current, timestamp: 1_200_011 }, route)).toBeNull();
	});

	test("recognizes direct voice requests without turning negations into audio", () => {
		expect(explicitVoiceRequest("菲八，用语音回复我一句你好")).toBe(true);
		expect(explicitVoiceRequest("Please send a voice reply in Japanese")).toBe(true);
		expect(explicitVoiceRequest("不用语音回复，打字就行")).toBe(false);
	});
});

describe("conversation guards", () => {
	test("only a platform-qualified persona admin may inspect or compact channel context", async () => {
		const core = new Conversation(
			conversationOptions({
				personas: [{ ...personas[1]!, adminUserIds: ["telegram:55555555555555555"] }],
				transports: [makeTransport()],
			}),
		);
		for (const [platform, requester] of [
			["discord", "33333333333333333"],
			// The same raw id is a different person on another platform.
			["discord", "55555555555555555"],
		] as const) {
			await expect(
				core.getContextStatus("mio", platform, "discord:11111111111111111", "222", requester),
			).rejects.toThrow("not_persona_admin");
			await expect(core.compactContext("mio", platform, "discord:11111111111111111", "222", requester)).rejects.toThrow(
				"not_persona_admin",
			);
		}
		await core.close();
	});
});
