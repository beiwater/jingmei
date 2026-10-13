import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import worker, { type Env, parseReport } from "../deploy/telemetry-worker/index.ts";
import { validateConfig } from "../src/config.ts";
import { bucket, buildTelemetryPayload, startTelemetry, TELEMETRY_NOTICE } from "../src/tools/telemetry.ts";

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

describe("telemetry payload", () => {
	test("is a fixed whitelist that carries no secret, id, name or path", () => {
		const payload = buildTelemetryPayload(config(), "11111111-2222-4333-8444-555555555555");
		expect(Object.keys(payload).sort()).toEqual(
			["features", "instance", "personas", "platforms", "runtime", "schema", "spaces", "version"].sort(),
		);
		expect(Object.keys(payload.runtime).sort()).toEqual(["arch", "bun", "os"]);
		expect(payload).toMatchObject({ platforms: ["discord", "telegram"], personas: "1", spaces: "2-5" });
		const text = JSON.stringify(payload);
		for (const forbidden of [...Object.values(SECRETS), GUILD, CHANNEL, CHAT, "luna", "Luna", root])
			expect(text).not.toContain(forbidden);
	});

	test("reports enabled features, not their settings", () => {
		const { features } = buildTelemetryPayload(
			config({ features: { memory: false }, kline: { enabled: true }, textImage: { enabled: true } }),
			"11111111-2222-4333-8444-555555555555",
		);
		expect(features).toMatchObject({ memory: false, history: true, search: true, kline: true, textImage: true });
		expect(features.voice).toBe(false);
		expect(Object.values(features).every((value) => typeof value === "boolean")).toBe(true);
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
	function recorder(respond: () => Response | Promise<Response> = () => new Response(null, { status: 204 })) {
		const calls: Array<{ url: string; body: unknown }> = [];
		const fetchImpl = (async (url: string, init: RequestInit) => {
			calls.push({ url, body: JSON.parse(init.body as string) });
			return respond();
		}) as unknown as typeof fetch;
		return { calls, fetchImpl };
	}

	test("shows the notice once, keeps one instance id across restarts, and reports to the endpoint", () => {
		const shown: string[] = [];
		const first = recorder();
		startTelemetry({
			config: config(),
			endpoint: "https://example.test/",
			fetchImpl: first.fetchImpl,
			print: (t) => shown.push(t),
		});
		const second = recorder();
		startTelemetry({
			config: config(),
			endpoint: "https://example.test/",
			fetchImpl: second.fetchImpl,
			print: (t) => shown.push(t),
		});
		expect(shown).toEqual([TELEMETRY_NOTICE]);
		expect(first.calls).toHaveLength(1);
		expect(first.calls[0]!.url).toBe("https://example.test/");
		expect(second.calls[0]!.body).toMatchObject({ instance: (first.calls[0]!.body as { instance: string }).instance });
		expect(readFileSync(join(root, "telemetry.json"), "utf8")).not.toContain("token");
	});

	test("does nothing, and writes nothing, when disabled or without a receiver", () => {
		const { calls, fetchImpl } = recorder();
		const shown: string[] = [];
		const print = (text: string) => shown.push(text);
		startTelemetry({
			config: config({ telemetry: { enabled: false } }),
			endpoint: "https://example.test/",
			fetchImpl,
			print,
		});
		startTelemetry({ config: config({}, { DO_NOT_TRACK: "1" }), endpoint: "https://example.test/", fetchImpl, print });
		startTelemetry({ config: config(), endpoint: "", fetchImpl, print });
		expect(calls).toHaveLength(0);
		expect(shown).toHaveLength(0);
		expect(existsSync(join(root, "telemetry.json"))).toBe(false);
	});

	test("a failing or rejecting receiver never throws into the bot", async () => {
		const failing = recorder(() => {
			throw new Error("network down");
		});
		expect(() =>
			startTelemetry({
				config: config(),
				endpoint: "https://example.test/",
				fetchImpl: failing.fetchImpl,
				print: () => {},
			}),
		).not.toThrow();
		const rejecting = recorder(() => new Response(null, { status: 500 }));
		expect(() =>
			startTelemetry({
				config: config(),
				endpoint: "https://example.test/",
				fetchImpl: rejecting.fetchImpl,
				print: () => {},
			}),
		).not.toThrow();
		await Bun.sleep(10);
	});
});

describe("telemetry receiver", () => {
	function receiver() {
		const sqlite = new Database(":memory:");
		sqlite.run(readFileSync(join(import.meta.dir, "../deploy/telemetry-worker/schema.sql"), "utf8"));
		const env: Env = {
			DB: {
				prepare: (sql) => ({
					bind: (...values) => ({
						run: async () => sqlite.query(sql).run(...(values as never[])),
						first: async <T>() => sqlite.query(sql).get(...(values as never[])) as T | null,
					}),
				}),
			},
		};
		const send = (body: unknown, method = "POST", path = "/") =>
			worker.fetch(
				new Request(`https://t.test${path}`, {
					method,
					...(method === "POST" ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}),
				}),
				env,
			);
		return { sqlite, send };
	}
	const payload = () => buildTelemetryPayload(config(), "11111111-2222-4333-8444-555555555555");

	test("accepts what the client sends and counts one row per instance", async () => {
		const { sqlite, send } = receiver();
		expect((await send(payload())).status).toBe(204);
		expect((await send(payload())).status).toBe(204);
		expect(sqlite.query("SELECT COUNT(*) AS n FROM instances").get()).toEqual({ n: 1 });
		const stats = (await (await send(null, "GET", "/stats")).json()) as Record<string, number>;
		expect(stats).toEqual({ instances_90d: 1, instances_30d: 1 });
		const row = sqlite.query("SELECT * FROM instances").get() as Record<string, unknown>;
		expect(Object.keys(row).sort()).toEqual(
			[
				"arch",
				"bun",
				"features",
				"first_seen",
				"instance",
				"last_seen",
				"os",
				"personas",
				"platforms",
				"spaces",
				"version",
			].sort(),
		);
	});

	test("rejects anything outside the whitelist instead of storing it", async () => {
		const { sqlite, send } = receiver();
		const good = payload();
		const bad: unknown[] = [
			{ ...good, extra: "x" },
			{ ...good, instance: "not-a-uuid" },
			{ ...good, schema: 2 },
			{ ...good, spaces: "37" },
			{ ...good, platforms: ["discord", "https://example.test"] },
			{ ...good, runtime: { ...good.runtime, host: "pi" } },
			{ ...good, features: { ...good.features, extra: true } },
			{ ...good, features: { ...good.features, voice: "yes" } },
			"not json",
		];
		for (const body of bad) expect((await send(body)).status).toBe(400);
		expect((await send("x".repeat(5000))).status).toBe(413);
		expect(sqlite.query("SELECT COUNT(*) AS n FROM instances").get()).toEqual({ n: 0 });
		expect(parseReport(good)).toBeDefined();
	});

	test("drops instances not seen for 90 days", async () => {
		const { sqlite, send } = receiver();
		const old = Date.now() - 91 * 24 * 60 * 60 * 1000;
		sqlite.run(
			"INSERT INTO instances VALUES ('00000000-0000-4000-8000-000000000000', ?1, ?1, '0', '1', 'linux', 'x64', 'discord', '1', '1', '{}')",
			[old],
		);
		expect((await send(payload())).status).toBe(204);
		expect(sqlite.query("SELECT COUNT(*) AS n FROM instances").get()).toEqual({ n: 1 });
	});
});
