import {
	type Candle,
	fetchKlines,
	KLINE_DEFAULT_LIMIT,
	KlineError,
	type KlineInterval,
	normalizeSymbol,
} from "../tools/market-klines.ts";
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

let echartsReady: Promise<typeof import("echarts/core")> | undefined;

/** Lazy: ECharts loads only when a chart is actually drawn. */
function loadEcharts() {
	echartsReady ??= (async () => {
		const [core, charts, components, renderers] = await Promise.all([
			import("echarts/core"),
			import("echarts/charts"),
			import("echarts/components"),
			import("echarts/renderers"),
		]);
		core.use([
			charts.CandlestickChart,
			charts.BarChart,
			components.GridComponent,
			components.TitleComponent,
			renderers.SVGRenderer,
		]);
		return core;
	})();
	return echartsReady;
}

export function describeKline(symbol: string, interval: KlineInterval, candles: readonly Candle[]): string {
	const first = candles[0]!;
	const last = candles[candles.length - 1]!;
	const change = ((last.close - first.open) / first.open) * 100;
	return `📈 ${symbol} ${INTERVAL_NAMES[interval]} · 最新 ${formatPrice(last.close)} · 近 ${candles.length} 根 ${change >= 0 ? "+" : ""}${change.toFixed(2)}%`;
}

/** Candlesticks over volume bars, as an SVG string. Server-side rendering needs no DOM. */
export async function klineSvg(symbol: string, interval: KlineInterval, candles: readonly Candle[]): Promise<string> {
	const echarts = await loadEcharts();
	const chart = echarts.init(null, null, { renderer: "svg", ssr: true, width: WIDTH, height: HEIGHT });
	try {
		const last = candles[candles.length - 1]!;
		const first = candles[0]!;
		const change = ((last.close - first.open) / first.open) * 100;
		const times = candles.map((candle) => formatTime(candle.time, interval));
		const axisLabel = { color: "#6b7280", fontSize: 11 };
		const category = (gridIndex: number, show: boolean) => ({
			type: "category" as const,
			gridIndex,
			data: times,
			boundaryGap: true,
			axisLine: { lineStyle: { color: "#d1d5db" } },
			axisTick: { show: false },
			axisLabel: { ...axisLabel, show, hideOverlap: true },
		});
		chart.setOption({
			animation: false,
			backgroundColor: "#ffffff",
			textStyle: { fontFamily: FONT_FAMILY },
			title: {
				left: 16,
				top: 10,
				text: `${symbol}  ${interval}`,
				subtext: `${formatPrice(last.close)}  ${change >= 0 ? "+" : ""}${change.toFixed(2)}%  ·  UTC`,
				textStyle: { fontSize: 18, color: "#1f2328" },
				subtextStyle: { fontSize: 13, color: change >= 0 ? UP : DOWN },
			},
			grid: [
				{ left: 72, right: 20, top: 74, height: 270 },
				{ left: 72, right: 20, top: 366, height: 82 },
			],
			xAxis: [category(0, false), category(1, true)],
			yAxis: [
				{
					type: "value",
					gridIndex: 0,
					scale: true,
					axisLabel: { ...axisLabel, formatter: (value: number) => formatPrice(value) },
					splitLine: { lineStyle: { color: "#eef0f3" } },
				},
				{
					type: "value",
					gridIndex: 1,
					splitNumber: 2,
					axisLabel: {
						...axisLabel,
						formatter: (value: number) => (value >= 1000 ? `${Math.round(value / 1000)}k` : String(value)),
					},
					splitLine: { show: false },
				},
			],
			series: [
				{
					type: "candlestick",
					xAxisIndex: 0,
					yAxisIndex: 0,
					// ECharts orders a candle as [open, close, low, high].
					data: candles.map((candle) => [candle.open, candle.close, candle.low, candle.high]),
					itemStyle: { color: UP, color0: DOWN, borderColor: UP, borderColor0: DOWN },
				},
				{
					type: "bar",
					xAxisIndex: 1,
					yAxisIndex: 1,
					data: candles.map((candle) => ({
						value: candle.volume,
						itemStyle: { color: candle.close >= candle.open ? UP : DOWN },
					})),
				},
			],
		});
		return chart.renderToSVGString();
	} finally {
		chart.dispose();
	}
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
		const data = await toPng(await klineSvg(symbol, interval, candles));
		return { data, contentType: "image/png", caption: describeKline(symbol, interval, candles) };
	} catch {
		throw new TextImageError("render_failed");
	}
}

/** Throws when ECharts or resvg cannot load; draws two synthetic candles. */
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
