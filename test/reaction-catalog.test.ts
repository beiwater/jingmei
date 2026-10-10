import { beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ConfigError, validateConfig } from "../src/config.ts";
import { useCleanups } from "./support/cleanup.ts";
import { personaFile } from "./support/core.ts";

const cleanups = useCleanups();
let root: string;
let directory: string;
beforeEach(() => {
	root = cleanups.tmpDir();
	directory = join(root, "personas/feiba");
	mkdirSync(directory, { recursive: true });
	personaFile(root);
	writeFileSync(
		join(directory, "001_innocent.png"),
		readFileSync(join(import.meta.dir, "../assets/reactions/hello.png")),
	);
});

function load(catalog: unknown, reactionImages: unknown = "personas/feiba") {
	if (catalog !== undefined) writeFileSync(join(directory, "catalog.json"), JSON.stringify(catalog));
	return validateConfig(
		{
			telegram: { chatIds: ["-100111"] },
			personas: [
				{
					id: "feiba",
					name: "Feiba",
					personaPath: "persona.md",
					provider: "fixture",
					model: "fixture",
					routingP: 0,
					reactionImages,
					telegram: { tokenEnv: "BOT_TOKEN" },
				},
			],
		},
		root,
		{ ROUTING_SECRET: "fixture", BOT_TOKEN: "fixture" },
	);
}

const entry = { file: "feiba/001_innocent.png", name: "Innocent", caption: "Who, me?", category: "reaction", num: 1 };

function errors(catalog: unknown): readonly string[] {
	try {
		load(catalog);
	} catch (error) {
		if (error instanceof ConfigError) return error.errors;
		throw error;
	}
	throw new Error("Expected an invalid catalog");
}

describe("persona reaction catalog", () => {
	test("accepts an unchanged directory-prefixed catalog and directory-relative files", () => {
		for (const file of [entry.file, "001_innocent.png"]) {
			const catalog = load({ innocent: { ...entry, file } }).personas[0]!.reactionImages!;
			expect(catalog.innocent).toEqual({
				path: join(directory, "001_innocent.png"),
				name: "Innocent",
				caption: "Who, me?",
				contentType: "image/png",
			});
		}
		expect(load({ innocent: entry }, directory).personas[0]!.reactionImages!.innocent!.path).toBe(
			join(directory, "001_innocent.png"),
		);
	});

	test("accepts JPEG and resolves its content type", () => {
		writeFileSync(join(directory, "photo.JPEG"), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
		expect(load({ photo: { ...entry, file: "photo.JPEG" } }).personas[0]!.reactionImages!.photo!.contentType).toBe(
			"image/jpeg",
		);
	});

	test("collects missing files, traversal, built-in collisions and bad extensions", () => {
		writeFileSync(join(directory, "animated.gif"), "GIF89a");
		writeFileSync(join(root, "outside.png"), "outside");
		const problems = errors({
			missing: { ...entry, file: "missing.png" },
			traversal: { ...entry, file: "../../outside.png" },
			hello: entry,
			animated: { ...entry, file: "animated.gif" },
		});
		for (const expected of ["missing or unreadable", "stay inside", "duplicates a built-in", "PNG or JPEG"])
			expect(problems.some((problem) => problem.includes(expected))).toBe(true);
	});

	test("rejects absolute paths and symlinks escaping the directory", () => {
		const outside = join(root, "outside.png");
		writeFileSync(outside, "outside");
		symlinkSync(outside, join(directory, "linked.png"));
		for (const file of [outside, "linked.png", "feiba/../feiba/001_innocent.png"])
			expect(errors({ unsafe: { ...entry, file } })).toContainEqual(expect.stringContaining("stay inside"));
	});

	test("rejects invalid ids and metadata while ignoring extra keys", () => {
		const problems = errors({ "Bad-id": entry, bad_metadata: { ...entry, name: 1, caption: null } });
		for (const expected of ["[a-z0-9_]+", "name must be a string", "caption must be a string"])
			expect(problems).toContainEqual(expect.stringContaining(expected));
	});

	test("requires readable object JSON and a nonempty configured path", () => {
		for (const value of [null, [], "not a catalog"])
			expect(errors(value)).toContainEqual(expect.stringContaining("must be an object"));
		for (const reactionImages of ["", 3])
			expect(() => load({ innocent: entry }, reactionImages)).toThrow("nonempty directory path");
		expect(() => load({ innocent: entry }, "missing")).toThrow("readable, valid catalog.json");
		writeFileSync(join(directory, "catalog.json"), "{");
		expect(() => load(undefined)).toThrow("readable, valid catalog.json");
	});
});
