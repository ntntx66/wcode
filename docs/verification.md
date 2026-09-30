# 研究与验证记录

日期：2026-09-30。当前交付范围为 M0–M3；M3 按用户确认交付可安装的 `.tgz`，暂不公开发布 npm。下文先保留 M0/M1 基线记录，M2/M3 新增记录见后半部分。

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

`npm run check` 执行 `tsc --noEmit` 和 Node 内置测试。M0/M1 基线 **28 项测试**在 Node v26.10.0 和最低支持版本 v22.18.0 均全部通过，类型检查也通过。覆盖：

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


## M2/M3 协议研究与实现

再次对照官方 2.4.9 的 `src/cdn/{aes-ecb,cdn-url,cdn-upload,upload,pic-decrypt}.ts`、`src/media/media-download.ts`、`src/api/types.ts` 和 `src/messaging/send.ts`。媒体加解密、字段编码与上传流程见设计 §14，未新增运行时依赖。

- 图片优先使用 `image_item.aeskey`；兼容两种 `media.aes_key` 编码、完整 URL 与 query 参数、无密钥明文图片、原始文件名与可选 MD5/长度。
- CDN 不带 bot 的 Authorization，只接受微信 HTTPS 地址并拒绝重定向。下载限制实际读取字节数，支持取消和 120 秒超时；异常不把半个附件交给 agent。
- 输入文件私有落盘，输出文件私有快照；文本与文件 outbox 同次持久化，上传完成后保存引用，发送失败重试与重启复用它。快照校验 SHA-256，原文件后续修改不改变回传内容。
- 自定义 `type:text` CLI 通过配置选择，用真实进程的 stdin/stdout 接入，共用停止/超时；明确无自动会话恢复。
- 发布构建用 TypeScript 5.9 `rewriteRelativeImportExtensions`，保留直接运行源码的开发方式。注册表上的 `wcode` 已是其他项目（查询时 0.5.3），本机未登录 npm；用户确认只交付 `.tgz`，因此保留 `private:true`，未执行 npm publish。

## M2/M3 自动化与真实 CLI

最终 **42 项测试**在 Node 26.10.0 与最低支持版本 22.18.0 均通过；类型检查和发布构建通过。新增测试覆盖图片解密、两种密钥编码、明文图片、完整 URL、文件名/权限、MD5/长度校验、HTTP 与超限失败、取消、原生图片参数、纯文本子进程、文件标记、快照、上传加密字段和信封、持久化失败、重启补发，以及 launchd plist 校验。HTTP 服务到真实 CLI 子进程的媒体闭环使用真实文件系统、AES 和网络请求：输入加密文件 → CLI 读取 → 写输出文件 → 加密上传 → 文件消息，已通过。

真实图片验证使用两张自生成图（`test/fixtures/scene-{a,b}.png`），分别测新会话和同 ID 续会话。a 为左红方块/右蓝圆，b 为左绿三角/右黄长方形：

| agent | 新会话 | 续会话 | 结果 |
|---|---|---|---|
| Claude Code | 37.2 秒 | 31.5 秒 | 两图的左右、颜色、形状都正确，图片通过路径读取 |
| Codex CLI | 32.4 秒 | 43.2 秒 | 两图均正确，新会话/resume 均实际使用 `-i` |
| pi + `na-auto-anthropic/claude-sonnet-5` | 4.5 秒 | 14.7 秒 | 两图均正确，实际使用 `@path` |

pi 本机默认 `na-auto-anthropic/glm-5.3` 的两轮识别错误。检查会话记录，确认每轮已包含对应 PNG 的原生 image block，故不能以 CLI 正常退出作为识别通过。临时用 `WCODE_SMOKE_MODEL` 指定已有视觉模型后通过，未修改全局设置。烟测断言也收紧为同时验证左右位置、颜色与形状，不能只检查四个关键词出现。

`npm run smoke:service` 实际在 macOS GUI 域加载一个独立临时 LaunchAgent，验证绝对 Node 入口、参数、WCODE_HOME、进程启动和 bootout 后退出。测试没有微信凭据、不连接微信；临时服务和目录已清理。真实 bot 的开机自启未安装，不声称已验证重启系统后的启动。

## M2/M3 真机记录

- 真实 `getuploadurl` HTTP 200，CDN 加密上传 HTTP 200，`sendmessage` 的文件项 `type:4` HTTP 200，outbox 清空。
- 发送 `M3-roundtrip.txt`，内容为 `M3_FILE_OK` 和中文验证说明。用户确认：手机已收到，能打开，内容正确。文件回传真机通过。
- 曾尝试将 CDN 上传返回的引用直接用于发送端 GET，得到 HTTP 400；诊断请求的另一字段形式返回授权错误。该旁路未作为入站成功依据，也未据此改动官方入站下载协议。手机成功打开实际文件说明上传、密钥编码、文件消息链路可用；随后真实手机入站也已成功，见下两项。
- 手机发送的微信聊天截图已下载解密为 193,955 字节 JPEG，0600 保存到 `media/inbound/`，通过 `-i` 传入现有 Codex 会话。实际识别到 `/status` 的 Codex/项目目录/108 秒运行信息、`/stop` 的两条停止回复，以及 `M3-roundtrip.txt` 的 36B 文件卡片。图片入站到 agent 分析的真机链路通过，达到 M2“发一张截图，agent 能分析”的完成标准。
- 截图中的红色 ❌ 对应主动停止的反馈，不表示该次文件上传失败；截图只确认文件卡片已到达，文件能打开且内容正确的依据是上条用户确认。手机将 `M3-roundtrip.txt` 发回后，36 字节文件成功下载解密，SHA-256 与发送原文件一致。Codex 读取并正确回复 `M3_FILE_OK` 和 `微信文件往返验证`，回复 HTTP 200。普通文件入站也通过真机验证。

## M3 安装包验证

已执行 `npm pack`，检查白名单内容只含编译 JavaScript、文档与第三方声明；未包含凭据、媒体、测试文件或开发依赖。通过 `npm install --global --prefix /tmp/wcode-m3-install /path/wcode-0.2.0.tgz` 独立安装，安装后的 CLI 在 Node 26.10.0 与 22.18.0 均返回版本 0.2.0 并正确显示帮助，无 node_modules 内 TypeScript 错误。

联调结束后切回正常前台 bot，保留当前 Codex 会话与项目目录，outbox 为空。本轮不公开发布 npm，不修改用户的全局 agent 配置，不自动安装真实 launchd bot 服务。可直接使用安装包，或按 README 手动安装后台服务。已知边界：100 MiB 是客户端上限，尚未测试微信真实大文件阈值；媒体与日志不自动清理；视频/音频原件处理不在 M2 范围；M0/M1 中的长期 token、频率、长消息上限仍未专门测定。
