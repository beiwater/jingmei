import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { compact, type AgentSession, type InlineExtension, type ModelRuntime } from "@earendil-works/pi-coding-agent";
import { errorCategory, log } from "../observability/log.ts";
import { identityFacts, type PromptIdentity } from "./prompt.ts";
import type { PlatformTransport } from "./types.ts";

/** Wire values predate the multi-platform core; they are persisted in existing session files. */
export const CONTEXT_MESSAGE_TYPE = "discord_context_v1";
export const PENDING_SOUL_TYPE = "discord_pending_soul_v1";
export const WITHHELD_MESSAGE_TYPE = "jingmei_withheld_v1";

export interface ContextImageRef {
	/** File name inside the private media dir; never a path. */
	name: string;
	mime: "image/jpeg" | "image/png";
	/** Auxiliary vision description, used only for personas whose model cannot see images. */
	description?: string;
}

/** Persisted in the custom message; image bytes are resolved only while building the provider payload. */
export interface ContextDetails {
	version: 1;
	providerText: string;
	images: ContextImageRef[];
	/**
	 * Turn guidance (current event) frozen when the message was written. It is projected on every
	 * request, so the cached prefix never changes after a message is appended.
	 */
	turnNote?: string;
}

function isContextDetails(value: unknown): value is ContextDetails {
	if (!value || typeof value !== "object") return false;
	const details = value as Partial<ContextDetails>;
	return (
		details.version === 1 &&
		typeof details.providerText === "string" &&
		Array.isArray(details.images) &&
		details.images.every(
			(image) =>
				image &&
				typeof image.name === "string" &&
				!image.name.includes("/") &&
				(image.mime === "image/jpeg" || image.mime === "image/png") &&
				(image.description === undefined || typeof image.description === "string"),
		) &&
		(details.turnNote === undefined || typeof details.turnNote === "string")
	);
}

export interface ProjectionOptions {
	mediaDir: string;
	personaId: string;
	formalSoul: string;
	/** Whether the session model accepts image input. */
	imageInput: boolean;
}

/**
 * Provider-context projection (rebuilt per request, never persisted):
 * - pending-soul notes already promoted into the formal soul are dropped;
 * - withheld-turn markers and the assistant messages after their preceding input are dropped;
 * - thinking blocks of completed turns (assistant messages before the last user/custom message)
 *   are dropped, keeping those of the in-progress tool loop;
 * - chat messages expand to text + image blocks; for text-only models an image with a vision
 *   description becomes `[图片：…]` text, otherwise the block is left for Pi to downgrade;
 * - a chat message's turn note, frozen at write time, follows its text on every request;
 */
function projectContext(messages: readonly AgentMessage[], options: ProjectionOptions): AgentMessage[] {
	let lastInput = -1;
	let withheld = false;
	const withheldAssistants = new Set<number>();
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index]!;
		if (message.role === "custom" && message.customType === WITHHELD_MESSAGE_TYPE) {
			withheld = true;
		} else if (message.role === "user" || message.role === "custom") {
			if (lastInput === -1) lastInput = index;
			withheld = false;
		} else if (withheld && message.role === "assistant") {
			withheldAssistants.add(index);
		}
	}
	const projected: AgentMessage[] = [];
	messages.forEach((message, index) => {
		if (message.role === "custom" && message.customType === WITHHELD_MESSAGE_TYPE) return;
		if (withheldAssistants.has(index)) return;
		if (isPromotedSoulNote(message, options.personaId, options.formalSoul)) return;
		if (message.role === "assistant") {
			projected.push(
				index < lastInput && message.content.some((part) => part.type === "thinking")
					? { ...message, content: message.content.filter((part) => part.type !== "thinking") }
					: message,
			);
			return;
		}
		if (
			message.role !== "custom" ||
			message.customType !== CONTEXT_MESSAGE_TYPE ||
			!isContextDetails(message.details)
		) {
			projected.push(message);
			return;
		}
		const { images, turnNote } = message.details;
		const providerText = turnNote ? `${message.details.providerText}\n\n${turnNote}` : message.details.providerText;
		if (!images.length) {
			projected.push({ ...message, content: providerText });
			return;
		}
		const content: (TextContent | ImageContent)[] = [{ type: "text", text: providerText }];
		for (const image of images) {
			if (!options.imageInput && image.description) {
				content.push({ type: "text", text: `[图片：${image.description}]` });
				continue;
			}
			try {
				const data = readFileSync(join(options.mediaDir, image.name)).toString("base64");
				content.push({ type: "image", data, mimeType: image.mime });
			} catch {
				// A pruned or missing image should not make text conversation fail.
			}
		}
		projected.push({ ...message, content });
	});
	return projected;
}

export function makeContextExtension(
	mediaDir: string,
	personaId: string,
	getFormalSoul: () => string,
	identity: PromptIdentity,
	transport: Pick<PlatformTransport, "platform" | "displayName">,
	modelRuntime: ModelRuntime,
	getSession: () => AgentSession,
): InlineExtension {
	return {
		name: "jingmei-context",
		hidden: true,
		factory: (pi) => {
			pi.on("context", (event, ctx) => ({
				messages: projectContext(event.messages, {
					mediaDir,
					personaId,
					formalSoul: getFormalSoul(),
					imageInput: ctx.model?.input.includes("image") ?? false,
				}),
			}));
			pi.on("session_before_compact", async (event, ctx) => {
				const instructions = [
					event.customInstructions,
					"群聊摘要规则：",
					identityFacts(transport, identity),
					"只记录已确认的事实；成员的说法必须归因到该成员，不要自动当作事实。助手自己的推测、猜测、过往拒绝或语气不得写成约束或偏好。只有成员明确要求的风格教训才可保留。修正旧摘要中与固定身份冲突或把助手猜测写成规则的内容。",
				]
					.filter(Boolean)
					.join("\n\n");
				// Pi 0.84.1 accepts instructions only on input, not in the hook result.
				// Return Pi's native result so both manual and automatic compaction use these rules.
				try {
					if (event.signal.aborted || !ctx.model) return { cancel: true };
					const auth = await modelRuntime.getAuth(ctx.model);
					const model = auth?.auth.baseUrl ? { ...ctx.model, baseUrl: auth.auth.baseUrl } : ctx.model;
					const headers = auth?.auth.headers
						? Object.fromEntries(
								Object.entries(auth.auth.headers).filter((entry): entry is [string, string] => entry[1] != null),
							)
						: undefined;
					const session = getSession();
					return {
						compaction: await compact(
							event.preparation,
							model,
							auth?.auth.apiKey,
							headers,
							instructions,
							event.signal,
							ctx.thinkingLevel,
							session.agent.streamFunction,
							auth?.env,
							session.settingsManager.getRetrySettings(),
						),
					};
				} catch (error) {
					// The extension runner otherwise swallows errors and retries without our rules.
					if (!event.signal.aborted) {
						log.error("core", "context_compaction_failed", {
							persona_id: personaId,
							error_category: errorCategory(error),
						});
					}
					return { cancel: true };
				}
			});
		},
	};
}

function isPromotedSoulNote(message: AgentMessage, personaId: string, formalSoul: string): boolean {
	if (!formalSoul || message.role !== "custom" || message.customType !== PENDING_SOUL_TYPE) return false;
	const details = message.details as { personaId?: unknown; note?: unknown } | undefined;
	if (details?.personaId !== personaId || typeof details.note !== "string") return false;
	return !!details.note && formalSoul.includes(details.note);
}
