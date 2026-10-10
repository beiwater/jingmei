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
- **持久入站与过期边界**：历史与 pending 同事务，重复投递不再入队；真实 Pi 轮次中断后新核心恢复一次并删除 expired pending（历史保留）；正常、失败、暂停、抛错都删除 pending。恢复不保存图片字节、用诚实占位；超过 3 分钟只入库：明确点名也不回复、不请求 participation/quick-reaction、不观察记忆、不留 pending，之后的新触发仍把它们带入对话段；恰好 3 分钟仍新鲜。Telegram 超过 3 分钟的消息不下载媒体、保留标记。提前入库的后续 lane 消息不得污染当前 recent-lines 或门控。
- **配置与客户端**：`replyDecision` 默认 `true`，`replyThreshold` 默认 `0.7`、仅接受 `(0,1]`；远程与本地共享 directed-choice、可选 `chat_in` 和 natural noul 请求/返回校验；缺失、类型错误、越界、未知 persona 及错误映射；远程回退一次保留新接口行为。
- **发送边界**：`§E\d` 或 `[当前事件` 命中以 `leak_pattern` 扣留且不调用 Jev；自然度 < 0.5 以 `audit` 扣留，0.5 放行。审查失败时 directed/probability 以 `audit_failed` 扣留，明确点名 fail-open。无客户端仍查泄漏，关闭接话判断仍做审查。每条无泄漏的最终文字只有一次审查，明确要求语音在转换前接受同样审查；图片、表情、工具语音不受影响。
- **扣留与会话**：所有扣留分支都不发送、不补写平台历史、不增加回复数；`reply_withheld` 仅含角色、平台、原因，日志无正文。`jingmei_withheld_v1` 持久、隐藏、不触发轮次；下一轮与重载后的 provider 投影去掉标记及被扣留轮次 assistant 消息，保留入站消息、未扣留历史与正常工具循环。事件说明仅作描述、不夹带指令，写入时固化为 `turnNote`，投影对每条带它的消息都拼接。
- **对话段与检索**：只有被路由触发的角色写会话，未触发的消息只入库与索引；对话段接续/开新的三个边界各取“恰好等于仍接续、超过则开新”（5 分钟、30 条积累且不含自己、40,000 tokens）；超时、发送失败、最终错误会清掉上次回复时间，重启后仍按持久状态判断；`（相关 N 条）` 在写入时固化、之后不重算，早于种子窗口起点才计数，超过 20 显示 `20+`；种子最多带最新 4 张图。历史检索：`related_messages` 与 `search_history` 每轮合计 3 次、每次 ≤ 20 行、只查当前群/频道、排除提问消息本身；`/forget` 成员不被索引也不出现在命中或上下文行里；无 embedder 时只有关键词检索。

### 文件清单


| 文件 | 守护什么 |
|---|---|
| `network-isolation.test.ts` | 有真实凭据时仍拒绝 Discord / Telegram（含 Discord 子域名） |
| `log.test.ts` | `persona_id` 原样保留以区分多角色；token/key/prompt/content/url/path 字段仍脱敏；字符串中的 Telegram token、`sk-` key、URL、绝对路径被替换 |
| `config.test.ts` | `jingmei.config.json` 默认值与密钥解析；`replyDecision=true`、`replyThreshold=0.7` 与 `(0,1]` 校验；Jev endpoint 与本地 LLM 默认/覆盖/无鉴权、显式缺失 key 报错、events 摘要/embedding 校验与决策来源要求；reasoning 档位、`visionModel` 拆分、管理员 ID 按平台规范化、一次收集全部错误且不回显密钥、空间与每空间 `routingP` 之和、平台段落与账号的相互要求、`process.env` 覆盖 `.env`、`.env` 解析错误只报行号、DeepSeek 模型目录只生成一次且不含密钥；`kline` 默认关闭、`enabled` 须为布尔 |
| `events.test.ts` | 人类消息话题归属、人与 bot 回复直接继承且不决策、空间/频道隔离；裸媒体/低内容继承及十分钟边界、视觉描述/Unicode 正文保留决策；`new` 概率低于 0.6 选最佳旧话题、达到阈值或无概率保留新话题；两小时活跃边界与旧话题召回；3、6、12……后台 single-flight 摘要、参与度与向量刷新；messages 幂等迁移 |
| `local-jev.test.ts` | 进程内 LLM→Jev 的决策概率与答案边界、logprobs 各话题概率传递、OpenAI-compatible 请求及鉴权、DeepSeek 关闭 thinking、弃答取 argmax、缺 logprobs 视为失败、超时与中止传递、不泄露 provider 错误正文 |
| `router.test.ts` | 路由优先级（提及 > 回复 > 名字）、平台账号与角色作用域、bot 不触发、HMAC 抽样稳定；30 秒冷却与 10 分钟/30 条/3 条/多于 1 个其他作者/25% 占比门控边界；directed 绕过门控与抽样，chat-in 不绕过；搜索预取与语音请求识别；平台限定管理员的上下文权限 |
| `context.test.ts` | 已完成轮次丢弃 thinking、工具循环保留 thinking；暂停入库但不回复，恢复计数；图片输入与 `visionModel`/Pi 降级；当前事件说明写入时固化为 `turnNote`，投影对每条带它的消息都拼接；`jingmei_withheld_v1` 持久且隐藏，投影只移除被扣留轮次 assistant 与标记、保留正常历史；成员记忆不自动注入 |
| `conversation-turn.test.ts` | 真实 Pi 会话总期限释放 lane、后续消息继续；error/aborted 不发半截文字、日志不泄漏、重试成功不误报；接话单次请求、门控只省 chat-in、directed 绕过门控/无候选、阈值与失败及关闭回退；每条人类消息的 `route` 日志字段（候选、门控、决策、分数、暂停）且无正文，bot 消息不记；最终文字泄漏/自然度扣留、审查失败按路由区分、明确语音审查与无客户端泄漏检查、不入库/不计数；“正在输入”在模型运行期间按周期刷新、回复发出后停止、不超过上限；无回声平台发送入库继承话题，有回声平台不预先入库；角色本地图库按 id 发送原文件并结束本轮；`send_reply` 多部分只用一次模型调用、工具旁的文字不再发、入库行只有首条带 `reply_to` 且各条继承话题（顺序与入库内容见 `send-reply.test.ts`）；被审查扣留时一条不发，工具旁的文字也不发 |
| `conversation-turn.test.ts`（持久入站回归） | 未完成轮次重启恢复、重复 redelivery 忽略、expired pending 清理并保留历史、恢复 payload 图片字节省略；完成/失败/暂停/抛错清理；超过 3 分钟只入库（明确提及也不回、不判断/不秒回表情/不记忆）且仍进入下一段、3 分钟精确边界；后排队 bot 消息不污染 recent-lines/接话门控 |
| `bot-state.test.ts` | CLI 连接写入的暂停对 bot 连接立即可见、重复暂停保留首次时间；累计运行时长：已结束运行求和、运行中算到当前、崩溃的运行止于最后心跳；本次与累计回复数 |
| `model-select.test.ts` | CLI 连接写入的模型覆盖让运行中 bot 已打开的会话下一轮换模型；1M 窗口完整使用与报告，`/context` 报告窗口条数、对话段上限和窗口后备点；后启动的 provider 目录经一次离线刷新后可用；选择在重启后保留；找不到的模型退回配置模型且只刷新一次；清除后恢复配置模型 |
| `quick-reactions.test.ts` | 普通消息需要强信号且按频道限频（限频期内不调用 Jev）；同频道并发决策共享一个名额；明确点名与 directed 不受阈值/限频影响且由对应角色点；bot 消息和表外表情永不点 |
| `jev.test.ts` | Jev 请求与答案映射、`none` 无表情、答案边界及固定错误码、错误无密钥/正文；directed 包含全部候选与 none、选中概率 0.5 边界、可选 chat-in noul 合并单次请求、natural noul 评分；System One 话题概率与畸形表；相关度单次打分按序返回；quick-react 规则；远程失败回退一次并保留话题概率 |
| `memory.test.ts` | 成员档案按空间隔离；只抽取本人明确的生日与稳定陈述、更正覆盖旧值；提及/回复关系去重并排除 bot；生日设置/清除/列出、`/forget` 停止收集与重新启用；拒绝不安全事实；重放不重复计数；打分回想保留最相关项、打分失败退回时间顺序；工具按显示名/ID 回想，精确名字优先、忽略大小写、歧义不泄露档案，拒绝不可见/其他空间成员，保留三次上限与 opt-out |
| `soul.test.ts` | soul 在角色、空间、平台、频道、thread 之间隔离；关闭重开数据库后恢复；暂存去重、压缩快照之后新增的笔记不被消费；容量或数据库失败时回滚并保留暂存；字节上限、身份与内容安全检查 |
| `soul-session.test.ts` | 真实 Pi 会话中 soul 工具、压缩与重启只影响所属会话，不重载其他会话 |
| `message-index.test.ts` | 相关条数的距离阈值、20 条上限、时间上界、排除自身与频道隔离；无向量的消息不报条数；相关/检索命中带前后各 2 行上下文且不含自身；关键词 + 向量按时间范围合并、短词条回退 `LIKE`；无 embedder 只有关键词；opt-out 作者不被索引、`forgetAuthor` 与 `MemberMemory.onForget` 删除既有行及上下文行；短回复与被回复正文一起嵌入、短普通消息无向量；单条串行、`ensure` 按需索引、失败不抛出 |
| `history-tools.test.ts` | `related_messages` 与 `search_history` 共用每轮 3 次预算且无进行中回复时拒绝；日期按 UTC 日、ISO 时间精确解析，无效或颠倒范围不调用索引；只查工具作用域的群/频道；输出标 `★` 锚点、压平并截断正文、不超过 20 行；无结果是简短说明而非错误；检索不返回提问消息本身；索引失败成为工具错误 |
| `conversation-segment.test.ts` | 未触发的消息只入库与索引、不写会话也不调模型；新段种子为触发前最近 30 条已处理消息（一条 context 消息）；相关条数写入时计算一次、只数早于种子窗口的历史、无索引时不写；接续只追加未见消息且已写内容不变；5 分钟、30 条（不含自己）、40,000 tokens 的边界；超时轮次、重启后与旧会话（无对话段状态）的开新段判断；开新段时暂存 soul 转正并进入 system prompt；种子带早先的图片且最多 4 张；各角色按自己的状态独立轮换；`sessions` 迁移幂等且保留旧行 |
| `celebrations.test.ts` | 悉尼夏令时切换下仍在当地 09:00 后发送；农历节日与两种日历的元旦合并；2027 年春节按目标当地日期发送且相邻日不发；2026、2027 年端午/中秋与闰月不重复；劳动节与 Boxing Day；2026、2027 年 NSW 复活节日期；跨 tick 和重启幂等；失败当天重试；中断的发送重启后恢复；暂停期间不发、恢复后当天补发；2 月 29 日生日；生日按空间查找并经该空间的平台发送 |
| `discord-transport.test.ts` | Snowflake 保持字符串；按可读边界分段不丢字；分段发送禁用提及并校验频道；只在允许频道点表情且幂等；Unicode 与自定义表情语法；按 `retry_after` 重试且不暴露响应内容；平台 transport 按角色路由且禁止提及；Gateway 事件只投递允许频道及其线程的消息与交互；Gateway 连接带 API 版本、identify、心跳与 resume |
| `discord-media.test.ts` | Discord CDN 图片有界下载并校验真实格式；真实小 PNG 转为 Pi 图片；拒绝非 CDN、声明或实际超大、HTML/畸形字节；缩放失败的超大原图被拒；视频下载同样受 CDN 与大小限制 |
| `telegram-platform.test.ts` | 归一化：@用户名和 text_mention 解析为 ID、UTF-16 偏移、论坛话题根不算回复、匿名管理员归属、非图片媒体占位、视频抽帧或 `[视频]`、照片与静态贴纸成图、超过 3 分钟的消息不下载媒体只留标记；适配器入口丢弃允许列表外的群（不分发、不回复、不下载）；文字命令解析、非开头命令当聊天、多角色时管理员命令要求指定；Markdown→entities（嵌套样式、代码、列表、astral emoji 的实体范围合法）、非公网链接去链接、代码块语言清洗、`fold` 块成为只含样式实体的折叠引用且链接写出网址；表情白名单、实体被拒退回纯文本一次且不 @、超长回复分条且只有第一条回复原消息 |
| `video-frames.test.ts` | 按时长选择的代表帧 seek 位置（含 1 秒与 3 秒边界）；只探测一次、最多抽三帧并清理临时文件；缺 ffmpeg 返回固定结果而不抛错 |
| `reaction-assets.test.ts` | 未配置本地图库时只能选内置的 4 张 PNG；拒绝编造 ID、路径穿越和调用方给的路径 |
| `reaction-catalog.test.ts` | 接受旧目录名前缀与目录相对路径、绝对配置目录、JPEG content type、额外元数据；收集缺失文件、路径穿越、内置 id 重名和错误扩展名；拒绝绝对文件路径、逃逸符号链接、非法 id/配文/名称及无效 catalog/配置目录 |
| `runjs.test.ts` | `run_js` 基本计算与输出、语法错/抛错/rejected promise 都是结构化失败、超时、异步膨胀、各类超大输出（日志行、错误、结果）有界、用户打印无法伪造结果帧、超长代码拒绝；宿主隔离：无 `process`、`require`、`Bun`、`fetch`，子进程环境无密钥 |
| `runjs-sandbox.test.ts` | 启动断言：bwrap 可用时通过、缺失时抛 `RunJsSandboxError`；argv 仅只读绑定系统运行时和三个必要文件，不绑定 home、repo、data、`.env` 或配置，隔离网络 / PID 并使用新 tmpfs cwd |
| `web-search.test.ts` | DeepSeek 服务端搜索工具、返回有界文本与公网来源 URL；空或超长查询不发请求；HTTP 错误分类不回显密钥；响应大小上限与超时分类 |
| `fish-tts.test.ts` | Fish Audio 请求与 MP3 返回；无效输入不发请求；不暴露 provider 错误正文；拒绝 JSON 响应与超大音频；中止映射为超时 |
| `text-image.test.ts` | 渲染器：中文、LaTeX 公式、表格、代码块出一张固定宽度的合法 PNG，文字越长图越高；图片只从公网 URL 下载（私网、本机、本地路径、引用式写法一律不请求），最多 4 张，下载失败/非图片/网络错误只显示占位；原始 Typst、`<svg>`、`<a>`、数学里的 `#` 转义被当成文字而不执行（执行就会让编译失败）；空与超长输入不做任何工作；过高的页面报 `too_large`；`plot` 代码块画出 2D/3D 图且写错的只留说明、图例文字不会被当成 Typst 执行；`image` 代码块交给画图函数（最多 2 张），失败或未开启时只留占位。`plot.test.ts`：表达式解析（优先级、一元负号、乘方右结合、省略乘号、函数与常量、方程）与拒绝一切非白名单输入；tan 在极点断开且点都在范围内；隐函数自动找范围并等比例；坏规格给出可读原因；代码块替换、数量上限、表达式文本不进 Typst。`textImage` 配置默认关闭、阈值默认 300 与边界校验。`conversation-turn.test.ts`：超长文字被扣留一次并通过工具发图（只发一条、入库的是配文）；模型重试后仍超长则按原样发送文字；未超长与未启用时不重试 |
| `image-generation.test.ts` | Antigravity 画图请求带存储的 project、模型与宽高比，跳过 thought 图取最终 PNG/JPEG；无效凭据/提示词不发请求；429、HTTP 错误、无图、超大图与超时分类且不回显 token |
| `kline.test.ts` | K 线：交易对写法归一（`btc/usdt`→`BTCUSDT`），带参数拼接或过短的写法不发请求；只请求固定公开主机、查询参数正确、`redirect: "error"`，返回按时间升序的数值 K 线；HTTP 400 → `invalid_symbol`，5xx、网络错误、非 JSON、行数不足或字段非数字 → `fetch_failed`；渲染出 1600×1000 的合法 PNG，配文由数据生成（最新价、窗口涨跌）；涨红跌绿、平盘与极小价格仍可渲染；渲染器先取数再画图，坏交易对在请求前失败 |
| `send-reply.test.ts` | `send_reply`：图/文/语音按给定顺序发出，只有第一条回复原消息，每条按源消息入库（只有首条带回复 ID），之后同轮再发被拒；表情图以原文件和自带配文发出并入库；画图与 TTS 并行准备、全部就绪前不发任何一条；同种媒体超过 1 个在任何工作前整体拒绝；schema 限总数 1–4、只接受该角色可用的种类、表情图 id 不接受路径；任一部分准备失败（画图、渲染、读图）一条不发、错误列出部分序号与错误码、回到 idle 可重试；发送中途失败保留已发、不再发后续、以 terminate 结束；首条发送失败回到 idle；超时中止后不再发；开启长文转图时超长文字部分在任何工作前被拒；审查扣留或配文含内部标记时不准备不发送并结束本轮，纯表情图不请求自然度审查；无配文的长文图取 Markdown 首行标题入库；`kline_image` 经渲染器取图、以数据生成的配文入库且只有模型自己的文字过审查、未开启时 schema 不含该种类、间隔/条数/交易对越界被 schema 拒绝、每轮至多 1 个、取数失败一条不发并回到 idle |

`test/network-guard.ts` 是预加载文件，不是测试。`test/support/` 是共享测试夹具，同样不是测试：

- `core.ts`：`makePersona(overrides)`、`makeTransport(overrides)`——默认关闭一切可选能力 / 接受一切发送，测试只写自己要变的字段；`conversationOptions(...)` 给出内存库 + 全新 `BotState`/`MemberMemory`/`SoulStore` 的 `ConversationOptions`，需要共享库或重启时传入 `db`。
- `cleanup.ts`：`useCleanups()` 在文件顶层调用一次，注册 `afterEach` 并返回后进先出的清理栈（`push`）和随栈清理的临时目录 `tmpDir()`；`personaFile(dir)`（`core.ts`）写入真实角色 prompt 文件。
- `fish.ts`：`mockFishTts(cleanups, onRequest?)`，把 Fish Audio TTS 请求答成固定 MP3 字节，其余网络请求一律报错。
- `pi.ts`：`makeModel`、`makeRuntime`（`ModelRuntime` 的模型/鉴权桩）、`assistantMessage`、`streamOf`/`scriptedStream`（确定性 provider 流）、`IMAGE`，以及驱动真实 Pi 会话的私有接缝 `seamOf`/`onSession`。

## 写测试的规则

- 新行为鼓励先写失败的测试。功能稳定后删掉脚手架测试，只留守护长期行为与安全边界的测试。
- 能确定性复现的 bug 修复必须带回归测试。
- 测可观察的行为与结果，不断言 prompt 字符串或实现细节。
- `bun test` 默认 UTC；涉及时区的测试显式指定时区（参考 `celebrations.test.ts`）。
- 不为通过测试而削弱断言、类型检查或安全控制（如 run_js 沙箱）。

## 失败诊断

改代码前先定位失败来源：被改的行为、环境或工具链（Bun 版本、时区）、外部依赖、与本次改动无关的既有失败。外部和既有失败单独报告，不混入本次结论。
