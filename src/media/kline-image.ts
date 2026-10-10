import {
	type Candle,
	fetchKlines,
	KLINE_DEFAULT_LIMIT,
	KlineError,
	type KlineInterval,
	normalizeSymbol,
} from "../tools/market-klines.ts";
import { niceStep } from "./plot.ts";
import { TextImageError } from "./text-image.ts";

const WIDTH = 800;
const HEIGHT = 500;
const ZOOM = 2;
/** Chinese-market convention: red up, green down. */
const UP = "#e0443e";
const DOWN = "#1fa67a";
/** resvg draws text with installed fonts only; the first family present wins per glyph. */
const FONT_FAMILY = "DejaVu Sans, Noto Sans, Arial, sans-serif";

const INTERVAL_NAMES: Record<KlineInterval, string> = {
	"15m": "15分钟",
	"1h": "1小时",
	"4h": "4小时",
	"1d": "日线",
	"1w": "周线",
};

export interface KlineImage {
	data: Uint8Array;
	contentType: "image/png";
	/** Deterministic one-line summary of the chart; this is what the chat history stores. */
	caption: string;
}

/** Fetches live candles and draws them; bound at startup, one `send_reply` part calls it. */
export type KlineRenderer = (request: {
	symbol: string;
	interval: KlineInterval;
	limit?: number;
}) => Promise<KlineImage>;

/** Enough digits to tell neighbouring prices apart for both BTC (67 123.45) and meme coins (0.00001234). */
function formatPrice(value: number): string {
	if (value >= 100) return value.toFixed(2);
	if (value >= 1) return value.toFixed(4);
	return value.toPrecision(4);
}

function formatTime(time: number, interval: KlineInterval): string {
	const iso = new Date(time).toISOString();
	return interval === "1d" || interval === "1w" ? iso.slice(0, 10) : `${iso.slice(5, 10)} ${iso.slice(11, 16)}`;
}

export function describeKline(symbol: string, interval: KlineInterval, candles: readonly Candle[]): string {
	const first = candles[0]!;
	const last = candles[candles.length - 1]!;
	const change = ((last.close - first.open) / first.open) * 100;
	return `📈 ${symbol} ${INTERVAL_NAMES[interval]} · 最新 ${formatPrice(last.close)} · 近 ${candles.length} 根 ${change >= 0 ? "+" : ""}${change.toFixed(2)}%`;
}

const LEFT = 72;
const RIGHT = 20;
const PRICE_TOP = 74;
const PRICE_HEIGHT = 270;
const VOLUME_TOP = 366;
const VOLUME_HEIGHT = 82;
/** Neighbouring time labels stay at least this many px apart. */
const LABEL_GAP = 100;

const round = (value: number) => Math.round(value * 100) / 100;
const trim = (value: number) => String(Number(value.toPrecision(6)));
const formatVolume = (value: number) => (value >= 1000 ? `${Math.round(value / 1000)}k` : trim(value));

/** Axis ticks `min, min+step, … ≥ hi`, on a 1/2/5 × 10^k step. */
function axis(lo: number, hi: number, count: number): { min: number; max: number; ticks: number[] } {
	const step = niceStep(hi - lo, count);
	const min = Math.floor(lo / step) * step;
	const ticks = Array.from({ length: Math.ceil((hi - min) / step - 1e-9) + 1 }, (_, i) => min + i * step);
	return { min, max: ticks[ticks.length - 1]!, ticks };
}

/** Candlesticks over volume bars, as an SVG string. */
export function klineSvg(symbol: string, interval: KlineInterval, candles: readonly Candle[]): string {
	const first = candles[0]!;
	const last = candles[candles.length - 1]!;
	const change = ((last.close - first.open) / first.open) * 100;
	const plotWidth = WIDTH - LEFT - RIGHT;
	const slot = plotWidth / candles.length;
	const bodyWidth = Math.min(slot * 0.7, 40);
	const x = (index: number) => round(LEFT + (index + 0.5) * slot);

	let low = Math.min(...candles.map((candle) => candle.low));
	let high = Math.max(...candles.map((candle) => candle.high));
	if (high === low) {
		// A flat market still needs a span to draw on.
		const pad = Math.abs(low) * 0.01 || 1;
		low -= pad;
		high += pad;
	}
	const price = axis(low, high, 5);
	const priceY = (value: number) =>
		round(PRICE_TOP + PRICE_HEIGHT * (1 - (value - price.min) / (price.max - price.min)));
	const volume = axis(0, Math.max(...candles.map((candle) => candle.volume)) || 1, 2);
	const volumeY = (value: number) => round(VOLUME_TOP + VOLUME_HEIGHT * (1 - value / volume.max));

	const parts: string[] = [];
	const text = (px: number, py: number, content: string, attrs: string) =>
		parts.push(`<text x="${px}" y="${py}" ${attrs}>${content}</text>`);
	const label = 'font-size="11" fill="#6b7280"';
	for (const value of price.ticks) {
		const y = priceY(value);
		parts.push(`<line x1="${LEFT}" x2="${WIDTH - RIGHT}" y1="${y}" y2="${y}" stroke="#eef0f3"/>`);
		text(LEFT - 8, y + 4, formatPrice(value), `${label} text-anchor="end"`);
	}
	for (const value of volume.ticks)
		text(LEFT - 8, volumeY(value) + 4, formatVolume(value), `${label} text-anchor="end"`);
	for (const top of [PRICE_TOP + PRICE_HEIGHT, VOLUME_TOP + VOLUME_HEIGHT])
		parts.push(`<line x1="${LEFT}" x2="${WIDTH - RIGHT}" y1="${top}" y2="${top}" stroke="#d1d5db"/>`);
	for (let i = 0; i < candles.length; i += Math.ceil(LABEL_GAP / slot))
		text(
			x(i),
			VOLUME_TOP + VOLUME_HEIGHT + 17,
			formatTime(candles[i]!.time, interval),
			`${label} text-anchor="middle"`,
		);

	candles.forEach((candle, i) => {
		const color = candle.close >= candle.open ? UP : DOWN;
		const [bodyTop, bodyBottom] = [
			priceY(Math.max(candle.open, candle.close)),
			priceY(Math.min(candle.open, candle.close)),
		];
		parts.push(
			`<line x1="${x(i)}" x2="${x(i)}" y1="${priceY(candle.high)}" y2="${priceY(candle.low)}" stroke="${color}" stroke-width="1.5"/>`,
			`<rect x="${round(x(i) - bodyWidth / 2)}" y="${bodyTop}" width="${round(bodyWidth)}" height="${Math.max(1, round(bodyBottom - bodyTop))}" fill="${color}"/>`,
			`<rect x="${round(x(i) - bodyWidth / 2)}" y="${volumeY(candle.volume)}" width="${round(bodyWidth)}" height="${round(VOLUME_TOP + VOLUME_HEIGHT - volumeY(candle.volume))}" fill="${color}"/>`,
		);
	});

	return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}" font-family="${FONT_FAMILY}"><rect width="${WIDTH}" height="${HEIGHT}" fill="#ffffff"/><text x="16" y="32" font-size="18" font-weight="bold" fill="#1f2328">${symbol}  ${interval}</text><text x="16" y="54" font-size="13" fill="${change >= 0 ? UP : DOWN}">${formatPrice(last.close)}  ${change >= 0 ? "+" : ""}${change.toFixed(2)}%  ·  UTC</text>${parts.join("")}</svg>`;
}

async function toPng(svg: string): Promise<Uint8Array> {
	const { Resvg } = await import("@resvg/resvg-js");
	return new Resvg(svg, {
		fitTo: { mode: "zoom", value: ZOOM },
		font: { loadSystemFonts: true, defaultFontFamily: "DejaVu Sans" },
	})
		.render()
		.asPng();
}

/** Draws given candles; split from the fetch so tests and the startup probe need no network. */
export async function renderKlineImage(
	symbol: string,
	interval: KlineInterval,
	candles: readonly Candle[],
): Promise<KlineImage> {
	try {
		const data = await toPng(klineSvg(symbol, interval, candles));
		return { data, contentType: "image/png", caption: describeKline(symbol, interval, candles) };
	} catch {
		throw new TextImageError("render_failed");
	}
}

/** Throws when resvg cannot load; draws two synthetic candles. */
export async function probeKlineRender(): Promise<void> {
	const candle = (time: number, open: number, close: number): Candle => ({
		time,
		open,
		high: Math.max(open, close) + 1,
		low: Math.min(open, close) - 1,
		close,
		volume: 1,
	});
	await renderKlineImage("PROBEUSDT", "1d", [candle(0, 10, 12), candle(86_400_000, 12, 11)]);
}

export function createKlineRenderer(fetchImpl: typeof fetch = fetch): KlineRenderer {
	return async ({ symbol, interval, limit = KLINE_DEFAULT_LIMIT }) => {
		const pair = normalizeSymbol(symbol);
		if (!pair) throw new KlineError("invalid_symbol");
		return renderKlineImage(pair, interval, await fetchKlines(pair, interval, limit, fetchImpl));
	};
}
