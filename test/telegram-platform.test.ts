import { describe, expect, test } from "bun:test";
import type { AppConfig } from "../src/config.ts";
import type { MemberMemory } from "../src/core/memory.ts";
import type { ConversationCore, Persona } from "../src/core/types.ts";
import { type BotApi, isReactionEmoji, TelegramApiError } from "../src/platforms/telegram/api.ts";
import { parseCommand, runCommand } from "../src/platforms/telegram/commands.ts";
import { formatTelegramMarkdown } from "../src/platforms/telegram/markdown.ts";
import {
	normalizeTelegramMessage,
	type TelegramMessage,
	type TelegramNormalizeDeps,
} from "../src/platforms/telegram/normalize.ts";
import {
	formatOutgoing,
	TELEGRAM_QUICK_REACTIONS,
	TelegramPlatformTransport,
} from "../src/platforms/telegram/transport.ts";

const CHAT = -1001234567890;

function normalizeDeps(overrides: Partial<TelegramNormalizeDeps> = {}): TelegramNormalizeDeps {
	return {
		allowedChatIds: new Set([String(CHAT)]),
		botUserIdsByUsername: new Map([["mizore_bot", "111"]]),
		downloadFile: async () => ({ bytes: new Uint8Array([1, 2, 3]), filePath: "videos/file_1.mp4" }),
		prepareImage: async () => ({ ok: true, image: { mimeType: "image/jpeg", base64: "AAAA" } }),
		extractVideoFrames: async () => ({
			ok: true,
			durationSeconds: 2,
			frames: [0.33, 0.66].map((position) => ({ bytes: new Uint8Array([9]), mimeType: "image/jpeg", position })),
		}),
		...overrides,
	};
}

function message(fields: Partial<TelegramMessage>): TelegramMessage {
	return {
		message_id: 42,
		date: 1_700_000_000,
		chat: { id: CHAT, type: "supergroup" },
		from: { id: 7, is_bot: false, first_name: "Ann", last_name: "Lee", username: "ann" },
		...fields,
	};
}

describe("Telegram message normalization", () => {
	test("resolves bot @mentions and text_mentions to user ids and keeps reply linkage", async () => {
		const text = "@Mizore_bot @someone_else hi";
		const normalized = await normalizeTelegramMessage(
			message({
				text,
				entities: [
					{ type: "mention", offset: 0, length: 11 },
					{ type: "mention", offset: 12, length: 13 },
					{ type: "text_mention", offset: 26, length: 2, user: { id: 555 } },
				],
				reply_to_message: message({ message_id: 40, from: { id: 111, is_bot: true, first_name: "Mizore" } }),
			}),
			normalizeDeps(),
		);
		expect(normalized).toMatchObject({
			platform: "telegram",
			spaceId: `telegram:${CHAT}`,
			channelId: String(CHAT),
			messageId: "42",
			authorId: "7",
			authorName: "Ann Lee",
			isBot: false,
			content: text,
			replyToMessageId: "40",
			replyToAuthorId: "111",
			timestamp: 1_700_000_000_000,
		});
		expect(normalized?.mentionedUserIds).toEqual(["111", "555"]);
	});

	test("mention offsets are UTF-16 units, so emoji before a mention still resolve", async () => {
		const normalized = await normalizeTelegramMessage(
			message({ text: "😀 @mizore_bot", entities: [{ type: "mention", offset: 3, length: 11 }] }),
			normalizeDeps(),
		);
		expect(normalized?.mentionedUserIds).toEqual(["111"]);
	});

	test("the implicit forum-topic root is not treated as a reply", async () => {
		const normalized = await normalizeTelegramMessage(
			message({ text: "hi", reply_to_message: { ...message({ message_id: 1 }), forum_topic_created: {} } }),
			normalizeDeps(),
		);
		expect(normalized?.replyToMessageId).toBeNull();
		expect(normalized?.replyToAuthorId).toBeNull();
	});

	test("chats outside the allow-list and empty service messages are dropped", async () => {
		expect(await normalizeTelegramMessage(message({ text: "hi", chat: { id: -100999 } }), normalizeDeps())).toBeNull();
		expect(await normalizeTelegramMessage(message({}), normalizeDeps())).toBeNull();
	});

	test("anonymous admins are attributed to the sender chat, not the placeholder bot", async () => {
		const normalized = await normalizeTelegramMessage(
			message({
				text: "notice",
				from: { id: 1087968824, is_bot: true, first_name: "Group" },
				sender_chat: { id: CHAT, title: "The Group" },
			}),
			normalizeDeps(),
		);
		expect(normalized).toMatchObject({ authorId: String(CHAT), authorName: "The Group", isBot: false });
	});

	test("non-image media become text placeholders ahead of the caption", async () => {
		const file = { file_id: "f" };
		const cases: Array<[Partial<TelegramMessage>, string]> = [
			[{ voice: file, caption: "听" }, "[语音] 听"],
			[{ audio: file }, "[语音]"],
			[{ document: file, caption: "报告" }, "[文件] 报告"],
			[{ sticker: { ...file, emoji: "😀", is_animated: true } }, "[贴纸 😀]"],
		];
		for (const [fields, content] of cases) {
			const normalized = await normalizeTelegramMessage(message(fields), normalizeDeps());
			expect(normalized?.content).toBe(content);
			expect(normalized?.images).toBeUndefined();
		}
	});

	test("videos become sampled frames with a frame-count marker, or [视频] when extraction fails", async () => {
		const video = { file_id: "v", file_size: 1000, mime_type: "video/mp4" };
		const sampled = await normalizeTelegramMessage(message({ video, caption: "看" }), normalizeDeps());
		expect(sampled?.content).toBe("[视频 2帧] 看");
		expect(sampled?.images).toHaveLength(2);

		const failed = await normalizeTelegramMessage(
			message({ animation: video, document: video }),
			normalizeDeps({ extractVideoFrames: async () => ({ ok: false, outcome: "video_transcoder_unavailable" }) }),
		);
		expect(failed?.content).toBe("[视频]");
		expect(failed?.images).toBeUndefined();

		let downloads = 0;
		const oversized = await normalizeTelegramMessage(
			message({ video: { file_id: "v", file_size: 21 * 1024 * 1024 } }),
			normalizeDeps({
				downloadFile: async () => {
					downloads++;
					return null;
				},
			}),
		);
		expect(oversized?.content).toBe("[视频]");
		expect(downloads).toBe(0);
	});

	test("photos and static stickers become images; a failed photo falls back to [图片]", async () => {
		const photo = await normalizeTelegramMessage(
			message({ photo: [{ file_id: "small" }, { file_id: "large" }] }),
			normalizeDeps(),
		);
		expect(photo?.content).toBe("");
		expect(photo?.images).toHaveLength(1);

		const sticker = await normalizeTelegramMessage(
			message({ sticker: { file_id: "s", emoji: "🐱" } }),
			normalizeDeps(),
		);
		expect(sticker?.content).toBe("[贴纸 🐱]");
		expect(sticker?.images).toHaveLength(1);

		const failed = await normalizeTelegramMessage(
			message({ photo: [{ file_id: "p" }] }),
			normalizeDeps({ downloadFile: async () => null }),
		);
		expect(failed?.content).toBe("[图片]");
		expect(failed?.images).toBeUndefined();
	});
});

describe("Telegram text commands", () => {
	test("parses a leading bot_command with optional lower-cased @target and arguments", () => {
		expect(parseCommand("/birthday@Mizore_Bot 09-25", [{ type: "bot_command", offset: 0, length: 20 }])).toEqual({
			name: "birthday",
			target: "mizore_bot",
			args: "09-25",
		});
		expect(parseCommand("/memory", [{ type: "bot_command", offset: 0, length: 7 }])).toEqual({
			name: "memory",
			target: null,
			args: "",
		});
	});

	test("unknown commands and commands not at offset 0 are ordinary chat", () => {
		expect(parseCommand("/start", [{ type: "bot_command", offset: 0, length: 6 }])).toBeNull();
		expect(parseCommand("try /help", [{ type: "bot_command", offset: 4, length: 5 }])).toBeNull();
		expect(parseCommand("/help", [])).toBeNull();
	});

	test("untargeted admin commands ask which persona when several bots share the chat", async () => {
		const persona = (id: string, username: string): Persona => ({
			id,
			name: id,
			personaPath: "",
			provider: "p",
			model: "m",
			reasoningEffort: "off",
			routingP: 0.5,
			aliases: [],
			adminUserIds: ["telegram:7"],
			sendReactionImages: true,
			voiceEnabled: false,
			accounts: { telegram: { userId: id, username } },
		});
		const personas = [persona("a", "a_bot"), persona("b", "b_bot")];
		let coreCalls = 0;
		const core = {
			getContextStatus: async () => {
				coreCalls++;
				return { tokens: 10, contextWindow: 100, compactionAtTokens: 80 };
			},
		} as unknown as ConversationCore;
		const context = {
			persona: personas[0]!,
			chatPersonas: personas,
			spaceId: `telegram:${CHAT}` as const,
			chatId: String(CHAT),
			messageId: "1",
			config: { celebrations: [] } as unknown as AppConfig,
			memberMemory: {} as MemberMemory,
			getCore: () => core,
		};
		const ambiguous = await runCommand({
			...context,
			userId: "7",
			command: { name: "context", target: null, args: "" },
		});
		expect(ambiguous).toContain("/context@a_bot");
		expect(ambiguous).toContain("/context@b_bot");
		const denied = await runCommand({
			...context,
			userId: "8",
			command: { name: "context", target: "a_bot", args: "" },
		});
		expect(denied).toContain("管理员");
		expect(coreCalls).toBe(0);
		await runCommand({ ...context, userId: "7", command: { name: "context", target: "a_bot", args: "" } });
		expect(coreCalls).toBe(1);
	});
});

describe("Telegram Markdown entities", () => {
	test("renders inline styles, code and public links as UTF-16 entities", () => {
		const formatted = formatTelegramMarkdown("😀 **粗** *斜* `code` [链接](https://example.com)");
		expect(formatted.text).toBe("😀 粗 斜 code 链接");
		expect(formatted.entities).toEqual([
			{ type: "bold", offset: 3, length: 1 },
			{ type: "italic", offset: 5, length: 1 },
			{ type: "code", offset: 7, length: 4 },
			{ type: "text_link", offset: 12, length: 2, url: "https://example.com/" },
		]);
	});

	test("non-public links keep their label but lose the link", () => {
		const formatted = formatTelegramMarkdown("[内网](http://127.0.0.1/admin)");
		expect(formatted).toEqual({ text: "内网", entities: [] });
	});

	test("fenced code keeps a sanitized language and blocks style overlap", () => {
		const formatted = formatTelegramMarkdown("```ts\nconst x = 1;\n```");
		expect(formatted).toEqual({
			text: "const x = 1;",
			entities: [{ type: "pre", offset: 0, length: 12, language: "ts" }],
		});
	});
});

describe("Telegram transport", () => {
	test("reaction whitelist follows the Bot API enum and the default table satisfies it", () => {
		for (const emoji of ["👍", "🤣", "❤️", "❤", "❤️‍🔥", "👨‍💻"]) expect(isReactionEmoji(emoji)).toBe(true);
		for (const emoji of ["😂", "🥺", "👍👍", "", "like"]) expect(isReactionEmoji(emoji)).toBe(false);
		for (const emoji of Object.keys(TELEGRAM_QUICK_REACTIONS)) expect(isReactionEmoji(emoji)).toBe(true);
	});

	test("an entity rejection is retried once as plain text, and @mentions never ping", async () => {
		const calls: Array<{ text: string; entities: readonly unknown[]; replyTo?: number }> = [];
		const api = {
			sendMessage: async (_chat: number, text: string, entities: readonly unknown[], replyTo?: number) => {
				calls.push({ text, entities, replyTo });
				if (entities.length > 0) throw new TelegramApiError(400, "Bad Request: can't parse entities");
				return { message_id: 99 };
			},
		} as unknown as BotApi;
		const transport = new TelegramPlatformTransport(new Map([["a", api]]));
		const sent = await transport.sendMessage({
			personaId: "a",
			channelId: String(CHAT),
			content: "**hi** @ann",
			replyToMessageId: "5",
		});
		expect(sent).toEqual({ id: "99" });
		expect(calls).toHaveLength(2);
		expect(calls[1]).toEqual({ text: "hi @\u2060ann", entities: [], replyTo: 5 });
	});

	test("mention defusing touches only displayed text, never links or code", () => {
		const [link] = formatOutgoing("[频道](https://www.youtube.com/@Veritasium) 和 https://www.youtube.com/@Veritasium");
		expect(link!.text).toBe("频道 和 https://www.youtube.com/@Veritasium");
		expect(link!.entities.filter((entity) => entity.type === "text_link").map((entity) => entity.url)).toEqual([
			"https://www.youtube.com/@Veritasium",
			"https://www.youtube.com/@Veritasium",
		]);

		const [inline] = formatOutgoing("用 `@dataclass` 问 @ann");
		expect(inline).toEqual({
			text: "用 @dataclass 问 @\u2060ann",
			entities: [{ type: "code", offset: 2, length: 10 }],
		});

		const [block] = formatOutgoing("**@ann** 看：\n\n```py\n@dataclass\nclass A: ...\n```");
		expect(block!.text).toBe("@\u2060ann 看：\n\n@dataclass\nclass A: ...");
		expect(block!.entities).toEqual([
			{ type: "bold", offset: 0, length: 5 },
			{ type: "pre", offset: 10, length: 23, language: "py" },
		]);
		expect(block!.text.slice(10, 33)).toBe("@dataclass\nclass A: ...");
	});

	test("only trusted mention recipients become notifying text_mentions", async () => {
		const calls: Array<{ text: string; entities: readonly unknown[] }> = [];
		const api = {
			sendMessage: async (_chat: number, text: string, entities: readonly unknown[]) => {
				calls.push({ text, entities });
				return { message_id: 1 };
			},
		} as unknown as BotApi;
		const transport = new TelegramPlatformTransport(new Map([["a", api]]));
		const ann = { userId: "7", username: "Ann_*Lee*" };
		const bob = { userId: "8", username: "@bob" };
		await transport.sendMessage({
			personaId: "a",
			channelId: String(CHAT),
			content: `**生日快乐 ${transport.formatMention(ann)}！** 还有 ${transport.formatMention(bob)} @carol`,
			mention: [ann],
		});
		const text = "生日快乐 Ann_*Lee*！ 还有 @\u2060bob @\u2060carol";
		expect(calls).toEqual([
			{
				text,
				entities: [
					{ type: "bold", offset: 0, length: 15 },
					{ type: "text_mention", offset: 5, length: 9, user: { id: 7 } },
				],
			},
		]);
		expect(text.slice(5, 14)).toBe("Ann_*Lee*");
	});

	test("over-long replies are split under 4096 characters and only the first one replies", async () => {
		const calls: Array<{ text: string; replyTo?: number }> = [];
		const api = {
			sendMessage: async (_chat: number, text: string, _entities: unknown, replyTo?: number) => {
				calls.push({ text, replyTo });
				return { message_id: calls.length };
			},
		} as unknown as BotApi;
		const transport = new TelegramPlatformTransport(new Map([["a", api]]));
		const paragraph = "字".repeat(3000);
		const sent = await transport.sendMessage({
			personaId: "a",
			channelId: String(CHAT),
			content: `${paragraph}\n\n${paragraph}\n\n${"x".repeat(9000)}`,
			replyToMessageId: "5",
		});
		expect(sent.id).toBe("1");
		expect(calls.length).toBeGreaterThanOrEqual(4);
		expect(calls.every((call) => call.text.length <= 4096 && call.text.trim().length > 0)).toBe(true);
		expect(calls.map((call) => call.replyTo)).toEqual([5, ...calls.slice(1).map(() => undefined)]);
	});
});
