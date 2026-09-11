# 方向三提交索引

依据用户提供的 2026-09-11 提交要求整理。

| 提交项 | 交付 |
|---|---|
| 公开 GitHub 代码仓 | https://github.com/changer-changer/PilotDeck-Verified-Subtasks ；根 README 给出改进点、模块与运行方式 |
| 游园会海报 | [A3 打印 PDF](assets/poster-a3.pdf)、[PNG](assets/poster-a3.png) |
| 可交互 Demo（选择性） | 原生 PilotDeck：运行 scripts/verified-subtasks-native.ts ui |
| 性能前后对比 | [原始数据](evidence/README.md)、[方法与限制](VALIDATION.zh-CN.md) |
| 技术设计图 | 根 README 与技术说明中的架构和状态图 |
| 功能演示视频（加分） | 当前不以视频替代现场原生执行；未录制 UI 视频 |

公开源代码保留上游许可证及 README.upstream.md，注明上游基线。清洁发布不包含私人工作记录、凭据、旧方案备份和上游发布自动化；本仓库 CI 只做构建、测试和确定性实验。

现场演示以改版 PilotDeck 为主。独立轨迹页只作为补充，不冒充现场执行。详见 DEMO.zh-CN.md。

主展示为双层验收：结构正确但业务错误的简报由独立模型识别，原子任务修复，成功兄弟任务保持不变。比赛模型的完整预演已通过，160.474 秒、4/4 最终通过、1 次模型触发修复。原生设置可单独配置评审模型，默认跟随主对话模型。具体开销与两次开发失败记录见验证说明。
