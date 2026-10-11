import type { StreamFn } from "@earendil-works/pi-agent-core";
import {
	type Api,
	type AssistantMessage,
	type Context,
	createAssistantMessageEventStream,
	type Model,
} from "@earendil-works/pi-ai";
import type { AgentSession, ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { Conversation } from "../../src/core/conversation.ts";
import type { Persona, SpaceId } from "../../src/core/types.ts";

/** A 1x1 PNG header-sized payload: enough for tests that only need "an image" to flow through. */
export const IMAGE = { mimeType: "image/png" as const, base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB" };

export type FixtureModel = Model<"openai-responses">;

/** A text-only fixture model; override only what a test actually varies (id, provider, input, contextWindow). */
export function makeModel(overrides: Partial<FixtureModel> = {}): FixtureModel {
	const id = overrides.id ?? "fixture";
	return {
		id,
		name: id,
		api: "openai-responses",
		provider: "fixture",
		baseUrl: "http://unused",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 65536,
		maxTokens: 4096,
		...overrides,
	};
}

/**
 * The slice of `ModelRuntime` the core uses for model lookup and auth. `models` is one model or a resolver;
 * `extras` adds stubs a test observes or drives (`completeSimple`, `refresh`, `checkAuth`).
 */
export function makeRuntime(
	models: FixtureModel | ((provider: string, id: string) => FixtureModel | undefined) = makeModel(),
	extras: Record<string, unknown> = {},
): ModelRuntime {
	return {
		getModel: typeof models === "function" ? models : () => models,
		hasConfiguredAuth: () => true,
		getAuth: async () => ({ auth: { apiKey: "fixture" } }),
		...extras,
	} as unknown as ModelRuntime;
}

/** A provider reply shaped like `model`'s; a string becomes one text block. Token counts feed segment sizing. */
export function assistantMessage(
	content: string | AssistantMessage["content"],
	options: {
		model?: Pick<Model<Api>, "api" | "provider" | "id">;
		stopReason?: AssistantMessage["stopReason"];
		tokens?: { input: number; output: number };
	} = {},
): AssistantMessage {
	const model = options.model ?? makeModel();
	const { input, output } = options.tokens ?? { input: 1, output: 1 };
	return {
		role: "assistant",
		content: typeof content === "string" ? [{ type: "text", text: content }] : content,
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input,
			output,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: input + output,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: options.stopReason ?? "stop",
		timestamp: Date.now(),
	};
}

/** A finished provider stream: `error`/`aborted` end as an error event, everything else as `done`. */
export function streamOf(message: AssistantMessage) {
	const stream = createAssistantMessageEventStream();
	if (message.stopReason === "error" || message.stopReason === "aborted")
		stream.push({ type: "error", reason: message.stopReason, error: message });
	else stream.push({ type: "done", reason: message.stopReason as "stop", message });
	return stream;
}

/**
 * A deterministic provider: each call shifts the next scripted reply (a message, or a stream function for
 * held/stuck providers), falling back to `fallback()` when the script is empty. `onCall` sees every request.
 */
export function scriptedStream(
	script: Array<AssistantMessage | StreamFn>,
	fallback: () => AssistantMessage,
	onCall?: (context: Context) => void,
): StreamFn {
	return (model, context, options) => {
		onCall?.(context);
		const next = script.shift() ?? fallback();
		return typeof next === "function" ? next(model, context, options) : streamOf(next);
	};
}

/** Private seam: tests drive real Pi sessions directly to inject deterministic provider streams. */
export type SessionSeam = {
	getSession(persona: Persona, spaceId: SpaceId, channelId: string): Promise<AgentSession>;
};

export const seamOf = (core: Conversation) => core as unknown as SessionSeam;

/** Runs `attach` once for every Pi session the core opens, before the session is first used. */
export function onSession(core: Conversation, attach: (session: AgentSession, persona: Persona) => void): SessionSeam {
	const seam = seamOf(core);
	const original = seam.getSession.bind(core);
	const attached = new Set<AgentSession>();
	seam.getSession = async (...args) => {
		const session = await original(...args);
		if (!attached.has(session)) {
			attached.add(session);
			attach(session, args[0]);
		}
		return session;
	};
	return seam;
}
