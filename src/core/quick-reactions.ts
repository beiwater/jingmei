import { type JevClient, shouldQuickReact } from "../decision/jev.ts";
import type { InboundMessage, Persona, Platform, PlatformTransport, Route } from "./types.ts";

export interface JevIntegration {
	client: JevClient;
	quickReactions: boolean;
	memoryScoring: boolean;
	/** Minimum max(strongEmotion, funny) for reacting to an unaddressed message. */
	threshold: number;
	/** Minimum gap between unaddressed quick reactions in one channel. */
	minIntervalMs: number;
	/** Per-platform emoji tables overriding `transport.quickReactions`. */
	emojis?: Partial<Record<Platform, Record<string, string>>>;
}

/**
 * One Jev call per human message picks an emoji from the platform table. Addressed messages get
 * it from the routed persona; unaddressed ones only on strong emotion/humour, rate-limited per
 * channel, from the first in-scope persona. Callers fire this without awaiting the main turn.
 */
export class QuickReactions {
	private readonly lastUnaddressed = new Map<string, number>();

	constructor(
		private readonly jev: JevIntegration,
		private readonly transports: ReadonlyMap<Platform, PlatformTransport>,
		private readonly now: () => number = Date.now,
	) {}

	async react(
		message: InboundMessage,
		route: Route,
		scopedPersonas: readonly Persona[],
		recent: readonly string[],
	): Promise<void> {
		if (message.isBot || !message.content.trim()) return;
		const transport = this.transports.get(message.platform);
		if (!transport?.addReaction) return;
		const addressed = route.reason === "explicit" || route.reason === "reply" || route.reason === "name";
		const reactor = addressed ? scopedPersonas.find((persona) => persona.id === route.personaId) : scopedPersonas[0];
		if (!reactor) return;
		const channelKey = `${message.spaceId}\0${message.channelId}`;
		const limited = () => this.now() - (this.lastUnaddressed.get(channelKey) ?? -Infinity) < this.jev.minIntervalMs;
		// A rate-limited unaddressed message cannot react, so it does not spend a Jev call either.
		if (!addressed && limited()) return;
		const emojis = Object.fromEntries(
			Object.entries(this.jev.emojis?.[message.platform] ?? transport.quickReactions).filter(([emoji]) =>
				transport.isValidReaction(emoji),
			),
		);
		if (!Object.keys(emojis).length) return;
		const decision = await this.jev.client.decideQuickReaction({ text: message.content, recent, emojis });
		const emoji = shouldQuickReact(decision, addressed, this.jev.threshold);
		if (!emoji || !Object.hasOwn(emojis, emoji)) return;
		if (!addressed) {
			// Re-check after the await: concurrent decisions in one channel share one slot.
			if (limited()) return;
			this.lastUnaddressed.set(channelKey, this.now());
		}
		await transport.addReaction(reactor.id, message.channelId, message.messageId, emoji);
	}
}
