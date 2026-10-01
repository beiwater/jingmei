# AGENTS.md

精魅（jingmei）：跑在 Pi 上、同时服务 Discord 与 Telegram 群的 AI 群宠。本文件是 agent 会话自动加载的唯一常载文档：短、稳定、高信号。细节在 `docs/`。

## 1. 项目哲学

- **极简，最少机制**：一套设计，不留兼容层。Breaking change 可以做，但迁移要干净、一步到位。删代码优先于加抽象；防御代码只防真实可能的分支。
- **Pi 原生优先**：动手前先查 `node_modules/@earendil-works/*` 导出了什么（会话、压缩、模型目录与认证、图片转码缩放、按模型能力降级图片）。Pi 能做的不自造。
- **不花冤枉钱**：能用确定性代码（路由、SQL、规则）解决的判断不花 LLM token。system prompt 与工具定义保持稳定以命中 provider 前缀缓存，动态内容只进消息或 `context` 事件投影；每轮新增的 provider 可见 token 必须有界。reasoning 默认 `off`。
- 平台是薄适配器：平台差异留在 `src/platforms/<platform>/`，核心只认 `src/core/types.ts`。

## 2. 仓库地图

- `src/main.ts` — 启动编排；`src/discord/main.ts` — systemd 入口（一行 import，**不得改名或改动**，`deploy/pi-discord-agent.service` 也不得改）
- `src/config.ts` — `jingmei.config.json` + `.env` 的唯一读取与校验
- `src/core/` — 对话核心：`conversation.ts`（主流程）、`router.ts`、`context.ts`（上下文投影）、`prompt.ts`、`tools.ts`、`quick-reactions.ts`、`memory.ts`、`member-commands.ts`（两平台共用的生日解析与 context/compact 命令）、`soul.ts`、`celebrations.ts`、`db.ts`、`model-runtime.ts`、`types.ts`
- `src/platforms/discord/`、`src/platforms/telegram/` — 平台适配器
- `src/decision/jev.ts` — TypeSafe Jev 客户端
- `src/media/` — 图片准备、视频抽帧；`src/tools/` — run_js、DeepSeek 搜索、Fish TTS；`src/net/` — 公网 URL 过滤、有界读取
- `src/observability/log.ts` — 结构化日志
- `scripts/migrate-config.ts` — 旧配置迁移；`scripts/git-gpg.sh` — 提交签名
- `docs/architecture.md` — 架构、数据流、表结构、上下文投影、Jev、run_js 威胁模型
- `docs/testing.md` — 测试清单与验证漏斗
- `docs/deploy.md` — 部署、数据目录、迁移

动手前只读与改动相关的章节。

## 3. 硬约束

- Secret 不进日志、测试 fixture、commit；`.env` 不入库。
- 生产代码只经 `src/observability/log.ts` 记日志；不记正文 / prompt / response / tool 参数 / 完整 URL 与路径；业务正确性不依赖日志。
- 配置只有一套：`jingmei.config.json`（业务）+ `.env`（secret，`key: value` 格式）。配置文件只写环境变量名，不写 secret。禁止引入第二来源。
- `bun test` 可使用网络，但永不访问 Discord / Telegram；由 `bunfig.toml` 预加载 `test/network-guard.ts` 阻止这些聊天平台域名。服务单元测试使用注入的 fetch 或本地服务保持确定性，避免真实付费调用。
- 不得为通过验证而削弱测试、类型检查或安全控制（如 run_js 沙箱）。
- 已写入会话文件的协议名不改：`discord_context_v1`、`discord_pending_soul_v1`。表结构变更必须在 `src/core/db.ts` 做幂等迁移并更新 `docs/architecture.md`。
- 用户可见行为变化同步 `README.md` 与 `README.en.md`。

## 4. 改动路由

行为放进拥有该职责的层；不为归属不清新建共享抽象。

- 平台 API、归一化、发送、命令 → `src/platforms/<platform>/`
- 路由、会话、上下文、提示词、模型工具 → `src/core/`（system prompt 与工具定义是缓存前缀，改动要有理由）
- 数据库表与迁移 → 拥有该表的 `src/core/*.ts` + `src/core/db.ts`
- 配置字段 → `src/config.ts` + `jingmei.config.example.json` + README 配置表
- 外部服务客户端 → `src/tools/`、`src/decision/`
- 图片/视频 → `src/media/`

## 5. 测试规则

- 鼓励 TDD。脚手架测试在功能稳定后删除——`test/` 只保留守护长期行为与安全边界的测试，清单见 `docs/testing.md`。
- 能确定性复现的 bug 必须有回归测试；测可观察的轨迹与结果，不断言 prompt 字符串。

## 6. 验证漏斗

1. `bun test test/<相关文件>.test.ts` → `bun test`
2. `bun run check`（tsc --noEmit）
3. `bun run lint`（Biome lint + format check；`bun run format` 自动修）
4. 跨边界改动：测试 bot + 测试群 `bun run start` 实测

仓库已有脚本时不要猜底层命令。

## 7. 提交规范

- 原子提交：一个行为变化一个 commit；只显式暂存本任务路径，禁止 `git add -A`。
- 提交自动 GPG 签名（`scripts/git-gpg.sh`）；签名失败停下诊断，不得绕过。不做破坏性 git 操作（reset --hard / force push / 改写历史）。
- subject：英文祈使句、首字母大写、≤72 字符、描述具体代码结果；纯机械变更末尾加 `Work-Type: mechanical` trailer。
- 提交前跑覆盖本次改动的测试。

## 8. 已知坑

- `.env` 是 `key: value` 冒号格式，由 `src/config.ts` 自解析，不是 dotenv。它的值不会进入 `process.env`，唯一例外是 `src/main.ts` 导出的 `DEEPSEEK_API_KEY`；其他 provider 的 env key 必须在进程环境里。
- Pi 的 agent 目录是 `data/pi-agent`（不是 `~/.pi/agent`）：`models.json`、`auth.json` 都在这里。用 Pi `/login` 需 `PI_CODING_AGENT_DIR="$PWD/data/pi-agent" bunx pi`。
- Telegram Bot API 不向 bot 投递其他 bot 的消息：同群多角色在 Telegram 上互相看不到。群消息还需要关闭 privacy mode。
- Telegram 表情回应只能用 Bot API 枚举（没有 😂，用 🤣）；Discord 与 Telegram 的默认表情表因此不同。
- 同一条消息会被每个角色的连接各收到一次：去重靠 `messages` 主键 `INSERT OR IGNORE`，不要在别处另做一套。
- `bun test` 默认 UTC：涉及时区的测试显式传时区（参考 `test/celebrations.test.ts`）。
- Pi 四包精确锁定 `0.84.1`；升级必须在同一原子提交里更新 manifest 与 lock，并验证兼容性。

## 9. 指南更新规则

单次失误不加规则。新增 / 修改规则须满足：非显然、会复发、可执行。能机械强制的优先做成测试 / lint，而不是文字。
