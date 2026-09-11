# 可复现证据

- deterministic-final：脚本化初始错误、真实文件工具与修复循环的三策略比较。
- live-minicpm：三题自然模型响应，初始和修复均 0/3，保留失败。
- live-glm-flash：相同三题，初始 3/3，没有修复收益证据。
- native-model-review：比赛 GLM-5.3 原生双层验收，保留两次开发失败与一次完整成功。`index.json` 为可计算摘要，各目录有逐次报告和事件，成功目录附实际文件与原任务。

前三组历史证据将本机绝对目录替换为 `<EVIDENCE_ROOT>` 和 `<REPO_ROOT>`。新的 native-model-review 证据还脱敏用户目录与比赛端点，并移除所有 `assistant_thinking_delta` / `subagent_thinking_delta` 思考流事件。其余事件、工具结果、判定、用量、问题和失败保留；每份记录注明原始 SHA-256 及删减前后事件数。摘要用量已包含评审，不能把评审子集重复相加。复现命令见根 README 和验证说明。
