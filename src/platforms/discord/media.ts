/** Discord CDN attachment downloads. Only HTTPS Discord CDN hosts, no redirects, bounded bodies, sniffed bytes. */

import { readBoundedBody } from "../../net/read-bounded-body.ts";

const DISCORD_IMAGE_MAX_BYTES = 20 * 1024 * 1024;
const DISCORD_VIDEO_MAX_BYTES = 20 * 1024 * 1024;
const DISCORD_ATTACHMENT_HOSTS: Readonly<Record<string, true>> = {
	"cdn.discordapp.com": true,
	"media.discordapp.net": true,
	"attachments.discordapp.net": true,
};

export type DiscordImageMime = "image/jpeg" | "image/png" | "image/webp" | "image/gif";

export interface DiscordAttachmentRef {
	url: string;
	filename?: string;
	contentType?: string | null;
	size?: number;
}

export interface DownloadDiscordOptions {
	signal?: AbortSignal;
	maxBytes?: number;
	fetchImpl?: (input: URL, init?: RequestInit) => Promise<Response>;
}

function detectImageMime(bytes: Uint8Array): DiscordImageMime | null {
	const ascii = (start: number, end: number) => new TextDecoder().decode(bytes.subarray(start, end));
	if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
	if (
		bytes.length >= 8 &&
		[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((value, index) => bytes[index] === value)
	)
		return "image/png";
	if (bytes.length >= 6 && (ascii(0, 6) === "GIF87a" || ascii(0, 6) === "GIF89a")) return "image/gif";
	if (bytes.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
	return null;
}

async function downloadFromCdn(
	attachment: DiscordAttachmentRef,
	maxBytes: number,
	accept: string,
	options: DownloadDiscordOptions,
): Promise<Uint8Array | null> {
	if ((attachment.size ?? 0) > maxBytes) return null;
	let url: URL;
	try {
		url = new URL(attachment.url);
	} catch {
		return null;
	}
	if (
		url.protocol !== "https:" ||
		!Object.hasOwn(DISCORD_ATTACHMENT_HOSTS, url.hostname.toLowerCase()) ||
		url.username ||
		url.password
	)
		return null;
	try {
		const response = await (options.fetchImpl ?? fetch)(url, {
			signal: options.signal,
			redirect: "error",
			headers: { accept },
		});
		if (!response.ok) return null;
		return await readBoundedBody(response, maxBytes);
	} catch {
		return null;
	}
}

/** Download only Discord CDN image attachments and verify the actual bytes before use. */
export async function downloadDiscordImage(
	attachment: DiscordAttachmentRef,
	options: DownloadDiscordOptions = {},
): Promise<{ bytes: Uint8Array; mimeType: DiscordImageMime } | null> {
	if (attachment.contentType && !attachment.contentType.toLowerCase().startsWith("image/")) return null;
	const downloaded = await downloadFromCdn(
		attachment,
		options.maxBytes ?? DISCORD_IMAGE_MAX_BYTES,
		"image/png,image/jpeg,image/webp,image/gif",
		options,
	);
	if (!downloaded) return null;
	const mimeType = detectImageMime(downloaded);
	return mimeType ? { bytes: downloaded, mimeType } : null;
}

/** Download a Discord CDN video attachment (bytes are only handed to ffprobe/ffmpeg via argv, never a shell). */
export async function downloadDiscordVideo(
	attachment: DiscordAttachmentRef,
	options: DownloadDiscordOptions = {},
): Promise<Uint8Array | null> {
	if (!attachment.contentType?.toLowerCase().startsWith("video/")) return null;
	return downloadFromCdn(attachment, options.maxBytes ?? DISCORD_VIDEO_MAX_BYTES, "video/*", options);
}
