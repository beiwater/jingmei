import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Resvg } from "@resvg/resvg-js";
import { validateConfig } from "../src/config.ts";
import { renderTextImage, TEXT_IMAGE_MAX_CHARS, TextImageError } from "../src/media/text-image.ts";

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function dimensions(png: Uint8Array) {
	const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
	return { width: view.getUint32(16), height: view.getUint32(20) };
}

const PICTURE = new Resvg(
	'<svg xmlns="http://www.w3.org/2000/svg" width="320" height="120"><rect width="320" height="120" fill="#4f46e5"/></svg>',
)
	.render()
	.asPng();

function recordingFetch(response: () => Response = () => new Response(PICTURE)) {
	const urls: string[] = [];
	const fetchImpl = (async (input: string | URL | Request) => {
		urls.push(String(input));
		return response();
	}) as typeof fetch;
	return { urls, fetchImpl };
}

describe("renderTextImage", () => {
	test("renders Chinese text, LaTeX math, a table and code to one PNG of fixed width", async () => {
		const image = await renderTextImage(
			[
				"# 标题",
				"",
				"行内公式 $a^2+b^2=c^2$，块公式：",
				"",
				"$$\\int_0^1 x^2\\,dx=\\frac13$$",
				"",
				"| 名称 | 数值 |",
				"|---|---|",
				"| 甲 | 1 |",
				"",
				"```python",
				"print('hi')",
				"```",
			].join("\n"),
		);
		expect(image.contentType).toBe("image/png");
		expect(Array.from(image.data.slice(0, 8))).toEqual(PNG_SIGNATURE);
		const { width, height } = dimensions(image.data);
		expect(width).toBe(720);
		expect(height).toBeGreaterThan(200);
	});

	test("a longer text makes a taller image", async () => {
		const short = dimensions((await renderTextImage("一行")).data);
		const long = dimensions((await renderTextImage("很长的一段文字。".repeat(120))).data);
		expect(long.height).toBeGreaterThan(short.height * 3);
	});

	test("downloads only public image URLs and refuses private hosts and local paths", async () => {
		const { urls, fetchImpl } = recordingFetch();
		const image = await renderTextImage(
			[
				"![公网](https://example.com/a.png)",
				"![私网](http://127.0.0.1/secret.png)",
				"![内网](http://10.0.0.5/x.png)",
				"![本地](/etc/passwd)",
				"![引用][ref]",
				"[ref]: https://example.com/b.png",
			].join("\n\n"),
			{ fetch: fetchImpl },
		);
		expect(urls).toEqual(["https://example.com/a.png"]);
		const bare = await renderTextImage("文字", { fetch: fetchImpl });
		expect(dimensions(image.data).height).toBeGreaterThan(dimensions(bare.data).height + 100);
	});

	test("caps downloads at four images and survives a failing or non-image response", async () => {
		const many = recordingFetch();
		await renderTextImage(
			Array.from({ length: 6 }, (_, index) => `![图${index}](https://example.com/${index}.png)`).join("\n\n"),
			{ fetch: many.fetchImpl },
		);
		expect(many.urls).toHaveLength(4);

		for (const response of [
			() => new Response("not an image"),
			() => new Response("gone", { status: 404 }),
			() => {
				throw new Error("network down");
			},
		]) {
			const { fetchImpl } = recordingFetch(response);
			const image = await renderTextImage("前\n\n![图](https://example.com/a.png)\n\n后", { fetch: fetchImpl });
			expect(Array.from(image.data.slice(0, 8))).toEqual(PNG_SIGNATURE);
		}
	});

	test("embedded Typst, raw HTML and math escapes are rendered as text, never executed", async () => {
		// Each snippet would abort the compilation if Typst ever evaluated it.
		const hostile = [
			'<!--raw-typst #panic("injected") -->',
			'<svg width="1" height="1"><image href="/cmarker/plugin.wasm"/></svg>',
			'<a>no href</a> <img src="/doc.md">',
			'$#panic("injected")$',
			'$$\\text{#panic("injected")}$$',
			'```\n#panic("injected")\n```',
		].join("\n\n");
		const image = await renderTextImage(hostile);
		expect(Array.from(image.data.slice(0, 8))).toEqual(PNG_SIGNATURE);
	});

	test("draws ```plot graphs and 3D surfaces, and a broken spec only leaves a note", async () => {
		const plot = (spec: unknown) => ["```plot", JSON.stringify(spec), "```"].join("\n");
		const bare = dimensions((await renderTextImage("函数图")).data);
		const image = await renderTextImage(
			[
				"函数图",
				plot({ x: [-6, 6], y: [-4, 4], plots: [{ y: "tan(x)", label: "tan" }, { implicit: "x^2+y^2=4" }] }),
				plot({ z: "sin(x)*cos(y)", x: [-3, 3], y: [-3, 3] }),
				plot({ plots: [{ y: "nope(x)" }] }),
			].join("\n\n"),
		);
		expect(Array.from(image.data.slice(0, 8))).toEqual(PNG_SIGNATURE);
		expect(dimensions(image.data).height).toBeGreaterThan(bare.height + 600);
	});

	test("plot labels are text, never Typst code", async () => {
		const label = '") #panic("injected") ("';
		const image = await renderTextImage(["```plot", JSON.stringify({ plots: [{ y: "x", label }] }), "```"].join("\n"));
		expect(Array.from(image.data.slice(0, 8))).toEqual(PNG_SIGNATURE);
	});

	test("```image blocks are drawn by the picture generator, at most two, and fall back to a note", async () => {
		const prompts: string[] = [];
		const generatePicture = async (prompt: string) => {
			prompts.push(prompt);
			return PICTURE;
		};
		const blocks = ["a red fox", "a blue whale", "a green frog"].map((p) => ["```image", p, "```"].join("\n"));
		const drawn = await renderTextImage(["前", ...blocks, "后"].join("\n\n"), { generatePicture });
		expect(prompts).toEqual(["a red fox", "a blue whale"]);
		const failing = await renderTextImage(["前", blocks[0]!, "后"].join("\n\n"), {
			generatePicture: async () => {
				throw new Error("quota");
			},
		});
		const absent = await renderTextImage(["前", blocks[0]!, "后"].join("\n\n"));
		expect(dimensions(drawn.data).height).toBeGreaterThan(dimensions(absent.data).height + 100);
		expect(dimensions(failing.data).height).toBe(dimensions(absent.data).height);
	});

	test("rejects empty and oversized input before any work", async () => {
		const { urls, fetchImpl } = recordingFetch();
		for (const markdown of ["", "  \n ", "字".repeat(TEXT_IMAGE_MAX_CHARS + 1)])
			await expect(renderTextImage(markdown, { fetch: fetchImpl })).rejects.toMatchObject({ code: "invalid_input" });
		expect(urls).toHaveLength(0);
	});

	test("an image taller than the platform limit is refused instead of sent", async () => {
		const error = await renderTextImage("字\n\n".repeat(2_600)).catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(TextImageError);
		expect(error).toMatchObject({ code: "too_large" });
	});
});

describe("textImage config", () => {
	function load(textImage: unknown) {
		const dir = mkdtempSync(join(tmpdir(), "jingmei-textimage-"));
		try {
			const personaPath = join(dir, "persona.md");
			writeFileSync(personaPath, "x");
			return validateConfig(
				{
					telegram: { chatIds: ["-100111"] },
					...(textImage === undefined ? {} : { textImage }),
					personas: [
						{
							id: "luna",
							name: "Luna",
							personaPath,
							provider: "p",
							model: "m",
							routingP: 0,
							telegram: { tokenEnv: "BOT_TOKEN" },
						},
					],
				},
				dir,
				{ ROUTING_SECRET: "fixture", BOT_TOKEN: "fixture" },
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}

	test("is off unless enabled, and the threshold defaults to 300", () => {
		expect(load(undefined).textImage).toBeUndefined();
		expect(load({}).textImage).toBeUndefined();
		expect(load({ enabled: false, thresholdChars: 500 }).textImage).toBeUndefined();
		expect(load({ enabled: true }).textImage).toEqual({ thresholdChars: 300 });
		expect(load({ enabled: true, thresholdChars: 800 }).textImage).toEqual({ thresholdChars: 800 });
	});

	test("rejects malformed values", () => {
		for (const value of [
			"yes",
			{ enabled: "yes" },
			{ thresholdChars: 10 },
			{ thresholdChars: 1.5 },
			{ thresholdChars: 9000 },
		])
			expect(() => load(value)).toThrow(/textImage/);
	});
});
