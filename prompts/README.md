# prompts/ · 版本化提示词目录（W3）

**改提示词不改代码**：所有 AI 提示词在这里维护，带版本号与变更说明。

## 目录

| 文件 | 用途 | 版本 |
|---|---|---|
| `system_simplify.ts` | 修订候选 system（词库边界/黑名单/输出格式） | v1.1 |
| `system_draft.ts` | 整章简化 system（逐段改写，占位符见 manifest） | v1.1 |
| `system_assistant.ts` | AI 助手身份与工具调用协议 | v1.0 |
| `rewrite_sentence.ts` | 逐句改写 user 模板 | v1.2 |
| `manifest.ts` | 版本清单与变更记录（`setVersion` = 整套版本，写入成本台账/建议台账；字符串形式供 parseManifest） | v1.6 |

## 加载顺序

1. **教师自定义**：`~/Documents/LayerText配置/prompts/<名字>.md` 存在则优先生效（版本记为 `v1.0*`）；
2. **内置**：本目录文件随应用打包。

CLI 评测（`src/eval.ts`）与桌面应用 **import 同一份 TS 常量**——单一正本，不存在两处漂移。

> 2026-09-16：提示词从 `.md?raw`（vite 专属，node 无法加载）内联为 `.ts` 字符串常量——
> 桌面应用、CLI 评测、node 测试三条链从此同源同载。教师自定义覆盖机制不变（仍按 `.md` 文件名匹配）。

## 修改流程

1. 改 `.ts` 文件里的字符串常量（占位符 `{{xxx}}` 保留，由代码填充——不知道有哪些占位符就看 manifest 的 desc）；
2. 在 `manifest.ts` 字符串里同步 `prompts.<name>.version` 与 `changelog`（bump 并写一句变更说明）；
3. `npm test && npm run eval` 全绿（AI 输出质量看 eval 的 key 模式）；
4. 应用建议台账/成本台账从下一行起自动记录新版本号，复盘页可对比版本间采纳率。

> 红线提醒：提示词同样受"教师握定稿权"约束——不得在提示词中加入"直接修改文件""跳过确认"类指令；
> 直改行为只由应用内开关（trustEdit/autoRewriteOnMark/inPlaceEdit）控制，与提示词无关。
