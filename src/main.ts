// All public entrypoints supervise one worker, including the unchanged legacy systemd entrypoint.
import { superviseBot } from "./runtime.ts";

if (process.argv.includes("--jingmei-worker")) {
	await (await import("./bot.ts")).startBot();
	// A failed startup may already have opened platform sockets; do not leave a half-started worker alive.
	if (process.exitCode) process.exit(process.exitCode);
} else {
	process.exitCode = await superviseBot();
}
