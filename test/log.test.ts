import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { log, setLogSink } from "../src/observability/log.ts";

let lines: string[] = [];
let restore: () => void = () => {};

beforeEach(() => {
	lines = [];
	restore = setLogSink((line) => lines.push(line));
});

afterEach(() => restore());

function fieldsOf(fields: Record<string, unknown>): Record<string, unknown> {
	log.error("test", "event", fields);
	expect(lines).toHaveLength(1);
	return JSON.parse(lines[0] ?? "{}").fields;
}

describe("log redaction", () => {
	test("persona_id stays visible so multi-persona logs are attributable", () => {
		expect(fieldsOf({ persona_id: "luna", chat_id: "123" })).toEqual({ persona_id: "luna", chat_id: "123" });
	});

	test("sensitive field names are still redacted", () => {
		const fields = fieldsOf({
			token: "a",
			bot_token: "b",
			api_key: "c",
			prompt: "d",
			content: "e",
			url: "f",
			path: "g",
			persona_id: "luna",
		});
		expect(fields).toEqual({
			token: "[redacted]",
			bot_token: "[redacted]",
			api_key: "[redacted]",
			prompt: "[redacted]",
			content: "[redacted]",
			url: "[redacted]",
			path: "[redacted]",
			persona_id: "luna",
		});
	});

	test("secrets inside free-form strings are scrubbed", () => {
		const { detail } = fieldsOf({
			detail: "bot 123456789:ABCdefGHIjklMNOpqr sk-abcdefghijkl https://example.com/x at /srv/app/.env",
		});
		expect(detail).toBe("bot [redacted-token] [redacted-key] [redacted-url] at [redacted-path]");
	});
});
