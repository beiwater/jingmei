import { describe, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
	Conversation,
	explicitSearchQuery,
	explicitVoiceRequest,
	searchQueryForRoutedMessage,
} from "../src/core/conversation.ts";
import { MemberMemory } from "../src/core/memory.ts";
import { SoulStore } from "../src/core/soul.ts";
import { routeMessage } from "../src/core/router.ts";
import { type ActiveTurn, createReactionImageTool } from "../src/core/tools.ts";
import type { InboundMessage, Persona, Platform, PlatformTransport } from "../src/core/types.ts";

function persona(id: string, name: string, userId: string, overrides: Partial<Persona> = {}): Persona {
	return {
		id,
		name,
		personaPath: "/unused",
		provider: "deepseek",
		model: "deepseek-flash",
		reasoningEffort: "off",
		routingP: 0.2,
		aliases: [],
		adminUserIds: [],
		sendReactionImages: true,
		voiceEnabled: true,
		accounts: { discord: { userId, username: name } },
		...overrides,
	};
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

function transports(sendMessage: PlatformTransport["sendMessage"]): Map<Platform, PlatformTransport> {
	return new Map([
		[
			"discord",
			{
				platform: "discord",
				displayName: "Discord",
				promptLines: [],
				quickReactions: {},
				sendMessage,
				formatMention: (user) => `@${user.username}`,
				isValidReaction: () => true,
			},
		],
	]);
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
		db.close();
	});

	test("recognizes direct voice requests without turning negations into audio", () => {
		expect(explicitVoiceRequest("菲八，用语音回复我一句你好")).toBe(true);
		expect(explicitVoiceRequest("Please send a voice reply in Japanese")).toBe(true);
		expect(explicitVoiceRequest("不用语音回复，打字就行")).toBe(false);
	});
});

describe("conversation guards", () => {
	test("only a platform-qualified persona admin may inspect or compact channel context", async () => {
		const db = new Database(":memory:");
		const core = new Conversation({
			db,
			memberMemory: new MemberMemory(db),
			soulStore: new SoulStore({ db, personaIds: ["mio"] }),
			dataDir: "/unused",
			routingSecret: "secret",
			personas: [{ ...personas[1]!, adminUserIds: ["telegram:55555555555555555"] }],
			modelRuntime: {} as ModelRuntime,
			transports: transports(async () => ({ id: "1" })),
		});
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
		db.close();
	});

	test("a failed reaction image read permits another send attempt", async () => {
		const turn: ActiveTurn = {
			spaceId: "discord:1",
			authorId: "3",
			sourceChannelId: "2",
			sourceMessageId: "1",
			query: "",
			visibleMemberIds: new Set(),
			memoryRecallCount: 0,
			replyToMessageId: "1",
			reply: { status: "idle" },
		};
		const tool = createReactionImageTool({
			personaId: "luna",
			transport: transports(async () => {
				throw new Error("must not send unread image");
			}).get("discord")!,
			spaceId: "discord:1",
			channelId: "2",
			getTurn: () => turn,
		});
		const read = fs.readFileSync as (...args: unknown[]) => unknown;
		const missing = spyOn(fs, "readFileSync").mockImplementation(((path: unknown, ...args: unknown[]) => {
			if (String(path).endsWith("/assets/reactions/hello.png")) throw new Error("fixture missing image");
			return read(path, ...args);
		}) as typeof fs.readFileSync);
		try {
			for (const call of ["first", "retry"])
				await expect(tool.execute(call, { asset_id: "hello" })).rejects.toThrow("fixture missing image");
		} finally {
			missing.mockRestore();
		}
	});
});
