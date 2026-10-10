/** Discord adapter: one Gateway client per persona token, normalized into the shared conversation core. */

import type { AppConfig } from "../../config.ts";
import {
	contextCommandError,
	HELP_INTRO,
	memoryCommandError,
	PAUSED_REPLY,
	parseBirthdayDate,
	runContextCommand,
	statusReply,
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
	DiscordGatewayFatalError,
	DiscordPlatformTransport,
	DiscordTransport,
} from "./transport.ts";

export interface PlatformDeps {
	config: AppConfig;
	personas: readonly Persona[];
	getCore(): ConversationCore;
	memberMemory: MemberMemory;
	/** True while an operator has paused the bot. */
	isPaused(): boolean;
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
	{ name: "help", description: "查看命令和使用方法" },
	{ name: "status", description: "查看在线状态" },
	{
		name: "ask",
		description: "直接向角色提问",
		options: [{ name: "prompt", description: "想问什么？", type: 3, required: true }],
	},
	{
		name: "memory",
		description: "查看或重新启用你在本服务器的长期记忆",
		options: [
			{
				name: "action",
				description: "show 或 enable",
				type: 3,
				required: false,
				choices: [
					{ name: "查看", value: "show" },
					{ name: "启用", value: "enable" },
				],
			},
		],
	},
	{
		name: "birthday",
		description: "查看、设置或清除生日提醒",
		options: [{ name: "date", description: "MM-DD，或 clear 清除；留空查看", type: 3, required: false }],
	},
	{ name: "forget", description: "删除你在本服务器的长期记忆并停止记录" },
];
const ADMIN_COMMANDS = [
	{ name: "context", description: "查看本频道上下文用量（管理员）" },
	{ name: "compact", description: "压缩本频道上下文（管理员）" },
];

function attachmentPlaceholder(contentType: string | undefined): string {
	const type = contentType?.toLowerCase() ?? "";
	if (type.startsWith("video/")) return "[视频]";
	if (type.startsWith("audio/")) return "[语音]";
	return "[文件]";
}

/** Normalize one Discord message; the transport already limited events to the persona's allowed channels. Images/video frames are capped per message. */
async function normalizeDiscordMessage(message: DiscordMessage): Promise<InboundMessage> {
	const images: InboundImage[] = [];
	const placeholders: string[] = [];
	for (const attachment of message.attachments ?? []) {
		const ref = {
			url: attachment.url,
			filename: attachment.filename,
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
		spaceId: toSpaceId("discord", message.guild_id as string),
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
	ref: { url: string; filename?: string; size?: number },
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
	const value = interaction.data?.options?.find((option) => option.name === name)?.value;
	return typeof value === "string" ? value : undefined;
}

function inPersonaScope(persona: Persona, space: SpaceId): boolean {
	return !persona.spaces || persona.spaces.includes(space);
}

export async function createDiscordPlatform(deps: PlatformDeps): Promise<PlatformHandle> {
	const { config, memberMemory } = deps;
	const guilds = config.discord?.guilds ?? [];
	const clients = new Map<string, DiscordTransport>();
	let failing = false;
	/**
	 * Reconnecting cannot fix this: tell the operator what to change and shut down. The exit code stays 0 on
	 * purpose: under `Restart=on-failure` a nonzero exit would re-IDENTIFY every few seconds and Discord
	 * resets the token after 1000 IDENTIFYs a day.
	 */
	function failFatally(personaId: string, error: DiscordGatewayFatalError): void {
		console.error(`[${personaId}] ${error.message}. ${error.hint}`.trim());
		if (failing) return;
		failing = true;
		process.kill(process.pid, "SIGTERM");
	}
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
			onError: (error) => {
				log.error("discord", "transport_error", {
					persona_id: persona.id,
					error_category: errorCategory(error),
					...(error instanceof DiscordGatewayFatalError ? { close_code: error.code } : {}),
				});
				if (error instanceof DiscordGatewayFatalError) failFatally(persona.id, error);
			},
			onMessage: async (message) => {
				try {
					await deps.getCore().handleMessage(await normalizeDiscordMessage(message));
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
		// The transport only delivers interactions from this persona's allowed guild channels, which always carry a member.
		const space = toSpaceId("discord", interaction.guild_id!);
		const channelId = interaction.channel_id!;
		const author = interaction.member!.user!;
		const name = interaction.data?.name;
		const reply = (content: string) => client.respondToInteraction(interaction, content, { ephemeral: true });

		if (name === "memory" || name === "birthday" || name === "forget") {
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
			if (!isAdmin(persona, author.id)) {
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
		if (name === "help") {
			const commands = isAdmin(persona, author.id) ? [...COMMANDS, ...ADMIN_COMMANDS] : COMMANDS;
			await reply([HELP_INTRO, ...commands.map((command) => `/${command.name} ${command.description}`)].join("\n"));
			return;
		}
		if (name === "status") {
			const alive = deps.personas.flatMap((candidate) =>
				candidate.accounts.discord ? [candidate.accounts.discord.username] : [],
			);
			await reply(statusReply(alive, deps.isPaused()));
			return;
		}
		if (name !== "ask") return;
		const prompt = getOption(interaction, "prompt")?.trim();
		if (!prompt) {
			await reply("请带上你的问题。");
			return;
		}
		if (deps.isPaused()) {
			await reply(PAUSED_REPLY);
			return;
		}
		await client.deferInteraction(interaction, true);
		try {
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
				dispatch.responseMessageId ? "回答已发到频道。" : "没有得到回答，请重试。",
			);
		} catch (error) {
			log.error("discord", "ask_failed", { persona_id: persona.id, error_category: errorCategory(error) });
			await client.followUpInteraction(interaction, "请求没有完成，请稍后再试。");
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
