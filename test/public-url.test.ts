import { expect, test } from "bun:test";
import { parsePublicHttpUrl } from "../src/net/public-url.ts";

test("accepts public http(s) hosts and globally routable IPv6 literals", () => {
	expect(parsePublicHttpUrl("https://example.com/a?b=1")).toEqual({
		url: "https://example.com/a?b=1",
		hostname: "example.com",
	});
	expect(parsePublicHttpUrl("http://8.8.8.8/")?.hostname).toBe("8.8.8.8");
	expect(parsePublicHttpUrl("https://[2606:4700::1111]/")?.hostname).toBe("2606:4700::1111");
});

test("rejects private, internal and non-routable targets", () => {
	for (const url of [
		"ftp://example.com/",
		"https://user:pass@example.com/",
		"http://localhost/",
		"http://printer.local/",
		"http://metadata.google.internal/",
		"http://127.0.0.1/",
		"http://10.1.2.3/",
		"http://169.254.169.254/",
		"http://192.168.0.1/",
		"http://[::1]/",
		"http://[::ffff:127.0.0.1]/",
		"http://[100::1]/",
		"http://[fd00::1]/",
		"http://[fe80::1]/",
		"http://[ff02::1]/",
		"http://[2001:db8::1]/",
	])
		expect(parsePublicHttpUrl(url)).toBeNull();
});
