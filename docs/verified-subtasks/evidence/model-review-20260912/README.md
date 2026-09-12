# GLM-5.3 模型验收工程对照

2026-09-12。12 个样例 × 4 策略，共 48 次任务运行。生产、独立只读评审、修复均使用 competition/glm-5.3。

## 结果入口

[可视化报告](../../model-review-report.html) · [指标](metrics.json) · [全部结果与最终文件](results.json) · [逐项独立核查](quality-audit.json) · [代码测试](code-audit.json) · [全部原始轨迹 ZIP](https://github.com/changer-changer/PilotDeck-Verified-Subtasks/releases/tag/model-review-20260912)

- 四组：原流程（未配置 acceptance 的既有路径）、仅 L1（修复上限 2）、L1 + 模型评审（修复上限 0）、L1 + 模型评审（修复上限 2）。并未另行重建上游版本。
- L1 只验收声明结构 artifact/summary，未提供业务答案或语义宿主检查器；L2 直接使用项目 createModelSubtaskReviewer；修复直接使用 SubAgentSession。
- 4 个从零生成任务，各组独立调用模型；4 份预置不合格和 4 份预置合格交付，各组初始文件与声明完全相同，首个声明由脚本注入，之后真实调用模型。预置错误的比例不能外推为自然错误率。
- 运行时不会看到 cases.json 中的 rubric 和 initialQuality；只看到 task、workspace 文件与交付声明。固定参考文本不是开放文档的唯一正确答案。
- Codex 在任务完成后对照要求和文件做人工式逐项核查，不把模型自身的 accepted 当成质量依据；不是第三方盲审。代码再运行 24 个独立用例，测试不进入模型修复反馈。
- 共享预算 24 轮，每次评审最多 5 轮、180 秒；每项任务最多 600 秒；并发 3（首个校验样例并发 2）。自然生产没有复用首答。请求次数包含原生框架内部模型调用；预置组的零请求只代表不追加模型检查，不代表真实生产免费。
- 全部 48 次结果保留，不删除失败记录。此为小样本工程验证，不宣称总体统计显著性，不与此前 L1 的 1,450 配对合并。

## 复跑

在仓库根目录安装依赖后，设置兼容 OpenAI 工具调用接口的 `PILOTDECK_DEMO_BASE_URL`、`PILOTDECK_DEMO_API_KEY`，以及 `REVIEW_EXPERIMENT_MODEL`（默认为 glm-5.3）。不要把凭据写进 Git。

```bash
mkdir -p artifacts/model-review-new
cp docs/verified-subtasks/evidence/model-review-20260912/cases.json artifacts/model-review-new/cases.json
node --import tsx scripts/model-review-engineering.ts artifacts/model-review-new
node docs/verified-subtasks/evidence/model-review-20260912/audit-code.mjs artifacts/model-review-new
```

完成后逐份审阅产物，不能复用本轮 quality-audit.json 作为新一轮判分。脚本跳过已有 result.json；完整复跑请使用全新目录。`EXPERIMENT_CONCURRENCY` 控制并发，`EXPERIMENT_CASE` 可选择一个案例。

源实现核心基线为本机 5c9dc81；公开仓库本次未改 src/，仅新增实验脚本及材料。原始执行脚本保留在 ZIP 中；公开复跑脚本只增加环境变量读取方式，算法与参数相同。原始事件和结果不含凭据；部分文件路径保留运行位置，供交叉核对。
