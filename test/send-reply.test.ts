import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { type Tool, validateToolArguments } from "@earendil-works/pi-ai";
import {
	type ActiveTurn,
	createSendReplyTool,
	type ReplyPart,
	type ReplySources,
	type ToolScope,
	isLeak,
	type Withheld,
} from "../src/core/tools.ts";
import type { PlatformTransport } from "../src/core/types.ts";
import { TextImageError } from "../src/media/text-image.ts";
import { AntigravityImageError } from "../src/tools/antigravity-image.ts";

type Send = Parameters<PlatformTransport["sendMessage"]>[0];

const restores: Array<() => void> = [];
afterEach(() => {
	for (const restore of restores.splice(0)) restore();
});

/** Fish Audio is the only network the tool may touch; every request is answered with three MP3 bytes. */
function fakeTts(onRequest: () => void | Promise<void> = () => {}) {
	const fetch = spyOn(globalThis, "fetch").mockImplementation((async (input: string | URL | Request) => {
		if (String(input) !== "https://api.fish.audio/v1/tts") throw new Error("unexpected network request");
		await onRequest();
		return new Response(new Uint8Array([73, 68, 51]), { headers: { "content-type": "audio/mpeg" } });
	}) as unknown as typeof globalThis.fetch);
	restores.push(() => fetch.mockRestore());
	return fetch;
}

function setup(
	options: {
		sources?: ReplySources;
		send?: (input: Send, attempt: number) => Promise<{ id: string }>;
		audit?: (text: string) => Promise<Withheld | null>;
	} = {},
) {
	const sends: Send[] = [];
	const recorded: Array<{ id: string; content: string; source: string; replyTo?: string }> = [];
	const audits: string[] = [];
	const turn: ActiveTurn = {
		spaceId: "telegram:-100",
		authorId: "7",
		sourceChannelId: "-100",
		sourceMessageId: "42",
		query: "画个抛物面",
		visibleMemberIds: new Set(),
		memoryRecallCount: 0,
		historyLookupCount: 0,
		replyToMessageId: "42",
		audit: async (text) => {
			audits.push(text);
			return options.audit?.(text) ?? null;
		},
		reply: { status: "idle" },
	};
	let attempts = 0;
	const scope: ToolScope = {
		personaId: "luna",
		transport: {
			platform: "telegram",
			sendMessage: async (input: Send) => {
				attempts++;
				const sent = options.send ? await options.send(input, attempts) : { id: String(100 + attempts) };
				sends.push(input);
				return sent;
			},
		} as unknown as PlatformTransport,
		spaceId: "telegram:-100",
		channelId: "-100",
		getTurn: () => turn,
		recordSentMessage: (id, content, source, replyTo) =>
			recorded.push({ id, content, source, ...(replyTo ? { replyTo } : {}) }),
	};
	const tool = createSendReplyTool(scope, options.sources ?? {});
	const run = (parts: ReplyPart[], signal?: AbortSignal) => tool.execute("call", { parts }, signal);
	return { turn, tool, run, sends, recorded, audits, attempts: () => attempts };
}

const generated = async () => ({ data: new Uint8Array([1]), contentType: "image/jpeg" as const });
const voice = { apiKey: "fixture", referenceId: "fixture", model: "s2.1-pro-free" as const };
const rendered = async () => ({ data: new Uint8Array([2]), contentType: "image/png" as const });

describe("send_reply", () => {
	test("sends every part in order; only the first replies to the trigger; all are recorded", async () => {
		fakeTts();
		const f = setup({ sources: { voice, generateImage: generated } });
		const result = await f.run([
			{ type: "image", prompt: "a paraboloid z = x^2 + y^2", caption: "抛物面" },
			{ type: "text", text: "这是一个开口向上的抛物面。" },
			{ type: "voice", text: "简单说，就是一个碗。" },
		]);
		expect(result).toMatchObject({ terminate: true, details: { messageIds: ["101", "102", "103"] } });
		expect(result).not.toHaveProperty("isError");
		expect(f.sends.map((send) => [send.content, send.replyToMessageId, send.attachments?.[0]?.contentType])).toEqual([
			["抛物面", "42", "image/jpeg"],
			["这是一个开口向上的抛物面。", undefined, undefined],
			["🎙️ 简单说，就是一个碗。", undefined, "audio/mpeg"],
		]);
		expect(f.recorded).toEqual([
			{ id: "101", content: "抛物面", source: "42", replyTo: "42" },
			{ id: "102", content: "这是一个开口向上的抛物面。", source: "42" },
			{ id: "103", content: "🎙️ 简单说，就是一个碗。", source: "42" },
		]);
		expect(f.turn.reply).toEqual({ status: "sent", messageId: "101" });
		// The audit sees exactly what the chat will read as the persona's words.
		expect(f.audits).toEqual(["这是一个开口向上的抛物面。\n\n简单说，就是一个碗。"]);

		const again = await f.run([{ type: "text", text: "再说一句" }]);
		expect(again).toMatchObject({ isError: true, details: { error: "reply_already_sent" } });
		expect(f.sends).toHaveLength(3);
	});

	test("slow parts are prepared in parallel and nothing is sent before all are ready", async () => {
		let ttsStarted!: () => void;
		const ttsRequested = new Promise<void>((resolve) => {
			ttsStarted = resolve;
		});
		const events: string[] = [];
		fakeTts(() => {
			events.push("tts");
			ttsStarted();
		});
		const f = setup({
			sources: {
				voice,
				// The drawing only finishes once speech synthesis has started: sequential preparation would hang.
				generateImage: async () => {
					events.push("draw");
					await ttsRequested;
					events.push("drawn");
					return generated();
				},
			},
			send: async (input, attempt) => {
				events.push(`send:${input.content}`);
				return { id: String(attempt) };
			},
		});
		await f.run([
			{ type: "image", prompt: "a cat" },
			{ type: "voice", text: "喵" },
		]);
		expect(events).toEqual(["draw", "tts", "drawn", "send:🎨", "send:🎙️ 喵"]);
	});

	test("per-kind caps reject the whole reply before any work", async () => {
		let draws = 0;
		const f = setup({
			sources: {
				generateImage: async () => {
					draws++;
					return generated();
				},
				reactionImages: {},
				textImage: { render: rendered, thresholdChars: 300 },
			},
		});
		for (const parts of [
			[
				{ type: "image", prompt: "a" },
				{ type: "image", prompt: "b" },
			],
			[
				{ type: "reaction_image", asset_id: "hello" },
				{ type: "reaction_image", asset_id: "laugh" },
			],
			[
				{ type: "text_image", markdown: "# a" },
				{ type: "text_image", markdown: "# b" },
			],
		] satisfies ReplyPart[][]) {
			expect(await f.run(parts)).toMatchObject({ isError: true, details: { error: "too_many_parts" } });
		}
		expect(draws).toBe(0);
		expect(f.audits).toEqual([]);
		expect(f.sends).toEqual([]);
		expect(f.turn.reply).toEqual({ status: "idle" });
	});

	test("the schema caps the total and offers only the part kinds this persona can send", () => {
		const call = (tool: { name: string; description: string; parameters: unknown }, parts: unknown[]) =>
			validateToolArguments(tool as Tool, { type: "toolCall", id: "call", name: tool.name, arguments: { parts } });
		const text = (n: number) => Array.from({ length: n }, (_, i) => ({ type: "text", text: `第 ${i + 1} 段` }));
		const plain = setup().tool;
		expect(call(plain, text(4)).parts).toHaveLength(4);
		expect(() => call(plain, text(5))).toThrow();
		expect(() => call(plain, [])).toThrow();
		for (const part of [
			{ type: "image", prompt: "a cat" },
			{ type: "voice", text: "hi" },
			{ type: "reaction_image", asset_id: "hello" },
			{ type: "text_image", markdown: "# hi" },
		])
			expect(() => call(plain, [part])).toThrow();

		const full = setup({
			sources: {
				voice,
				generateImage: generated,
				reactionImages: {},
				textImage: { render: rendered, thresholdChars: 300 },
			},
		}).tool;
		expect(
			call(full, [
				{ type: "image", prompt: "a cat" },
				{ type: "voice", text: "hi" },
				{ type: "reaction_image", asset_id: "hello" },
				{ type: "text_image", markdown: "# hi" },
			]).parts,
		).toHaveLength(4);
		expect(() => call(full, [{ type: "reaction_image", asset_id: "../../etc/passwd" }])).toThrow();
	});

	test("a part that cannot be prepared sends nothing and leaves the turn free", async () => {
		let draws = 0;
		const f = setup({
			sources: {
				generateImage: async () => {
					draws++;
					throw new AntigravityImageError("rate_limited");
				},
				textImage: {
					render: async () => {
						throw new TextImageError("too_large");
					},
					thresholdChars: 300,
				},
			},
		});
		const result = await f.run([
			{ type: "text", text: "先看图" },
			{ type: "image", prompt: "a cat" },
			{ type: "text_image", markdown: "# 推导" },
		]);
		expect(result).toMatchObject({ isError: true, details: { error: "rate_limited" } });
		expect(result).not.toHaveProperty("terminate");
		const text = JSON.stringify(result.content);
		expect(text).toContain("Part 2 (image) failed: rate_limited");
		expect(text).toContain("Part 3 (text_image) failed: too_large");
		expect(f.sends).toEqual([]);
		expect(f.recorded).toEqual([]);
		expect(f.turn.reply).toEqual({ status: "idle" });

		// The model may try again (for example without the picture).
		expect(await f.run([{ type: "text", text: "画不出来，口头说吧" }])).toMatchObject({ terminate: true });
		expect(f.sends.map((send) => send.content)).toEqual(["画不出来，口头说吧"]);
		expect(draws).toBe(1);
	});

	test("an unreadable reaction image fails preparation and permits another attempt", async () => {
		const f = setup({ sources: { reactionImages: {} } });
		const read = fs.readFileSync as (...args: unknown[]) => unknown;
		const missing = spyOn(fs, "readFileSync").mockImplementation(((path: unknown, ...args: unknown[]) => {
			if (String(path).endsWith("/assets/reactions/hello.png")) throw new Error("fixture missing image");
			return read(path, ...args);
		}) as typeof fs.readFileSync);
		restores.push(() => missing.mockRestore());
		for (const _attempt of ["first", "retry"]) {
			expect(await f.run([{ type: "reaction_image", asset_id: "hello" }])).toMatchObject({
				isError: true,
				details: { error: "prepare_failed" },
			});
			expect(f.turn.reply).toEqual({ status: "idle" });
		}
		expect(f.attempts()).toBe(0);
	});

	test("a send failure mid-way keeps the earlier parts, stops the rest and ends the turn", async () => {
		const f = setup({
			send: async (_input, attempt) => {
				if (attempt === 2) throw new Error("platform down");
				return { id: String(100 + attempt) };
			},
		});
		const result = await f.run([
			{ type: "text", text: "第一段" },
			{ type: "text", text: "第二段" },
			{ type: "text", text: "第三段" },
		]);
		expect(result).toMatchObject({
			isError: true,
			terminate: true,
			details: { messageIds: ["101"], error: "send_failed" },
		});
		expect(JSON.stringify(result.content)).toContain("part 2 (text) failed");
		expect(f.attempts()).toBe(2);
		expect(f.sends.map((send) => send.content)).toEqual(["第一段"]);
		expect(f.recorded.map((row) => row.id)).toEqual(["101"]);
		expect(f.turn.reply).toEqual({ status: "sent", messageId: "101" });
	});

	test("a failed first send leaves nothing in the chat and the turn free for a text reply", async () => {
		const f = setup({
			send: async () => {
				throw new Error("platform down");
			},
		});
		const result = await f.run([
			{ type: "text", text: "第一段" },
			{ type: "text", text: "第二段" },
		]);
		expect(result).toMatchObject({ isError: true, details: { error: "send_failed" } });
		expect(result).not.toHaveProperty("terminate");
		expect(f.attempts()).toBe(1);
		expect(f.recorded).toEqual([]);
		expect(f.turn.reply).toEqual({ status: "idle" });
	});

	test("an aborted turn sends no further parts", async () => {
		const controller = new AbortController();
		const f = setup({
			send: async (_input, attempt) => {
				controller.abort();
				return { id: String(attempt) };
			},
		});
		const result = await f.run(
			[
				{ type: "text", text: "第一段" },
				{ type: "text", text: "第二段" },
			],
			controller.signal,
		);
		expect(result).toMatchObject({ terminate: true, details: { messageIds: ["1"] } });
		expect(f.attempts()).toBe(1);
	});

	test("text parts over the text-image threshold are refused before any work", async () => {
		const f = setup({ sources: { textImage: { render: rendered, thresholdChars: 10 } } });
		const result = await f.run([
			{ type: "text", text: "短" },
			{ type: "text", text: "这一段明显超过了十个字的上限" },
		]);
		expect(result).toMatchObject({ isError: true, details: { error: "text_too_long" } });
		expect(JSON.stringify(result.content)).toContain("Part 2");
		expect(f.audits).toEqual([]);
		expect(f.sends).toEqual([]);
		expect(f.turn.reply).toEqual({ status: "idle" });
	});

	test("the reply audit withholds the whole reply: nothing is prepared or sent and the turn ends", async () => {
		let draws = 0;
		const drawing = async () => {
			draws++;
			return generated();
		};
		const audited = setup({ sources: { generateImage: drawing }, audit: async () => ({ reason: "audit" }) });
		const result = await audited.run([
			{ type: "image", prompt: "a cat" },
			{ type: "text", text: "我先规划一下怎么回答" },
		]);
		expect(result).toMatchObject({ terminate: true, details: { error: "withheld" } });
		expect(audited.turn.reply).toEqual({ status: "withheld", reason: "audit" });

		// Internal markers anywhere visible (here a caption) go to the audit even without spoken text.
		const leaked = setup({
			sources: { generateImage: drawing },
			audit: async (text) => (isLeak(text) ? { reason: "leak_pattern" } : null),
		});
		await leaked.run([{ type: "image", prompt: "a cat", caption: "§E3 的图" }]);
		expect(leaked.audits).toEqual(["§E3 的图"]);
		expect(leaked.turn.reply).toEqual({ status: "withheld", reason: "leak_pattern" });

		expect(draws).toBe(0);
		expect([...audited.sends, ...leaked.sends]).toEqual([]);
	});

	test("a rejection with a rewrite hint keeps the turn open so a second send_reply goes out", async () => {
		let rejections = 1;
		const f = setup({
			audit: async () => (rejections-- > 0 ? { reason: "audit", rewrite: "只留要对群友说的话。" } : null),
		});
		const first = await f.run([{ type: "text", text: "我先列个计划" }]);
		expect(first).toMatchObject({ isError: true, details: { error: "withheld" } });
		expect(first).not.toHaveProperty("terminate");
		expect(JSON.stringify(first.content)).toContain("只留要对群友说的话。");
		expect(f.turn.reply).toEqual({ status: "idle" });
		expect(f.sends).toEqual([]);

		await f.run([{ type: "text", text: "火锅！" }]);
		expect(f.audits).toEqual(["我先列个计划", "火锅！"]);
		expect(f.sends.map((send) => send.content)).toEqual(["火锅！"]);
	});

	test("a text image without a caption is stored under a one-line title taken from its Markdown", async () => {
		const f = setup({ sources: { textImage: { render: rendered, thresholdChars: 300 } } });
		await f.run([{ type: "text_image", markdown: "\n## **勾股定理** 的证明\n\n正文" }]);
		expect(f.sends[0]?.attachments?.[0]).toMatchObject({ name: "text.png", contentType: "image/png" });
		const bare = setup({ sources: { textImage: { render: rendered, thresholdChars: 300 } } });
		await bare.run([{ type: "text_image", markdown: "$$$$" }]);
		expect([...f.recorded, ...bare.recorded].map((row) => row.content)).toEqual(["📄 勾股定理 的证明", "📄"]);
	});

	test("media-only replies skip the naturalness audit", async () => {
		const f = setup({ sources: { reactionImages: {} }, audit: async () => ({ reason: "audit" }) });
		await f.run([{ type: "reaction_image", asset_id: "hello" }]);
		expect(f.audits).toEqual([]);
		expect(f.sends).toMatchObject([{ content: "👋", replyToMessageId: "42" }]);
	});
});
