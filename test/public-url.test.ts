import { expect, test } from "bun:test";
import { parsePublicHttpUrl } from "../src/net/public-url.ts";

test("accepts public http(s) hosts and globally routable IPv6 literals", () => {
	expect(parsePublicHttpUrl("https://example.com/a?b=1")).toEqual({
		url: "https://example.com/a?b=1",
		hostname: "example.com",
	});
	expect(parsePublicHttpUrl("http://8.8.8.8/")?.hostname).toBe("8.8.8.8");
	expect(parsePublicHttpUrl("https://[2606:4700::1111]/")?.hostname).toBe("2606:4700::1111");
	for (const address of [
		"2000::",
		"3fff:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
		"2001:0000:0DB8:0000:0000:0000:0000:0001",
		"2001:db7:ffff::1",
		"2001:db9::1",
		"2000::8.8.8.8",
	])
		expect(parsePublicHttpUrl(`http://[${address}]/`)?.hostname).toBe(
			new URL(`http://[${address}]/`).hostname.slice(1, -1),
		);
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
		"http://[::]/",
		"http://[::8.8.8.8]/",
		"http://[0:0:0:0:0:ffff:8.8.8.8]/",
		"http://[64:ff9b::8.8.8.8]/",
		"http://[1fff:ffff:ffff:ffff:ffff:ffff:ffff:ffff]/",
		"http://[4000::]/",
		"http://[fc00::1]/",
		"http://[2001:0DB8:0000:0000:0000:0000:0000:0001]/",
		"http://[2001:db8:ffff:ffff:ffff:ffff:ffff:ffff]/",
		"http://[2001:db8::8.8.8.8]/",
		"http://[::ffff:127.0.0.1]/",
		"http://[100::1]/",
		"http://[fd00::1]/",
		"http://[fe80::1]/",
		"http://[ff02::1]/",
		"http://[2001:db8::1]/",
	])
		expect(parsePublicHttpUrl(url)).toBeNull();
});
