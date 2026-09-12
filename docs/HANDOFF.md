# LayerText 工程交接（总优化轮）

## 本轮状态

工作在独立分支 `codex/total-optimization`，基线为 `546c3cc`。未 push、未 release、未打 tag；未读取或修改 AnimalFarm 真实教学资产。

本轮核对了当前发布闭环与运行身份实现。发布脚本已经具备缺件拒绝导出、多层决定日志汇总、半成品学生版默认拒绝发布等保护；这些逻辑位于 `tools/af_pipeline/LayerText_AF发布包.mjs`。教师稳定 ID、章节解析、任务实验等模块已在基线中存在。

## 仍需关注

- `清单_最新.json` 是兼容入口，任何未显式指定 run 的发布/恢复流程都应继续保持歧义拒绝；多教师并发验收需在独立目录跑一次。
- `--allow-partial` 是显式例外，发布包描述必须保留 partial 声明。
- 四格 AI 实验和真实教师任务实验仍是产品效果证据，不能由单元测试替代。
- `.mjs` 的 TDZ 风险无法由 tsc 覆盖，继续保留真子进程 smoke test。

## 验证

本轮已执行前端/引擎检查（见最终工作总结）。提交前应在干净 checkout 再执行：

```bash
npm run verify
npm run verify:rust
cd app && npm run build
```
