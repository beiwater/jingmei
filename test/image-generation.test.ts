import { describe, expect, test } from "bun:test";
import { type ActiveTurn, createImageGenerationTool, type ToolScope } from "../src/core/tools.ts";
import type { PlatformTransport } from "../src/core/types.ts";
import { AntigravityImageError, generateAntigravityImage } from "../src/tools/antigravity-image.ts";

const CREDENTIAL = JSON.stringify({ token: "unit-test-token", projectId: "unit-project" });
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64");
const JPEG = Buffer.from([0xff, 0xd8, 0xff]).toString("base64");

function sse(...events: unknown[]): Response {
	return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
		headers: { "content-type": "text/event-stream" },
	});
}

function parts(...items: unknown[]) {
	return { response: { candidates: [{ content: { role: "model", parts: items } }] } };
}

describe("Antigravity image client", () => {
	test("sends the prompt with the stored project and returns the final image", async () => {
		let request: Request | undefined;
		const image = await generateAntigravityImage(CREDENTIAL, "  a cat waving  ", {
			model: "gemini-3.1-flash-image",
			aspectRatio: "16:9",
			fetch: async (input, init) => {
				request = new Request(String(input), init);
				return sse(
					parts(
						{ text: "drafting", thought: true },
						{ inlineData: { mimeType: "image/png", data: PNG }, thought: true },
					),
					parts({ text: "Here you go" }),
					parts({ inlineData: { mimeType: "image/jpeg", data: JPEG } }),
				);
			},
		});

		expect(image.contentType).toBe("image/jpeg");
		expect(Array.from(image.data)).toEqual([0xff, 0xd8, 0xff]);
		expect(request?.url).toBe("https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse");
		expect(request?.headers.get("authorization")).toBe("Bearer unit-test-token");
		const body = await request?.json();
		expect(body).toMatchObject({
			project: "unit-project",
			model: "gemini-3.1-flash-image",
			requestType: "image_gen",
			request: {
				contents: [{ role: "user", parts: [{ text: "a cat waving" }] }],
				generationConfig: { candidateCount: 1, imageConfig: { aspectRatio: "16:9" } },
			},
		});
	});

	test("rejects unusable credentials and prompts before any request", async () => {
		let requested = false;
		const fetcher = async () => {
			requested = true;
			return new Response();
		};
		for (const credential of ["bare-token", JSON.stringify({ token: "t" }), "{"])
			await expect(generateAntigravityImage(credential, "cat", { fetch: fetcher })).rejects.toMatchObject({
				code: "invalid_credential",
			});
		await expect(generateAntigravityImage(CREDENTIAL, "   ", { fetch: fetcher })).rejects.toMatchObject({
			code: "invalid_input",
		});
		await expect(generateAntigravityImage(CREDENTIAL, "x".repeat(2001), { fetch: fetcher })).rejects.toMatchObject({
			code: "invalid_input",
		});
		expect(requested).toBe(false);
	});

	test("classifies provider failures without exposing tokens or bodies", async () => {
		const quota = generateAntigravityImage(CREDENTIAL, "cat", {
			fetch: async () => new Response("RESOURCE_EXHAUSTED unit-test-token", { status: 429 }),
		});
		await expect(quota).rejects.toMatchObject({ code: "rate_limited" });

		let error: unknown;
		try {
			await generateAntigravityImage(CREDENTIAL, "cat", {
				fetch: async () => new Response("private detail unit-test-token", { status: 403 }),
			});
		} catch (caught) {
			error = caught;
		}
		expect(error).toBeInstanceOf(AntigravityImageError);
		expect((error as Error).message).toBe("Antigravity image generation failed: http_error");
	});

	test("reports a text-only or blocked answer as no image", async () => {
		await expect(
			generateAntigravityImage(CREDENTIAL, "cat", {
				fetch: async () =>
					sse(parts({ text: "I can't draw that." }), parts({ inlineData: { mimeType: "image/webp", data: PNG } })),
			}),
		).rejects.toMatchObject({ code: "no_image" });
		await expect(
			generateAntigravityImage(CREDENTIAL, "cat", { fetch: async () => new Response("not sse") }),
		).rejects.toMatchObject({ code: "invalid_response" });
	});

	test("rejects oversized images and maps aborts to timeout", async () => {
		const huge = "A".repeat(14 * 1024 * 1024);
		await expect(
			generateAntigravityImage(CREDENTIAL, "cat", {
				fetch: async () => sse(parts({ inlineData: { mimeType: "image/png", data: huge } })),
			}),
		).rejects.toMatchObject({ code: "image_too_large" });
		await expect(
			generateAntigravityImage(CREDENTIAL, "cat", {
				timeoutMs: 5,
				fetch: async (_input, init) =>
					await new Promise<Response>((_resolve, reject) => {
						init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), {
							once: true,
						});
					}),
			}),
		).rejects.toMatchObject({ code: "timeout" });
	});
});

describe("generate_image tool", () => {
	function setup(sendMessage: PlatformTransport["sendMessage"]) {
		const turn: ActiveTurn = {
			spaceId: "telegram:-100",
			authorId: "7",
			sourceChannelId: "-100",
			sourceMessageId: "42",
			query: "画只猫",
			visibleMemberIds: new Set(),
			memoryRecallCount: 0,
			historyLookupCount: 0,
			replyToMessageId: "42",
			reply: { status: "idle" },
		};
		const recorded: string[] = [];
		const scope: ToolScope = {
			personaId: "luna",
			transport: { sendMessage } as PlatformTransport,
			spaceId: "telegram:-100",
			channelId: "-100",
			getTurn: () => turn,
			recordSentMessage: (messageId) => recorded.push(messageId),
		};
		return { turn, scope, recorded };
	}

	test("sends one generated image as the turn's reply", async () => {
		const sends: Parameters<PlatformTransport["sendMessage"]>[0][] = [];
		const { turn, scope, recorded } = setup(async (input) => {
			sends.push(input);
			return { id: "99" };
		});
		const tool = createImageGenerationTool(scope, async () => ({
			data: new Uint8Array([1]),
			contentType: "image/jpeg",
		}));

		const result = await tool.execute("call", { prompt: "a cat", caption: "  喵  " });
		expect(result).toMatchObject({ terminate: true });
		expect(sends).toHaveLength(1);
		expect(sends[0]).toMatchObject({ content: "喵", replyToMessageId: "42" });
		expect(sends[0]?.attachments?.[0]).toMatchObject({ name: "generated.jpg", contentType: "image/jpeg" });
		expect(turn.reply).toEqual({ status: "sent", kind: "image", messageId: "99" });
		expect(recorded).toEqual(["99"]);

		const second = await tool.execute("call", { prompt: "another" });
		expect(second).toMatchObject({ isError: true, details: { error: "reply_already_sent" } });
		expect(sends).toHaveLength(1);
	});

	test("a failed generation leaves the turn free for a text reply", async () => {
		const { turn, scope } = setup(async () => {
			throw new Error("must not send");
		});
		const tool = createImageGenerationTool(scope, async () => {
			throw new AntigravityImageError("rate_limited");
		});

		const result = await tool.execute("call", { prompt: "a cat" });
		expect(result).toMatchObject({ isError: true, details: { error: "rate_limited" } });
		expect(turn.reply).toEqual({ status: "idle" });
	});
});
