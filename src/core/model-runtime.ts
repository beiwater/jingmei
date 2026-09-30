import {
	createAgentSessionServices,
	getAgentDir,
	type ModelRuntime,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
	clampThinkingLevel,
	getSupportedThinkingLevels,
	type Api,
	type Model,
	type ModelThinkingLevel,
} from "@earendil-works/pi-ai";

/** The subset of Pi's ModelRuntime the startup assertion reads. */
type ConfigurableModelRuntime = Pick<ModelRuntime, "getModel" | "hasConfiguredAuth">;

export type PiModelConfigurationCategory =
	| "unknown_model"
	| "unauthenticated_provider"
	| "unsupported_reasoning_effort"
	| "image_input_unsupported";

export interface PiModelSelection {
	provider: string;
	model: string;
	thinkingLevel?: ModelThinkingLevel;
	/** Auxiliary vision models must accept image input. */
	requireImageInput?: boolean;
	purpose?: string;
}

interface ModelReasoningCapabilities {
	provider: string;
	model: string;
	requested: ModelThinkingLevel;
	effective: ModelThinkingLevel;
	supported: ModelThinkingLevel[];
	valid: boolean;
}

export class PiModelConfigurationError extends Error {
	constructor(
		readonly category: PiModelConfigurationCategory,
		readonly provider: string,
		readonly model: string,
		readonly reasoning?: ModelReasoningCapabilities,
		readonly purpose?: string,
	) {
		const target = `${provider}/${model}${purpose ? ` (${purpose})` : ""}`;
		super(
			reasoning
				? `Pi model configuration invalid (${category}): ${target} requested ${reasoning.requested}; supported: ${reasoning.supported.join(", ")}. Use Pi /model, then restart.`
				: `Pi model unavailable (${category}): ${target}. Use Pi /login and /model, then restart.`,
		);
		this.name = "PiModelConfigurationError";
	}
}

/** Read Pi's model-specific reasoning contract without sending a provider request. */
function inspectModelReasoning(model: Model<Api>, requested: ModelThinkingLevel): ModelReasoningCapabilities {
	const supported = getSupportedThinkingLevels(model);
	const effective = clampThinkingLevel(model, requested);
	return {
		provider: model.provider,
		model: model.id,
		requested,
		effective,
		supported,
		valid: supported.includes(requested),
	};
}

/** Validate a Pi-owned model/auth pair without reading or injecting credential material. */
export function assertBotModelConfigured(bot: PiModelSelection, runtime: ConfigurableModelRuntime): void {
	const model = runtime.getModel(bot.provider, bot.model);
	if (!model) {
		throw new PiModelConfigurationError("unknown_model", bot.provider, bot.model, undefined, bot.purpose);
	}
	if (bot.thinkingLevel != null) {
		const reasoning = inspectModelReasoning(model, bot.thinkingLevel);
		if (!reasoning.valid) {
			throw new PiModelConfigurationError(
				"unsupported_reasoning_effort",
				bot.provider,
				bot.model,
				reasoning,
				bot.purpose,
			);
		}
	}
	if (bot.requireImageInput && !model.input.includes("image")) {
		throw new PiModelConfigurationError("image_input_unsupported", bot.provider, bot.model, undefined, bot.purpose);
	}
	if (!runtime.hasConfiguredAuth(bot.provider)) {
		throw new PiModelConfigurationError("unauthenticated_provider", bot.provider, bot.model, undefined, bot.purpose);
	}
}

/**
 * Build the shared model runtime through Pi's resource loader so user-installed provider
 * extensions participate in the same catalog/auth/cost contract as interactive Pi.
 * Project extensions stay excluded: persona sessions own a fixed cache-visible extension set.
 */
export async function createInstalledPiModelRuntime(
	options: { cwd?: string; agentDir?: string } = {},
): Promise<ModelRuntime> {
	const cwd = options.cwd ?? process.cwd();
	const agentDir = options.agentDir ?? getAgentDir();
	const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
	const services = await createAgentSessionServices({
		cwd,
		agentDir,
		settingsManager,
		resourceLoaderOptions: {
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
		},
	});
	return services.modelRuntime;
}
