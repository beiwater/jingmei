// Site map shared by sync.ts (page generation) and .vitepress/config.ts (sidebar, edit links).
// Every page body comes from README.md / README.en.md / docs/*.md; this file only says where it goes.

export type Lang = "zh" | "en";
type Text = Record<Lang, string>;

export interface Page {
	/** Output path without extension, relative to the language root. */
	path: string;
	/** Required when the page joins several README sections; single-section pages use the heading. */
	title?: Text;
	/** README `##` headings in page order; "" is the introduction before the first heading. */
	readme?: Record<Lang, string[]>;
	/** A document under docs/ (Chinese only), published once at `path` and linked from both sidebars. */
	doc?: string;
	docTitle?: Text;
}

export interface Group {
	text: Text;
	pages: Page[];
}

const section = (zh: string, en: string): Page["readme"] => ({ zh: [zh], en: [en] });

export const groups: Group[] = [
	{
		text: { zh: "指南", en: "Guide" },
		pages: [
			{
				path: "guide/",
				title: { zh: "介绍", en: "Introduction" },
				readme: { zh: ["", "能做什么", "架构一览"], en: ["", "What it does", "Architecture at a glance"] },
			},
			{ path: "guide/quick-start", readme: section("快速开始", "Quick start") },
			{ path: "guide/discord", readme: section("Discord 设置", "Discord setup") },
			{ path: "guide/telegram", readme: section("Telegram 设置", "Telegram setup") },
			{ path: "guide/deploy", doc: "docs/deploy.md", docTitle: { zh: "部署", en: "Deployment (中文)" } },
		],
	},
	{
		text: { zh: "功能", en: "Features" },
		pages: [
			{ path: "features/", readme: section("可选功能", "Optional features") },
			{ path: "features/drawing", readme: section("画图", "Drawing") },
			{ path: "features/kline", readme: section("K 线图", "Candlestick charts") },
			{ path: "features/text-image", readme: section("长文转图", "Long text as an image") },
			{ path: "features/jev", readme: section("Jev", "Jev") },
			{ path: "features/telemetry", readme: section("使用统计", "Usage statistics") },
		],
	},
	{
		text: { zh: "参考", en: "Reference" },
		pages: [
			{ path: "reference/commands", readme: section("命令", "Commands") },
			{ path: "reference/cli", readme: section("运维命令", "Operator commands") },
			{ path: "reference/config", readme: section("配置参考", "Configuration reference") },
		],
	},
	{
		text: { zh: "开发", en: "Development" },
		pages: [
			{
				path: "dev/",
				title: { zh: "参与开发", en: "Contributing" },
				readme: {
					zh: ["开发", "参与贡献", "安全", "许可证"],
					en: ["Development", "Contributing", "Security", "License"],
				},
			},
			{
				path: "dev/architecture",
				doc: "docs/architecture.md",
				docTitle: { zh: "架构", en: "Architecture (中文)" },
			},
			{ path: "dev/testing", doc: "docs/testing.md", docTitle: { zh: "测试", en: "Testing (中文)" } },
		],
	},
];

/** README sections that are not published because a docs/ page covers them in full. */
export const skipped: Record<Lang, string[]> = { zh: ["部署"], en: ["Deployment"] };

export const readmeFile: Record<Lang, string> = { zh: "README.md", en: "README.en.md" };

/** URL prefix of a language root. */
export const langRoot: Record<Lang, string> = { zh: "/", en: "/en/" };

/** Site URL of a page in a language; docs/ pages exist only under the Chinese root. */
export function pageLink(page: Page, lang: Lang): string {
	return (page.doc ? "/" : langRoot[lang]) + page.path;
}

export function pageTitle(page: Page, lang: Lang): string {
	if (page.doc) return page.docTitle![lang];
	return page.title?.[lang] ?? page.readme![lang][0]!;
}

export const allPages = groups.flatMap((group) => group.pages);
