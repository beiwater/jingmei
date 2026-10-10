import { describe, expect, test } from "bun:test";
import { createKlineRenderer, describeKline, klineSvg, renderKlineImage } from "../src/media/kline-image.ts";
import { type Candle, fetchKlines, KlineError, normalizeSymbol } from "../src/tools/market-klines.ts";

const DAY = 86_400_000;
const START = Date.UTC(2026, 0, 1);

/** Binance row: [openTime, open, high, low, close, volume, ...] with prices as strings. */
const row = (i: number, open: number, close: number) => [
	START + i * DAY,
	String(open),
	String(Math.max(open, close) + 5),
	String(Math.min(open, close) - 5),
	String(close),
	"1234.5",
	START + (i + 1) * DAY - 1,
	"0",
	0,
	"0",
	"0",
	"0",
];
const candles: Candle[] = [
	{ time: START, open: 100, high: 112, low: 98, close: 110, volume: 10 },
	{ time: START + DAY, open: 110, high: 111, low: 95, close: 96, volume: 20 },
	{ time: START + 2 * DAY, open: 96, high: 125, low: 96, close: 120, volume: 30 },
];

function fakeBinance(respond: (url: URL) => Response | Promise<Response>) {
	const requests: Array<{ url: URL; init?: RequestInit }> = [];
	const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = new URL(String(input));
		requests.push({ url, ...(init ? { init } : {}) });
		return respond(url);
	}) as unknown as typeof fetch;
	return { fetchImpl, requests };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe("market klines", () => {
	test("normalizes pair spellings and rejects everything else", () => {
		expect(normalizeSymbol(" btc/usdt ")).toBe("BTCUSDT");
		expect(normalizeSymbol("eth-usdt")).toBe("ETHUSDT");
		for (const bad of ["BTC", "BTC USDT", "../etc", "BTCUSDT&limit=1", "", "A".repeat(21)])
			expect(normalizeSymbol(bad)).toBeNull();
	});

	test("asks only the fixed public host and returns numeric candles, oldest first", async () => {
		const f = fakeBinance(() => json([row(0, 100, 110), row(1, 110, 96)]));
		const result = await fetchKlines("btc/usdt", "1d", 30, f.fetchImpl);
		expect(result).toEqual([
			{ time: START, open: 100, high: 115, low: 95, close: 110, volume: 1234.5 },
			{ time: START + DAY, open: 110, high: 115, low: 91, close: 96, volume: 1234.5 },
		]);
		expect(f.requests).toHaveLength(1);
		expect(f.requests[0]!.url.origin).toBe("https://data-api.binance.vision");
		expect(Object.fromEntries(f.requests[0]!.url.searchParams)).toEqual({
			symbol: "BTCUSDT",
			interval: "1d",
			limit: "30",
		});
		// A redirect must not carry the request to another host.
		expect(f.requests[0]!.init?.redirect).toBe("error");
	});

	test("a malformed symbol never reaches the network", async () => {
		const f = fakeBinance(() => json([]));
		await expect(fetchKlines("BTC&x=1", "1d", 30, f.fetchImpl)).rejects.toMatchObject({ code: "invalid_symbol" });
		expect(f.requests).toEqual([]);
	});

	test("maps upstream failures to stable error codes", async () => {
		const failing = (respond: () => Response | Promise<Response>) =>
			fetchKlines("BTCUSDT", "1d", 30, fakeBinance(respond).fetchImpl).catch((error: unknown) => error);
		expect(await failing(() => json({ code: -1121, msg: "Invalid symbol." }, 400))).toMatchObject({
			code: "invalid_symbol",
		});
		for (const respond of [
			() => json({}, 500),
			() => json({ not: "rows" }),
			() => json([row(0, 1, 2)]),
			() => json([row(0, 1, 2), ["x", "1", "1", "1", "1", "1"]]),
			() => new Response("<html>", { status: 200 }),
			() => {
				throw new Error("network down");
			},
		])
			expect(await failing(respond)).toBeInstanceOf(KlineError);
		expect(await failing(() => json({}, 500))).toMatchObject({ code: "fetch_failed" });
	});
});

describe("kline image", () => {
	test("renders a 1600x1000 PNG and describes the chart from the data", async () => {
		const image = await renderKlineImage("BTCUSDT", "1d", candles);
		expect([...image.data.slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
		const header = new DataView(image.data.buffer, image.data.byteOffset);
		expect([header.getUint32(16), header.getUint32(20)]).toEqual([1600, 1000]);
		expect(image.contentType).toBe("image/png");
		expect(image.caption).toBe("📈 BTCUSDT 日线 · 最新 120.00 · 近 3 根 +20.00%");
		expect(describeKline("X", "1h", [candles[1]!, candles[0]!])).toEndWith("近 2 根 +0.00%");
	});

	test("rising candles are red and falling ones green; volume bars follow the same colours", async () => {
		const svg = await klineSvg("BTCUSDT", "1d", candles);
		expect(svg).toContain("#e0443e");
		expect(svg).toContain("#1fa67a");
		const falling = await klineSvg("BTCUSDT", "1d", [candles[1]!, { ...candles[1]!, time: START + 3 * DAY }]);
		expect(falling).not.toContain("#e0443e");
	});

	test("a flat market and tiny prices still render", async () => {
		const flat = (time: number): Candle => ({
			time,
			open: 0.00001234,
			high: 0.00001234,
			low: 0.00001234,
			close: 0.00001234,
			volume: 0,
		});
		const image = await renderKlineImage("SHIBUSDT", "15m", [flat(START), flat(START + 900_000)]);
		expect(image.data.byteLength).toBeGreaterThan(1000);
		expect(image.caption).toContain("最新 0.00001234");
	});

	test("the renderer fetches, then draws; a bad symbol fails before any request", async () => {
		const f = fakeBinance(() => json([row(0, 100, 110), row(1, 110, 120)]));
		const render = createKlineRenderer(f.fetchImpl);
		const image = await render({ symbol: "eth/usdt", interval: "4h", limit: 2 });
		expect(image.caption).toStartWith("📈 ETHUSDT 4小时");
		expect(f.requests[0]!.url.searchParams.get("limit")).toBe("2");
		await expect(render({ symbol: "nope", interval: "1d" })).rejects.toMatchObject({ code: "invalid_symbol" });
		expect(f.requests).toHaveLength(1);
	});
});
