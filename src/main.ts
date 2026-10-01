// 精魅 (jingmei) entrypoint for `bun run start` and the systemd unit (via src/discord/main.ts).
import { startBot } from "./bot.ts";

await startBot();
