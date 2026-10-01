# 部署

精魅是一个常驻前台进程：`bun run start` 或 `bun run jingmei start`（本地），或 systemd 运行的 `bun run src/discord/main.ts`，三者进入同一个 `startBot()`。进程只向 stdout 写结构化 JSONL 日志，收到 SIGINT/SIGTERM 时停止各平台、等待进行中的对话及后台事件刷新后关闭数据库。

## 准备

- 专用 Linux 用户；代码、`.env`、`jingmei.config.json`、persona 文件和 `data/` 都放在该用户家目录下，只有该用户可读。
- [Bun](https://bun.sh/)。仓库 CI 使用 Bun 1.3.14。
- 可选：`ffmpeg` 与 `ffprobe`（Debian/Ubuntu：`sudo apt install ffmpeg`）。缺少任一工具时启动日志有一条 `video_frames_unavailable` 警告，视频只以 `[视频]` 占位进入上下文，其他功能不受影响；安装后重启即可。
- 可选话题层 `events`：需要可加载 sqlite-vec 的 SQLite；macOS 开发机执行 `brew install sqlite`。首次启动下载约 96 MB 的默认 embedding 模型到 `${dataDir}/models`，允许外网下载并保留缓存；更换 `embeddingModel` 时需相应模型资源。`summaryModel` 必须已在 Pi 中配置且认证，决策来源必须是远程 Jev 或 `localJev`（默认可用 `DEEPSEEK_API_KEY` 的 DeepSeek 包装器）。
- 按 [README](../README.md#快速开始) 准备 `jingmei.config.json`、`.env` 和模型凭据。

## systemd 用户服务

仓库里的 [`deploy/pi-discord-agent.service`](../deploy/pi-discord-agent.service)：

```ini
[Service]
Type=simple
WorkingDirectory=%h/apps/pi-extension-discord
ExecStart=%h/.local/share/pi-discord-bun/node_modules/.bin/bun run src/discord/main.ts
Restart=on-failure
RestartSec=5
UMask=0077
```

服务名和启动命令沿用改名前的部署，保持不变；`src/discord/main.ts` 只有一行，导入 `src/main.ts`。如果代码目录或 Bun 路径不同，修改 `WorkingDirectory` 与 `ExecStart` 里的路径即可。`UMask=0077` 让新建的数据库、会话和媒体文件只有服务用户可读。

服务运行时，在代码目录以服务用户执行 `bun run jingmei` 打开运维菜单；也可直接 `bun run jingmei pause` / `resume` 暂停或恢复回复（立即生效、重启后保留），`bun run jingmei model` 切换角色模型（运行中的 bot 在下一次回复前生效），`bun run jingmei stats` 查看运行时长和数据汇总；详见 [README 运维命令](../README.md#运维命令)。暂停不会停止进程，停服务仍用 `systemctl --user stop pi-discord-agent`。

```bash
cp deploy/pi-discord-agent.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now pi-discord-agent
systemctl --user status pi-discord-agent
journalctl --user -u pi-discord-agent -f
```

未登录时也要运行，需为该用户开启 lingering：

```bash
sudo loginctl enable-linger <linux-user>
```

非 DeepSeek 的 provider 若通过环境变量认证，变量必须进入服务进程环境（例如 `systemctl --user edit pi-discord-agent` 添加 `Environment=` 或 `EnvironmentFile=`）；`.env` 除 `DEEPSEEK_API_KEY` 外不会转交给 Pi。用 `bun run jingmei login` 登录的 OAuth 凭据保存在 `data/pi-agent/auth.json`，不需要额外设置；服务器没有浏览器时，在本机打开打印的链接，再把跳转 URL 或授权码粘贴回终端。

## 更新

```bash
git pull
bun install --frozen-lockfile
systemctl --user restart pi-discord-agent
```

改了 `jingmei.config.json`、`.env` 或 persona 文件后同样需要重启。persona 文件在创建会话时读取，重启后才对已有会话生效。

## 数据目录

默认 `data/`（`dataDir` 可改），整个目录都是私密数据：

| 路径 | 内容 |
|---|---|
| `jingmei.db` | SQLite：消息、话题/参与者/向量、会话索引、成员记忆、soul、祝福发送记录、运行记录与暂停状态（表结构见 [architecture.md](architecture.md#sqlite)） |
| `sessions/<personaId>/` | Pi 会话文件，每个角色 × 空间 × 频道一个 |
| `media/` | 进入上下文的图片与视频帧（`img-*.jpg` / `img-*.png`） |
| `models/` | fastembed 模型下载缓存（仅开启 `events` 时使用，默认模型约 96 MB） |
| `pi-agent/models.json` | 启动时生成的 DeepSeek 模型目录，不含密钥 |
| `pi-agent/auth.json` | `bun run jingmei login` 保存的 OAuth 凭据（权限 0600，勿入库） |

消息和媒体不会自动清理。需要腾空间时可以删除较早的 `media/img-*` 文件：上下文里缺失的图片会被跳过，不影响对话。备份时停止服务后复制整个 `data/`。

## 从旧版迁移

1. 停止服务。
2. 在项目根运行 `bun scripts/migrate-config.ts`，由 `discord.config.json` 生成 `jingmei.config.json`，检查后按需补 `telegram`、`jev` 段落（见 [README](../README.md#从旧版迁移)）。
3. 启动服务。首次启动时 `data/discord-agent.db`（连同 `-wal`/`-shm`）自动改名为 `data/jingmei.db`，旧的 `discord_*` 表在一个事务里迁移为新表，服务器 ID 改写为 `discord:<guildId>`。如果 `jingmei.db` 已存在，旧文件不会被动。

## 排查

- 启动即退出：stderr 会打印配置错误清单或模型问题（`unknown_model`、`unauthenticated_provider`、`unsupported_reasoning_effort`、`image_input_unsupported`）。
- 话题启动失败：macOS 确认已安装 Homebrew SQLite；检查 sqlite-vec 能否加载、首次模型下载网络、`events.summaryModel` 认证与决策 key / `localJev` 配置。`jev.endpoint` 的运行时调用失败只在有本地包装器时回退；显式命名却缺失的环境变量仍会拒绝启动。
- Discord 收不到普通消息：检查 Message Content Intent 和频道权限。
- Telegram 只对命令和 @ 有反应：privacy mode 未关闭，日志有 `privacy_mode_enabled`。
- Telegram 群没反应：日志里的 `chat_ignored` 给出未列入 `telegram.chatIds` 的群 ID。
- 日志只包含事件名、ID 和错误类别，从不包含消息正文、prompt 或密钥。
