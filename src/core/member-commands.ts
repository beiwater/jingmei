import type { ConversationCore } from "./types.ts";

/** Calendar validity and opt-out enforcement remain in MemberMemory.setBirthday. */
export function parseBirthdayDate(date: string): { month: number; day: number } | null {
	const match = /^(\d{1,2})-(\d{1,2})$/.exec(date);
	return match ? { month: Number(match[1]), day: Number(match[2]) } : null;
}

export function memoryCommandError(error: unknown, optedOutReply: string): string {
	return error instanceof Error && error.message === "memory_opted_out"
		? optedOutReply
		: "记忆操作失败；请检查日期是否有效，或稍后重试。";
}

export async function runContextCommand(
	core: ConversationCore,
	command: string,
	target: Parameters<ConversationCore["getContextStatus"]>,
	labels: { context: string; scope: string },
): Promise<string> {
	if (command === "context") {
		const status = await core.getContextStatus(...target);
		const tokens = status.tokens === null ? "暂时无法估算" : `${status.tokens.toLocaleString()} tokens`;
		return `${labels.context}：${tokens} / ${status.contextWindow.toLocaleString()} tokens。每次回复只带最近 ${status.windowMessages} 条群消息，更早的靠检索；连续对话会接续同一段，超过 ${status.segmentMaxTokens.toLocaleString()} tokens、距上次回复超过 ${status.segmentIdleMs / 60_000} 分钟或其间新增超过 ${status.segmentMaxPending} 条消息就开新的对话段。接近窗口上限（约 ${status.safetyCompactionAtTokens.toLocaleString()} tokens）仍有自动压缩与溢出恢复保护，也可用 /compact 手动压缩。`;
	}
	const result = await core.compactContext(...target);
	return `已压缩${labels.scope}上下文。压缩前约 ${result.tokensBefore.toLocaleString()} tokens。`;
}

/** Unknown errors stay with the adapter's existing logging and failure handling. */
export function contextCommandError(error: unknown, scope: string): string | null {
	const reason = error instanceof Error ? error.message : "";
	if (reason === "not_persona_admin") return "只有管理员可以使用这个命令。";
	if (reason === "context_busy") return `${scope}正在处理消息，稍后再试。`;
	if (reason === "Already compacted" || reason.startsWith("Nothing to compact"))
		return `${scope}目前没有需要压缩的上下文。`;
	return null;
}
