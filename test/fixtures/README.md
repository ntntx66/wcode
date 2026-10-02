# 真实 agent 输出样本

2026-09-30 在 macOS / Node v26.10.0 上录制：Claude Code 2.1.283、Codex CLI 0.157.1、pi 0.84.2。

每个 agent 的 `new` 轮只执行 `printf wcode-fixture-ok`，记住 `WCODE_SESSION_7392`，最后回答 `WCODE_FIXTURE_OK`。`resume` 轮通过同一会话 ID 回答上一轮的 marker。两轮 prompt 均通过 stdin 输入；参数见设计 §6 和适配器。

这些是实际 JSONL 的脱敏节选：移除了思考内容、签名、绝对路径、账户/插件信息和无关事件；会话 ID 替换为固定 UUID。保留解析器依赖的原始事件类型、层级、文本和工具字段。错误事件另在测试里构造，未冒充真实样本。

初次 Codex resume 录到了正确最终文本和 `turn.completed`，但进程在本机 GitHub MCP 认证失败后的退出阶段停滞，120 秒后由录制脚本终止。这个样本证明续接和输出格式，不证明正常退出。完整实测状态见 [验证记录](../../docs/verification.md)。

`npm run smoke -- claude codex pi` 可通过实际执行器重新验证新会话、工具事件和续接。它会使用已登录的 agent，产生正常的模型调用费用；普通 `npm test` 只读这些样本，不调用模型或微信。

`*-progress.jsonl` 来自 2026-10-03 的 Claude Code 2.1.287、Codex CLI 0.160.0、pi 0.84.2 实测续接轮：先说明并执行 `pwd`，再说明并执行 `printf probe-two`，最后回复 `FINAL: 两个命令都已完成。`。保留原始事件顺序和公开文字字段，移除思考、工具结果、账号/环境元数据，将 Claude 会话 ID 和示例路径替换为固定测试值。Claude 文本与 tool_use 分别到达，最终 assistant 文本在 result 重复；Codex 文本没有 phase；pi 的工具轮带 toolUse，结束轮带 stop，但发送不依赖这些阶段标签。

`npm run smoke:progress -- claude codex pi` 使用真实执行器和 Bot，将实际模型产生的完整文字发给本地 HTTP 收件端，验证两条说明、最终答案一次发送，以及同会话续接。不连接微信或修改真实 bot 的凭据、会话与服务。

`scene-a.png` 和 `scene-b.png` 是确定性生成的 400×240 测试图。a 为左红方块、右蓝圆；b 为左绿三角、右黄长方形。`npm run smoke:media` 分别在新会话和续会话传入两图，严格校验左右位置、颜色与形状。`WCODE_SMOKE_MODEL` 可临时指定视觉模型，不修改全局设置。
