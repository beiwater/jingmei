import { Database } from "bun:sqlite";
import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { type CelebrationTarget, CelebrationScheduler } from "../src/core/celebrations.ts";
import type { PersonaAccount, Platform, PlatformTransport, SpaceId } from "../src/core/types.ts";

afterEach(() => setSystemTime());

function tickAt(scheduler: CelebrationScheduler, now: Date): Promise<void> {
	setSystemTime(now);
	return scheduler.tick();
}

const guildA: SpaceId = "discord:11111111111111111";
const guildB: SpaceId = "telegram:-1002222222222";
const channelA = "33333333333333333";
const channelB = "-1002222222222";
const userA = "55555555555555555";

type Sent = {
	platform: Platform;
	personaId: string;
	channelId: string;
	content: string;
	mention?: readonly PersonaAccount[];
};

const target = (overrides: Partial<CelebrationTarget> = {}): CelebrationTarget => ({
	spaceId: guildA,
	channelId: channelA,
	personaId: "luna",
	timeZone: "Australia/Sydney",
	calendar: "both",
	...overrides,
});

function harness(
	targets: readonly CelebrationTarget[],
	options: {
		birthdays?: (spaceId: SpaceId, month: number, day: number) => { userId: string; name: string }[];
		send?: (sent: Sent) => Promise<void>;
	} = {},
) {
	const db = new Database(":memory:");
	const sends: Sent[] = [];
	let listBirthdays = options.birthdays ?? (() => []);
	let paused = false;
	const send =
		options.send ??
		(async (sent: Sent) => {
			sends.push(sent);
		});
	const transport = (platform: Platform): PlatformTransport => ({
		platform,
		echoesOwnMessages: platform === "discord",
		displayName: platform,
		promptLines: [],
		quickReactions: {},
		formatMention: (user) => `<mention:${user.userId}:${user.username}>`,
		isValidReaction: () => true,
		sendMessage: async ({ personaId, channelId, content, mention }) => {
			await send({ platform, personaId, channelId, content, ...(mention ? { mention } : {}) });
			return { id: "1" };
		},
	});
	const transports = new Map<Platform, PlatformTransport>([
		["discord", transport("discord")],
		["telegram", transport("telegram")],
	]);
	const create = () =>
		new CelebrationScheduler({
			db,
			targets,
			transports,
			listBirthdays: (space, month, day) => listBirthdays(space, month, day),
			isPaused: () => paused,
		});
	return {
		db,
		sends,
		create,
		setBirthdays: (fn: typeof listBirthdays) => (listBirthdays = fn),
		setPaused: (value: boolean) => (paused = value),
	};
}

describe("celebration scheduler", () => {
	test("waits until 09:00 in the target zone across Sydney's DST change", async () => {
		const h = harness([target()], {
			birthdays: () => [{ userId: userA, name: "小明" }],
		});
		const scheduler = h.create();
		await tickAt(scheduler, new Date("2026-10-03T21:59:00Z")); // 07:59, before the DST jump
		expect(h.sends).toHaveLength(0);
		await tickAt(scheduler, new Date("2026-10-03T22:00:00Z")); // 09:00 after the DST jump
		expect(h.sends).toHaveLength(1);
		expect(h.sends[0]?.content).toBe(`🎂 <mention:${userA}:小明> 生日快乐！祝你新的一岁顺顺利利、每天开心。`);
		// Exactly the birthday member is notified.
		expect(h.sends[0]?.mention).toEqual([{ userId: userA, username: "小明" }]);
		h.db.close();
	});

	test("recognizes Chinese lunar festivals and merges New Year for both calendars", async () => {
		const h = harness([target()]);
		const scheduler = h.create();
		await tickAt(scheduler, new Date("2026-02-17T01:00:00Z")); // Sydney, lunar month 1 day 1
		expect(h.sends).toHaveLength(1);
		expect(h.sends[0]?.content).toContain("春节");
		await tickAt(scheduler, new Date("2027-02-06T01:00:00Z")); // Sydney, Lunar New Year (6 Feb 2027)
		expect(h.sends).toHaveLength(2);
		expect(h.sends[1]?.content).toContain("春节");
		const jan1 = harness([target()]);
		await tickAt(jan1.create(), new Date("2027-01-01T00:00:00Z"));
		expect(jan1.sends).toHaveLength(1);
		expect(jan1.sends[0]?.content).toContain("新年快乐");
		h.db.close();
		jan1.db.close();
	});

	test("uses the target civil date for Lunar New Year and never sends on adjacent days", async () => {
		const h = harness([target({ calendar: "china" })]);
		const scheduler = h.create();
		// HKO's 2027 conversion table puts Lunar New Year on February 6.
		// At 09:00 Sydney time it is still February 5 in UTC.
		await tickAt(scheduler, new Date("2027-02-04T22:00:00Z"));
		expect(h.sends).toHaveLength(0);
		await tickAt(scheduler, new Date("2027-02-05T22:00:00Z"));
		expect(h.sends).toHaveLength(1);
		expect(h.sends[0]?.content).toContain("春节");
		await tickAt(scheduler, new Date("2027-02-06T22:00:00Z"));
		expect(h.sends).toHaveLength(1);
		h.db.close();
	});

	test("recognizes Dragon Boat and Mid-Autumn festivals and excludes leap months", async () => {
		const h = harness([target({ calendar: "china" })]);
		const scheduler = h.create();
		for (const [date, holiday] of [
			["2026-06-19", "端午节"],
			["2026-09-25", "中秋节"],
			["2027-06-09", "端午节"],
			["2027-09-15", "中秋节"],
			["2009-05-28", "端午节"],
		] as const) {
			const count = h.sends.length;
			await tickAt(scheduler, new Date(`${date}T01:00:00Z`));
			expect(h.sends).toHaveLength(count + 1);
			expect(h.sends[count]?.content).toContain(holiday);
		}
		// June 27, 2009 is leap fifth month, day 5, not another Dragon Boat Festival.
		await tickAt(scheduler, new Date("2009-06-27T01:00:00Z"));
		expect(h.sends).toHaveLength(5);
		h.db.close();
	});

	test("recognizes China Labour Day and Australian Boxing Day", async () => {
		const h = harness([target()]);
		const scheduler = h.create();
		await tickAt(scheduler, new Date("2026-05-01T00:00:00Z")); // Sydney, May 1
		expect(h.sends).toHaveLength(1);
		expect(h.sends[0]?.content).toContain("劳动节");
		await tickAt(scheduler, new Date("2026-12-26T00:00:00Z")); // Sydney, Boxing Day
		expect(h.sends).toHaveLength(2);
		expect(h.sends[1]?.content).toContain("Boxing Day");
		expect(h.sends.map((sent) => sent.mention)).toEqual([undefined, undefined]);
		h.db.close();
	});

	test("uses official NSW Easter dates in 2026 and 2027 and deduplicates each Sydney local day", async () => {
		const h = harness([target({ calendar: "australia" })]);
		const scheduler = h.create();
		// NSW lists Good Friday on 3 April and Easter Sunday on 5 April in 2026.
		const goodFriday2026 = new Date("2026-04-03T00:00:00Z"); // 11:00 in Sydney
		await tickAt(scheduler, goodFriday2026);
		await tickAt(scheduler, goodFriday2026);
		expect(h.sends).toHaveLength(1);
		expect(h.sends[0]?.content).toContain("Good Friday");
		await tickAt(scheduler, new Date("2026-04-05T00:00:00Z"));
		expect(h.sends).toHaveLength(2);
		expect(h.sends[1]?.content).toContain("Easter Sunday");

		// NSW lists Good Friday on 26 March and Easter Sunday on 28 March in 2027.
		await tickAt(scheduler, new Date("2027-03-26T00:00:00Z"));
		expect(h.sends).toHaveLength(3);
		expect(h.sends[2]?.content).toContain("Good Friday");
		await tickAt(scheduler, new Date("2027-03-28T00:00:00Z"));
		expect(h.sends).toHaveLength(4);
		expect(h.sends[3]?.content).toContain("Easter Sunday");
		h.db.close();
	});

	test("is idempotent across ticks and scheduler restarts", async () => {
		const h = harness([target()], { birthdays: () => [{ userId: userA, name: "小明" }] });
		const first = h.create();
		const now = new Date("2026-05-04T00:00:00Z");
		await tickAt(first, now);
		await tickAt(first, now);
		const restarted = h.create();
		await tickAt(restarted, now);
		expect(h.sends).toHaveLength(1);
		h.db.close();
	});

	test("retries a failed delivery on the same local date", async () => {
		let attempts = 0;
		const h = harness([target()], {
			birthdays: () => [{ userId: userA, name: "小明" }],
			send: async (sent) => {
				attempts++;
				if (attempts === 1) throw new Error("temporary send failure");
				h.sends.push(sent);
			},
		});
		const scheduler = h.create();
		const now = new Date("2026-05-04T00:00:00Z");
		await expect(tickAt(scheduler, now)).rejects.toThrow("temporary send failure");
		await tickAt(scheduler, now);
		expect(attempts).toBe(2);
		expect(h.sends).toHaveLength(1);
		h.db.close();
	});

	test("recovers a stale in-flight delivery after restart", async () => {
		const h = harness([target()], { birthdays: () => [{ userId: userA, name: "小明" }] });
		const first = new Date("2026-05-04T00:00:00Z");
		const scheduler = h.create();
		h.db
			.query(
				"INSERT INTO celebration_deliveries (space_id,channel_id,persona_id,local_date,event_key,status,created_at) VALUES (?,?,?,?,?,'sending',?)",
			)
			.run(guildA, channelA, "luna", "2026-05-04", `birthday:${userA}`, first.getTime());
		await tickAt(scheduler, first);
		expect(h.sends).toHaveLength(0);
		await tickAt(h.create(), new Date(first.getTime() + 31 * 60_000));
		expect(h.sends).toHaveLength(1);
		h.db.close();
	});

	test("a paused bot holds today's greetings and sends them after resume", async () => {
		const h = harness([target()], { birthdays: () => [{ userId: userA, name: "小明" }] });
		const scheduler = h.create();
		const nineAm = new Date("2026-05-03T23:00:00Z");
		h.setPaused(true);
		await tickAt(scheduler, nineAm);
		expect(h.sends).toHaveLength(0);
		h.setPaused(false);
		await tickAt(scheduler, new Date(nineAm.getTime() + 60_000));
		expect(h.sends).toHaveLength(1);
		h.db.close();
	});

	test("celebrates February 29 birthdays on February 28 in other years", async () => {
		const h = harness([target()], {
			birthdays: (_guild, month, day) => (month === 2 && day === 29 ? [{ userId: userA, name: "小明" }] : []),
		});
		await tickAt(h.create(), new Date("2027-02-28T01:00:00Z"));
		expect(h.sends).toHaveLength(1);
		expect(h.sends[0]?.content).toContain("小明");
		h.db.close();
	});

	test("isolates birthday lookup by space and sends through that space's platform", async () => {
		const h = harness([target(), target({ spaceId: guildB, channelId: channelB, personaId: "luna-b" })], {
			birthdays: (space) => (space === guildB ? [{ userId: userA, name: "小明" }] : []),
		});
		await tickAt(h.create(), new Date("2026-05-04T00:00:00Z"));
		expect(h.sends).toEqual([
			{
				platform: "telegram",
				personaId: "luna-b",
				channelId: channelB,
				content: expect.stringContaining("小明"),
				mention: [{ userId: userA, username: "小明" }],
			},
		]);
		h.db.close();
	});
});
