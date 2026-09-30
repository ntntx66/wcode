# wcode 设计文档

> 状态：M0–M3 代码已实现；自动化、真实 agent 图片和安装验证见验证记录 · 2026-09-30
> 已定：TypeScript；默认 yolo（agent 不向微信请求审批）
> 研究依据、真实 CLI 样本和验证边界见 [verification.md](verification.md)。下文保留原设计基线，M2/M3 实施细化见 §14。
> M3 按本次确认交付可安装的 `.tgz`，暂不公开发布 npm；注册表已有其他项目使用 `wcode` 名称。
> 微信的长时 token 有效性、限频阈值和真实消息长度上限仍待专项实测。

## 1. 目标

在微信里给本机的 coding agent（pi、Claude Code、Codex）派活：发一句话，agent 在指定目录执行，结果回到微信。

用它替代 OpenClaw + ACP。只保留微信协议这一层，其余部分用最少的代码自己实现。

## 2. 第一性原理

### 2.1 本质需求

去掉实现细节，这件事只有四个动作：

1. 收：拿到我在微信里发的消息
2. 跑：让选定的 agent 在选定的目录执行，并接着上一轮的上下文
3. 回：把结果送回微信
4. 控：能停止，能切换 agent 和目录，能看状态

不服务于这四点的东西都不进 v1。

### 2.2 事实约束与设计推论

| 事实 | 推论 |
|---|---|
| iLink 只支持私聊，实际只有扫码者本人能用 | 单用户。全局只有一份聊天状态，不需要绑定码、多租户、路由 |
| 微信消息发出后不能编辑 | 不做流式输出。只发最终结果，运行中显示"对方正在输入" |
| 默认 yolo，不需要把审批转回微信 | wcode 和 agent 之间不需要双向交互，所以每轮起一个子进程、读完输出即可。不需要常驻进程，也不需要 SDK 或 ACP |
| 三个 agent 都自带会话持久化和 resume | wcode 只存会话 ID，不存对话内容 |
| 回复有频率和长度限制（来自社区报告） | 少发、短发；超长的分页；发送失败先存起来，下次补发 |
| 会执行代码的消息，重复执行比丢失更危险 | 入站消息"至多一次"：先存游标，再处理 |

### 2.3 最关键的简化

"yolo + 每轮一个子进程"让接入一个 agent 从"实现一套协议客户端"变成"拼一行命令，再逐行解析 JSONL"：

- 每个 agent 的接入代码约 40 行，只有参数构造和输出解析
- 停止任务就是杀掉进程组
- 进程之间天然隔离，不存在内存泄漏，也不需要空闲回收逻辑
- 会话恢复交给 agent 自己的 resume 参数

代价是每轮多 1～3 秒的进程启动开销。相对 agent 动辄几分钟的执行时间，可以忽略。

## 3. 不做什么

| 不做 | 原因 |
|---|---|
| OpenClaw、ACP、各 agent 的 ACP 适配包 | 每轮一个子进程就够，不需要协议中间层 |
| 审批转发 | 默认 yolo；以后需要再加（见 §12） |
| 流式输出、进度播报 | 微信不能编辑消息，频率也受限 |
| 多用户、绑定码、群聊 | 协议只支持 owner 私聊 |
| 数据库 | 状态只有几个字段，JSON 文件足够 |
| Web UI、插件系统 | 配置文件加聊天命令足够 |
| 官方插件中的 markdown 过滤状态机、引用 SQLite、多账号、routeTag、typing ticket 缓存 | ZCode 不用这些也能正常工作 |
| 本地开发构建步骤 | Node ≥ 22.18 可以直接运行 .ts；M3 的安装包另用 tsc 生成 JavaScript |

## 4. 总体架构

```
 微信（手机）── ClawBot
        │
        ▼
 iLink HTTP API（ilinkai.weixin.qq.com）
        ▲  getupdates 长轮询 / sendmessage / sendtyping
        │
┌───────┴────────────── wcode（单个 Node 进程）──────────────┐
│ wechat/   登录 · 长轮询 · 发送                              │
│ bot       过滤 → 命令或排队 → 执行一轮 → 分段回复           │
│ agents/   run()：spawn 子进程，stdin 写入 prompt，逐行解析  │
│ store     ~/.wcode/*.json                                   │
└──────────┬──────────────────┬──────────────────┬────────────┘
           ▼                  ▼                  ▼
      claude -p          codex exec         pi --mode json
   （每轮一个进程，cwd 为当前项目，会话由 agent 自己持久化）
```

不开任何入站端口，没有常驻的 agent 进程。运行时依赖只有 `qrcode-terminal`。

## 5. 微信通道（iLink）

参考实现是官方 `@tencent-weixin/openclaw-weixin` 2.4.9 的源码（MIT 许可），以及 ZCode 3.14.4 内嵌的实现。wcode 只用下面这些接口：

| 用途 | 接口 | 要点 |
|---|---|---|
| 取二维码 | `ilink/bot/get_bot_qrcode?bot_type=3` | 返回 `qrcode` 和 `qrcode_img_content`，在终端渲染。ZCode 用不带参数的 GET，官方用 POST 并附上本地旧 token；M0 选最简单能用的形式 |
| 轮询扫码状态 | `GET ilink/bot/get_qrcode_status?qrcode=` | 状态有 `wait`、`scaned`、`need_verifycode`、`expired`、`scaned_but_redirect`、`confirmed`。成功时返回 `bot_token`、`ilink_bot_id`、`ilink_user_id`、`baseurl` |
| 收消息 | `POST ilink/bot/getupdates {get_updates_buf}` | 服务端挂起的长轮询，返回 `msgs` 和新游标 |
| 发消息 | `POST ilink/bot/sendmessage {msg}` | 必须带 `to_user_id`，以及该用户最近一条入站消息里的 `context_token`；`item_list` 只放一个文本项 |
| 正在输入 | `POST getconfig` 取 `typing_ticket`，再 `POST sendtyping {status}` | 每 5 秒续发一次 `status: 1`，结束时发 `status: 2` |

公共请求头：

- `AuthorizationType: ilink_bot_token`
- `Authorization: Bearer <token>`
- `X-WECHAT-UIN`：每次请求一个随机 uint32，做 base64
- `iLink-App-Id: bot`
- `iLink-App-ClientVersion`

POST 请求体带 `base_info {channel_version, bot_agent: "wcode/<版本>"}`。

处理规则：

- 只处理 `message_type == 1` 且 `from_user_id == ownerId` 的消息。其余丢弃，只记日志。
- 消息文本由三部分拼成：
  - `text_item.text`
  - `voice_item.text`，即服务端的语音转写，所以语音输入不用额外开发
  - 引用消息里的文本（如果有），放在最前面
- 游标：收到一批消息后立即写盘，然后才处理，保证至多一次。
- 错误处理：
  - `errcode -14` 表示 token 失效：停止轮询，日志提示重新执行 `wcode login`
  - 其他错误：从 2 秒开始指数退避，最多 30 秒
- 单实例锁：同一个 bot 只能有一个进程在轮询，否则游标会互相覆盖。

## 6. Agent 接入

### 6.1 接口

```ts
// agent = 命令行参数构造 + 输出逐行解析
export interface AgentSpec {
  name: string;                        // "claude" | "codex" | "pi"
  command: string;                     // 可在配置里改成绝对路径
  args(o: { sessionId?: string; model?: string }): string[];
  parseLine(obj: unknown): AgentEvent[];
}

export type AgentEvent =
  | { type: "session"; id: string }                  // 拿到就持久化，任务被中断也能续
  | { type: "tool"; name: string; detail?: string }  // 只给 /status 用
  | { type: "text"; text: string }                   // 助手文本，最后一段作为回复
  | { type: "error"; message: string };
```

通用执行器 `run(spec, { prompt, cwd, sessionId, model, signal })` 的步骤：

1. 用 `spawn(command, args, { cwd, detached: true })` 启动，参数是数组，不经过 shell。
2. prompt 写入 stdin 后关闭。这样以 `-` 开头的消息不会被当成参数，也没有长度限制。
3. 按行读 stdout，每行 `JSON.parse` 后交给 `parseLine`；不是 JSON 的行直接忽略。
4. 停止时向整个进程组发 SIGINT，5 秒后补发 SIGKILL，agent 启动的 shell 命令会一起结束。
5. 如果退出码非 0 且没有产出任何 text，就用 stderr 的最后 20 行生成 error。

### 6.2 三个 agent

命令行参数已对照本机 `--help` 核实（claude 2.1.283、codex 0.157.1、pi 0.84.2）。事件字段已用真实输出逐一核实，样本保存于 `test/fixtures/`。

| | Claude Code | Codex | pi |
|---|---|---|---|
| 新会话 | `claude -p --output-format stream-json --verbose` | `codex exec --json --skip-git-repo-check -` | `pi --mode json --session-id <uuid>` |
| 续会话 | 加 `--resume <id>` | `codex exec resume --json --skip-git-repo-check <id> -` | 与新会话相同，传同一个 uuid |
| yolo | `--dangerously-skip-permissions` | `--dangerously-bypass-approvals-and-sandbox` | 不需要，pi 没有权限系统 |
| 指定模型 | `--model` | `-m` | `--model` |
| 会话 ID 来源 | `system/init` 事件的 `session_id` | `thread.started` 事件的 `thread_id` | wcode 生成 uuid 传入 |
| 工具活动 | assistant 消息里的 `tool_use` | `item.started`（`command_execution` 等） | `tool_execution_start` |
| 最终文本 | `result` 事件的 `result` | 最后一个 `agent_message` item | 最后一条 assistant `message_end` 里的文本块 |

每个 agent 都可以在配置里追加 `extraArgs`，例如给 pi 加 `-a` 以信任项目本地配置。注意 `codex exec resume` 不接受 `--sandbox`、`-C` 这类参数（已对照本机 `--help`），Codex 的配置覆盖统一用 `-c key=value`；工作目录一律通过子进程的 cwd 传递。

每个会话的第一轮，会在 prompt 前加一句固定说明："你的回复会发到微信，请简洁，先给结论，避免大段代码。" 从源头控制长度，比事后截断有效。可以在配置里关掉。

## 7. 会话与命令

### 7.1 状态

单用户，所以全局只有一份状态：

```jsonc
// ~/.wcode/state.json
{
  "cursor": "…",                // get_updates_buf
  "contextToken": "…",          // 最近一条入站消息的 context_token
  "agent": "claude",
  "cwd": "/Volumes/Files/code/projects/wcode",
  "models": { "claude": "sonnet" },   // 没设置的 agent 用它自己的默认模型
  "sessions": { "claude:/Volumes/Files/code/projects/wcode": "3f2a…" },
  "outbox": []                  // 发送失败、等待补发的消息
}
```

会话按"agent + 目录"记忆。切回某个项目会自动接上次的会话；`/new` 只清掉当前这一组。

### 7.2 一条消息的处理流程

```
收到消息
 ├─ 更新 contextToken；outbox 非空就先补发
 ├─ 第一个词是已知命令 → 执行命令并立即回复（任务运行中也可以用）
 ├─ 有任务正在运行 → 放进队列，回复"已排队"
 └─ 否则开始一轮：
      开始 sendtyping 心跳
      run(agent)：session 事件写盘；tool 事件记下来给 /status；text 只保留最后一段
      结束：取消 typing → 分段发送 → 队列不为空就把排队消息合并成一条 prompt，开始下一轮
```

只有第一个词恰好等于某个命令名时才当作命令。所以 `/Users/me/a.ts 这里有 bug` 会原样交给 agent。

### 7.3 命令

| 命令 | 中文别名 | 作用 |
|---|---|---|
| `/help` | `/帮助` | 显示命令列表 |
| `/status` | `/状态` | 查看 agent、模型、目录、会话、运行时长、最近调用的工具、排队条数 |
| `/stop` | `/停止` | 停止当前任务，清空队列 |
| `/new` | `/新建` | 为当前 agent + 目录开一个新会话 |
| `/agent [名称\|序号]` | | 不带参数时列出所有 agent，带参数时切换 |
| `/cd [别名\|序号\|路径]` | | 不带参数时列出配置里的项目；也接受绝对路径或 `~/…` |
| `/model [名称\|default]` | | 设置当前 agent 的模型 |
| `/more` | `/更多` | 发送超长回复的下一页 |
| `/send 路径` | `/发送 路径` | 回传本机普通文件，接受相对当前项目、绝对路径与 `~/…` |

选择一律通过命令参数完成（如 `/agent 2`），不做"回复数字进行选择"这种需要记住上下文的交互。任务运行中执行 `/agent`、`/cd`、`/model`、`/new`，会提示先 `/stop`。

## 8. 回复策略

- 文本基本原样发送，只去掉 markdown 的图片语法。换行等显示细节等 M0 实测后再定。
- 分段：优先按段落切，其次按行，最后硬切。每段不超过 2000 字；有多段时，在每段加上 `（1/4）` 这样的序号。
- 一次最多发 3 段。其余的存为"下一页"，最后一段末尾提示 `还有 N 段，发送 /more`。开始新的一轮时，未发的下一页清空。
- 发送失败（被限频或 token 过期）时，退避重试 3 次。仍然失败就放进 outbox，下次收到任何消息、拿到新的 contextToken 时先补发。
- 出错时回复 `❌ <agent>：<错误摘要>`，摘要最长 500 字。

2000 字和 3 段是保守的初始值，M0 测出真实限制后再调整。

## 9. 配置、数据文件与 CLI

```
~/.wcode/
  config.json   可选，手动编辑
  auth.json     权限 0600，存 token、baseUrl、botId、ownerId
  state.json    内容见 §7.1
  wcode.lock    单实例锁，记录 pid
```

```jsonc
// ~/.wcode/config.json（每一项都可以省略）
{
  "defaultAgent": "claude",
  "projects": { "wcode": "/Volumes/Files/code/projects/wcode" },
  "agents": {
    "claude": { "command": "claude", "extraArgs": [] },
    "codex":  { "command": "codex",  "extraArgs": [] },
    "pi":     { "command": "pi",     "extraArgs": [] }
  },
  "turnTimeoutMinutes": 60,
  "mobilePreamble": true
}
```

auth.json 和 state.json 的写入都用"写临时文件，再 rename"的方式，保证原子性。

```
wcode login    在终端扫码登录，写入 auth.json
wcode start    前台运行
wcode service install|status|uninstall    macOS 用户 launchd 服务
```

## 10. 安全（yolo 前提下）

信任边界只有一条：谁能给这个 bot 发消息，谁就能以你的身份在这台电脑上执行任意命令。

已有的措施：

- 只处理 ownerId（扫码者本人）的消息
- auth.json 权限设为 0600，不开任何端口
- 子进程用参数数组启动，不经过 shell；prompt 通过 stdin 传入
- `/stop` 会杀掉整个进程组；单轮超过时限（默认 60 分钟）会自动停止

仍然存在的风险，需要你知晓：

- 微信账号被盗，等于这台电脑被远程控制。
- agent 读到的外部内容（网页、依赖包、issue）可能带有提示词注入，yolo 模式下会被直接执行。
- 文件可能被误删或误改。建议工作目录都放在 git 里。以后如需更强隔离，可以按 agent 关闭 yolo 参数、改用它自带的沙箱，这属于 §12 之后的范围。

合规方面：iLink 客户端代码移植自 MIT 许可的官方插件，会保留原版权声明。服务本身受《微信 ClawBot 功能使用条款》约束，目前还在灰度阶段，腾讯可能随时调整。

## 11. 代码结构与规模

```
wcode/
  package.json            "type": "module"，bin 指向 src/cli.ts
  tsconfig.json           noEmit、erasableSyntaxOnly、allowImportingTsExtensions
  src/
    cli.ts                login / start                          ~40
    config.ts             读取配置，补默认值                       ~50
    store.ts              JSON 原子读写、单实例锁                   ~50
    wechat/ilink.ts       请求封装和 4 个 bot 接口                  ~150
    wechat/login.ts       扫码登录                                 ~100
    wechat/inbound.ts     入站消息转成 { text, contextToken }       ~50
    agents/types.ts       接口定义                                 ~20
    agents/run.ts         通用子进程执行器                          ~80
    agents/claude.ts      参数和解析                                ~40
    agents/codex.ts       参数和解析                                ~40
    agents/pi.ts          参数和解析                                ~40
    bot.ts                调度：过滤、命令、排队、执行一轮           ~180
    commands.ts           8 个命令                                 ~150
    reply.ts              分段、发送、outbox、/more                 ~90
  test/
    fixtures/             三个 agent 的真实 JSONL 输出样本
    *.test.ts             用 node:test 编写
```

不含测试，合计约 1100 行。这个数字也作为上限：超出了，就说明设计在变复杂，需要回头审视。

依赖：

- 运行时：`qrcode-terminal`，锁定精确版本
- 开发时：`typescript`、`@types/node`
- 测试用内置的 `node:test`，类型检查用 `tsc --noEmit`

## 12. 里程碑

| 阶段 | 内容 | 完成标准 |
|---|---|---|
| M0 协议验证（约半天） | 登录，加一个回声 bot | 回答 §13 列出的 5 个问题 |
| M1 MVP | 三个 agent、8 个命令、分段和补发、typing、语音转写、状态持久化、解析器单测 | 在手机上走通：切到某个项目，让 Claude 跑测试并修复；切到 Codex 继续；`/stop` 能杀掉正在跑的测试；重启 wcode 后会话能接上 |
| M2 媒体输入 | 图片和文件：CDN 下载后做 AES-128-ECB 解密，存到 `~/.wcode/media/`，把路径写进 prompt（Codex 用 `-i`，pi 用 `@path`） | 发一张截图，agent 能分析 |
| M3 收尾 | 文件回传（`getuploadurl` 加密上传）；通过配置定义的纯文本 CLI agent；launchd；tsc 构建和 npm 打包（本次按用户确认暂不公开发布） | 可以用 `npm i -g /path/wcode-0.2.0.tgz` 安装 |

不在当前范围、以后按需再加：

- 审批转发：把 agent 切换为常驻交互模式，包括 Claude Agent SDK 的 `canUseTool`、`codex app-server`、pi RPC 加 extension UI；bot 增加"等待审批回复"状态。
- 进度播报。
- 为原生支持 ACP 的 agent 做一个 ACP 适配器。

## 13. 依据与待验证

已核实的部分：

- iLink 协议：来自官方插件 2.4.9 的源码和 ZCode 3.14.4 的实现
- 三个 agent 的命令行参数：来自本机 `--help`
- Node 直接运行 .ts：已在本机 v26 验证

下面 5 个问题需要在 M0 实测。前三个目前只有社区 issue 的说法，而且互相矛盾：

1. context_token 的有效期：agent 跑了 10～30 分钟后，结果还能直接发出去吗？如果不能，outbox 补发就成了主要路径，/help 里要告诉用户"发任意消息来取结果"。
2. 频率限制的真实阈值。有说法是 8 分钟内约 4 条。
3. 单条消息的长度上限，以及是按字符还是按字节计算。
4. markdown 在微信里的显示效果，以及换行是否需要转成 `\r\n`（ZCode 做了这个转换）。
5. prompt 通过 stdin 传入时，三个 agent 是否都能正常工作，尤其是 pi 的 `--mode json`。

另外，本机的 OpenClaw 已经登录了同一个微信 bot。运行 wcode 前需要先停掉 OpenClaw gateway，否则两边会争抢同一个消息游标。

## 14. M2/M3 实施细化

### 媒体输入

- 图片项 `type:2/image_item`、文件项 `type:4/file_item`；owner 过滤完成后才下载，引用项若携带媒体信息也提取。游标仍先落盘，不改变至多一次执行语义。
- 优先 `media.full_url`，否则拼接官方 `https://novac2c.cdn.weixin.qq.com/c2c/download?encrypted_query_param=…`。仅允许微信 HTTPS 域名，拒绝重定向，不向 CDN 附带 bot Authorization。
- AES-128-ECB 使用 PKCS#7 填充。图片优先使用 `image_item.aeskey` 的 32 位 hex；`media.aes_key` 兼容 base64(raw16) 和 base64(hex32)。没有密钥的图片按明文处理；文件必须有密钥。有长度、MD5 时校验。
- 流式读取响应并检查长度，单件上限 100 MiB、每轮最多 10 件、下载超时 120 秒。文件名去除路径与控制字符、限制 UTF-8 字节长度，随机前缀防覆盖，0600 落盘到 `media/inbound/`。
- 下载属于可取消的当前任务；超时和 `/stop` 同时取消下载与 agent，不阻塞接收其他命令。附件失败则整轮报错，不让 agent 对缺失文件猜测。
- 图片检测 PNG/JPEG/GIF/WebP 魔数。Claude 从 prompt 路径读取；Codex 新会话与 resume 都传 `-i`；pi 传 `@path`。其他文件只传路径。模型必须具备视觉能力，参数传入成功不等于模型识别正确。

### 文件回传

- 用户用 `/send 路径`，或让 agent 最终输出独立一行 `WCODE_FILE: /绝对路径`。仅解析代码块外的明确标记；每轮最多 3 件。
- 上传前将普通文件复制为 `media/outbound/` 快照，记录文件名、长度、SHA-256，先持久化 outbox。重试时不会读取后来改变的源文件。
- `getuploadurl` 传 `media_type:3`、`rawsize`、明文 MD5、PKCS#7 后密文长度、随机 `filekey` 和 hex AES key、`no_need_thumb:true`。优先 `upload_full_url`，否则使用 `upload_param` 拼 CDN URL。
- CDN POST 发送 AES 密文，读取 `x-encrypted-param`。在 state 中保存已上传的媒体引用，再发 `type:4` 消息；`len` 为明文长度字符串，`aes_key` 按官方发送格式编码为 base64(hex32)。重试复用媒体引用和 client ID。
- 沿用文本的独立发送队列与重试；网络失败保留 outbox，新 owner 消息触发补发。媒体目录暂不自动清理，避免删除仍被会话引用或待发送的文件。

### 纯文本 CLI、后台服务与包

- `agents.<name>.type: "text"` 配合 `command`、数组 `args`/`extraArgs` 定义 CLI，`{model}` 为可选模型占位符。stdin 输入 prompt，stdout 完整累积，stderr 用于错误，非零退出码失败。无自动会话恢复；共用取消、超时、队列、分页与回传。
- agent 名称扩展为配置项列表，保留前三项 claude/codex/pi 的序号；旧 state 兼容，新 state 可保存自定义 agent 与文件 outbox。自定义 agent 从配置移除后给出切换提示。
- macOS `service` 生成用户 LaunchAgent，记录绝对 Node/CLI 路径、PATH、WCODE_HOME、私有日志；按数据目录哈希隔离服务。真实加载验证用无网络临时进程，不安装真实 bot 后台服务。
- `tsconfig.build.json` 使用 TypeScript 5.9 的 `rewriteRelativeImportExtensions`，产物为 `dist/*.js`，bin 指向 `dist/cli.js`。`npm pack` 执行测试与构建，包白名单只有 dist、文档与第三方声明。数据、测试、源码和私有凭据不打包。
- 本次保留 `private:true` 并交付 `.tgz`；公开发布需要另选包名/scope、确认许可与发布权限。
