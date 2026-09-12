# 项目问答中心

[打开项目问答](defense-qa.html)：搜索感兴趣的问题，查看结论、图表与公开证据。

## 1. 这个项目做了什么？

让每次交付，都有验收依据。我们给 PilotDeck 的子任务加上两层检查：程序核对格式与规则，独立 AI 核对任务与实物；发现可修复的问题，就在原来的子任务里限次修好，再返回验收结果。

**从完成声明到验收依据**：Agent 会说“完成了”，但用户还得自己查字段、对文件、核数值。我们把这些交付检查接进 PilotDeck 的执行过程，连同失败原因、修复次数和观察记录一起交给用户。完成状态由检查支撑，出错也能说明白。

**对使用者的价值**：开发者定义交付标准，操作者看到哪里没过，查看结果的人能沿着证据了解通过原因。只对配置了验收契约的子任务生效。

证据：[公开实现与模块说明](https://github.com/changer-changer/PilotDeck-Verified-Subtasks/blob/main/README.md#改了哪里) · [真实录像与验收报告](https://github.com/changer-changer/PilotDeck-Verified-Subtasks/blob/main/docs/verified-subtasks/evidence/ui-recording-20260911/README.md)

## 2. 解决谁的痛点？为什么值得用？

最直接的用户，是用多个 Agent 处理报表、文件和业务流程的开发团队。他们需要的交付，应当既能检查，又能说明失败原因。我们把反复人工核对的步骤变成可执行的验收流程。

**从用户的一天出发**：四个子任务汇总出三张正确报表和一份错误简报。用户希望保留正确结果，集中处理那份有问题的交付。原生演示就按这条路径展开。

**价值如何衡量**：关注最终交付通过率、每次任务用量、失败原因是否可追踪，以及已通过任务是否被重新执行。当前有受控演示与合成任务数据，尚无企业生产节省工时的实测。

证据：[真实录像与验收报告](https://github.com/changer-changer/PilotDeck-Verified-Subtasks/blob/main/docs/verified-subtasks/evidence/ui-recording-20260911/README.md) · [修订版统计报告](statistics-report.html)

## 3. 为什么要在 PilotDeck 里做？

PilotDeck 已有主子代理、模型池、原生任务界面和白盒记忆。我们把验收接在真实的子任务交付边界，让这些已有能力围绕一份“可以核对的结果”协同工作。

**框架发挥作用的位置**：任务从原生 agent 工具派发，SubAgentSession 管理验收和同会话修复，状态事件进入子任务卡片，终态观察进入项目存储与白盒记忆。

**框架原有贡献与本项目贡献**：主子代理、模型接入、工具执行、记忆召回与 Dream 属于 PilotDeck 资产。本项目新增验收契约、双层判定、有界修复及其状态、用量与记忆接合。

证据：[公开实现与模块说明](https://github.com/changer-changer/PilotDeck-Verified-Subtasks/blob/main/README.md#改了哪里) · [验收观察实现](https://github.com/changer-changer/PilotDeck-Verified-Subtasks/blob/main/src/context/memory/AcceptanceMemory.ts)

## 4. 创新在哪？只是“再问一次模型”吗？

我们的工程创新，是让验收成为子任务执行的一部分：交付前有契约，失败后有局部修复，预算耗尽有明确终态，过程和经验可追踪。每个环节都有代码接合与验证证据。

**三处关键设计**：先用确定性规则检查，再用只读评审核对语义；修复回到同一个子任务，保留上下文与权限；验收观察按实际模型和契约分组，进入白盒记忆。

**怎样评价原创性**：验收、反馈修复、审查代理都有先例。项目的新增价值是面向 PilotDeck 的完整执行路径，以及可审阅的实现和证据。

证据：[公开实现与模块说明](https://github.com/changer-changer/PilotDeck-Verified-Subtasks/blob/main/README.md#改了哪里) · [子任务修复状态机](https://github.com/changer-changer/PilotDeck-Verified-Subtasks/blob/main/src/agent/sub/SubAgentSession.ts) · [验收观察实现](https://github.com/changer-changer/PilotDeck-Verified-Subtasks/blob/main/src/context/memory/AcceptanceMemory.ts)

## 5. 与 Claude Code、Codex、OpenCode 相比，有什么不同？

在“子任务如何交付”这个环节，我们给出了一套面向 PilotDeck 的现成方案：契约、两层检查、同会话修复、预算、原生状态和记忆回写可以一起工作。用户可以沿同一条记录理解一次交付。

**集成的价值**：在 PilotDeck 内，一份验收契约可以连接检查、修复、预算、原生状态和观察记录。开发者配置交付标准，使用者能查到判定依据与处理过程。

**比较范围**：三家都已有审查或扩展能力，也可构建相近工作流。本页比较的是本项目已实现的集成方式；尚无三家同条件性能实验，不能据此得出整体性能排名。

证据：[Claude Code · 模型 Hooks](https://code.claude.com/docs/en/hooks-guide#agent-based-hooks) · [Codex · SubagentStop](https://developers.openai.com/codex/hooks#subagentstop) · [OpenCode · 子代理配置](https://opencode.ai/docs/agents/) · [公开实现与模块说明](https://github.com/changer-changer/PilotDeck-Verified-Subtasks/blob/main/README.md#改了哪里)

## 6. Claude Code 已经做了什么？

Claude Code 已有 prompt / agent Hooks，可以让模型判断完成条件；agent hook 还能读文件、搜索并核验。它也有项目指令和自动记忆。本项目的侧重点，是将验收与局部修复完整接入 PilotDeck 的交付流程。

**官方可确认的能力**：Stop / SubagentStop 可将不满足条件的理由反馈给执行者，让任务继续。agent hooks 当前文档标注为实验性；prompt hooks 可配置模型。

**本项目的侧重点**：验收契约、结构化问题、共享预算、同子任务修复、原生卡片和验收观察存储已经接通。Claude Code 也可通过扩展搭建相近流程；这里体现的是面向 PilotDeck 的具体集成价值。

证据：[Claude Code · 模型 Hooks](https://code.claude.com/docs/en/hooks-guide#agent-based-hooks) · [Claude Code · 记忆](https://code.claude.com/docs/en/memory) · [公开实现与模块说明](https://github.com/changer-changer/PilotDeck-Verified-Subtasks/blob/main/README.md#改了哪里)

## 7. Codex 已经做了什么？

Codex 已有可配置的审查子代理、只读权限和结构化审查输出；SubagentStop 可以阻止结束并要求继续。我们针对 PilotDeck 提供统一的验收与修复语义，并把证据带回原生交付流程。

**官方可确认的能力**：官方子代理示例包含独立模型与 read-only reviewer；官方 Cookbook 用输出 schema 组织审查结果；Hooks 文档明确给出阻止子代理停止、继续工作的方式。

**交付验收的关注对象**：代码审查、结构化输出和业务产物验收有交集。本项目以报表与供应简报为例，核对任务、交付声明和实际文件；这不代表 Codex 无法完成相同任务。

证据：[Codex · SubagentStop](https://developers.openai.com/codex/hooks#subagentstop) · [Codex · 审查子代理](https://developers.openai.com/codex/subagents) · [Codex · 结构化审查](https://developers.openai.com/cookbook/examples/codex/build_code_review_with_codex_sdk) · [公开实现与模块说明](https://github.com/changer-changer/PilotDeck-Verified-Subtasks/blob/main/README.md#改了哪里)

## 8. OpenCode 已经做了什么？

OpenCode 已有主代理与子代理、独立模型配置、权限控制和步数上限；插件能接入工具前后与会话事件。我们的交付重点是把这些验收环节落实到 PilotDeck 的任务生命周期。

**可扩展基础**：官方 Agent 配置能指定模型、工具权限和 steps；插件有 tool.execute.before / after 及 session.idle 等事件。这些是建设审查工作流的可用基础。

**本项目提供的现成流程**：验收状态、修复终止原因和观察记录有统一格式，并进入 PilotDeck 原生界面与存储。开发者可以在这些已接通的环节上配置业务标准；OpenCode 的插件体系也提供了建设相近流程的基础。

证据：[OpenCode · 子代理配置](https://opencode.ai/docs/agents/) · [OpenCode · 插件事件](https://opencode.ai/docs/plugins/) · [公开实现与模块说明](https://github.com/changer-changer/PilotDeck-Verified-Subtasks/blob/main/README.md#改了哪里)

## 9. 这是新方向吗？谁先做出来的？

验收、反馈修复和审查代理已有实践。本项目的新增价值，是把这些能力在 PilotDeck 内完整接通并提供验证证据。本页依据 2026 年 9 月 12 日核对的官方能力比较，不作为功能首发时间的排名。

**时间口径**：本项目已有 9 月 11 日真实演示与实验记录。竞品页面持续更新，只能支持当前能力，不自动支持某功能的首发日期。

**本项目的新增贡献**：完整的运行时接合、故障处理、可视化状态与验收观察，使原框架增加了可检查的子任务交付流程。代码、真实运行记录和统计数据分别说明实现范围与验证结果。

证据：[Claude Code · 模型 Hooks](https://code.claude.com/docs/en/hooks-guide#agent-based-hooks) · [Codex · SubagentStop](https://developers.openai.com/codex/hooks#subagentstop) · [OpenCode · 子代理配置](https://opencode.ai/docs/agents/) · [真实录像与验收报告](https://github.com/changer-changer/PilotDeck-Verified-Subtasks/blob/main/docs/verified-subtasks/evidence/ui-recording-20260911/README.md)

## 10. 两层验收怎样串起来？

先确认“交付是否符合约定”，再确认“内容是否真的完成任务”。结构或规则失败，反馈到原来的子任务修复；模型发现明确内容问题也可修复；证据不足或评审异常则明确拒绝。

**第一层**：有限 JSON Schema、宿主注册的业务规则，以及配置的产物检查。错误会归一化为包含路径、错误码和说明的问题项。

**第二层**：独立只读评审会话看到原任务、交付声明和执行证据；文件任务可读取实际产物与源材料。两层启用时必须都通过。

证据：[只读评审实现](https://github.com/changer-changer/PilotDeck-Verified-Subtasks/blob/main/src/agent/sub/acceptance/modelReviewer.ts) · [子任务修复状态机](https://github.com/changer-changer/PilotDeck-Verified-Subtasks/blob/main/src/agent/sub/SubAgentSession.ts)

## 11. JSON 格式对了，为什么还要模型审？

格式正确只说明“填得像一份交付”。例如简报字段完整，却把延期 7 天、影响 18 单写成供应正常。第一层可以验结构和已编码规则，第二层再核对任务、内容和源材料。

**两层的分工**：能够写成确定性规则的检查优先交给程序；开放的语义要求交给模型复核。模型评审增加判断能力，也增加用量和误判风险。

**现场证据**：已录制演示中，问题简报第一层通过，第二层读取实际文件后拒绝，原来的子任务修复一次后通过。该过程证明这个故障路径跑通。

证据：[真实录像与验收报告](https://github.com/changer-changer/PilotDeck-Verified-Subtasks/blob/main/docs/verified-subtasks/evidence/ui-recording-20260911/README.md) · [只读评审实现](https://github.com/changer-changer/PilotDeck-Verified-Subtasks/blob/main/src/agent/sub/acceptance/modelReviewer.ts)

## 12. 目前是谁在审？能换模型吗？

已录制演示使用 competition/glm-5.3 评审，和生产者同型号、不同会话。设置页可单独选评审模型；未指定时跟随实际派发任务的主对话模型，便于使用已配置可用的模型入口。

**配置入口**：原生设置 → Agent → 交付评审，可启停第二层、指定模型、调评审轮次和超时。端点与密钥由模型池管理。

**独立的准确含义**：独立指评审会话、指令职责和只读工具权限；同型号仍可能有相关错误。跟随模型配置不保证端点永远可用，异常会进入失败路径。

证据：[公开实现与模块说明](https://github.com/changer-changer/PilotDeck-Verified-Subtasks/blob/main/README.md#改了哪里) · [真实录像与验收报告](https://github.com/changer-changer/PilotDeck-Verified-Subtasks/blob/main/docs/verified-subtasks/evidence/ui-recording-20260911/README.md) · [只读评审实现](https://github.com/changer-changer/PilotDeck-Verified-Subtasks/blob/main/src/agent/sub/acceptance/modelReviewer.ts)

## 13. “局部修复”到底局部在哪里？

被拒的交付回到原来的子任务、会话和权限里继续处理。其他已通过的兄弟任务保留。这样一次失败的处理边界清楚，用户也能查到具体修了哪份交付。

**演示中的直接证据**：四个子任务里只有简报需要一次语义修复；三张正确报表的内容哈希和纳秒修改时间保持不变。

**实现边界**：这不是文件系统事务。兄弟任务若并发写同一文件，仍可能冲突；当前没有新增通用回滚或共享文件隔离机制。

证据：[真实录像与验收报告](https://github.com/changer-changer/PilotDeck-Verified-Subtasks/blob/main/docs/verified-subtasks/evidence/ui-recording-20260911/README.md) · [子任务修复状态机](https://github.com/changer-changer/PilotDeck-Verified-Subtasks/blob/main/src/agent/sub/SubAgentSession.ts)

## 14. 会不会无限重试、烧钱？

修复次数和总模型轮次都有上限，生产、修复和评审共享总轮次预算。到上限就返回明确的失败原因，让调用方决定下一步。

**两道预算**：验收契约默认最多 2 次修复、20 个总轮次，可配置但受上限约束；修复最多 5 次，总轮次最多 100。评审还有自身轮次与超时限制。

**成本理解**：轮次上限用于控制执行范围，不是精确金额上限。单次上下文大小、输出长度、模型价格仍影响成本。统计实验单独使用了 6 轮总预算。

证据：[子任务修复状态机](https://github.com/changer-changer/PilotDeck-Verified-Subtasks/blob/main/src/agent/sub/SubAgentSession.ts) · [只读评审实现](https://github.com/changer-changer/PilotDeck-Verified-Subtasks/blob/main/src/agent/sub/acceptance/modelReviewer.ts)

## 15. 评审超时、出错、证据不足怎么办？

这些状态不会被当作验收通过。系统明确返回错误或证据不足，停止这条验收流程；只有具体、可修复的交付问题才进入有界修复。

**判定与终态**：评审输出 accepted / rejected / inconclusive；执行层再把问题和停止原因带回调用方。判决格式异常、检查器错误和预算耗尽都有可观察的失败路径。

**这项保证的范围**：错误状态不会默认放行，不等于模型永远判断正确。模型把错误内容误判为 accepted 仍是已知限制。

证据：[只读评审实现](https://github.com/changer-changer/PilotDeck-Verified-Subtasks/blob/main/src/agent/sub/acceptance/modelReviewer.ts) · [子任务修复状态机](https://github.com/changer-changer/PilotDeck-Verified-Subtasks/blob/main/src/agent/sub/SubAgentSession.ts)

## 16. 生产者能骗评审，或通过提示注入改文件吗？

我们限制评审只能读取和提交判决，不能写文件、执行 shell 或递归派发任务；同时把生产者内容标成不可信数据。这降低了攻击面，但不能保证模型不受恶意文本影响。

**代码约束**：只读工具白名单、禁止交互申请权限、内部评审禁用再次评审。文件任务的通过判断还需要实际读取证据。

**防护边界**：原任务、声明和轨迹是在同一评审输入中分区标注，不是物理隔离。提示注入防护和语义误判没有被证明完全解决。

证据：[只读评审实现](https://github.com/changer-changer/PilotDeck-Verified-Subtasks/blob/main/src/agent/sub/acceptance/modelReviewer.ts)

## 17. 失败内容会污染主代理上下文吗？

修复过程留在子任务会话里，主代理收到带验收状态、问题和用量的结果。这样主代理可以依据明确的通过或失败状态继续决策；返回结果仍可能包含交付正文。

**为什么有帮助**：主代理不用亲自主持每一轮修复，能看到通过或拒绝以及原因。失败作为真实工具失败返回，便于后续决策。

**返回内容的范围**：当前工具返回会包含 report.markdown，因此主代理仍会接触交付内容。过程隔离和明确状态有助于判断失败，但不能保证错误正文不会影响后续推理。

证据：[原生 agent 工具接合](https://github.com/changer-changer/PilotDeck-Verified-Subtasks/blob/main/src/tool/builtin/agent.ts) · [子任务修复状态机](https://github.com/changer-changer/PilotDeck-Verified-Subtasks/blob/main/src/agent/sub/SubAgentSession.ts)

## 18. 验收写进白盒记忆，有什么用？

让重复出现的问题留下可检查的记录。我们保存结果、错误码、模型来源与修复次数，按模型和契约分组，让用户能观察哪类交付经常出错，并为之后改契约提供依据。

**已交付范围**：项目存储保存有界终态观察，并投递到原生白盒记忆；演示中可见 4 条观察、3 条首次通过、4 条最终通过。

**数据与学习的边界**：观察不保存任务正文与自由文本评语，也不等于完整尝试轨迹的长期存储。既有 Dream 可以整理记忆；尚未验证后续任务成功率提升，更不会自动修改验收标准。

证据：[验收观察实现](https://github.com/changer-changer/PilotDeck-Verified-Subtasks/blob/main/src/context/memory/AcceptanceMemory.ts) · [真实录像与验收报告](https://github.com/changer-changer/PilotDeck-Verified-Subtasks/blob/main/docs/verified-subtasks/evidence/ui-recording-20260911/README.md)

## 19. 开发者要改多少？怎么接自己的业务？

对需要保护的子任务配置 acceptance：声明输出结构，选择宿主已经注册的检查器，设置修复与轮次预算。规则可确定时先用程序检查，需要语义核对时再启用模型评审。

**接入责任**：框架负责执行与错误传播；业务方仍要定义有意义的标准，并注册自己的业务检查器。JSON Schema 采用实现支持的有限子集，错误契约会先被拒绝。

**正确字段示意**：acceptance 使用 schema、validators、maxRepairs、maxTurns 等参数。示例里 validators 为空仅表示未选择额外宿主规则，不代表业务自动被验证。

证据：[公开实现与模块说明](https://github.com/changer-changer/PilotDeck-Verified-Subtasks/blob/main/README.md#改了哪里) · [原生 agent 工具接合](https://github.com/changer-changer/PilotDeck-Verified-Subtasks/blob/main/src/tool/builtin/agent.ts)

## 20. 验收修复带来了多大提升？

在 Llama 3.2 3B 的 450 组配对合成任务上，最终正确交付从 17 份增加到 161 份：3.8% → 35.8%，提升 32 个百分点。这组结果验证了第一层确定性验收与有界修复的收益。

**四个模型一起看**：Qwen2.5-Coder 7B 从 21.0% 到 38.7%；MiniCPM5 1B 与 Qwen2.5 1.5B 的提升很小，配对检验没有显著差异。收益依赖模型和任务。

**证据边界**：统计实验关闭了第二层模型评审，也没有测自然业务任务分布。这些数字不能归为双层评审的整体收益，更不能作为与竞品的性能排名。

证据：[修订版统计报告](statistics-report.html) · [原始数据与实验脚本](https://github.com/changer-changer/PilotDeck-Verified-Subtasks/releases/tag/statistics-20260912)

## 21. 1,450 是怎么算的？实验怎样设计？

1,450 是四个模型合计的 A/B 配对任务数：450 + 400 + 300 + 300。C、D 各有 1,000 条记录；E 是从 C 的候选里事后计算的选择结果。

**A/B 主问题**：A 是单次贪心回答；B 精确回放同一首答，然后允许最多两次修复。最终都由确定性任务生成器的标准答案判分。

**C/D/E 的用途**：C 是三次独立采样后多数投票；D 是一次温度 0.7 采样；E 使用已知标准答案选择 C 中最早正确样本。E 没有额外跑一批模型。任务族合并共四类，每个模型覆盖三类。

证据：[修订版统计报告](statistics-report.html) · [原始数据与实验脚本](https://github.com/changer-changer/PilotDeck-Verified-Subtasks/releases/tag/statistics-20260912)

## 22. 是不是多采样带来的？这个比较公平吗？

A/B 的第一次回答完全相同，所以起点可核对；后续收益来自整个修复方案，包含额外采样和反馈。C/D 对照进一步展示了不同策略的表现，报告保留了修复不占优的结果。

**配对的好处**：逐实例比较相同起点，减少首答运气差异。B 的逻辑请求与 token 计入回放的首答，成本口径包含完整尝试过程。

**不能隔离的因素**：B 与 C/D 还在温度、上下文、反馈和结构化输出通道上有差异。现有数据不能把提升单独归因于某个反馈技巧。任务难度经过校准，也限制了外推范围。

证据：[修订版统计报告](statistics-report.html) · [原始数据与实验脚本](https://github.com/changer-changer/PilotDeck-Verified-Subtasks/releases/tag/statistics-20260912)

## 23. 验收修复一定比三次投票好吗？

不一定。Llama 的配对子集上，三次投票 44.3% 高于同会话修复的 35.0%；Qwen Coder 7B 上，修复是 40.7%，投票是 16.7%。可靠的方案需要按模型和任务选择。

**为何仍有价值**：验收给出通过依据和失败原因，局部修复提供清晰的处理路径。成功率最高的采样策略需要实验决定，不能靠机制名称判断。

**正确比较分母**：这里 Llama n=300、Coder n=150，B 的百分比也按同一子集计算。Llama B/D 为 35.0% / 29.3%，p=0.1145，未达到通常的 0.05 显著阈值。

证据：[修订版统计报告](statistics-report.html) · [原始数据与实验脚本](https://github.com/changer-changer/PilotDeck-Verified-Subtasks/releases/tag/statistics-20260912)

## 24. 56% 对 44.3%，能证明什么？

它说明在这批已生成的 Llama 候选中，若拥有正确答案来选择，能找到更多正确结果。56% 是事后使用标准答案得到的参考值，不能当作模型评审的实测通过率。

**E 怎样算**：沿 C 的三次采样，选择第一个与标准答案一致的结果；都不对则失败。完美判分条件下，E 不低于投票是结构上可以预期的。

**2.17 次请求怎样理解**：这是按“找到正确答案就停止”折算的逻辑请求均值。实际 C 已经生成三次，未实测 E 在线执行的花费或延迟。

证据：[修订版统计报告](statistics-report.html) · [原始数据与实验脚本](https://github.com/changer-changer/PilotDeck-Verified-Subtasks/releases/tag/statistics-20260912)

## 25. 能省多少钱？为什么值得付出开销？

当前可以准确报告请求次数，尚不能给出通用省钱比例。第一层程序检查不新增模型请求；第二层复核会增加模型用量。用户付出的开销，换来交付检查、明确反馈与可追踪记录。

**已有成本口径**：A 单次请求，C 固定三次；B 四模型平均每题 2.47–2.97 次逻辑请求，包含首答回放。首答过关可早停，但启用第二层仍需支付评审用量。

**从请求次数到实际成本**：请求更少未必金额更低，因为上下文和输出长度不同；没有旗舰替代实验，也没有生产工时对照。因此不承诺任意业务降本百分比。

证据：[修订版统计报告](statistics-report.html) · [原始数据与实验脚本](https://github.com/changer-changer/PilotDeck-Verified-Subtasks/releases/tag/statistics-20260912) · [只读评审实现](https://github.com/changer-changer/PilotDeck-Verified-Subtasks/blob/main/src/agent/sub/acceptance/modelReviewer.ts)

## 26. 为什么小模型有的几乎没提升？

验收可以发现错误，修复能利用模型已有能力，但不能凭空补齐能力。MiniCPM5 1B 和 Qwen2.5 1.5B 在这批任务上没有显著提升，这给了我们明确的适用边界。

**对用户的选型价值**：先用实际任务检验模型是否能在反馈后生成正确答案，再决定是否投入修复预算。公开弱结果，能帮助用户避免把预算投在收益很小的组合上。

**结论的适用范围**：结果对应所测模型、量化、任务和配置，尚不足以判断某个参数规模天然无效，也不能代表这些模型在其他策略或场景下的表现。

证据：[修订版统计报告](statistics-report.html) · [原始数据与实验脚本](https://github.com/changer-changer/PilotDeck-Verified-Subtasks/releases/tag/statistics-20260912)

## 27. 如何理解统计显著性与实际价值？

Llama 3B 的正确交付增加了 144 份，即提升 32 个百分点，配对检验也显示显著差异。统计差异是一个维度；实际价值还要结合请求开销、模型能力和业务任务的相似程度判断。

**检验方法**：A/B 是配对二元结果，使用 McNemar 精确检验；成功率给 Wilson 95% 区间。p 值是在零假设与检验假设成立时，出现当前或更极端结果的概率，不是零假设为真的概率。

**零倒退的解释**：B 直接保留 A 已通过的首答，所以 A 过/B 败为零受到设计保障；这一结果不能外推为生产环境中的零回归。多组对照 p 值未做多重比较校正，作为探索性证据解释。

证据：[修订版统计报告](statistics-report.html) · [原始数据与实验脚本](https://github.com/changer-changer/PilotDeck-Verified-Subtasks/releases/tag/statistics-20260912)

## 28. 除了演示，还验证了哪些东西？

现有代码审查跑通 100 项后端定向检查、63 项 UI 检查和项目构建；另有真实模型录像、验收报告与文件指纹核对。机制测试、真实链路和统计数据各自回答不同的问题。

**检查覆盖的故障路径**：契约预检、修复次数与总轮次上限、中断、检查器异常、评审失败、兄弟任务与生命周期，以及 UI 状态展示。

**三类证据分别说明什么**：测试证明被覆盖行为符合断言；真实录像证明该故障闭环实际执行；L1 统计用于估计所选任务上的收益。三者不能互相替代。

证据：[公开实现与模块说明](https://github.com/changer-changer/PilotDeck-Verified-Subtasks/blob/main/README.md#改了哪里) · [真实录像与验收报告](https://github.com/changer-changer/PilotDeck-Verified-Subtasks/blob/main/docs/verified-subtasks/evidence/ui-recording-20260911/README.md) · [修订版统计报告](statistics-report.html)

## 29. 还有哪些限制？能直接上生产吗？

比赛主流程已有可运行实现和验证证据；生产使用仍要按业务检查器、模型、权限与并发场景做评估。最关键的限制是评审可能误判，任务标准需要人定义，修复不是事务回滚。

**已知技术边界**：JSON Schema 为有限子集；共享文件并发写入可能冲突；没有通用跨进程恢复与事务隔离保证；模型端点可用性和评审开销仍需监控。

**已知证据边界**：没有双层验收的大样本收益试验，没有白盒记忆带来的跨任务学习收益验证，也没有同条件竞品性能对照。本项目的成熟度以公开实现、演示和具体测试为准。

证据：[公开实现与模块说明](https://github.com/changer-changer/PilotDeck-Verified-Subtasks/blob/main/README.md#改了哪里) · [修订版统计报告](statistics-report.html) · [真实录像与验收报告](https://github.com/changer-changer/PilotDeck-Verified-Subtasks/blob/main/docs/verified-subtasks/evidence/ui-recording-20260911/README.md)

## 30. 如何查看完整的验收与修复过程？

跟随一份“格式正确、内容错误”的简报，就能看到完整过程：模型读取源材料并拒绝，原来的子任务修复后通过，其他三张报表保持原样，验收观察进入白盒记忆。下方提供录像、报告和运行说明。

**录像中的五个观察点**：① 源数据：延期 7 天、18 单受影响。② 第一层通过，第二层读取实际材料后拒绝。③ 简报修复一次通过。④ 三张报表指纹未变。⑤ Memory 留下四条验收观察。

**选择观看或亲自运行**：快速观看版约 1 分 58 秒，包含标明的加速；完整实录约 9 分 47 秒。录像中 UI 主任务耗时 5 分 58 秒。希望亲自运行时，可按“8 步真实演示”操作，预留 5–7 分钟；实际耗时受模型和网络影响。

证据：[8 步真实演示](https://github.com/changer-changer/PilotDeck-Verified-Subtasks/blob/main/docs/verified-subtasks/QUICKSTART.zh-CN.md) · [真实录像与验收报告](https://github.com/changer-changer/PilotDeck-Verified-Subtasks/blob/main/docs/verified-subtasks/evidence/ui-recording-20260911/README.md) · [1 分 58 秒 / 完整实录](https://github.com/changer-changer/PilotDeck-Verified-Subtasks/releases/tag/demo-recording-20260911)

## 31. 演示中的评审和修复是真实执行的吗？

演示预置了错误，但评审和修复真实调用模型。公开材料包含任务产物、验收判决、读取证据与文件指纹，录像可以对照过程。这证明受控故障的闭环跑通。

**控制了什么**：错误简报是刻意构造的，用来稳定展示“结构合规却语义错误”的路径。评审要读取任务相关材料，修复由执行子任务完成。

**这份证据能说明什么**：录像与产物记录证明了受控故障的实际处理过程，不代表自然错误发生率或平均性能。大样本部分也属于合成任务，只测第一层验收与修复；页面分别标注两类证据。

证据：[真实录像与验收报告](https://github.com/changer-changer/PilotDeck-Verified-Subtasks/blob/main/docs/verified-subtasks/evidence/ui-recording-20260911/README.md) · [1 分 58 秒 / 完整实录](https://github.com/changer-changer/PilotDeck-Verified-Subtasks/releases/tag/demo-recording-20260911) · [原始数据与实验脚本](https://github.com/changer-changer/PilotDeck-Verified-Subtasks/releases/tag/statistics-20260912)

## 32. 项目具体改进了哪些模块？

本项目跨越五个环节：任务派发的验收契约、运行时的验收与局部修复、独立模型读文件核查、原生卡片状态、白盒观察回写。它们共同构成一条可运行、可解释、可核对的子任务交付流程。

**对方向三的实际贡献**：实用性：错误能被发现并在局部处理；技术深度：状态机、预算、失败语义与原生系统接合；新增价值：把验收证据和白盒观察连入交付体验。

**如何核查实现**：公开仓库 README 提供模块说明和运行方式；验收报告记录实际判定与文件证据；统计报告给出适用任务上的结果。可以从任一问题沿链接追溯到相应材料。

证据：[公开实现与模块说明](https://github.com/changer-changer/PilotDeck-Verified-Subtasks/blob/main/README.md#改了哪里) · [真实录像与验收报告](https://github.com/changer-changer/PilotDeck-Verified-Subtasks/blob/main/docs/verified-subtasks/evidence/ui-recording-20260911/README.md) · [修订版统计报告](statistics-report.html)
