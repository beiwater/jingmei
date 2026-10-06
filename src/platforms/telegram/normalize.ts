// Telegram Bot API message → platform-neutral InboundMessage.
// Telegram never delivers one bot's messages to another bot, so personas cannot observe each
// other's Telegram output through updates; the core only knows what it sent itself.

import { type InboundImage, type InboundMessage, STALE_MESSAGE_MS, spaceId } from "../../core/types.ts";
import type { prepareImage } from "../../media/image.ts";
import type { extractVideoFrames } from "../../media/video-frames.ts";

/** Bot API `getFile` refuses files above 20 MB; do not even ask for larger ones. */
export const MAX_TELEGRAM_FILE_BYTES = 20 * 1024 * 1024;

export interface TelegramEntity {
	type: string;
	offset: number;
	length: number;
	user?: { id: number };
}

interface TelegramFileRef {
	file_id: string;
	file_size?: number;
	mime_type?: string;
}

interface TelegramSender {
	id: number;
	is_bot?: boolean;
	first_name?: string;
	last_name?: string;
	username?: string;
	title?: string;
}

/** The subset of Bot API `Message` the adapter reads. Only the envelope is runtime-checked. */
export interface TelegramMessage {
	message_id: number;
	date: number;
	chat: { id: number; type?: string };
	from?: TelegramSender;
	sender_chat?: TelegramSender;
	text?: string;
	caption?: string;
	entities?: TelegramEntity[];
	caption_entities?: TelegramEntity[];
	reply_to_message?: TelegramMessage & { forum_topic_created?: unknown };
	photo?: Array<TelegramFileRef & { width?: number; height?: number }>;
	sticker?: TelegramFileRef & { emoji?: string; is_animated?: boolean; is_video?: boolean };
	video?: TelegramFileRef;
	animation?: TelegramFileRef;
	video_note?: TelegramFileRef;
	voice?: TelegramFileRef;
	audio?: TelegramFileRef;
	document?: TelegramFileRef;
}

export function isTelegramMessage(value: unknown): value is TelegramMessage {
	if (!value || typeof value !== "object") return false;
	if (!("message_id" in value) || typeof value.message_id !== "number") return false;
	if (!("date" in value) || typeof value.date !== "number") return false;
	if (!("chat" in value) || !value.chat || typeof value.chat !== "object") return false;
	return "id" in value.chat && typeof value.chat.id === "number";
}

export interface TelegramNormalizeDeps {
	/** Lower-cased bot username (without `@`) → bot user id, for every persona with a Telegram account. */
	botUserIdsByUsername: ReadonlyMap<string, string>;
	/** Bounded download through the receiving bot's token (file ids are per bot); null when unavailable. */
	downloadFile(fileId: string): Promise<{ bytes: Uint8Array; filePath: string } | null>;
	prepareImage: typeof prepareImage;
	extractVideoFrames: typeof extractVideoFrames;
}

function senderName(sender: TelegramSender): string {
	const full = [sender.first_name, sender.last_name].filter(Boolean).join(" ").trim();
	return full || sender.title || sender.username || String(sender.id);
}

/** Raw user ids addressed by `@username` mentions of known bots and by `text_mention` entities. */
function mentionedUserIds(
	text: string,
	entities: readonly TelegramEntity[],
	botUserIdsByUsername: ReadonlyMap<string, string>,
): string[] {
	const ids = new Set<string>();
	for (const entity of entities) {
		if (entity.type === "text_mention" && entity.user) ids.add(String(entity.user.id));
		if (entity.type !== "mention") continue;
		// entity offsets are UTF-16 code units, which is exactly what String#slice indexes
		const username = text.slice(entity.offset + 1, entity.offset + entity.length).toLowerCase();
		const id = botUserIdsByUsername.get(username);
		if (id) ids.add(id);
	}
	return [...ids];
}

async function download(deps: TelegramNormalizeDeps, file: TelegramFileRef) {
	if (file.file_size != null && file.file_size > MAX_TELEGRAM_FILE_BYTES) return null;
	return deps.downloadFile(file.file_id);
}

async function stillImage(
	deps: TelegramNormalizeDeps,
	file: TelegramFileRef,
	mimeType: string,
): Promise<InboundImage | null> {
	const downloaded = await download(deps, file);
	if (!downloaded) return null;
	const prepared = await deps.prepareImage(downloaded.bytes, mimeType);
	return prepared.ok ? prepared.image : null;
}

async function videoFrames(deps: TelegramNormalizeDeps, file: TelegramFileRef): Promise<InboundImage[]> {
	const downloaded = await download(deps, file);
	if (!downloaded) return [];
	const extension = /\.([A-Za-z0-9]{1,8})$/.exec(downloaded.filePath)?.[1] ?? file.mime_type?.split("/")[1] ?? "mp4";
	const result = await deps.extractVideoFrames({
		sourceBytes: downloaded.bytes,
		sourceExtension: extension,
	});
	if (!result.ok) return [];
	const images: InboundImage[] = [];
	for (const frame of result.frames) {
		const prepared = await deps.prepareImage(frame.bytes, frame.mimeType);
		if (prepared.ok) images.push(prepared.image);
	}
	return images;
}

/** Media → model images plus text markers such as `[视频 3帧]`, `[贴纸 😀]`, `[语音]`, `[文件]`. */
async function collectMedia(
	message: TelegramMessage,
	deps: TelegramNormalizeDeps,
): Promise<{ markers: string[]; images: InboundImage[] }> {
	const markers: string[] = [];
	const images: InboundImage[] = [];
	const addVideo = async (file: TelegramFileRef) => {
		const frames = await videoFrames(deps, file);
		images.push(...frames);
		markers.push(frames.length > 0 ? `[视频 ${frames.length}帧]` : "[视频]");
	};
	const largestPhoto = message.photo?.at(-1);
	if (largestPhoto) {
		const image = await stillImage(deps, largestPhoto, "image/jpeg");
		if (image) images.push(image);
		else markers.push("[图片]");
	} else if (message.sticker) {
		const sticker = message.sticker;
		markers.push(sticker.emoji ? `[贴纸 ${sticker.emoji}]` : "[贴纸]");
		if (sticker.is_video) await addVideo(sticker);
		else if (!sticker.is_animated) {
			const image = await stillImage(deps, sticker, "image/webp");
			if (image) images.push(image);
		}
	} else if (message.video || message.animation || message.video_note) {
		// `animation` messages also carry `document` for backward compatibility; it is not a file share
		await addVideo((message.video ?? message.animation ?? message.video_note)!);
	} else if (message.voice || message.audio) {
		markers.push("[语音]");
	} else if (message.document) {
		markers.push("[文件]");
	}
	return { markers, images };
}

/** Null for sender-less service updates and messages with nothing to say. */
export async function normalizeTelegramMessage(
	message: TelegramMessage,
	deps: TelegramNormalizeDeps,
): Promise<InboundMessage | null> {
	const chatId = String(message.chat.id);
	// Anonymous admins and linked channels post as `sender_chat`; `from` is then a placeholder bot.
	const sender = message.sender_chat ?? message.from;
	if (!sender) return null;
	const text = message.text ?? message.caption ?? "";
	const entities = message.entities ?? message.caption_entities ?? [];
	// The core keeps stale messages as history only; markers without downloads keep an offline backlog moving.
	const stale = Date.now() - message.date * 1000 > STALE_MESSAGE_MS;
	const { markers, images } = await collectMedia(message, stale ? { ...deps, downloadFile: async () => null } : deps);
	const content = [...markers, text].filter(Boolean).join(" ");
	if (!content && images.length === 0) return null;
	// In forum topics every message "replies" to the topic's creation service message.
	const reply = message.reply_to_message?.forum_topic_created ? undefined : message.reply_to_message;
	const replyAuthor = reply?.sender_chat ?? reply?.from;
	return {
		platform: "telegram",
		spaceId: spaceId("telegram", chatId),
		channelId: chatId,
		messageId: String(message.message_id),
		authorId: String(sender.id),
		authorName: senderName(sender),
		isBot: !message.sender_chat && message.from?.is_bot === true,
		content,
		mentionedUserIds: mentionedUserIds(text, entities, deps.botUserIdsByUsername),
		replyToMessageId: reply ? String(reply.message_id) : null,
		replyToAuthorId: replyAuthor ? String(replyAuthor.id) : null,
		timestamp: message.date * 1000,
		...(images.length > 0 ? { images } : {}),
	};
}
