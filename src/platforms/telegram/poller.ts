// Long-polling loop for one bot token. The offset lives in memory: after a restart Telegram
// redelivers the unconfirmed tail, and the core's `INSERT OR IGNORE` on message ids dedupes it.
// Reconnects with backoff on network/API errors; honors retry_after.

import { setTimeout } from "node:timers/promises";
import { errorCategory, log } from "../../observability/log.ts";
import { type BotApi, TelegramApiError } from "./api.ts";

const POLL_TIMEOUT_SEC = 25;
const MAX_BACKOFF_MS = 60_000;

export class Poller {
	private offset = 0;
	private stopped = false;
	private readonly abort = new AbortController();

	constructor(
		private readonly api: BotApi,
		private readonly personaId: string,
		/** Must not block: long work is scheduled by the caller so polling continues. */
		private readonly onUpdate: (update: unknown) => void,
	) {}

	async stop(): Promise<void> {
		this.stopped = true;
		this.abort.abort();
		// Confirm everything already handed off so the next start does not replay it.
		if (this.offset > 0) await this.api.getUpdates(this.offset, 0).catch(() => undefined);
	}

	async run(): Promise<void> {
		let backoffMs = 1000;
		while (!this.stopped) {
			let updates: unknown[];
			try {
				updates = await this.api.getUpdates(this.offset, POLL_TIMEOUT_SEC, this.abort.signal);
				backoffMs = 1000;
			} catch (err) {
				// an abort rejection is the normal stop path, not an error
				if (this.stopped) break;
				if (err instanceof TelegramApiError && (err.code === 401 || err.code === 404)) {
					// token invalid/revoked: retrying never succeeds
					log.error("telegram_poller", "auth_failed", { persona_id: this.personaId, telegram_code: err.code });
					throw err;
				}
				if (err instanceof TelegramApiError && err.retryAfter) {
					await this.sleep(err.retryAfter * 1000);
					continue;
				}
				if (err instanceof TelegramApiError && err.code === 409) {
					// another process polls the same token (or a webhook is set)
					log.error("telegram_poller", "poll_conflict", { persona_id: this.personaId, retry_ms: 30_000 });
					await this.sleep(30_000);
					continue;
				}
				log.error("telegram_poller", "poll_failed", {
					persona_id: this.personaId,
					category: errorCategory(err),
					retry_ms: backoffMs,
				});
				await this.sleep(backoffMs);
				backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
				continue;
			}
			for (const update of updates) {
				if (this.stopped) break;
				if (!update || typeof update !== "object" || !("update_id" in update)) continue;
				const updateId = update.update_id;
				if (typeof updateId !== "number") continue;
				this.offset = Math.max(this.offset, updateId + 1);
				try {
					this.onUpdate(update);
				} catch (err) {
					log.error("telegram_poller", "update_failed", {
						persona_id: this.personaId,
						category: errorCategory(err),
					});
				}
			}
		}
	}

	/** Backoff that aborts early on stop() so shutdown never waits out a sleep. */
	private async sleep(ms: number): Promise<void> {
		try {
			await setTimeout(ms, undefined, { signal: this.abort.signal });
		} catch (error) {
			if (!(this.abort.signal.aborted && error instanceof Error && error.name === "AbortError")) throw error;
		}
	}
}
