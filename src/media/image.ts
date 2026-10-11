/** Platform-neutral still-image preparation for model context. */

import { convertToPng, resizeImage } from "@earendil-works/pi-coding-agent";
import type { InboundImage } from "../core/types.ts";

export const IMAGE_LIMITS = { maxWidth: 1024, maxHeight: 1024, maxBytes: 200_000, jpegQuality: 80 } as const;

/**
 * Convert (WebP/GIF→PNG via Pi convertToPng) and resize (Pi resizeImage) raw bytes to a model-ready still.
 * Both Pi functions report failure as null and never reject.
 */
export async function prepareImage(
	bytes: Uint8Array,
	mimeType: string,
): Promise<{ ok: true; image: InboundImage } | { ok: false; reason: string }> {
	let current = bytes;
	let mime = mimeType.toLowerCase();
	if (mime === "image/webp" || mime === "image/gif") {
		const converted = await convertToPng(Buffer.from(current).toString("base64"), mime);
		if (!converted) return { ok: false, reason: "conversion_failed" };
		current = Buffer.from(converted.data, "base64");
		mime = converted.mimeType;
	}
	const resized = await resizeImage(current, mime, IMAGE_LIMITS);
	if (resized) {
		if (resized.mimeType !== "image/png" && resized.mimeType !== "image/jpeg") {
			return { ok: false, reason: "unsupported_format" };
		}
		return { ok: true, image: { mimeType: resized.mimeType, base64: resized.data } };
	}
	if (current.byteLength > IMAGE_LIMITS.maxBytes) {
		return { ok: false, reason: "oversize" };
	}
	if (mime !== "image/png" && mime !== "image/jpeg") return { ok: false, reason: "unsupported_format" };
	return { ok: true, image: { mimeType: mime, base64: Buffer.from(current).toString("base64") } };
}
