import { describe, expect, test } from "bun:test";
import { IMAGE_LIMITS, prepareImage } from "../src/media/image.ts";
import { downloadDiscordImage, downloadDiscordVideo } from "../src/platforms/discord/media.ts";

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const base = {
	url: "https://cdn.discordapp.com/attachments/1/2/photo.png",
	filename: "../photo.png",
};

describe("Discord image attachments", () => {
	test("downloads bounded CDN images and verifies the actual format", async () => {
		const result = await downloadDiscordImage(base, {
			fetchImpl: async () => new Response(png, { headers: { "content-length": String(png.length) } }),
		});
		expect(result).toEqual({ bytes: png, mimeType: "image/png" });
	});

	test("prepares a real small PNG into Pi image content", async () => {
		const realPng = Uint8Array.from(
			Buffer.from(
				"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQI12P4z8DwHwAFAAH/cpxSZwAAAABJRU5ErkJggg==",
				"base64",
			),
		);
		const prepared = await prepareImage(realPng, "image/png");
		expect(prepared.ok).toBe(true);
		if (!prepared.ok) return;
		expect(prepared.image.mimeType).toBe("image/png");
		const imageBytes = Buffer.from(prepared.image.base64, "base64");
		expect(imageBytes.byteLength).toBeLessThanOrEqual(IMAGE_LIMITS.maxBytes);
		expect(Array.from(imageBytes.subarray(0, 8))).toEqual(Array.from(realPng.subarray(0, 8)));
	});

	test("rejects non-CDN URLs, declared oversize and streamed oversize bodies", async () => {
		const fetchNever = async () => {
			throw new Error("fetch must not run");
		};
		expect(
			await downloadDiscordImage({ ...base, url: "http://cdn.discordapp.com/a.png" }, { fetchImpl: fetchNever }),
		).toBeNull();
		expect(
			await downloadDiscordImage({ ...base, url: "https://example.org/a.png" }, { fetchImpl: fetchNever }),
		).toBeNull();
		expect(await downloadDiscordImage({ ...base, size: 101 }, { maxBytes: 100, fetchImpl: fetchNever })).toBeNull();
		expect(
			await downloadDiscordImage(base, {
				maxBytes: 10,
				fetchImpl: async () => new Response(new Uint8Array(11)),
			}),
		).toBeNull();
	});

	test("rejects HTML or malformed bytes even from the Discord CDN", async () => {
		const result = await downloadDiscordImage(base, {
			fetchImpl: async () => new Response("<html>not an image</html>", { headers: { "content-type": "image/png" } }),
		});
		expect(result).toBeNull();
	});

	test("rejects an oversize original when resizing fails", async () => {
		const prepared = await prepareImage(new Uint8Array(IMAGE_LIMITS.maxBytes + 1), "image/png", {
			resize: async () => {
				throw new Error("resize failed");
			},
		});
		expect(prepared.ok).toBe(false);
	});

	test("applies CDN and size protections to video downloads", async () => {
		const fetchNever = async () => {
			throw new Error("fetch must not run");
		};
		const video = { url: "https://cdn.discordapp.com/attachments/1/2/clip.mp4" };
		expect(
			await downloadDiscordVideo({ ...video, url: "https://example.org/clip.mp4" }, { fetchImpl: fetchNever }),
		).toBeNull();
		expect(await downloadDiscordVideo({ ...video, size: 101 }, { maxBytes: 100, fetchImpl: fetchNever })).toBeNull();
		expect(
			await downloadDiscordVideo(video, { maxBytes: 10, fetchImpl: async () => new Response(new Uint8Array(11)) }),
		).toBeNull();
	});
});
