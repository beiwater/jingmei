import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateConfig } from "../src/config.ts";
import { bucket, buildTelemetryEvent, startTelemetry, TELEMETRY_NOTICE } from "../src/tools/telemetry.ts";

const GUILD = "1552560014353506386";
const CHANNEL = "1552560015276113962";
const CHAT = "-1001234567890";
const SECRETS = {
	ROUTING_SECRET: "routing-fixture-secret",
	DISCORD_LUNA_TOKEN: "discord-fixture-token",
	TELEGRAM_LUNA_TOKEN: "telegram-fixture-token",
	DEEPSEEK_API_KEY: "deepseek-fixture-key",
};

let root: string;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "jingmei-telemetry-"));
	writeFileSync(join(root, "luna.md"), "Luna");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function config(extra: Record<string, unknown> = {}, env: Record<string, string> = {}) {
	return validateConfig(
		{
			dataDir: root,
			discord: { guilds: [{ guildId: GUILD, channelIds: [CHANNEL] }] },
			telegram: { chatIds: [CHAT] },
			personas: [
				{
					id: "luna",
					name: "Luna",
					personaPath: "luna.md",
					provider: "deepseek",
					model: "deepseek-flash",
					routingP: 0.6,
					discord: { tokenEnv: "DISCORD_LUNA_TOKEN" },
					telegram: { tokenEnv: "TELEGRAM_LUNA_TOKEN" },
				},
			],
			...extra,
		},
		root,
		{ ...SECRETS, ...env },
	);
}

const INSTANCE = "11111111-2222-4333-8444-555555555555";
const HOST = "https://eu.i.posthog.com";

describe("telemetry event", () => {
	test("is a fixed whitelist that carries no secret, id, name or path", () => {
		const event = buildTelemetryEvent(config(), INSTANCE);
		expect(Object.keys(event).sort()).toEqual(["distinct_id", "event", "properties"]);
		expect(event.distinct_id).toBe(INSTANCE);
		expect(Object.keys(event.properties).sort()).toEqual(
			[
				"$geoip_disable",
				"arch",
				"bun",
				"feature_audit",
				"feature_celebrations",
				"feature_events",
				"feature_history",
				"feature_jev",
				"feature_kline",
				"feature_memory",
				"feature_search",
				"feature_soul",
				"feature_text_image",
				"feature_vision",
				"feature_voice",
				"os",
				"personas",
				"platforms",
				"spaces",
				"version",
			].sort(),
		);
		expect(event.properties).toMatchObject({ platforms: ["discord", "telegram"], personas: "1", spaces: "2-5" });
		expect(event.properties.$geoip_disable).toBe(true);
		const text = JSON.stringify(event);
		for (const forbidden of [...Object.values(SECRETS), GUILD, CHANNEL, CHAT, "luna", "Luna", root])
			expect(text).not.toContain(forbidden);
	});

	test("reports enabled features, not their settings", () => {
		const { properties } = buildTelemetryEvent(
			config({ features: { memory: false }, kline: { enabled: true }, textImage: { enabled: true } }),
			INSTANCE,
		);
		expect(properties).toMatchObject({
			feature_memory: false,
			feature_history: true,
			feature_search: true,
			feature_kline: true,
			feature_text_image: true,
			feature_voice: false,
		});
	});

	test("counts are bucketed", () => {
		expect([0, 1, 2, 5, 6, 20, 21, 500].map((count) => bucket(count))).toEqual([
			"0",
			"1",
			"2-5",
			"2-5",
			"6-20",
			"6-20",
			"21+",
			"21+",
		]);
	});
});

describe("telemetry client", () => {
	function recorder(respond: () => Response | Promise<Response> = () => new Response(null, { status: 200 })) {
		const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
		const fetchImpl = (async (url: string, init: RequestInit) => {
			calls.push({ url, body: JSON.parse(init.body as string) });
			return respond();
		}) as unknown as typeof fetch;
		return { calls, fetchImpl };
	}

	test("shows the notice once, keeps one instance id across restarts, and posts to PostHog", () => {
		const shown: string[] = [];
		const first = recorder();
		startTelemetry({
			config: config(),
			host: HOST,
			key: "phc_test",
			fetchImpl: first.fetchImpl,
			print: (t) => shown.push(t),
		});
		const second = recorder();
		startTelemetry({
			config: config(),
			host: HOST,
			key: "phc_test",
			fetchImpl: second.fetchImpl,
			print: (t) => shown.push(t),
		});
		expect(shown).toEqual([TELEMETRY_NOTICE]);
		expect(first.calls).toHaveLength(1);
		expect(first.calls[0]!.url).toBe(`${HOST}/i/v0/e/`);
		expect(first.calls[0]!.body).toMatchObject({ api_key: "phc_test", event: "jingmei_report" });
		expect(second.calls[0]!.body.distinct_id).toBe(first.calls[0]!.body.distinct_id);
		expect(readFileSync(join(root, "telemetry.json"), "utf8")).not.toContain("token");
	});

	test("does nothing, and writes nothing, when disabled or without a key", () => {
		const { calls, fetchImpl } = recorder();
		const shown: string[] = [];
		const print = (text: string) => shown.push(text);
		startTelemetry({
			config: config({ telemetry: { enabled: false } }),
			host: HOST,
			key: "phc_test",
			fetchImpl,
			print,
		});
		startTelemetry({ config: config({}, { DO_NOT_TRACK: "1" }), host: HOST, key: "phc_test", fetchImpl, print });
		startTelemetry({ config: config(), host: HOST, key: "", fetchImpl, print });
		expect(calls).toHaveLength(0);
		expect(shown).toHaveLength(0);
		expect(existsSync(join(root, "telemetry.json"))).toBe(false);
	});

	test("a failing or rejecting PostHog never throws into the bot", async () => {
		const failing = recorder(() => {
			throw new Error("network down");
		});
		const rejecting = recorder(() => new Response(null, { status: 500 }));
		for (const { fetchImpl } of [failing, rejecting])
			expect(() =>
				startTelemetry({ config: config(), host: HOST, key: "phc_test", fetchImpl, print: () => {} }),
			).not.toThrow();
		await Bun.sleep(10);
	});
});
