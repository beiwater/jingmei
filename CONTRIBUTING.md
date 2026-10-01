# Contributing / 参与贡献

[中文](#中文) · [English](#english)

## 中文

感谢你愿意改进精魅。开始之前先读 [AGENTS.md](AGENTS.md)（项目哲学、仓库地图、硬约束），再按需读 [docs/architecture.md](docs/architecture.md) 中与改动相关的章节。

### 开发环境

```bash
bun install
bun test          # 可联网，但 test/network-guard.ts 会拦截 Discord / Telegram
bun run check     # tsc --noEmit
bun run lint      # Biome；bun run format 自动修复
```

需要 Bun 1.3 以上；CI 使用 Bun 1.3.14。跨平台边界的改动请用测试 bot 和测试群 `bun run start` 实测。

### 提交 PR 前

- **一个行为变化一个 commit**；只暂存本次改动的路径。
- commit subject 用英文祈使句，首字母大写，不超过 72 字符，描述具体代码结果。纯机械变更末尾加 `Work-Type: mechanical` trailer。
- 能确定性复现的 bug 必须带回归测试；测可观察的行为，不断言 prompt 字符串。
- 用户可见的行为变化同步更新 `README.md` 与 `README.en.md`；配置字段同步 `src/config.ts`、`jingmei.config.example.json` 和 README 配置表；表结构变更在 `src/core/db.ts` 做幂等迁移并更新 `docs/architecture.md`。
- 不要为了通过检查而削弱测试、类型检查或安全控制（例如 run_js 沙箱）。
- 密钥不得出现在代码、日志、测试 fixture 或 commit 中。

### 报告问题

- Bug 与功能建议：使用 [issue 模板](https://github.com/beiwater/jingmei/issues/new/choose)。
- 安全漏洞：不要公开提交，见 [SECURITY.md](SECURITY.md)。

## English

Thanks for helping improve Jingmei. Start with [AGENTS.md](AGENTS.md) (philosophy, repository map, hard constraints; written in Chinese), then the sections of [docs/architecture.md](docs/architecture.md) relevant to your change.

### Development setup

```bash
bun install
bun test          # network allowed; test/network-guard.ts blocks Discord / Telegram
bun run check     # tsc --noEmit
bun run lint      # Biome; bun run format fixes formatting
```

Bun 1.3 or newer is required; CI uses Bun 1.3.14. Changes crossing the platform boundary should be tried against a test bot and test group with `bun run start`.

### Before opening a PR

- **One behavior change per commit**; stage only the paths you changed.
- Commit subjects are English imperative sentences, capitalized, at most 72 characters, describing the concrete code result. Purely mechanical changes add a `Work-Type: mechanical` trailer.
- Deterministically reproducible bugs need a regression test; test observable behavior, not prompt strings.
- User-visible changes update both `README.md` and `README.en.md`; config fields update `src/config.ts`, `jingmei.config.example.json` and the README tables; schema changes add an idempotent migration in `src/core/db.ts` and update `docs/architecture.md`.
- Never weaken tests, type checking or security controls (such as the run_js sandbox) to make checks pass.
- Secrets never go into code, logs, test fixtures or commits.

### Reporting issues

- Bugs and feature requests: use the [issue templates](https://github.com/beiwater/jingmei/issues/new/choose).
- Security vulnerabilities: do not file publicly; see [SECURITY.md](SECURITY.md).
