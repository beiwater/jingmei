/** Multiplexes one Bot API client per persona behind the platform-neutral transport. */

import type { OutboundAttachment, PersonaAccount, PlatformTransport } from "../../core/types.ts";
import { errorCategory, log } from "../../observability/log.ts";
import { type BotApi, isReactionEmoji, type SentTelegramMessage, TelegramApiError } from "./api.ts";
import {
	formatTelegramMarkdown,
	TelegramMarkdownError,
	type TelegramFormattedMessage,
	type TelegramMessageEntity,
} from "./markdown.ts";

/** Telegram's reaction enum has no 😂; 🤣 stands in for "funny". */
export const TELEGRAM_QUICK_REACTIONS: Readonly<Record<string, string>> = {
	"👍": "赞同、收到",
	"🤣": "好笑",
	"😭": "难过、破防",
	"❤": "暖心、感谢",
	"🤔": "疑问、不确定",
};

const TELEGRAM_PROMPT_LINES: readonly string[] = [
	"- Telegram 消息正文支持 Markdown 子集：**粗体**、*斜体*、~~删除线~~、> 引用、`行内代码`、三反引号代码块、[来源](https://example.com) 链接。标题会显示为粗体，列表和表格会显示为纯文本。按内容选择，普通聊天保持自然，不要每句都加格式。",
	"- Telegram 单条消息正文上限 4096 字符；超长会被拆成多条，长答用清楚的短段落组织。",
	"- 大段解释、长清单、详细步骤这类可以先不看的细节，放进 ```fold 代码块：Telegram 会显示成默认收起的引用，点开才看到全文，块里照常用 Markdown。结论用一两句写在块外面；闲聊和短回答不要用。",
	"- Telegram 不渲染 LaTeX 数学公式；写数学时用清楚的纯文本或代码块，不要输出 $ 或 $$ 公式标记。",
	"- 不要用 @用户名 点名群成员，直接称呼名字。",
];

/** Leaves headroom under Telegram's 4096 limit for list markers the renderer adds. */
const CHUNK_CHARS = 4000;
const MAX_TEXT_CODE_POINTS = 4096;
const CAPTION_CHARS = 1024;

/**
 * `formatMention` output: private-use delimiters around a numeric user id and a Markdown-escaped
 * display name. They survive Markdown rendering as plain text and are resolved afterwards.
 */
const MENTION_SENTINEL = /\uE000(\d{1,20})\uE001([^\uE000-\uE002]*)\uE002/g;
/** `@` that Telegram would parse as a username mention: not glued to a URL, email or word. */
const BARE_AT = /(?<![\w/.:@-])@(?=\w)/g;
/** A word joiner after `@` stops Telegram from turning `@username` into a notifying mention. */
const WORD_JOINER = "\u2060";

interface TextEdit {
	offset: number;
	remove: number;
	insert: string;
	/** Set for a trusted mention: the replacement becomes a notifying `text_mention`. */
	userId?: number;
}

function defuse(text: string): string {
	return text.replace(BARE_AT, `@${WORD_JOINER}`);
}

/**
 * Resolves mention sentinels and defuses bare `@username` in displayed text only, shifting entity
 * offsets (UTF-16) for every inserted/removed character. Links and code are never rewritten, and
 * only ids in `mentionIds` become notifying `text_mention` entities.
 */
function finalizeOutgoing(
	formatted: TelegramFormattedMessage,
	mentionIds: ReadonlySet<string>,
): TelegramFormattedMessage {
	const { text } = formatted;
	const verbatim = formatted.entities
		.filter((entity) => entity.type === "text_link" || entity.type === "code" || entity.type === "pre")
		.map((entity): [number, number] => [entity.offset, entity.offset + entity.length]);
	const insideVerbatim = (start: number, end: number) => verbatim.some(([from, to]) => start < to && end > from);
	const edits: TextEdit[] = [];
	const sentinels: Array<[number, number]> = [];
	for (const match of text.matchAll(MENTION_SENTINEL)) {
		const start = match.index;
		const end = start + match[0].length;
		sentinels.push([start, end]);
		const trusted = mentionIds.has(match[1]!) && !insideVerbatim(start, end);
		const name = defuse(match[2]!) || match[1]!;
		edits.push({ offset: start, remove: end - start, insert: name, ...(trusted ? { userId: Number(match[1]) } : {}) });
	}
	for (const match of text.matchAll(BARE_AT)) {
		const at = match.index;
		if (insideVerbatim(at, at + 1) || sentinels.some(([from, to]) => at >= from && at < to)) continue;
		edits.push({ offset: at + 1, remove: 0, insert: WORD_JOINER });
	}
	if (edits.length === 0) return formatted;
	// an insertion right before a replaced range must be emitted first
	edits.sort((a, b) => a.offset - b.offset || a.remove - b.remove);

	let result = "";
	let cursor = 0;
	const placed: Array<{ edit: TextEdit; newOffset: number }> = [];
	for (const edit of edits) {
		result += text.slice(cursor, edit.offset);
		placed.push({ edit, newOffset: result.length });
		result += edit.insert;
		cursor = edit.offset + edit.remove;
	}
	result += text.slice(cursor);
	/** Old UTF-16 position → new one; a position inside a replaced range snaps to the replacement's end. */
	const map = (position: number): number => {
		let delta = 0;
		for (const { edit, newOffset } of placed) {
			const editEnd = edit.offset + edit.remove;
			if (position >= editEnd) delta = newOffset + edit.insert.length - editEnd;
			else if (position > edit.offset) return newOffset + edit.insert.length;
			else break;
		}
		return position + delta;
	};
	const entities: TelegramMessageEntity[] = [];
	for (const entity of formatted.entities) {
		const offset = map(entity.offset);
		const length = map(entity.offset + entity.length) - offset;
		if (length > 0) entities.push({ ...entity, offset, length });
	}
	for (const { edit, newOffset } of placed) {
		if (edit.userId !== undefined && edit.insert.length > 0)
			entities.push({ type: "text_mention", offset: newOffset, length: edit.insert.length, user: { id: edit.userId } });
	}
	entities.sort((a, b) => a.offset - b.offset || b.length - a.length);
	return { text: result, entities };
}

/** Paragraph-greedy split into pieces of at most `limit` UTF-16 units, never inside a surrogate pair. */
function splitLongText(text: string, limit: number): string[] {
	const chunks: string[] = [];
	let current = "";
	for (const paragraph of text.split(/\n{2,}/)) {
		const candidate = current ? `${current}\n\n${paragraph}` : paragraph;
		if (candidate.length <= limit) {
			current = candidate;
			continue;
		}
		if (current) chunks.push(current);
		current = paragraph;
		while (current.length > limit) {
			const high = current.charCodeAt(limit - 1);
			const cut = high >= 0xd800 && high <= 0xdbff ? limit - 1 : limit;
			chunks.push(current.slice(0, cut));
			current = current.slice(cut);
		}
	}
	if (current) chunks.push(current);
	return chunks.filter((chunk) => chunk.trim().length > 0);
}

/** Markdown → one or more Telegram text+entities messages; unformattable pieces go out as plain text. */
export function formatOutgoing(
	markdown: string,
	mentionIds: ReadonlySet<string> = new Set(),
): TelegramFormattedMessage[] {
	try {
		const single = finalizeOutgoing(formatTelegramMarkdown(markdown), mentionIds);
		if ([...single.text].length <= MAX_TEXT_CODE_POINTS) return [single];
	} catch (error) {
		if (!(error instanceof TelegramMarkdownError) || error.category === "empty") throw error;
	}
	return splitLongText(markdown, CHUNK_CHARS).map((chunk) => {
		let formatted: TelegramFormattedMessage;
		try {
			formatted = formatTelegramMarkdown(chunk);
		} catch {
			formatted = { text: chunk, entities: [] };
		}
		return finalizeOutgoing(formatted, mentionIds);
	});
}

/** One plain retry when Telegram rejects our entities (400) — nothing was created in that case. */
async function withPlainFallback(
	entities: readonly TelegramMessageEntity[],
	send: (entities: readonly TelegramMessageEntity[]) => Promise<SentTelegramMessage>,
): Promise<SentTelegramMessage> {
	try {
		return await send(entities);
	} catch (error) {
		if (!(error instanceof TelegramApiError) || error.kind !== "api" || error.code !== 400 || entities.length === 0)
			throw error;
		log.warn("telegram", "entities_rejected", { telegram_code: error.code });
		return send([]);
	}
}

export class TelegramPlatformTransport implements PlatformTransport {
	readonly platform = "telegram" as const;
	readonly echoesOwnMessages = false;
	readonly displayName = "Telegram";
	readonly promptLines = TELEGRAM_PROMPT_LINES;
	/** sendChatAction shows "typing…" for at most five seconds. */
	readonly typingRefreshMs = 4_000;

	constructor(
		private readonly apis: ReadonlyMap<string, BotApi>,
		readonly quickReactions: Readonly<Record<string, string>> = TELEGRAM_QUICK_REACTIONS,
	) {}

	private api(personaId: string): BotApi {
		const api = this.apis.get(personaId);
		if (!api) throw new Error("telegram_persona_unavailable");
		return api;
	}

	async sendMessage(input: {
		personaId: string;
		channelId: string;
		content: string;
		replyToMessageId?: string;
		attachments?: readonly OutboundAttachment[];
		mention?: readonly PersonaAccount[];
	}): Promise<{ id: string }> {
		const api = this.api(input.personaId);
		const chatId = Number(input.channelId);
		let replyTo = input.replyToMessageId ? Number(input.replyToMessageId) : undefined;
		const mentionIds = new Set(input.mention?.map((user) => user.userId));
		const texts = input.content.trim() ? formatOutgoing(input.content, mentionIds) : [];
		let firstId: number | undefined;
		const attachment = input.attachments?.[0];
		if (attachment) {
			const caption = texts.length === 1 && [...texts[0]!.text].length <= CAPTION_CHARS ? texts.shift() : undefined;
			const method = attachment.contentType.startsWith("image/") ? "sendPhoto" : "sendAudio";
			const sent = await withPlainFallback(caption?.entities ?? [], (entities) =>
				api.sendFile(method, chatId, attachment, caption && { text: caption.text, entities }, replyTo),
			);
			firstId = sent.message_id;
			replyTo = undefined;
		}
		if (!attachment && texts.length === 0) throw new Error("telegram_empty_message");
		for (const text of texts) {
			const sent = await withPlainFallback(text.entities, (entities) =>
				api.sendMessage(chatId, text.text, entities, replyTo),
			);
			firstId ??= sent.message_id;
			replyTo = undefined;
		}
		return { id: String(firstId) };
	}

	async startTyping(personaId: string, channelId: string): Promise<void> {
		await this.api(personaId)
			.sendChatAction(Number(channelId))
			.catch((error: unknown) =>
				log.warn("telegram", "typing_failed", { persona_id: personaId, error_category: errorCategory(error) }),
			);
	}

	async addReaction(personaId: string, channelId: string, messageId: string, emoji: string): Promise<void> {
		if (!isReactionEmoji(emoji)) throw new Error("telegram_reaction_invalid");
		await this.api(personaId).setMessageReaction(Number(channelId), Number(messageId), emoji);
	}

	/** Resolved into a notifying `text_mention` only when `user` is also passed as a `mention` recipient. */
	formatMention(user: PersonaAccount): string {
		const name = user.username.replace(/[\uE000-\uE002\r\n]/g, " ").replace(/[\\`*_~[\]()#+\-.!|<>&]/g, "\\$&");
		return `\uE000${user.userId}\uE001${name}\uE002`;
	}

	isValidReaction(emoji: string): boolean {
		return isReactionEmoji(emoji);
	}
}
