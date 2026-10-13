// Anonymous instance-level usage report: how many jingmei installs exist and which features they enable.
// The payload is built from a fixed whitelist of non-identifying fields; it never carries tokens, space or member ids,
// message text, paths or hostnames. `bun run jingmei telemetry` prints exactly what would be sent.

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import pkg from "../../package.json" with { type: "json" };
import type { AppConfig } from "../config.ts";
import { errorCategory, log } from "../observability/log.ts";

/** Where reports go: the receiver in `deploy/telemetry-worker`. Empty until one is deployed, which keeps the report off. */
export const TELEMETRY_ENDPOINT = "";
const INTERVAL_MS = 24 * 60 * 60 * 1000;
const TIMEOUT_MS = 5_000;
const STATE_FILE = "telemetry.json";

export const TELEMETRY_NOTICE = [
	"精魅会匿名上报实例级使用统计：随机实例 ID、版本、系统、启用的平台与功能、分档后的数量。",
	"不含 token、群或成员 ID、消息内容，接收端不保存 IP。查看内容：bun run jingmei telemetry",
	'关闭：jingmei.config.json 写 "telemetry": { "enabled": false }，或设置环境变量 DO_NOT_TRACK=1。',
	"jingmei sends anonymous instance-level usage stats: a random instance id, version, OS, enabled platforms and features, bucketed counts.",
	"No tokens, space or member ids, or message content; the receiver stores no IP. Preview: bun run jingmei telemetry",
	'Turn off: "telemetry": { "enabled": false } in jingmei.config.json, or set DO_NOT_TRACK=1.',
].join("\n");

export interface TelemetryPayload {
	schema: 1;
	instance: string;
	version: string;
	runtime: { bun: string; os: string; arch: string };
	platforms: string[];
	personas: string;
	spaces: string;
	features: Record<string, boolean>;
}

/** Coarse count so a report cannot single out one deployment by its exact size. */
export function bucket(count: number): string {
	if (count <= 0) return "0";
	if (count === 1) return "1";
	if (count <= 5) return "2-5";
	if (count <= 20) return "6-20";
	return "21+";
}

export function buildTelemetryPayload(config: AppConfig, instance: string): TelemetryPayload {
	const spaces = (config.discord?.guilds ?? []).reduce((sum, guild) => sum + guild.channelIds.length, 0);
	return {
		schema: 1,
		instance,
		version: pkg.version,
		runtime: { bun: Bun.version, os: process.platform, arch: process.arch },
		platforms: [config.discord ? "discord" : "", config.telegram ? "telegram" : ""].filter(Boolean),
		personas: bucket(config.personas.length),
		spaces: bucket(spaces + (config.telegram?.chatIds.length ?? 0)),
		features: {
			history: config.features.history,
			memory: config.features.memory,
			soul: config.features.soul,
			search: config.features.search && !!config.webSearchApiKey,
			audit: config.features.audit,
			voice: !!config.voice,
			textImage: !!config.textImage,
			kline: !!config.kline,
			vision: !!config.visionModel,
			jev: !!config.jev || !!config.localJev,
			events: !!config.events,
			celebrations: config.celebrations.length > 0,
		},
	};
}

interface TelemetryState {
	instance: string;
	noticed: boolean;
}

/** The instance id is random and local; losing the file only makes this install count as a new one. */
export function loadTelemetryState(dataDir: string): TelemetryState {
	const path = join(dataDir, STATE_FILE);
	try {
		const saved = JSON.parse(readFileSync(path, "utf8")) as Partial<TelemetryState>;
		if (typeof saved.instance === "string" && saved.instance)
			return { instance: saved.instance, noticed: !!saved.noticed };
	} catch {}
	return { instance: randomUUID(), noticed: false };
}

function saveTelemetryState(dataDir: string, state: TelemetryState): void {
	writeFileSync(join(dataDir, STATE_FILE), `${JSON.stringify(state)}\n`, { mode: 0o600 });
}

export interface TelemetryOptions {
	config: AppConfig;
	endpoint?: string;
	fetchImpl?: typeof fetch;
	intervalMs?: number;
	/** Where the first-run notice is shown. */
	print?: (text: string) => void;
}

/**
 * Show the notice once, then report at start and every 24 hours. Fire and forget: a failure is logged at debug level
 * and never affects the bot. Does nothing when disabled or when no receiver is configured.
 */
export function startTelemetry(options: TelemetryOptions): void {
	const { config, endpoint = TELEMETRY_ENDPOINT, fetchImpl = fetch, intervalMs = INTERVAL_MS } = options;
	if (!config.telemetry || !endpoint || !existsSync(config.dataDir)) return;
	const state = loadTelemetryState(config.dataDir);
	if (!state.noticed) {
		(options.print ?? ((text) => process.stderr.write(`${text}\n`)))(TELEMETRY_NOTICE);
		state.noticed = true;
	}
	try {
		saveTelemetryState(config.dataDir, state);
	} catch (error) {
		// Without a saved id every restart would count as a new install.
		log.debug("core", "telemetry_state_unwritable", { error_category: errorCategory(error) });
		return;
	}
	const send = async () => {
		try {
			const response = await fetchImpl(endpoint, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(buildTelemetryPayload(config, state.instance)),
				signal: AbortSignal.timeout(TIMEOUT_MS),
			});
			if (!response.ok) log.debug("core", "telemetry_rejected", { status: response.status });
		} catch (error) {
			log.debug("core", "telemetry_failed", { error_category: errorCategory(error) });
		}
	};
	void send();
	setInterval(send, intervalMs).unref();
}
