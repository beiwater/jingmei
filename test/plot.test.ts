import { describe, expect, test } from "bun:test";
import { buildPlot, MAX_PLOTS, PlotError, parseExpression, preparePlots } from "../src/media/plot.ts";

const fence = (spec: unknown) => ["```plot", typeof spec === "string" ? spec : JSON.stringify(spec), "```"].join("\n");

describe("parseExpression", () => {
	test("evaluates precedence, unary minus, powers, implicit multiplication and functions", () => {
		const at = (source: string, x: number) => parseExpression(source, ["x"])({ x });
		expect(at("2x^2 - 3(x+1)", 2)).toBe(-1);
		expect(at("-x^2", 3)).toBe(-9);
		expect(at("2^-1", 0)).toBe(0.5);
		expect(at("x**2", 4)).toBe(16);
		expect(at("2^3^2", 0)).toBe(512);
		expect(at("sin(pi/2)", 0)).toBeCloseTo(1);
		expect(at("sin x^2", 2)).toBeCloseTo(Math.sin(4));
		expect(at("sin(x)^2 + cos(x)^2", 0.7)).toBeCloseTo(1);
		expect(at("x sin(x)", 1)).toBeCloseTo(Math.sin(1));
		expect(at("2pi", 0)).toBeCloseTo(2 * Math.PI);
		expect(at("−x×2÷4", 2)).toBe(-1);
		expect(at("ln(e) + log(100) + abs(-3) + sqrt(16) + cbrt(-8)", 0)).toBeCloseTo(1 + 2 + 3 + 4 - 2);
		expect(at("sqrt(x)", -1)).toBeNaN();
	});

	test("an equation evaluates to left minus right", () => {
		const circle = parseExpression("x^2 + y^2 = 1", ["x", "y"], { equation: true });
		expect(circle({ x: 1, y: 0 })).toBe(0);
		expect(circle({ x: 0, y: 0 })).toBe(-1);
		expect(() => parseExpression("x = 1", ["x"])).toThrow(PlotError);
	});

	test("rejects anything that is not whitelisted maths", () => {
		for (const source of [
			"",
			"t",
			"y + 1",
			"constructor",
			"__proto__",
			"toString(x)",
			"x.constructor",
			"alert(1)",
			'#import "x"',
			"x; 1",
			"x[0]",
			"x +",
			"(x",
			"sin",
			"x".repeat(201),
			`${"(".repeat(100)}x${")".repeat(100)}`,
		])
			expect(() => parseExpression(source, ["x"]), source).toThrow(PlotError);
	});
});

describe("buildPlot", () => {
	test("splits tan at its poles and keeps every point inside the given box", () => {
		const plot = buildPlot(JSON.stringify({ x: [-6, 6], y: [-4, 4], plots: [{ y: "tan(x)" }] }));
		if (plot.kind !== "2d" || plot.series[0]?.kind !== "line") throw new Error("expected a 2D line");
		expect(plot.series[0].segments.length).toBeGreaterThanOrEqual(4);
		for (const point of plot.series[0].segments.flat()) {
			expect(point[0]).toBeGreaterThanOrEqual(-6);
			expect(point[0]).toBeLessThanOrEqual(6);
			expect(Math.abs(point[1])).toBeLessThanOrEqual(4 + 1e-9);
		}
	});

	test("finds an implicit curve's extent and draws circles at equal scale", () => {
		const plot = buildPlot(JSON.stringify({ plots: [{ implicit: "x^2 + y^2 = 1" }] }));
		if (plot.kind !== "2d") throw new Error("expected 2D");
		expect(plot.x[0]).toBeLessThan(-1);
		expect(plot.x[1]).toBeGreaterThan(1);
		expect(plot.x[1] - plot.x[0]).toBeLessThan(4);
		expect(plot.width / plot.height).toBeCloseTo((plot.x[1] - plot.x[0]) / (plot.y[1] - plot.y[0]), 1);
	});

	test("rejects bad specs with a readable reason", () => {
		for (const json of [
			"not json",
			"[]",
			JSON.stringify({ plots: [] }),
			JSON.stringify({ plots: Array.from({ length: 7 }, () => ({ y: "x" })) }),
			JSON.stringify({ x: [3, 1], plots: [{ y: "x" }] }),
			JSON.stringify({ x: [0, 1e9], plots: [{ y: "x" }] }),
			JSON.stringify({ plots: [{ points: [[1, "2"]] }] }),
			JSON.stringify({ plots: [{ label: "nothing to draw" }] }),
			JSON.stringify({ z: "x*y", x: [-1.5, 1.5], y: [-1, 1] }),
			JSON.stringify({ z: "sqrt(-1-x^2)", x: [-1, 1], y: [-1, 1] }),
		])
			expect(() => buildPlot(json), json).toThrow(PlotError);
	});
});

describe("preparePlots", () => {
	test("swaps plot blocks for image references and broken ones for a note", () => {
		const { markdown, plots } = preparePlots(
			["前", fence({ plots: [{ y: "x" }] }), "中", fence("{oops"), fence({ z: "x*y", x: [-2, 2], y: [-2, 2] })].join(
				"\n",
			),
		);
		expect(plots.map((p) => [p.name, p.surface])).toEqual([
			["plot-0", false],
			["plot-1", true],
		]);
		expect(markdown).toContain("![函数图](plot-0)");
		expect(markdown).toContain("![函数图](plot-1)");
		expect(markdown).toContain("函数图无法生成：内容不是合法的 JSON");
		expect(markdown).not.toContain("```plot");
	});

	test("draws at most the cap", () => {
		const blocks = Array.from({ length: MAX_PLOTS + 1 }, () => fence({ plots: [{ y: "x" }] }));
		const { markdown, plots } = preparePlots(blocks.join("\n"));
		expect(plots).toHaveLength(MAX_PLOTS);
		expect(markdown).toContain(`每张最多 ${MAX_PLOTS} 个`);
	});

	test("only numbers and escaped labels reach Typst, never the expression text", () => {
		const { plots } = preparePlots(fence({ plots: [{ y: "sin(x) + 12345.5", label: 'a"b\\c' }] }));
		expect(plots[0]!.typst).not.toContain("sin");
		expect(plots[0]!.typst).toContain('label: "a\\"b\\\\c"');
	});
});
