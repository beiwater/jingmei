import { describe, expect, spyOn, test } from "bun:test";
import type { AppConfig } from "../src/config.ts";
import type { MemberMemory } from "../src/core/memory.ts";
import type { ConversationCore, InboundMessage, Persona } from "../src/core/types.ts";
import { BotApi, isReactionEmoji, TelegramApiError } from "../src/platforms/telegram/api.ts";
import { parseCommand, runCommand } from "../src/platforms/telegram/commands.ts";
import { createTelegramPlatform, type PlatformHandle } from "../src/platforms/telegram/index.ts";
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
		botUserIdsByUsername: new Map([["mizore_bot", "111"]]),
		downloadFile: async () => ({ bytes: new Uint8Array([1, 2, 3]), filePath: "videos/file_1.mp4" }),
		prepareImage: async () => ({ ok: true, image: { mimeType: "image/jpeg", base64: "AAAA" } }),
		extractVideoFrames: async () => ({
			ok: true,
			frames: Array.from({ length: 2 }, () => ({ bytes: new Uint8Array([9]), mimeType: "image/jpeg" })),
		}),
		...overrides,
	};
}

const NOW_SEC = Math.floor(Date.now() / 1000);

function message(fields: Partial<TelegramMessage>): TelegramMessage {
	return {
		message_id: 42,
		date: NOW_SEC,
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
			timestamp: NOW_SEC * 1000,
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

	test("empty service messages are dropped", async () => {
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

	test("messages older than three minutes keep media markers without downloading anything", async () => {
		let downloads = 0;
		const deps = normalizeDeps({
			downloadFile: async () => {
				downloads++;
				return { bytes: new Uint8Array([1, 2, 3]), filePath: "photos/file_1.jpg" };
			},
		});
		const old = NOW_SEC - 181;
		const photo = await normalizeTelegramMessage(
			message({ date: old, photo: [{ file_id: "p" }], caption: "看" }),
			deps,
		);
		expect(photo?.content).toBe("[图片] 看");
		expect(photo?.images).toBeUndefined();
		const video = await normalizeTelegramMessage(message({ date: old, video: { file_id: "v" } }), deps);
		expect(video?.content).toBe("[视频]");
		expect(downloads).toBe(0);
		const fresh = await normalizeTelegramMessage(message({ photo: [{ file_id: "p" }] }), deps);
		expect(fresh?.images).toHaveLength(1);
		expect(downloads).toBe(1);
	});
});

describe("Telegram adapter", () => {
	test("unlisted chats are rejected before commands, downloads and core dispatch", async () => {
		const delivered = Promise.withResolvers<void>();
		const received: InboundMessage[] = [];
		const persona: Persona = {
			id: "a",
			name: "A",
			personaPath: "",
			provider: "p",
			model: "m",
			reasoningEffort: "off",
			routingP: 0.5,
			aliases: [],
			adminUserIds: [],
			sendReactionImages: true,
			voiceEnabled: false,
			imageGenerationEnabled: false,
			accounts: {},
		};
		const getMe = spyOn(BotApi.prototype, "getMe").mockResolvedValue({
			id: 111,
			is_bot: true,
			first_name: "A",
			username: "a_bot",
		});
		const setCommands = spyOn(BotApi.prototype, "setMyCommands").mockResolvedValue(true);
		const send = spyOn(BotApi.prototype, "sendMessage").mockResolvedValue({ message_id: 99 });
		const getFile = spyOn(BotApi.prototype, "getFile").mockRejectedValue(new Error("unexpected download"));
		let firstPoll = true;
		const getUpdates = spyOn(BotApi.prototype, "getUpdates").mockImplementation(async (_offset, timeout, signal) => {
			if (timeout === 0) return [];
			if (firstPoll) {
				firstPoll = false;
				const ignoredChat = { id: -100999 };
				return [
					message({ chat: ignoredChat, text: "ignored" }),
					message({ chat: ignoredChat, text: "/help", entities: [{ type: "bot_command", offset: 0, length: 5 }] }),
					message({ chat: ignoredChat, photo: [{ file_id: "ignored" }] }),
					message({ text: "accepted" }),
				].map((message, index) => ({ update_id: index + 1, message }));
			}
			const { promise, reject } = Promise.withResolvers<unknown[]>();
			signal!.addEventListener("abort", () => reject(signal!.reason), { once: true });
			return promise;
		});
		let platform: PlatformHandle | undefined;
		try {
			platform = await createTelegramPlatform({
				config: {
					telegram: { chatIds: [String(CHAT)] },
					personas: [{ id: "a", tokens: { telegram: "test-token" } }],
				} as AppConfig,
				personas: [persona],
				memberMemory: {} as MemberMemory,
				getCore: () =>
					({
						handleMessage: async (message: InboundMessage) => {
							received.push(message);
							delivered.resolve();
						},
					}) as unknown as ConversationCore,
			});
			await platform.start();
			await delivered.promise;
			await platform.stop();
			expect(received.map(({ channelId, content }) => ({ channelId, content }))).toEqual([
				{ channelId: String(CHAT), content: "accepted" },
			]);
			expect(send).not.toHaveBeenCalled();
			expect(getFile).not.toHaveBeenCalled();
		} finally {
			await platform?.stop();
			for (const spy of [getMe, setCommands, send, getFile, getUpdates]) spy.mockRestore();
		}
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
			imageGenerationEnabled: false,
			accounts: { telegram: { userId: id, username } },
		});
		const personas = [persona("a", "a_bot"), persona("b", "b_bot")];
		let coreCalls = 0;
		const core = {
			getContextStatus: async () => {
				coreCalls++;
				return {
					tokens: 10,
					contextWindow: 1_000_000,
					segmentMaxTokens: 40_000,
					segmentIdleMs: 300_000,
					segmentMaxPending: 30,
					windowMessages: 30,
					safetyCompactionAtTokens: 983_616,
				};
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
	test.each([
		{
			name: "nested bold and italic inside links",
			markdown: "[**bold *italic***](https://example.com)",
			text: "bold italic",
			types: ["text_link", "bold", "italic"],
		},
		{
			name: "code inside styled text",
			markdown: "**before `code` *after***",
			text: "before code after",
			types: ["bold", "code", "bold", "italic"],
		},
		{
			name: "multi-line lists with styles",
			markdown: "- **first\n  second**\n- *third*",
			text: "• first\n  second\n• third",
			types: ["bold", "bold", "italic"],
		},
		{
			name: "astral emoji before and inside entities",
			markdown: "😀 [**🚀 *🌙***](https://example.com) `🧪`",
			text: "😀 🚀 🌙 🧪",
			types: ["text_link", "bold", "italic", "code"],
		},
		{
			name: "a fold containing styles, code, links and a quote",
			markdown: "结论\n\n```fold\n**要点** `x` [源](https://example.com)\n\n> 引用\n```",
			text: "结论\n\n要点 x 源 (https://example.com/)\n\n引用",
			types: ["expandable_blockquote", "bold"],
		},
	])("produces valid entity ranges for $name", ({ markdown, text, types }) => {
		const formatted = formatTelegramMarkdown(markdown);
		expect(formatted.text).toBe(text);
		expect(formatted.entities.map((entity) => entity.type)).toEqual([...types]);
		const boundaries = new Set([0]);
		let offset = 0;
		for (const character of formatted.text) {
			offset += character.length;
			boundaries.add(offset);
		}
		for (const entity of formatted.entities) {
			expect(Number.isSafeInteger(entity.offset)).toBe(true);
			expect(Number.isSafeInteger(entity.length)).toBe(true);
			expect(entity.length).toBeGreaterThan(0);
			expect(boundaries.has(entity.offset)).toBe(true);
			expect(boundaries.has(entity.offset + entity.length)).toBe(true);
		}
		for (const [index, left] of formatted.entities.entries()) {
			for (const right of formatted.entities.slice(index + 1)) {
				const leftEnd = left.offset + left.length;
				const rightEnd = right.offset + right.length;
				if (left.offset >= rightEnd || right.offset >= leftEnd) continue;
				expect(["code", "pre"]).not.toContain(left.type);
				expect(["code", "pre"]).not.toContain(right.type);
				expect(
					(left.offset <= right.offset && leftEnd >= rightEnd) || (right.offset <= left.offset && rightEnd >= leftEnd),
				).toBe(true);
			}
		}
	});

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

	test("a fold becomes a collapsed quote that holds only style entities", () => {
		const formatted = formatTelegramMarkdown(
			"先说结论。\n\n```fold\n1. **第一步** 跑 `bun test`\n2. 看 [文档](https://example.com/docs) 或 https://example.com\n```",
		);
		const text = "先说结论。\n\n1. 第一步 跑 bun test\n2. 看 文档 (https://example.com/docs) 或 https://example.com";
		expect(formatted).toEqual({
			text,
			entities: [
				{ type: "expandable_blockquote", offset: 7, length: text.length - 7 },
				{ type: "bold", offset: 10, length: 3 },
			],
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
