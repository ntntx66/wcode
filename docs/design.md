# wcode 当前设计

本文只描述当前实现。CLI 参数、配置示例与操作步骤见 [README](../README.md)；历史决策、真实协议样本及验证边界见 [verification.md](verification.md)。

## 1. 目标与约束

在微信里给本机的 coding agent 派活：收消息，在指定目录执行，回传文字与文件，并能停止、切换和查询状态。

| 事实与需求 | 当前选择 |
|---|---|
| 仅处理扫码 owner 的私聊 | 一个 Node 进程、一份状态、串行执行 |
| 默认 yolo，无需回传审批 | 每轮一个 CLI 子进程，参数数组加 stdin，不经过 shell |
| agent 自带对话存储与恢复 | 只保存 agent + 目录对应的会话 ID |
| 微信已有消息历史 | 只保留当前或最近一轮状态，不维护任务历史、结果档案 |
| 微信消息不能编辑 | 立即转发完整用户可见文本，不发送逐字增量或生成进度摘要 |
| 执行代码不能随意重放 | 游标与普通输入同次保存；中断后提示核查，不自动重跑 |
| 文字直发与结果补发的要求不同 | 过程文字只在内存排队；最终未送达内容进入可靠 outbox |

简化以状态副本、同步点和操作步骤的数量衡量。当前不需要数据库、插件系统、Web UI、常驻 agent、ACP/SDK 或多用户路由。运行时依赖仅 `qrcode-terminal`，Node ≥ 22.18.0，平台为 macOS/Linux。

## 2. 模块边界

```text
微信 iLink → wechat/inbound → Bot → commands 或 agents/run → CLI 子进程
                             ↓              ↓ 完整文本事件
                           Store ←────── Replies → iLink 文本/文件发送
                             ↓
                           json → state.json
```

- `bot.ts`：接收批次、任务开始/结束、队列推进和中断恢复，拥有任务状态的提交边界。
- `commands.ts`：命令匹配、状态展示、配置切换；配置变更显式保存后才回复。
- `reply.ts`：分段、准备最终回复、文字直发、可靠 outbox 和分页。准备最终回复可创建文件快照，但不修改状态或发送消息。
- `agents/`：CLI 参数与 JSONL 适配器，共享子进程执行器。
- `store.ts`：状态校验、旧格式迁移、保存和单实例锁。
- `json.ts`：私有文件的 JSON 读取、临时文件写入、fsync 与原子 rename。
- `values.ts`：无 I/O 的对象和 agent 名称校验。配置与状态均直接依赖基础模块，无循环导入。
- `wechat/`、`files.ts`：登录、协议、附件下载/上传和文件快照。
- `maintenance.ts`、`logs.ts`、`service.ts`：本地诊断、媒体清理、日志轮转与 macOS launchd。

源码直接运行 TypeScript；发布时清空 `dist` 后用 tsc 编译 JavaScript，安装入口为 `dist/cli.js`。不开入站端口。

## 3. 状态与提交边界

`state.json` 保存以下内容：

| 字段 | 用途 |
|---|---|
| `cursor`、`contextToken` | 已接收的批次游标与最新回复上下文 |
| `agent`、`cwd`、`models` | 当前执行配置 |
| `sessions` | 按 agent + 规范化绝对目录保存会话 ID |
| `task` | 当前或最近一轮的状态、输入、agent、目录、开始/结束时间；中断时可含未执行输入 |
| `pendingInputs` | 已接收但尚未执行的普通输入，包括当前批次尚未分发的消息 |
| `outbox`、`pages` | 待可靠发送的文字/文件，以及 `/more` 的剩余段落 |

内存中的 `queuedCount` 只标记 `pendingInputs` 已分发入队的前缀长度，不保存第二份输入数组。其余运行时状态为控制器、运行 promise、工具活动和临时文字送达记录。

明确的提交顺序：

1. 批次过滤后，普通输入与新游标一起保存；保存失败不执行。
2. 逐条更新 owner 的 context token、处理命令或入队。命令不会自动重放。
3. 开始一轮时，从待处理输入移出本轮输入，写入 `task.running`，清空分页，同次保存后才下载附件或运行 agent。
4. 收到会话 ID 立即保存，允许中断后续接已有上下文。
5. 结束时先准备回复、核对直发送达情况并创建文件快照，再把结束状态、未送达文字、文件 outbox 和分页一次保存，之后才触发可靠发送。
6. 文件上传成功后先保存 CDN 引用再发消息；消息确认送达后移出 outbox 并保存。

不通过分页或发送方法顺带保存业务状态，不对这些提交做延迟合并。JSON 使用 0600 权限、同目录临时文件、文件 fsync 与 rename；不声称覆盖所有断电场景。损坏状态阻止启动，避免重置游标后重复执行。

## 4. 队列、停止与恢复

任务运行时，普通消息加入待处理输入并逐条回复排队数量。当前轮结束后，将已经入队的输入合并为下一轮 prompt。

`/stop` 取消当前轮并删除 `pendingInputs` 中已入队的前缀；同批中位于 `/stop` 后面的新消息继续处理。停止尚未完成时仍不能切换执行配置。全局退出则停止推进队列。

状态流转为 `running → succeeded/failed/stopped`；无法确认执行结果时为 `interrupted`。重启将运行记录和未执行输入收缩为一条中断状态，清空待执行队列，并将核查提示写入 outbox，等待 owner 消息触发发送。不会重跑旧输入。用户核查后发补充指令，沿用当前会话；新一轮替换旧状态。

旧任务列表只在读取时迁移为单条状态与未完成输入，保留游标、会话和 outbox；下次保存移除旧列表和编号。

## 5. Agent 执行

适配器提供 `args(options)` 和 `parseLine(unknown)`。统一事件只有 `session`、`tool`、`text`、`error`。事件字段以仓库中的真实 JSONL 样本为依据，不推测执行阶段。

| 行为 | Claude Code | Codex | pi |
|---|---|---|---|
| 启动 | `-p --output-format stream-json --verbose` | `exec --json --skip-git-repo-check` | `--mode json` |
| 恢复 | `--resume <id>` | `exec resume <id>` | 复用 `--session-id <uuid>` |
| 会话 ID | `system/init` | `thread.started` | 启动前生成，或 session 事件 |
| 通道规则 | `--append-system-prompt` | `-c developer_instructions=...` | `--append-system-prompt` |
| 图片 | 从 prompt 中的本地路径读取 | 新会话和恢复都用 `-i` | `@path` |
| 完整文字 | 顶层 assistant text block 与 result | `item.completed/agent_message` | assistant `message_end` |

Claude 过滤思考与子 agent 文本；Codex 的重连 `error` 不当作终态，`turn.failed` 才失败；pi 的 error/aborted 是错误。执行器去掉连续相同文字，遇到工具事件重新允许相同文字。保留最后一段作为执行返回值；显式错误和非零退出码始终失败，已有文字不能掩盖错误。

每轮通过 `spawn` 启动 detached 子进程，cwd 为当前项目，prompt 原样写入 stdin。取消时枚举并记录子孙进程，发送 SIGINT，5 秒后补发 SIGKILL，覆盖单独进程组及父进程先退出的情况；完全脱离可追踪父子关系的守护进程不在保证范围内。

微信简洁回复约定由 `mobilePreamble` 控制；文件回传规则每轮作为 system 参数传递。Codex 的 developer instructions 在创建会话时固定，修改规则后需 `/new`；恢复参数虽传递该值，CLI 不会更新旧会话规则。

自定义 `type:text` CLI 通过 stdin 接收拼有通道规则的 prompt，stdout 返回完整文字，最多 1 MiB；无自动会话恢复或原生图片参数。它与内置 agent 共用超时、取消、队列和文件回传。

## 6. 文字发送与文件

完整文字到达后立刻进入串行内存发送队列，不等待工具或结束事件。每段最多 2000 UTF-16 单元，保留段落边界和完整 emoji；只过滤 Markdown 图片语法及代码块外的独立 `WCODE_FILE` 行。每次请求最多等待 3 秒，失败不重试、不落盘；通道阻塞或已有 outbox 时跳过直发。命令回复可取消当前直发并清空排队直发；停止、超时和退出取消本轮直发。

每条直发保留段落、client ID、确认送达标记和完成 promise。任务等待最后一条直发收尾，不等待整个 outbox。成功结束后，最终文字已确认的段落不再发送，未确认段落复用原 ID 进入 outbox。文件只在成功退出后回传，文件错误另发说明，避免重复正文。

命令、自定义文本 CLI 和没有直发记录的最终回复每页最多发送 3 段，剩余内容用 `/more` 获取，新一轮清空未发页。可靠回复最多退避重试 3 次，之后阻塞发送并保留 outbox；新的 owner context token 解除阻塞。token 失效（-14）停止 bot 并保留结果。网络响应丢失时仍可能重复，服务端 client ID 去重语义尚未实测。

入站媒体先经 owner 过滤，再下载至 `media/inbound/`。只允许微信 HTTPS CDN，拒绝重定向，不携带 bot Authorization。图片兼容明文、hex AES key、base64(raw16) 与 base64(hex32)；文件必须有密钥。AES-128-ECB 使用 PKCS#7，存在长度或 MD5 时校验。单件上限 100 MiB，每轮最多 10 件，下载超时 120 秒；任何附件失败则整轮报错。支持 PNG、JPEG、GIF、WebP，图片识别能力取决于模型。

`/send 路径` 或最终回复的独立 `WCODE_FILE: /绝对路径` 可回传文件，每轮最多 3 件。发送前创建 0600 的 `media/outbound/` 快照，记录 SHA-256；重试校验快照，不重读原文件。上传使用 `getuploadurl` 和 AES 加密 CDN POST，返回媒体引用先写入 outbox，再发送 `type:4` 文件消息。图片产物也以文件附件回传。

## 7. 微信协议与登录

协议参考腾讯官方 MIT 实现，声明见 [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md)。

| 用途 | 接口与行为 |
|---|---|
| 取二维码 | POST `get_bot_qrcode?bot_type=3`，`local_token_list: []` |
| 扫码状态 | GET `get_qrcode_status`；处理等待、已扫、配对码、过期、可信跳转和确认 |
| 接收 | POST `getupdates`，带游标长轮询；普通错误 2–30 秒退避 |
| 发送 | POST `sendmessage`，带最新 context token、固定 client ID，每条一个文本或文件项 |
| typing | `getconfig` 获取 ticket，`sendtyping` 每 5 秒续发，结束发送取消 |
| 媒体上传 | `getuploadurl` 返回微信 CDN 上传地址 |

仅接受 owner 的用户私聊。语音使用服务端转写；引用文本写入 prompt，命令只从用户当前发送的文字识别。`X-WECHAT-UIN` 是随机 uint32 的十进制字符串再 base64；版本头和 `base_info` 均取自 package.json。

同一数据目录通过 PID 与随机 nonce 锁协调实例，并串行回收陈旧锁。它不能协调其他客户端或同一 bot 的其他数据目录。同 bot/owner 重新登录保留状态；身份改变清空旧状态。

## 8. 命令与配置

命令包括 `/help`、`/status`、`/stop`、`/new`、`/agent`、`/cd`、`/model`、`/more`、`/send`，中文别名与参数见 README。只有第一个词恰好匹配才作为命令，绝对路径开头的普通请求照常执行。

`/new` 只清除当前 agent + 目录的会话；切换回来可恢复各自上下文。运行期间可查询 agent/目录/模型，但带参数修改或 `/new` 需先停止。`/status` 同时显示运行活动、队列、待补发、分页和最近一轮状态；开始/结束时间按本机时区显示并附 UTC 偏移，持久化仍使用毫秒时间戳。

项目配置接受路径数组，默认别名为规范化目录的末级名称；旧的自定义别名对象仍兼容。加载后统一为有序的名称/路径列表，相同名称与路径只保留一次。`/cd 别名` 唯一匹配时切换，重名时列出完整路径及总列表中的序号，等待用户 `/cd 序号` 选择；没有额外的选择状态。数字参数优先选择总列表序号，绝对路径和 `~/…` 仍直接解析。

配置、凭据和状态默认位于 `~/.wcode/`，可用 `WCODE_HOME` 覆盖。配置省略项采用默认值。路径规范化为真实绝对目录；内置 agent 使用 `extraArgs`，自定义文本 CLI 还使用 `args` 与 `{model}` 占位符。

## 9. 本地维护与后台运行

`doctor` 只读检查运行环境、配置、目录、可执行命令、凭据字段及权限、状态、待补发快照、占用和进程/launchd 状态。它不调用模型或微信，不判断远程登录有效期。当前 agent 不可执行等错误退出码为 1，未安装的其他 agent 只提示 WARN。

`clean` 默认预览；`--apply` 使用同一实例锁，需停止 bot。只清理超过年龄阈值的普通媒体文件，不跟随符号链接。outbox 快照始终受保护；存在运行、中断或待执行输入时保护全部媒体；存在任意会话时保护全部入站附件。缺失/损坏 state 时不猜测引用，不删除已有媒体。

macOS LaunchAgent 记录绝对 Node/CLI 路径、PATH 和 WCODE_HOME，异常退出至少间隔 30 秒重启。升级 Node 或安装路径后需重装服务。日志启动时及每 30 秒检查，超过 5 MiB 复制最新尾部后截断原文件，保留 launchd 已打开的描述符；每类保留 3 份归档。Linux 使用前台或自行配置系统服务。

## 10. 信任边界

能以 owner 身份给 bot 发消息，就能让默认 yolo 的 agent 以当前本机用户执行命令。owner 过滤、参数数组、私有凭据与文件权限、取消和超时都保留。微信账号被盗、外部内容提示词注入或 agent 误操作仍可能影响本机文件，重要项目应保留版本记录。

## 11. 验证与发布流程

- 日常改动运行 `npm run check`：类型检查与本地自动化，不使用真实模型或微信。
- 修改 CLI 协议或升级 agent 后，按影响范围运行 `smoke`、`smoke:progress` 或 `smoke:media`；真实模型调用需要已有账号。四个烟测入口统一处理 SIGINT/SIGTERM，等待取消清理后退出；已取消时不会进入下一个 agent。
- launchd 相关改动可运行 `smoke:service`，只创建临时本地服务。
- 交付运行 `npm run release`：检查一次 → 清空 dist 并构建 → 打包 → 校验白名单与源码/产物一一对应 → 临时全局 prefix 安装 → 使用安装后的 JavaScript 回放三种 agent、验证 CLI 版本与状态落盘 → 输出 tgz 和 SHA-256。
- 交付产物位于 `artifacts/release/<version>/`，验证脚本在 `scripts/` 受版本管理；每次使用独立临时目录。临时安装可能从 npm 获取依赖，不安装到用户的实际全局目录，不发布 npm。
- `npm pack` 仍通过 prepack 检查并清空构建，但不包含临时安装回放步骤。最低 Node 版本可在相应运行时执行 `npm run check` 和 `npm run release`。

当前设计不承诺微信真实频率、长度、大文件阈值或 client ID 去重；这些边界及在线验证结果以 verification.md 为准。
