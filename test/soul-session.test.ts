import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { join } from "node:path";
import { Conversation } from "../src/core/conversation.ts";
import { type SoulScope, SoulStore } from "../src/core/soul.ts";
import { useCleanups } from "./support/cleanup.ts";
import { conversationOptions, makePersona, makeTransport, personaFile } from "./support/core.ts";
import { assistantMessage, makeModel, makeRuntime, seamOf, streamOf } from "./support/pi.ts";

const model = makeModel();
const runtime = makeRuntime(model);
const scope: SoulScope = { personaId: "luna", spaceId: "discord:111", channelId: "222" };
const note = "A calm and curious conversational style.";
const cleanups = useCleanups();

function result(tool = false) {
	return assistantMessage(
		tool ? [{ type: "toolCall", id: "soul-fixture", name: "update_soul", arguments: { text: note } }] : "Hello.",
		{ model, stopReason: tool ? "toolUse" : "stop", tokens: { input: 100, output: 1 } },
	);
}

test("soul tool, compaction and restart retain the owning conversation without reloading other sessions", async () => {
	const dataDir = cleanups.tmpDir();
	const personaPath = personaFile(dataDir);
	const personas = ["luna", "mio"].map((id, index) =>
		makePersona({
			id,
			personaPath,
			adminUserIds: ["discord:999"],
			sendReactionImages: true,
			accounts: { discord: { userId: `1234567890123456${index}`, username: id } },
		}),
	);
	const transport = makeTransport();
	let db = new Database(join(dataDir, "jingmei.db"));
	let soul = new SoulStore({ db, personaIds: personas.map((persona) => persona.id) });
	const createCore = () =>
		new Conversation(
			conversationOptions({
				db,
				dataDir,
				personas,
				soulStore: soul,
				modelRuntime: runtime,
				transports: [transport],
			}),
		);
	let core = createCore();
	cleanups.push(async () => {
		await core.close();
		db.close();
	});
	// Use real Pi sessions and tools; provider calls and the compaction result are deterministic fixtures.
	const getSession = (target: SoulScope): Promise<AgentSession> => {
		return seamOf(core).getSession(
			personas.find((persona) => persona.id === target.personaId)!,
			target.spaceId,
			target.channelId,
		);
	};
	const otherScopes = [
		{ ...scope, personaId: "mio" },
		{ ...scope, spaceId: "discord:333" } as SoulScope,
		{ ...scope, channelId: "444" },
		{ ...scope, channelId: "555" },
	];
	const session = await getSession(scope);
	const others = await Promise.all(otherScopes.map(getSession));
	let reloads = 0;
	const reload = session.reload.bind(session);
	session.reload = async () => {
		reloads++;
		await reload();
	};
	for (const other of others)
		other.reload = async () => {
			throw new Error("Unrelated session reloaded");
		};
	let calls = 0;
	session.agent.streamFunction = () => {
		return streamOf(result(calls++ === 0));
	};
	await core.handleMessage({
		platform: "discord",
		spaceId: scope.spaceId,
		channelId: scope.channelId,
		messageId: "777",
		authorId: "999",
		authorName: "fixture",
		isBot: false,
		content: "Hello",
		mentionedUserIds: [personas[0]!.accounts.discord!.userId],
	});
	expect(calls).toBe(2);
	expect(soul.readPending(scope)).toBe(`${note}\n`);
	for (const target of otherScopes) expect(soul.readPending(target)).toBe("");
	session.compact = async () => {
		throw new Error("compaction aborted");
	};
	await expect(core.compactContext("luna", "discord", "discord:111", "222", "999")).rejects.toThrow(
		"compaction aborted",
	);
	expect(soul.read(scope)).toBe("");
	expect(soul.readPending(scope)).toBe(`${note}\n`);
	session.compact = async () => ({ summary: "fixture summary", tokensBefore: 100, estimatedTokensAfter: 10 }) as never;
	await core.compactContext("luna", "discord", "discord:111", "222", "999");
	expect(reloads).toBe(1);
	expect(soul.read(scope)).toBe(`${note}\n`);
	expect(soul.readPending(scope)).toBe("");
	for (const target of otherScopes) {
		expect(soul.read(target)).toBe("");
		await getSession(target); // No deferred reload of another conversation either.
	}
	await core.close();
	db.close();
	db = new Database(join(dataDir, "jingmei.db"));
	soul = new SoulStore({ db, personaIds: personas.map((persona) => persona.id) });
	core = createCore();
	const restored = await getSession(scope);
	const other = await getSession(otherScopes[2]!);
	// Inspect the provider boundary through the normal stream callback to detect cross-session leaks.
	const observed: boolean[] = [];
	for (const target of [restored, other]) {
		target.agent.streamFunction = (_model, context) => {
			observed.push(context.systemPrompt?.includes(note) ?? false);
			return streamOf(result());
		};
		await target.prompt("Hello again.");
	}
	expect(observed).toEqual([true, false]);
});
