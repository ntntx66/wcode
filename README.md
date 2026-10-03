# wcode

在微信里给本机的 coding agent（Claude Code、Codex、pi）派活：发一句话，agent 在指定目录执行，结果回到微信。

单个 Node 进程直连微信 iLink 协议，每轮以子进程运行 agent（默认 yolo），不依赖 OpenClaw / ACP / SDK。运行时依赖仅 `qrcode-terminal`，要求 Node ≥ 22.18。

当前已实现：扫码登录、文本/语音转写/图片/文件输入、三个 agent、会话恢复、命令、队列、typing、回复分页与失败补发，以及文件回传、纯文本 CLI agent、launchd 和可全局安装的 JavaScript 包。设计见 [docs/design.md](docs/design.md)，实测结果与边界见 [docs/verification.md](docs/verification.md)。本次交付 `.tgz`，不公开发布 npm（注册表上的同名 `wcode` 是其他项目）。

当前或最近一次执行状态集中在 `/status`，异常退出后提示中断，不自动重跑；增加 `wcode doctor` 本地诊断、日志轮转和媒体清理预览。继续使用单进程、串行执行和 JSON 状态文件，无新增运行时依赖，不维护任务历史。

0.3.0 将 Claude、Codex、pi 面向用户的完整文本直接发到微信：有中间说明就发，最终答案也直接发，无需等待工具调用，不人为限频或合并。不会额外要求 agent 写进度，也不生成摘要。只读完整文本事件，不转发思考、工具输出或逐字增量。

## 安装包

```bash
npm i -g /绝对路径/wcode-0.3.0.tgz
wcode --version
wcode login
wcode start
```

使用本项目生成的本地 `.tgz`，不要运行 `npm i -g wcode` 下载注册表上的同名项目。源码开发仍可直接运行 TypeScript；发布包的 `bin` 指向 `dist/cli.js`，不会触发 Node 对 `node_modules` 中 TypeScript 的限制。

## 本地运行

```bash
npm install
npm run login           # 微信扫码，必要时在终端输入手机上的配对数字
npm start               # 前台运行，Ctrl-C 会停止整个任务进程组
# 或 node src/cli.ts start --echo，先只验证微信文本收发
```

需要 macOS/Linux、Node ≥ 22.18，以及至少一个已安装且已登录的 `claude`、`codex`、`pi` 或配置的纯文本 CLI。本地运行不需要构建。若用 `npm link`，先执行 `npm run build`。

启动前停止使用同一个 bot 的 OpenClaw gateway。wcode 的锁只协调同一数据目录内的 wcode 进程，不能协调其他客户端。不要让同一个 bot 使用多个数据目录。

## 微信命令

| 命令 | 用途 |
|---|---|
| `/help`、`/帮助` | 命令列表 |
| `/status`、`/状态` | agent、模型、目录、会话、运行时长、工具、队列，以及当前或最近一次执行状态 |
| `/stop`、`/停止` | 停止进程组并清空队列；最多等待 5 秒强制结束 |
| `/new`、`/新建` | 只重开当前 agent + 目录的会话 |
| `/agent [名称或序号]` | 查看或切换 claude / codex / pi（1 / 2 / 3） |
| `/cd [别名或序号或路径]` | 查看或切换项目；支持绝对路径、空格和 `~/…` |
| `/model [名称或default]` | 查看或设置当前 agent 的模型 |
| `/more`、`/更多` | 发送超长回复的下一页 |
| `/send 路径`、`/发送 路径` | 回传本机文件，支持相对当前项目的路径、绝对路径与 `~/…`；空格无需引号 |

其他文本直接交给 agent，包括 `/Users/me/file.ts 这里有 bug`。运行时收到的普通消息会排队，下一轮合并处理；运行期间可以查询状态和停止，切换配置要先停止任务。切回某个 agent + 目录会续接它自己的上下文，不会把 Claude 的对话转给 Codex。

每条最多 2000 个 UTF-16 单元（包括序号和提示，emoji 不会被切坏）。三个内置 agent 的完整文本按产生顺序直接发送，超长文本自动分段，全部发送；命令回复、自定义纯文本 CLI 和未走直发的结果继续每页最多 3 段，剩余内容用 `/more` 取回，下一轮开始时清空未发页。

直发文字使用内存队列，每个请求最多等 3 秒，失败不重试、不落盘；已有可靠回复待发或通道阻塞时跳过直发。命令回复优先，`/stop`、超时和退出取消未发完的直发文字。任务正常结束时只将最终文本尚未确认送达的部分写入 outbox，复用已尝试的消息 ID；已确认送达的最终文字不会再发一次。连续重复文本事件会合并为一次，工具调用后相同文字仍可重新发送。任务结束状态和文件回传仍在进程完成后保存；进程非零退出始终报错，不把此前的说明当成成功结果。

最终结果、命令回复和文件发送失败最多重试 3 次，然后保存在 outbox；收到带有新 context token 的 owner 消息后补发。发送重试不阻塞 `/stop` 的执行。服务端 token 失效（-14）时保存结果并退出，重新登录后发新消息补发。直发内容不保存为历史，异常退出后的处理仍以 `/status` 中的中断状态为准。

入站批次将游标和普通消息一起保存，再处理命令和执行任务。排队消息仍合并为下一轮。`/status` 显示当前或最近一次执行的请求摘要、agent、目录、开始/结束时间和状态；每轮覆盖上一轮，不保存编号、历史结果或产物列表。

异常退出后，上次执行及尚未执行的消息收缩为一条“中断，待核查”状态，不自动重跑；下次 owner 消息会触发中断提示。用 `/status` 查看后，核查已有改动，再发送补充指令续接当前 agent + 目录的会话。新一轮会替换中断记录，未执行的旧消息不会自动加入新请求。原始请求和已送达结果可从微信聊天记录查看；文件需要再次发送时使用 `/send`。

发送采用固定 `client_id` 重试；服务端是否去重尚未实测，网络响应丢失时仍可能收到重复回复。

## 图片、文件与回传

在微信发送图片或文件即可；图片没有附言时，默认要求 agent 分析附件。引用消息携带原始媒体信息时也能读取引用附件。文件下载到 `~/.wcode/media/inbound/`，路径写入 prompt；Claude 使用读取文件工具，Codex 通过 `-i`、pi 通过 `@path` 接收图片。文件本身通过路径让 agent 读取，避免把二进制或大文本塞入参数。

支持 PNG、JPEG、GIF、WebP；每个文件上限为 100 MiB，每轮最多 10 个附件。这些是客户端限制，不代表微信实际允许的上限。图片识别要求当前模型支持视觉：本机 pi 默认的 `glm-5.3` 虽声明支持图片，实测出现误识别；换用已配置的视觉模型通过。可在微信用 `/model 模型名` 切换。

需要 agent 发回产物时直接告诉它“生成文件并发给我”。wcode 每轮通过 system prompt 要求 agent 在最终回复独立一行写 `WCODE_FILE: /绝对路径`（Claude、pi 用 `--append-system-prompt`，Codex 用 `developer_instructions` 且仅在新会话写入，自定义 CLI 拼在 stdin 开头），最多回传 3 个文件；也可以自己用 `/send`。只解析代码块之外的独立标记，不会自动上传普通 Markdown 链接。回传按普通文件附件发送，图片文件也可用此方式回传。

发送前复制到 `media/outbound/`，校验 SHA-256，上传成功后持久化 CDN 引用，再发送消息。发送重试与重启补发复用快照和 client ID；源文件之后被修改不会改变待补发内容。入站文件和快照均为 0600。媒体不自动删除；使用下方的清理预览管理磁盘空间。

## 配置与数据

可选 `~/.wcode/config.json`：

```json
{
  "defaultAgent": "claude",
  "projects": { "wcode": "/absolute/path/to/wcode" },
  "agents": {
    "claude": { "command": "claude", "extraArgs": [] },
    "codex": { "command": "codex", "extraArgs": [] },
    "pi": { "command": "pi", "extraArgs": ["-a"] }
  },
  "turnTimeoutMinutes": 60,
  "mobilePreamble": true
}
```

每一项都可省略；默认目录为第一个配置项目，否则为启动时目录。`pi -a` 表示信任项目本地配置，可按需要移除。Codex 的新会话与 resume 共用 `extraArgs`，请使用双方支持的参数；配置覆盖用 `-c key=value`，不要添加 resume 不支持的 `--sandbox`、`-C`。

纯文本 CLI 可加到 `agents`，自动出现在 `/agent` 列表中，例如：

```json
{
  "agents": {
    "local": {
      "type": "text",
      "command": "/absolute/path/to/my-cli",
      "args": ["--non-interactive", "--model", "{model}"],
      "extraArgs": []
    }
  }
}
```

命令须从 stdin 读取 prompt，将最终文本写到 stdout，诊断写到 stderr；不经过 shell。`{model}` 替换为 `/model` 设置的值，未设置为空字符串，可按 CLI 的默认模型行为省略该参数对。非零退出码视为失败，文本输出最多 1 MiB。自定义 CLI 每轮独立运行，不提供会话恢复或原生图片参数；附件路径仍写入 prompt。内置 agent 只用 `extraArgs` 扩展参数。

数据目录可用 `WCODE_HOME` 覆盖。`auth.json`、`state.json` 均原子写入且权限为 0600；状态包含游标、最新 context token、各 agent 的模型/会话 ID、一条执行状态、未完成输入、outbox 和下一页，不复制 agent 的完整对话历史。旧任务列表迁移为单条状态与未完成输入，下一次保存去掉历史和编号，不重置游标、会话或 outbox。同一个 bot 重新登录保留状态；切换 bot/owner 会清空旧状态，避免将旧消息发给新账号。损坏的状态文件会阻止启动，需要先备份再修复，避免误重放消息。

## 诊断与维护

```bash
wcode doctor                  # 本地只读诊断，不连接微信或模型
wcode clean                   # 预览超过 30 天的可清理媒体
wcode clean --days 7           # 修改年龄阈值，仍只预览
wcode clean --days 7 --apply   # 停止 wcode 后实际清理
```

`doctor` 检查 Node/平台、配置、项目目录、PATH 中的 agent 命令、登录凭据字段和文件权限、状态、待补发快照校验、媒体/日志占用、进程锁和 macOS 后台服务。当前 agent 不可执行等错误返回退出码 1；未安装的其他 agent 只提示 WARN。它不启动 agent，不判断登录凭据的服务端有效期，也不验证模型能力。

`clean` 默认仅列出候选路径和可释放空间；`--apply` 使用同一进程锁，拒绝与 bot 同时运行。仅处理 `media/inbound/` 和 `media/outbound/` 的普通文件，不跟随符号链接，不修改会话、执行状态或 outbox。outbox 文件受保护；存在待执行输入、运行或中断状态时保护全部媒体。由于会话历史由 agent 管理，只要有任何保存的会话，全部入站附件都受保护。`/new` 只清除当前 agent + 目录的会话。缺少或损坏 state 时，已有媒体不会被猜测性删除。

## macOS 后台运行

先停止前台 wcode，再执行：

```bash
wcode service install
wcode service status
wcode service uninstall
```

安装当前用户的 LaunchAgent，登录系统后启动，异常退出后间隔至少 30 秒重启。plist 以数据目录哈希命名，位于 `~/Library/LaunchAgents/io.wcode.bot.*.plist`；卸载只移除该服务，不删除登录和聊天数据。日志在 `~/.wcode/logs/`：启动时及每 30 秒检查 `stdout.log` / `stderr.log`，超过 5 MiB 后保留最新 5 MiB 为归档并清空当前文件，每个日志保留 3 份归档，权限为 0600。当前文件在两次检查间可暂时超过阈值。

服务记录安装时 Node 的真实绝对路径、CLI 入口、PATH 和 WCODE_HOME，不复制其他 shell 环境变量。agent 应有自己的登录配置；依赖其他环境变量的 CLI 需在 launchd 环境配置。升级 Node、更换包安装目录或 PATH 后，卸载并重新安装服务。Linux 使用前台进程、tmux 或自建系统服务。

## 验证

```bash
npm run check                  # tsc + node:test，不连接微信或模型
npm run smoke -- claude pi      # 可选：真实 CLI 新会话、工具调用、续接
npm run smoke:progress -- claude codex pi # 真实 CLI → 本地 HTTP 收件端；验证文字直发和续接，不连接微信
npm run smoke:media -- claude codex pi  # 可选：真实图片新会话与续接，实际调用模型
npm run smoke:service           # macOS 临时 launchd 进程验证，不连接微信
npm run release                # 检查、干净构建、打包、临时安装与回放验证，输出 tgz + SHA-256
npm pack                       # 仅检查、干净构建与打包
```

发布产物位于 `artifacts/release/<version>/`。`release` 每个阶段只执行一次，校验包内白名单和编译产物与源码对应关系，再在独立临时目录安装并验证；可能从 npm 获取依赖，不发布 npm，也不修改实际全局安装。单独验证安装版可运行 `node scripts/verify-installed.ts /安装目录/lib/node_modules/wcode`。

四个烟测脚本统一处理 Ctrl-C/SIGTERM：取消执行、等待子进程或服务清理、移除临时目录后退出。协议/模型相关烟测按变更范围选择，日常检查不需要调用真实模型。

测试包含真实 JSONL 样本、HTTP 通道到子进程的完整链路、跨进程锁、故障恢复、分页，以及忽略 SIGINT 的子孙进程被 SIGKILL 清理（包括独立进程组和父进程先退出的情况）。停止时用系统 `ps` 追踪子孙进程；已经完全脱离父子关系的守护进程不在追踪范围内。实机联调步骤见 [docs/verification.md](docs/verification.md)。

## 安全

默认 yolo：能给这个 bot 发消息的只有扫码者本人，但微信账号被盗等同于本机被远程控制，agent 读到的外部内容也可能带来提示词注入。详见设计文档 §10。

iLink 协议实现参考腾讯官方 MIT 代码，版权声明保留在 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
