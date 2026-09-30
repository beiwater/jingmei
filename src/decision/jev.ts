import { readBoundedBody } from "../net/read-bounded-body.ts";
import { errorCategory, log } from "../observability/log.ts";

/** TypeSafe Jev decision model client (https://docs.typesafe.ai/api.md). Never logs text, state or key. */

export const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
export const NEW_EVENT_OPTION = "new";
const DEFAULT_TIMEOUT_MS = 3_000;
const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_RECENT_LINES = 5;
const NONE_OPTION = "none";

export interface JevConfig {
	endpoint?: string;
	apiKey?: string;
	model: string;
	/** Default 3000. Covers the request and reading the response body. */
	timeoutMs?: number;
}

export interface QuickReactionDecision {
	/** Chosen emoji from the offered table, or null when Jev chose `none`. */
	emoji: string | null;
	confidence: number;
	strongEmotion: number;
	funny: number;
}

export interface EventOption {
	id: string;
	description: string;
}

export interface JevClient {
	decideQuickReaction(input: {
		text: string;
		recent?: readonly string[];
		emojis: Readonly<Record<string, string>>;
	}): Promise<QuickReactionDecision>;
	/** Relevance of each candidate to the query in [0,1], same order; throws on failure. */
	scoreRelevance(query: string, candidates: readonly string[]): Promise<number[]>;
	chooseEvent(input: {
		message: string;
		recent?: readonly string[];
		options: readonly EventOption[];
	}): Promise<{ choice: string; confidence: number }>;
	/** Participation in this event, in [0,1], in the same order as members. */
	scoreParticipation(input: {
		event: string;
		transcript: readonly string[];
		members: readonly string[];
	}): Promise<number[]>;
}

export type JevErrorCode = "timeout" | "network" | "invalid_response" | `http_${number}`;

export class JevError extends Error {
	readonly code: JevErrorCode;
	constructor(code: JevErrorCode) {
		super(`Jev request failed: ${code}`);
		this.name = "JevError";
		this.code = code;
	}
}

type Question =
	| { type: "noul"; instructions: unknown; criteria?: { true: string; false: string } }
	| { type: "choice"; instructions: unknown; criteria: Record<string, string> };

interface NoulAnswer {
	type: "noul";
	noul: number;
}
interface ChoiceAnswer {
	type: "choice";
	choice: string;
	confidence: number;
}
type Answer = NoulAnswer | ChoiceAnswer;

const REACTION_INSTRUCTIONS =
	"Pick the one emoji reaction that best matches what `message` says or feels, as a friend in a Chinese group chat would react to it. " +
	"`recent` (if present) holds earlier chat lines for context only; judge `message` itself, not `recent`. " +
	"Each option's description says what that emoji means. Choose `none` if no option's meaning fits `message`, " +
	"or if `message` is neutral and does not call for any reaction.";

const STRONG_EMOTION_INSTRUCTIONS =
	"Does `message` itself express a strong emotion, such as intense excitement, joy, sadness, frustration, anger, shock, or affection? " +
	"`recent` (if present) is earlier context only; judge `message`.";

const FUNNY_INSTRUCTIONS =
	"Is `message` itself clearly funny, a joke, or deliberately humorous? " +
	"`recent` (if present) is earlier context only; judge `message`.";

function isUnit(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

/** Wire answer as received; every field is checked before use. */
interface RawAnswer {
	type?: unknown;
	noul?: unknown;
	choice?: unknown;
	confidence?: unknown;
}

function parseAnswers(payload: unknown, questions: Readonly<Record<string, Question>>): Record<string, Answer> {
	const rawAnswers =
		typeof payload === "object" && payload !== null && "answers" in payload ? payload.answers : undefined;
	if (typeof rawAnswers !== "object" || rawAnswers === null || Array.isArray(rawAnswers)) {
		throw new JevError("invalid_response");
	}
	const answers: Record<string, Answer> = {};
	for (const [id, question] of Object.entries(questions)) {
		const answer: unknown = Object.hasOwn(rawAnswers, id) ? (rawAnswers as Record<string, unknown>)[id] : undefined;
		if (typeof answer !== "object" || answer === null) throw new JevError("invalid_response");
		const raw = answer as RawAnswer;
		if (raw.type !== question.type) throw new JevError("invalid_response");
		if (question.type === "noul") {
			if (!isUnit(raw.noul)) throw new JevError("invalid_response");
			answers[id] = { type: "noul", noul: raw.noul };
		} else {
			if (typeof raw.choice !== "string" || !Object.hasOwn(question.criteria, raw.choice)) {
				throw new JevError("invalid_response");
			}
			if (!isUnit(raw.confidence)) throw new JevError("invalid_response");
			answers[id] = { type: "choice", choice: raw.choice, confidence: raw.confidence };
		}
	}
	return answers;
}

function noulOf(answers: Record<string, Answer>, id: string): number {
	const answer = answers[id];
	if (answer?.type !== "noul") throw new JevError("invalid_response");
	return answer.noul;
}

export function createJevClient(config: JevConfig, fetchImpl: typeof fetch = fetch): JevClient {
	const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const model = config.model || "jev-latest";

	async function evaluate(
		state: unknown,
		questions: Readonly<Record<string, Question>>,
	): Promise<Record<string, Answer>> {
		const signal = AbortSignal.timeout(timeoutMs);
		let bytes: Uint8Array | null;
		try {
			const response = await fetchImpl(config.endpoint ?? JEV_ENDPOINT, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
				},
				body: JSON.stringify({ state, model, questions }),
				signal,
			});
			if (!response.ok) {
				await response.body?.cancel().catch(() => {});
				throw new JevError(`http_${response.status}`);
			}
			bytes = await readBoundedBody(response, MAX_RESPONSE_BYTES);
		} catch (error) {
			if (error instanceof JevError) throw error;
			if (signal.aborted) throw new JevError("timeout");
			throw new JevError("network");
		}
		if (!bytes) throw new JevError("invalid_response");
		let payload: unknown;
		try {
			payload = JSON.parse(new TextDecoder().decode(bytes));
		} catch {
			throw new JevError("invalid_response");
		}
		return parseAnswers(payload, questions);
	}

	return {
		async decideQuickReaction({ text, recent, emojis }) {
			const criteria: Record<string, string> = {};
			for (const [emoji, meaning] of Object.entries(emojis)) {
				if (emoji !== NONE_OPTION) criteria[emoji] = meaning;
			}
			criteria[NONE_OPTION] = "没有合适的表情，或这条消息不需要表态";
			const state: { message: string; recent?: string[] } = { message: text };
			if (recent && recent.length > 0) state.recent = recent.slice(-MAX_RECENT_LINES);
			const answers = await evaluate(state, {
				reaction: { type: "choice", instructions: REACTION_INSTRUCTIONS, criteria },
				strong_emotion: {
					type: "noul",
					instructions: STRONG_EMOTION_INSTRUCTIONS,
					criteria: {
						true: "`message` clearly shows a strong, intense feeling.",
						false: "`message` is calm, neutral, or only mildly emotional.",
					},
				},
				funny: {
					type: "noul",
					instructions: FUNNY_INSTRUCTIONS,
					criteria: {
						true: "`message` is clearly meant to be funny or is genuinely amusing.",
						false: "`message` is not a joke and is not amusing.",
					},
				},
			});
			const reaction = answers.reaction;
			if (reaction?.type !== "choice") throw new JevError("invalid_response");
			return {
				emoji: reaction.choice === NONE_OPTION ? null : reaction.choice,
				confidence: reaction.confidence,
				strongEmotion: noulOf(answers, "strong_emotion"),
				funny: noulOf(answers, "funny"),
			};
		},

		async scoreRelevance(query, candidates) {
			if (candidates.length === 0) return [];
			const questions: Record<string, Question> = {};
			candidates.forEach((candidate, index) => {
				questions[`c${index}`] = {
					type: "noul",
					instructions: { candidate, question: "Is `candidate` relevant to the message in the state?" },
				};
			});
			const answers = await evaluate(query, questions);
			return candidates.map((_, index) => noulOf(answers, `c${index}`));
		},

		async chooseEvent({ message, recent, options }) {
			const criteria: Record<string, string> = Object.fromEntries(
				options.filter((option) => option.id !== NEW_EVENT_OPTION).map((option) => [option.id, option.description]),
			);
			criteria[NEW_EVENT_OPTION] = "与以上事件都无关，开启新话题";
			const state: { message: string; recent?: string[] } = { message };
			if (recent && recent.length > 0) state.recent = recent.slice(-MAX_RECENT_LINES);
			const answers = await evaluate(state, {
				event: {
					type: "choice",
					instructions:
						"判断 `message` 延续了哪个事件（话题）。`recent` 仅供理解上下文，选择最符合消息本身的事件；与所有事件无关时选择 `new`。",
					criteria,
				},
			});
			const answer = answers.event;
			if (answer?.type !== "choice") throw new JevError("invalid_response");
			return { choice: answer.choice, confidence: answer.confidence };
		},

		async scoreParticipation({ event, transcript, members }) {
			if (members.length === 0) return [];
			const questions: Record<string, Question> = {};
			members.forEach((member, index) => {
				questions[`m${index}`] = {
					type: "noul",
					instructions: {
						member,
						question:
							"`member` 是否参与了 state 中的事件（话题）？根据事件描述和聊天记录判断，不要把其他话题的发言算作参与。",
					},
				};
			});
			const answers = await evaluate({ event, transcript: transcript.slice(-MAX_RECENT_LINES) }, questions);
			return members.map((_, index) => noulOf(answers, `m${index}`));
		},
	};
}

/** A failed primary decision gets exactly one attempt through the local decision model. */
export function withFallback(primary: JevClient, fallback: JevClient): JevClient {
	async function attempt<T>(method: keyof JevClient, runPrimary: () => Promise<T>, runFallback: () => Promise<T>) {
		try {
			return await runPrimary();
		} catch (error) {
			log.warn("decision", "jev_fallback", {
				method,
				error_category: error instanceof JevError ? error.code : errorCategory(error),
			});
			return runFallback();
		}
	}
	return {
		decideQuickReaction: (input) =>
			attempt(
				"decideQuickReaction",
				() => primary.decideQuickReaction(input),
				() => fallback.decideQuickReaction(input),
			),
		scoreRelevance: (query, candidates) =>
			attempt(
				"scoreRelevance",
				() => primary.scoreRelevance(query, candidates),
				() => fallback.scoreRelevance(query, candidates),
			),
		chooseEvent: (input) =>
			attempt(
				"chooseEvent",
				() => primary.chooseEvent(input),
				() => fallback.chooseEvent(input),
			),
		scoreParticipation: (input) =>
			attempt(
				"scoreParticipation",
				() => primary.scoreParticipation(input),
				() => fallback.scoreParticipation(input),
			),
	};
}

/**
 * Addressed messages always get the chosen emoji (null when Jev chose `none`).
 * Unaddressed messages get it only when max(strongEmotion, funny) ≥ threshold.
 */
export function shouldQuickReact(
	decision: Pick<QuickReactionDecision, "emoji" | "strongEmotion" | "funny">,
	addressed: boolean,
	threshold: number,
): string | null {
	if (addressed) return decision.emoji;
	return Math.max(decision.strongEmotion, decision.funny) >= threshold ? decision.emoji : null;
}
