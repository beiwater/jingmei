import { isIP } from "node:net";

export interface PublicHttpUrl {
	url: string;
	hostname: string;
}

function parseIpv4(hostname: string): [number, number, number, number] | undefined {
	if (isIP(hostname) !== 4) return undefined;
	const octets = hostname.split(".").map(Number);
	if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return undefined;
	return octets as [number, number, number, number];
}

function isBlockedIpv4([a, b, c]: [number, number, number, number]): boolean {
	return (
		a === 0 ||
		a === 10 ||
		(a === 100 && b >= 64 && b <= 127) ||
		a === 127 ||
		(a === 169 && b === 254) ||
		(a === 172 && b >= 16 && b <= 31) ||
		(a === 192 && b === 0 && c === 0) ||
		(a === 192 && b === 0 && c === 2) ||
		(a === 192 && b === 168) ||
		(a === 198 && (b === 18 || b === 19)) ||
		(a === 198 && b === 51 && c === 100) ||
		(a === 203 && b === 0 && c === 113) ||
		a >= 224
	);
}

/**
 * Only globally routable unicast (2000::/3) outside the documentation prefix is public. This also
 * rejects loopback, unspecified, IPv4-mapped/NAT64 forms, discard-only 100::/64, ULA,
 * link-local and multicast.
 */
function isBlockedIpv6(hostname: string): boolean {
	// URL canonicalization removes leading zeros and dotted tails before this prefix check.
	return !/^[23][0-9a-f]{3}:/.test(hostname) || hostname.startsWith("2001:db8:");
}

/** Parse one literal public HTTP(S) URL without DNS resolution or network access. */
export function parsePublicHttpUrl(input: string, maxChars = 2_048): PublicHttpUrl | null {
	if (!input || input.length > maxChars) return null;
	let parsed: URL;
	try {
		parsed = new URL(input);
	} catch {
		return null;
	}
	if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.username || parsed.password) return null;
	const hostname = parsed.hostname
		.replace(/^\[|\]$/g, "")
		.replace(/\.$/, "")
		.toLowerCase();
	if (
		!hostname ||
		hostname === "localhost" ||
		hostname.endsWith(".localhost") ||
		hostname === "local" ||
		hostname.endsWith(".local") ||
		hostname.endsWith(".internal")
	)
		return null;
	const ipv4 = parseIpv4(hostname);
	if (ipv4 && isBlockedIpv4(ipv4)) return null;
	if (hostname.includes(":") && isBlockedIpv6(hostname)) return null;
	return { url: parsed.toString(), hostname };
}
