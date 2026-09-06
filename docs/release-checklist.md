# 发布前检查清单（逐项过完才打 tag）

> 发版前把这份清单从头到尾过一遍。任何一项不过 → 不发版。
> 口径以"第一次拿到 dmg 的英语教师"为准，不是以开发者为准。

## 1. 质量门禁

- [ ] `npm test` 全绿（当前基线 56 项）
- [ ] `npm run eval` 输出"✓ 不低于质量基线"（若规则有意变更：已 `--update-baseline` 并书面说明理由）
- [ ] `node dist/tools/compare.js` 双引擎一致
- [ ] `cd app && npx tsc --noEmit` 无错误
- [ ] `cd app && npx vite build` 成功

## 2. 版本与文档

- [ ] 版本号三处一致：`package.json` / `app/src-tauri/tauri.conf.json` / `app/index.html` 的 `<small>`
- [ ] `CHANGELOG.md` 已有 `## [X.Y.Z] - 日期` 段落（Release 正文从这里提取，缺段落工作流会失败）
- [ ] `README.md` 路线图与当前状态一致（无把已交付功能列为待办）
- [ ] 涉及提示词变更：`prompts/manifest.json` 已 bump 版本并写变更说明

## 3. 产物验证

- [ ] CI 绿（Release 工作流会再跑一遍门禁，但别浪费一次 tag）
- [ ] Release 页出现的 dmg 可下载、可安装（首次右键→打开→打开）
- [ ] Release 正文是 CHANGELOG 对应段落（不是空的或错版本）

## 4. 新手首开路径（换位 walkthrough）

- [ ] 新机器/删除 `~/.layertext.json` 后首启动：欢迎三步向导能走完（含"跳过"路径）
- [ ] 载入示例 → 一键质检 → 看到报告与 OOV 清单 → 正文三态高亮 → 点词/拖选做标记
- [ ] 不配 AI Key 时：质检与标记全流程可用，AI 入口给"去配置"引导而非报错堆栈
- [ ] 配了 AI（可用任一预设）：一次"✨ AI 审核建议"能出候选，点 ✓ 生效且变更日志/台账落盘

## 5. 发布后

- [ ] 在 GitHub Release 描述里附一行已知问题（如有）
- [ ] 真实使用中发现的问题 → `docs/复盘模板.md` 记一轮 → 归入下个版本
