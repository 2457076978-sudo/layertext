# 发布前检查清单（逐项过完才打 tag）

> 发版前把这份清单从头到尾过一遍。任何一项不过 → 不发版。
> 口径以"第一次拿到 dmg 的英语教师"为准，不是以开发者为准。

## 1. 质量门禁

- [ ] `npm test` 全绿（当前基线 1108 项：1106 过 / 2 跳过——2026-09-18 尺子收口轮起）
- [ ] `npm run eval` 输出"✓ 不低于质量基线"（若规则有意变更：已 `--update-baseline` 并书面说明理由）
- [ ] `node dist/tools/compare.js` 双引擎一致
- [ ] `cd app && npx tsc --noEmit` 无错误
- [ ] `cd app && npx vite build` 成功

## 2. 版本与文档

- [ ] 版本号四处一致（`node tools/check_versions.mjs`）：根 `package.json` / `app/package.json` / `app/src-tauri/tauri.conf.json` / `README.md` 当前状态
- [ ] `CHANGELOG.md` 已有 `## [X.Y.Z] - 日期` 段落（Release 正文从这里提取，缺段落工作流会失败）
- [ ] `README.md` 路线图与当前状态一致（无把已交付功能列为待办）
- [ ] 涉及提示词变更：`prompts/manifest.json` 已 bump 版本并写变更说明

## 3. 产物验证

- [ ] CI 绿（Release 工作流会再跑一遍门禁，但别浪费一次 tag）
- [ ] Release 页出现的 dmg 可下载、可安装（首次右键→打开→打开）
- [ ] Release 正文是 CHANGELOG 对应段落（不是空的或错版本）
- [ ] **GUI 自动化验证（截图/走查）依赖屏幕解锁**——锁屏时截图全黑、辅助操作失效；无人值守环境不要安排 GUI 验证步骤（欠账#5，2026-09-07 写入）
- [ ] **无 UI 环境（SSH/CI）打包 dmg 必须用 `hdiutil create`**——tauri 自带 bundle_dmg.sh 依赖 GUIAppleEvents，无用户会话会失败（欠账#5）

## 4. 新手首开路径（换位 walkthrough）

- [ ] 新机器/删除 `~/.layertext.json` 后首启动：欢迎三步向导能走完（含"跳过"路径）
- [ ] 载入示例 → 一键质检 → 看到报告与 OOV 清单 → 正文三态高亮 → 点词/拖选做标记
- [ ] 不配 AI Key 时：质检与标记全流程可用，AI 入口给"去配置"引导而非报错堆栈
- [ ] 配了 AI（可用任一预设）：一次"✨ AI 审核建议"能出候选，点 ✓ 生效且变更日志/台账落盘

## 5. 发布后

- [ ] 在 GitHub Release 描述里附一行已知问题（如有）
- [ ] 真实使用中发现的问题 → `docs/复盘模板.md` 记一轮 → 归入下个版本

---

## 走查记录 · v1.3.0（2026-09-18，本地就绪待推）

按上方清单逐项过：

1. **质量门禁**：`npm run verify` 全绿（1108 项：1106/0/2，含 eval 基线与双引擎 76/76）；
   `USER=runner npm run verify` 复现 CI 条件全绿；`cd app && npx tsc --noEmit` 与 `npx vite build` 均过。
2. **版本与文档**：五处版本一致（`node tools/check_versions.mjs` = 1.3.0）；`CHANGELOG.md` 已收敛为
   `## [1.3.0] - 2026-09-18`（95 个未发布批次降为 ### 小节，分支 6 节原样保留在引块），
   `tools/extract_changelog.mjs 1.3.0` 取到 2310 行正文（tests/changelog.test.ts 锁）；
   README 路线图与当前状态一致（S1 已清理已交付项）；本轮无提示词变更（prompts/manifest 未动，N/A）。
3. **产物验证**：**CI 绿 / Release dmg / GUI 走查三项依赖 push+tag，列为发版闸门项等作者发话**
   （本仓 github.com 需网络绕行，且 09-16 起 25 提交未 push——推完后按本清单 3/4 节补走）。
4. **新手首开路径**：本轮改动限于终审门禁弹层与核对表行，未动首开流程；装机版走查随 dmg 发版做。

结论：**本地就绪待推**——tag 与 push 等作者发话（惯例：GitHub 冻结由 Wayne 拍板）。
