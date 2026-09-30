/**
 * Convert an existing `discord.config.json` into `jingmei.config.json`.
 * Usage: bun scripts/migrate-config.ts [rootDir]. Refuses to overwrite; config holds no secrets.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

type Json = Record<string, unknown>;

/** Map the old Discord-only shape onto the unified jingmei shape; unknown fields are dropped. */
export function migrateDiscordConfig(old: Json): Json & {
	discord: { guilds: unknown[] };
	personas: Json[];
	celebrations?: Json[];
} {
	const guilds = Array.isArray(old.guilds) ? old.guilds : [];
	const personas = (Array.isArray(old.personas) ? old.personas : []).map((entry: Json) => {
		const {
			token_env: tokenEnv,
			guildIds,
			adminUserIds,
			id,
			name,
			personaPath,
			provider,
			model,
			reasoningEffort,
			routingP,
			aliases,
			sendReactionImages,
			voiceEnabled,
		} = entry;
		return {
			id,
			name,
			personaPath,
			provider,
			model,
			...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
			routingP,
			...(aliases !== undefined ? { aliases } : {}),
			...(Array.isArray(guildIds) ? { spaces: guildIds.map((guildId) => `discord:${guildId}`) } : {}),
			...(sendReactionImages !== undefined ? { sendReactionImages } : {}),
			...(voiceEnabled !== undefined ? { voiceEnabled } : {}),
			discord: { tokenEnv, ...(adminUserIds !== undefined ? { adminUserIds } : {}) },
		};
	});
	const celebrations = (Array.isArray(old.celebrations) ? old.celebrations : []).map(
		({ guildId, channelId, personaId, timeZone, calendar }: Json) => ({
			space: `discord:${guildId}`,
			channelId,
			personaId,
			timeZone,
			calendar,
		}),
	);
	return {
		...(old.dataDir !== undefined ? { dataDir: old.dataDir } : {}),
		...(old.routingSecretEnv !== undefined ? { routingSecretEnv: old.routingSecretEnv } : {}),
		discord: { guilds },
		...(old.voice !== undefined ? { voice: old.voice } : {}),
		...(celebrations.length > 0 ? { celebrations } : {}),
		personas,
	};
}

if (import.meta.main) {
	const rootDir = resolve(process.argv[2] ?? process.cwd());
	const source = join(rootDir, "discord.config.json");
	const target = join(rootDir, "jingmei.config.json");
	if (!existsSync(source)) {
		console.error(`No ${source} to migrate.`);
		process.exit(1);
	}
	if (existsSync(target)) {
		console.error(`${target} already exists; refusing to overwrite.`);
		process.exit(1);
	}
	const migrated = migrateDiscordConfig(JSON.parse(readFileSync(source, "utf8")));
	writeFileSync(target, `${JSON.stringify(migrated, null, "\t")}\n`, { flag: "wx" });
	const guildCount = migrated.discord.guilds.length;
	const personaCount = migrated.personas.length;
	const celebrationCount = migrated.celebrations?.length ?? 0;
	console.log(
		`Wrote ${target}: ${guildCount} guild(s), ${personaCount} persona(s), ${celebrationCount} celebration target(s).`,
	);
	console.log(
		"Next: persona ids must match [a-z0-9_-]; add a telegram section / persona telegram accounts and a jev section as needed.",
	);
}
