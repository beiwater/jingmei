import type { Platform, SpaceId } from "./types.ts";

/** Raw platform ids (Discord snowflakes, Telegram numeric/negative ids) stay opaque strings. */
const RAW_ID = /^[\w.:-]{1,64}$/;
const SPACE_ID = /^(?:discord|telegram):[\w.-]{1,64}$/;

export function isRawId(value: unknown): value is string {
	return typeof value === "string" && RAW_ID.test(value);
}

export function isSpaceId(value: unknown): value is SpaceId {
	return typeof value === "string" && SPACE_ID.test(value);
}

export function platformOf(spaceId: SpaceId): Platform {
	return spaceId.slice(0, spaceId.indexOf(":")) as Platform;
}
