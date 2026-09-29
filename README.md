# wcode

在微信里给本机的 coding agent（Claude Code、Codex、pi）派活：发一句话，agent 在指定目录执行，结果回到微信。

单个 Node 进程直连微信 iLink 协议，每轮以子进程运行 agent（默认 yolo），不依赖 OpenClaw / ACP / SDK。运行时依赖仅 `qrcode-terminal`，要求 Node ≥ 22.18。

> 状态：设计阶段，尚未实现。完整设计见 [docs/design.md](docs/design.md)。

## 计划用法

```bash
wcode login   # 终端扫码登录微信
wcode start   # 前台运行
```

微信里直接发消息即派活；`/agent`、`/cd`、`/model`、`/stop`、`/status`、`/more` 等命令完成切换与控制（均有中文别名，`/help` 查看全部）。

## 安全

默认 yolo：能给这个 bot 发消息的只有扫码者本人，但微信账号被盗等同于本机被远程控制，agent 读到的外部内容也可能带来提示词注入。详见设计文档 §10。
