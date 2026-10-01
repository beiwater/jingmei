#!/usr/bin/env bun
// 精魅 (jingmei) operator CLI: run the bot, sign in to providers, pause/resume and summarize a running bot.

import { mkdirSync } from "node:fs";
import * as p from "@clack/prompts";
import type { AuthEvent, AuthPrompt } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { defineCommand, runMain } from "citty";
import { startBot } from "./bot.ts";
import { loadDataDir, piAgentDir } from "./config.ts";
import { BotState, type BotSummary } from "./core/bot-state.ts";
import { openDatabase } from "./core/db.ts";
import { createInstalledPiModelRuntime } from "./core/model-runtime.ts";

function answered(value: string | symbol, signal?: AbortSignal): string {
	if (typeof value !== "symbol") return value;
	// The flow aborted this prompt because another path won (e.g. the browser callback beat a manual paste).
	if (signal?.aborted) throw new Error("Login cancelled");
	p.cancel("Cancelled");
	process.exit(1);
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

async function operation(title: string, run: () => Promise<string> | string): Promise<void> {
	p.intro(title);
	try {
		p.outro(await run());
	} catch (error) {
		p.cancel(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}

/** Open the same Pi model runtime the bot uses, so credentials land in `<dataDir>/pi-agent/auth.json`. */
async function openRuntime(): Promise<ModelRuntime> {
	const agentDir = piAgentDir(loadDataDir());
	mkdirSync(agentDir, { recursive: true, mode: 0o700 });
	return createInstalledPiModelRuntime({ agentDir });
}

/** The bot reads the pause flag per message, so changes apply to a running bot without restart. */
function openBotState(): BotState {
	return new BotState(openDatabase(loadDataDir()));
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

const start = defineCommand({
	meta: { name: "start", description: "Run the bot in the foreground (same as bun run start)" },
	run: startBot,
});

const pause = defineCommand({
	meta: { name: "pause", description: "Stop replying, reacting and sending greetings; messages are still stored" },
	run: () =>
		operation("jingmei pause", () => {
			const state = openBotState();
			if (state.pause()) return "Paused. The bot stays online but stays silent until `bun run jingmei resume`.";
			return `Already paused since ${formatTime(state.pausedAt() ?? Date.now())}`;
		}),
});

const resume = defineCommand({
	meta: { name: "resume", description: "Resume replying after a pause" },
	run: () => operation("jingmei resume", () => (openBotState().resume() ? "Resumed" : "Not paused")),
});

const stats = defineCommand({
	meta: { name: "stats", description: "Show uptime, total runtime and data totals" },
	run: () =>
		operation("jingmei stats", () => {
			const now = Date.now();
			const summary = openBotState().summary(now);
			p.note(statsLines(summary, now).join("\n"), "Bot");
			return summary.pausedAt !== null ? "Paused: resume with `bun run jingmei resume`" : "Done";
		}),
});

const login = defineCommand({
	meta: {
		name: "login",
		description: "Sign in to a provider with OAuth (Claude Pro/Max, ChatGPT Plus/Pro, Copilot, ...)",
	},
	args: {
		provider: { type: "positional", required: false, description: "Provider id, e.g. anthropic or openai-codex" },
	},
	run: ({ args }) =>
		operation("jingmei login", async () => {
			const runtime = await openRuntime();
			const providers = runtime
				.getProviders()
				.flatMap((provider) => (provider.auth.oauth ? [{ id: provider.id, name: provider.auth.oauth.name }] : []));
			const signedIn = new Set(
				(await runtime.listCredentials()).filter((c) => c.type === "oauth").map((c) => c.providerId),
			);
			const providerId =
				args.provider ??
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
			return `Signed in to ${providerId}`;
		}),
});

const logout = defineCommand({
	meta: { name: "logout", description: "Remove a provider's stored credential" },
	args: { provider: { type: "positional", required: false, description: "Provider id" } },
	run: ({ args }) =>
		operation("jingmei logout", async () => {
			const runtime = await openRuntime();
			const stored = await runtime.listCredentials();
			if (!stored.length) return "No stored credentials";
			const providerId =
				args.provider ??
				answered(
					await p.select({
						message: "Provider",
						options: stored.map(({ providerId, type }) => ({ value: providerId, label: providerId, hint: type })),
					}),
				);
			if (!stored.some((c) => c.providerId === providerId)) throw new Error(`No stored credential for "${providerId}"`);
			await runtime.logout(providerId);
			return `Signed out of ${providerId}`;
		}),
});

await runMain(
	defineCommand({
		meta: { name: "jingmei", description: "精魅 operator commands" },
		subCommands: { start, login, logout, pause, resume, stats },
	}),
);
