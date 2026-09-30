import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractVideoFrames, sampleVideoFrameFractions, type VideoCommandRunner } from "../src/media/video-frames.ts";

describe("video frame sampling", () => {
	test("uses fixed representative frame positions", () => {
		expect(sampleVideoFrameFractions(0)).toEqual([]);
		expect(sampleVideoFrameFractions(1)).toEqual([0.5]);
		expect(sampleVideoFrameFractions(2)).toEqual([1 / 3, 2 / 3]);
		expect(sampleVideoFrameFractions(3)).toEqual([0.2, 0.5, 0.8]);
	});

	test("probes once, extracts at most three frames, and removes temporary output", async () => {
		const directory = mkdtempSync(join(tmpdir(), "video-extract-"));
		try {
			const sourcePath = join(directory, "source.mp4");
			writeFileSync(sourcePath, new Uint8Array([0, 1, 2, 3]));
			const commands: string[][] = [];
			const runner: VideoCommandRunner = {
				which: (command) => `/usr/bin/${command}`,
				run: async (argv) => {
					commands.push([...argv]);
					if (argv[0]?.endsWith("ffprobe")) {
						return { exitCode: 0, stdout: JSON.stringify({ format: { duration: "10" }, streams: [{}] }) };
					}
					writeFileSync(argv.at(-1)!, new Uint8Array([0xff, 0xd8, 0xff, 0xd9]));
					return { exitCode: 0, stdout: "" };
				},
			};
			const result = await extractVideoFrames(
				{ sourcePath, sourceBytes: new Uint8Array(), sourceExtension: "mp4" },
				{ runner },
			);
			expect(result.ok).toBe(true);
			if (!result.ok) return;
			expect(result.frames).toHaveLength(3);
			expect(commands.filter((argv) => argv[0]?.endsWith("ffprobe"))).toHaveLength(1);
			expect(commands.filter((argv) => argv[0]?.endsWith("ffmpeg"))).toHaveLength(3);
			expect(result.frames.every((frame) => frame.bytes.byteLength === 4)).toBe(true);
			expect(commands.every((argv) => !argv.includes("sh") && !argv.includes("-c"))).toBe(true);
			expect(commands.slice(1).every((argv) => !existsSync(argv.at(-1)!))).toBe(true);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("missing ffmpeg is a fixed outcome, not an exception", async () => {
		const runner: VideoCommandRunner = {
			which: () => null,
			run: async () => ({ exitCode: 1, stdout: "" }),
		};
		const result = await extractVideoFrames(
			{ sourcePath: null, sourceBytes: new Uint8Array([1]), sourceExtension: "mp4" },
			{ runner },
		);
		expect(result).toEqual({ ok: false, outcome: "video_transcoder_unavailable" });
	});
});
