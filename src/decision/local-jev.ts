import { createClient, type WireQuestion, wire } from "notjev";
import { createJevClientWithTransport, type JevClient, JevError } from "./jev.ts";

export interface LocalJevLlm {
	baseUrl: string;
	model: string;
	apiKey?: string;
	timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/** 本地转换 Jev 协议，不监听端口；网络请求只发给配置的 LLM。 */
export function createLocalJevClient(llm: LocalJevLlm, fetchImpl: typeof fetch = fetch): JevClient {
	const baseUrl = llm.baseUrl.replace(/\/+$/, "");
	const deepseek = new URL(baseUrl).hostname === "api.deepseek.com" || llm.model.startsWith("deepseek-");
	const client = createClient({
		baseUrl,
		model: llm.model,
		apiKey: llm.apiKey,
		fetch: fetchImpl,
		timeoutMs: llm.timeoutMs ?? DEFAULT_TIMEOUT_MS,
		path: baseUrl.endsWith("/v1") ? "/chat/completions" : "/v1/chat/completions",
		env: {},
		retries: 0,
		topLogprobs: 20,
		// DeepSeek 的 thinking 默认开启；官方协议用 thinking.type 禁用，不接受模板参数。
		// https://api-docs.deepseek.com/api/create-chat-completion
		templateKwargs: null,
		extra: deepseek ? { thinking: { type: "disabled" } } : undefined,
	});

	return createJevClientWithTransport(async (state, questions) => {
		const signal = AbortSignal.timeout(llm.timeoutMs ?? DEFAULT_TIMEOUT_MS);
		try {
			// notjev 只接受字符串 state/instructions；TypeSafe 接受结构化 JSON。
			const wireQuestions: Record<string, WireQuestion> = {};
			for (const [id, question] of Object.entries(questions)) {
				wireQuestions[id] = {
					...question,
					instructions:
						typeof question.instructions === "string" ? question.instructions : JSON.stringify(question.instructions),
				};
			}
			const translated = wire.toQuestions({
				state: typeof state === "string" ? state : JSON.stringify(state),
				questions: wireQuestions,
			});
			for (const question of translated.questions) question.signal = signal;
			const results = await client.decideMany(translated.state, translated.questions);
			// 没有字母概率时不能把 notjev 的合成均匀分布当作真实决策。
			if (results.some((result) => result.degraded)) throw new JevError("invalid_response");
			const out = wire.toAnswers(translated.specs, results);
			// notjev 的 answers 按类型分组；TypeSafe 和现有解析器按 question id 平铺。
			// Jev 没有弃权：choice 为 null 但有真实概率时取 argmax，同分取菜单中第一项。
			for (const answer of Object.values(out.answers.choices)) {
				if (answer.choice !== null) continue;
				let best = -1;
				for (const [id, probability] of Object.entries(answer.probabilities)) {
					if (Number.isFinite(probability) && probability > best) {
						answer.choice = id;
						best = probability;
					}
				}
			}
			return { answers: { ...out.answers.nouls, ...out.answers.choices, ...out.answers.scores } };
		} catch (error) {
			if (error instanceof JevError) throw error;
			if (signal.aborted) throw new JevError("timeout");
			const code = (error as { code?: unknown } | null)?.code;
			if (code === "NOTJEV_WIRE_422" || error instanceof SyntaxError) throw new JevError("invalid_response");
			if (code === "NOTJEV_TIMEOUT") throw new JevError("timeout");
			if (code === "NOTJEV_NETWORK") throw new JevError("network");
			throw new JevError("http_502");
		}
	});
}
