// Receiver for jingmei's anonymous instance report (Cloudflare Worker + D1). It stores only the whitelisted fields
// below and never reads the client IP or any request header. `GET /stats` returns instance counts.

interface D1Statement {
	bind(...values: unknown[]): { run(): Promise<unknown>; first<T>(): Promise<T | null> };
}
export interface Env {
	DB: { prepare(sql: string): D1Statement };
}

const FEATURES = [
	"history",
	"memory",
	"soul",
	"search",
	"audit",
	"voice",
	"textImage",
	"kline",
	"vision",
	"jev",
	"events",
	"celebrations",
] as const;
const BUCKETS = ["0", "1", "2-5", "6-20", "21+"];
const PLATFORMS = ["discord", "telegram"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const WORD = /^[0-9A-Za-z.+_-]{1,32}$/;
const MAX_BODY_BYTES = 2048;
const RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const ACTIVE_MS = 30 * 24 * 60 * 60 * 1000;

interface Report {
	instance: string;
	version: string;
	bun: string;
	os: string;
	arch: string;
	platforms: string;
	personas: string;
	spaces: string;
	features: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	!!value && typeof value === "object" && !Array.isArray(value);

/** The whitelist: anything unexpected rejects the whole report instead of being stored. */
export function parseReport(input: unknown): Report | undefined {
	if (!isRecord(input) || input.schema !== 1 || Object.keys(input).length !== 8) return;
	const { instance, version, runtime, platforms, personas, spaces, features } = input;
	if (typeof instance !== "string" || !UUID.test(instance)) return;
	if (typeof version !== "string" || !WORD.test(version)) return;
	if (!isRecord(runtime) || Object.keys(runtime).length !== 3) return;
	const { bun, os, arch } = runtime;
	if (![bun, os, arch].every((value) => typeof value === "string" && WORD.test(value))) return;
	if (!Array.isArray(platforms) || !platforms.every((value) => PLATFORMS.includes(value))) return;
	if (typeof personas !== "string" || !BUCKETS.includes(personas)) return;
	if (typeof spaces !== "string" || !BUCKETS.includes(spaces)) return;
	if (!isRecord(features) || Object.keys(features).length !== FEATURES.length) return;
	if (!FEATURES.every((name) => typeof features[name] === "boolean")) return;
	return {
		instance,
		version,
		bun: bun as string,
		os: os as string,
		arch: arch as string,
		platforms: [...new Set(platforms as string[])].sort().join(","),
		personas,
		spaces,
		features: JSON.stringify(Object.fromEntries(FEATURES.map((name) => [name, features[name]]))),
	};
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const { pathname } = new URL(request.url);
		if (request.method === "GET" && pathname === "/stats") {
			const now = Date.now();
			const total = await env.DB.prepare("SELECT COUNT(*) AS n FROM instances WHERE last_seen > ?")
				.bind(now - RETENTION_MS)
				.first<{ n: number }>();
			const active = await env.DB.prepare("SELECT COUNT(*) AS n FROM instances WHERE last_seen > ?")
				.bind(now - ACTIVE_MS)
				.first<{ n: number }>();
			return Response.json(
				{ instances_90d: total?.n ?? 0, instances_30d: active?.n ?? 0 },
				{ headers: { "cache-control": "public, max-age=300" } },
			);
		}
		if (request.method !== "POST" || pathname !== "/") return new Response(null, { status: 404 });
		const body = await request.text();
		if (body.length > MAX_BODY_BYTES) return new Response(null, { status: 413 });
		let report: Report | undefined;
		try {
			report = parseReport(JSON.parse(body));
		} catch {}
		if (!report) return new Response(null, { status: 400 });
		const now = Date.now();
		await env.DB.prepare(
			`INSERT INTO instances (instance, first_seen, last_seen, version, bun, os, arch, platforms, personas, spaces, features)
			 VALUES (?1, ?2, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
			 ON CONFLICT(instance) DO UPDATE SET last_seen = ?2, version = ?3, bun = ?4, os = ?5, arch = ?6,
			   platforms = ?7, personas = ?8, spaces = ?9, features = ?10`,
		)
			.bind(
				report.instance,
				now,
				report.version,
				report.bun,
				report.os,
				report.arch,
				report.platforms,
				report.personas,
				report.spaces,
				report.features,
			)
			.run();
		// Retention: rows not seen for 90 days are dropped.
		await env.DB.prepare("DELETE FROM instances WHERE last_seen < ?")
			.bind(now - RETENTION_MS)
			.run();
		return new Response(null, { status: 204 });
	},
};
