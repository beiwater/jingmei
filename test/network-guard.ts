// Tests may download models, but must never call a chat platform with real credentials.

import { useExtensibleSqlite } from "../src/core/db.ts";
import { setLogSink } from "../src/observability/log.ts";

useExtensibleSqlite();

// Production writes JSONL to stdout. Tests capture individual events explicitly and keep the
// default suite output quiet, including high-volume boundedness fixtures.
setLogSink(() => {});

const nativeFetch = globalThis.fetch.bind(globalThis);

function isChatPlatform(hostname: string): boolean {
	const normalized = hostname.toLowerCase().replace(/\.$/, "");
	return (
		normalized === "api.telegram.org" ||
		["discord.com", "discordapp.com", "discord.gg", "discordapp.net"].some(
			(host) => normalized === host || normalized.endsWith(`.${host}`),
		)
	);
}

globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
	let target: URL;
	try {
		target = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
	} catch {
		return nativeFetch(input, init);
	}
	if ((target.protocol === "http:" || target.protocol === "https:") && isChatPlatform(target.hostname)) {
		return Promise.reject(new Error("chat platform network is disabled in bun test"));
	}
	return nativeFetch(input, init);
}) as typeof fetch;
