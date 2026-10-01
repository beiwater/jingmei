import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";

/** Wire values predate the multi-platform core; they are persisted in existing session files. */
export const CONTEXT_MESSAGE_TYPE = "discord_context_v1";
export const PENDING_SOUL_TYPE = "discord_pending_soul_v1";

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
		)
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
 * - thinking blocks of completed turns (assistant messages before the last user/custom message)
 *   are dropped, keeping those of the in-progress tool loop;
 * - chat messages expand to text + image blocks; for text-only models an image with a vision
 *   description becomes `[图片：…]` text, otherwise the block is left for Pi to downgrade.
 */
function projectContext(messages: readonly AgentMessage[], options: ProjectionOptions): AgentMessage[] {
	let lastInput = -1;
	for (let index = messages.length - 1; index >= 0; index--) {
		const role = messages[index]!.role;
		if (role === "user" || role === "custom") {
			lastInput = index;
			break;
		}
	}
	const projected: AgentMessage[] = [];
	messages.forEach((message, index) => {
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
		const { providerText, images } = message.details;
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
		},
	};
}

function isPromotedSoulNote(message: AgentMessage, personaId: string, formalSoul: string): boolean {
	if (!formalSoul || message.role !== "custom" || message.customType !== PENDING_SOUL_TYPE) return false;
	const details = message.details as { personaId?: unknown; note?: unknown } | undefined;
	if (details?.personaId !== personaId || typeof details.note !== "string") return false;
	return !!details.note && formalSoul.includes(details.note);
}
