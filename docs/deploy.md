# 部署

精魅是一个常驻前台进程：`bun run start` 或 `bun run jingmei start`（本地），或 systemd 运行的 `bun run src/discord/main.ts`，三者进入同一个 `startBot()`。进程只向 stdout 写结构化 JSONL 日志，收到 SIGINT/SIGTERM 时停止各平台、等待进行中的对话及后台事件刷新后关闭数据库。

## 准备

- 专用 Linux 用户；代码、`.env`、`jingmei.config.json`、persona 文件和 `data/` 都放在该用户家目录下，只有该用户可读。
- [Bun](https://bun.sh/)。仓库 CI 使用 Bun 1.3.14。
- 可选：`ffmpeg` 与 `ffprobe`（Debian/Ubuntu：`sudo apt install ffmpeg`）。缺少任一工具时启动日志有一条 `video_frames_unavailable` 警告，视频只以 `[视频]` 占位进入上下文，其他功能不受影响；安装后重启即可。
- 可选：开启 `textImage`（长文转图）需要系统中文字体（Debian/Ubuntu：`sudo apt install fonts-noto-cjk`），首次渲染会联网下载并缓存两个固定版本的 Typst 包。字体缺失时图里的汉字会变成方框；启动时检测到会记一条 `text_image_font_missing` 警告（功能仍保持开启），装好字体后重启即可。
- 可选：开启 `kline`（K 线图）不需要额外下载，只需出站访问 `data-api.binance.vision`，并有系统字体 DejaVu Sans（Debian/Ubuntu：`fonts-dejavu-core`，通常已安装）；试渲染失败会记 `kline_unavailable` 并关闭该功能。
- 需要可加载 sqlite-vec 的 SQLite（消息检索向量总是需要；macOS 开发机执行 `brew install sqlite`）。首次启动下载约 96 MB 的默认 embedding 模型到 `${dataDir}/models`，允许外网下载并保留缓存；更换 `events.embeddingModel` 时需相应模型资源。可选话题层 `events`：`summaryModel` 必须已在 Pi 中配置且认证，决策来源必须是远程 Jev 或 `localJev`（默认可用 `DEEPSEEK_API_KEY` 的 DeepSeek 包装器）。
- 按 [README](../README.md#快速开始) 准备 `jingmei.config.json`、`.env` 和模型凭据。

## run_js 操作系统沙箱

Linux 首次 `run_js` 调用会自动探测 bubblewrap 是否真正可用；其他系统或探测失败时保留原有 vm 沙箱，不新增配置，也不阻止计算功能。**vm 不是安全边界**：未启用 bwrap 时，引擎逃逸仍可读服务用户的文件并联网。

Ubuntu 24.04 安装发行版工具：

```bash
sudo apt install bubblewrap
command -v bwrap
sysctl kernel.apparmor_restrict_unprivileged_userns
```

Ubuntu 24.04 默认启用 AppArmor 对非特权 user namespace 的限制；`kernel.apparmor_restrict_unprivileged_userns = 1` 时，仅找到 `bwrap` 并不代表可创建沙箱。Ubuntu 的[官方发行说明](https://discourse.ubuntu.com/t/noble-numbat-release-notes/39890)解释了该限制及推荐的应用专用 AppArmor `flags=(unconfined)` + `userns,` 授权方式。若发行版已加载匹配 `/usr/bin/bwrap` 的授权 profile，无需另加；若实际探测仍被 AppArmor 拒绝，由管理员检查现有 profile / 内核拒绝日志，必要时按该官方模式创建 `/etc/apparmor.d/jingmei-bwrap`（这里假设 `command -v bwrap` 为 `/usr/bin/bwrap`）：

```text
abi <abi/4.0>,
include <tunables/global>

profile jingmei-bwrap /usr/bin/bwrap flags=(unconfined) {
  userns,
}
```

不要为同一个 bwrap 路径叠加多个 profile；已有 profile 时应由管理员维护那一份。加载新增 profile：

```bash
sudo apparmor_parser -r /etc/apparmor.d/jingmei-bwrap
systemctl --user restart pi-discord-agent
```

该授权只解决 AppArmor 的 userns 限制，不承诺覆盖其他内核、容器或 systemd 策略；不推荐全局把上述 sysctl 改成 0。Bun 即使位于 `~/.bun/bin/bun` 也只挂载可执行文件本身，不暴露 home。bwrap 参数语义见 [Ubuntu bwrap 手册](https://manpages.ubuntu.com/manpages/noble/man1/bwrap.1.html)；隔离边界及剩余风险见 [architecture.md](architecture.md#run_js-sandbox-威胁模型)。

重启后触发一次正常计算工具调用，并用 `journalctl --user -u pi-discord-agent -f` 查看 `event: "run_js_sandbox"`：`fields.kind: "bwrap"` 才表示试运行成功；`"vm"` 表示本进程回退。日志只出现一次，不包含失败 stderr 或路径；安装工具或调整策略后必须重启重新探测。没有工具调用时不会出现这条日志。

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

改了 `jingmei.config.json`、`.env` 或 persona 文件后同样需要重启。persona 文件在创建或重载会话时读取：重启后已有会话重载时生效，不重启则要等该角色下一次开新对话段。

## 数据目录

默认 `data/`（`dataDir` 可改），整个目录都是私密数据：

| 路径 | 内容 |
|---|---|
| `jingmei.db` | SQLite：消息、消息检索索引（关键词与向量）、话题/参与者/向量、会话索引与对话段状态、带图消息的图片引用、成员记忆、soul、祝福发送记录、运行记录与暂停状态（表结构见 [architecture.md](architecture.md#sqlite)） |
| `sessions/<personaId>/` | Pi 会话文件；每个角色 × 空间 × 频道的当前对话段一个，开新段时新建文件，旧文件保留在磁盘上 |
| `media/` | 进入上下文的图片与视频帧（`img-*.jpg` / `img-*.png`） |
| `models/` | fastembed 模型下载缓存（消息检索向量与话题共用，默认模型约 96 MB） |
| `pi-agent/models.json` | 启动时生成的 DeepSeek 模型目录，不含密钥 |
| `pi-agent/auth.json` | `bun run jingmei login` 保存的 OAuth 凭据（权限 0600，勿入库） |

消息和媒体不会自动清理。需要腾空间时可以删除较早的 `media/img-*` 文件：上下文里缺失的图片会被跳过，不影响对话。备份时停止服务后复制整个 `data/`。

## 升级后回填历史消息索引

升级到带消息检索索引的版本后，新入库的消息会自动在后台建索引（关键词 + 向量，单条串行），但升级前已经入库的旧消息没有索引，`related_messages` / `search_history` 查不到它们，会话行末的“（相关 N 条）”也数不到它们。`sessions` 表的新列与新表由启动时的幂等迁移创建，无需手动处理；旧会话没有对话段状态，每个角色被触发时先开一个新对话段。

用回填脚本给旧消息补建索引，在项目目录、以运行 bot 的同一个用户执行：

```bash
nice -n 10 bun scripts/backfill-message-index.ts [delayMs]
```

- 服务器是单核，回填会和正在运行的 bot 抢 CPU：始终带 `nice -n 10` 以低优先级运行，并避开群里的高峰时段。
- 脚本一次只处理一条消息，每条之后暂停 `delayMs` 毫秒（默认 100）；机器吃紧时调大这个值。
- 按时间从新到旧处理，每 500 条打印一次进度，结束打印 `done`。可以随时中断（Ctrl+C）再重跑，已建好索引的消息会被跳过。
- 向量使用 `events.embeddingModel`（未开话题时用默认模型）与 `data/models` 里的模型缓存。已 `/forget` 的成员的消息不会被索引。
- 回填与 bot 共用同一个 `data/jingmei.db`，部署新版本后运行一次即可，之后无需再跑。

## 从旧版迁移

1. 停止服务。
2. 在项目根运行 `bun scripts/migrate-config.ts`，由 `discord.config.json` 生成 `jingmei.config.json`，检查后按需补 `telegram`、`jev` 段落（见 [README](../README.md#从旧版迁移)）。
3. 启动服务。首次启动时 `data/discord-agent.db`（连同 `-wal`/`-shm`）自动改名为 `data/jingmei.db`，旧的 `discord_*` 表在一个事务里迁移为新表，服务器 ID 改写为 `discord:<guildId>`。如果 `jingmei.db` 已存在，旧文件不会被动。

## 排查

- 启动即退出：stderr 会打印配置错误清单或模型问题（`unknown_model`、`unauthenticated_provider`、`unsupported_reasoning_effort`、`image_input_unsupported`）。
- 启动失败且与模型缓存相关：macOS 确认已安装 Homebrew SQLite；检查 sqlite-vec 能否加载、首次模型下载网络。话题启动失败另查 `events.summaryModel` 认证与决策 key / `localJev` 配置。`jev.endpoint` 的运行时调用失败只在有本地包装器时回退；显式命名却缺失的环境变量仍会拒绝启动。
- Discord 收不到普通消息：检查 Message Content Intent 和频道权限。
- Telegram 只对命令和 @ 有反应：privacy mode 未关闭，日志有 `privacy_mode_enabled`。
- Telegram 群没反应：日志里的 `chat_ignored` 给出未列入 `telegram.chatIds` 的群 ID。
- 某条消息为什么没回：按时间找该消息附近的 `event: "route"`。`stale: true` 表示收到或开始处理时已超过 3 分钟：只入库和写向量索引，明确点名也不回。`reason: "nobody"` 时看 `candidate`（没抽中为 `null`）、`gated`（冷却/占比挡住）、`decision`（`failed` 为接话判断调用失败）与 `chat_in`（低于 `replyThreshold`）；被路由但没发出则看同一角色的 `reply_withheld` / `turn_failed` / `turn_timeout`。重启的 `inbound_recovered { recovered, expired }` 表示补处理的 3 分钟内未完成消息与仅保留历史的过期消息数；没有积压则不记该事件。
- 日志只包含事件名、ID 和错误类别，从不包含消息正文、prompt 或密钥。
