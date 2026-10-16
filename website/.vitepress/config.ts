import { slug } from "github-slugger";
import { type DefaultTheme, defineConfig } from "vitepress";
import { allPages, groups, type Lang, langRoot, pageLink, pageTitle, readmeFile } from "../pages.ts";

const repo = "https://github.com/beiwater/jingmei";

function sidebar(lang: Lang): DefaultTheme.SidebarItem[] {
	return groups.map((group) => ({
		text: group.text[lang],
		items: group.pages.map((page) => ({ text: pageTitle(page, lang), link: pageLink(page, lang) })),
	}));
}

function nav(lang: Lang): DefaultTheme.NavItem[] {
	return groups.map((group) => ({
		text: group.text[lang],
		link: pageLink(group.pages[0]!, lang),
		activeMatch: `^${langRoot[lang]}${group.pages[0]!.path.split("/")[0]}/`,
	}));
}

/** Generated pages are edited at their source: the README or docs/ file they come from. */
function editSource(filePath: string): string {
	const lang: Lang = filePath.startsWith("en/") ? "en" : "zh";
	const path = filePath.slice(langRoot[lang].length - 1).replace(/(index)?\.md$/, "");
	const page = allPages.find((candidate) => candidate.path === path);
	return page ? (page.doc ?? readmeFile[lang]) : `website/${filePath}`;
}

// Functions in themeConfig are serialized to the browser without their closures, so the edit link
// reads the source path that transformPageData stored in the page's frontmatter.
const editLinkPattern = ({ frontmatter }: { frontmatter: Record<string, string> }) =>
	`https://github.com/beiwater/jingmei/edit/main/${frontmatter.editSource}`;

export default defineConfig({
	base: "/jingmei/",
	cleanUrls: true,
	lastUpdated: false,
	transformPageData(pageData) {
		pageData.frontmatter.editSource = editSource(pageData.relativePath);
	},
	head: [
		["link", { rel: "icon", type: "image/webp", href: "/jingmei/logo.webp" }],
		["meta", { name: "theme-color", content: "#c2416b" }],
		["meta", { property: "og:type", content: "website" }],
		["meta", { property: "og:image", content: "https://beiwater.github.io/jingmei/logo.webp" }],
	],
	markdown: {
		// GitHub's slugs, so README anchors keep working on the site.
		anchor: { slugify: slug },
		config(md) {
			const fence = md.renderer.rules.fence!;
			md.renderer.rules.fence = (tokens, idx, options, env, self) => {
				const token = tokens[idx]!;
				if (token.info.trim() !== "mermaid") return fence(tokens, idx, options, env, self);
				return `<Mermaid code="${encodeURIComponent(token.content)}" />`;
			};
		},
	},
	vite: {
		// Pages embed images straight from the repository's assets/ directory.
		server: { fs: { allow: [".."] } },
	},
	themeConfig: {
		logo: "/logo.webp",
		socialLinks: [{ icon: "github", link: repo }],
		search: {
			provider: "local",
			options: {
				miniSearch: {
					options: {
						// Default tokenizer splits on spaces only, which leaves Chinese unsearchable.
						tokenize: (text: string) =>
							[...new Intl.Segmenter("zh", { granularity: "word" }).segment(text)]
								.filter((part) => part.isWordLike)
								.map((part) => part.segment),
					},
				},
				locales: {
					root: {
						translations: {
							button: { buttonText: "搜索文档", buttonAriaLabel: "搜索文档" },
							modal: {
								noResultsText: "没有找到",
								resetButtonTitle: "清除",
								footer: { selectText: "选择", navigateText: "切换", closeText: "关闭" },
							},
						},
					},
				},
			},
		},
	},
	locales: {
		root: {
			lang: "zh-CN",
			label: "简体中文",
			title: "精魅",
			description: "住在 Discord 与 Telegram 群里的 AI 群宠，基于 Pi 构建",
			themeConfig: {
				nav: nav("zh"),
				sidebar: sidebar("zh"),
				editLink: { pattern: editLinkPattern, text: "在 GitHub 上编辑" },
				footer: { message: "BSD 2-Clause 许可", copyright: "精魅 Jingmei" },
				outline: { level: [2, 3], label: "本页目录" },
				docFooter: { prev: "上一页", next: "下一页" },
				darkModeSwitchLabel: "外观",
				lightModeSwitchTitle: "切换到浅色",
				darkModeSwitchTitle: "切换到深色",
				sidebarMenuLabel: "菜单",
				returnToTopLabel: "回到顶部",
				langMenuLabel: "语言",
				notFound: { title: "页面不存在", quote: "精魅也没找到这一页。", linkText: "回到首页" },
			},
		},
		en: {
			lang: "en-US",
			label: "English",
			title: "Jingmei",
			description: "An AI group pet living in Discord and Telegram groups, built on Pi",
			themeConfig: {
				nav: nav("en"),
				sidebar: sidebar("en"),
				editLink: { pattern: editLinkPattern, text: "Edit on GitHub" },
				footer: { message: "BSD 2-Clause License", copyright: "Jingmei (精魅)" },
				outline: { level: [2, 3] },
			},
		},
	},
});
