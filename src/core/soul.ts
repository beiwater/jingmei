import type { Database } from "bun:sqlite";
import { isRawId, isSpaceId } from "./ids.ts";
import type { SpaceId } from "./types.ts";

const MAX_SOUL_BYTES = 4 * 1024;
const MAX_PENDING_BYTES = 1024;
const PENDING_SEPARATOR = "\n\n<!-- pending soul note -->\n\n";
const ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
const SECRET_OR_INJECTION_PATTERNS = [
	/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i,
	/\b(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|password|passwd|secret)\s*[:=]\s*\S+/i,
	/\b(?:sk-[a-z0-9_-]{16,}|gh[pousr]_[a-z0-9]{20,}|xox[baprs]-[a-z0-9-]{10,})\b/i,
	/ignore\s+(?:all\s+)?(?:previous|prior|above)\s+instructions/i,
	/system\s+prompt/i,
	/(?:reveal|dump|print|exfiltrate)\s+(?:the\s+)?(?:secrets?|credentials?|system\s+prompt)/i,
	/\b(?:curl|wget|bash|sh|powershell|chmod|rm\s+-rf)\b/i,
	/\b(?:member|user|colleague|teammate)\s+(?:birthday|phone|email|address|medical|health|salary|password|secret)\b/i,
	/\b(?:生日|手机号|电话号码|邮箱|住址|家庭住址|病史|病情|薪资|工资|密码|密钥|私事)\b/,
	/[\w.+-]+@[\w.-]+\.[a-z]{2,}/i,
	/(?:忽略|无视).{0,8}(?:之前|先前|上面).{0,8}(?:指令|规则)/,
	/(?:泄露|输出|打印).{0,8}(?:系统提示词|密钥|密码)/,
];

function validateNote(text: string, maxBytes: number): string {
	if (typeof text !== "string" || !text.trim()) throw new Error("Soul text must not be empty");
	const note = text.trim();
	if (Buffer.byteLength(note, "utf8") > maxBytes) throw new Error(`Soul text exceeds ${maxBytes} bytes`);
	if (note.includes(PENDING_SEPARATOR) || SECRET_OR_INJECTION_PATTERNS.some((pattern) => pattern.test(note))) {
		throw new Error("Soul text contains secret, private member data, or instruction injection");
	}
	return note;
}

export function parsePendingSoul(pending: string): string[] {
	return pending
		.split(PENDING_SEPARATOR)
		.map((note) => note.trim())
		.filter(Boolean);
}

export interface SoulScope {
	personaId: string;
	spaceId: SpaceId;
	channelId: string;
}

const SCHEMA = `
	CREATE TABLE IF NOT EXISTS session_souls (
		persona_id TEXT NOT NULL,
		space_id TEXT NOT NULL,
		channel_id TEXT NOT NULL,
		formal TEXT NOT NULL DEFAULT '' CHECK (length(CAST(formal AS BLOB)) <= 4096),
		pending TEXT NOT NULL DEFAULT '' CHECK (length(CAST(pending AS BLOB)) <= 1024),
		updated_at INTEGER NOT NULL,
		PRIMARY KEY (persona_id, space_id, channel_id)
	);
`;

/** Durable character notes owned by one persona in one channel conversation. */
export class SoulStore {
	private readonly db: Database;
	private readonly personas: Set<string>;

	constructor(options: { db: Database; personaIds: readonly string[] }) {
		for (const id of options.personaIds) {
			if (!ID_PATTERN.test(id)) throw new Error(`Invalid persona id: ${id}`);
		}
		this.personas = new Set(options.personaIds);
		this.db = options.db;
		this.db.exec(SCHEMA);
	}

	read(scope: SoulScope): string {
		return this.state(scope).formal;
	}

	readPending(scope: SoulScope): string {
		return this.state(scope).pending;
	}

	update(scope: SoulScope, text: string): { saved: true } {
		const note = validateNote(text, MAX_PENDING_BYTES);
		this.db
			.transaction(() => {
				const { formal, pending } = this.state(scope);
				const notes = parsePendingSoul(pending).map((value) => validateNote(value, MAX_PENDING_BYTES));
				if (notes.includes(note)) return;
				const next = `${[...notes, note].join(PENDING_SEPARATOR)}\n`;
				if (Buffer.byteLength(next, "utf8") > MAX_PENDING_BYTES)
					throw new Error(`Pending soul exceeds ${MAX_PENDING_BYTES} bytes`);
				this.save(scope, formal, next);
			})
			.immediate();
		return { saved: true };
	}

	/** Commit formal content and pending cleanup together; failures retain the staged notes. */
	promotePending(scope: SoulScope, expectedPending: string): { promoted: boolean } {
		return this.db
			.transaction(() => {
				const { formal, pending } = this.state(scope);
				if (!pending.trim() || pending !== expectedPending) return { promoted: false };
				const notes = parsePendingSoul(pending).map((note) => validateNote(note, MAX_PENDING_BYTES));
				const additions = notes.filter((note) => !formal.includes(note));
				const next = additions.length
					? `${formal.trimEnd()}${formal.trim() ? "\n\n" : ""}${additions.join("\n\n")}\n`
					: formal;
				if (Buffer.byteLength(next, "utf8") > MAX_SOUL_BYTES) throw new Error("Soul would exceed 4 KiB");
				this.save(scope, next, "");
				return { promoted: true };
			})
			.immediate();
	}

	private state(scope: SoulScope): { formal: string; pending: string } {
		this.assertScope(scope);
		return (
			(this.db
				.query(`
			SELECT formal, pending FROM session_souls
			WHERE persona_id = ? AND space_id = ? AND channel_id = ?
		`)
				.get(scope.personaId, scope.spaceId, scope.channelId) as { formal: string; pending: string } | null) ?? {
				formal: "",
				pending: "",
			}
		);
	}

	private save(scope: SoulScope, formal: string, pending: string): void {
		this.db
			.query(`
			INSERT INTO session_souls (persona_id, space_id, channel_id, formal, pending, updated_at)
			VALUES (?, ?, ?, ?, ?, ?)
			ON CONFLICT(persona_id, space_id, channel_id) DO UPDATE SET
				formal = excluded.formal, pending = excluded.pending, updated_at = excluded.updated_at
		`)
			.run(scope.personaId, scope.spaceId, scope.channelId, formal, pending, Date.now());
	}

	private assertScope(scope: SoulScope): void {
		if (!this.personas.has(scope.personaId)) throw new Error("Persona is not configured for soul storage");
		if (!isSpaceId(scope.spaceId) || !isRawId(scope.channelId))
			throw new Error("Soul scope requires valid space and channel ids");
	}
}
