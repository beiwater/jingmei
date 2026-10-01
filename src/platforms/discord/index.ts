/** Discord adapter: one Gateway client per persona token, normalized into the shared conversation core. */

import type { AppConfig } from "../../config.ts";
import {
	contextCommandError,
	memoryCommandError,
	modelCommandError,
	parseBirthdayDate,
	runContextCommand,
	runModelCommand,
} from "../../core/member-commands.ts";
import type { MemberMemory } from "../../core/memory.ts";
import {
	type ConversationCore,
	type InboundImage,
	type InboundMessage,
	type Persona,
	type SpaceId,
	spaceId as toSpaceId,
} from "../../core/types.ts";
import { prepareImage } from "../../media/image.ts";
import { extractVideoFrames } from "../../media/video-frames.ts";
import { errorCategory, log } from "../../observability/log.ts";
import { downloadDiscordImage, downloadDiscordVideo } from "./media.ts";
import {
	DISCORD_QUICK_REACTIONS,
	type DiscordInteraction,
	type DiscordMessage,
	DiscordPlatformTransport,
	DiscordTransport,
} from "./transport.ts";

export interface PlatformDeps {
	config: AppConfig;
	personas: readonly Persona[];
	getCore(): ConversationCore;
	memberMemory: MemberMemory;
}

export interface PlatformHandle {
	transport: DiscordPlatformTransport;
	start(): Promise<void>;
	stop(): Promise<void>;
}

const MAX_IMAGES_PER_MESSAGE = 4;
/** Placeholder application id for the identity probe; replaced by the verified bot id. */
const PROBE_APPLICATION_ID = "10000000000000001";

const COMMANDS = [
	{ name: "help", description: "Show bot commands" },
	{ name: "status", description: "Show bot status" },
	{
		name: "ask",
		description: "Ask the assistants",
		options: [{ name: "prompt", description: "What would you like to ask?", type: 3, required: true }],
	},
	{
		name: "memory",
		description: "View or re-enable your own server memory",
		options: [
			{
				name: "action",
				description: "show or enable",
				type: 3,
				required: false,
				choices: [
					{ name: "Show", value: "show" },
					{ name: "Enable", value: "enable" },
				],
			},
		],
	},
	{
		name: "birthday",
		description: "View, set, or clear your own birthday reminder",
		options: [{ name: "date", description: "MM-DD, or clear; leave empty to view", type: 3, required: false }],
	},
	{ name: "forget", description: "Delete your server memory and stop collecting it" },
];
const ADMIN_COMMANDS = [
	{ name: "context", description: "Show this channel's context usage (bot admin only)" },
	{ name: "compact", description: "Compact this channel's context (bot admin only)" },
	{
		name: "model",
		description: "Show or switch this bot's model (bot admin only)",
		options: [
			{
				name: "model",
				description: "provider/model, or default; leave empty to list models",
				type: 3,
				required: false,
			},
		],
	},
];

function attachmentPlaceholder(contentType: string | undefined): string {
	const type = contentType?.toLowerCase() ?? "";
	if (type.startsWith("video/")) return "[视频]";
	if (type.startsWith("audio/")) return "[语音]";
	return "[文件]";
}

/** Normalize one Discord message; null when outside the allow-list. Images/video frames are capped per message. */
async function normalizeDiscordMessage(
	message: DiscordMessage,
	allowedGuilds: ReadonlyMap<string, ReadonlySet<string>>,
	parentChannelId?: string,
): Promise<InboundMessage | null> {
	const guildId = message.guild_id;
	const allowedChannels = typeof guildId === "string" ? allowedGuilds.get(guildId) : undefined;
	if (
		!allowedChannels ||
		!(allowedChannels.has(message.channel_id) || (parentChannelId && allowedChannels.has(parentChannelId)))
	)
		return null;
	const images: InboundImage[] = [];
	const placeholders: string[] = [];
	for (const attachment of message.attachments ?? []) {
		const ref = {
			url: attachment.url,
			filename: attachment.filename,
			contentType: attachment.content_type,
			size: attachment.size,
		};
		const type = attachment.content_type?.toLowerCase() ?? "";
		if (type.startsWith("image/")) {
			if (images.length >= MAX_IMAGES_PER_MESSAGE) continue;
			const downloaded = await downloadDiscordImage(ref);
			const prepared = downloaded ? await prepareImage(downloaded.bytes, downloaded.mimeType) : null;
			if (prepared?.ok) images.push(prepared.image);
			else placeholders.push("[图片]");
			continue;
		}
		if (type.startsWith("video/") && images.length < MAX_IMAGES_PER_MESSAGE) {
			const frames = await videoFrames(ref, MAX_IMAGES_PER_MESSAGE - images.length);
			if (frames.length) {
				images.push(...frames);
				placeholders.push(`[视频 ${frames.length}帧]`);
				continue;
			}
		}
		placeholders.push(attachmentPlaceholder(attachment.content_type));
	}
	const content = [message.content ?? "", ...placeholders].filter(Boolean).join(" ");
	return {
		platform: "discord",
		spaceId: toSpaceId("discord", guildId as string),
		channelId: message.channel_id,
		messageId: message.id,
		authorId: message.author.id,
		authorName: message.author.username,
		isBot: message.author.bot === true,
		content,
		mentionedUserIds: (message.mentions ?? []).map((mention) => mention.id),
		replyToMessageId: message.message_reference?.message_id ?? null,
		replyToAuthorId: message.referenced_message?.author.id ?? null,
		timestamp: Date.parse(String(message.timestamp ?? "")) || Date.now(),
		images,
	};
}

async function videoFrames(
	ref: { url: string; filename?: string; contentType?: string; size?: number },
	limit: number,
): Promise<InboundImage[]> {
	const downloaded = await downloadDiscordVideo(ref);
	if (!downloaded) return [];
	const extension = /\.([A-Za-z0-9]{1,8})$/.exec(ref.filename ?? "")?.[1] ?? "mp4";
	const extracted = await extractVideoFrames({
		sourceBytes: downloaded,
		sourceExtension: extension,
	});
	if (!extracted.ok) return [];
	const images: InboundImage[] = [];
	for (const frame of extracted.frames.slice(0, limit)) {
		const prepared = await prepareImage(frame.bytes, frame.mimeType);
		if (prepared.ok) images.push(prepared.image);
	}
	return images;
}

function getOption(interaction: DiscordInteraction, name: string): string | undefined {
	const options = interaction.data?.options;
	if (!Array.isArray(options)) return undefined;
	for (const item of options)
		if (item && typeof item === "object" && "name" in item && item.name === name && "value" in item)
			return typeof item.value === "string" ? item.value : undefined;
	return undefined;
}

function inPersonaScope(persona: Persona, space: SpaceId): boolean {
	return !persona.spaces || persona.spaces.includes(space);
}

export async function createDiscordPlatform(deps: PlatformDeps): Promise<PlatformHandle> {
	const { config, memberMemory } = deps;
	const guilds = config.discord?.guilds ?? [];
	const allowedGuilds = new Map(guilds.map(({ guildId, channelIds }) => [guildId, new Set(channelIds)]));
	const clients = new Map<string, DiscordTransport>();
	const commandsByClient: Array<{ client: DiscordTransport; persona: Persona }> = [];

	for (const persona of deps.personas) {
		const token = config.personas.find((candidate) => candidate.id === persona.id)?.tokens.discord;
		if (!token) continue;
		const identity = await new DiscordTransport({ token, applicationId: PROBE_APPLICATION_ID }).getCurrentUser();
		persona.accounts.discord = { userId: identity.id, username: identity.username };
		const personaAllowed = guilds
			.filter(({ guildId }) => inPersonaScope(persona, toSpaceId("discord", guildId)))
			.flatMap(({ channelIds }) => channelIds);
		const client: DiscordTransport = new DiscordTransport({
			token,
			applicationId: identity.id,
			allowedChannelIds: personaAllowed,
			onError: (error) =>
				log.error("discord", "transport_error", { persona_id: persona.id, error_category: errorCategory(error) }),
			onMessage: async (message) => {
				try {
					const normalized = await normalizeDiscordMessage(
						message,
						allowedGuilds,
						client.getParentChannelId(message.channel_id),
					);
					if (normalized) await deps.getCore().handleMessage(normalized);
				} catch (error) {
					log.error("discord", "message_failed", { persona_id: persona.id, error_category: errorCategory(error) });
				}
			},
			onInteraction: (interaction) => handleInteraction(interaction, persona, client),
		});
		clients.set(persona.id, client);
		commandsByClient.push({ client, persona });
	}

	const isAdmin = (persona: Persona, userId: string) => persona.adminUserIds.includes(`discord:${userId}`);

	async function handleInteraction(
		interaction: DiscordInteraction,
		persona: Persona,
		client: DiscordTransport,
	): Promise<void> {
		const guildId = interaction.guild_id;
		const channels = typeof guildId === "string" ? allowedGuilds.get(guildId) : undefined;
		if (
			!guildId ||
			!channels ||
			!inPersonaScope(persona, toSpaceId("discord", guildId)) ||
			!interaction.channel_id ||
			!(channels.has(interaction.channel_id) || channels.has(client.getParentChannelId(interaction.channel_id) ?? ""))
		)
			return;
		const space = toSpaceId("discord", guildId);
		const channelId = interaction.channel_id;
		const author = interaction.member?.user ?? interaction.user;
		const name = interaction.data?.name;
		const reply = (content: string) => client.respondToInteraction(interaction, content, { ephemeral: true });

		if (name === "memory" || name === "birthday" || name === "forget") {
			if (!author) return;
			try {
				if (name === "forget") {
					memberMemory.forgetMember(space, author.id);
					await reply(
						"已删除你在这个服务器的长期档案和关系记录，并停止继续建立档案。频道原有聊天记录仍按服务器现有设置保存。",
					);
					return;
				}
				if (name === "memory") {
					if (getOption(interaction, "action") === "enable") {
						memberMemory.enableMember(space, author.id);
						await reply("已重新启用你在这个服务器的长期记忆。今后的消息会建立新档案。");
						return;
					}
					const profile = memberMemory.getProfile(space, author.id);
					await reply(
						profile
							? [
									`名称：${profile.name}`,
									`已记录消息：${profile.messageCount}`,
									`生日：${profile.birthday ? `${profile.birthday.month}月${profile.birthday.day}日` : "未记录"}`,
									...profile.facts.slice(0, 6).map((fact) => `${fact.key}：${fact.value}`),
									...profile.relationships.slice(0, 5).map((relation) => `${relation.type}：${relation.name}`),
								]
									.join("\n")
									.slice(0, 1800)
							: "这个服务器里暂无你的长期档案，或者你已关闭记忆。可用 `/memory action:enable` 重新启用。",
					);
					return;
				}
				const date = getOption(interaction, "date")?.trim();
				if (!date) {
					const birthday = memberMemory.getProfile(space, author.id)?.birthday;
					await reply(
						birthday
							? `已记录生日：${birthday.month}月${birthday.day}日。`
							: "还没有记录生日。使用 `/birthday date:MM-DD` 设置。",
					);
					return;
				}
				if (date.toLowerCase() === "clear") {
					memberMemory.clearBirthday(space, author.id);
					await reply("已清除生日提醒。");
					return;
				}
				const birthday = parseBirthdayDate(date);
				if (!birthday) {
					await reply("请输入 MM-DD，例如 09-25；或输入 clear 清除。");
					return;
				}
				const { month, day } = birthday;
				memberMemory.setBirthday(space, author.id, month, day, channelId, interaction.id);
				const celebrationChannel = config.celebrations.find((target) => target.spaceId === space)?.channelId;
				await reply(
					`已在这个服务器记录你的生日：${month}月${day}日。${celebrationChannel ? `到时会在 <#${celebrationChannel}> 祝福。` : "这个服务器尚未启用自动生日祝福。"}`,
				);
			} catch (error) {
				log.error("discord", "memory_command_failed", { error_category: errorCategory(error) });
				await reply(
					memoryCommandError(error, "你已关闭长期记忆。若要重新保存生日，请先使用 `/memory action:enable`。"),
				);
			}
			return;
		}
		if (name === "context" || name === "compact") {
			if (!author || !isAdmin(persona, author.id)) {
				await reply("只有管理员可以使用这个命令。");
				return;
			}
			await client.deferInteraction(interaction, true);
			try {
				const content = await runContextCommand(
					deps.getCore(),
					name,
					[persona.id, "discord", space, channelId, author.id],
					{ context: "当前频道上下文", scope: "本频道" },
				);
				await client.followUpInteraction(interaction, content, true);
			} catch (error) {
				log.error("discord", "admin_command_failed", { persona_id: persona.id, error_category: errorCategory(error) });
				await client.followUpInteraction(
					interaction,
					contextCommandError(error, "本频道") ?? "上下文管理失败，请稍后再试。",
					true,
				);
			}
			return;
		}
		if (name === "model") {
			if (!author || !isAdmin(persona, author.id)) {
				await reply("只有管理员可以使用这个命令。");
				return;
			}
			await client.deferInteraction(interaction, true);
			try {
				const content = await runModelCommand(deps.getCore(), getOption(interaction, "model") ?? "", [
					persona.id,
					"discord",
					space,
					author.id,
				]);
				await client.followUpInteraction(interaction, content, true);
			} catch (error) {
				log.error("discord", "admin_command_failed", { persona_id: persona.id, error_category: errorCategory(error) });
				await client.followUpInteraction(interaction, modelCommandError(error) ?? "切换模型失败，请稍后再试。", true);
			}
			return;
		}
		if (name === "help") {
			await reply(
				author && isAdmin(persona, author.id)
					? "Commands: `/ask`, `/status`, `/memory`, `/birthday`, `/forget`, `/context`, `/compact`, `/model`"
					: "Commands: `/ask`, `/status`, `/memory`, `/birthday`, `/forget`",
			);
			return;
		}
		if (name === "status") {
			const alive = deps.personas
				.flatMap((candidate) => (candidate.accounts.discord ? [candidate.accounts.discord.username] : []))
				.join(", ");
			await reply(`Online. Assistants: ${alive}.`);
			return;
		}
		if (name !== "ask") return;
		const prompt = getOption(interaction, "prompt")?.trim();
		if (!prompt) {
			await reply("Please include a prompt.");
			return;
		}
		await client.deferInteraction(interaction, true);
		try {
			if (!author) throw new Error("missing_interaction_context");
			const dispatch = await deps.getCore().handleMessage({
				platform: "discord",
				spaceId: space,
				channelId,
				messageId: interaction.id,
				authorId: author.id,
				authorName: author.username,
				isBot: false,
				content: prompt,
				mentionedUserIds: [persona.accounts.discord!.userId],
			});
			await client.followUpInteraction(
				interaction,
				dispatch.responseMessageId
					? "Your answer was posted in the channel."
					: dispatch.route.personaId
						? "The assistant didn't return an answer. Please try again."
						: "No assistant was selected for that request. Please try /ask again.",
			);
		} catch (error) {
			log.error("discord", "ask_failed", { persona_id: persona.id, error_category: errorCategory(error) });
			await client.followUpInteraction(interaction, "I couldn't complete that request. Please try again.");
		}
	}

	const transport = new DiscordPlatformTransport(clients, config.jev?.emojis?.discord ?? DISCORD_QUICK_REACTIONS);
	return {
		transport,
		async start() {
			for (const { client, persona } of commandsByClient) {
				const commands = persona.adminUserIds.some((id) => id.startsWith("discord:"))
					? [...COMMANDS, ...ADMIN_COMMANDS]
					: COMMANDS;
				for (const { guildId } of guilds)
					if (inPersonaScope(persona, toSpaceId("discord", guildId))) await client.registerCommands(commands, guildId);
			}
			for (const client of clients.values()) await client.start();
		},
		async stop() {
			await Promise.allSettled([...clients.values()].map((client) => client.stop()));
		},
	};
}
