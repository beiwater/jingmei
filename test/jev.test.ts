import { describe, expect, test } from "bun:test";
import {
	createJevClient,
	createJevClientWithTransport,
	JEV_ENDPOINT,
	JevError,
	type JevErrorCode,
	NEW_EVENT_OPTION,
	shouldQuickReact,
	withFallback,
} from "../src/decision/jev.ts";

interface Captured {
	url: string;
	init: RequestInit;
	body: { state: unknown; model: string; questions: Record<string, Record<string, unknown>> };
}

function fakeFetch(respond: (captured: Captured) => Response | Promise<Response>) {
	const calls: Captured[] = [];
	const impl = (async (input: string | URL | Request, init?: RequestInit) => {
		const captured: Captured = {
			url: String(input),
			init: init ?? {},
			body: JSON.parse(String(init?.body)),
		};
		calls.push(captured);
		return respond(captured);
	}) as typeof fetch;
	return { impl, calls };
}

const EMOJIS = { "👍": "赞同、收到", "😂": "好笑" };
const config = { apiKey: "secret-key", model: "jev-latest" };

function reactionAnswers(choice: string, overrides: Record<string, unknown> = {}) {
	return {
		model: "jev-1.13.0",
		answers: {
			reaction: { type: "choice", choice, probabilities: { [choice]: 0.9 }, confidence: 0.7 },
			strong_emotion: { type: "noul", noul: 0.2 },
			funny: { type: "noul", noul: 0.95 },
			...overrides,
		},
		usage: { input_tokens: 1, output_tokens: 1 },
	};
}

async function expectJevError(promise: Promise<unknown>, code: JevErrorCode) {
	const error = await promise.then(
		() => undefined,
		(caught: unknown) => caught,
	);
	expect(error).toBeInstanceOf(JevError);
	expect((error as JevError).code).toBe(code);
}

describe("Jev quick reaction", () => {
	test("sends a typed request and maps the answers", async () => {
		const { impl, calls } = fakeFetch(() => Response.json(reactionAnswers("😂")));
		const client = createJevClient(config, impl);
		const recent = ["a", "b", "c", "d", "e", "f", "g"];
		const decision = await client.decideQuickReaction({ text: "哈哈哈笑死", recent, emojis: EMOJIS });

		expect(decision).toEqual({ emoji: "😂", confidence: 0.7, strongEmotion: 0.2, funny: 0.95 });
		expect(calls).toHaveLength(1);
		const [call] = calls;
		expect(call?.url).toBe(JEV_ENDPOINT);
		expect(call?.init.method).toBe("POST");
		expect(new Headers(call?.init.headers).get("authorization")).toBe("Bearer secret-key");
		expect(call?.init.signal).toBeInstanceOf(AbortSignal);
		expect(call?.body.model).toBe("jev-latest");
		expect(call?.body.state).toEqual({ message: "哈哈哈笑死", recent: ["c", "d", "e", "f", "g"] });
		expect(Object.keys(call?.body.questions ?? {}).sort()).toEqual(["funny", "reaction", "strong_emotion"]);
		expect(call?.body.questions.reaction?.type).toBe("choice");
		expect(Object.keys(call?.body.questions.reaction?.criteria as object)).toEqual(["👍", "😂", "none"]);
		expect(call?.body.questions.strong_emotion?.type).toBe("noul");
		expect(call?.body.questions.funny?.type).toBe("noul");
	});

	test("omits recent when there is none and maps `none` to a null emoji", async () => {
		const { impl, calls } = fakeFetch(() => Response.json(reactionAnswers("none")));
		const decision = await createJevClient(config, impl).decideQuickReaction({ text: "ok", emojis: EMOJIS });
		expect(decision.emoji).toBeNull();
		expect(calls[0]?.body.state).toEqual({ message: "ok" });
	});

	test("rejects answers that are missing, mistyped, out of range, or not an offered option", async () => {
		const bad = [
			{ model: "x" },
			{ answers: [] },
			reactionAnswers("🔥"),
			reactionAnswers("😂", { funny: undefined }),
			reactionAnswers("😂", { funny: { type: "choice", choice: "x", confidence: 1 } }),
			reactionAnswers("😂", { strong_emotion: { type: "noul", noul: 1.5 } }),
			reactionAnswers("😂", { reaction: { type: "choice", choice: "😂", confidence: "high" } }),
		];
		for (const body of bad) {
			const { impl } = fakeFetch(() => Response.json(body));
			await expectJevError(
				createJevClient(config, impl).decideQuickReaction({ text: "x", emojis: EMOJIS }),
				"invalid_response",
			);
		}
		const { impl } = fakeFetch(() => new Response("not json"));
		await expectJevError(
			createJevClient(config, impl).decideQuickReaction({ text: "x", emojis: EMOJIS }),
			"invalid_response",
		);
	});

	test("maps HTTP, network and timeout failures to fixed codes", async () => {
		const http = fakeFetch(() => new Response("rate limited", { status: 429 }));
		await expectJevError(
			createJevClient(config, http.impl).decideQuickReaction({ text: "x", emojis: EMOJIS }),
			"http_429",
		);

		const network = (async () => {
			throw new TypeError("connection refused");
		}) as unknown as typeof fetch;
		await expectJevError(
			createJevClient(config, network).decideQuickReaction({ text: "x", emojis: EMOJIS }),
			"network",
		);

		const hanging = ((_input: string | URL | Request, init?: RequestInit) =>
			new Promise<Response>((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
			})) as typeof fetch;
		await expectJevError(
			createJevClient({ ...config, timeoutMs: 20 }, hanging).decideQuickReaction({ text: "x", emojis: EMOJIS }),
			"timeout",
		);
	});

	test("error messages never include the key or message text", async () => {
		const { impl } = fakeFetch(() => new Response("secret-key 秘密内容", { status: 401 }));
		const error = await createJevClient(config, impl)
			.decideQuickReaction({ text: "秘密内容", emojis: EMOJIS })
			.catch((caught: unknown) => caught as Error);
		expect(String(error)).not.toContain("secret-key");
		expect(String(error)).not.toContain("秘密内容");
	});
});

describe("Jev relevance scoring", () => {
	test("asks one noul per candidate in a single request and returns scores in order", async () => {
		const { impl, calls } = fakeFetch(() =>
			Response.json({
				model: "jev-1.13.0",
				answers: { c1: { type: "noul", noul: 0.1 }, c0: { type: "noul", noul: 0.9 }, c2: { type: "noul", noul: 0.5 } },
			}),
		);
		const scores = await createJevClient(config, impl).scoreRelevance("明天去爬山", ["喜欢爬山", "养猫", "住在上海"]);
		expect(scores).toEqual([0.9, 0.1, 0.5]);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.body.state).toBe("明天去爬山");
	});

	test("empty candidates skip the request", async () => {
		const { impl, calls } = fakeFetch(() => Response.json({}));
		expect(await createJevClient(config, impl).scoreRelevance("q", [])).toEqual([]);
		expect(calls).toHaveLength(0);
	});

	test("a missing candidate answer is invalid", async () => {
		const { impl } = fakeFetch(() => Response.json({ answers: { c0: { type: "noul", noul: 0.9 } } }));
		await expectJevError(createJevClient(config, impl).scoreRelevance("q", ["a", "b"]), "invalid_response");
	});
});

describe("Jev event decisions", () => {
	const options = [
		{ id: "e12", description: "周末爬山" },
		{ id: "e13", description: "猫咪饮食" },
	];

	test("uses a configured endpoint without inventing authorization", async () => {
		const { impl, calls } = fakeFetch(() => Response.json({ answers: { c0: { type: "noul", noul: 0.8 } } }));
		expect(
			await createJevClient({ endpoint: "http://localhost/v1/systemone", model: "local" }, impl).scoreRelevance("q", [
				"a",
			]),
		).toEqual([0.8]);
		expect(calls[0]?.url).toBe("http://localhost/v1/systemone");
		expect(new Headers(calls[0]?.init.headers).has("authorization")).toBe(false);
	});

	test("chooses an offered event or a new event, and rejects unknown or malformed answers", async () => {
		for (const choice of ["e12", "e13", NEW_EVENT_OPTION]) {
			const { impl } = fakeFetch(() =>
				Response.json({ answers: { event: { type: "choice", choice, confidence: 0.7 } } }),
			);
			expect(await createJevClient(config, impl).chooseEvent({ message: "明天几点出发", options })).toEqual({
				choice,
				confidence: 0.7,
			});
		}
		for (const answer of [
			{ type: "choice", choice: "e99", confidence: 0.9 },
			{ type: "choice", choice: null, confidence: 0.9 },
			{ type: "choice", choice: "e12", confidence: 1.1 },
			{ type: "noul", noul: 0.9 },
			undefined,
		]) {
			const { impl } = fakeFetch(() => Response.json({ answers: { event: answer } }));
			await expectJevError(
				createJevClient(config, impl).chooseEvent({ message: "明天几点出发", options }),
				"invalid_response",
			);
		}
	});

	test("returns System One option probabilities and ignores malformed distributions without rejecting the choice", async () => {
		const distributions = [
			{ e12: 0.3, e13: 0.25, new: 0.45 },
			{ e12: 0, e13: 0, new: 1 },
		];
		for (const probabilities of distributions) {
			const { impl } = fakeFetch(() =>
				Response.json({ answers: { event: { type: "choice", choice: "new", confidence: 0.2, probabilities } } }),
			);
			expect(await createJevClient(config, impl).chooseEvent({ message: "好难受", options })).toEqual({
				choice: "new",
				confidence: 0.2,
				probabilities,
			});
		}
		for (const probabilities of [
			null,
			[],
			"bad",
			{ new: 0.45, e99: 0.55 },
			{ new: 0.45, e12: -0.1 },
			{ new: 0.45, e12: 1.1 },
			{ new: 0.45, e12: "0.55" },
			{ new: Number.NaN, e12: 0.55 },
			{ new: Number.POSITIVE_INFINITY, e12: 0.55 },
		]) {
			const client = createJevClientWithTransport(async () => ({
				answers: { event: { type: "choice", choice: "new", confidence: 0.2, probabilities } },
			}));
			expect(await client.chooseEvent({ message: "好难受", options })).toEqual({
				choice: "new",
				confidence: 0.2,
			});
		}
	});

	test("scores participation in member order and rejects incomplete batches", async () => {
		const { impl, calls } = fakeFetch(() =>
			Response.json({ answers: { m1: { type: "noul", noul: 0.2 }, m0: { type: "noul", noul: 0.9 } } }),
		);
		const client = createJevClient(config, impl);
		expect(
			await client.scoreParticipation({
				event: "爬山",
				transcript: ["甲：几点出发", "乙：我养猫"],
				members: ["甲", "乙"],
			}),
		).toEqual([0.9, 0.2]);
		expect(calls).toHaveLength(1);
		expect(await client.scoreParticipation({ event: "爬山", transcript: [], members: [] })).toEqual([]);
		expect(calls).toHaveLength(1);
		const missing = fakeFetch(() => Response.json({ answers: { m0: { type: "noul", noul: 0.9 } } }));
		await expectJevError(
			createJevClient(config, missing.impl).scoreParticipation({
				event: "爬山",
				transcript: [],
				members: ["甲", "乙"],
			}),
			"invalid_response",
		);
	});
});

describe("Jev fallback", () => {
	test("all decisions recover once on primary failure; successful primary does not call fallback", async () => {
		const primary = fakeFetch(() => new Response(null, { status: 503 }));
		const local = fakeFetch(({ body }) => {
			const answers = Object.fromEntries(
				Object.entries(body.questions).map(([id, question]) => [
					id,
					question.type === "choice"
						? {
								type: "choice",
								choice: id === "event" ? "e1" : "👍",
								confidence: 0.8,
								...(id === "event" ? { probabilities: { e1: 0.8, new: 0.2 } } : {}),
							}
						: { type: "noul", noul: 0.6 },
				]),
			);
			return Response.json({ answers });
		});
		const client = withFallback(createJevClient(config, primary.impl), createJevClient(config, local.impl));
		expect(await client.chooseEvent({ message: "q", options: [{ id: "e1", description: "d" }] })).toEqual({
			choice: "e1",
			confidence: 0.8,
			probabilities: { e1: 0.8, new: 0.2 },
		});
		expect(await client.scoreRelevance("q", ["a"])).toEqual([0.6]);
		expect(await client.scoreParticipation({ event: "d", transcript: [], members: ["a"] })).toEqual([0.6]);
		expect(await client.decideQuickReaction({ text: "q", emojis: EMOJIS })).toEqual({
			emoji: "👍",
			confidence: 0.8,
			strongEmotion: 0.6,
			funny: 0.6,
		});
		expect(primary.calls).toHaveLength(4);
		expect(local.calls).toHaveLength(4);
		const unused = fakeFetch(() => {
			throw new Error("fallback must not run");
		});
		expect(
			await withFallback(createJevClient(config, local.impl), createJevClient(config, unused.impl)).scoreRelevance(
				"q",
				["a"],
			),
		).toEqual([0.6]);
		expect(unused.calls).toHaveLength(0);
	});

	test("does not hide a failing fallback", async () => {
		const primary = fakeFetch(() => new Response(null, { status: 503 }));
		const fallback = fakeFetch(() => new Response(null, { status: 401 }));
		await expectJevError(
			withFallback(createJevClient(config, primary.impl), createJevClient(config, fallback.impl)).scoreRelevance("q", [
				"a",
			]),
			"http_401",
		);
		expect(primary.calls).toHaveLength(1);
		expect(fallback.calls).toHaveLength(1);
	});
});

describe("shouldQuickReact", () => {
	const decision = { emoji: "😂", confidence: 0.5, strongEmotion: 0.3, funny: 0.8 };

	test("addressed messages use the chosen emoji regardless of scores", () => {
		expect(shouldQuickReact({ ...decision, funny: 0 }, true, 0.8)).toBe("😂");
		expect(shouldQuickReact({ ...decision, emoji: null }, true, 0.8)).toBeNull();
	});

	test("unaddressed messages react only at or above the threshold", () => {
		expect(shouldQuickReact(decision, false, 0.8)).toBe("😂");
		expect(shouldQuickReact({ ...decision, funny: 0.79 }, false, 0.8)).toBeNull();
		expect(shouldQuickReact({ ...decision, funny: 0, strongEmotion: 0.85 }, false, 0.8)).toBe("😂");
		expect(shouldQuickReact({ ...decision, emoji: null, funny: 1 }, false, 0.8)).toBeNull();
	});
});
