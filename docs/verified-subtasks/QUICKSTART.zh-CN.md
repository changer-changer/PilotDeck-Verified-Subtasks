# 现场演示：极简操作

1. 按[仓库 README](../../README.md#安装与启动)安装依赖，设置 `PILOTDECK_DEMO_BASE_URL`、`PILOTDECK_DEMO_API_KEY`、`PILOTDECK_DEMO_MODEL`。
2. 在仓库目录运行（Linux / macOS）：

   ```bash
   env -u SERVER_PORT -u VITE_PORT -u PILOTDECK_GATEWAY_PORT -u PILOTDECK_GATEWAY_URL \
     PILOTDECK_GATEWAY_PORT_BASE=18791 \
     node --import tsx scripts/verified-subtasks-native.ts ui --semantic-fault --acceptance-memory
   ```

3. 打开终端中 `Local:` 后的地址，选择本轮 `workspace`。
4. **Settings → Acceptance & review**：开启评审，模型选 **Follow main conversation**，开启保存验收经验。
5. 返回主界面，顶部 **Files** → 底部 **Files**：打开 `briefing-source.json` 与 `briefing.json`，对比“延期 7 天、影响 18 单”和“供应稳定”。
6. 打开终端打印的 `taskFile`，复制全文到聊天并发送；如出现权限提示，允许本次演示的文件操作。
7. 等待结束，展开“供应风险简报”，查看拒绝与修复；打开修复后的 `briefing.json`，确认四份交付通过。
8. **Explore → Memory → 子任务验收经验**：查看观察记录。重演时终端按 **Ctrl+C**，从第 2 步开始。

[播放或下载录像](https://github.com/changer-changer/PilotDeck-Verified-Subtasks/releases/tag/demo-recording-20260911)：播放版 1 分 58 秒；完整实录 9 分 47 秒。无旁白；播放版有中文字幕与倍速标记。网络异常时直接播放录像。
