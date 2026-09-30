# wcode

在微信里给本机的 coding agent（Claude Code、Codex、pi）派活：发一句话，agent 在指定目录执行，结果回到微信。

单个 Node 进程直连微信 iLink 协议，每轮以子进程运行 agent（默认 yolo），不依赖 OpenClaw / ACP / SDK。运行时依赖仅 `qrcode-terminal`，要求 Node ≥ 22.18。

已实现 M0–M3：扫码登录、文本/语音转写/图片/文件输入、三个 agent、会话恢复、命令、队列、typing、回复分页与失败补发，以及文件回传、纯文本 CLI agent、launchd 和可全局安装的 JavaScript 包。设计见 [docs/design.md](docs/design.md)，实测结果与边界见 [docs/verification.md](docs/verification.md)。本次交付 `.tgz`，不公开发布 npm（注册表上的同名 `wcode` 是其他项目）。

## 安装包

```bash
npm i -g /绝对路径/wcode-0.2.0.tgz
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
| `/status`、`/状态` | agent、模型、目录、会话、运行时长、工具、队列 |
| `/stop`、`/停止` | 停止进程组并清空队列；最多等待 5 秒强制结束 |
| `/new`、`/新建` | 只重开当前 agent + 目录的会话 |
| `/agent [名称或序号]` | 查看或切换 claude / codex / pi（1 / 2 / 3） |
| `/cd [别名或序号或路径]` | 查看或切换项目；支持绝对路径、空格和 `~/…` |
| `/model [名称或default]` | 查看或设置当前 agent 的模型 |
| `/more`、`/更多` | 发送超长回复的下一页 |
| `/send 路径`、`/发送 路径` | 回传本机文件，支持相对当前项目的路径、绝对路径与 `~/…`；空格无需引号 |

其他文本直接交给 agent，包括 `/Users/me/file.ts 这里有 bug`。运行时收到的普通消息会排队，下一轮合并处理；运行期间可以查询状态和停止，切换配置要先停止任务。切回某个 agent + 目录会续接它自己的上下文，不会把 Claude 的对话转给 Codex。

每条最多 2000 个 UTF-16 单元（包括序号和提示，emoji 不会被切坏），每页最多 3 段，下一轮开始时清空未发页。发送失败最多重试 3 次，然后保存在 outbox；收到带有新 context token 的 owner 消息后补发。发送重试不阻塞 `/stop` 的执行。服务端 token 失效（-14）时保存结果并退出，重新登录后发新消息补发。

入站批次先保存游标再处理：进程崩溃时可能丢掉尚未执行的消息和内存队列，不会有意重跑它们。发送采用固定 `client_id` 重试；服务端是否去重尚未实测，网络响应丢失时仍可能收到重复回复。

## 图片、文件与回传

在微信发送图片或文件即可；图片没有附言时，默认要求 agent 分析附件。引用消息携带原始媒体信息时也能读取引用附件。文件下载到 `~/.wcode/media/inbound/`，路径写入 prompt；Claude 使用读取文件工具，Codex 通过 `-i`、pi 通过 `@path` 接收图片。文件本身通过路径让 agent 读取，避免把二进制或大文本塞入参数。

支持 PNG、JPEG、GIF、WebP；每个文件上限为 100 MiB，每轮最多 10 个附件。这些是客户端限制，不代表微信实际允许的上限。图片识别要求当前模型支持视觉：本机 pi 默认的 `glm-5.3` 虽声明支持图片，实测出现误识别；换用已配置的视觉模型通过。可在微信用 `/model 模型名` 切换。

需要 agent 发回产物时直接告诉它“生成文件并发给我”。wcode 每轮通过 system prompt 要求 agent 在最终回复独立一行写 `WCODE_FILE: /绝对路径`（Claude、pi 用 `--append-system-prompt`，Codex 用 `developer_instructions` 且仅在新会话写入，自定义 CLI 拼在 stdin 开头），最多回传 3 个文件；也可以自己用 `/send`。只解析代码块之外的独立标记，不会自动上传普通 Markdown 链接。回传按普通文件附件发送，图片文件也可用此方式回传。

发送前复制到 `media/outbound/`，校验 SHA-256，上传成功后持久化 CDN 引用，再发送消息。重试与重启复用快照和 client ID；入站文件和快照均为 0600。媒体不自动过期清理，避免破坏会话引用或待补发结果；长期运行需管理磁盘空间。确认已无待补发且会话不再需要后，可手动清理对应文件。

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

数据目录可用 `WCODE_HOME` 覆盖。`auth.json`、`state.json` 均原子写入且权限为 0600；状态包含游标、最新 context token、各 agent 的模型/会话 ID、outbox 和下一页，不保存对话历史。同一个 bot 重新登录保留会话、游标和 outbox；切换 bot/owner 会清空旧状态，避免将旧消息发给新账号。损坏的状态文件会阻止启动，需要先备份再修复，避免误重放消息。

## macOS 后台运行

先停止前台 wcode，再执行：

```bash
wcode service install
wcode service status
wcode service uninstall
```

安装当前用户的 LaunchAgent，登录系统后启动，异常退出后间隔至少 30 秒重启。plist 以数据目录哈希命名，位于 `~/Library/LaunchAgents/io.wcode.bot.*.plist`；卸载只移除该服务，不删除登录和聊天数据。日志在 `~/.wcode/logs/`，暂不自动轮转。

服务记录安装时 Node 的真实绝对路径、CLI 入口、PATH 和 WCODE_HOME，不复制其他 shell 环境变量。agent 应有自己的登录配置；依赖其他环境变量的 CLI 需在 launchd 环境配置。升级 Node、更换包安装目录或 PATH 后，卸载并重新安装服务。Linux 使用前台进程、tmux 或自建系统服务。

## 验证

```bash
npm run check                  # tsc + node:test，不连接微信或模型
npm run smoke -- claude pi      # 可选：真实 CLI 新会话、工具调用、续接
npm run smoke:media -- claude codex pi  # 可选：真实图片新会话与续接，实际调用模型
npm run smoke:service           # macOS 临时 launchd 进程验证，不连接微信
npm pack                       # 检查、构建并生成 wcode-0.2.0.tgz
```

测试包含真实 JSONL 样本、HTTP 通道到子进程的完整链路、跨进程锁、故障恢复、分页，以及忽略 SIGINT 的子孙进程被 SIGKILL 清理（包括独立进程组和父进程先退出的情况）。停止时用系统 `ps` 追踪子孙进程；已经完全脱离父子关系的守护进程不在追踪范围内。实机联调步骤见 [docs/verification.md](docs/verification.md)。

## 安全

默认 yolo：能给这个 bot 发消息的只有扫码者本人，但微信账号被盗等同于本机被远程控制，agent 读到的外部内容也可能带来提示词注入。详见设计文档 §10。

iLink 协议实现参考腾讯官方 MIT 代码，版权声明保留在 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
