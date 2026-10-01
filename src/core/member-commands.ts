import type { ConversationCore } from "./types.ts";

const MAX_LISTED_MODELS_CHARS = 1200;

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
		return `${labels.context}：${tokens} / ${status.contextWindow.toLocaleString()} tokens。自动压缩约在 ${status.compactionAtTokens.toLocaleString()} tokens 后触发；也可用 /compact 手动压缩。`;
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

/** `/model` → status, `/model default` → configured model, `/model provider/model` → switch. */
export async function runModelCommand(
	core: ConversationCore,
	args: string,
	target: Parameters<ConversationCore["getModelStatus"]>,
): Promise<string> {
	const ref = args.trim();
	const status = ref
		? await core.selectModel(...target, ref.toLowerCase() === "default" ? null : ref)
		: await core.getModelStatus(...target);
	const current =
		status.current === status.configured
			? `${status.current}（配置默认）`
			: `${status.current}（配置默认为 ${status.configured}）`;
	if (ref) return `已切换为 ${current}。所有频道从下一条消息起生效。`;
	let listed = "";
	let shown = 0;
	for (const model of status.available) {
		const next = listed ? `${listed}、${model}` : model;
		if (next.length > MAX_LISTED_MODELS_CHARS) break;
		listed = next;
		shown++;
	}
	const more = status.available.length > shown ? ` …等 ${status.available.length} 个` : "";
	return [
		`当前模型：${current}`,
		`可用模型：${listed ? `${listed}${more}` : "无（没有已登录的 provider）"}`,
		"用 /model provider/model 切换，/model default 恢复配置默认。",
	].join("\n");
}

/** Unknown errors stay with the adapter's existing logging and failure handling. */
export function modelCommandError(error: unknown): string | null {
	const reason = error instanceof Error ? error.message : "";
	if (reason === "not_persona_admin") return "只有管理员可以使用这个命令。";
	if (reason === "invalid_model_ref") return "请用 provider/model 格式，例如 /model deepseek/deepseek-flash。";
	if (reason === "unknown_model") return "没有这个模型；发送 /model 查看可用模型。";
	if (reason === "unauthenticated_provider")
		return "这个 provider 还没有凭据：在服务器上执行 bun run jingmei login 登录，或配置它的 API key。";
	return null;
}
