import { describe, expect, test } from "bun:test";
import {
	DiscordGatewayFatalError,
	DiscordPlatformTransport,
	DiscordTransport,
	isSnowflake,
	isValidReactionEmoji,
	splitDiscordMessage,
} from "../src/platforms/discord/transport.ts";

class FakeSocket {
	readyState: number = WebSocket.OPEN;
	onopen: ((event: Event) => void) | null = null;
	onmessage: ((event: MessageEvent) => void) | null = null;
	onerror: ((event: Event) => void) | null = null;
	onclose: ((event: CloseEvent) => void) | null = null;
	sent: Array<{ op: number; d: any }> = [];
	send(raw: string) {
		this.sent.push(JSON.parse(raw));
	}
	open() {
		this.onopen?.(new Event("open"));
	}
	message(data: unknown) {
		this.onmessage?.({ data: JSON.stringify(data) } as MessageEvent);
	}
	close(code = 1000, reason = "") {
		this.readyState = 3;
		this.onclose?.({ code, reason, wasClean: code === 1000 } as CloseEvent);
	}
}

describe("Discord transport primitives", () => {
	test("keeps Discord Snowflakes as strings", () => {
		const id = "18446744073709551615";
		expect(isSnowflake(id)).toBe(true);
		expect(isSnowflake(18446744073709551615n)).toBe(false);
		expect(isSnowflake("abc")).toBe(false);
	});

	test("splits at readable boundaries and preserves all text", () => {
		const text = "alpha beta\ngamma delta epsilon";
		const parts = splitDiscordMessage(text, 12);
		expect(parts.every((part) => part.length <= 12)).toBe(true);
		expect(parts.join("")).toBe(text);
		expect(splitDiscordMessage("x".repeat(2001))).toEqual(["x".repeat(2000), "x"]);
	});

	test("chunks sends with mention parsing disabled and guards the channel", async () => {
		const calls: Array<{ url: string; body: unknown }> = [];
		const transport = new DiscordTransport({
			token: "test-only",
			applicationId: "123456789012345678",
			allowedChannelIds: ["223456789012345678"],
			fetch: (async (input: string | URL | Request, init?: RequestInit) => {
				const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
				calls.push({ url: String(input), body });
				const index = calls.length;
				return Response.json({
					id: String(323456789012345678n + BigInt(index)),
					channel_id: "223456789012345678",
					content: body.content,
					author: { id: "123456789012345678", username: "bot" },
				});
			}) as unknown as typeof fetch,
		});
		const messages = await transport.sendMessage("223456789012345678", "a".repeat(2001), {
			replyTo: "423456789012345678",
		});
		expect(messages).toHaveLength(2);
		expect(calls).toHaveLength(2);
		expect(calls[0]?.body).toMatchObject({
			allowed_mentions: { parse: [], replied_user: false },
			message_reference: { message_id: "423456789012345678", fail_if_not_exists: false },
		});
		expect(calls[1]?.body).toMatchObject({ allowed_mentions: { parse: [], replied_user: false } });
		await expect(transport.sendMessage("999999999999999999", "nope")).rejects.toThrow("allowlist");
	});

	test("adds idempotent Discord reactions only in configured channels", async () => {
		let url = "";
		let method = "";
		const transport = new DiscordTransport({
			token: "test-only",
			applicationId: "123456789012345678",
			allowedChannelIds: ["223456789012345678"],
			fetch: (async (input: string | URL | Request, init?: RequestInit) => {
				url = String(input);
				method = init?.method ?? "";
				return new Response(null, { status: 204 });
			}) as unknown as typeof fetch,
		});
		await transport.addReaction("223456789012345678", "323456789012345678", "👍");
		expect(method).toBe("PUT");
		expect(url).toContain("/channels/223456789012345678/messages/323456789012345678/reactions/%F0%9F%91%8D/@me");
		await expect(transport.addReaction("999999999999999999", "323456789012345678", "👍")).rejects.toThrow("allowlist");
	});

	test("accepts bounded Unicode and custom emoji syntax", () => {
		expect(isValidReactionEmoji("🔥")).toBe(true);
		expect(isValidReactionEmoji("party_blob:123456789012345678")).toBe(true);
		expect(isValidReactionEmoji("text")).toBe(false);
		expect(isValidReactionEmoji("🔥".repeat(33))).toBe(false);
	});

	test("retries rate limits according to retry_after without exposing response text", async () => {
		let count = 0;
		const transport = new DiscordTransport({
			token: "test-only",
			applicationId: "123456789012345678",
			fetch: (async () => {
				count++;
				if (count === 1) return Response.json({ retry_after: 0, message: "private server detail" }, { status: 429 });
				return Response.json({
					id: "323456789012345678",
					channel_id: "223456789012345678",
					content: "ok",
					author: { id: "123456789012345678", username: "bot" },
				});
			}) as unknown as typeof fetch,
		});
		const result = await transport.sendMessage("223456789012345678", "ok");
		expect(count).toBe(2);
		expect(result[0]?.id).toBe("323456789012345678");
		await expect(transport.sendMessage("223456789012345678", "ok", { replyTo: "bad-id" })).rejects.toThrow("Snowflake");
	});

	test("platform transport routes by persona and never allows mentions", async () => {
		const bodies: unknown[] = [];
		const client = new DiscordTransport({
			token: "test-only",
			applicationId: "123456789012345678",
			fetch: (async (_input: string | URL | Request, init?: RequestInit) => {
				bodies.push(JSON.parse(String(init?.body)));
				return Response.json({ id: "323456789012345678" });
			}) as unknown as typeof fetch,
		});
		const transport = new DiscordPlatformTransport(new Map([["a", client]]));
		expect(
			await transport.sendMessage({
				personaId: "a",
				channelId: "223456789012345678",
				content: "<@423456789012345678> hi",
			}),
		).toEqual({ id: "323456789012345678" });
		expect(bodies[0]).toMatchObject({ allowed_mentions: { parse: [], replied_user: false } });
		expect((bodies[0] as { allowed_mentions: { users?: unknown } }).allowed_mentions.users).toBeUndefined();
		const friend = { userId: "423456789012345678", username: "friend" };
		await transport.sendMessage({
			personaId: "a",
			channelId: "223456789012345678",
			content: `生日快乐 ${transport.formatMention(friend)}`,
			mention: [friend],
		});
		expect(bodies[1]).toMatchObject({
			content: "生日快乐 <@423456789012345678>",
			allowed_mentions: { parse: [], users: ["423456789012345678"], replied_user: false },
		});
		expect(Object.keys(transport.quickReactions).every((emoji) => transport.isValidReaction(emoji))).toBe(true);
	});

	test("identifies, heartbeats, and resumes the Gateway session", async () => {
		const sockets: FakeSocket[] = [];
		const socketUrls: string[] = [];
		const transport = new DiscordTransport({
			token: "test-only",
			applicationId: "123456789012345678",
			gatewayUrl: "wss://gateway.discord.gg",
			webSocketFactory: (url) => {
				socketUrls.push(url);
				const socket = new FakeSocket();
				sockets.push(socket);
				return socket as unknown as WebSocket;
			},
			fetch: (async () => Response.json({ url: "wss://gateway.discord.gg" })) as unknown as typeof fetch,
		});
		await transport.start();
		sockets[0]?.open();
		sockets[0]?.message({ op: 10, d: { heartbeat_interval: 1000 } });
		expect(new URL(socketUrls[0]!).searchParams.get("v")).toBe("10");
		expect(sockets[0]?.sent[0]).toMatchObject({ op: 2, d: { token: "test-only" } });
		sockets[0]?.message({
			op: 0,
			t: "READY",
			s: 1,
			d: {
				session_id: "session-1",
				resume_gateway_url: "wss://resume.discord.gg",
				user: { id: "123456789012345678", username: "persona" },
			},
		});
		await new Promise((resolve) => setTimeout(resolve, 1050));
		expect(sockets[0]?.sent.some((message) => message.op === 1)).toBe(true);
		sockets[0]?.message({ op: 11, d: null });
		sockets[0]?.close(1006, "network lost");
		for (let i = 0; i < 100 && sockets.length < 2; i++) await new Promise((resolve) => setTimeout(resolve, 25));
		expect(sockets).toHaveLength(2);
		expect(sockets[1]?.readyState).toBe(WebSocket.OPEN);
		sockets[1]?.open();
		sockets[1]?.message({ op: 10, d: { heartbeat_interval: 60_000 } });
		expect(sockets[1]?.sent[0]).toMatchObject({ op: 6, d: { session_id: "session-1", seq: 1 } });
		await transport.stop();
	}, 5000);

	test.each([
		[4004, "token"],
		[4013, "Message Content Intent"],
		[4014, "Message Content Intent"],
	])("reports unrecoverable close code %d with an actionable hint and does not reconnect", async (code, hint) => {
		const sockets: FakeSocket[] = [];
		const errors: Error[] = [];
		const transport = new DiscordTransport({
			token: "test-only",
			applicationId: "123456789012345678",
			gatewayUrl: "wss://gateway.discord.gg",
			webSocketFactory: () => {
				const socket = new FakeSocket();
				sockets.push(socket);
				return socket as unknown as WebSocket;
			},
			onError: (error) => void errors.push(error),
		});
		await transport.start();
		sockets[0]?.open();
		sockets[0]?.close(code);
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(errors).toHaveLength(1);
		const error = errors[0];
		expect(error).toBeInstanceOf(DiscordGatewayFatalError);
		expect((error as DiscordGatewayFatalError).code).toBe(code);
		expect((error as DiscordGatewayFatalError).hint).toContain(hint);
		expect(sockets).toHaveLength(1);
		await transport.stop();
	});

	test("delivers messages and interactions only from allowed channels or their threads", async () => {
		const allowed = "223456789012345678";
		const thread = "323456789012345678";
		const otherThread = "423456789012345678";
		const outside = "523456789012345678";
		const socket = new FakeSocket();
		const messages: string[] = [];
		const interactions: string[] = [];
		const transport = new DiscordTransport({
			token: "test-only",
			applicationId: "123456789012345678",
			gatewayUrl: "wss://gateway.discord.gg",
			allowedChannelIds: [allowed],
			webSocketFactory: () => socket as unknown as WebSocket,
			onMessage: (message) => void messages.push(message.channel_id),
			onInteraction: (interaction) => void interactions.push(interaction.channel_id!),
		});
		await transport.start();
		socket.open();
		socket.message({ op: 10, d: { heartbeat_interval: 60_000 } });
		const dispatch = (t: string, d: object) => socket.message({ op: 0, t, s: 1, d });
		dispatch("THREAD_CREATE", { id: thread, parent_id: allowed });
		dispatch("THREAD_CREATE", { id: otherThread, parent_id: outside });
		for (const channel_id of [allowed, thread, otherThread, outside]) {
			dispatch("MESSAGE_CREATE", { channel_id });
			dispatch("INTERACTION_CREATE", { channel_id });
		}
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(messages).toEqual([allowed, thread]);
		expect(interactions).toEqual([allowed, thread]);
		await transport.stop();
	});
});
