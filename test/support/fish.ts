import { spyOn } from "bun:test";

/**
 * Fish Audio is the only network a voice test may touch: every TTS request is answered with three MP3 bytes
 * after `onRequest` runs (to observe or order requests). The spy is restored with the file's cleanup stack.
 */
export function mockFishTts(
	cleanups: { push(cleanup: () => void): unknown },
	onRequest: () => void | Promise<void> = () => {},
) {
	const fetch = spyOn(globalThis, "fetch").mockImplementation((async (input: string | URL | Request) => {
		if (String(input) !== "https://api.fish.audio/v1/tts") throw new Error("unexpected network request");
		await onRequest();
		return new Response(new Uint8Array([73, 68, 51]), { headers: { "content-type": "audio/mpeg" } });
	}) as unknown as typeof globalThis.fetch);
	cleanups.push(() => fetch.mockRestore());
	return fetch;
}
