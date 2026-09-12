# 统计实验包 · 复核与复跑

先看 `报告.html`。本包整理 2026-09-11 至 09-12 已完成的实验；本次材料修订没有新增实验。统计只测 L1 确定性验收与修复，未启用 L2 模型评审。

## 不调用模型，复核已有数据

在解压后的 `pilotdeck-statistics/` 内运行：

```bash
sha256sum -c SHA256SUMS
python3 audit-existing.py .
```

复核脚本只读 `runs/`，重算 A/B 总数、成功数、McNemar 精确 p 值、B/C 和 B/D 的匹配子集，以及 E 事后选择。四模型 A/B 合计 1,450 对；C、D 各 1,000 条。脚本不接模型、不改原始文件。

## 在新目录复跑模型实验

需要 Node.js 22.13–22.x、pnpm 10.32.1、Python 3、本机 Ollama，以及相应模型。以下命令会产生新的模型调用与数据，不覆盖包内记录。运行时/GPU/量化变化和无固定种子的修复采样，可能让结果不同；不承诺逐位复现。

把公开仓库与解压后的 `pilotdeck-statistics/` 放在同一父目录。从该父目录开始：

```bash
git clone https://github.com/changer-changer/PilotDeck-Verified-Subtasks.git PilotDeck-repro
cd PilotDeck-repro
git checkout 8e8c57b0659b5654f447cc61ed5b865dbb473d2d
corepack enable
pnpm install --frozen-lockfile
cp ../pilotdeck-statistics/scripts/verified-subtasks-stats*.ts scripts/

export VERIFIED_SUBTASK_MODEL='llama3.2:3b'
export VERIFIED_SUBTASK_OLLAMA='http://127.0.0.1:11434'
export VERIFIED_SUBTASK_REPAIR_TEMP='0.7'
unset VERIFIED_SUBTASK_COT_FEEDBACK
node --import tsx scripts/verified-subtasks-stats.ts run artifacts/repro-llama32 ../pilotdeck-statistics/校准记录/config-main-llama.json
node --import tsx scripts/verified-subtasks-stats.ts blind artifacts/repro-llama32 100
node --import tsx scripts/verified-subtasks-stats.ts blind1 artifacts/repro-llama32 100
node --import tsx scripts/verified-subtasks-stats.ts analyze artifacts/repro-llama32
```

模型环境变量必须保持到 `blind` / `blind1` 结束，否则脚本会回退默认模型。上面 Llama 的 A/B 为每任务族 150 题，C/D 为每族 100 题。若需要单独复跑错误画像的首答采集，可另执行 `probe artifacts/repro-llama32 ../pilotdeck-statistics/校准记录/config-main-llama.json`，也会调用模型。

| 模型 | VERIFIED_SUBTASK_MODEL | 配置文件 | C/D 每配置单元上限 |
|---|---|---|---:|
| Llama 3.2 3B | llama3.2:3b | config-main-llama.json | 100 |
| MiniCPM5 1B Q4 | hf.co/openbmb/MiniCPM5-1B-GGUF:Q4_K_M | config-main-minicpm.json | 100 |
| Qwen2.5 1.5B | qwen2.5:1.5b | config-main-qwen15.json | 50 |
| Qwen2.5-Coder 7B | qwen2.5-coder:7b | config-main-qwen7b.json | 50 |

具体模型 tag 以各 `runs/<model>/results.json` 中的 `model` 字段为准；复制命令时同时修改模型、目标目录与配置文件。校准记录保留原难度选择，不要求重跑校准才能复核既有结果。

## 包含什么

- `runs/`：结果、C/D 候选、首答 probe、原始分析与字段画像。
- `evalset/`：任务提示与标准答案，生成器基础种子 20260911。
- `校准记录/`：难度校准与主实验配置。
- `scripts/`：既有实验 runner 与生成器/统计辅助文件；保留实验时源代码。
- `audit-existing.py`：本次新增的离线数据复核脚本，不属于 PilotDeck 运行时。
- `core-version-map.json`：本机实现、实验分支与可解析公开版本的核心文件指纹映射。
- `SHA256SUMS`：本包校验和。

版本口径：实验源实现为本机 `5c9dc81`，实验脚本版本为 `3eb0484`；公开仓库基线为 `8e8c57b0659b5654f447cc61ed5b865dbb473d2d`。三者不是同一 Git 历史，不能用本机哈希在公开仓直接 checkout。包内映射逐文件证明所对照核心的一致性。

原始 37 份数据文件保留原字节，包括旧 `analysis.json` 的注释、`taxonomy.json` 的历史标签和开发机路径。它们是历史记录；当前数据解释、B/C/D 配对子集口径以修订后的报告和独立复核为准。E 是用标准答案事后分析，不是第五批独立执行；其请求均值是反事实早停值。

[公开数据 Release](https://github.com/changer-changer/PilotDeck-Verified-Subtasks/releases/tag/statistics-20260912)
