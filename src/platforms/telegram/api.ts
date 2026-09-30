// Minimal Telegram Bot API client over fetch. No third-party SDK.
// Docs: https://core.telegram.org/bots/api
// The token is part of every URL: never log URLs, request bodies, or raw fetch errors.

import type { TelegramMessageEntity } from "./markdown.ts";

const API_BASE = "https://api.telegram.org";
const CALL_TIMEOUT_MS = 10_000;
const UPLOAD_TIMEOUT_MS = 60_000;
const DOWNLOAD_TIMEOUT_MS = 30_000;
const CHAT_ACTION_TIMEOUT_MS = 3500;
// headroom on top of the long-poll window so the server-side timeout fires first
const LONG_POLL_GRACE_MS = 10_000;

export class TelegramApiError extends Error {
	code: number;
	description: string;
	retryAfter: number | null;
	/** `api`: structured Bot API error body; `non_json`: an intermediary answered with HTML/text. */
	kind: "api" | "non_json";
	constructor(code: number, description: string, retryAfter: number | null = null, kind: "api" | "non_json" = "api") {
		super(`telegram api error ${code}: ${description}`);
		this.code = code;
		this.description = description;
		this.retryAfter = retryAfter;
		this.kind = kind;
	}
}

interface ApiResponse<T> {
	ok: boolean;
	result?: T;
	error_code?: number;
	description?: string;
	parameters?: { retry_after?: number };
}

export interface TelegramUser {
	id: number;
	is_bot: boolean;
	first_name: string;
	last_name?: string;
	username?: string;
	can_read_all_group_messages?: boolean;
}

export interface TelegramInputFile {
	name: string;
	data: Uint8Array;
	contentType: string;
}

export interface SentTelegramMessage {
	message_id: number;
}

function replyParameters(replyToMessageId: number | undefined): Record<string, unknown> {
	// allow_sending_without_reply: a deleted target must not make the whole reply fail
	return replyToMessageId
		? { reply_parameters: { message_id: replyToMessageId, allow_sending_without_reply: true } }
		: {};
}

async function parseResponse<T>(res: Response): Promise<T> {
	let body: ApiResponse<T>;
	try {
		body = (await res.json()) as ApiResponse<T>;
	} catch {
		// intermediaries can answer with HTML/text (e.g. 502 pages); keep the HTTP status
		throw new TelegramApiError(res.status, `non-JSON response (HTTP ${res.status})`, null, "non_json");
	}
	if (!body.ok) {
		throw new TelegramApiError(
			body.error_code ?? res.status,
			body.description ?? "unknown",
			body.parameters?.retry_after ?? null,
		);
	}
	return body.result as T;
}

export class BotApi {
	private readonly token: string;
	constructor(token: string) {
		this.token = token;
	}

	async call<T = unknown>(
		method: string,
		params: Record<string, unknown> = {},
		timeoutMs: number = CALL_TIMEOUT_MS,
		externalSignal?: AbortSignal,
	): Promise<T> {
		const res = await fetch(`${API_BASE}/bot${this.token}/${method}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(params),
			signal: externalSignal
				? AbortSignal.any([externalSignal, AbortSignal.timeout(timeoutMs)])
				: AbortSignal.timeout(timeoutMs),
		});
		return parseResponse<T>(res);
	}

	private async callMultipart<T>(method: string, form: FormData): Promise<T> {
		const res = await fetch(`${API_BASE}/bot${this.token}/${method}`, {
			method: "POST",
			body: form,
			signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
		});
		return parseResponse<T>(res);
	}

	getMe(): Promise<TelegramUser> {
		return this.call("getMe");
	}

	getUpdates(offset: number, timeoutSec: number, signal?: AbortSignal): Promise<unknown[]> {
		return this.call(
			"getUpdates",
			{ offset, timeout: timeoutSec, allowed_updates: ["message"] },
			timeoutSec * 1000 + LONG_POLL_GRACE_MS,
			signal,
		);
	}

	setMyCommands(commands: readonly { command: string; description: string }[]): Promise<true> {
		return this.call<true>("setMyCommands", { commands, scope: { type: "all_group_chats" } });
	}

	sendMessage(
		chatId: number,
		text: string,
		entities: readonly TelegramMessageEntity[] = [],
		replyToMessageId?: number,
	): Promise<SentTelegramMessage> {
		return this.call("sendMessage", {
			chat_id: chatId,
			text,
			...(entities.length > 0 ? { entities } : {}),
			link_preview_options: { is_disabled: true },
			...replyParameters(replyToMessageId),
		});
	}

	/** `sendPhoto` / `sendAudio` with an uploaded file and optional formatted caption. */
	sendFile(
		method: "sendPhoto" | "sendAudio",
		chatId: number,
		file: TelegramInputFile,
		caption?: { text: string; entities: readonly TelegramMessageEntity[] },
		replyToMessageId?: number,
	): Promise<SentTelegramMessage> {
		const form = new FormData();
		form.set("chat_id", String(chatId));
		form.set(method === "sendPhoto" ? "photo" : "audio", new Blob([file.data], { type: file.contentType }), file.name);
		if (caption?.text) {
			form.set("caption", caption.text);
			if (caption.entities.length > 0) form.set("caption_entities", JSON.stringify(caption.entities));
		}
		const reply = replyParameters(replyToMessageId).reply_parameters;
		if (reply) form.set("reply_parameters", JSON.stringify(reply));
		return this.callMultipart(method, form);
	}

	/** Bots get one non-paid reaction per message; re-setting the same emoji is idempotent. */
	setMessageReaction(chatId: number, messageId: number, emoji: string): Promise<true> {
		return this.call<true>("setMessageReaction", {
			chat_id: chatId,
			message_id: messageId,
			reaction: [{ type: "emoji", emoji }],
		});
	}

	/** Shows "typing…" for up to five seconds or until the bot sends a message. */
	sendChatAction(chatId: number): Promise<true> {
		return this.call<true>("sendChatAction", { chat_id: chatId, action: "typing" }, CHAT_ACTION_TIMEOUT_MS);
	}

	getFile(
		fileId: string,
	): Promise<{ file_id: string; file_unique_id: string; file_size?: number; file_path?: string }> {
		return this.call("getFile", { file_id: fileId });
	}

	async downloadFile(filePath: string, maxBytes: number): Promise<Uint8Array> {
		const res = await fetch(`${API_BASE}/file/bot${this.token}/${filePath}`, {
			signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
		});
		if (!res.ok) throw new TelegramApiError(res.status, "file download failed");
		const declared = Number(res.headers.get("content-length") ?? "0");
		if (declared > maxBytes) {
			await res.body?.cancel();
			throw new TelegramApiError(413, "file too large");
		}
		const bytes = new Uint8Array(await res.arrayBuffer());
		if (bytes.byteLength > maxBytes) throw new TelegramApiError(413, "file too large");
		return bytes;
	}
}

// The fixed ReactionTypeEmoji enum (https://core.telegram.org/bots/api#reactiontypeemoji,
// captured 2026-09-21). Both sides strip U+FE0F variation selectors, so "❤" and "❤️"
// spellings of the same emoji are equivalent; ZWJ sequences stay explicit.
const REACTION_EMOJIS: ReadonlySet<string> = new Set(
	[
		"❤",
		"👍",
		"👎",
		"🔥",
		"🥰",
		"👏",
		"😁",
		"🤔",
		"🤯",
		"😱",
		"🤬",
		"😢",
		"🎉",
		"🤩",
		"🤮",
		"💩",
		"🙏",
		"👌",
		"🕊",
		"🤡",
		"🥱",
		"🥴",
		"😍",
		"🐳",
		"❤\u200d🔥",
		"🌚",
		"🌭",
		"💯",
		"🤣",
		"⚡",
		"🍌",
		"🏆",
		"💔",
		"🤨",
		"😐",
		"🍓",
		"🍾",
		"💋",
		"🖕",
		"😈",
		"😴",
		"😭",
		"🤓",
		"👻",
		"👨\u200d💻",
		"👀",
		"🎃",
		"🙈",
		"😇",
		"😨",
		"🤝",
		"✍",
		"🤗",
		"🫡",
		"🎅",
		"🎄",
		"☃",
		"💅",
		"🤪",
		"🗿",
		"🆒",
		"💘",
		"🙉",
		"🦄",
		"😘",
		"💊",
		"🙊",
		"😎",
		"👾",
		"🤷\u200d♂",
		"🤷",
		"🤷\u200d♀",
		"😡",
	].map((emoji) => emoji.replaceAll("\ufe0f", "")),
);

/** Telegram rejects any emoji outside its fixed reaction enum with REACTION_INVALID. */
export function isReactionEmoji(value: string): boolean {
	return REACTION_EMOJIS.has(value.replaceAll("\ufe0f", ""));
}
