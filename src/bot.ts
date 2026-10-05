// 精魅 (jingmei) startup orchestration: one Pi conversation core serving every configured platform.

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { ConfigError, ensureDeepSeekModelsFile, loadConfig, piAgentDir } from "./config.ts";
import { BotState, HEARTBEAT_MS } from "./core/bot-state.ts";
import { CelebrationScheduler } from "./core/celebrations.ts";
import { Conversation } from "./core/conversation.ts";
import { openDatabase } from "./core/db.ts";
import { createFastEmbedder } from "./core/embedding.ts";
import { createPiEventSummarizer, EventTracker } from "./core/events.ts";
import { MemberMemory } from "./core/memory.ts";
import {
	assertBotModelConfigured,
	createInstalledPiModelRuntime,
	PiModelConfigurationError,
} from "./core/model-runtime.ts";
import { SoulStore } from "./core/soul.ts";
import type { Persona, Platform, PlatformTransport } from "./core/types.ts";
import { createJevClient, withFallback } from "./decision/jev.ts";
import { createLocalJevClient } from "./decision/local-jev.ts";
import { inspectVideoTranscoder } from "./media/video-frames.ts";
import { errorCategory, log } from "./observability/log.ts";
import { createDiscordPlatform } from "./platforms/discord/index.ts";
import { createTelegramPlatform } from "./platforms/telegram/index.ts";
import { ANTIGRAVITY_PROVIDER_ID, AntigravityImageError, generateAntigravityImage } from "./tools/antigravity-image.ts";
import type { ImageGenerator } from "./core/tools.ts";

async function main(): Promise<void> {
	const config = loadConfig();
	const agentDir = piAgentDir(config.dataDir);
	mkdirSync(agentDir, { recursive: true, mode: 0o700 });
	ensureDeepSeekModelsFile(agentDir);
	// Pi resolves the key reference in the project-local models.json at request time.
	if (config.webSearchApiKey) process.env.DEEPSEEK_API_KEY = config.webSearchApiKey;
	const personas: Persona[] = config.personas.map(({ tokens: _tokens, ...persona }) => ({ ...persona, accounts: {} }));
	const db = openDatabase(config.dataDir);
	const memberMemory = new MemberMemory(db);
	const botState = new BotState(db);
	let core: Conversation | undefined;
	const deps = {
		config,
		personas,
		memberMemory,
		getCore: () => {
			if (!core) throw new Error("conversation core is not ready");
			return core;
		},
	};
	// Each factory verifies its tokens and fills `persona.accounts[platform]` before returning.
	const platforms = [
		...(config.discord ? [await createDiscordPlatform(deps)] : []),
		...(config.telegram ? [await createTelegramPlatform(deps)] : []),
	];
	if (!platforms.length) throw new Error("no platform configured");
	const transports = new Map<Platform, PlatformTransport>(
		platforms.map((platform) => [platform.transport.platform, platform.transport]),
	);

	const modelRuntime = await createInstalledPiModelRuntime({ cwd: config.rootDir, agentDir });
	for (const persona of personas)
		assertBotModelConfigured(
			{ provider: persona.provider, model: persona.model, thinkingLevel: persona.reasoningEffort, purpose: persona.id },
			modelRuntime,
		);
	if (config.visionModel)
		assertBotModelConfigured({ ...config.visionModel, requireImageInput: true, purpose: "vision" }, modelRuntime);
	if (config.events) assertBotModelConfigured({ ...config.events.summaryModel, purpose: "events" }, modelRuntime);

	const jev = config.jev;
	const remoteDecision = jev?.apiKey
		? createJevClient({ endpoint: jev.endpoint, apiKey: jev.apiKey, model: jev.model })
		: undefined;
	const localDecision = config.localJev ? createLocalJevClient(config.localJev) : undefined;
	const decision =
		remoteDecision && localDecision ? withFallback(remoteDecision, localDecision) : (remoteDecision ?? localDecision);
	let events: EventTracker | undefined;
	if (config.events) {
		if (!decision) throw new Error("events requires a decision client");
		const embedder = await createFastEmbedder({
			model: config.events.embeddingModel,
			cacheDir: join(config.dataDir, "models"),
		});
		events = new EventTracker({
			db,
			decision,
			embedder,
			summarize: createPiEventSummarizer(modelRuntime, config.events.summaryModel),
		});
	}
	// Reuses the pi-provider-antigravity login; Pi refreshes the token under its auth.json lock.
	const imageGenerator: ImageGenerator | undefined = modelRuntime.hasConfiguredAuth(ANTIGRAVITY_PROVIDER_ID)
		? async (prompt, aspectRatio) => {
				const auth = await modelRuntime
					.getAuth(ANTIGRAVITY_PROVIDER_ID, { signal: AbortSignal.timeout(30_000) })
					.catch(() => undefined);
				if (!auth?.auth.apiKey) throw new AntigravityImageError("invalid_credential");
				return generateAntigravityImage(auth.auth.apiKey, prompt, { model: config.imageModel, aspectRatio });
			}
		: undefined;
	core = new Conversation({
		db,
		botState,
		dataDir: config.dataDir,
		routingSecret: config.routingSecret,
		personas,
		transports,
		modelRuntime,
		memberMemory,
		soulStore: new SoulStore({ db, personaIds: personas.map((persona) => persona.id) }),
		...(events ? { events } : {}),
		...(config.webSearchApiKey ? { webSearchApiKey: config.webSearchApiKey } : {}),
		...(config.voice ? { voice: config.voice } : {}),
		...(imageGenerator ? { imageGenerator } : {}),
		...(config.visionModel ? { visionModel: config.visionModel } : {}),
		...(decision
			? {
					jev: {
						client: decision,
						quickReactions: jev?.quickReactions ?? false,
						memoryScoring: jev?.memoryScoring ?? false,
						replyDecision: jev?.replyDecision ?? true,
						replyThreshold: jev?.replyThreshold ?? 0.7,
						threshold: jev?.threshold ?? 0.8,
						minIntervalMs: jev?.minIntervalMs ?? 60_000,
						...(jev?.emojis ? { emojis: jev.emojis } : {}),
					},
				}
			: {}),
	});
	const scheduler = new CelebrationScheduler({
		db,
		targets: config.celebrations,
		transports,
		listBirthdays: (spaceId, month, day) => memberMemory.listBirthdays(spaceId, month, day),
		isPaused: () => botState.pausedAt() !== null,
		onError: (error) => log.error("core", "celebration_failed", { error_category: errorCategory(error) }),
	});

	let shuttingDown = false;
	let heartbeat: Timer | undefined;
	const shutdown = async (signal: string) => {
		if (shuttingDown) return;
		shuttingDown = true;
		log.info("core", "shutdown", { signal });
		await scheduler.stop();
		await Promise.allSettled(platforms.map((platform) => platform.stop()));
		await core?.close();
		await events?.idle();
		clearInterval(heartbeat);
		botState.stopRun();
		db.close();
	};
	process.once("SIGINT", () => void shutdown("SIGINT").then(() => process.exit(0)));
	process.once("SIGTERM", () => void shutdown("SIGTERM").then(() => process.exit(0)));

	for (const platform of platforms) await platform.start();
	// Recovered turns run in their channel lanes; startup (heartbeat, run record) must not wait for model calls.
	void core
		?.recoverPending()
		.catch((error: unknown) => log.error("core", "inbound_recovery_failed", { error_category: errorCategory(error) }));
	scheduler.start();
	botState.startRun();
	heartbeat = setInterval(() => botState.heartbeat(), HEARTBEAT_MS);
	const transcoder = inspectVideoTranscoder();
	if (!transcoder.ffmpeg || !transcoder.ffprobe)
		log.warn("core", "video_frames_unavailable", { ffmpeg: transcoder.ffmpeg, ffprobe: transcoder.ffprobe });
	log.info("core", "ready", {
		platforms: [...transports.keys()].join(","),
		persona_count: personas.length,
		search_enabled: !!config.webSearchApiKey,
		voice_enabled: !!config.voice,
		image_generation_enabled: !!imageGenerator,
		vision_enabled: !!config.visionModel,
		jev_quick_reactions: !!jev?.quickReactions,
		jev_memory_scoring: !!jev?.memoryScoring,
		jev_reply_decision: (jev?.replyDecision ?? true) && !!decision,
		events_enabled: !!events,
		events_local_fallback: !!events && !!remoteDecision && !!localDecision,
		celebration_targets: config.celebrations.length,
		paused: botState.pausedAt() !== null,
	});
}

/** Start every configured platform; a startup failure is logged and sets a nonzero exit code. */
export async function startBot(): Promise<void> {
	try {
		await main();
	} catch (error) {
		// `detail` goes through the logger's token/key/URL/path redaction; operators need the reason.
		log.error("core", "startup_failed", {
			error_category: errorCategory(error),
			detail: error instanceof Error ? error.message : undefined,
		});
		// Both messages are built from config/model names only, never secret values.
		if (error instanceof ConfigError || error instanceof PiModelConfigurationError) console.error(error.message);
		process.exitCode = 1;
	}
}
