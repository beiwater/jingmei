export type ImageMime = "image/jpeg" | "image/png" | "image/webp" | "image/gif";

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** The still-image type the leading bytes declare, or null. Untrusted headers and extensions never decide this. */
export function sniffImageMime(bytes: Uint8Array): ImageMime | null {
	const ascii = (start: number, end: number) => new TextDecoder().decode(bytes.subarray(start, end));
	if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
	if (PNG_SIGNATURE.every((value, index) => bytes[index] === value)) return "image/png";
	if (ascii(0, 6) === "GIF87a" || ascii(0, 6) === "GIF89a") return "image/gif";
	if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
	return null;
}
