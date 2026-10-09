// Function plots inside text images. A ```plot block holds a JSON spec; its maths is parsed by a small
// whitelisted parser and sampled here, so only numbers (and escaped labels) reach Typst, never expressions.
// 2D graphs are drawn by cetz-plot, surfaces by plotsy-3d.

const MAX_EXPRESSION_CHARS = 200;
const MAX_DEPTH = 40;
const MAX_SERIES = 6;
const MAX_POINTS = 300;
const MAX_LABEL_CHARS = 40;
const MAX_RANGE = 1e6;
const FN_SAMPLES = 400;
const PARAM_SAMPLES = 600;
const CONTOUR_SAMPLES = 81;
/** Surface cells per side; plotsy-3d draws one polygon per cell, and compiles synchronously on the bot's thread. */
const SURFACE_CELLS = 24;
/** Plot width in canvas units (cm); the text image is 324 pt (≈ 11.4 cm) wide inside its margins. */
const WIDTH = 9;
const MIN_HEIGHT = 4;
const MAX_HEIGHT = 9;
const COLORS = ["#2563eb", "#dc2626", "#16a34a", "#9333ea", "#ea580c", "#0891b2"];

export class PlotError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PlotError";
	}
}

type Env = Readonly<Record<string, number>>;
export type Expression = (env: Env) => number;

const FUNCTIONS: Readonly<Record<string, (value: number) => number>> = {
	sin: Math.sin,
	cos: Math.cos,
	tan: Math.tan,
	cot: (v) => 1 / Math.tan(v),
	sec: (v) => 1 / Math.cos(v),
	csc: (v) => 1 / Math.sin(v),
	asin: Math.asin,
	acos: Math.acos,
	atan: Math.atan,
	arcsin: Math.asin,
	arccos: Math.acos,
	arctan: Math.atan,
	sinh: Math.sinh,
	cosh: Math.cosh,
	tanh: Math.tanh,
	exp: Math.exp,
	ln: Math.log,
	log: Math.log10,
	lg: Math.log10,
	log2: Math.log2,
	sqrt: Math.sqrt,
	cbrt: Math.cbrt,
	abs: Math.abs,
	floor: Math.floor,
	ceil: Math.ceil,
	sign: Math.sign,
};
const CONSTANTS: Readonly<Record<string, number>> = { pi: Math.PI, π: Math.PI, e: Math.E };

type Token = { kind: "num"; value: number } | { kind: "name"; name: string } | { kind: "op"; op: string };

const TOKEN =
	/\s*(?:(\d+\.?\d*(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?)|([A-Za-zπ][A-Za-z0-9_]*)|(\*\*|[-+*/^(),=×÷·−]))/y;
const OP_ALIASES: Readonly<Record<string, string>> = { "**": "^", "×": "*", "·": "*", "÷": "/", "−": "-" };

function tokenize(source: string): Token[] {
	const tokens: Token[] = [];
	TOKEN.lastIndex = 0;
	let index = 0;
	while (index < source.length) {
		if (!source.slice(index).trim()) break;
		TOKEN.lastIndex = index;
		const match = TOKEN.exec(source);
		if (!match) throw new PlotError(`无法识别「${source.slice(index).trim().slice(0, 8)}」`);
		index = TOKEN.lastIndex;
		if (match[1] !== undefined) tokens.push({ kind: "num", value: Number(match[1]) });
		else if (match[2] !== undefined) tokens.push({ kind: "name", name: match[2] });
		else tokens.push({ kind: "op", op: OP_ALIASES[match[3]!] ?? match[3]! });
	}
	return tokens;
}

/**
 * Parses `source` into an evaluator over `variables`. Supports + - * / ^ (or **), unary minus, parentheses,
 * implicit multiplication (`2x`, `3(x+1)`, `x sin(x)`), the functions above and pi/e. With `equation`, one
 * `lhs = rhs` is accepted and evaluates to lhs − rhs. Anything else is rejected, so nothing but maths runs.
 */
export function parseExpression(
	source: string,
	variables: readonly string[],
	options: { equation?: boolean } = {},
): Expression {
	if (typeof source !== "string" || !source.trim()) throw new PlotError("表达式为空");
	if (source.length > MAX_EXPRESSION_CHARS) throw new PlotError("表达式太长");
	const tokens = tokenize(source);
	let position = 0;
	let depth = 0;
	const peek = () => tokens[position];
	const isOp = (op: string) => {
		const token = peek();
		return token?.kind === "op" && token.op === op;
	};
	const expect = (op: string) => {
		if (!isOp(op)) throw new PlotError(`缺少「${op}」`);
		position++;
	};
	const nested = <T>(parse: () => T): T => {
		if (++depth > MAX_DEPTH) throw new PlotError("表达式嵌套太深");
		try {
			return parse();
		} finally {
			depth--;
		}
	};
	const startsOperand = () => {
		const token = peek();
		return token !== undefined && (token.kind !== "op" || token.op === "(");
	};

	const sum = (): Expression =>
		nested(() => {
			let left = product();
			while (isOp("+") || isOp("-")) {
				const minus = isOp("-");
				position++;
				const a = left;
				const b = product();
				left = minus ? (env) => a(env) - b(env) : (env) => a(env) + b(env);
			}
			return left;
		});
	const product = (): Expression => {
		let left = unary();
		for (;;) {
			if (isOp("*") || isOp("/")) {
				const divide = isOp("/");
				position++;
				const a = left;
				const b = unary();
				left = divide ? (env) => a(env) / b(env) : (env) => a(env) * b(env);
			} else if (startsOperand()) {
				const a = left;
				const b = power();
				left = (env) => a(env) * b(env);
			} else return left;
		}
	};
	const unary = (): Expression =>
		nested(() => {
			if (isOp("-")) {
				position++;
				const inner = unary();
				return (env) => -inner(env);
			}
			if (isOp("+")) {
				position++;
				return unary();
			}
			return power();
		});
	const power = (): Expression => {
		const base = primary();
		if (!isOp("^")) return base;
		position++;
		const exponent = unary();
		return (env) => base(env) ** exponent(env);
	};
	const primary = (): Expression =>
		nested(() => {
			const token = peek();
			if (!token) throw new PlotError("表达式不完整");
			position++;
			if (token.kind === "num") {
				const value = token.value;
				return () => value;
			}
			if (token.kind === "op") {
				if (token.op !== "(") throw new PlotError(`多余的「${token.op}」`);
				const inner = sum();
				expect(")");
				return inner;
			}
			const name = token.name;
			const fn = Object.hasOwn(FUNCTIONS, name) ? FUNCTIONS[name] : undefined;
			if (fn) {
				if (!startsOperand()) throw new PlotError(`${name} 缺少参数`);
				const argument = isOp("(") ? primary() : unary();
				return (env) => fn(argument(env));
			}
			if (variables.includes(name)) return (env) => env[name] ?? Number.NaN;
			if (Object.hasOwn(CONSTANTS, name)) {
				const value = CONSTANTS[name]!;
				return () => value;
			}
			throw new PlotError(`未知的名称「${name.slice(0, 20)}」，可用变量：${variables.join("、")}`);
		});

	let expression = sum();
	if (options.equation && isOp("=")) {
		position++;
		const left = expression;
		const right = sum();
		expression = (env) => left(env) - right(env);
	}
	if (position < tokens.length) {
		const extra = tokens[position]!;
		throw new PlotError(
			`多余的「${extra.kind === "op" ? extra.op : extra.kind === "name" ? extra.name : extra.value}」`,
		);
	}
	return expression;
}

type Range = [number, number];
type Point = [number, number];

export type Series =
	| { kind: "line"; label?: string; color: string; segments: Point[][] }
	| { kind: "contour"; label?: string; color: string; grid: number[][]; x: Range; y: Range }
	| { kind: "points"; label?: string; color: string; points: Point[] };

export type Plot =
	| { kind: "2d"; x: Range; y: Range; width: number; height: number; series: Series[] }
	| { kind: "3d"; x: Range; y: Range; z: Range; samples: number; zs: number[][] };

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function range(value: unknown, name: string): Range | undefined {
	if (value === undefined) return undefined;
	if (
		!Array.isArray(value) ||
		value.length !== 2 ||
		!value.every((v) => typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= MAX_RANGE) ||
		!(value[1] - value[0] > 1e-9)
	)
		throw new PlotError(`${name} 应写成 [最小值, 最大值]`);
	return [value[0], value[1]];
}

function label(value: unknown): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string") throw new PlotError("label 应为文字");
	const text = value.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
	return text ? [...text].slice(0, MAX_LABEL_CHARS).join("") : undefined;
}

function samplesOver([lo, hi]: Range, count: number): number[] {
	return Array.from({ length: count }, (_, i) => lo + ((hi - lo) * i) / (count - 1));
}

/** Splits a sampled curve at non-finite values. */
function finiteRuns(points: Point[]): Point[][] {
	const runs: Point[][] = [];
	let run: Point[] = [];
	for (const point of points) {
		if (Number.isFinite(point[0]) && Number.isFinite(point[1])) run.push(point);
		else if (run.length) {
			runs.push(run);
			run = [];
		}
	}
	if (run.length) runs.push(run);
	return runs;
}

/** Liang–Barsky: the part of segment p→q inside the box, or null. */
function clipSegment(p: Point, q: Point, x: Range, y: Range): [Point, Point] | null {
	const dx = q[0] - p[0];
	const dy = q[1] - p[1];
	let t0 = 0;
	let t1 = 1;
	for (const [step, distance] of [
		[-dx, p[0] - x[0]],
		[dx, x[1] - p[0]],
		[-dy, p[1] - y[0]],
		[dy, y[1] - p[1]],
	] as const) {
		if (step === 0) {
			if (distance < 0) return null;
			continue;
		}
		const t = distance / step;
		if (step < 0) t0 = Math.max(t0, t);
		else t1 = Math.min(t1, t);
		if (t0 > t1) return null;
	}
	return [
		[p[0] + t0 * dx, p[1] + t0 * dy],
		[p[0] + t1 * dx, p[1] + t1 * dy],
	];
}

/**
 * Clips runs to the box. A step from far above to far below (or back) is a pole such as tan(x) or 1/x,
 * not a steep line, so it breaks the curve instead of drawing a vertical stroke.
 */
function clipRuns(runs: Point[][], x: Range, y: Range): Point[][] {
	const out: Point[][] = [];
	for (const run of runs) {
		let current: Point[] = [];
		const flush = () => {
			if (current.length >= 2) out.push(current);
			current = [];
		};
		for (let i = 1; i < run.length; i++) {
			const p = run[i - 1]!;
			const q = run[i]!;
			const pole = (p[1] > y[1] && q[1] < y[0]) || (p[1] < y[0] && q[1] > y[1]);
			const clipped = pole ? null : clipSegment(p, q, x, y);
			if (!clipped) {
				flush();
				continue;
			}
			const last = current[current.length - 1];
			if (!last || last[0] !== clipped[0][0] || last[1] !== clipped[0][1]) {
				flush();
				current.push(clipped[0]);
			}
			current.push(clipped[1]);
		}
		flush();
	}
	return out;
}

function quantile(sorted: readonly number[], q: number): number {
	return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))))]!;
}

function padded(lo: number, hi: number): Range {
	if (!(hi - lo > 1e-9)) return [lo - 1, hi + 1];
	const pad = (hi - lo) * 0.08;
	return [lo - pad, hi + pad];
}

type Draft =
	| { kind: "fn"; label?: string; f: Expression }
	| { kind: "param"; label?: string; fx: Expression; fy: Expression; t: Range }
	| { kind: "implicit"; label?: string; f: Expression }
	| { kind: "points"; label?: string; points: Point[] };

function draftSeries(value: unknown): Draft {
	if (!isObject(value)) throw new PlotError("plots 里每一项都应是对象");
	const name = label(value.label);
	const named = name ? { label: name } : {};
	if (value.points !== undefined) {
		const points = value.points;
		if (
			!Array.isArray(points) ||
			!points.length ||
			points.length > MAX_POINTS ||
			!points.every(
				(p) =>
					Array.isArray(p) &&
					p.length === 2 &&
					p.every((v) => typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= MAX_RANGE),
			)
		)
			throw new PlotError(`points 应为 1–${MAX_POINTS} 个 [x, y]`);
		return { kind: "points", points: points.map((p) => [p[0], p[1]] as Point), ...named };
	}
	if (typeof value.implicit === "string")
		return { kind: "implicit", f: parseExpression(value.implicit, ["x", "y"], { equation: true }), ...named };
	if (typeof value.x === "string" && typeof value.y === "string")
		return {
			kind: "param",
			fx: parseExpression(value.x, ["t"]),
			fy: parseExpression(value.y, ["t"]),
			t: range(value.t, "t") ?? [0, 2 * Math.PI],
			...named,
		};
	if (typeof value.y === "string") return { kind: "fn", f: parseExpression(value.y, ["x"]), ...named };
	throw new PlotError("每一项需要 y、implicit、x+y（参数方程）或 points 之一");
}

/** Where an implicit curve f = 0 lies within ±10, found by sign changes on a coarse grid; null if nowhere. */
function implicitBox(f: Expression): { x: Range; y: Range } | null {
	const axis = samplesOver([-10, 10], 121);
	const values = axis.map((y) => axis.map((x) => f({ x, y })));
	let box: { x: Range; y: Range } | null = null;
	for (let j = 0; j < axis.length; j++)
		for (let i = 0; i < axis.length; i++) {
			const here = values[j]![i]!;
			const right = values[j]![i + 1];
			const up = values[j + 1]?.[i];
			const crosses = [right, up].some(
				(next) =>
					next !== undefined && Number.isFinite(here) && Number.isFinite(next) && Math.sign(here) !== Math.sign(next),
			);
			if (!crosses) continue;
			const [x, y] = [axis[i]!, axis[j]!];
			box = box
				? { x: [Math.min(box.x[0], x), Math.max(box.x[1], x)], y: [Math.min(box.y[0], y), Math.max(box.y[1], y)] }
				: { x: [x, x], y: [y, y] };
		}
	return box && { x: padded(box.x[0], box.x[1] + 20 / 120), y: padded(box.y[0], box.y[1] + 20 / 120) };
}

/** A step of 1, 2 or 5 × 10^k giving about `count` ticks over `span`. */
export function niceStep(span: number, count: number): number {
	const raw = span / Math.max(1, count);
	const magnitude = 10 ** Math.floor(Math.log10(raw));
	const step = [1, 2, 5, 10].map((m) => m * magnitude).find((candidate) => candidate >= raw) ?? 10 * magnitude;
	return Number(step.toPrecision(6));
}

function build2d(spec: Record<string, unknown>): Plot {
	if (!Array.isArray(spec.plots) || !spec.plots.length || spec.plots.length > MAX_SERIES)
		throw new PlotError(`plots 应为 1–${MAX_SERIES} 项`);
	const drafts = spec.plots.map(draftSeries);
	const givenX = range(spec.x, "x");
	const givenY = range(spec.y, "y");
	const needsX = drafts.some((d) => d.kind === "fn");
	const domain: Range = givenX ?? [-5, 5];
	const implicitBoxes = givenX
		? []
		: drafts.flatMap((d) => (d.kind === "implicit" ? [implicitBox(d.f) ?? { x: domain, y: domain }] : []));

	const sampled = drafts.map((draft) => {
		if (draft.kind === "fn") return samplesOver(domain, FN_SAMPLES).map((x) => [x, draft.f({ x })] as Point);
		if (draft.kind === "param")
			return samplesOver(draft.t, PARAM_SAMPLES).map((t) => [draft.fx({ t }), draft.fy({ t })] as Point);
		if (draft.kind === "points") return draft.points;
		return [];
	});

	// Auto ranges: curves of y = f(x) use the 2–98% band so poles do not flatten everything else.
	const fnYs = drafts
		.flatMap((d, i) => (d.kind === "fn" ? sampled[i]!.map((p) => p[1]) : []))
		.filter(Number.isFinite)
		.sort((a, b) => a - b);
	const others = drafts.flatMap((d, i) => (d.kind === "param" || d.kind === "points" ? sampled[i]! : []));
	const finiteOthers = [
		...others.filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1])),
		...implicitBoxes.flatMap((box): Point[] => [
			[box.x[0], box.y[0]],
			[box.x[1], box.y[1]],
		]),
	];
	let x: Range =
		givenX ??
		(needsX || !finiteOthers.length
			? domain
			: padded(Math.min(...finiteOthers.map((p) => p[0])), Math.max(...finiteOthers.map((p) => p[0]))));
	let y: Range;
	if (givenY) y = givenY;
	else {
		const lows = [...(fnYs.length ? [quantile(fnYs, 0.02)] : []), ...finiteOthers.map((p) => p[1])];
		const highs = [...(fnYs.length ? [quantile(fnYs, 0.98)] : []), ...finiteOthers.map((p) => p[1])];
		y = lows.length ? padded(Math.min(...lows), Math.max(...highs)) : [-5, 5];
	}

	// Without y = f(x) curves (circles, ellipses, Lissajous figures) both axes share one scale.
	let height = 6;
	if (!drafts.some((d) => d.kind === "fn")) {
		height = (WIDTH * (y[1] - y[0])) / (x[1] - x[0]);
		if (height > MAX_HEIGHT) {
			height = MAX_HEIGHT;
			const half = ((y[1] - y[0]) * WIDTH) / MAX_HEIGHT / 2;
			const mid = (x[0] + x[1]) / 2;
			x = [mid - half, mid + half];
		} else if (height < MIN_HEIGHT) {
			height = MIN_HEIGHT;
			const half = ((x[1] - x[0]) * MIN_HEIGHT) / WIDTH / 2;
			const mid = (y[0] + y[1]) / 2;
			y = [mid - half, mid + half];
		}
	}

	const series = drafts.map((draft, i): Series => {
		const color = COLORS[i % COLORS.length]!;
		const named = draft.label ? { label: draft.label } : {};
		if (draft.kind === "implicit") {
			// One extra cell past each edge: the contour library closes regions along the sampled border,
			// and those closing lines then fall outside the plot box, which clips them.
			const cellX = (x[1] - x[0]) / (CONTOUR_SAMPLES - 1);
			const cellY = (y[1] - y[0]) / (CONTOUR_SAMPLES - 1);
			const gridX: Range = [x[0] - cellX, x[1] + cellX];
			const gridY: Range = [y[0] - cellY, y[1] + cellY];
			const xs = samplesOver(gridX, CONTOUR_SAMPLES + 2);
			const grid = samplesOver(gridY, CONTOUR_SAMPLES + 2).map((yv) =>
				xs.map((xv) => {
					const value = draft.f({ x: xv, y: yv });
					// Outside the domain counts as "positive" so the contour stays closed instead of failing.
					return Number.isFinite(value) ? value : 1e9;
				}),
			);
			return { kind: "contour", color, grid, x: gridX, y: gridY, ...named };
		}
		if (draft.kind === "points")
			return {
				kind: "points",
				color,
				points: draft.points.filter((p) => p[0] >= x[0] && p[0] <= x[1] && p[1] >= y[0] && p[1] <= y[1]),
				...named,
			};
		return { kind: "line", color, segments: clipRuns(finiteRuns(sampled[i]!), x, y), ...named };
	});
	return { kind: "2d", x, y, width: WIDTH, height: Number(height.toFixed(2)), series };
}

function build3d(spec: Record<string, unknown>): Plot {
	const f = parseExpression(spec.z as string, ["x", "y"]);
	const x = range(spec.x, "x") ?? [-3, 3];
	const y = range(spec.y, "y") ?? [-3, 3];
	// plotsy-3d samples on whole-number domains with integer axis steps.
	for (const [name, [lo, hi]] of [
		["x", x],
		["y", y],
	] as const)
		if (!Number.isInteger(lo) || !Number.isInteger(hi) || hi - lo < 1 || hi - lo > 40)
			throw new PlotError(`3D 曲面的 ${name} 范围须为整数，跨度 1–40`);
	const samples = Math.max(1, Math.floor(SURFACE_CELLS / Math.max(x[1] - x[0], y[1] - y[0])));
	const raw = samplesOver(x, (x[1] - x[0]) * samples + 1).map((xv) =>
		samplesOver(y, (y[1] - y[0]) * samples + 1).map((yv) => f({ x: xv, y: yv })),
	);
	const finite = raw
		.flat()
		.filter(Number.isFinite)
		.sort((a, b) => a - b);
	if (!finite.length) throw new PlotError("曲面在该范围内没有定义");
	// The full value range, unless a pole stretches it far beyond the 2–98% band.
	const band: Range = [quantile(finite, 0.02), quantile(finite, 0.98)];
	const full: Range = [finite[0]!, finite[finite.length - 1]!];
	const z = range(spec.zRange, "zRange") ?? (full[1] - full[0] > 5 * (band[1] - band[0]) + 1e-9 ? band : full);
	if (!(z[1] > z[0])) z[1] = z[0] + 1;
	// Out-of-domain cells sit on the floor; poles are cut at the z range.
	const zs = raw.map((row) => row.map((v) => (Number.isFinite(v) ? Math.min(z[1], Math.max(z[0], v)) : z[0])));
	return { kind: "3d", x, y, z, samples, zs };
}

/** Validates and samples one ```plot block's JSON. */
export function buildPlot(json: string): Plot {
	let spec: unknown;
	try {
		spec = JSON.parse(json);
	} catch {
		throw new PlotError("内容不是合法的 JSON");
	}
	if (!isObject(spec)) throw new PlotError("内容应是一个 JSON 对象");
	return typeof spec.z === "string" ? build3d(spec) : build2d(spec);
}

/** A number as a Typst literal; plot data is bounded, so no exponent forms beyond what Typst accepts. */
function num(value: number): string {
	const bounded = Math.max(-1e9, Math.min(1e9, value));
	if (Math.abs(bounded) < 1e-9) return "0";
	return String(Number(bounded.toPrecision(7)));
}

function pair([a, b]: readonly [number, number]): string {
	return `(${num(a)}, ${num(b)})`;
}

function list(items: readonly string[]): string {
	return `(${items.join(", ")}${items.length === 1 ? "," : ""})`;
}

/** Labels become Typst string literals: only `\` and `"` are special there, and control characters are gone. */
function typstString(text: string): string {
	return `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Typst content for one plot; assumes `cetz`, `plot` (cetz-plot) and, for surfaces, `plot-3d-surface` in scope. */
export function plotTypst(plot: Plot): string {
	if (plot.kind === "3d") {
		const zLow = Math.floor(plot.z[0]);
		const zHigh = Math.max(zLow + 1, Math.ceil(plot.z[1]));
		const xSpan = plot.x[1] - plot.x[0];
		const ySpan = plot.y[1] - plot.y[0];
		const rows = list(plot.zs.map((row) => list(row.map(num))));
		return `{
  let zs = ${rows}
  plot-3d-surface(
    (x, y) => zs.at(int(calc.round((x - ${num(plot.x[0])}) * ${plot.samples}))).at(int(calc.round((y - ${num(plot.y[0])}) * ${plot.samples}))),
    subdivisions: ${plot.samples},
    subdivision-mode: "increase",
    scale-dim: (${num(0.54 / xSpan)}, ${num(0.54 / ySpan)}, ${num(0.42 / (zHigh - zLow))}),
    xdomain: ${pair(plot.x)},
    ydomain: ${pair(plot.y)},
    axis-step: (${Math.max(1, Math.ceil(xSpan / 6))}, ${Math.max(1, Math.ceil(ySpan / 6))}, ${Math.max(1, Math.ceil((zHigh - zLow) / 4))}),
    dot-thickness: 0.05em,
    front-axis-thickness: 0.1em,
    front-axis-dot-scale: (0.05, 0.05),
    rear-axis-dot-scale: (0.08, 0.08),
    rear-axis-text-size: 0.5em,
    color-func: (x, y, z, ..bounds) => gradient.linear(..color.map.viridis).sample(calc.clamp((z - ${num(plot.z[0])}) / ${num(Math.max(plot.z[1] - plot.z[0], 1e-9))}, 0, 1) * 100%).transparentize(8%),
    axis-label-size: 1.2em,
    axis-label-offset: (${num((0.3 * ySpan) / 6)}, ${num((0.2 * xSpan) / 6)}, ${num((0.15 * xSpan) / 6)}),
    axis-text-offset: ${num((0.075 * (xSpan + ySpan)) / 12)},
  )
}`;
	}
	const inside = (r: Range) => r[0] < 0 && r[1] > 0;
	const legend = plot.series.some((s) => s.label);
	const body = plot.series.flatMap((series) => {
		const named = series.label ? `, label: ${typstString(series.label)}` : "";
		const stroke = `(stroke: 1.2pt + rgb("${series.color}"))`;
		if (series.kind === "contour")
			return [
				`plot.add-contour(${list(series.grid.map((row) => list(row.map(num))))}, z: 0, x-domain: ${pair(series.x)}, y-domain: ${pair(series.y)}, style: ${stroke}${named})`,
			];
		if (series.kind === "points")
			return series.points.length
				? [
						`plot.add(${list(series.points.map(pair))}, mark: "o", mark-size: .14, style: (stroke: none), mark-style: (stroke: 0.8pt + rgb("${series.color}"), fill: rgb("${series.color}").lighten(60%))${named})`,
					]
				: [];
		return series.segments.map(
			(segment, index) => `plot.add(${list(segment.map(pair))}, style: ${stroke}${index === 0 ? named : ""})`,
		);
	});
	return `cetz.canvas({
  plot.plot(
    size: (${plot.width}, ${plot.height}),
    axis-style: "${inside(plot.x) && inside(plot.y) ? "school-book" : "scientific"}",
    x-min: ${num(plot.x[0])}, x-max: ${num(plot.x[1])}, y-min: ${num(plot.y[0])}, y-max: ${num(plot.y[1])},
    x-tick-step: ${num(niceStep(plot.x[1] - plot.x[0], plot.width / 1.5))},
    y-tick-step: ${num(niceStep(plot.y[1] - plot.y[0], plot.height / 1.2))},
    x-grid: true, y-grid: true, x-label: $x$, y-label: $y$,
    legend: ${legend ? '"inner-north-east"' : "none"},
    {
${body.map((line) => `      ${line}`).join("\n")}
      plot.add(((${num(plot.x[0])}, ${num(plot.y[0])}),), style: (stroke: none))
    },
  )
})`;
}

const PLOT_FENCE = /^```plot[^\S\r\n]*\r?\n([\s\S]*?)\r?\n```[^\S\r\n]*$/gm;
export const MAX_PLOTS = 3;

/**
 * Replaces each ```plot block with an image reference `plot-N` and returns the Typst content for each.
 * A broken spec becomes a short note in place, so one bad graph does not sink the whole reply.
 */
export function preparePlots(markdown: string): {
	markdown: string;
	plots: Array<{ name: string; typst: string; surface: boolean }>;
} {
	const plots: Array<{ name: string; typst: string; surface: boolean }> = [];
	const rewritten = markdown.replace(PLOT_FENCE, (_whole, json: string) => {
		if (plots.length >= MAX_PLOTS) return `（函数图无法生成：每张最多 ${MAX_PLOTS} 个）`;
		try {
			const plot = buildPlot(json);
			const name = `plot-${plots.length}`;
			plots.push({ name, typst: plotTypst(plot), surface: plot.kind === "3d" });
			return `![函数图](${name})`;
		} catch (error) {
			return `（函数图无法生成：${error instanceof PlotError ? error.message : "数据有误"}）`;
		}
	});
	return { markdown: rewritten, plots };
}
