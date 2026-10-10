import type { Database } from "bun:sqlite";
import { Solar, SolarUtil } from "lunar-typescript";
import { platformOf } from "./ids.ts";
import type { PersonaAccount, Platform, PlatformTransport, SpaceId } from "./types.ts";

export interface CelebrationTarget {
	spaceId: SpaceId;
	channelId: string;
	personaId: string;
	timeZone: string;
	calendar: "china" | "australia" | "both";
}

export interface BirthdayMember {
	userId: string;
	name: string;
}

export interface CelebrationSchedulerOptions {
	db: Database;
	targets: readonly CelebrationTarget[];
	listBirthdays: (spaceId: SpaceId, month: number, day: number) => readonly BirthdayMember[];
	/** Each target sends through the transport named by its space prefix. */
	transports: ReadonlyMap<Platform, PlatformTransport>;
	/** A paused bot sends nothing; greetings due today go out after resume. */
	isPaused: () => boolean;
	onError?: (error: unknown) => void;
}

interface LocalDateTime {
	year: number;
	month: number;
	day: number;
	hour: number;
}

const INTERVAL_MS = 60_000;
const STALE_SEND_MS = 30 * 60_000;

function dateTimeInZone(date: Date, timeZone: string): LocalDateTime {
	const parts = new Intl.DateTimeFormat("en-CA", {
		timeZone,
		year: "numeric",
		month: "numeric",
		day: "numeric",
		hour: "numeric",
		hourCycle: "h23",
	}).formatToParts(date);
	const value = (type: string) => Number(parts.find((part) => part.type === type)?.value);
	return { year: value("year"), month: value("month"), day: value("day"), hour: value("hour") };
}

/** Gregorian computus: returns the Western Easter Sunday date for the given year. */
function easterSunday(year: number): { month: number; day: number } {
	const a = year % 19;
	const b = Math.floor(year / 100);
	const c = year % 100;
	const d = Math.floor(b / 4);
	const e = b % 4;
	const f = Math.floor((b + 8) / 25);
	const g = Math.floor((b - f + 1) / 3);
	const h = (19 * a + b - d - g + 15) % 30;
	const i = Math.floor(c / 4);
	const k = c % 4;
	const l = (32 + 2 * e + 2 * i - h - k) % 7;
	const m = Math.floor((a + 11 * h + 22 * l) / 451);
	const value = h + l - 7 * m + 114;
	return { month: Math.floor(value / 31), day: (value % 31) + 1 };
}

function holidayOn(local: LocalDateTime, calendar: CelebrationTarget["calendar"]): string[] {
	const found: string[] = [];
	if (calendar === "china" || calendar === "both") {
		if (local.month === 1 && local.day === 1) found.push("元旦");
		if (local.month === 5 && local.day === 1) found.push("劳动节");
		// Use the target's civil date and a deterministic calendar, independent of host ICU.
		const lunar = Solar.fromYmd(local.year, local.month, local.day).getLunar();
		// Leap months are negative, so these comparisons exclude them.
		if (lunar.getMonth() === 1 && lunar.getDay() === 1) found.push("春节");
		if (lunar.getMonth() === 5 && lunar.getDay() === 5) found.push("端午节");
		if (lunar.getMonth() === 8 && lunar.getDay() === 15) found.push("中秋节");
		if (local.month === 10 && local.day === 1) found.push("国庆节");
	}
	if (calendar === "australia" || calendar === "both") {
		if (local.month === 1 && local.day === 1) {
			if (!found.includes("元旦")) found.push("元旦");
		}
		if (local.month === 1 && local.day === 26) found.push("Australia Day");
		if (local.month === 4 && local.day === 25) found.push("ANZAC Day");
		if (local.month === 12 && local.day === 25) found.push("圣诞节");
		if (local.month === 12 && local.day === 26) found.push("Boxing Day");
		const easter = easterSunday(local.year);
		const goodFriday = Solar.fromYmd(local.year, easter.month, easter.day).next(-2);
		if (local.month === goodFriday.getMonth() && local.day === goodFriday.getDay()) found.push("Good Friday");
		if (local.month === easter.month && local.day === easter.day) found.push("Easter Sunday");
	}
	return found;
}

/** The mention itself renders the member's name on both platforms, so the name is not repeated. */
function birthdayGreeting(mention: string): string {
	return `🎂 ${mention} 生日快乐！祝你新的一岁顺顺利利、每天开心。`;
}

/**
 * Sends one birthday greeting per member and one greeting per holiday and target,
 * once local time is at or after 09:00. Delivery claims live in SQLite so a
 * completed message is never emitted again after restart.
 */
export class CelebrationScheduler {
	private timer: ReturnType<typeof setInterval> | undefined;
	private stopped = true;
	private running: Promise<void> | undefined;

	constructor(private readonly options: CelebrationSchedulerOptions) {
		for (const target of options.targets) {
			// Fail during startup on an unserved platform, not on the first birthday.
			if (!options.transports.has(platformOf(target.spaceId)))
				throw new Error(`celebration target ${target.spaceId} has no running platform`);
		}
		options.db.exec(`
			CREATE TABLE IF NOT EXISTS celebration_deliveries (
				space_id TEXT NOT NULL,
				channel_id TEXT NOT NULL,
				persona_id TEXT NOT NULL,
				local_date TEXT NOT NULL,
				event_key TEXT NOT NULL,
				status TEXT NOT NULL CHECK (status IN ('sending', 'sent')),
				created_at INTEGER NOT NULL,
				sent_at INTEGER,
				PRIMARY KEY (space_id, channel_id, persona_id, local_date, event_key)
			);
		`);
	}

	start(): void {
		if (!this.stopped) return;
		this.stopped = false;
		const run = () => void this.tick().catch((error) => this.options.onError?.(error));
		run();
		this.timer = setInterval(run, INTERVAL_MS);
		this.timer.unref?.();
	}

	async stop(): Promise<void> {
		this.stopped = true;
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
		await this.running;
	}

	async tick(): Promise<void> {
		if (this.running) return this.running;
		const task = this.deliverForDate(new Date());
		this.running = task;
		try {
			await task;
		} finally {
			if (this.running === task) this.running = undefined;
		}
	}

	private async deliverForDate(now: Date): Promise<void> {
		if (this.options.isPaused()) return;
		for (const target of this.options.targets) {
			const local = dateTimeInZone(now, target.timeZone);
			if (local.hour < 9) continue;
			const localDate = `${local.year.toString().padStart(4, "0")}-${local.month.toString().padStart(2, "0")}-${local.day.toString().padStart(2, "0")}`;
			const birthdays = [...this.options.listBirthdays(target.spaceId, local.month, local.day)];
			// A February 29 birthday is celebrated on February 28 in non-leap years.
			if (local.month === 2 && local.day === 28 && !SolarUtil.isLeapYear(local.year))
				birthdays.push(...this.options.listBirthdays(target.spaceId, 2, 29));
			const transport = this.options.transports.get(platformOf(target.spaceId))!;
			for (const member of birthdays) {
				// Exactly one notified recipient: the member whose birthday it is.
				const name = member.name
					.replace(/[\r\n]/g, " ")
					.trim()
					.slice(0, 80);
				const account = { userId: member.userId, username: name };
				const content = birthdayGreeting(transport.formatMention(account));
				await this.sendOnce(target, localDate, `birthday:${member.userId}`, content, now, [account]);
			}
			for (const holiday of holidayOn(local, target.calendar)) {
				await this.sendOnce(
					target,
					localDate,
					`holiday:${holiday}`,
					holiday === "元旦"
						? "🎉 新年快乐！愿大家新的一年平安顺心、万事顺意。"
						: `🎉 今天是${holiday}，祝大家节日愉快、平安顺心！`,
					now,
				);
			}
		}
	}

	private async sendOnce(
		target: CelebrationTarget,
		localDate: string,
		eventKey: string,
		content: string,
		now: Date,
		mention?: readonly PersonaAccount[],
	): Promise<void> {
		const claimed = this.options.db
			.query(`
				INSERT INTO celebration_deliveries
					(space_id, channel_id, persona_id, local_date, event_key, status, created_at)
				VALUES (?, ?, ?, ?, ?, 'sending', ?)
				ON CONFLICT (space_id, channel_id, persona_id, local_date, event_key) DO UPDATE SET
					created_at = excluded.created_at
				WHERE celebration_deliveries.status = 'sending'
					AND celebration_deliveries.created_at < ?
			`)
			.run(
				target.spaceId,
				target.channelId,
				target.personaId,
				localDate,
				eventKey,
				now.getTime(),
				now.getTime() - STALE_SEND_MS,
			);
		if (claimed.changes === 0) return;
		try {
			await this.options.transports.get(platformOf(target.spaceId))!.sendMessage({
				personaId: target.personaId,
				channelId: target.channelId,
				content,
				...(mention ? { mention } : {}),
			});
			this.options.db
				.query(`
					UPDATE celebration_deliveries SET status = 'sent', sent_at = ?
					WHERE space_id = ? AND channel_id = ? AND persona_id = ? AND local_date = ? AND event_key = ?
				`)
				.run(now.getTime(), target.spaceId, target.channelId, target.personaId, localDate, eventKey);
		} catch (error) {
			this.options.db
				.query(`
					DELETE FROM celebration_deliveries
					WHERE space_id = ? AND channel_id = ? AND persona_id = ? AND local_date = ? AND event_key = ? AND status = 'sending'
				`)
				.run(target.spaceId, target.channelId, target.personaId, localDate, eventKey);
			throw error;
		}
	}
}
