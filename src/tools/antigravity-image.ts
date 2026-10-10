import { readBoundedBody } from "../net/read-bounded-body.ts";

/** Pi provider id of the `pi-provider-antigravity` extension whose login this client reuses. */
export const ANTIGRAVITY_PROVIDER_ID = "antigravity";
export const DEFAULT_IMAGE_MODEL = "gemini-3.1-flash-image";
export const IMAGE_ASPECT_RATIOS = ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"] as const;
export type ImageAspectRatio = (typeof IMAGE_ASPECT_RATIOS)[number];

const ENDPOINT = "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse";
// Same client identity as pi-provider-antigravity 0.13.0, which owns the login this request reuses.
const USER_AGENT =
	"antigravity/cli/1.2.5 (aidev_client; os_type=linux; arch=amd64; cl=982839923; auth_method=consumer)";
const DEFAULT_TIMEOUT_MS = 90_000;
const MAX_PROMPT_LENGTH = 2_000;
const MAX_RESPONSE_BYTES = 40 * 1024 * 1024;
/** Discord's default upload limit and Telegram's sendPhoto limit. */
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

export type AntigravityImageErrorCode =
	| "invalid_input"
	| "invalid_credential"
	| "rate_limited"
	| "http_error"
	| "invalid_response"
	| "no_image"
	| "image_too_large"
	| "timeout"
	| "network_error";

/** Safe, stable error codes; tokens and provider response bodies are never included. */
export class AntigravityImageError extends Error {
	constructor(public readonly code: AntigravityImageErrorCode) {
		super(`Antigravity image generation failed: ${code}`);
		this.name = "AntigravityImageError";
	}
}

export interface GeneratedImage {
	data: Uint8Array;
	contentType: "image/png" | "image/jpeg";
}

export interface AntigravityImageOptions {
	model?: string;
	aspectRatio?: ImageAspectRatio;
	fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
	timeoutMs?: number;
}

/** The extension stores `{ token, projectId }` as the provider's request API key. */
function parseCredential(apiKey: string): { token: string; projectId: string } {
	try {
		const parsed = JSON.parse(apiKey) as { token?: unknown; projectId?: unknown };
		if (typeof parsed.token === "string" && parsed.token && typeof parsed.projectId === "string" && parsed.projectId)
			return { token: parsed.token, projectId: parsed.projectId };
	} catch {
		// Fall through: a bare or malformed key is not a usable Antigravity credential.
	}
	throw new AntigravityImageError("invalid_credential");
}

interface ResponsePart {
	thought?: boolean;
	inlineData?: { mimeType?: string; data?: string };
}

/** The last final (non-thought) PNG/JPEG part across all SSE events. */
function extractImage(sse: string): GeneratedImage {
	let image: GeneratedImage | undefined;
	let sawEvent = false;
	for (const line of sse.split("\n")) {
		if (!line.startsWith("data:")) continue;
		let event: { response?: { candidates?: Array<{ content?: { parts?: ResponsePart[] } }> } };
		try {
			event = JSON.parse(line.slice(5));
		} catch {
			throw new AntigravityImageError("invalid_response");
		}
		sawEvent = true;
		for (const part of event.response?.candidates?.[0]?.content?.parts ?? []) {
			const mimeType = part.inlineData?.mimeType;
			if (part.thought || !part.inlineData?.data || (mimeType !== "image/png" && mimeType !== "image/jpeg")) continue;
			if (part.inlineData.data.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4)
				throw new AntigravityImageError("image_too_large");
			image = { data: Buffer.from(part.inlineData.data, "base64"), contentType: mimeType };
		}
	}
	if (!sawEvent) throw new AntigravityImageError("invalid_response");
	if (!image || image.data.byteLength === 0) throw new AntigravityImageError("no_image");
	return image;
}

/** Generate one image with the Antigravity credential resolved by Pi (already refreshed). */
export async function generateAntigravityImage(
	apiKey: string,
	prompt: string,
	options: AntigravityImageOptions = {},
): Promise<GeneratedImage> {
	if (!prompt.trim() || prompt.length > MAX_PROMPT_LENGTH) throw new AntigravityImageError("invalid_input");
	const { token, projectId } = parseCredential(apiKey);
	const signal = AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
	try {
		const response = await (options.fetch ?? fetch)(ENDPOINT, {
			method: "POST",
			headers: { "User-Agent": USER_AGENT, "Content-Type": "application/json", Authorization: `Bearer ${token}` },
			body: JSON.stringify({
				project: projectId,
				model: options.model ?? DEFAULT_IMAGE_MODEL,
				userAgent: "antigravity",
				requestType: "image_gen",
				requestId: `image_gen/${Date.now()}/${crypto.randomUUID()}/12`,
				request: {
					contents: [{ role: "user", parts: [{ text: prompt.trim() }] }],
					generationConfig: { candidateCount: 1, imageConfig: { aspectRatio: options.aspectRatio ?? "1:1" } },
				},
			}),
			signal,
		});
		if (response.status === 429) throw new AntigravityImageError("rate_limited");
		if (!response.ok) throw new AntigravityImageError("http_error");
		const body = await readBoundedBody(response, MAX_RESPONSE_BYTES);
		if (!body) throw new AntigravityImageError("image_too_large");
		return extractImage(new TextDecoder().decode(body));
	} catch (error) {
		if (error instanceof AntigravityImageError) throw error;
		if (signal.aborted) throw new AntigravityImageError("timeout");
		throw new AntigravityImageError("network_error");
	}
}
