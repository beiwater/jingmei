import { createClient, type WireQuestion, wire } from "notjev";
import { createJevClient, type JevClient, JevError } from "./jev.ts";

export interface LocalJevLlm {
	baseUrl: string;
	model: string;
	apiKey?: string;
	timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const LOCAL_ENDPOINT = "http://localhost/v1/systemone";

/** 本地转换 Jev 协议，不监听端口；网络请求只发给配置的 LLM。 */
export function createLocalSystemOneFetch(llm: LocalJevLlm, fetchImpl: typeof fetch = fetch): typeof fetch {
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

	return (async (input: string | URL | Request, init?: RequestInit) => {
		const request = input instanceof Request ? new Request(input, init) : new Request(String(input), init);
		if (request.method !== "POST" || new URL(request.url).pathname !== "/v1/systemone") {
			return new Response(null, { status: 404 });
		}
		try {
			const raw: unknown = await request.json();
			if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
				return new Response(null, { status: 422 });
			}
			const body = raw as { state?: unknown; questions?: unknown; model?: string; theta?: number };
			// notjev 只接受字符串 state/instructions；TypeSafe 接受结构化 JSON。
			const questions: Record<string, WireQuestion> = {};
			if (typeof body.questions === "object" && body.questions !== null && !Array.isArray(body.questions)) {
				for (const [id, value] of Object.entries(body.questions)) {
					if (typeof value !== "object" || value === null || Array.isArray(value)) {
						return new Response(null, { status: 422 });
					}
					const question = value as WireQuestion;
					questions[id] = {
						...question,
						instructions:
							typeof question.instructions === "string" ? question.instructions : JSON.stringify(question.instructions),
					};
				}
			}
			const translated = wire.toQuestions({
				...body,
				state: typeof body.state === "string" ? body.state : JSON.stringify(body.state),
				questions,
			});
			for (const question of translated.questions) question.signal = request.signal;
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
			return new Response(
				JSON.stringify({
					model: llm.model,
					answers: { ...out.answers.nouls, ...out.answers.choices, ...out.answers.scores },
					usage: out.usage,
				}),
				{ headers: { "Content-Type": "application/json" } },
			);
		} catch (error) {
			if (error instanceof JevError) throw error;
			if (request.signal.aborted) throw new JevError("timeout");
			const code = (error as { code?: unknown } | null)?.code;
			if (code === "NOTJEV_WIRE_422" || error instanceof SyntaxError) {
				return new Response(null, { status: 422 });
			}
			if (code === "NOTJEV_TIMEOUT") throw new JevError("timeout");
			if (code === "NOTJEV_NETWORK") throw new JevError("network");
			return new Response(null, { status: 502 });
		}
	}) as typeof fetch;
}

export function createLocalJevClient(llm: LocalJevLlm, fetchImpl: typeof fetch = fetch): JevClient {
	return createJevClient(
		{ endpoint: LOCAL_ENDPOINT, model: llm.model, timeoutMs: llm.timeoutMs ?? DEFAULT_TIMEOUT_MS },
		createLocalSystemOneFetch(llm, fetchImpl),
	);
}
