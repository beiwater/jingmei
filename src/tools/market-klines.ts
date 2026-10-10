import { readBoundedBody } from "../net/read-bounded-body.ts";

/** Binance's market-data-only mirror: public, keyless, and not geo-blocked like api.binance.com. */
const KLINES_URL = "https://data-api.binance.vision/api/v3/klines";
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 256 * 1024;

export const KLINE_INTERVALS = ["15m", "1h", "4h", "1d", "1w"] as const;
export type KlineInterval = (typeof KLINE_INTERVALS)[number];
export const KLINE_DEFAULT_LIMIT = 60;
export const KLINE_MAX_LIMIT = 120;

export interface Candle {
	/** Open time, Unix ms. */
	time: number;
	open: number;
	high: number;
	low: number;
	close: number;
	volume: number;
}

export type KlineErrorCode = "invalid_symbol" | "fetch_failed";

export class KlineError extends Error {
	constructor(readonly code: KlineErrorCode) {
		super(`Kline request failed: ${code}`);
		this.name = "KlineError";
	}
}

/** `BTC/USDT`, `btc-usdt` and `BTCUSDT` are the same pair; anything else is not a symbol. */
export function normalizeSymbol(input: string): string | null {
	const symbol = input.trim().replace(/[/_-]/g, "").toUpperCase();
	return /^[A-Z0-9]{5,20}$/.test(symbol) ? symbol : null;
}

function candleFrom(row: unknown): Candle | null {
	if (!Array.isArray(row) || row.length < 6) return null;
	const [time, open, high, low, close, volume] = row.slice(0, 6).map(Number) as [
		number,
		number,
		number,
		number,
		number,
		number,
	];
	return [time, open, high, low, close, volume].every(Number.isFinite)
		? { time, open, high, low, close, volume }
		: null;
}

/** The latest `limit` candles of a spot pair, oldest first. */
export async function fetchKlines(
	symbol: string,
	interval: KlineInterval,
	limit: number,
	fetchImpl: typeof fetch = fetch,
): Promise<Candle[]> {
	const pair = normalizeSymbol(symbol);
	if (!pair) throw new KlineError("invalid_symbol");
	const url = `${KLINES_URL}?${new URLSearchParams({ symbol: pair, interval, limit: String(limit) })}`;
	let response: Response;
	let body: Uint8Array | null;
	try {
		response = await fetchImpl(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS), redirect: "error" });
		body = await readBoundedBody(response, MAX_RESPONSE_BYTES);
	} catch {
		throw new KlineError("fetch_failed");
	}
	// Binance answers an unknown pair with HTTP 400 (code -1121).
	if (response.status === 400) throw new KlineError("invalid_symbol");
	if (!response.ok || !body) throw new KlineError("fetch_failed");
	let rows: unknown;
	try {
		rows = JSON.parse(new TextDecoder().decode(body));
	} catch {
		throw new KlineError("fetch_failed");
	}
	const candles = Array.isArray(rows) ? rows.map(candleFrom) : [];
	if (candles.length < 2 || candles.some((candle) => candle === null)) throw new KlineError("fetch_failed");
	return candles as Candle[];
}
