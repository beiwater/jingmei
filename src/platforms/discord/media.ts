/** Discord CDN attachment downloads. Only HTTPS Discord CDN hosts, no redirects, bounded bodies, sniffed bytes. */

import { type ImageMime, sniffImageMime } from "../../media/sniff-image.ts";
import { readBoundedBody } from "../../net/read-bounded-body.ts";

const DISCORD_IMAGE_MAX_BYTES = 20 * 1024 * 1024;
const DISCORD_VIDEO_MAX_BYTES = 20 * 1024 * 1024;
const DISCORD_ATTACHMENT_HOSTS: Readonly<Record<string, true>> = {
	"cdn.discordapp.com": true,
	"media.discordapp.net": true,
	"attachments.discordapp.net": true,
};

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
): Promise<{ bytes: Uint8Array; mimeType: ImageMime } | null> {
	if (attachment.contentType && !attachment.contentType.toLowerCase().startsWith("image/")) return null;
	const downloaded = await downloadFromCdn(
		attachment,
		options.maxBytes ?? DISCORD_IMAGE_MAX_BYTES,
		"image/png,image/jpeg,image/webp,image/gif",
		options,
	);
	if (!downloaded) return null;
	const mimeType = sniffImageMime(downloaded);
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
