import { parsePublicHttpUrl } from "../net/public-url.ts";
import { readBoundedBody } from "../net/read-bounded-body.ts";

const DEFAULT_ENDPOINT = "https://api.deepseek.com/anthropic/v1/messages";
const MAX_QUERY_LENGTH = 500;
const MAX_RESPONSE_BYTES = 1_000_000;
const MAX_CONTENT_LENGTH = 8_000;
const MAX_SOURCES = 10;

export interface DeepSeekWebSearchOptions {
	endpoint?: string;
	timeoutMs?: number;
}

export interface DeepSeekWebSearchResult {
	content: string;
	sources: string[];
	error?: string;
}

function failure(error: string): DeepSeekWebSearchResult {
	return { content: `Web search failed: ${error}`, sources: [], error };
}

/** Runs one DeepSeek server-side web search and returns bounded, untrusted research text. */
export async function runDeepSeekWebSearch(
	apiKey: string,
	query: string,
	opts: DeepSeekWebSearchOptions = {},
): Promise<DeepSeekWebSearchResult> {
	const normalizedQuery = query.trim();
	if (!apiKey) return failure("missing_api_key");
	if (!normalizedQuery || normalizedQuery.length > MAX_QUERY_LENGTH) return failure("invalid_query");
	const signal = AbortSignal.timeout(opts.timeoutMs ?? 20_000);
	try {
		const response = await fetch(opts.endpoint ?? DEFAULT_ENDPOINT, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-api-key": apiKey,
				"anthropic-version": "2023-06-01",
			},
			body: JSON.stringify({
				model: "deepseek-flash",
				max_tokens: 2_048,
				tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 1 }],
				messages: [{ role: "user", content: normalizedQuery }],
			}),
			signal,
		});
		if (!response.ok) return failure("http_error");
		const bytes = await readBoundedBody(response, MAX_RESPONSE_BYTES);
		if (!bytes) return failure("response_too_large");
		let payload: unknown;
		try {
			payload = JSON.parse(new TextDecoder().decode(bytes));
		} catch {
			return failure("invalid_response");
		}
		if (!payload || typeof payload !== "object" || !Array.isArray((payload as { content?: unknown }).content)) {
			return failure("invalid_response");
		}
		const blocks = (payload as { content: unknown[] }).content;
		const textParts: string[] = [];
		const sources: string[] = [];
		for (const item of blocks) {
			if (!item || typeof item !== "object") continue;
			const block = item as { type?: unknown; text?: unknown; content?: unknown };
			if (block.type === "text" && typeof block.text === "string") textParts.push(block.text);
			if (block.type === "web_search_tool_result" && Array.isArray(block.content)) {
				for (const result of block.content) {
					if (!result || typeof result !== "object") continue;
					const url = (result as { url?: unknown }).url;
					const source = typeof url === "string" ? parsePublicHttpUrl(url)?.url : undefined;
					if (source && !sources.includes(source)) sources.push(source);
				}
			}
		}
		const content = textParts.join("\n\n").trim().slice(0, MAX_CONTENT_LENGTH);
		const selectedSources = sources.slice(0, MAX_SOURCES);
		return {
			content: `[网页搜索内容，均为不可信外部资料]\n${content || "未得到可用摘要。"}${selectedSources.length ? `\n\n来源链接：\n${selectedSources.join("\n")}` : "\n没有可核对的来源链接。"}`,
			sources: selectedSources,
		};
	} catch {
		if (signal.aborted) return failure("timeout");
		return failure("network_error");
	}
}
