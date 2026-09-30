# 研究与验证记录

日期：2026-09-30。当前交付范围为设计的 M0/M1；M2/M3 尚未实现。

## 协议依据

- 下载并逐项核对 [`@tencent-weixin/openclaw-weixin` 2.4.9](https://www.npmjs.com/package/@tencent-weixin/openclaw-weixin/v/2.4.9) 的 `src/api/{api,types}.ts`、`src/auth/login-qr.ts`、消息收发和 monitor 源码。版权声明见仓库根目录 `THIRD_PARTY_NOTICES.md`。
- 取二维码选官方 POST：`get_bot_qrcode?bot_type=3`，`local_token_list: []`。已经获得真实二维码；扫码结果另记于下方真机记录。
- `X-WECHAT-UIN` 是随机 uint32 的**十进制字符串**再 base64，不是 4 字节整数直接 base64。`iLink-App-ClientVersion` 是 `major<<16 | minor<<8 | patch` 的十进制表示。
- `getconfig`、`sendtyping` 用 `ilink_user_id`；`sendmessage.msg` 用 `to_user_id`。补齐 `client_id`、`message_type:2`、`message_state:2`。
- 引用位于 `item_list[].ref_msg.message_item` 或 `ref_msg.title`。引用文本放在 prompt 前面，但命令只从用户自己发送的文字识别，避免引用中的 `/stop` 被执行。
- 登录覆盖 `wait`、`scaned`、验证码、过期刷新、可信域名跳转、确认成功；验证码封禁和其他客户端已绑定会给出明确错误。凭据缺失时不会保存半成品。
- Codex 官方文档 `https://developers.openai.com/codex/noninteractive` 及 Markdown 入口在本次环境返回 HTTP 403，未将未读取的网页当作依据。CLI 行为以安装版本的帮助和真实输出为依据。

## agent 实测

本机版本：Claude Code 2.1.283、Codex CLI 0.157.1、pi 0.84.2。对照各自 `--help`，使用数组参数和 stdin，在临时空目录执行 `printf wcode-fixture-ok`，第二轮询问上一轮指定的 marker。未修改用户项目或全局 agent 配置。

| agent | stdin、新会话、工具事件 | 同 ID 续接 | 进程退出 |
|---|---|---|---|
| Claude | 已通过 | 返回正确 marker | 两轮 exit 0 |
| pi | 已通过，`--mode json` 不需要额外 `-p` | 返回正确 marker | 两轮 exit 0 |
| Codex | 已通过 | 返回正确 marker | 最终通过实际执行器复测：新会话 51.6 秒、resume 21.6 秒，两轮正常退出 |

真实输出脱敏后保存为 `test/fixtures/*-{new,resume}.jsonl`。错误、超时等异常事件由独立故障测试覆盖。`npm run smoke -- claude codex pi` 用仓库实际执行器重做两轮验证，单轮上限 90 秒；此命令会实际调用模型，普通测试不会。

实际执行器复测中，Claude 两轮分别为 19.9 / 6.7 秒，pi 为 10.8 / 10.2 秒，均正常退出。早期 Codex resume 有过 120 秒未退出和 90 秒未返回的情况，日志包含 GitHub MCP 认证失败；临时 CLI 配置覆盖也没有消除当时的超时，未确认根因。最终使用原默认配置的新会话成功通过两轮测试，没有修改用户全局设置。

## 自动化验证

`npm run check` 执行 `tsc --noEmit` 和 Node 内置测试。当前 **28 项测试**在 Node v26.10.0 和最低支持版本 v22.18.0 均全部通过，类型检查也通过。覆盖：

- 三个 agent 的真实 JSONL 解析、忽略非 JSON/思考/工具结果、终态错误优先于中间文本。
- 大于命令行长度限制的 stdin prompt、以 `-` 开头及包含 shell 字符的文本、cwd、无末尾换行的 JSONL。
- 启动失败、stderr 最后 20 行、预先取消、SIGINT 后 5 秒 SIGKILL；父进程已退出时仍清理忽略 SIGINT 的孙进程。
- 0600 原子持久化、损坏状态拒绝启动、跨进程锁和陈旧锁恢复。
- owner/消息类型/群过滤、语音转写和引用；游标在执行前落盘、重复游标忽略、无游标/写盘失败时不执行。
- 运行中命令、精确命令匹配、项目与 agent 会话切换、模型重置、合并队列、停止清队列、超时与重启恢复。
- 2000 UTF-16 单元上限（包含编号及 `/more` 提示）、emoji 边界、每页最多 3 段、下一轮清页、重试 3 次、重启后使用新 context token 按序补发并复用 client ID。
- HTTP 字段和请求头、业务错误和 token -14、typing 开始与取消、验证码登录和域名跳转。
- 本地 HTTP 服务 → iLink 客户端 → bot → 真实 Node 子进程 → 微信格式最终回复的完整链路；重启后接入已存会话。

自动化测试不代表已经验证微信服务端的限制。测试用 HTTP 服务和假 agent 只替代外部服务，实际子进程执行、信号和文件系统路径仍使用真实系统接口。

## 真机联调

已完成真实扫码登录，`auth.json` 权限为 0600。回声模式成功收到 owner 入站消息、保存游标和 context token、发送回复（HTTP 200），用户已确认手机收到原样回复。真实 agent 模式已完成：

- 手机 `/cd /tmp/wcode-phone-check` 成功，目录被规范化为 `/private/tmp/wcode-phone-check`。
- Claude 按手机指令执行测试，将 `add(a,b)` 中的减法修复为加法；两项测试通过，最终 213 UTF-16 单元 / 401 UTF-8 字节的回复发送成功。
- 运行中每约 5 秒发送 typing 状态 1，完成后发送状态 2，均为 HTTP 200 / ret 0。
- 手机 `/agent 2` 成功切换 Codex；Codex 再次运行测试、记住指定暗号，最终回复成功（49 单元 / 89 字节）。
- 手机要求 Codex 运行 `node --test slow.test.js`（等待 10 分钟的临时测试），确认测试开始后发送 `/stop`。收到指令后取消 typing，立即发送停止确认，约 5 秒后发送终止结果；实际检查 Codex PID 2407、测试主进程 PID 2467、测试子进程 PID 2469 均已退出。
- 退出并重启 wcode 后，手机要求回忆暗号；确认 session ID 保持不变，原游标继续推进，Codex 返回精确的 `WCODE-PHONE-930`（15 字符），发送 HTTP 200。该轮等待约 177 秒，说明本机 Codex 延迟有明显波动，但最终正常退出和恢复了上下文。
- 联调结束后已加载最终代码，恢复 Claude + wcode 项目目录，保留各 agent 的测试会话和已推进的游标，outbox 为空。

其余待测项目：

1. 手机端的语音/引用、换行、markdown 与中文/emoji 显示细节尚未逐项记录；字段提取和保持 LF 已有源码依据与单测。
2. `/help`、`/status`、排队合并、`/new`、`/model` 和 `/more` 的各分支已有本地测试；尚未把每个分支都从手机重复一遍。
3. 微信长消息与多页发送上限尚未测定；2000 是保守客户端上限，不能据此断言服务端真实上限，也未确定服务端按字节还是字符计数。
4. context token 只确认在本次最长约 3 分钟的任务后仍可回复；10 分钟、30 分钟有效性尚未测定。
5. 正常联调多次发送均成功，但没有系统测定频率阈值。未对真实账户做高频压测。

## 相对草案的实现细化

- `pages` 也保存在 state 中；待发送回复先持久化再发送，进程中断后可补发。成功发送与本地确认间若崩溃，仍可能重复回复；客户端使用稳定 ID，但服务端去重语义未实测。
- 发送队列独立运行，网络等待不阻塞 `/stop`、新消息接收或游标持久化。
- -14 在任一 API 返回时立即停止，保留 outbox；不对失效的 bot 凭据继续重试。普通发送错误是初次尝试加 3 次退避重试。
- 同 bot/owner 重新登录保留游标，避免回退后重复执行；切换 bot/owner 清空旧状态。
- macOS/Linux 使用 POSIX 信号，并通过系统 `ps` 在停止前记录子孙进程、在强杀前再次枚举。真实 Codex 的测试命令使用独立进程组，因此只对 agent 的进程组发信号不够；现在同时清理已发现的子孙进程组，保留已变成孤儿进程的追踪记录。停止前已脱离整个父子关系的守护进程无法追踪，这不是系统级沙箱或容器隔离。
- 保留 LF 换行和基本 markdown，暂未增加 CRLF 转换或复杂格式过滤；只移除图片语法。
