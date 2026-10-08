import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NodeCompiler } from "@myriaddreamin/typst-ts-node-compiler";
import { parsePublicHttpUrl } from "../net/public-url.ts";
import { readBoundedBody } from "../net/read-bounded-body.ts";

/** Longest Markdown source one image may be rendered from. */
export const TEXT_IMAGE_MAX_CHARS = 8_000;
const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const IMAGE_TIMEOUT_MS = 10_000;
/** Telegram `sendPhoto` accepts 10 MB and width + height <= 10000 px. */
const MAX_PNG_BYTES = 9_000_000;
const MAX_HEIGHT_PX = 8_000;
const PAGE_WIDTH_PT = 360;
const ZOOMS = [2, 1] as const;

/** Typst workspace root: an empty private directory, so the compiler can read nothing else on disk. */
const TYPST_DIR = join(tmpdir(), "jingmei-text-image");
/** CJK fonts come from the system (Linux: `fonts-noto-cjk`); the first match per glyph wins. */
const FONTS = ["Noto Sans CJK SC", "Noto Sans SC", "Microsoft YaHei", "PingFang SC"];
const FONT = `(${FONTS.map((name) => JSON.stringify(name)).join(", ")})`;

export type TextImageErrorCode = "invalid_input" | "render_failed" | "too_large";

export class TextImageError extends Error {
	constructor(readonly code: TextImageErrorCode) {
		super(`Text image rendering failed: ${code}`);
		this.name = "TextImageError";
	}
}

export interface TextImage {
	data: Uint8Array;
	contentType: "image/png";
}

/** Renders Markdown (with `$…$` LaTeX math and public image URLs) to one PNG. */
export type TextImageRenderer = (markdown: string) => Promise<TextImage>;

/** `![alt](url)` and `![alt](url "title")`; the capture groups are alt and url. */
const IMAGE_SYNTAX = /!\[([^\]\n]*)\]\(\s*<?([^)\s>]+)>?(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g;

interface LoadedImage {
	name: string;
	data: Uint8Array;
}

function imageExtension(bytes: Uint8Array): "png" | "jpg" | "gif" | "webp" | null {
	const at = (index: number) => bytes[index];
	if (at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47) return "png";
	if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return "jpg";
	if (at(0) === 0x47 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x38) return "gif";
	if (at(0) === 0x52 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x46 && at(8) === 0x57 && at(9) === 0x45)
		return "webp";
	return null;
}

/** One public image, or null. Redirects are refused so a public URL cannot bounce to a private host. */
async function fetchImage(url: string, fetchImpl: typeof fetch): Promise<{ data: Uint8Array; ext: string } | null> {
	const parsed = parsePublicHttpUrl(url);
	if (!parsed) return null;
	try {
		const response = await fetchImpl(parsed.url, {
			signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS),
			redirect: "error",
			headers: { accept: "image/png,image/jpeg,image/gif,image/webp" },
		});
		if (!response.ok) return null;
		const data = await readBoundedBody(response, MAX_IMAGE_BYTES);
		const ext = data && imageExtension(data);
		return data && ext ? { data, ext } : null;
	} catch {
		return null;
	}
}

/**
 * Downloads every `![](url)` image up to the cap and points the Markdown at the local copy.
 * Anything unavailable becomes a short text placeholder instead of failing the whole render.
 */
async function inlineImages(
	markdown: string,
	fetchImpl: typeof fetch,
): Promise<{ markdown: string; images: LoadedImage[] }> {
	const matches = [...markdown.matchAll(IMAGE_SYNTAX)];
	const fetched = await Promise.all(matches.slice(0, MAX_IMAGES).map((match) => fetchImage(match[2]!, fetchImpl)));
	const images: LoadedImage[] = [];
	let index = 0;
	const rewritten = markdown.replace(IMAGE_SYNTAX, (_whole, alt: string) => {
		const image = fetched[index++];
		if (!image) return `（图片无法显示${alt ? `：${alt}` : ""}）`;
		const name = `img-${images.length}.${image.ext}`;
		images.push({ name, data: image.data });
		return `![${alt}](${name})`;
	});
	return { markdown: rewritten, images };
}

/**
 * Everything user-controlled reaches Typst only as data (`doc.md`, image bytes), never as source:
 * cmarker's raw Typst is off, raw HTML `<svg>`/`<a>` handlers are neutralised, and `image` is
 * restricted to the files fetched for this render.
 */
function mainSource(imageNames: readonly string[]): string {
	const allowed = `(${imageNames.map((name) => JSON.stringify(name)).join(", ")}${imageNames.length === 1 ? "," : ""})`;
	return `
#import "@preview/cmarker:0.1.8"
#import "@preview/mitex:0.2.7": mitex
#let allowed-images = ${allowed}
#set page(width: ${PAGE_WIDTH_PT}pt, height: auto, margin: 18pt, fill: white)
#set text(font: ${FONT}, size: 10.5pt, lang: "zh", fill: rgb("#1f2328"))
#set par(leading: 0.8em)
#show heading: set block(above: 1.1em, below: 0.6em)
#show raw: set text(font: ("DejaVu Sans Mono", "Noto Sans Mono CJK SC", "Noto Sans CJK SC", "Microsoft YaHei"), size: 9pt)
#show raw.where(block: true): it => block(fill: rgb("#f3f4f6"), inset: 8pt, radius: 4pt, width: 100%, it)
#show raw.where(block: false): it => box(fill: rgb("#f3f4f6"), inset: (x: 3pt), outset: (y: 3pt), radius: 2pt, it)
#set table(stroke: 0.5pt + rgb("#c9ced6"), inset: 6pt)
#show quote: it => block(stroke: (left: 2.5pt + rgb("#9ca3af")), inset: (left: 10pt, y: 4pt), text(fill: rgb("#4b5563"), it.body))
#cmarker.render(
  read("/doc.md"),
  math: mitex,
  raw-typst: false,
  html: (svg: ("raw-text", (attrs, body) => none), a: (attrs, body) => body),
  blockquote: it => quote(block: true, it),
  scope: (image: (source, ..args) => if type(source) == str and allowed-images.contains(source) {
    image(source, width: 100%, ..args)
  } else { [（图片无法显示）] }),
)
`;
}

let compiler: Promise<NodeCompiler> | undefined;

/** Lazy: the native module loads only when text images are actually used. */
function getCompiler(): Promise<NodeCompiler> {
	compiler ??= import("@myriaddreamin/typst-ts-node-compiler").then(({ NodeCompiler }) => {
		mkdirSync(TYPST_DIR, { recursive: true, mode: 0o700 });
		return NodeCompiler.create({ workspace: TYPST_DIR });
	});
	return compiler;
}

/** True when none of the CJK fonts is installed: Typst renders no error, only empty boxes for hanzi. */
export async function cjkFontMissing(): Promise<boolean> {
	const typst = await getCompiler();
	const warnings = typst.compile({ mainFileContent: `#set text(font: ${FONT})\n汉` }).takeWarnings();
	const unknown = warnings
		? typst.fetchDiagnostics(warnings).filter((item) => String(item.message).startsWith("unknown font family"))
		: [];
	return unknown.length >= FONTS.length;
}

async function toPng(svg: string): Promise<Uint8Array> {
	const { Resvg } = await import("@resvg/resvg-js");
	for (const zoom of ZOOMS) {
		const resvg = new Resvg(svg, { fitTo: { mode: "zoom", value: zoom }, font: { loadSystemFonts: false } });
		if (Math.ceil(resvg.height * zoom) > MAX_HEIGHT_PX) continue;
		const png = resvg.render().asPng();
		if (png.byteLength > MAX_PNG_BYTES) continue;
		return png;
	}
	throw new TextImageError("too_large");
}

export async function renderTextImage(markdown: string, options: { fetch?: typeof fetch } = {}): Promise<TextImage> {
	const source = markdown.trim();
	if (!source || source.length > TEXT_IMAGE_MAX_CHARS) throw new TextImageError("invalid_input");
	const { markdown: prepared, images } = await inlineImages(source, options.fetch ?? fetch);
	const typst = await getCompiler().catch(() => {
		throw new TextImageError("render_failed");
	});
	const shadows = [{ name: "doc.md", data: Buffer.from(prepared) }, ...images];
	let svg: string;
	try {
		for (const shadow of shadows) typst.mapShadow(join(TYPST_DIR, shadow.name), Buffer.from(shadow.data));
		const compiled = typst.compile({ mainFileContent: mainSource(images.map((image) => image.name)) });
		if (compiled.hasError() || !compiled.result) throw new TextImageError("render_failed");
		svg = typst.svg(compiled.result);
	} catch (error) {
		throw error instanceof TextImageError ? error : new TextImageError("render_failed");
	} finally {
		for (const shadow of shadows) typst.unmapShadow(join(TYPST_DIR, shadow.name));
		typst.evictCache(10);
	}
	try {
		return { data: await toPng(svg), contentType: "image/png" };
	} catch (error) {
		throw error instanceof TextImageError ? error : new TextImageError("render_failed");
	}
}
