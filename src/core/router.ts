import { createHmac } from "node:crypto";
import type { InboundMessage, Persona, Route } from "./types.ts";

/** The single scope filter: the persona has a verified account on this platform and serves this space. */
export function personaInScope(persona: Persona, message: Pick<InboundMessage, "platform" | "spaceId">): boolean {
	return !!persona.accounts[message.platform] && (!persona.spaces || persona.spaces.includes(message.spaceId));
}

/**
 * Deterministic, replay-safe router: explicit mention > reply > name/alias > HMAC-sampled
 * cumulative probability in configured persona order. Bot messages never trigger anyone.
 */
export function routeMessage(message: InboundMessage, personas: readonly Persona[], secret: string): Route {
	const scoped = personas.filter((persona) => personaInScope(persona, message));
	if (message.isBot || scoped.length === 0) return { personaId: null, reason: "nobody" };
	const userIdOf = (persona: Persona) => persona.accounts[message.platform]!.userId;
	const mentions = new Set(message.mentionedUserIds ?? []);
	const explicit = scoped.find((persona) => mentions.has(userIdOf(persona)));
	if (explicit) return { personaId: explicit.id, reason: "explicit" };
	const replied = scoped.find((persona) => message.replyToAuthorId === userIdOf(persona));
	if (replied) return { personaId: replied.id, reason: "reply" };
	const text = message.content.toLocaleLowerCase();
	const named = scoped.find((persona) =>
		[persona.name, ...persona.aliases].some((label) => label.trim() && text.includes(label.trim().toLocaleLowerCase())),
	);
	if (named) return { personaId: named.id, reason: "name" };
	const digest = createHmac("sha256", secret)
		.update(`${message.spaceId}:${message.channelId}:${message.messageId}`)
		.digest();
	const sample = digest.readUIntBE(0, 6) / 2 ** 48;
	let cumulative = 0;
	for (const persona of scoped) {
		cumulative += persona.routingP;
		if (sample < cumulative) return { personaId: persona.id, reason: "probability" };
	}
	return { personaId: null, reason: "nobody" };
}
