import { expect, test } from "bun:test";

test("bun test rejects Discord and Telegram requests even when real credentials exist", async () => {
	for (const url of [
		"https://discord.com/api/v10/channels/1/messages",
		"https://cdn.discordapp.com/attachments/1/2/file.png",
		"https://discord.gg/example",
		"https://media.discordapp.net/attachments/1/2/file.png",
		"https://api.telegram.org/bot-not-a-token/sendMessage",
	]) {
		await expect(fetch(url)).rejects.toThrow("chat platform network is disabled in bun test");
	}
});
