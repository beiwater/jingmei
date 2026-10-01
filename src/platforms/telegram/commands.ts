// Group text commands (`/memory`, `/birthday@jingmei_bot 09-25`, …). Same semantics as the Discord
// slash commands, but Telegram has no ephemeral replies: answers go into the group as a brief reply.

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
import type { ConversationCore, Persona, SpaceId } from "../../core/types.ts";
import type { TelegramEntity } from "./normalize.ts";

export const TELEGRAM_COMMANDS = [
	{ command: "help", description: "查看命令" },
	{ command: "status", description: "查看在线角色" },
	{ command: "ask", description: "直接向这个角色提问" },
	{ command: "memory", description: "查看或重新启用你在本群的长期记忆（/memory enable）" },
	{ command: "birthday", description: "查看、设置或清除生日（MM-DD 或 clear）" },
	{ command: "forget", description: "删除你在本群的长期记忆并停止记录" },
] as const;
export const TELEGRAM_ADMIN_COMMANDS = [
	{ command: "context", description: "查看本群上下文用量（管理员）" },
	{ command: "compact", description: "压缩本群上下文（管理员）" },
	{ command: "model", description: "查看或切换模型（管理员，/model provider/model）" },
] as const;

const KNOWN_COMMANDS: ReadonlySet<string> = new Set(
	[...TELEGRAM_COMMANDS, ...TELEGRAM_ADMIN_COMMANDS].map(({ command }) => command),
);

export interface ParsedCommand {
	/** Lower-cased command name without the slash. */
	name: string;
	/** Lower-cased `@botusername` suffix, or null when the command addresses every bot. */
	target: string | null;
	args: string;
}

/** A command is a `bot_command` entity at offset 0 naming one of our commands; anything else is chat. */
export function parseCommand(text: string, entities: readonly TelegramEntity[]): ParsedCommand | null {
	const entity = entities.find((candidate) => candidate.type === "bot_command" && candidate.offset === 0);
	if (!entity) return null;
	const match = /^\/([A-Za-z0-9_]{1,32})(?:@([A-Za-z0-9_]{1,64}))?$/.exec(text.slice(0, entity.length));
	if (!match) return null;
	const name = match[1]!.toLowerCase();
	if (!KNOWN_COMMANDS.has(name)) return null;
	return { name, target: match[2]?.toLowerCase() ?? null, args: text.slice(entity.length).trim() };
}

export interface CommandContext {
	command: ParsedCommand;
	/** The persona whose bot answers. */
	persona: Persona;
	/** In-scope personas with a Telegram account in this chat, in configured order. */
	chatPersonas: readonly Persona[];
	spaceId: SpaceId;
	chatId: string;
	messageId: string;
	userId: string;
	config: AppConfig;
	memberMemory: MemberMemory;
	getCore(): ConversationCore;
}

function formatBirthday(birthday: { month: number; day: number }): string {
	return `${birthday.month}月${birthday.day}日`;
}

/** Reply text for every command except `/ask`, which the adapter routes into the core. */
export async function runCommand(context: CommandContext): Promise<string> {
	const { command, persona, spaceId, userId, memberMemory } = context;
	const isAdmin = persona.adminUserIds.includes(`telegram:${userId}`);
	switch (command.name) {
		case "help":
			return isAdmin
				? "命令：/ask /status /memory /birthday /forget /context /compact /model"
				: "命令：/ask /status /memory /birthday /forget";
		case "status":
			return `在线。角色：${context.chatPersonas.map((candidate) => `@${candidate.accounts.telegram!.username}`).join("、")}。`;
		case "forget":
			memberMemory.forgetMember(spaceId, userId);
			return "已删除你在本群的长期档案和关系记录，并停止继续建立档案。";
		case "memory": {
			if (command.args.toLowerCase() === "enable") {
				memberMemory.enableMember(spaceId, userId);
				return "已重新启用你在本群的长期记忆。今后的消息会建立新档案。";
			}
			const profile = memberMemory.getProfile(spaceId, userId);
			if (!profile) return "本群暂无你的长期档案，或者你已关闭记忆。可用 /memory enable 重新启用。";
			// Group replies are public: summarize instead of listing remembered facts.
			return [
				`名称：${profile.name}`,
				`已记录消息：${profile.messageCount}`,
				`生日：${profile.birthday ? formatBirthday(profile.birthday) : "未记录"}`,
				`记住的事：${profile.facts.length} 条；关系：${profile.relationships.length} 条`,
			].join("\n");
		}
		case "birthday":
			return runBirthday(context);
		case "context":
		case "compact":
		case "model":
			return runAdminCommand(context, isAdmin);
		default:
			throw new Error(`unhandled_command:${command.name}`);
	}
}

function runBirthday(context: CommandContext): string {
	const { command, spaceId, userId, memberMemory } = context;
	const date = command.args;
	try {
		if (!date) {
			const birthday = memberMemory.getProfile(spaceId, userId)?.birthday;
			return birthday ? `已记录生日：${formatBirthday(birthday)}。` : "还没有记录生日。使用 /birthday MM-DD 设置。";
		}
		if (date.toLowerCase() === "clear") {
			memberMemory.clearBirthday(spaceId, userId);
			return "已清除生日提醒。";
		}
		const birthday = parseBirthdayDate(date);
		if (!birthday) return "请输入 MM-DD，例如 /birthday 09-25；或 /birthday clear 清除。";
		const { month, day } = birthday;
		memberMemory.setBirthday(spaceId, userId, month, day, context.chatId, context.messageId);
		const celebrates = context.config.celebrations.some((target) => target.spaceId === spaceId);
		return `已在本群记录你的生日：${month}月${day}日。${celebrates ? "到时会在群里祝福。" : "本群尚未启用自动生日祝福。"}`;
	} catch (error) {
		return memoryCommandError(error, "你已关闭长期记忆。若要保存生日，请先使用 /memory enable。");
	}
}

async function runAdminCommand(context: CommandContext, isAdmin: boolean): Promise<string> {
	const { command, persona, spaceId, chatId, userId } = context;
	if (!isAdmin) return "只有管理员可以使用这个命令。";
	// Context is per persona: an untargeted command is ambiguous when several bots share the chat.
	if (!command.target && context.chatPersonas.length > 1) {
		const choices = context.chatPersonas
			.map((candidate) => `/${command.name}@${candidate.accounts.telegram!.username}`)
			.join("  ");
		return `本群有多个角色，请指定：${choices}`;
	}
	if (command.name === "model") {
		try {
			return await runModelCommand(context.getCore(), command.args, [persona.id, "telegram", spaceId, userId]);
		} catch (error) {
			const reply = modelCommandError(error);
			if (reply) return reply;
			throw error;
		}
	}
	try {
		return await runContextCommand(context.getCore(), command.name, [persona.id, "telegram", spaceId, chatId, userId], {
			context: "当前上下文",
			scope: "本群",
		});
	} catch (error) {
		const reply = contextCommandError(error, "本群");
		if (reply) return reply;
		throw error;
	}
}
