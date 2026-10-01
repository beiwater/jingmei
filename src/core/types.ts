import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

/** Chat platforms served by the single conversation core. */
export type Platform = "discord" | "telegram";

/**
 * Opaque conversation space: `${platform}:${rawId}` — a Discord guild or a Telegram group chat.
 * Memory, soul, sessions and stored messages are keyed by space; only adapters parse the raw id.
 */
export type SpaceId = `${Platform}:${string}`;

export function spaceId(platform: Platform, rawId: string): SpaceId {
	return `${platform}:${rawId}`;
}

/** Bounded, model-ready still image produced by `src/media/image.ts`. */
export interface InboundImage {
	mimeType: "image/jpeg" | "image/png";
	/** Base64 bytes; the core writes them to the private media cache and keeps only file refs. */
	base64: string;
}

/** Platform-neutral inbound message. Every id is a string; adapters own conversion. */
export interface InboundMessage {
	platform: Platform;
	spaceId: SpaceId;
	/** Raw platform channel id (Discord channel/thread snowflake, Telegram chat id). */
	channelId: string;
	messageId: string;
	/** Raw platform user id. */
	authorId: string;
	authorName: string;
	isBot: boolean;
	/** Text/caption. Adapters append placeholders such as `[视频]`/`[语音]`/`[贴纸 😀]` for non-image media. */
	content: string;
	/** Raw platform user ids addressed by this message (mentions resolved to ids by the adapter). */
	mentionedUserIds?: readonly string[];
	replyToMessageId?: string | null;
	replyToAuthorId?: string | null;
	timestamp?: number;
	images?: readonly InboundImage[];
}

export interface OutboundAttachment {
	name: string;
	data: Uint8Array;
	contentType: "image/png" | "image/jpeg" | "audio/mpeg";
}

/** Everything the core needs from a platform. One instance per platform, multiplexing personas. */
export interface PlatformTransport {
	readonly platform: Platform;
	/** Whether successful bot sends return through the inbound platform stream. */
	readonly echoesOwnMessages: boolean;
	/** Human-readable platform name used in prompts, e.g. "Discord". */
	readonly displayName: string;
	/** Platform-specific protocol lines (formatting, length limits). Cache-visible system prompt text. */
	readonly promptLines: readonly string[];
	/** Emoji table offered to Jev quick reactions: emoji -> meaning. Must satisfy isValidReaction. */
	readonly quickReactions: Readonly<Record<string, string>>;
	/**
	 * Plain text (Markdown allowed) or a single attachment with optional caption. Never notifies anyone,
	 * except the trusted `mention` recipients whose `formatMention` output the caller embedded in `content`.
	 */
	sendMessage(input: {
		personaId: string;
		channelId: string;
		content: string;
		replyToMessageId?: string;
		attachments?: readonly OutboundAttachment[];
		/** Trusted code paths only (e.g. birthday greetings); model output never sets this. */
		mention?: readonly PersonaAccount[];
	}): Promise<{ id: string }>;
	/** Platform syntax for a notifying mention of `user`; only effective when `user` is passed in `mention`. */
	formatMention(user: PersonaAccount): string;
	startTyping?(personaId: string, channelId: string): Promise<void> | void;
	addReaction?(personaId: string, channelId: string, messageId: string, emoji: string): Promise<void>;
	isValidReaction(emoji: string): boolean;
}

/** Verified bot identity of one persona on one platform. */
export interface PersonaAccount {
	userId: string;
	username: string;
}

export const BUILTIN_REACTION_IMAGE_IDS = ["hello", "laugh", "think", "hug"] as const;

/** Validated at config load; tool callers supply ids, never filesystem paths. */
export interface ReactionImage {
	path: string;
	caption: string;
	name: string;
	contentType: "image/png" | "image/jpeg";
}

export type ReactionImageCatalog = Readonly<Record<string, ReactionImage>>;

export interface Persona {
	id: string;
	name: string;
	personaPath: string;
	provider: string;
	model: string;
	/** Default "off": a group companion does not need hidden reasoning. */
	reasoningEffort: ThinkingLevel;
	/** Cumulative probability weight for unaddressed messages, in configured persona order. */
	routingP: number;
	aliases: readonly string[];
	/** Restrict to these spaces; undefined = every configured space. */
	spaces?: readonly SpaceId[];
	/** `${platform}:${userId}` entries allowed to run admin commands. */
	adminUserIds: readonly string[];
	sendReactionImages: boolean;
	/** Persona-local image catalog resolved from the optional reactionImages directory. */
	reactionImages?: ReactionImageCatalog;
	voiceEnabled: boolean;
	/** Filled by platform startup after verifying each token. */
	accounts: Partial<Record<Platform, PersonaAccount>>;
}

export type RouteReason = "explicit" | "reply" | "name" | "probability" | "nobody";

export interface Route {
	personaId: string | null;
	reason: RouteReason;
}

export interface Dispatch {
	route: Route;
	messageStored: boolean;
	responseMessageId?: string;
}

/** Public surface used by platform adapters (commands, /ask). */
export interface ConversationCore {
	handleMessage(message: InboundMessage): Promise<Dispatch>;
	getContextStatus(
		personaId: string,
		platform: Platform,
		spaceId: SpaceId,
		channelId: string,
		requesterId: string,
	): Promise<{ tokens: number | null; contextWindow: number; compactionAtTokens: number }>;
	compactContext(
		personaId: string,
		platform: Platform,
		spaceId: SpaceId,
		channelId: string,
		requesterId: string,
	): Promise<{ tokensBefore: number; estimatedTokensAfter?: number }>;
	close(): Promise<void>;
}
