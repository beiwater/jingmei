// Generates the site's pages from README.md, README.en.md and docs/*.md so the repository docs stay the
// only source. Runs before every dev server and build; the output directories are gitignored.
// Fails loudly when a README `##` section is not placed in pages.ts or a relative link has no target.

import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, posix, relative } from "node:path";
import GithubSlugger from "github-slugger";
import { allPages, type Lang, langRoot, type Page, pageLink, pageTitle, readmeFile, skipped } from "./pages.ts";

const site = import.meta.dir;
const repo = join(site, "..");
const blob = "https://github.com/beiwater/jingmei/blob/main/";
const langs: Lang[] = ["zh", "en"];

interface Heading {
	line: number;
	level: number;
	text: string;
}

/** Calls `visit` for each line outside fenced code blocks. */
function eachProseLine(lines: string[], visit: (line: string, index: number) => void): void {
	let fence = "";
	lines.forEach((line, index) => {
		const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
		if (fence) {
			if (marker && marker[0] === fence[0] && marker.length >= fence.length && line.trim() === marker) fence = "";
			return;
		}
		if (marker) {
			fence = marker;
			return;
		}
		visit(line, index);
	});
}

function headings(lines: string[]): Heading[] {
	const found: Heading[] = [];
	eachProseLine(lines, (line, index) => {
		const match = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
		if (match) found.push({ line: index, level: match[1]!.length, text: match[2]! });
	});
	return found;
}

/** Plain heading text as GitHub and VitePress slug it. */
const plain = (text: string) => text.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[`*]/g, "");

interface Chunk {
	/** Repository-relative source file. */
	file: string;
	/** Source line range [start, end). */
	start: number;
	end: number;
	/** Added to every heading level (-1 promotes `##` page sections to the page title). */
	shift: number;
}

interface Output {
	page: Page;
	lang: Lang;
	/** File path relative to the site root. */
	out: string;
	url: string;
	title?: string;
	chunks: Chunk[];
}

const read = (file: string) => readFileSync(join(repo, file), "utf8").split("\n");
const sources = new Map<string, string[]>();
const source = (file: string) => sources.get(file) ?? sources.set(file, read(file)).get(file)!;

function outputs(): Output[] {
	const result: Output[] = [];
	const missing: string[] = [];
	for (const lang of langs) {
		const file = readmeFile[lang];
		const lines = source(file);
		const sections = new Map<string, Chunk>();
		const tops = headings(lines).filter((heading) => heading.level === 2);
		// The introduction starts after the centered logo/badge block.
		const introStart = lines.findIndex((line) => line.trim() === "</div>") + 1;
		sections.set("", { file, start: introStart, end: tops[0]?.line ?? lines.length, shift: 0 });
		tops.forEach((heading, index) => {
			const end = tops[index + 1]?.line ?? lines.length;
			sections.set(heading.text, { file, start: heading.line, end, shift: 0 });
		});
		const placed = new Set([...skipped[lang], ...allPages.flatMap((page) => page.readme?.[lang] ?? [])]);
		for (const name of sections.keys()) if (!placed.has(name)) missing.push(`${file}: "## ${name}"`);
		for (const page of allPages) {
			if (!page.readme) continue;
			const names = page.readme[lang];
			const chunks = names.map((name) => {
				const chunk = sections.get(name);
				if (!chunk) throw new Error(`pages.ts names "${name}", but ${file} has no such "##" section`);
				return { ...chunk, shift: names.length === 1 ? -1 : 0 };
			});
			const out = langRoot[lang].slice(1) + page.path + (page.path.endsWith("/") ? "index.md" : ".md");
			const title = names.length === 1 ? undefined : pageTitle(page, lang);
			result.push({ page, lang, out, url: pageLink(page, lang), title, chunks });
		}
	}
	if (missing.length > 0) {
		throw new Error(`README sections not placed on any page; add them to website/pages.ts:\n${missing.join("\n")}`);
	}
	for (const page of allPages) {
		if (!page.doc) continue;
		const lines = source(page.doc);
		const out = page.path + (page.path.endsWith("/") ? "index.md" : ".md");
		result.push({
			page,
			lang: "zh",
			out,
			url: pageLink(page, "zh"),
			chunks: [{ file: page.doc, start: 0, end: lines.length, shift: 0 }],
		});
	}
	return result;
}

interface Target {
	url: string;
	/** Anchor on the target page; empty for the page title. */
	slug: string;
}

/** Maps `file#github-slug` (and bare `file`) to where that heading ends up on the site. */
function anchorIndex(pages: Output[]): Map<string, Target> {
	const index = new Map<string, Target>();
	index.set("README.md", { url: "/", slug: "" });
	index.set("README.en.md", { url: "/en/", slug: "" });
	const pageSlugs = new Map<string, Map<number, string>>(); // `${file}:${line}` keyed per page
	for (const page of pages) {
		const slugger = new GithubSlugger();
		if (page.title) slugger.slug(page.title);
		const lineSlugs = new Map<number, string>();
		for (const chunk of page.chunks) {
			for (const heading of headings(source(chunk.file))) {
				if (heading.line < chunk.start || heading.line >= chunk.end) continue;
				const level = heading.level + chunk.shift;
				lineSlugs.set(heading.line, level === 1 ? "" : slugger.slug(plain(heading.text)));
			}
		}
		pageSlugs.set(page.out, lineSlugs);
		if (page.page.doc) index.set(page.page.doc, { url: page.url, slug: "" });
	}
	for (const file of sources.keys()) {
		const slugger = new GithubSlugger();
		for (const heading of headings(source(file))) {
			const fileSlug = slugger.slug(plain(heading.text));
			const page = pages.find((candidate) =>
				candidate.chunks.some(
					(chunk) => chunk.file === file && heading.line >= chunk.start && heading.line < chunk.end,
				),
			);
			if (!page) continue;
			index.set(`${file}#${fileSlug}`, { url: page.url, slug: pageSlugs.get(page.out)!.get(heading.line)! });
		}
	}
	return index;
}

function rewrite(page: Output, file: string, href: string, index: Map<string, Target>): string {
	if (/^[a-z][a-z0-9+.-]*:|^\/\//i.test(href)) return href;
	const [path = "", hash] = href.split("#") as [string, string | undefined];
	const resolved = path ? posix.normalize(posix.join(posix.dirname(file), path)) : file;
	if (resolved.startsWith("assets/")) {
		return relative(dirname(join(site, page.out)), join(repo, resolved))
			.split("\\")
			.join("/");
	}
	const key = hash ? `${resolved}#${decodeURIComponent(hash)}` : resolved;
	const target = index.get(key);
	if (target) {
		if (target.url === page.url && target.slug) return `#${target.slug}`;
		return target.slug ? `${target.url}#${target.slug}` : target.url;
	}
	if (hash && index.has(resolved)) {
		throw new Error(`${file}: link "${href}" points at a heading that is not on the site`);
	}
	return blob + resolved + (hash ? `#${hash}` : "");
}

// Inline code spans, markdown link targets and raw <img src>, in one pass so code is never rewritten.
const inline = /(`+)[\s\S]*?(?<!`)\1(?!`)|(\]\()([^)\s]+)(\))|(<img\s[^>]*?src=")([^"]+)(")/g;

function render(page: Output, index: Map<string, Target>): string {
	const parts: string[] = [];
	if (page.title) parts.push(`# ${page.title}\n`);
	for (const chunk of page.chunks) {
		const lines = source(chunk.file).slice(chunk.start, chunk.end);
		const prose = new Set<number>();
		eachProseLine(lines, (_, i) => prose.add(i));
		const body = lines.map((line, i) => {
			if (!prose.has(i)) return line;
			const heading = /^(#{1,6})(\s.*)$/.exec(line);
			if (heading && chunk.shift) line = "#".repeat(heading[1]!.length + chunk.shift) + heading[2];
			return line.replace(inline, (match, _tick, open, href, close, imgOpen, src, imgClose) => {
				if (open) return open + rewrite(page, chunk.file, href, index) + close;
				if (imgOpen) return imgOpen + rewrite(page, chunk.file, src, index) + imgClose;
				return match;
			});
		});
		parts.push(body.join("\n").trim(), "");
	}
	return parts.join("\n");
}

const pages = outputs();
const index = anchorIndex(pages);
for (const lang of langs) {
	for (const dir of ["guide", "features", "reference", "dev"])
		rmSync(join(site, langRoot[lang], dir), { recursive: true, force: true });
}
for (const page of pages) {
	const out = join(site, page.out);
	mkdirSync(dirname(out), { recursive: true });
	writeFileSync(out, render(page, index));
}
mkdirSync(join(site, "public"), { recursive: true });
copyFileSync(join(repo, "assets/logo.webp"), join(site, "public/logo.webp"));
console.log(`synced ${pages.length} pages`);
