/**
 * Telegram adapter: one long-polling Bot API client per persona token, normalized into the shared core.
 *
 * Every persona bot in a group receives the same user message; the first poller to see it claims
 * `chat:message` and feeds the core (the core's `INSERT OR IGNORE` covers restart replays).
 * Telegram never delivers one bot's messages to another bot, so personas cannot observe each
 * other's Telegram replies — this is a Bot API limitation, not worked around here. Bots also need
 * privacy mode disabled (BotFather `/setprivacy`) or admin rights to see unaddressed group messages.
 */

import type { AppConfig } from "../../config.ts";
import { PAUSED_REPLY } from "../../core/member-commands.ts";
import type { MemberMemory } from "../../core/memory.ts";
import {
	type ConversationCore,
	type InboundMessage,
	type Persona,
	type PlatformTransport,
	type SpaceId,
	spaceId as toSpaceId,
} from "../../core/types.ts";
import { prepareImage } from "../../media/image.ts";
import { extractVideoFrames } from "../../media/video-frames.ts";
import { errorCategory, log } from "../../observability/log.ts";
import { BotApi, isReactionEmoji } from "./api.ts";
import {
	type ParsedCommand,
	parseCommand,
	runCommand,
	TELEGRAM_ADMIN_COMMANDS,
	TELEGRAM_COMMANDS,
} from "./commands.ts";
import {
	MAX_TELEGRAM_FILE_BYTES,
	normalizeTelegramMessage,
	type TelegramMessage,
	type TelegramNormalizeDeps,
	type TelegramUpdate,
} from "./normalize.ts";
import { Poller } from "./poller.ts";
import { TELEGRAM_QUICK_REACTIONS, TelegramPlatformTransport } from "./transport.ts";

export interface PlatformDeps {
	config: AppConfig;
	personas: readonly Persona[];
	getCore(): ConversationCore;
	memberMemory: MemberMemory;
	/** True while an operator has paused the bot. */
	isPaused(): boolean;
}

export interface PlatformHandle {
	transport: PlatformTransport;
	start(): Promise<void>;
	stop(): Promise<void>;
}

interface TelegramBot {
	persona: Persona;
	api: BotApi;
	userId: string;
	/** Lower-cased, without `@`. */
	username: string;
	poller: Poller;
}

/** Recently claimed `chat:message` keys; enough to cover the skew between persona pollers. */
const MAX_CLAIMED_MESSAGES = 5000;

function inScope(persona: Persona, space: SpaceId): boolean {
	return !persona.spaces || persona.spaces.includes(space);
}

export async function createTelegramPlatform(deps: PlatformDeps): Promise<PlatformHandle> {
	const { config, personas, memberMemory } = deps;
	const allowedChatIds: ReadonlySet<string> = new Set(config.telegram?.chatIds ?? []);
	const bots: TelegramBot[] = [];
	const botUserIdsByUsername = new Map<string, string>();
	const claimed = new Set<string>();
	const chatQueues = new Map<string, Promise<void>>();
	const ignoredChats = new Set<string>();

	for (const persona of personas) {
		const token = config.personas.find((candidate) => candidate.id === persona.id)?.tokens.telegram;
		if (!token) continue;
		const api = new BotApi(token);
		const me = await api.getMe();
		persona.accounts.telegram = { userId: String(me.id), username: me.username };
		if (me.can_read_all_group_messages === false)
			log.warn("telegram", "privacy_mode_enabled", { persona_id: persona.id });
		const bot: TelegramBot = {
			persona,
			api,
			userId: String(me.id),
			username: me.username.toLowerCase(),
			poller: new Poller(api, persona.id, (update) => onUpdate(bot, update)),
		};
		bots.push(bot);
		botUserIdsByUsername.set(bot.username, bot.userId);
	}

	const configuredReactions = config.jev?.emojis?.telegram;
	const quickReactions = configuredReactions
		? Object.fromEntries(Object.entries(configuredReactions).filter(([emoji]) => isReactionEmoji(emoji)))
		: TELEGRAM_QUICK_REACTIONS;
	if (configuredReactions && Object.keys(quickReactions).length < Object.keys(configuredReactions).length)
		log.warn("telegram", "quick_reactions_dropped", {
			dropped: Object.keys(configuredReactions).length - Object.keys(quickReactions).length,
		});
	const transport = new TelegramPlatformTransport(
		new Map(bots.map((bot) => [bot.persona.id, bot.api])),
		quickReactions,
	);

	/** First poller wins; later pollers of other persona bots drop the same message. */
	function claim(key: string): boolean {
		if (claimed.has(key)) return false;
		claimed.add(key);
		if (claimed.size > MAX_CLAIMED_MESSAGES) claimed.delete(claimed.values().next().value!);
		return true;
	}

	/** Media downloads are async; a per-chat queue keeps core hand-off in arrival order. */
	function enqueue(chatId: string, task: () => Promise<void>): void {
		const next = (chatQueues.get(chatId) ?? Promise.resolve())
			.then(task)
			.catch((error: unknown) => log.error("telegram", "message_failed", { error_category: errorCategory(error) }));
		chatQueues.set(chatId, next);
		void next.finally(() => {
			if (chatQueues.get(chatId) === next) chatQueues.delete(chatId);
		});
	}

	function normalizeDeps(bot: TelegramBot): TelegramNormalizeDeps {
		return {
			botUserIdsByUsername,
			prepareImage,
			extractVideoFrames,
			async downloadFile(fileId) {
				try {
					const file = await bot.api.getFile(fileId);
					if (!file.file_path) return null;
					return {
						bytes: await bot.api.downloadFile(file.file_path, MAX_TELEGRAM_FILE_BYTES),
						filePath: file.file_path,
					};
				} catch (error) {
					log.warn("telegram", "media_download_failed", {
						persona_id: bot.persona.id,
						error_category: errorCategory(error),
					});
					return null;
				}
			},
		};
	}

	function dispatch(message: InboundMessage): void {
		// The core serializes per channel; do not hold the chat queue for a whole model turn.
		deps
			.getCore()
			.handleMessage(message)
			.catch((error: unknown) => log.error("telegram", "dispatch_failed", { error_category: errorCategory(error) }));
	}

	/** A turn that sent nothing (failed, withheld, timed out) gets a short notice, like Discord's `/ask`. */
	async function answerAsk(bot: TelegramBot, message: TelegramMessage, ask: InboundMessage): Promise<void> {
		let responseMessageId: string | undefined;
		try {
			responseMessageId = (await deps.getCore().handleMessage(ask)).responseMessageId;
		} catch (error) {
			log.error("telegram", "ask_failed", { persona_id: bot.persona.id, error_category: errorCategory(error) });
		}
		if (!responseMessageId)
			await bot.api
				.sendMessage(message.chat.id, "没有得到回答，请重试。", [], message.message_id)
				.catch((error: unknown) =>
					log.error("telegram", "command_reply_failed", {
						persona_id: bot.persona.id,
						error_category: errorCategory(error),
					}),
				);
	}

	async function handleCommand(bot: TelegramBot, command: ParsedCommand, message: TelegramMessage): Promise<void> {
		const chatId = String(message.chat.id);
		const space = toSpaceId("telegram", chatId);
		const sender = message.sender_chat ?? message.from;
		if (!sender) return;
		if (command.name === "ask") {
			if (!command.args) {
				await bot.api.sendMessage(message.chat.id, "请在 /ask 后写上问题。", [], message.message_id);
				return;
			}
			if (deps.isPaused()) {
				await bot.api.sendMessage(message.chat.id, PAUSED_REPLY, [], message.message_id);
				return;
			}
			enqueue(chatId, async () => {
				const normalized = await normalizeTelegramMessage(
					{ ...message, text: command.args, entities: [] },
					normalizeDeps(bot),
				);
				if (!normalized) return;
				// Not awaited: the chat queue must not wait for a whole model turn.
				void answerAsk(bot, message, { ...normalized, mentionedUserIds: [bot.userId] });
			});
			return;
		}
		let reply: string;
		try {
			reply = await runCommand({
				command,
				persona: bot.persona,
				chatPersonas: personas.filter((persona) => persona.accounts.telegram && inScope(persona, space)),
				spaceId: space,
				chatId,
				messageId: String(message.message_id),
				userId: String(sender.id),
				config,
				memberMemory,
				getCore: deps.getCore,
				isPaused: deps.isPaused,
			});
		} catch (error) {
			log.error("telegram", "command_failed", {
				persona_id: bot.persona.id,
				command: command.name,
				error_category: errorCategory(error),
			});
			reply = "命令执行失败，请稍后再试。";
		}
		await bot.api.sendMessage(message.chat.id, reply, [], message.message_id);
	}

	function onUpdate(bot: TelegramBot, { message }: TelegramUpdate): void {
		const chatId = String(message.chat.id);
		if (!allowedChatIds.has(chatId)) {
			// Chat ids are not secret; logging the first sighting lets operators allow-list a group.
			if (!ignoredChats.has(chatId)) {
				ignoredChats.add(chatId);
				log.info("telegram", "chat_ignored", { persona_id: bot.persona.id, chat_id: chatId });
			}
			return;
		}
		const key = `${chatId}:${message.message_id}`;
		const command = message.text ? parseCommand(message.text, message.entities ?? []) : null;
		if (command) {
			// `/cmd@other_bot` belongs to that bot; an untargeted command goes to the first in-scope claimer.
			if (command.target && command.target !== bot.username) return;
			if (!inScope(bot.persona, toSpaceId("telegram", chatId)) || !claim(key)) return;
			handleCommand(bot, command, message).catch((error: unknown) =>
				log.error("telegram", "command_reply_failed", {
					persona_id: bot.persona.id,
					error_category: errorCategory(error),
				}),
			);
			return;
		}
		if (!claim(key)) return;
		enqueue(chatId, async () => {
			const normalized = await normalizeTelegramMessage(message, normalizeDeps(bot));
			if (normalized) dispatch(normalized);
		});
	}

	return {
		transport,
		async start() {
			for (const bot of bots) {
				const admin = bot.persona.adminUserIds.some((id) => id.startsWith("telegram:"));
				await bot.api
					.setMyCommands(admin ? [...TELEGRAM_COMMANDS, ...TELEGRAM_ADMIN_COMMANDS] : TELEGRAM_COMMANDS)
					.catch((error: unknown) =>
						log.warn("telegram", "commands_register_failed", {
							persona_id: bot.persona.id,
							error_category: errorCategory(error),
						}),
					);
				bot.poller.run().catch((error: unknown) =>
					log.error("telegram", "poller_stopped", {
						persona_id: bot.persona.id,
						error_category: errorCategory(error),
					}),
				);
			}
			log.info("telegram", "ready", { persona_count: bots.length, chat_count: allowedChatIds.size });
		},
		async stop() {
			await Promise.allSettled(bots.map((bot) => bot.poller.stop()));
			await Promise.allSettled([...chatQueues.values()]);
		},
	};
}
