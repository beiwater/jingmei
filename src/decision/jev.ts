import { readBoundedBody } from "../net/read-bounded-body.ts";
import { errorCategory, log } from "../observability/log.ts";

/**
 * Decision model client: TypeSafe Jev (https://docs.typesafe.ai/api.md) or the OpenAI Decisions API
 * (https://developers.openai.com/api/docs/guides/decisions), behind one question model. Never logs text, state or key.
 */

export const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
export const OPENAI_DECISIONS_ENDPOINT = "https://api.openai.com/v1/decisions";
export const OPENAI_DECISIONS_MODEL = "gpt-6-luna";
export const NEW_EVENT_OPTION = "new";
const DEFAULT_TIMEOUT_MS = 3_000;
const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_RECENT_LINES = 5;
const NONE_OPTION = "none";

export type JevProvider = "typesafe" | "openai";

export interface JevConfig {
	/** Wire format of `endpoint`; default `typesafe`. */
	provider?: JevProvider;
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

export interface EventDecision {
	choice: string;
	confidence: number;
	probabilities?: Record<string, number>;
}

export interface ParticipationDecision {
	directedPersonaId: string | null;
	/** Present only when chat-in scoring was requested. */
	chatIn?: number;
}

export interface JevClient {
	decideQuickReaction(input: {
		text: string;
		recent?: readonly string[];
		emojis: Readonly<Record<string, string>>;
	}): Promise<QuickReactionDecision>;
	decideParticipation(input: {
		message: string;
		recent?: readonly string[];
		personas: readonly { id: string; name: string; aliases: readonly string[] }[];
		chatIn: boolean;
	}): Promise<ParticipationDecision>;
	/** Probability that the reply is natural chat text ready to post, not internal planning. */
	auditNatural(input: { reply: string; message: string; recent?: readonly string[] }): Promise<number>;
	/** Relevance of each candidate to the query in [0,1], same order; throws on failure. */
	scoreRelevance(query: string, candidates: readonly string[]): Promise<number[]>;
	chooseEvent(input: {
		message: string;
		recent?: readonly string[];
		options: readonly EventOption[];
	}): Promise<EventDecision>;
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
	probabilities?: Record<string, number>;
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

// Measured on a real Telegram window: the looser "continuing the bot counts" wording called 65 of 65
// unaddressed messages (stickers, links, members talking to each other) directed at the bot.
const DIRECTED_INSTRUCTIONS =
	"判断 `message` 是不是在对某个机器人角色说话。选项描述给出角色名字和别名；`message` 与 `recent` 都以「发言者: 内容」开头。" +
	"没有 @、回复引用或名字时，只有 `message` 明显是在回应机器人刚说的那句话（回答它的问题、接它的话茬、反驳或追问它）才算。" +
	"群友接着自己或其他群友的话说、自言自语、发贴纸或表情、谈论机器人、对全群说话，都选 `none`；" +
	"机器人刚说过话不代表下一条就是对它说的。拿不准时选 `none`。";

// The previous "is chiming in appropriate?" wording scored 0 on all 193 messages of a real Telegram
// window. This one rejects stickers, one-word acks, two-person exchanges and bot commands (19 of 193).
const CHAT_IN_INSTRUCTIONS =
	"`recent` 是群聊最近几条，`message` 是最新一条，都以「发言者: 内容」开头。" +
	"一个爱聊天的群友看到 `message` 后接一句，会不会显得自然？" +
	"`message` 有可接的内容（观点、吐槽、问题、梗、新闻、求助、分享）时接一句就自然；" +
	"只有纯贴纸/表情/单字附和、明显是两个人之间的私下对话、或者话题已经说完时才不自然。";

const NATURAL_INSTRUCTIONS =
	"判断 `reply` 是否是可以原样发到群里的自然聊天正文，而不是机器人的内部思考或写作计划。" +
	"内部计划、元叙述、重述事件或触发消息（如「当前事件」「触发消息」标签）、对自己的指令、" +
	"分析应采用的风格或长度、列出备选说法或草稿、讨论接下来要说什么，均不是自然正文。" +
	"自然正文不论长短都可以：简短回答、接梗、情绪表达、追问，以及直接讲给群友的长篇讲解、解题步骤、分点、公式或代码。" +
	"是否需要接话已由路由决定，不重新判断；只检查正文是否泄漏规划，不审核安全、事实准确性、长度格式或是否有新信息。";

function isUnit(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

/** Wire answer as received; every field is checked before use. */
interface RawAnswer {
	type?: unknown;
	noul?: unknown;
	choice?: unknown;
	confidence?: unknown;
	probabilities?: unknown;
}

function parseAnswers(
	payload: unknown,
	questions: Readonly<Record<string, Question>>,
	strictProbabilities = false,
): Record<string, Answer> {
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
			const parsed: ChoiceAnswer = { type: "choice", choice: raw.choice, confidence: raw.confidence };
			if (
				typeof raw.probabilities === "object" &&
				raw.probabilities !== null &&
				!Array.isArray(raw.probabilities) &&
				Object.entries(raw.probabilities).every(
					([key, value]) => Object.hasOwn(question.criteria, key) && isUnit(value),
				)
			) {
				parsed.probabilities = raw.probabilities as Record<string, number>;
			} else if (strictProbabilities && Object.hasOwn(raw, "probabilities")) {
				throw new JevError("invalid_response");
			}
			answers[id] = parsed;
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
	const openai = config.provider === "openai";
	const model = config.model || (openai ? OPENAI_DECISIONS_MODEL : "jev-latest");
	const endpoint = config.endpoint ?? (openai ? OPENAI_DECISIONS_ENDPOINT : JEV_ENDPOINT);

	return createJevClientWithTransport(async (state, questions) => {
		const signal = AbortSignal.timeout(timeoutMs);
		let bytes: Uint8Array | null;
		try {
			const response = await fetchImpl(endpoint, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
				},
				body: JSON.stringify(openai ? toOpenAiRequest(model, state, questions) : { state, model, questions }),
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
		return openai ? fromOpenAiResponse(payload) : payload;
	});
}

function text(value: unknown): string {
	return typeof value === "string" ? value : JSON.stringify(value);
}

/** OpenAI has no `criteria` on a predicate: the true/false descriptions join its instructions. */
function toOpenAiRequest(model: string, state: unknown, questions: Readonly<Record<string, Question>>) {
	return {
		model,
		input: text(state),
		questions: Object.entries(questions).map(([name, question]) =>
			question.type === "noul"
				? {
						type: "predicate",
						name,
						instructions: question.criteria
							? `${text(question.instructions)}\n是：${question.criteria.true}\n否：${question.criteria.false}`
							: text(question.instructions),
					}
				: {
						type: "choice",
						name,
						instructions: text(question.instructions),
						choices: Object.entries(question.criteria).map(([value, description]) => ({ value, description })),
					},
		),
	};
}

/** Re-keys OpenAI answers by name in the TypeSafe shape; a refusal or unknown type fails `parseAnswers`. */
function fromOpenAiResponse(payload: unknown) {
	const list = typeof payload === "object" && payload !== null && "answers" in payload ? payload.answers : undefined;
	if (!Array.isArray(list)) throw new JevError("invalid_response");
	const answers: Record<string, unknown> = {};
	for (const answer of list) {
		if (typeof answer !== "object" || answer === null || typeof answer.name !== "string") continue;
		if (answer.type === "predicate") answers[answer.name] = { type: "noul", noul: answer.probability };
		else if (answer.type === "choice")
			answers[answer.name] = {
				type: "choice",
				choice: answer.choice,
				confidence: answer.confidence,
				...(Array.isArray(answer.probabilities)
					? {
							probabilities: Object.fromEntries(
								answer.probabilities.map((entry: { value?: unknown; probability?: unknown }) => [
									entry.value,
									entry.probability,
								]),
							),
						}
					: {}),
			};
	}
	return { answers };
}

export function createJevClientWithTransport(
	transport: (state: unknown, questions: Readonly<Record<string, Question>>) => Promise<unknown>,
): JevClient {
	async function evaluate(state: unknown, questions: Readonly<Record<string, Question>>) {
		return parseAnswers(await transport(state, questions), questions);
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

		async decideParticipation({ message, recent, personas, chatIn }) {
			const criteria: Record<string, string> = Object.fromEntries(
				personas.map((persona) => [persona.id, `${persona.name}（别名：${persona.aliases.join("、")}）`]),
			);
			criteria[NONE_OPTION] = "没有在对任何机器人角色说话";
			const state: { message: string; recent?: string[] } = { message };
			if (recent && recent.length > 0) state.recent = recent.slice(-MAX_RECENT_LINES);
			const questions: Record<string, Question> = {
				directed: { type: "choice", instructions: DIRECTED_INSTRUCTIONS, criteria },
			};
			if (chatIn)
				questions.chat_in = {
					type: "noul",
					instructions: CHAT_IN_INSTRUCTIONS,
					criteria: { true: "群友接一句很自然。", false: "接一句会显得多余或打扰。" },
				};
			const answers = parseAnswers(await transport(state, questions), questions, true);
			const directed = answers.directed;
			if (directed?.type !== "choice") throw new JevError("invalid_response");
			let winner = directed.choice;
			let probability = directed.confidence;
			if (directed.probabilities) {
				probability = 0;
				for (const [id, value] of Object.entries(directed.probabilities)) {
					if (value > probability) {
						winner = id;
						probability = value;
					}
				}
			}
			const result: ParticipationDecision = {
				directedPersonaId: winner !== NONE_OPTION && probability >= 0.5 ? winner : null,
			};
			if (chatIn) result.chatIn = noulOf(answers, "chat_in");
			return result;
		},

		async auditNatural({ reply, message, recent }) {
			const state: { reply: string; message: string; recent?: string[] } = { reply, message };
			if (recent && recent.length > 0) state.recent = recent.slice(-MAX_RECENT_LINES);
			const answers = await evaluate(state, {
				natural: {
					type: "noul",
					instructions: NATURAL_INSTRUCTIONS,
					// Without criteria the model withheld ~12% of real chat replies on security/crypto topics; with the
					// earlier short-reply wording it withheld every long step-by-step answer (e.g. worked maths solutions).
					criteria: {
						true: "`reply` 从头到尾都是直接对群友说的话（长篇讲解、解题步骤、分点或公式也算），可以原样发到群里。",
						false:
							"`reply` 含有机器人写给自己的规划：用第三人称复述群里谁说了什么、分析自己该怎么回或该用什么风格长度、列出几种备选说法或草稿、复述事件或触发消息、对自己下指令。",
					},
				},
			});
			return noulOf(answers, "natural");
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
						"判断 `message` 延续了哪个事件（话题）。短回复、追问、赞同和情绪反应通常延续 `recent` 中正在进行的话题；只有 `message` 明确引入与所有事件都无关的内容时才选择 `new`。",
					criteria,
				},
			});
			const answer = answers.event;
			if (answer?.type !== "choice") throw new JevError("invalid_response");
			const result: EventDecision = {
				choice: answer.choice,
				confidence: answer.confidence,
			};
			if (answer.probabilities) result.probabilities = answer.probabilities;
			return result;
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
		decideParticipation: (input) =>
			attempt(
				"decideParticipation",
				() => primary.decideParticipation(input),
				() => fallback.decideParticipation(input),
			),
		auditNatural: (input) =>
			attempt(
				"auditNatural",
				() => primary.auditNatural(input),
				() => fallback.auditNatural(input),
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
