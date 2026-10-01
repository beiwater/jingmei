# Security Policy / 安全策略

## Reporting a vulnerability / 报告漏洞

Please **do not** open a public issue. Report privately through GitHub's [private vulnerability reporting](https://github.com/beiwater/jingmei/security/advisories/new) and include affected versions or commits, reproduction steps and the impact you observed.

请**不要**公开提交 issue。通过 GitHub [私密漏洞报告](https://github.com/beiwater/jingmei/security/advisories/new) 提交，并附上受影响的版本或 commit、复现步骤和实际影响。

## Supported versions / 支持范围

Only the latest commit on `main` receives fixes. 只修复 `main` 分支的最新版本。

## Scope / 关注范围

Jingmei reads untrusted group messages and feeds them to an LLM that can call tools, so these are in scope:

精魅读取不可信的群消息并交给可调用工具的 LLM，以下问题都在范围内：

- **run_js escape** — reaching host objects, the file system, the network or environment variables from `run_js` (threat model: [docs/architecture.md](docs/architecture.md#run_js-sandbox-威胁模型)). / 从 `run_js` 拿到宿主对象、文件、网络或环境变量。
- **Secret disclosure** — bot tokens or API keys appearing in logs, replies, session files or error messages. / bot token、API key 出现在日志、回复、会话文件或错误信息里。
- **Server-side request forgery** — media or tool fetches reaching private or internal addresses. / 媒体或工具请求访问到内网地址。
- **Memory and privacy bypass** — collecting data after `/forget`, recalling another space's members, or leaking member profiles into public replies. / `/forget` 后仍收集数据、跨群召回成员、在公开回复中泄露成员档案。
- **Authorization bypass** — non-admins running `/context` or `/compact`, or a persona answering outside its configured spaces. / 非管理员执行管理员命令，或角色在未配置的空间发言。

Out of scope: weaknesses in third-party providers (Discord, Telegram, model providers, TypeSafe, Fish Audio) and attacks that require access to the host account or its `.env`.

不在范围内：第三方服务本身的问题，以及需要先拿到宿主账号或 `.env` 的攻击。
