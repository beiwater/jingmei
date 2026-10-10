import { Database } from "bun:sqlite";
import { BotState } from "../../src/core/bot-state.ts";
import type { ConversationOptions } from "../../src/core/conversation.ts";
import { MemberMemory } from "../../src/core/memory.ts";
import { SoulStore } from "../../src/core/soul.ts";
import type { Persona, PlatformTransport } from "../../src/core/types.ts";
import { makeRuntime } from "./pi.ts";

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

/**
 * `ConversationOptions` over an in-memory database with fresh bot state, member memory and soul store.
 * Pass `db` (or `soulStore`, `botState`, `memberMemory`) to share storage across restarts or with other
 * components; anything else in `ConversationOptions` overrides the default.
 */
export function conversationOptions(
	options: Partial<Omit<ConversationOptions, "transports">> & {
		personas: readonly Persona[];
		transports: readonly PlatformTransport[];
	},
): ConversationOptions {
	const db = options.db ?? new Database(":memory:");
	return {
		db,
		botState: new BotState(db),
		memberMemory: new MemberMemory(db),
		soulStore: new SoulStore({ db, personaIds: options.personas.map((persona) => persona.id) }),
		dataDir: "/unused",
		routingSecret: "fixture",
		modelRuntime: makeRuntime(),
		...options,
		transports: new Map(options.transports.map((transport) => [transport.platform, transport])),
	};
}
