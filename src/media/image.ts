/** Platform-neutral still-image preparation for model context. */

import { convertToPng, resizeImage } from "@earendil-works/pi-coding-agent";
import type { InboundImage } from "../core/types.ts";

export const IMAGE_LIMITS = { maxWidth: 1024, maxHeight: 1024, maxBytes: 200_000, jpegQuality: 80 } as const;

export interface PrepareImageOptions {
	convert?: typeof convertToPng;
	resize?: typeof resizeImage;
}

/** Convert (WebP/GIF→PNG via Pi convertToPng) and resize (Pi resizeImage) raw bytes to a model-ready still. */
export async function prepareImage(
	bytes: Uint8Array,
	mimeType: string,
	options: PrepareImageOptions = {},
): Promise<{ ok: true; image: InboundImage } | { ok: false; reason: string }> {
	let current = bytes;
	let mime = mimeType.toLowerCase();
	if (mime === "image/webp" || mime === "image/gif") {
		const converted = await (options.convert ?? convertToPng)(Buffer.from(current).toString("base64"), mime).catch(
			() => null,
		);
		if (!converted) return { ok: false, reason: "conversion_failed" };
		current = new Uint8Array(Buffer.from(converted.data, "base64"));
		mime = converted.mimeType;
	}
	const resized = await (options.resize ?? resizeImage)(current, mime, IMAGE_LIMITS).catch(() => null);
	if (resized) {
		current = new Uint8Array(Buffer.from(resized.data, "base64"));
		mime = resized.mimeType;
	} else if (current.byteLength > IMAGE_LIMITS.maxBytes) {
		return { ok: false, reason: "oversize" };
	}
	if (mime !== "image/png" && mime !== "image/jpeg") return { ok: false, reason: "unsupported_format" };
	return { ok: true, image: { mimeType: mime, base64: Buffer.from(current).toString("base64") } };
}
