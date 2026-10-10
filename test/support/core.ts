import type { Persona, PlatformTransport } from "../../src/core/types.ts";

/** A text-only persona with every optional capability off; tests override only what they exercise. */
export function makePersona(overrides: Partial<Persona> = {}): Persona {
	const id = overrides.id ?? "luna";
	return {
		id,
		name: id,
		personaPath: "/unused",
		provider: "fixture",
		model: "fixture",
		reasoningEffort: "off",
		routingP: 0,
		aliases: [],
		adminUserIds: [],
		sendReactionImages: false,
		voiceEnabled: false,
		imageGenerationEnabled: false,
		accounts: {},
		...overrides,
	};
}

/**
 * A transport that accepts everything. Like the real platforms, only Discord echoes the bot's own sends back
 * through the inbound stream; pass `echoesOwnMessages` to override.
 */
export function makeTransport(overrides: Partial<PlatformTransport> = {}): PlatformTransport {
	const platform = overrides.platform ?? "discord";
	return {
		platform,
		echoesOwnMessages: platform === "discord",
		displayName: platform,
		promptLines: [],
		quickReactions: {},
		sendMessage: async () => ({ id: "1" }),
		formatMention: (user) => `@${user.username}`,
		isValidReaction: () => true,
		...overrides,
	};
}
