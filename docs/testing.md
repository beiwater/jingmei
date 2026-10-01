# 测试

> 当前真实的测试状态。增删测试文件时同步更新清单。

## 验证漏斗

由便宜到贵，跑到能覆盖改动的那一层：

1. `bun test test/<相关文件>.test.ts`
2. `bun test`：全量；允许联网但永不访问 Discord / Telegram
3. `bun run check`：`tsc --noEmit`
4. `bun run lint`：Biome lint + 格式检查（`bun run format` 自动修复）
5. 真实平台 smoke：跨边界改动才需要。用测试 bot 和测试群/频道 `bun run start`，观察日志与实际回复

CI（`.github/workflows/ci.yml`）按顺序运行 `bun install --frozen-lockfile`、`bun test`、`bun run check`、`bun run lint`。

## 网络隔离

`bunfig.toml` 预加载 `test/network-guard.ts`：测试可联网（例如下载 embedding 模型），但 `fetch` 永不放行 Discord 域名 `discord.com`、`discordapp.com`、`discord.gg`、`discordapp.net` 及其子域名，或 Telegram Bot API `api.telegram.org`；日志输出同时被静音。即使本机有真实 `.env`，测试也不能向这些聊天平台发消息。模型/服务的单元测试仍注入 `fetchImpl` 或起本地 Bun server，以保持确定性并避免真实付费调用。

## 测试清单

`test/` 只保留守护长期行为与安全边界的测试。

| 文件 | 守护什么 |
|---|---|
| `network-isolation.test.ts` | 有真实凭据时仍拒绝 Discord / Telegram（含 Discord 子域名） |
| `log.test.ts` | `persona_id` 原样保留以区分多角色；token/key/prompt/content/url/path 字段仍脱敏；字符串中的 Telegram token、`sk-` key、URL、绝对路径被替换 |
| `config.test.ts` | `jingmei.config.json` 默认值与密钥解析；Jev endpoint 与本地 LLM 默认/覆盖/无鉴权、显式缺失 key 报错、events 摘要/embedding 校验与决策来源要求；reasoning 档位、`visionModel` 拆分、管理员 ID 按平台规范化、一次收集全部错误且不回显密钥、空间与每空间 `routingP` 之和、平台段落与账号的相互要求、`process.env` 覆盖 `.env`、`.env` 解析错误只报行号、`discord.config.json` 迁移结果可加载、DeepSeek 模型目录只生成一次且不含密钥 |
| `events.test.ts` | 人类消息话题归属、人与 bot 回复直接继承且不决策、空间/频道隔离；裸媒体/低内容继承及十分钟边界、视觉描述/Unicode 正文保留决策；`new` 概率低于 0.6 选最佳旧话题、达到阈值或无概率保留新话题；两小时活跃边界与旧话题召回；3、6、12……后台 single-flight 摘要、参与度与向量刷新；messages 幂等迁移 |
| `local-jev.test.ts` | 进程内 LLM→Jev 的决策概率与答案边界、logprobs 各话题概率传递、OpenAI-compatible 请求及鉴权、DeepSeek 关闭 thinking、弃答取 argmax、缺 logprobs 视为失败、超时与中止传递、不泄露 provider 错误正文 |
| `migration.test.ts` | 旧 `discord-agent.db` 改名并把 `discord_*` 表迁移为按空间的新表且只迁移一次；已有 `jingmei.db` 时不动旧文件 |
| `router.test.ts` | 路由优先级（提及 > 回复 > 名字）、按消息所在平台匹配账号、名字/别名只在角色作用域内生效、bot 消息不触发、HMAC 抽样稳定；搜索预取与语音请求的识别；只有平台限定的角色管理员能看/压缩上下文；表情图读取失败后可以重试发送 |
| `context.test.ts` | 丢弃已完成轮次的 thinking、保留进行中工具循环的 thinking；能看图的模型收到图片块；看不了图的模型收到 `visionModel` 描述；没有 `visionModel` 时保留图片块交给 Pi 降级 |
| `quick-reactions.test.ts` | 普通消息需要强信号且按频道限频（限频期内不调用 Jev）；同频道并发决策共享一个名额；点名消息不受阈值和限频影响、由被点名角色点；bot 消息和表外表情永不点 |
| `jev.test.ts` | Jev 请求结构与答案映射、`none` → 无表情、拒绝缺失/类型错误/越界/非选项答案、HTTP/网络/超时映射为固定错误码、错误信息不含密钥和正文；System One 话题概率解析、畸形概率表忽略；相关度打分一次请求、按序返回；`shouldQuickReact` 规则；远程失败回退到本地一次并保留话题概率 |
| `memory.test.ts` | 成员档案按空间隔离；只抽取本人明确的生日与稳定陈述、更正覆盖旧值；提及/回复关系去重并排除 bot；生日设置/清除/列出、`/forget` 停止收集与重新启用；拒绝不安全事实；重放不重复计数；打分回想保留最相关项、打分失败退回时间顺序 |
| `soul.test.ts` | soul 在角色、空间、平台、频道、thread 之间隔离；关闭重开数据库后恢复；暂存去重、压缩快照之后新增的笔记不被消费；容量或数据库失败时回滚并保留暂存；字节上限、身份与内容安全检查 |
| `soul-session.test.ts` | 真实 Pi 会话中 soul 工具、压缩与重启只影响所属会话，不重载其他会话 |
| `celebrations.test.ts` | 悉尼夏令时切换下仍在当地 09:00 后发送；农历节日与两种日历的元旦合并；2027 年春节按目标当地日期发送且相邻日不发；2026、2027 年端午/中秋与闰月不重复；劳动节与 Boxing Day；2026、2027 年 NSW 复活节日期；跨 tick 和重启幂等；失败当天重试；中断的发送重启后恢复；2 月 29 日生日；生日按空间查找并经该空间的平台发送 |
| `discord-transport.test.ts` | Snowflake 保持字符串；按可读边界分段不丢字；分段发送禁用提及并校验频道；只在允许频道点表情且幂等；Unicode 与自定义表情语法；按 `retry_after` 重试且不暴露响应内容；平台 transport 按角色路由且禁止提及；Gateway 连接带 API 版本、identify、心跳与 resume |
| `discord-media.test.ts` | Discord CDN 图片有界下载并校验真实格式；真实小 PNG 转为 Pi 图片；拒绝非 CDN、非图片、声明或实际超大、HTML/畸形字节；缩放失败的超大原图被拒；视频下载同样受 CDN 与大小限制 |
| `telegram-platform.test.ts` | 归一化：@用户名和 text_mention 解析为 ID、UTF-16 偏移、论坛话题根不算回复、匿名管理员归属、非图片媒体占位、视频抽帧或 `[视频]`、照片与静态贴纸成图；适配器入口丢弃允许列表外的群（不分发、不回复、不下载）；文字命令解析、非开头命令当聊天、多角色时管理员命令要求指定；Markdown→entities（嵌套样式、代码、列表、astral emoji 的实体范围合法）、非公网链接去链接、代码块语言清洗；表情白名单、实体被拒退回纯文本一次且不 @、超长回复分条且只有第一条回复原消息 |
| `video-frames.test.ts` | 按时长选择的代表帧 seek 位置（含 1 秒与 3 秒边界）；只探测一次、最多抽三帧并清理临时文件；缺 ffmpeg 返回固定结果而不抛错 |
| `reaction-assets.test.ts` | 表情图只能选内置的 4 张 PNG；拒绝编造 ID、路径穿越和调用方给的路径 |
| `runjs.test.ts` | `run_js` 基本计算与输出、超时、异步膨胀、输出上限、超长代码拒绝；宿主隔离：无 `process`、`require`、`Bun`、`fetch`，子进程环境无密钥 |
| `web-search.test.ts` | DeepSeek 服务端搜索工具、返回有界文本与公网来源 URL；空或超长查询不发请求；HTTP 错误分类不回显密钥；响应大小上限与超时分类 |
| `fish-tts.test.ts` | Fish Audio 请求与 MP3 返回；无效输入不发请求；不暴露 provider 错误正文；拒绝 JSON 响应与超大音频；中止映射为超时 |

`test/network-guard.ts` 是预加载文件，不是测试。

## 写测试的规则

- 新行为鼓励先写失败的测试。功能稳定后删掉脚手架测试，只留守护长期行为与安全边界的测试。
- 能确定性复现的 bug 修复必须带回归测试。
- 测可观察的行为与结果，不断言 prompt 字符串或实现细节。
- `bun test` 默认 UTC；涉及时区的测试显式指定时区（参考 `celebrations.test.ts`）。
- 不为通过测试而削弱断言、类型检查或安全控制（如 run_js 沙箱）。

## 失败诊断

改代码前先定位失败来源：被改的行为、环境或工具链（Bun 版本、时区）、外部依赖、与本次改动无关的既有失败。外部和既有失败单独报告，不混入本次结论。
