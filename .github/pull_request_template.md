## What / 改了什么

<!-- One behavior change. Why it is needed and what users will notice. / 一个行为变化：为什么需要，用户会看到什么。 -->

## Verification / 验证

- [ ] `bun test`
- [ ] `bun run check`
- [ ] `bun run lint`
- [ ] Tried with a test bot / 已用测试 bot 实测（跨平台边界的改动）

## Checklist / 检查项

- [ ] User-visible changes are reflected in `README.md` and `README.en.md` / 用户可见变化已同步中英文 README
- [ ] Config fields updated in `src/config.ts`, `jingmei.config.example.json` and README tables (if any) / 配置字段已同步（如有）
- [ ] Schema changes have an idempotent migration in `src/core/db.ts` and are documented in `docs/architecture.md` (if any) / 表结构变更已迁移并更新文档（如有）
- [ ] No secrets, chat content or member IDs in code, logs, fixtures or commits / 无密钥、聊天内容或成员 ID
