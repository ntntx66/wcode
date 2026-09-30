# wcode

在微信里给本机的 coding agent（Claude Code、Codex、pi）派活：发一句话，agent 在指定目录执行，结果回到微信。

单个 Node 进程直连微信 iLink 协议，每轮以子进程运行 agent（默认 yolo），不依赖 OpenClaw / ACP / SDK。运行时依赖仅 `qrcode-terminal`，要求 Node ≥ 22.18。

已实现 M0/M1：扫码登录、文本/语音转写、三个 agent、会话恢复、命令、队列、typing、回复分页和失败补发。设计见 [docs/design.md](docs/design.md)，实测结果和未验证项见 [docs/verification.md](docs/verification.md)。图片/文件输入、文件回传、launchd 和 npm 发布属于后续阶段。

## 本地运行

```bash
npm install
npm run login           # 微信扫码，必要时在终端输入手机上的配对数字
npm start               # 前台运行，Ctrl-C 会停止整个任务进程组
# 或 node src/cli.ts start --echo，先只验证微信文本收发
```

需要 macOS/Linux、Node ≥ 22.18，以及至少一个已安装且已登录的 `claude`、`codex` 或 `pi`。本地运行不需要构建。可选 `npm link` 创建 `wcode` 命令；暂不支持从 npm 全局安装发布包（Node 不会剥离 `node_modules` 内的 TypeScript）。

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

其他文本直接交给 agent，包括 `/Users/me/file.ts 这里有 bug`。运行时收到的普通消息会排队，下一轮合并处理；运行期间可以查询状态和停止，切换配置要先停止任务。切回某个 agent + 目录会续接它自己的上下文，不会把 Claude 的对话转给 Codex。

每条最多 2000 个 UTF-16 单元（包括序号和提示，emoji 不会被切坏），每页最多 3 段，下一轮开始时清空未发页。发送失败最多重试 3 次，然后保存在 outbox；收到带有新 context token 的 owner 消息后补发。发送重试不阻塞 `/stop` 的执行。服务端 token 失效（-14）时保存结果并退出，重新登录后发新消息补发。

入站批次先保存游标再处理：进程崩溃时可能丢掉尚未执行的消息和内存队列，不会有意重跑它们。发送采用固定 `client_id` 重试；服务端是否去重尚未实测，网络响应丢失时仍可能收到重复回复。

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

数据目录可用 `WCODE_HOME` 覆盖。`auth.json`、`state.json` 均原子写入且权限为 0600；状态包含游标、最新 context token、各 agent 的模型/会话 ID、outbox 和下一页，不保存对话历史。同一个 bot 重新登录保留会话、游标和 outbox；切换 bot/owner 会清空旧状态，避免将旧消息发给新账号。损坏的状态文件会阻止启动，需要先备份再修复，避免误重放消息。

## 验证

```bash
npm run check                  # tsc + node:test，不连接微信或模型
npm run smoke -- claude pi      # 可选：真实 CLI 新会话、工具调用、续接
```

测试包含真实 JSONL 样本、HTTP 通道到子进程的完整链路、跨进程锁、故障恢复、分页，以及忽略 SIGINT 的子孙进程被 SIGKILL 清理（包括独立进程组和父进程先退出的情况）。停止时用系统 `ps` 追踪子孙进程；已经完全脱离父子关系的守护进程不在追踪范围内。实机联调步骤见 [docs/verification.md](docs/verification.md)。

## 安全

默认 yolo：能给这个 bot 发消息的只有扫码者本人，但微信账号被盗等同于本机被远程控制，agent 读到的外部内容也可能带来提示词注入。详见设计文档 §10。

iLink 协议实现参考腾讯官方 MIT 代码，版权声明保留在 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
