# 部署

精魅由一个常驻监护进程管理一个 bot 工作进程：`bun run start` 或 `bun run jingmei start`（本地），或 systemd 运行的 `bun run src/discord/main.ts`，三者进入同一个监护入口。工作进程调用 `startBot()`，只向 stdout 写结构化 JSONL 日志；收到 SIGINT/SIGTERM 时停止各平台、等待进行中的对话及后台事件刷新后关闭数据库。

## 准备

- 专用 Linux 用户；代码、`.env`、`jingmei.config.json`、persona 文件和 `data/` 都放在该用户家目录下，只有该用户可读。
- [Bun](https://bun.sh/)。仓库 CI 使用 Bun 1.3.14。
- 必需：`bubblewrap` 与允许其创建 user namespace 的系统策略（见下文“run_js 操作系统沙箱”）；缺少时启动直接报错退出。
- 可选：`ffmpeg` 与 `ffprobe`（Debian/Ubuntu：`sudo apt install ffmpeg`）。缺少任一工具时启动日志有一条 `video_frames_unavailable` 警告，视频只以 `[视频]` 占位进入上下文，其他功能不受影响；安装后重启即可。
- 可选：开启 `textImage`（长文转图）需要系统中文字体（Debian/Ubuntu：`sudo apt install fonts-noto-cjk`），首次渲染会联网下载并缓存两个固定版本的 Typst 包。字体缺失时图里的汉字会变成方框；启动时检测到会记一条 `text_image_font_missing` 警告（功能仍保持开启），装好字体后重启即可。
- 可选：开启 `kline`（K 线图）不需要额外下载，只需出站访问 `data-api.binance.vision`，并有系统字体 DejaVu Sans（Debian/Ubuntu：`fonts-dejavu-core`，通常已安装）；试渲染失败会记 `kline_unavailable` 并关闭该功能。
- `features.history` 开启（默认）时需要可加载 sqlite-vec 的 SQLite（macOS 开发机执行 `brew install sqlite`），首次启动下载约 96 MB 的默认 embedding 模型到 `${dataDir}/models`，允许外网下载并保留缓存；更换 `events.embeddingModel` 时需相应模型资源。设 `features.history: false` 则两者都不需要。可选话题层 `events`：`summaryModel` 必须已在 Pi 中配置且认证，决策来源必须是远程 Jev 或 `localJev`（默认可用 `DEEPSEEK_API_KEY` 的 DeepSeek 包装器）。
- 按 [README](../README.md#快速开始) 准备 `jingmei.config.json`、`.env` 和模型凭据：`bun run jingmei init` 向导一步生成三者（已有 `jingmei.config.json` 或 `.env` 时拒绝运行，不覆盖），之后 `bun run jingmei doctor` 自检。

## run_js 操作系统沙箱

`run_js` 只在 bubblewrap 里运行，没有回退。启动时用真实的 bwrap 参数试运行一次 `1 + 1`；非 Linux、未安装 bwrap、被 AppArmor 拒绝 user namespace、挂载或运行时失败都会让启动直接报错退出（stderr 打印原因），不新增配置。**node:vm 不是安全边界**，所以不在没有 bwrap 的机器上降级运行。

Ubuntu 24.04 安装发行版工具：

```bash
sudo apt install bubblewrap
command -v bwrap
sysctl kernel.apparmor_restrict_unprivileged_userns
```

Ubuntu 24.04 默认启用 AppArmor 对非特权 user namespace 的限制；`kernel.apparmor_restrict_unprivileged_userns = 1` 时，仅找到 `bwrap` 并不代表可创建沙箱。Ubuntu 的[官方发行说明](https://discourse.ubuntu.com/t/noble-numbat-release-notes/39890)解释了该限制及推荐的应用专用 AppArmor `flags=(unconfined)` + `userns,` 授权方式。若发行版已加载匹配 `/usr/bin/bwrap` 的授权 profile，无需另加；若启动试运行仍被 AppArmor 拒绝，由管理员检查现有 profile / 内核拒绝日志，必要时按该官方模式创建 `/etc/apparmor.d/jingmei-bwrap`（这里假设 `command -v bwrap` 为 `/usr/bin/bwrap`）：

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

重启后服务正常启动即表示试运行成功；失败时 `bun run start` 的 stderr 与 `journalctl --user -u pi-discord-agent` 里的 `startup_failed` 都会给出原因（stderr 不含 bwrap 的详细输出，userns 被拒通常表现为 `sandbox exited without a structured result`）。安装工具或调整策略后重启即可重新探测。

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

首次升级到带热更新的版本，需要先按旧方式更新并重启一次，启用监护进程（前台运行时用 Ctrl+C 后重新 `bun run start`）：

```bash
git pull --ff-only
bun install --frozen-lockfile
systemctl --user restart pi-discord-agent
```

以后在项目目录、以运行 bot 的同一个用户执行即可，不必手动重启：

```bash
bun run update
# 等价：bun run jingmei update；交互菜单也有 Update
```

命令快进拉取**当前分支的 upstream**，运行 `bun install --frozen-lockfile` 和 `bun run check`，全部成功后写入 `.jingmei-reload` 请求重载。即使已经是最新提交，也重新检查依赖并通知重载，便于失败后重试。未运行的 bot 不会被启动。tracked 文件有未提交改动、detached HEAD、未设置 upstream、分支分叉或步骤失败时退出，不 stash、不 reset、不请求重载；已经拉取的代码不会自动回滚。个人 `.env`、配置、角色文件、`data/` 应保持未跟踪 / 忽略。

监护进程通过 `fs.watch` 监听配置、`.env` 与 `personaPath` 引用的文件（含项目外路径）的父目录；收到目录事件后防抖 500ms，比较实际文件内容，再校验并优雅重载，空闲时不扫描文件。目录事件仅作为变化提示，不依赖回调一定给出目标文件名，以兼容编辑器原子替换保存及合并的事件；角色文件暂缺或目录被替换时会重新挂载监听。同内容保存、无关文件变化与重复事件不会重启 bot。更新锁释放也由目录事件唤醒，不轮询等待。语法 / 字段校验失败记 `reload_rejected`，旧 bot 保持运行，修复后自动重试。旧工作进程退出前等待当前对话与后台写入完成；最多 210 秒，超时记 `shutdown_timeout` 并强制结束，随后重建工作进程，因此不是零断线更新。新 bot 启动失败时查看 `startup_failed`，退出码与原有 systemd 策略一致。数据库、记忆、暂停状态、模型选择保留；对话段沿用原有重启边界，在下一次触发时开新段。

更新期间 `.jingmei-update.lock` 防止并发更新并暂停自动重载；依赖安装 / 类型检查失败时不会发出代码重载请求。正常结束会删除锁；若更新被强制中断，确认没有其他更新进程后删除该锁再运行 `bun run update`。这两个控制文件已加入 `.gitignore`。直接手动修改源码或图库 catalog 后仍需手动重启；监护进程自身的代码变动也在下次完整重启时加载。

## 数据目录

默认 `data/`（`dataDir` 可改），整个目录都是私密数据：

| 路径 | 内容 |
|---|---|
| `jingmei.db` | SQLite：消息、消息检索索引（关键词与向量）、话题/参与者/向量、会话索引与对话段状态、带图消息的图片引用、成员记忆、soul、祝福发送记录、运行记录与暂停状态（表结构见 [architecture.md](architecture.md#sqlite)） |
| `sessions/<personaId>/` | Pi 会话文件；每个角色 × 空间 × 频道的当前对话段一个，开新段时新建文件，旧文件保留在磁盘上 |
| `media/` | 进入上下文的图片与视频帧（`img-*.jpg` / `img-*.png`） |
| `models/` | fastembed 模型下载缓存（消息检索向量与话题共用，默认模型约 96 MB；`features.history` 关闭时不创建） |
| `pi-agent/models.json` | 启动时生成的 DeepSeek 模型目录，不含密钥 |
| `telemetry.json` | 随机实例 ID 与“已显示告知”标记（权限 0600）；删除后该实例会被当作新实例统计 |
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

## 配置 PostHog 使用统计

[使用统计](../README.md#使用统计)发往 PostHog。只有维护发行版的人需要配置；自己跑 bot 的人不需要。

1. 在 PostHog 建一个项目，记下区域（US 或 EU）。
2. **先**在 Settings → Project → IP data capture configuration 打开 **Discard client IP data**。README 和首次启动的告知都承诺“不保存 IP”，这一项是客户端无法代为保证的；EU 组织的新项目默认已关闭 IP 采集，但仍应核对。
3. 把项目 token（`phc_...`，只写、可公开）填进 `src/tools/telemetry.ts` 的 `POSTHOG_KEY`，EU 项目同时把 `POSTHOG_HOST` 改为 `https://eu.i.posthog.com`，然后发布新版本。填写前发行版不会发送任何东西。
4. 在 PostHog 里看 `jingmei_report` 事件，按 `distinct_id`（实例）去重计数即得安装数；`properties` 里的 `version`、`os`、`feature_*` 可用来分组。

## 排查

- 先跑 `bun run jingmei doctor`：只读自检，逐项给出 OK / WARN / FAIL 和一行修复提示（配置、`run_js` 沙箱、模型与认证、Discord / Telegram token 与权限、ffmpeg / 字体 / sqlite-vec / embedding 缓存），有 FAIL 时退出码非 0；下面是 doctor 覆盖不到的现象。
- 启动即退出：stderr 会打印配置错误清单或模型问题（`unknown_model`、`unauthenticated_provider`、`unsupported_reasoning_effort`、`image_input_unsupported`）。
- 启动失败且与模型缓存相关：macOS 确认已安装 Homebrew SQLite；检查 sqlite-vec 能否加载、首次模型下载网络。话题启动失败另查 `events.summaryModel` 认证与决策 key / `localJev` 配置。`jev.endpoint` 的运行时调用失败只在有本地包装器时回退；显式命名却缺失的环境变量仍会拒绝启动。
- Discord 收不到普通消息：检查 Message Content Intent 和频道权限。
- Discord Gateway 不可恢复的关闭码（日志 `transport_error` 带 `close_code`）：进程会向 stderr 打印提示并优雅关闭，重连无法修复。退出码刻意为 0：服务是 `Restart=on-failure`，非零退出会每几秒重连一次并反复 IDENTIFY，Discord 每天超过 1000 次会重置令牌；所以修好后需手动重启服务。`4014` 在 Discord Developer Portal 的 Bot 页打开 Message Content Intent；`4013` 是 jingmei 发出的 intents 值被拒，属于代码问题，请升级或报告；`4004` 令牌无效，检查 `.env` 里该角色的令牌变量；`4010` / `4011` / `4012` 是分片或 API 版本被拒，通常是 Discord 侧变化，需升级代码。其他关闭码会自动重连。
- Telegram 只对命令和 @ 有反应：privacy mode 未关闭，日志有 `privacy_mode_enabled`。
- Telegram 群没反应：日志里的 `chat_ignored` 给出未列入 `telegram.chatIds` 的群 ID。
- 某条消息为什么没回：按时间找该消息附近的 `event: "route"`。`stale: true` 表示收到或开始处理时已超过 3 分钟：只入库和写向量索引，明确点名也不回。`reason: "nobody"` 时看 `candidate`（没抽中为 `null`）、`gated`（冷却/占比挡住）、`decision`（`failed` 为接话判断调用失败）与 `chat_in`（低于 `replyThreshold`）；被路由但没发出则看同一角色的 `reply_withheld` / `turn_failed` / `turn_timeout`；`reply_rewrite` 表示第一次审查没过、已让角色带原因重写，随后没有 `reply_withheld` 就说明重写发出去了。重启的 `inbound_recovered { recovered, expired }` 表示补处理的 3 分钟内未完成消息与仅保留历史的过期消息数；没有积压则不记该事件。
- 日志只包含事件名、ID 和错误类别，从不包含消息正文、prompt 或密钥。
