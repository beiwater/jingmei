/** Small Discord HTTP/Gateway transport. Snowflakes stay strings end to end. */

import type { OutboundAttachment, PersonaAccount, PlatformTransport } from "../../core/types.ts";

export type Snowflake = string;

export interface DiscordMessage {
	id: Snowflake;
	channel_id: Snowflake;
	content: string;
	author: { id: Snowflake; username: string; bot?: boolean };
	mentions?: Array<{ id: Snowflake; username?: string; bot?: boolean }>;
	attachments?: Array<{ id: Snowflake; filename: string; url: string; content_type?: string; size?: number }>;
	referenced_message?: DiscordMessage | null;
	message_reference?: { message_id?: Snowflake; channel_id?: Snowflake; guild_id?: Snowflake };
	[key: string]: unknown;
}

export interface DiscordInteraction {
	id: Snowflake;
	type: number;
	application_id: Snowflake;
	token: string;
	data?: { name?: string; options?: Array<{ name: string; value?: unknown }>; [key: string]: unknown };
	guild_id?: Snowflake;
	channel_id?: Snowflake;
	member?: { user?: { id: Snowflake; username: string; [key: string]: unknown }; [key: string]: unknown };
	user?: { id: Snowflake; username: string; [key: string]: unknown };
	[key: string]: unknown;
}

export interface DiscordCommand {
	name: string;
	description: string;
	type?: number;
	options?: unknown[];
	default_member_permissions?: string | null;
}

export interface DiscordTransportOptions {
	token: string;
	applicationId: Snowflake;
	gatewayUrl?: string;
	allowedChannelIds?: Iterable<Snowflake>;
	fetch?: typeof fetch;
	webSocketFactory?: (url: string) => WebSocket;
	onMessage?: (message: DiscordMessage) => void | Promise<void>;
	onInteraction?: (interaction: DiscordInteraction) => void | Promise<void>;
	onError?: (error: Error) => void;
}

const API_VERSION = "10";
const API_BASE = "https://discord.com/api";
const MAX_MESSAGE_LENGTH = 2000;
const DEFAULT_ALLOWED_MENTIONS = { parse: [] as string[], replied_user: false };
const GUILDS = 1 << 0;
const GUILD_MESSAGES = 1 << 9;
const MESSAGE_CONTENT = 1 << 15;
const DEFAULT_INTENTS = GUILDS | GUILD_MESSAGES | MESSAGE_CONTENT;

/** Gateway close codes that reconnecting cannot fix; `hint` tells the operator what to change. */
const FATAL_CLOSE_HINTS: Readonly<Record<number, string>> = {
	4004: "Discord rejected the bot token. Check the persona's token variable in .env.",
	4010: "Discord rejected the gateway shard configuration.",
	4011: "Discord requires sharding for this bot.",
	4012: "Discord rejected the gateway API version.",
	4013: "Discord rejected the intents value jingmei sends. This is a code problem; upgrade jingmei or report it.",
	4014: "Message Content Intent is not enabled. Enable it in the Discord Developer Portal (Bot > Privileged Gateway Intents).",
};

/** The Gateway closed with a code that no reconnect can recover from. */
export class DiscordGatewayFatalError extends Error {
	override readonly name = "DiscordGatewayFatalError";
	readonly hint: string;
	constructor(readonly code: number) {
		super(`Discord Gateway closed with unrecoverable code ${code}`);
		this.hint = FATAL_CLOSE_HINTS[code] ?? "";
	}
}

export function isSnowflake(value: unknown): value is Snowflake {
	return typeof value === "string" && /^\d{17,20}$/.test(value);
}

/** Split without discarding whitespace; prefer a newline, then a word boundary. */
export function splitDiscordMessage(content: string, maxLength = MAX_MESSAGE_LENGTH): string[] {
	if (!content) return [];
	const parts: string[] = [];
	let rest = content;
	while (rest.length > maxLength) {
		let cut = rest.lastIndexOf("\n", maxLength - 1);
		if (cut < Math.floor(maxLength * 0.55)) cut = rest.lastIndexOf(" ", maxLength - 1);
		if (cut < Math.floor(maxLength * 0.55)) cut = maxLength;
		else if (rest[cut] === "\n") cut += 1;
		// Never leave half of a UTF-16 surrogate pair at either end.
		if (
			cut < rest.length &&
			cut > 0 &&
			/[\uD800-\uDBFF]/.test(rest[cut - 1] ?? "") &&
			/[\uDC00-\uDFFF]/.test(rest[cut] ?? "")
		)
			cut -= 1;
		parts.push(rest.slice(0, cut));
		rest = rest.slice(cut);
	}
	if (rest) parts.push(rest);
	return parts;
}

export class DiscordTransport {
	private readonly fetchImpl: typeof fetch;
	private readonly wsFactory: (url: string) => WebSocket;
	private socket?: WebSocket;
	private sessionId?: string;
	private resumeGatewayUrl?: string;
	private sequence: number | null = null;
	private heartbeatInterval?: ReturnType<typeof setInterval>;
	private reconnectTimer?: ReturnType<typeof setTimeout>;
	private heartbeatAck = true;
	private stopped = true;
	private reconnectAttempts = 0;
	private intentionalClose = false;
	private readonly allowedChannels?: Set<Snowflake>;
	private readonly threadParents = new Map<Snowflake, Snowflake>();

	constructor(private readonly options: DiscordTransportOptions) {
		this.fetchImpl = options.fetch ?? fetch;
		this.wsFactory = options.webSocketFactory ?? ((url) => new WebSocket(url));
		this.allowedChannels = options.allowedChannelIds ? new Set(options.allowedChannelIds) : undefined;
	}

	async getCurrentUser(): Promise<{ id: Snowflake; username: string }> {
		const user = await this.request<{ id: Snowflake; username: string }>("/users/@me");
		return { id: user.id, username: user.username };
	}

	/** Application flags; Message Content Intent shows as GATEWAY_MESSAGE_CONTENT (1 << 18) or, below verification, the LIMITED variant (1 << 19). */
	async getApplicationFlags(): Promise<number | undefined> {
		const application = await this.request<{ flags?: unknown }>("/applications/@me");
		return typeof application.flags === "number" ? application.flags : undefined;
	}

	private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
		const headers = new Headers(init.headers);
		headers.set("Authorization", `Bot ${this.options.token}`);
		if (init.body && !(init.body instanceof FormData)) headers.set("Content-Type", "application/json");
		for (let attempt = 0; ; attempt++) {
			const response = await this.fetchImpl(`${API_BASE}/v${API_VERSION}${path}`, { ...init, headers });
			if (response.status === 429 && attempt < 4) {
				const retryHeader = response.headers.get("Retry-After");
				let retryAfter = retryHeader === null ? Number.NaN : Number(retryHeader);
				try {
					const data = (await response.clone().json()) as { retry_after?: unknown };
					if (typeof data.retry_after === "number" && Number.isFinite(data.retry_after)) retryAfter = data.retry_after;
				} catch {
					/* Header is the fallback; never include the body in errors. */
				}
				const delay = Math.min(120_000, Math.max(0, Number.isFinite(retryAfter) ? retryAfter * 1000 : 1000));
				await new Promise((resolve) => setTimeout(resolve, delay));
				continue;
			}
			if (!response.ok) throw new Error(`Discord API request failed with HTTP ${response.status}`);
			if (response.status === 204) return undefined as T;
			return (await response.json()) as T;
		}
	}

	async sendMessage(
		channelId: Snowflake,
		content: string,
		options: {
			replyTo?: Snowflake;
			allowedMentions?: { parse?: string[]; users?: Snowflake[]; roles?: Snowflake[]; replied_user?: boolean };
			attachments?: readonly OutboundAttachment[];
		} = {},
	): Promise<DiscordMessage[]> {
		this.assertSnowflake(channelId, "channelId");
		this.assertAllowedChannel(channelId);
		if (options.replyTo) this.assertSnowflake(options.replyTo, "replyTo");
		const parts = splitDiscordMessage(content);
		if (!parts.length && !options.attachments?.length) return [];
		const sent: DiscordMessage[] = [];
		for (let i = 0; i < Math.max(1, parts.length); i++) {
			const body: Record<string, unknown> = {
				content: parts[i] ?? "",
				allowed_mentions: options.allowedMentions ?? DEFAULT_ALLOWED_MENTIONS,
			};
			if (i === 0 && options.replyTo)
				body.message_reference = { message_id: options.replyTo, fail_if_not_exists: false };
			let message: DiscordMessage;
			if (i === 0 && options.attachments?.length) {
				const form = new FormData();
				form.set("payload_json", JSON.stringify(body));
				options.attachments.forEach((file, index) => {
					const blob = new Blob([file.data as Uint8Array<ArrayBuffer>], { type: file.contentType });
					form.append(`files[${index}]`, blob, file.name);
				});
				message = await this.request(`/channels/${channelId}/messages`, { method: "POST", body: form });
			} else {
				message = await this.request(`/channels/${channelId}/messages`, { method: "POST", body: JSON.stringify(body) });
			}
			sent.push(message);
		}
		return sent;
	}

	async addReaction(channelId: Snowflake, messageId: Snowflake, emoji: string): Promise<void> {
		this.assertSnowflake(channelId, "channelId");
		this.assertSnowflake(messageId, "messageId");
		this.assertAllowedChannel(channelId);
		const encoded = encodeURIComponent(emoji);
		await this.request(`/channels/${channelId}/messages/${messageId}/reactions/${encoded}/@me`, { method: "PUT" });
	}

	async startTyping(channelId: Snowflake): Promise<void> {
		this.assertSnowflake(channelId, "channelId");
		this.assertAllowedChannel(channelId);
		await this.request(`/channels/${channelId}/typing`, { method: "POST" });
	}

	async registerCommands(commands: DiscordCommand[], guildId: Snowflake): Promise<unknown[]> {
		this.assertSnowflake(guildId, "guildId");
		return this.request(`/applications/${this.options.applicationId}/guilds/${guildId}/commands`, {
			method: "PUT",
			body: JSON.stringify(commands),
		});
	}

	async respondToInteraction(
		interaction: DiscordInteraction,
		content: string,
		options: { ephemeral?: boolean } = {},
	): Promise<void> {
		const flags = options.ephemeral ? 64 : 0;
		const [first = "", ...rest] = splitDiscordMessage(content);
		await this.request(`/interactions/${interaction.id}/${interaction.token}/callback`, {
			method: "POST",
			body: JSON.stringify({
				type: 4,
				data: {
					content: first,
					flags,
					allowed_mentions: DEFAULT_ALLOWED_MENTIONS,
				},
			}),
		});
		for (const part of rest) {
			await this.request(`/webhooks/${interaction.application_id}/${interaction.token}`, {
				method: "POST",
				body: JSON.stringify({ content: part, allowed_mentions: DEFAULT_ALLOWED_MENTIONS }),
			});
		}
	}

	async deferInteraction(interaction: DiscordInteraction, ephemeral = false): Promise<void> {
		await this.request(`/interactions/${interaction.id}/${interaction.token}/callback`, {
			method: "POST",
			body: JSON.stringify({ type: 5, data: ephemeral ? { flags: 64 } : {} }),
		});
	}

	async followUpInteraction(interaction: DiscordInteraction, content: string, ephemeral = false): Promise<void> {
		for (const part of splitDiscordMessage(content)) {
			await this.request(`/webhooks/${interaction.application_id}/${interaction.token}`, {
				method: "POST",
				body: JSON.stringify({
					content: part,
					...(ephemeral ? { flags: 64 } : {}),
					allowed_mentions: DEFAULT_ALLOWED_MENTIONS,
				}),
			});
		}
	}

	async start(): Promise<void> {
		if (!this.stopped) return;
		this.stopped = false;
		await this.connect();
	}

	async stop(): Promise<void> {
		this.stopped = true;
		this.intentionalClose = true;
		if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
		if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
		this.heartbeatInterval = undefined;
		this.reconnectTimer = undefined;
		const socket = this.socket;
		this.socket = undefined;
		if (socket && socket.readyState < 2) socket.close(1000, "shutdown");
	}

	private async connect(): Promise<void> {
		if (this.stopped) return;
		try {
			let url = this.sessionId && this.resumeGatewayUrl ? this.resumeGatewayUrl : this.options.gatewayUrl;
			if (!url) {
				const response = await this.request<{ url: string }>("/gateway/bot");
				url = response.url;
			}
			const wsUrl = new URL(url);
			wsUrl.searchParams.set("v", API_VERSION);
			wsUrl.searchParams.set("encoding", "json");
			const socket = this.wsFactory(wsUrl.toString());
			this.socket = socket;
			socket.onopen = () => {
				this.reconnectAttempts = 0;
			};
			socket.onmessage = (event) => {
				void this.handlePayload(String(event.data));
			};
			socket.onerror = () => this.options.onError?.(new Error("Discord Gateway WebSocket error"));
			socket.onclose = (event) => {
				if (this.socket === socket) this.socket = undefined;
				this.clearHeartbeat();
				if (!this.stopped && !this.intentionalClose) {
					if (event.code in FATAL_CLOSE_HINTS) {
						this.options.onError?.(new DiscordGatewayFatalError(event.code));
						this.stopped = true;
					} else if (event.code === 4007 || event.code === 4009) {
						this.sessionId = undefined;
						this.sequence = null;
						this.scheduleReconnect(false);
					} else this.scheduleReconnect(true);
				}
				this.intentionalClose = false;
			};
		} catch (error) {
			this.options.onError?.(asError(error));
			this.scheduleReconnect(Boolean(this.sessionId));
		}
	}

	private async handlePayload(raw: string): Promise<void> {
		let payload: { op: number; t?: string | null; s?: number | null; d?: any };
		try {
			payload = JSON.parse(raw);
		} catch {
			this.options.onError?.(new Error("Invalid Discord Gateway JSON"));
			return;
		}
		if (typeof payload.s === "number") this.sequence = payload.s;
		switch (payload.op) {
			case 10: {
				this.heartbeatAck = true;
				const interval: number = payload.d.heartbeat_interval;
				this.clearHeartbeat();
				this.heartbeatInterval = setInterval(() => {
					if (!this.heartbeatAck) {
						this.socket?.close(4000, "heartbeat timeout");
						return;
					}
					this.sendGateway(1, this.sequence);
					this.heartbeatAck = false;
				}, interval);
				this.sendGateway(
					this.sessionId ? 6 : 2,
					this.sessionId
						? { token: this.options.token, session_id: this.sessionId, seq: this.sequence }
						: {
								token: this.options.token,
								intents: DEFAULT_INTENTS,
								properties: {
									os: process.platform,
									browser: "jingmei",
									device: "jingmei",
								},
							},
				);
				break;
			}
			case 1:
				this.sendGateway(1, this.sequence);
				break;
			case 7:
				this.socket?.close(4000, "server requested reconnect");
				break;
			case 9:
				if (!payload.d) {
					this.sessionId = undefined;
					this.sequence = null;
				}
				this.socket?.close(4000, "invalid session");
				break;
			case 11:
				this.heartbeatAck = true;
				break;
			case 0:
				if (payload.t === "READY") {
					this.sessionId = payload.d?.session_id;
					this.resumeGatewayUrl = payload.d?.resume_gateway_url;
					this.reconnectAttempts = 0;
				}
				if (payload.t === "RESUMED") this.reconnectAttempts = 0;
				if (
					(payload.t === "THREAD_CREATE" || payload.t === "THREAD_UPDATE") &&
					isSnowflake(payload.d?.id) &&
					isSnowflake(payload.d?.parent_id)
				)
					this.threadParents.set(payload.d.id, payload.d.parent_id);
				if (payload.t === "THREAD_DELETE" && isSnowflake(payload.d?.id)) this.threadParents.delete(payload.d.id);
				if (payload.t === "MESSAGE_CREATE" && payload.d && this.isAllowedEventChannel(payload.d.channel_id)) {
					void Promise.resolve(this.options.onMessage?.(payload.d as DiscordMessage)).catch((error) =>
						this.options.onError?.(asError(error)),
					);
				}
				if (payload.t === "INTERACTION_CREATE" && payload.d && this.isAllowedEventChannel(payload.d.channel_id)) {
					void Promise.resolve(this.options.onInteraction?.(payload.d as DiscordInteraction)).catch((error) =>
						this.options.onError?.(asError(error)),
					);
				}
				break;
		}
	}

	private sendGateway(op: number, d: unknown): void {
		if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({ op, d }));
	}
	private clearHeartbeat(): void {
		if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
		this.heartbeatInterval = undefined;
	}
	private scheduleReconnect(resume: boolean): void {
		if (this.stopped || this.reconnectTimer) return;
		if (!resume) {
			this.sessionId = undefined;
			this.sequence = null;
		}
		const delay = Math.min(30_000, 1000 * 2 ** Math.min(this.reconnectAttempts++, 5)) + Math.floor(Math.random() * 500);
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = undefined;
			void this.connect();
		}, delay);
	}
	private assertSnowflake(value: string, name: string): void {
		if (!isSnowflake(value)) throw new Error(`${name} must be a Discord Snowflake string`);
	}
	private assertAllowedChannel(channelId: Snowflake): void {
		if (!this.isAllowedEventChannel(channelId)) throw new Error("Discord channel is outside the configured allowlist");
	}
	private isAllowedEventChannel(channelId: unknown): boolean {
		if (!isSnowflake(channelId) || !this.allowedChannels) return isSnowflake(channelId);
		return this.allowedChannels.has(channelId) || this.allowedChannels.has(this.threadParents.get(channelId) ?? "");
	}
}

/** Discord accepts a Unicode emoji or a custom emoji written as name:id. */
export function isValidReactionEmoji(value: unknown): value is string {
	if (typeof value !== "string" || value.length === 0 || value.length > 64 || value.trim() !== value) return false;
	if (/^[A-Za-z0-9_]{2,32}:\d{17,20}$/.test(value)) return true;
	if (/[:\p{Cc}\p{Cs}\p{Zl}\p{Zp}]/u.test(value)) return false;
	return /\p{Extended_Pictographic}/u.test(value) || /^[\u{1F1E6}-\u{1F1FF}]{2}$/u.test(value);
}

function asError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}

export const DISCORD_QUICK_REACTIONS: Readonly<Record<string, string>> = {
	"👍": "赞同、收到",
	"😂": "好笑",
	"😭": "难过、破防",
	"❤️": "暖心、感谢",
	"🤔": "疑问、不确定",
};

const DISCORD_PROMPT_LINES: readonly string[] = [
	"- Discord 消息正文支持 Markdown 子集：**粗体**、*斜体*、__下划线__、~~删除线~~、## 小标题、- 列表、> 引用、`行内代码`、三反引号代码块、[来源](https://example.com) 链接，以及 ||剧透||。按内容选择，普通聊天保持自然，不要每句都加格式。",
	"- 题解或较长说明可用少量小标题、列表和粗体突出结构；引用网页时给可点击来源链接。标题、列表、引用符号后必须加空格；代码块要闭合。中英文混排需要斜体时优先用 *文字*。",
	"- Discord 单条消息正文上限 2000 字符，格式符号也计入；长答用清楚的短段落组织，避免超长代码块跨消息拆开。",
	"- Discord 不渲染 LaTeX 数学公式；写数学时用清楚的纯文本或代码块，不要输出 $ 或 $$ 公式标记。",
];

/** Multiplexes one Discord client per persona behind the platform-neutral transport. Only trusted `mention` recipients are notified. */
export class DiscordPlatformTransport implements PlatformTransport {
	readonly platform = "discord" as const;
	readonly echoesOwnMessages = true;
	readonly displayName = "Discord";
	readonly promptLines = DISCORD_PROMPT_LINES;
	/** A typing trigger lasts about ten seconds. */
	readonly typingRefreshMs = 8_000;

	constructor(
		private readonly clients: ReadonlyMap<string, DiscordTransport>,
		readonly quickReactions: Readonly<Record<string, string>> = DISCORD_QUICK_REACTIONS,
	) {}

	async sendMessage(input: {
		personaId: string;
		channelId: string;
		content: string;
		replyToMessageId?: string;
		attachments?: readonly OutboundAttachment[];
		mention?: readonly PersonaAccount[];
	}): Promise<{ id: string }> {
		const users = [...new Set(input.mention?.map((user) => user.userId) ?? [])];
		const messages = await this.clients.get(input.personaId)!.sendMessage(input.channelId, input.content, {
			replyTo: input.replyToMessageId,
			allowedMentions: users.length ? { ...DEFAULT_ALLOWED_MENTIONS, users } : DEFAULT_ALLOWED_MENTIONS,
			attachments: input.attachments,
		});
		const first = messages[0];
		if (!first) throw new Error("Discord send produced no message");
		return { id: first.id };
	}

	formatMention(user: PersonaAccount): string {
		return `<@${user.userId}>`;
	}

	startTyping(personaId: string, channelId: string): Promise<void> {
		return this.clients.get(personaId)!.startTyping(channelId);
	}

	addReaction(personaId: string, channelId: string, messageId: string, emoji: string): Promise<void> {
		return this.clients.get(personaId)!.addReaction(channelId, messageId, emoji);
	}

	isValidReaction(emoji: string): boolean {
		return isValidReactionEmoji(emoji);
	}
}
