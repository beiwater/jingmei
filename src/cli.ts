#!/usr/bin/env bun
// 精魅 (jingmei) operator CLI: an interactive menu, plus subcommands to run the bot, sign in to providers,
// switch persona models, pause/resume and summarize a running bot.

import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import * as p from "@clack/prompts";
import type { AuthEvent, AuthPrompt } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { defineCommand, runMain } from "citty";
import { loadOperatorConfig, type OperatorConfig, piAgentDir } from "./config.ts";
import { BotState, type BotSummary } from "./core/bot-state.ts";
import { openDatabase } from "./core/db.ts";
import { createInstalledPiModelRuntime } from "./core/model-runtime.ts";

/** Bound for network model-catalog refreshes, so a slow provider cannot hang the CLI. */
const CATALOG_REFRESH_MS = 30_000;

/** Cancelling a prompt fails the current action; the menu then returns to its list instead of exiting. */
function answered(value: string | symbol, signal?: AbortSignal): string {
	if (typeof value !== "symbol") return value;
	// The flow aborted this prompt because another path won (e.g. the browser callback beat a manual paste).
	throw new Error(signal?.aborted ? "Login cancelled" : "Cancelled");
}

async function ask(prompt: AuthPrompt): Promise<string> {
	const common = { message: prompt.message, signal: prompt.signal };
	switch (prompt.type) {
		case "select":
			return answered(
				await p.select({
					...common,
					options: prompt.options.map((option) => ({
						value: option.id,
						label: option.label,
						hint: option.description,
					})),
				}),
				prompt.signal,
			);
		case "secret":
			return answered(await p.password(common), prompt.signal);
		default:
			return answered(await p.text({ ...common, placeholder: prompt.placeholder }), prompt.signal);
	}
}

// URLs go to stdout unframed: clack wraps long lines behind its guide bar, which breaks copy and terminal link detection.
function show(event: AuthEvent): void {
	switch (event.type) {
		case "auth_url":
			p.log.step(event.instructions ? `Open in a browser. ${event.instructions}` : "Open in a browser:");
			process.stdout.write(`${event.url}\n`);
			break;
		case "device_code":
			p.log.step(`Open in a browser and enter code ${event.userCode}:`);
			process.stdout.write(`${event.verificationUri}\n`);
			break;
		case "info":
			p.log.info(event.message);
			for (const link of event.links ?? []) process.stdout.write(`${link.label ? `${link.label}: ` : ""}${link.url}\n`);
			break;
		case "progress":
			p.log.step(event.message);
			break;
	}
}

/** One subcommand run. The process exits afterwards: provider extensions may keep timers or sockets open. */
async function operation(title: string, run: () => Promise<string> | string): Promise<never> {
	p.intro(title);
	try {
		p.outro(await run());
	} catch (error) {
		p.cancel(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
	process.exit();
}

let operatorConfig: OperatorConfig | undefined;
let runtimePromise: Promise<ModelRuntime> | undefined;
let botState: BotState | undefined;

function loadOperator(): OperatorConfig {
	operatorConfig ??= loadOperatorConfig();
	return operatorConfig;
}

/** The same Pi model runtime the bot uses, so credentials land in `<dataDir>/pi-agent/auth.json`. */
function openRuntime(): Promise<ModelRuntime> {
	runtimePromise ??= (async () => {
		const agentDir = piAgentDir(loadOperator().dataDir);
		mkdirSync(agentDir, { recursive: true, mode: 0o700 });
		return createInstalledPiModelRuntime({ agentDir });
	})();
	return runtimePromise;
}

/** The bot reads pause and model choices per message, so changes apply to a running bot without restart. */
function openBotState(): BotState {
	botState ??= new BotState(openDatabase(loadOperator().dataDir));
	return botState;
}

function formatDuration(ms: number): string {
	const minutes = Math.floor(ms / 60_000);
	const days = Math.floor(minutes / 1440);
	const hours = Math.floor((minutes % 1440) / 60);
	return `${days ? `${days}d ` : ""}${days || hours ? `${hours}h ` : ""}${minutes % 60}m`;
}

function formatTime(ms: number): string {
	return new Date(ms).toLocaleString();
}

function statsLines(s: BotSummary, now: number): string[] {
	const rows: Array<[string, string]> = [
		[
			"Status",
			s.current
				? `running ${formatDuration(now - s.current.startedAt)} (since ${formatTime(s.current.startedAt)})`
				: s.lastSeenAt !== null
					? `stopped (last seen ${formatTime(s.lastSeenAt)})`
					: "never started",
		],
		...(s.pausedAt !== null ? [["Paused", `since ${formatTime(s.pausedAt)}, not replying`] as [string, string]] : []),
		[
			"Runtime",
			s.firstStartedAt !== null
				? `${formatDuration(s.runtimeMs)} over ${s.runs} ${s.runs === 1 ? "run" : "runs"} since ${formatTime(s.firstStartedAt)}`
				: "-",
		],
		[
			"Replies",
			`${s.current ? `${s.current.replies.toLocaleString()} this run, ` : ""}${s.replies.toLocaleString()} total`,
		],
		[
			"Messages",
			`${s.messages.toLocaleString()} total, ${s.messagesLast24h.toLocaleString()} in last 24h, ${s.groups} ${s.groups === 1 ? "group" : "groups"}`,
		],
		["Members", s.members.toLocaleString()],
		["Topics", s.topics.toLocaleString()],
		["Celebrations", `${s.celebrations.toLocaleString()} sent`],
	];
	return rows.map(([label, value]) => `${label.padEnd(13)}${value}`);
}

function pauseBot(): string {
	const state = openBotState();
	if (state.pause()) return "Paused. The bot stays online but stays silent until resumed.";
	return `Already paused since ${formatTime(state.pausedAt() ?? Date.now())}`;
}

function resumeBot(): string {
	return openBotState().resume() ? "Resumed" : "Not paused";
}

function showStats(): string {
	const now = Date.now();
	const summary = openBotState().summary(now);
	p.note(statsLines(summary, now).join("\n"), "Bot");
	return summary.pausedAt !== null ? "Paused: resume with `bun run jingmei resume`" : "Done";
}

/** First-run wizard: writes jingmei.config.json, .env and a persona file; it never overwrites. */
async function createInstall(): Promise<string> {
	if (!process.stdin.isTTY || !process.stdout.isTTY)
		throw new Error(
			"init is interactive and needs a terminal; otherwise copy jingmei.config.example.json and .env.example",
		);
	const { clackUi, defaultInitDeps, runInit } = await import("./init.ts");
	return runInit(process.cwd(), clackUi, defaultInitDeps(process.cwd()));
}

/** Print the self-check table; any failed check makes the command (and the process exit code) fail. */
async function checkInstall(): Promise<string> {
	const { defaultProbes, failureCount, formatReport, runDoctor } = await import("./doctor.ts");
	const results = await runDoctor(defaultProbes(process.cwd()));
	process.stdout.write(`${formatReport(results)}\n`);
	const failed = failureCount(results);
	if (failed) throw new Error(`${failed} ${failed === 1 ? "check" : "checks"} failed`);
	return "All required checks passed";
}

async function signIn(provider?: string): Promise<string> {
	const runtime = await openRuntime();
	const providers = runtime
		.getProviders()
		.flatMap((candidate) => (candidate.auth.oauth ? [{ id: candidate.id, name: candidate.auth.oauth.name }] : []));
	const signedIn = new Set(
		(await runtime.listCredentials()).filter((c) => c.type === "oauth").map((c) => c.providerId),
	);
	const providerId =
		provider ??
		answered(
			await p.select({
				message: "Provider",
				options: providers.map(({ id, name }) => ({
					value: id,
					label: name,
					hint: signedIn.has(id) ? "signed in" : id,
				})),
			}),
		);
	if (!providers.some(({ id }) => id === providerId))
		throw new Error(`No OAuth provider "${providerId}"; available: ${providers.map(({ id }) => id).join(", ")}`);
	await runtime.login(providerId, "oauth", { prompt: ask, notify: show });
	// Live-catalog providers (e.g. antigravity) list models only after a network refresh, which also caches them for the bot.
	const refresh = await runtime.refresh({ providers: [providerId], signal: AbortSignal.timeout(CATALOG_REFRESH_MS) });
	const models = runtime.getModels(providerId).length;
	return refresh.errors.size || refresh.aborted
		? `Signed in to ${providerId}; its model list could not be refreshed (try "Switch model" again later)`
		: `Signed in to ${providerId}; ${models} ${models === 1 ? "model" : "models"} available`;
}

async function signOut(provider?: string): Promise<string> {
	const runtime = await openRuntime();
	const stored = await runtime.listCredentials();
	if (!stored.length) return "No stored credentials";
	const providerId =
		provider ??
		answered(
			await p.select({
				message: "Provider",
				options: stored.map(({ providerId, type }) => ({ value: providerId, label: providerId, hint: type })),
			}),
		);
	if (!stored.some((c) => c.providerId === providerId)) throw new Error(`No stored credential for "${providerId}"`);
	await runtime.logout(providerId);
	return `Signed out of ${providerId}`;
}

/** Store a persona's model override; `default` (or the configured model) clears it. */
async function switchModel(ref?: string, personaId?: string): Promise<string> {
	const { personas } = loadOperator();
	if (!personas.length) throw new Error("No personas with provider/model in jingmei.config.json");
	const id =
		personaId ??
		(personas.length === 1
			? personas[0]!.id
			: answered(
					await p.select({
						message: "Persona",
						options: personas.map((persona) => ({ value: persona.id, label: persona.id })),
					}),
				));
	const persona = personas.find((candidate) => candidate.id === id);
	if (!persona)
		throw new Error(`No persona "${id}"; available: ${personas.map((candidate) => candidate.id).join(", ")}`);
	const state = openBotState();
	const runtime = await openRuntime();
	const configured = `${persona.provider}/${persona.model}`;
	const override = state.modelOverride(persona.id);
	const current = override ? `${override.provider}/${override.model}` : configured;
	let choice = ref;
	if (!choice) {
		const spinner = p.spinner();
		spinner.start("Refreshing model lists");
		const refresh = await runtime.refresh({ signal: AbortSignal.timeout(CATALOG_REFRESH_MS) });
		spinner.stop(
			refresh.errors.size || refresh.aborted
				? `Some model lists could not be refreshed: ${[...refresh.errors.keys()].join(", ") || "timed out"}`
				: "Model lists refreshed",
		);
		const available = (await runtime.getAvailable()).map((model) => `${model.provider}/${model.id}`).sort();
		choice = answered(
			await p.select({
				message: `Model for ${persona.id} (now ${current})`,
				initialValue: override ? current : "default",
				maxItems: 15,
				options: [
					{ value: "default", label: "Configured default", hint: configured },
					...available.map((model) => ({ value: model, label: model })),
				],
			}),
		);
	}
	if (choice === "default" || choice === configured) {
		state.clearModelOverride(persona.id);
		return `${persona.id} uses its configured model ${configured}; the running bot switches before each channel's next reply`;
	}
	const slash = choice.indexOf("/");
	const model = slash > 0 ? runtime.getModel(choice.slice(0, slash), choice.slice(slash + 1)) : undefined;
	if (!model) throw new Error(`Unknown model "${choice}"; run \`bun run jingmei model\` to pick from the list`);
	if (!(await runtime.checkAuth(model.provider)))
		throw new Error(`No credentials for ${model.provider}; run \`bun run jingmei login ${model.provider}\``);
	state.setModelOverride(persona.id, model.provider, model.id);
	return `${persona.id} now uses ${choice}; the running bot switches before each channel's next reply`;
}

const MENU_ACTIONS: Record<string, () => Promise<string> | string> = {
	init: createInstall,
	stats: showStats,
	doctor: checkInstall,
	model: () => switchModel(),
	pause: pauseBot,
	resume: resumeBot,
	login: () => signIn(),
	logout: () => signOut(),
};

/** `bun run jingmei` with no subcommand: pick actions until Exit, returning here after each one. */
async function menu(): Promise<never> {
	p.intro("jingmei");
	for (;;) {
		// Before `init` there is no config, so only init (and exit) can work.
		const installed = existsSync(join(process.cwd(), "jingmei.config.json"));
		const paused = installed && openBotState().pausedAt() !== null;
		const choice = await p.select({
			message: "What next?",
			options: installed
				? [
						{ value: "stats", label: "Status", hint: "uptime and totals" },
						{ value: "doctor", label: "Check install", hint: "config, tokens, models, dependencies" },
						{ value: "model", label: "Switch model" },
						paused ? { value: "resume", label: "Resume replies" } : { value: "pause", label: "Pause replies" },
						{ value: "login", label: "Sign in to a provider" },
						{ value: "logout", label: "Sign out of a provider" },
						{ value: "exit", label: "Exit" },
					]
				: [
						{ value: "init", label: "Set up", hint: "create config, .env and a persona" },
						{ value: "exit", label: "Exit" },
					],
		});
		const action = p.isCancel(choice) ? undefined : MENU_ACTIONS[choice];
		if (!action) break;
		try {
			p.log.success(await action());
		} catch (error) {
			p.log.error(error instanceof Error ? error.message : String(error));
		}
	}
	p.outro("Bye");
	process.exit();
}

const start = defineCommand({
	meta: { name: "start", description: "Run the bot in the foreground (same as bun run start)" },
	// The bot pulls in the embedding model, vector store and decision wrapper; operator commands must not.
	run: async () => (await import("./bot.ts")).startBot(),
});

const pause = defineCommand({
	meta: { name: "pause", description: "Stop replying, reacting and sending greetings; messages are still stored" },
	run: () => operation("jingmei pause", pauseBot),
});

const resume = defineCommand({
	meta: { name: "resume", description: "Resume replying after a pause" },
	run: () => operation("jingmei resume", resumeBot),
});

const stats = defineCommand({
	meta: { name: "stats", description: "Show uptime, total runtime and data totals" },
	run: () => operation("jingmei stats", showStats),
});

const init = defineCommand({
	meta: { name: "init", description: "Create jingmei.config.json, .env and a persona file with a guided wizard" },
	run: () => operation("jingmei init", createInstall),
});

const doctor = defineCommand({
	meta: { name: "doctor", description: "Check config, bot tokens, models and optional dependencies (read-only)" },
	run: () => operation("jingmei doctor", checkInstall),
});

const model = defineCommand({
	meta: { name: "model", description: "Show or switch a persona's chat model (picker when no model is given)" },
	args: {
		model: { type: "positional", required: false, description: "provider/model, or default for the configured model" },
		persona: { type: "string", required: false, description: "Persona id; needed only with several personas" },
	},
	run: ({ args }) => operation("jingmei model", () => switchModel(args.model, args.persona)),
});

const login = defineCommand({
	meta: {
		name: "login",
		description: "Sign in to a provider with OAuth (Claude Pro/Max, ChatGPT Plus/Pro, Copilot, ...)",
	},
	args: {
		provider: { type: "positional", required: false, description: "Provider id, e.g. anthropic or openai-codex" },
	},
	run: ({ args }) => operation("jingmei login", () => signIn(args.provider)),
});

const logout = defineCommand({
	meta: { name: "logout", description: "Remove a provider's stored credential" },
	args: { provider: { type: "positional", required: false, description: "Provider id" } },
	run: ({ args }) => operation("jingmei logout", () => signOut(args.provider)),
});

await runMain(
	defineCommand({
		meta: { name: "jingmei", description: "精魅 operator commands; run without a command for the interactive menu" },
		subCommands: { start, init, doctor, login, logout, model, pause, resume, stats },
		// citty also calls this after a subcommand (only `start` returns), so act only on a bare invocation.
		run: ({ rawArgs }) => (rawArgs.length ? undefined : menu()),
	}),
);
