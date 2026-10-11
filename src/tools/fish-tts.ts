import { readBoundedBody } from "../net/read-bounded-body.ts";

const DEFAULT_ENDPOINT = "https://api.fish.audio/v1/tts";
const DEFAULT_MODEL = "s2.1-pro-free";
const DEFAULT_TIMEOUT_MS = 45_000;
const MAX_TEXT_LENGTH = 4_000;
const MAX_AUDIO_BYTES = 8 * 1024 * 1024;

export type FishAudioTtsErrorCode =
	| "missing_api_key"
	| "invalid_input"
	| "http_error"
	| "invalid_response"
	| "audio_too_large"
	| "timeout"
	| "network_error";

/** Safe, stable error codes; provider response bodies and credentials are never included. */
export class FishAudioTtsError extends Error {
	constructor(public readonly code: FishAudioTtsErrorCode) {
		super(`Fish Audio TTS failed: ${code}`);
		this.name = "FishAudioTtsError";
	}
}

export interface FishAudioTtsOptions {
	model?: string;
	fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
	timeoutMs?: number;
}

/** Generate an MP3 from Fish Audio and return the binary audio for a chat attachment. */
export async function synthesizeFishAudioTts(
	apiKey: string,
	text: string,
	referenceId: string,
	options: FishAudioTtsOptions = {},
): Promise<Uint8Array> {
	if (!apiKey.trim()) throw new FishAudioTtsError("missing_api_key");
	if (!text.trim() || text.length > MAX_TEXT_LENGTH || !referenceId.trim() || referenceId.length > 256) {
		throw new FishAudioTtsError("invalid_input");
	}

	const signal = AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
	try {
		const response = await (options.fetch ?? fetch)(DEFAULT_ENDPOINT, {
			method: "POST",
			headers: {
				authorization: `Bearer ${apiKey}`,
				"content-type": "application/json",
				model: options.model ?? DEFAULT_MODEL,
			},
			body: JSON.stringify({ text, reference_id: referenceId, format: "mp3" }),
			signal,
		});
		if (!response.ok) throw new FishAudioTtsError("http_error");
		const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
		if (contentType.includes("application/json") || contentType.includes("text/")) {
			throw new FishAudioTtsError("invalid_response");
		}
		const audio = await readBoundedBody(response, MAX_AUDIO_BYTES);
		if (!audio) throw new FishAudioTtsError("audio_too_large");
		if (audio.byteLength === 0) throw new FishAudioTtsError("invalid_response");
		return audio;
	} catch (error) {
		if (error instanceof FishAudioTtsError) throw error;
		if (signal.aborted) throw new FishAudioTtsError("timeout");
		throw new FishAudioTtsError("network_error");
	}
}
