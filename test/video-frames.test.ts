import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { extractVideoFrames, type VideoCommandRunner } from "../src/media/video-frames.ts";

describe("video frame sampling", () => {
	test.each([
		{ duration: 0.5, seeks: ["0.250"] },
		{ duration: 0.999, seeks: ["0.499"] },
		{ duration: 1, seeks: ["0.333", "0.667"] },
		{ duration: 2.999, seeks: ["1.000", "1.999"] },
		{ duration: 3, seeks: ["0.600", "1.500", "2.400"] },
		{ duration: 10, seeks: ["2.000", "5.000", "8.000"] },
	])("uses duration-dependent seek positions for $duration seconds", async ({ duration, seeks }) => {
		const actual: string[] = [];
		const runner: VideoCommandRunner = {
			which: (command) => `/usr/bin/${command}`,
			run: async (argv) => {
				if (argv[0]?.endsWith("ffprobe")) {
					return { exitCode: 0, stdout: `${duration}\n` };
				}
				actual.push(argv[argv.indexOf("-ss") + 1]!);
				writeFileSync(argv.at(-1)!, new Uint8Array([0xff, 0xd8, 0xff, 0xd9]));
				return { exitCode: 0, stdout: "" };
			},
		};
		const result = await extractVideoFrames(
			{ sourceBytes: new Uint8Array([0, 1, 2, 3]), sourceExtension: "mp4" },
			{ runner },
		);
		expect(result.ok).toBe(true);
		expect(actual).toEqual([...seeks]);
	});

	test("probes a private byte copy once, extracts three frames, and removes temporary files", async () => {
		const sourceBytes = new Uint8Array([0, 1, 2, 3]);
		const commands: string[][] = [];
		const runner: VideoCommandRunner = {
			which: (command) => `/usr/bin/${command}`,
			run: async (argv) => {
				commands.push([...argv]);
				if (argv[0]?.endsWith("ffprobe")) {
					const sourcePath = argv.at(-1)!;
					expect(new Uint8Array(readFileSync(sourcePath))).toEqual(sourceBytes);
					expect(statSync(sourcePath).mode & 0o777).toBe(0o600);
					expect(statSync(dirname(sourcePath)).mode & 0o777).toBe(0o700);
					return { exitCode: 0, stdout: "10.000000\n" };
				}
				writeFileSync(argv.at(-1)!, new Uint8Array([0xff, 0xd8, 0xff, 0xd9]));
				return { exitCode: 0, stdout: "" };
			},
		};
		const result = await extractVideoFrames({ sourceBytes, sourceExtension: "mp4" }, { runner });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.frames).toHaveLength(3);
		expect(commands.filter((argv) => argv[0]?.endsWith("ffprobe"))).toHaveLength(1);
		expect(commands.filter((argv) => argv[0]?.endsWith("ffmpeg"))).toHaveLength(3);
		expect(result.frames.every((frame) => frame.bytes.byteLength === 4)).toBe(true);
		expect(commands.every((argv) => !argv.includes("sh") && !argv.includes("-c"))).toBe(true);
		expect(commands.every((argv) => !existsSync(argv.at(-1)!))).toBe(true);
		expect(existsSync(dirname(commands[0]!.at(-1)!))).toBe(false);
	});

	test.each(["N/A\n", "", "0\n", "abc"])("an unusable probe duration %j is a fixed outcome", async (stdout) => {
		const runner: VideoCommandRunner = {
			which: (command) => `/usr/bin/${command}`,
			run: async () => ({ exitCode: 0, stdout }),
		};
		const result = await extractVideoFrames({ sourceBytes: new Uint8Array([1]), sourceExtension: "mp4" }, { runner });
		expect(result).toEqual({ ok: false, outcome: "video_probe_failed" });
	});

	test("missing ffmpeg is a fixed outcome, not an exception", async () => {
		const runner: VideoCommandRunner = {
			which: () => null,
			run: async () => ({ exitCode: 1, stdout: "" }),
		};
		const result = await extractVideoFrames({ sourceBytes: new Uint8Array([1]), sourceExtension: "mp4" }, { runner });
		expect(result).toEqual({ ok: false, outcome: "video_transcoder_unavailable" });
	});
});
