# 现场演示：运行改版 PilotDeck 本体

方向三作品是底层升级。独立 Demo 属于选择性提交项；原生软件的真实执行链是现场主线。

开场：“原来子任务说完成，主任务还得自己检查。现在 PilotDeck 按契约检查实际文件，不合格就让原子任务继续修复，成功的任务不用重做。”

## 演示前

按根 README 安装依赖并构建，准备可用的智谱 Coding Plan 凭据。

```bash
node --import tsx scripts/verified-subtasks-native.ts ui --opencode-auth
```

仅在已经用 OpenCode 登录 Coding Plan 时使用 `--opencode-auth`；否则通过 `ZHIPU_API_KEY` 提供凭据并省略该选项。凭据不写入演示产物。

启动器创建新的 `artifacts/native-*/`：`workspace/` 有源数据和三份报表，`acceptance.json` 是宿主检查规则，`pilot-home/` 是隔离配置，`现场任务.txt` 是任务。原有工作目录与配置不被改写。在原生界面选中打印出的 workspace 路径、新建任务。界面只监听本机。

## 双层评审主展示

使用兼容 OpenAI 的比赛模型时，先设置 `PILOTDECK_DEMO_BASE_URL`、`PILOTDECK_DEMO_API_KEY`、`PILOTDECK_DEMO_MODEL`，再运行：

```bash
node --import tsx scripts/verified-subtasks-native.ts ui --semantic-fault
```

本机持有操作者提供的私密比赛配置时可加 `--competition-auth`，显式读取 `~/.config/pilotdeck-competition/credentials.json`；该文件不在仓库中。公开复现推荐使用上述环境变量。

1. 打开原生 **设置 → Agent → 交付评审**，展示默认跟随主对话，也能单独选模型。
2. 展示 `briefing-source.json`：供应商延期七天，影响十八单。现有 `briefing.json` 的三个字段齐全，却说“一切正常、无需跟进”。这是明确的故障注入。
3. 提交任务。三份正确报表通过；简报的结构检查通过，独立评审模型读取实际文件和来源后指出业务问题。
4. 同一个简报子任务根据问题修复文件，再次经过两层验收。查看具体风险、采购负责人、下周一截止时间和备选供应商行动。
5. 核对另外三份报表的文件与修改时间保持不变。解释收益是把问题留在失败子任务内解决；模型复核自身会增加调用与时延。

预演使用 `live --semantic-fault`，可同样加凭据选项。准备好的成功事件仅用于备用回放，现场必须区分回放与实跑。

## 第一层演示（数值故障）

1. 展示 `sales.json` 中错误的 196；源数据 48、63、75 合计 186。明确这是预置错误，另外两份报表正确。
2. 粘贴 `现场任务.txt`。三个子任务读取现有报表并按契约提交，按正常提示允许文件操作。
3. 看销售子任务的验收问题、局部修复和再次通过；库存与退款直接通过。修复保留同一子任务，不重新派发兄弟任务。
4. 打开修正后的销售文件（186），核对库存（48）和退款（12）。结合事件解释完成与验收通过的区别。

模型延迟会影响时长。要保留失败原因和修复过程，说明结果为什么可信。

## 预演与自动核对

```bash
node --import tsx scripts/verified-subtasks-native.ts live --opencode-auth
```

从 `createLocalGateway → submitTurn → agent → SubAgentSession` 运行同一原生链，真实调用模型和文件工具。只给隔离会话授权 `agent/read_file/write_file/edit_file`，保留默认路径检查。

`native-results.json` 和 `gateway-events.json` 保存事件、文件哈希与修改时间。数值场景核对销售修复、两份成功文件内容和修改时间不变、三个最终验收通过。语义场景额外核对模型确实读取简报并拒绝、四个最终通过、三份成功报表保持不变，以及修复后的业务要点。网关集成验证不能代替浏览器可视验收。

比赛 GLM-5.3 最新预演用时 160.474 秒，现场建议预留 3–5 分钟。先用约一分钟说明错误与验收设置，执行中展示实际读取和问题反馈，最后查看修复产物与成功报表；该时长只作排练参考，网络与模型响应会变化。

## 网络异常备用

保留一次成功预演的原始文件和事件。也可运行离线机制实验：

```bash
node --import tsx scripts/verified-subtasks-benchmark.ts artifacts/offline-demo
node --import tsx scripts/verified-subtasks-viewer.ts artifacts/offline-demo
```

生成的 index.html 是轨迹回放，须说明模型响应是脚本化故障注入。15→9 请求来自这个三任务实验，不能宣称自然模型成功率。

公开仓库与 README 说明改动和运行方式；海报解释一条失败修复路径；原生现场执行证明核心链；性能原始数据、限制和设计图支撑结论。方向三功能视频为加分材料，不是必交的 1–2 分钟视频。
