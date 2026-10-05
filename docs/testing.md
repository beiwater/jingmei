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

### 接话与最终文字契约

新增行为的回归测试须守护下列可观察契约，不靠断言 prompt 文案替代行为验证：

- **路由与成本**：提及 > 回复 > 名字/别名优先级、作用域与 bot 不触发不变；明确点名不调用接话决策。每条未明确点名的人类消息在启用且有客户端时只调用一次接话决策，即使未抽中或被门控；全部 scoped 角色与 `none` 都可参与 directed 判断。directed ≥ 0.5 绕过抽样/门控且秒回表情按 addressed 处理；仅抽中且未被门控的候选包含 `chat_in`，分数 ≥ `replyThreshold` 接话。失败不接话、日志只含错误类别；关闭或无客户端用 HMAC+门控。接话与 `events.assign` 并行，重复投递不产生新决策。
- **门控边界**：当前平台账号最近 30 秒任何消息冷却；最近 10 分钟最多 30 条消息，自己的消息数 ≥ 3、其他不同作者 > 1 且自己占比 ≥ 25% 才触发占比门控。覆盖时间边界、消息数量上限、其他 bot 作者、空间/频道/平台账号隔离及不同角色不合并计算。
- **持久入站与过期边界**：历史与 pending 同事务，重复投递不再入队；真实 Pi 轮次中断后新核心恢复一次并删除 expired pending（历史保留）；正常、失败、暂停、抛错都删除 pending。恢复不保存图片字节、用诚实占位；超过 2 分钟不请求 participation/quick-reaction、仍观察会话/记忆/话题，明确点名照常回复，恰好 2 分钟仍新鲜。提前入库的后续 lane 消息不得污染当前 recent-lines 或门控。
- **配置与客户端**：`replyDecision` 默认 `true`，`replyThreshold` 默认 `0.7`、仅接受 `(0,1]`；远程与本地共享 directed-choice、可选 `chat_in` 和 natural noul 请求/返回校验；缺失、类型错误、越界、未知 persona 及错误映射；远程回退一次保留新接口行为。
- **发送边界**：`§E\d` 或 `[当前事件` 命中以 `leak_pattern` 扣留且不调用 Jev；自然度 < 0.5 以 `audit` 扣留，0.5 放行。审查失败时 directed/probability 以 `audit_failed` 扣留，明确点名 fail-open。无客户端仍查泄漏，关闭接话判断仍做审查。每条无泄漏的最终文字只有一次审查，明确要求语音在转换前接受同样审查；图片、表情、工具语音不受影响。
- **扣留与会话**：所有扣留分支都不发送、不补写平台历史、不增加回复数；`reply_withheld` 仅含角色、平台、原因，日志无正文。`jingmei_withheld_v1` 持久、隐藏、不触发轮次；下一轮与重载后的 provider 投影去掉标记及被扣留轮次 assistant 消息，保留入站消息、未扣留历史与正常工具循环。事件说明仅作描述、不夹带指令，仍只投影到最新输入。

### 文件清单


| 文件 | 守护什么 |
|---|---|
| `network-isolation.test.ts` | 有真实凭据时仍拒绝 Discord / Telegram（含 Discord 子域名） |
| `log.test.ts` | `persona_id` 原样保留以区分多角色；token/key/prompt/content/url/path 字段仍脱敏；字符串中的 Telegram token、`sk-` key、URL、绝对路径被替换 |
| `config.test.ts` | `jingmei.config.json` 默认值与密钥解析；`replyDecision=true`、`replyThreshold=0.7` 与 `(0,1]` 校验；Jev endpoint 与本地 LLM 默认/覆盖/无鉴权、显式缺失 key 报错、events 摘要/embedding 校验与决策来源要求；reasoning 档位、`visionModel` 拆分、管理员 ID 按平台规范化、一次收集全部错误且不回显密钥、空间与每空间 `routingP` 之和、平台段落与账号的相互要求、`process.env` 覆盖 `.env`、`.env` 解析错误只报行号、`discord.config.json` 迁移结果可加载、DeepSeek 模型目录只生成一次且不含密钥 |
| `events.test.ts` | 人类消息话题归属、人与 bot 回复直接继承且不决策、空间/频道隔离；裸媒体/低内容继承及十分钟边界、视觉描述/Unicode 正文保留决策；`new` 概率低于 0.6 选最佳旧话题、达到阈值或无概率保留新话题；两小时活跃边界与旧话题召回；3、6、12……后台 single-flight 摘要、参与度与向量刷新；messages 幂等迁移 |
| `local-jev.test.ts` | 进程内 LLM→Jev 的决策概率与答案边界、logprobs 各话题概率传递、OpenAI-compatible 请求及鉴权、DeepSeek 关闭 thinking、弃答取 argmax、缺 logprobs 视为失败、超时与中止传递、不泄露 provider 错误正文 |
| `migration.test.ts` | 旧 `discord-agent.db` 改名并把 `discord_*` 表迁移为按空间的新表且只迁移一次；已有 `jingmei.db` 时不动旧文件 |
| `router.test.ts` | 路由优先级（提及 > 回复 > 名字）、平台账号与角色作用域、bot 不触发、HMAC 抽样稳定；30 秒冷却与 10 分钟/30 条/3 条/多于 1 个其他作者/25% 占比门控边界；directed 绕过门控与抽样，chat-in 不绕过；搜索预取与语音请求识别；平台限定管理员的上下文权限；表情图失败重试 |
| `context.test.ts` | 已完成轮次丢弃 thinking、工具循环保留 thinking；暂停入库但不回复，恢复计数；图片输入与 `visionModel`/Pi 降级；当前事件说明只在最新输入；`jingmei_withheld_v1` 持久且隐藏，投影只移除被扣留轮次 assistant 与标记、保留正常历史；成员记忆不自动注入 |
| `conversation-turn.test.ts` | 真实 Pi 会话总期限释放 lane、后续消息继续；error/aborted 不发半截文字、日志不泄漏、重试成功不误报；接话单次请求、门控只省 chat-in、directed 绕过门控/无候选、阈值与失败及关闭回退；每条人类消息的 `route` 日志字段（候选、门控、决策、分数、暂停）且无正文，bot 消息不记；最终文字泄漏/自然度扣留、审查失败按路由区分、明确语音审查与无客户端泄漏检查、不入库/不计数；“正在输入”在模型运行期间按周期刷新、回复发出后停止、不超过上限；无回声平台发送入库继承话题，有回声平台不预先入库；角色本地图库按 id 发送原文件并结束本轮 |
| `conversation-turn.test.ts`（持久入站回归） | 未完成轮次重启恢复、重复 redelivery 忽略、expired pending 清理并保留历史、恢复 payload 图片字节省略；完成/失败/暂停/抛错清理；stale 概率与 directed 候选不判断/不秒回表情、会话/记忆/话题照常、明确提及仍回复、2 分钟精确边界；后排队 bot 消息不污染 recent-lines/接话门控 |
| `bot-state.test.ts` | CLI 连接写入的暂停对 bot 连接立即可见、重复暂停保留首次时间；累计运行时长：已结束运行求和、运行中算到当前、崩溃的运行止于最后心跳；本次与累计回复数 |
| `model-select.test.ts` | CLI 连接写入的模型覆盖让运行中 bot 已打开的会话下一轮换模型；1M 窗口完整使用与报告，安静压缩阈值和窗口后备点分开报告；后启动的 provider 目录经一次离线刷新后可用；选择在重启后保留；找不到的模型退回配置模型且只刷新一次；清除后恢复配置模型 |
| `quick-reactions.test.ts` | 普通消息需要强信号且按频道限频（限频期内不调用 Jev）；同频道并发决策共享一个名额；明确点名与 directed 不受阈值/限频影响且由对应角色点；bot 消息和表外表情永不点 |
| `jev.test.ts` | Jev 请求与答案映射、`none` 无表情、答案边界及固定错误码、错误无密钥/正文；directed 包含全部候选与 none、选中概率 0.5 边界、可选 chat-in noul 合并单次请求、natural noul 评分；System One 话题概率与畸形表；相关度单次打分按序返回；quick-react 规则；远程失败回退一次并保留话题概率 |
| `memory.test.ts` | 成员档案按空间隔离；只抽取本人明确的生日与稳定陈述、更正覆盖旧值；提及/回复关系去重并排除 bot；生日设置/清除/列出、`/forget` 停止收集与重新启用；拒绝不安全事实；重放不重复计数；打分回想保留最相关项、打分失败退回时间顺序；工具按显示名/ID 回想，精确名字优先、忽略大小写、歧义不泄露档案，拒绝不可见/其他空间成员，保留三次上限与 opt-out |
| `soul.test.ts` | soul 在角色、空间、平台、频道、thread 之间隔离；关闭重开数据库后恢复；暂存去重、压缩快照之后新增的笔记不被消费；容量或数据库失败时回滚并保留暂存；字节上限、身份与内容安全检查 |
| `soul-session.test.ts` | 真实 Pi 会话中 soul 工具、压缩与重启只影响所属会话，不重载其他会话 |
| `idle-compaction.test.ts` | 注入时钟驱动真实 Pi 会话：超过 200K 后安静 10 分钟才压缩；新消息重置；阈值及以下不压缩；关闭取消；所有角色会话检查；lane 内排队后新消息使任务失效；忙碌/正在压缩跳过；暂停仍压缩且 soul 晋升；失败保留暂存并不阻止其他会话 |
| `celebrations.test.ts` | 悉尼夏令时切换下仍在当地 09:00 后发送；农历节日与两种日历的元旦合并；2027 年春节按目标当地日期发送且相邻日不发；2026、2027 年端午/中秋与闰月不重复；劳动节与 Boxing Day；2026、2027 年 NSW 复活节日期；跨 tick 和重启幂等；失败当天重试；中断的发送重启后恢复；暂停期间不发、恢复后当天补发；2 月 29 日生日；生日按空间查找并经该空间的平台发送 |
| `discord-transport.test.ts` | Snowflake 保持字符串；按可读边界分段不丢字；分段发送禁用提及并校验频道；只在允许频道点表情且幂等；Unicode 与自定义表情语法；按 `retry_after` 重试且不暴露响应内容；平台 transport 按角色路由且禁止提及；Gateway 连接带 API 版本、identify、心跳与 resume |
| `discord-media.test.ts` | Discord CDN 图片有界下载并校验真实格式；真实小 PNG 转为 Pi 图片；拒绝非 CDN、非图片、声明或实际超大、HTML/畸形字节；缩放失败的超大原图被拒；视频下载同样受 CDN 与大小限制 |
| `telegram-platform.test.ts` | 归一化：@用户名和 text_mention 解析为 ID、UTF-16 偏移、论坛话题根不算回复、匿名管理员归属、非图片媒体占位、视频抽帧或 `[视频]`、照片与静态贴纸成图；适配器入口丢弃允许列表外的群（不分发、不回复、不下载）；文字命令解析、非开头命令当聊天、多角色时管理员命令要求指定；Markdown→entities（嵌套样式、代码、列表、astral emoji 的实体范围合法）、非公网链接去链接、代码块语言清洗；表情白名单、实体被拒退回纯文本一次且不 @、超长回复分条且只有第一条回复原消息 |
| `video-frames.test.ts` | 按时长选择的代表帧 seek 位置（含 1 秒与 3 秒边界）；只探测一次、最多抽三帧并清理临时文件；缺 ffmpeg 返回固定结果而不抛错 |
| `reaction-assets.test.ts` | 未配置本地图库时只能选内置的 4 张 PNG；拒绝编造 ID、路径穿越和调用方给的路径 |
| `reaction-catalog.test.ts` | 接受旧目录名前缀与目录相对路径、绝对配置目录、JPEG content type、额外元数据；收集缺失文件、路径穿越、内置 id 重名和错误扩展名；拒绝绝对文件路径、逃逸符号链接、非法 id/配文/名称及无效 catalog/配置目录 |
| `runjs.test.ts` | `run_js` 基本计算与输出、超时、异步膨胀、输出上限、超长代码拒绝；宿主隔离：无 `process`、`require`、`Bun`、`fetch`，子进程环境无密钥 |
| `runjs-sandbox.test.ts` | bwrap 缺失 / userns 探测拒绝时选择 vm 且计算可用；成功 / 失败探测缓存与并发共享、一次性脱敏日志；argv 仅只读绑定系统运行时和三个必要文件，不绑定 home、repo、data、`.env` 或配置，隔离网络 / PID 并使用新 tmpfs cwd |
| `web-search.test.ts` | DeepSeek 服务端搜索工具、返回有界文本与公网来源 URL；空或超长查询不发请求；HTTP 错误分类不回显密钥；响应大小上限与超时分类 |
| `fish-tts.test.ts` | Fish Audio 请求与 MP3 返回；无效输入不发请求；不暴露 provider 错误正文；拒绝 JSON 响应与超大音频；中止映射为超时 |
| `image-generation.test.ts` | Antigravity 画图请求带存储的 project、模型与宽高比，跳过 thought 图取最终 PNG/JPEG；无效凭据/提示词不发请求；429、HTTP 错误、无图、超大图与超时分类且不回显 token；`generate_image` 一轮只发一张、失败后回到 idle |

`test/network-guard.ts` 是预加载文件，不是测试。

## 写测试的规则

- 新行为鼓励先写失败的测试。功能稳定后删掉脚手架测试，只留守护长期行为与安全边界的测试。
- 能确定性复现的 bug 修复必须带回归测试。
- 测可观察的行为与结果，不断言 prompt 字符串或实现细节。
- `bun test` 默认 UTC；涉及时区的测试显式指定时区（参考 `celebrations.test.ts`）。
- 不为通过测试而削弱断言、类型检查或安全控制（如 run_js 沙箱）。

## 失败诊断

改代码前先定位失败来源：被改的行为、环境或工具链（Bun 版本、时区）、外部依赖、与本次改动无关的既有失败。外部和既有失败单独报告，不混入本次结论。
