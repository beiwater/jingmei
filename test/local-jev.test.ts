import { describe, expect, test } from "bun:test";
import { JevError } from "../src/decision/jev.ts";
import { createLocalJevClient } from "../src/decision/local-jev.ts";

function completion(probabilities: readonly number[]) {
	const letters = probabilities.map((probability, index) => ({
		token: String.fromCharCode(65 + index),
		logprob: Math.log(probability),
	}));
	return Response.json({
		choices: [
			{
				message: { role: "assistant", content: letters[0]?.token },
				logprobs: { content: [{ token: letters[0]?.token, top_logprobs: letters }] },
				finish_reason: "length",
			},
		],
		usage: { prompt_tokens: 20, completion_tokens: 1 },
	});
}

describe("local Jev over OpenAI chat-completions", () => {
	test("reads letter probabilities as event choices and ordered relevance scores without authentication", async () => {
		const rows = [
			[0.1, 0.8, 0.1],
			[0.75, 0.25],
			[0.2, 0.8],
		];
		let index = 0;
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(request) {
				if (new URL(request.url).pathname !== "/v1/chat/completions") return new Response(null, { status: 404 });
				const body = (await request.json()) as {
					thinking?: { type: string };
					chat_template_kwargs?: unknown;
					logprobs?: boolean;
					top_logprobs: number;
					max_tokens?: number;
				};
				// 模拟 DeepSeek 的非思考、单 token 概率接口，拒绝不支持的模板参数。
				if (
					body.thinking?.type !== "disabled" ||
					body.chat_template_kwargs !== undefined ||
					body.logprobs !== true ||
					body.top_logprobs > 20 ||
					body.max_tokens !== 1 ||
					request.headers.has("authorization")
				) {
					return new Response(null, { status: 400 });
				}
				return completion(rows[index++] ?? []);
			},
		});
		try {
			const client = createLocalJevClient({ baseUrl: server.url.toString(), model: "deepseek-flash" });
			const decision = await client.chooseEvent({
				message: "它不吃罐头怎么办",
				recent: ["甲：周末去爬山", "乙：猫不肯吃饭"],
				options: [
					{ id: "e1", description: "周末爬山" },
					{ id: "e2", description: "猫咪饮食" },
				],
			});
			expect(decision.choice).toBe("e2");
			expect(decision.confidence).toBeCloseTo(1 - (-0.8 * Math.log(0.8) - 0.2 * Math.log(0.1)) / Math.log(3));
			expect(decision.probabilities?.e1).toBeCloseTo(0.1);
			expect(decision.probabilities?.e2).toBeCloseTo(0.8);
			expect(decision.probabilities?.new).toBeCloseTo(0.1);
			const scores = await client.scoreRelevance("猫吃什么", ["猫粮", "爬山"]);
			expect(scores[0]).toBeCloseTo(0.75);
			expect(scores[1]).toBeCloseTo(0.2);
		} finally {
			await server.stop(true);
		}
	});

	test("supports versioned base URLs and chooses argmax with menu-order ties", async () => {
		for (const [probabilities, choice] of [
			[[0.45, 0.55], "new"],
			[[0.5, 0.5], "e1"],
		] as const) {
			const upstream = (async (input: string | URL | Request) => {
				if (String(input) !== "http://localhost:9999/v1/chat/completions") {
					return new Response(null, { status: 404 });
				}
				return completion(probabilities);
			}) as typeof fetch;
			const client = createLocalJevClient({ baseUrl: "http://localhost:9999/v1/", model: "local" }, upstream);
			const decision = await client.chooseEvent({
				message: "新话题",
				options: [{ id: "e1", description: "爬山" }],
			});
			expect(decision.choice).toBe(choice);
			expect(decision.probabilities?.e1).toBeCloseTo(probabilities[0]);
			expect(decision.probabilities?.new).toBeCloseTo(probabilities[1]);
		}
	});

	test("upstream errors and missing logprobs raise sanitized JevError instead of fabricated decisions", async () => {
		for (const response of [new Response("secret upstream content", { status: 401 }), Response.json({ choices: [] })]) {
			const server = Bun.serve({
				hostname: "127.0.0.1",
				port: 0,
				async fetch() {
					return new Response(await response.text(), { status: response.status });
				},
			});
			try {
				const client = createLocalJevClient({ baseUrl: server.url.toString(), model: "local" });
				const error = await client.scoreRelevance("private text", ["candidate"]).catch((caught: unknown) => caught);
				expect(error).toBeInstanceOf(JevError);
				expect((error as JevError).code).toBe(response.ok ? "invalid_response" : "http_502");
				expect(String(error)).not.toContain("secret upstream content");
				expect(String(error)).not.toContain("private text");
			} finally {
				await server.stop(true);
			}
		}
	});

	test("refuses an unsupported choice menu before contacting the upstream", async () => {
		let calls = 0;
		const upstream = (async () => {
			calls++;
			return completion([0.5, 0.5]);
		}) as unknown as typeof fetch;
		const client = createLocalJevClient({ baseUrl: "http://localhost:9999", model: "local" }, upstream);
		const error = await client
			.chooseEvent({
				message: "q",
				options: Array.from({ length: 26 }, (_, index) => ({ id: `e${index}`, description: "topic" })),
			})
			.catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(JevError);
		expect((error as JevError).code).toBe("invalid_response");
		expect(calls).toBe(0);
	});

	test("cancels an in-flight upstream request when the decision deadline expires", async () => {
		const hanging = ((_input: string | URL | Request, init?: RequestInit) =>
			new Promise<Response>((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
			})) as typeof fetch;
		const client = createLocalJevClient({ baseUrl: "http://localhost:9999", model: "local", timeoutMs: 20 }, hanging);
		const error = await client.scoreRelevance("q", ["a"]).catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(JevError);
		expect((error as JevError).code).toBe("timeout");
	});
});
