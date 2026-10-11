/**
 * Index messages stored before the per-message index existed (keyword table + vectors), newest first.
 * Usage: nice -n 10 bun scripts/backfill-message-index.ts [delayMs]
 * One message at a time with a pause in between: the host is a single core shared with the running bot,
 * and batched embedding balloons memory. Safe to stop and rerun; indexed rows are skipped.
 */
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { openDatabase } from "../src/core/db.ts";
import { createFastEmbedder } from "../src/core/embedding.ts";
import { DEFAULT_EMBEDDING_MODEL } from "../src/core/embedding-models.ts";
import { MessageIndex } from "../src/core/message-index.ts";
import type { SpaceId } from "../src/core/types.ts";

const delayMs = Number(process.argv[2] ?? 100);
if (!Number.isFinite(delayMs) || delayMs < 0) throw new Error("delayMs must be a non-negative number");
const config = loadConfig();
if (!config.features.history) throw new Error("features.history is off; there is no message index to backfill");
const db = openDatabase(config.dataDir);
const embedder = await createFastEmbedder({
	model: config.events?.embeddingModel ?? DEFAULT_EMBEDDING_MODEL,
	cacheDir: join(config.dataDir, "models"),
});
const index = new MessageIndex({ db, embedder });
const keys = db
	.query(
		"SELECT space_id AS spaceId, channel_id AS channelId, message_id AS messageId FROM messages ORDER BY timestamp DESC",
	)
	.all() as Array<{ spaceId: SpaceId; channelId: string; messageId: string }>;
const started = Date.now();
for (const [done, key] of keys.entries()) {
	await index.ensure([key]);
	if (done % 500 === 0) console.log(`${done}/${keys.length} (${Math.round((Date.now() - started) / 1000)}s)`);
	await Bun.sleep(delayMs);
}
console.log(`done: ${keys.length} messages in ${Math.round((Date.now() - started) / 1000)}s`);
