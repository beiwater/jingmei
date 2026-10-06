import { describe, expect, test } from "bun:test";
import type { HistoryHit, HistoryLine, MessageIndex } from "../src/core/message-index.ts";
import { type ActiveTurn, createHistoryTools, type ToolScope } from "../src/core/tools.ts";

const SPACE = "discord:guild-a";
const CHANNEL = "chan-a";

function line(id: number, overrides: Partial<HistoryLine> = {}): HistoryLine {
	return {
		messageId: `m${id}`,
		timestamp: Date.UTC(2026, 0, 1, 12, 0, id),
		authorName: "Alice",
		isBot: false,
		content: `message ${id}`,
		replyToMessageId: null,
		...overrides,
	};
}

function hit(anchorId: number, contextSize = 5): HistoryHit {
	const context = Array.from({ length: contextSize }, (_, i) => line(anchorId * 10 + i));
	const anchor = context[Math.floor(contextSize / 2)] as HistoryLine;
	return { anchor, context };
}

function setup(hits: HistoryHit[] = [hit(1)]) {
	const calls = {
		related: [] as { key: unknown; limit: number }[],
		search: [] as { scope: unknown; query: string; range: { from?: number; to?: number } }[],
	};
	const index = {
		related(key: unknown, limit: number) {
			calls.related.push({ key, limit });
			return hits;
		},
		async search(scope: unknown, query: string, range: { from?: number; to?: number }) {
			calls.search.push({ scope, query, range });
			return hits;
		},
	} as unknown as MessageIndex;
	const turn = { historyLookupCount: 0 } as ActiveTurn;
	const scope = { spaceId: SPACE, channelId: CHANNEL, personaId: "p", getTurn: () => turn } as unknown as ToolScope;
	const tools = createHistoryTools(scope, index);
	const byName = (name: string) => {
		const tool = tools.find((candidate) => candidate.name === name);
		if (!tool) throw new Error(`missing tool ${name}`);
		return tool.execute as unknown as (
			id: string,
			params: Record<string, string>,
		) => Promise<{ content: { text: string }[]; details: { error?: string; hits?: number }; isError?: true }>;
	};
	return { calls, turn, scope, related: byName("related_messages"), search: byName("search_history") };
}

describe("history tools", () => {
	test("both tools draw on one three-lookup budget per turn and refuse without a turn", async () => {
		const { turn, related, search } = setup();
		await related("a", { message_id: "m1" });
		await search("b", { query: "x" });
		await related("c", { message_id: "m2" });
		expect(turn.historyLookupCount).toBe(3);
		for (const result of [await search("d", { query: "x" }), await related("e", { message_id: "m1" })]) {
			expect(result.isError).toBe(true);
			expect(result.details.error).toBe("history_lookup_limit_reached");
		}
		expect(turn.historyLookupCount).toBe(3);

		const orphan = setup();
		const noTurnScope = { ...orphan.scope, getTurn: () => undefined } as ToolScope;
		const index = { related: () => [], search: async () => [] } as unknown as MessageIndex;
		const [relatedTool] = createHistoryTools(noTurnScope, index);
		const refused = await (
			(relatedTool as NonNullable<typeof relatedTool>).execute as unknown as (
				id: string,
				p: { message_id: string },
			) => Promise<{ details: { error?: string } }>
		)("f", { message_id: "m1" });
		expect(refused.details.error).toBe("no_active_turn");
	});

	test("search_history parses dates as UTC days and ISO times exactly", async () => {
		const { calls, search } = setup();
		await search("1", { query: "q", from: "2026-03-01", to: "2026-03-01" });
		await search("2", { query: "q", from: "2026-03-01T08:30:00Z", to: "2026-03-01T18:00:00+08:00" });
		await search("3", { query: "q", to: "2026-03-02T10:00:00" });
		expect(calls.search[0]?.range).toEqual({ from: Date.UTC(2026, 2, 1), to: Date.UTC(2026, 2, 2) - 1 });
		expect(calls.search[1]?.range).toEqual({ from: Date.UTC(2026, 2, 1, 8, 30), to: Date.UTC(2026, 2, 1, 10, 0) });
		expect(calls.search[2]?.range).toEqual({ to: Date.UTC(2026, 2, 2, 10, 0) });
	});

	test("search_history rejects invalid and reversed ranges without calling the index", async () => {
		const { calls, turn, search } = setup();
		const cases: [Record<string, string>, string][] = [
			[{ query: "q", from: "yesterday" }, "invalid_from"],
			[{ query: "q", from: "2026-02-30" }, "invalid_from"],
			[{ query: "q", to: "2026-13-01" }, "invalid_to"],
			[{ query: "q", from: "2026-03-02", to: "2026-03-01" }, "invalid_range"],
			[{ query: "q", from: "2026-03-01T10:00:00Z", to: "2026-03-01T09:00:00Z" }, "invalid_range"],
		];
		for (const [params, code] of cases) {
			turn.historyLookupCount = 0;
			const result = await search("x", params);
			expect(result.isError).toBe(true);
			expect(result.details.error).toBe(code);
		}
		expect(calls.search).toHaveLength(0);
	});

	test("lookups are confined to the tool scope's space and channel", async () => {
		const { calls, related, search } = setup();
		await related("a", { message_id: "#m7", spaceId: "discord:other", channelId: "other" });
		await search("b", { query: "q", spaceId: "discord:other", channelId: "other" });
		expect(calls.related[0]?.key).toEqual({ spaceId: SPACE, channelId: CHANNEL, messageId: "m7" });
		expect(calls.search[0]?.scope).toEqual({ spaceId: SPACE, channelId: CHANNEL });
	});

	test("output marks anchors, flattens and truncates content, and never exceeds 20 lines", async () => {
		const long = `${"长".repeat(400)}\nsecond line`;
		const first = hit(1, 3);
		first.context[1] = line(11, { content: long, isBot: true, authorName: "Bot" });
		first.anchor = first.context[1] as HistoryLine;
		const { search } = setup([first]);
		const result = await search("a", { query: "q" });
		const lines = (result.content[0]?.text ?? "").split("\n");
		expect(lines).toHaveLength(3);
		expect(lines.filter((l) => l.startsWith("★ "))).toHaveLength(1);
		expect(lines[1]).toStartWith("★ [2026-01-01T12:00:11.000Z] #m11 Bot · bot: ");
		expect(lines[1]?.endsWith(`${"长".repeat(300)}…`)).toBe(true);
		expect(lines[0]).toBe("[2026-01-01T12:00:10.000Z] #m10 Alice: message 10");

		const many = setup(Array.from({ length: 6 }, (_, i) => hit(i + 1, 5)));
		const big = (await many.related("b", { message_id: "m1" })).content[0]?.text ?? "";
		const bigLines = big.split("\n");
		expect(bigLines.length).toBeLessThanOrEqual(20);
		expect(bigLines.filter((l) => l.startsWith("★ "))).toHaveLength(3);
		expect(bigLines.filter((l) => l === "")).toHaveLength(3);
		expect(bigLines.at(-1)).toContain("更多");

		const fits = setup([hit(1, 5), hit(2, 5), hit(3, 5)]);
		const exact = (await fits.search("c", { query: "q" })).content[0]?.text ?? "";
		expect(exact.split("\n")).toHaveLength(17);
		expect(exact).not.toContain("更多");
	});

	test("no results is a short plain explanation, not an error", async () => {
		const { related, search } = setup([]);
		for (const result of [await related("a", { message_id: "m1" }), await search("b", { query: "q" })]) {
			expect(result.isError).toBeUndefined();
			expect(result.details.hits).toBe(0);
			expect(result.content[0]?.text.length).toBeGreaterThan(0);
			expect(result.content[0]?.text.split("\n")).toHaveLength(1);
		}
	});

	test("search_history never returns the asking message itself", async () => {
		const asking = hit(1);
		const older = hit(2);
		const { turn, search } = setup([asking, older]);
		turn.sourceMessageId = asking.anchor.messageId;
		const result = await search("a", { query: "q" });
		expect(result.details.hits).toBe(1);
		expect(result.content[0]?.text).toContain(
			`★ [${new Date(older.anchor.timestamp).toISOString()}] #${older.anchor.messageId}`,
		);
		expect(result.content[0]?.text).not.toContain(`★ [${new Date(asking.anchor.timestamp).toISOString()}]`);
	});

	test("index failures become a tool error instead of throwing", async () => {
		const index = {
			related: () => {
				throw new Error("boom");
			},
			search: async () => {
				throw new Error("boom");
			},
		} as unknown as MessageIndex;
		const turn = { historyLookupCount: 0 } as ActiveTurn;
		const scope = { spaceId: SPACE, channelId: CHANNEL, personaId: "p", getTurn: () => turn } as unknown as ToolScope;
		for (const tool of createHistoryTools(scope, index)) {
			const result = await (
				tool.execute as unknown as (id: string, p: Record<string, string>) => Promise<{ isError?: true }>
			)("a", {
				message_id: "m1",
				query: "q",
			});
			expect(result.isError).toBe(true);
		}
	});
});
