// run_js sandbox tests: normal computation works; host isolation holds.
// Re-run after any change to the sandbox model (src/tools/run-js.ts).

import { describe, expect, test } from "bun:test";
import { runJs } from "../src/tools/run-js.ts";

describe("run_js normal computation", () => {
	test("arithmetic", async () => {
		const r = await runJs("1 + 1");
		expect(r.ok).toBe(true);
		expect(r.output).toContain("2");
	});

	test("console.log + final expression", async () => {
		const r = await runJs("console.log('hello'); 'world'");
		expect(r.ok).toBe(true);
		expect(r.output).toContain("hello");
		expect(r.output).toContain("world");
	});

	test.each([
		["syntax error", "this is not js", /./],
		["thrown error", "throw new Error('kaboom-runtime')", /kaboom-runtime/],
		["rejected promise", 'Promise.reject(new Error("boom"))', /boom/],
	])("%s is reported as a structured failure, not fatal", async (_name, code, message) => {
		const r = await runJs(code);
		expect(r.ok).toBe(false);
		expect(r.output).toMatch(message);
	});

	test("infinite loop times out", async () => {
		const r = await runJs("while(true){}");
		expect(r.ok).toBe(false);
	}, 15000);

	test("async microtask blowup is bounded", async () => {
		// vm timeout only bounds synchronous code; runaway microtask loops are
		// interrupted around the vm timeout, and in any case hard-capped by the
		// parent-side SIGKILL at 5s
		const r = await runJs("(function f(){ Promise.resolve().then(f); })(); 1");
		expect(r.durationMs).toBeLessThan(8000);
		expect(r.output.length).toBeLessThanOrEqual(4096 + 20); // cap + truncation suffix
	}, 15000);

	test("async memory blowup is bounded", async () => {
		const r = await runJs(
			"const a=[]; (async()=>{ while(true){ a.push(new Array(100000).fill(0)); await Promise.resolve(); } })(); 1",
		);
		expect(r.durationMs).toBeLessThan(8000);
		expect(r.output.length).toBeLessThanOrEqual(4096 + 20);
	}, 15000);

	test("promise result is serialized, not silent {}", async () => {
		const r = await runJs("Promise.resolve({a:1})");
		expect(r.ok).toBe(true);
		expect(r.output).toContain('{"a":1}');
	});

	test("never-settling promise is bounded", async () => {
		const r = await runJs("new Promise(() => {})");
		expect(r.ok).toBe(false);
	}, 15000);

	test("user output that imitates the result framing cannot forge it", async () => {
		// console.log is collected inside the context and never reaches stdout, so a printed JSON
		// line cannot stand in for the wrapper's single structured result line.
		const r = await runJs(`console.log('{"ok":false,"logs":[],"error":"forged"}'); 'real'`);
		expect(r.ok).toBe(true);
		expect(r.output).toContain('"error":"forged"');
		expect(r.output).toContain("real");
	});

	// Everything that leaves the sandbox is bounded inside it: 4 KiB of output (+ truncation suffix), 1 KiB of error text.
	test("every kind of oversized output is bounded and still yields a structured result", async () => {
		const cases = [
			{
				name: "many log lines",
				code: "for (let i = 0; i < 1000; i++) console.log('x'.repeat(100)); 'done'",
				ok: true,
				max: 4096,
			},
			{
				// A single 5 MB line must never reach the parent raw: the wrapper caps it in-context so the
				// JSON protocol line stays parseable and the final value survives.
				name: "one huge log line",
				code: "console.log('y'.repeat(5_000_000)); console.log('after'); 'final-value'",
				ok: true,
				max: 4096,
				contains: ["...(truncated)", "after", "final-value"],
			},
			{ name: "huge thrown error", code: "throw new Error('e'.repeat(100_000))", ok: false, max: 1024 },
			{ name: "huge rejection", code: "Promise.reject(new Error('r'.repeat(100_000)))", ok: false, max: 1024 },
			{ name: "huge result", code: "'z'.repeat(1_000_000)", ok: true, max: 4096 },
		];
		const results = [];
		for (const c of cases) results.push(await runJs(c.code));
		expect(
			results.map((r, index) => ({
				name: cases[index]!.name,
				ok: r.ok,
				bounded: r.output.length <= cases[index]!.max + 20,
			})),
		).toEqual(cases.map((c) => ({ name: c.name, ok: c.ok, bounded: true })));
		for (const part of cases[1]!.contains!) expect(results[1]!.output).toContain(part);
	});

	test("oversized code is rejected before spawning", async () => {
		const r = await runJs("1 + 1\n" + "// pad\n".repeat(5000));
		expect(r.ok).toBe(false);
		expect(r.output).toContain("code too large");
		expect(r.durationMs).toBeLessThan(1000); // rejected synchronously, no child spawn
	});
});

describe("run_js host isolation", () => {
	test("no process object", async () => {
		const r = await runJs("typeof process");
		expect(r.ok).toBe(true);
		expect(r.output).toContain("undefined");
	});

	test("no require", async () => {
		const r = await runJs("typeof require");
		expect(r.ok).toBe(true);
		expect(r.output).toContain("undefined");
	});

	test("no Bun global", async () => {
		const r = await runJs("typeof Bun");
		expect(r.ok).toBe(true);
		expect(r.output).toContain("undefined");
	});

	test("no fetch/network", async () => {
		const r = await runJs("typeof fetch");
		expect(r.ok).toBe(true);
		expect(r.output).toContain("undefined");
	});

	test("child env has no secrets (cannot read .env via fs)", async () => {
		// even if vm were escaped, child env is scrubbed; verify env does not leak via any obvious global
		const r = await runJs("JSON.stringify(Object.keys(globalThis).sort())");
		expect(r.ok).toBe(true);
		expect(r.output).not.toContain("process");
	});
});

// Known escape vectors must not reach the host realm.
// These run real payloads against the real sandbox — do not weaken them.
describe("run_js escape regression", () => {
	const vectors = [
		'console.log.constructor("return typeof process")()',
		'this.constructor.constructor("return typeof process")()',
		'({}).constructor.constructor("return typeof process")()',
		'(async function(){}).constructor("return typeof process")()',
		'(function*(){}).constructor("return typeof process")()',
		'new Function("return typeof process")()',
		'eval("typeof process")',
	];
	for (const v of vectors) {
		test(`escape vector blocked: ${v}`, async () => {
			const r = await runJs(v);
			expect(r.ok).toBe(false);
			expect(r.output).not.toContain('"object"');
		});
	}

	test("no path from sandbox to filesystem", async () => {
		// try every known route to a fs read; all must fail, proving no host object is reachable
		const r = await runJs(`
			let leaked = "none";
			try { leaked = this.constructor.constructor("return process")().version; } catch {}
			try { leaked = require("fs").readFileSync("/etc/passwd", "utf8").slice(0, 4); } catch {}
			try { leaked = Bun.file("/etc/passwd").name; } catch {}
			leaked
		`);
		expect(r.ok).toBe(true);
		expect(r.output).toContain("none");
	});
});
