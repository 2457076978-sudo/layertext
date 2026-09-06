# LayerText 分层读

**Tiered English text simplification & review workbench** — 把"一篇英文原著简化成不同难度版本给学生读"
从混乱的手工流程，变成有质检、有人机协作审校、全程可审计的桌面工具。

> LayerText (分层读) turns "simplifying an English book into tiered versions for my students"
> from a messy manual process into a tool with automated quality checks, human-in-the-loop
> review, and a full audit trail.

**给谁用**：把英文原著/分级文本改编成多个难度层的英语教师。全离线、数据本地存储、零遥测。

## 核心工作流

```
导入原文（.txt/.md，按章切分）
   → 配词库（内置课标2022三级1600词 ∪ 教材已学词CSV ∪ 术语表）
   → 自动质检 QC（生词率/句长/被动/定从/过去完成/专名一致性……）
   → 审校工作台（点词划句标记，AI 只出候选、教师握定稿权）
   → 标记执行（修订对照表 → 确认 → 批量应用，每处留痕）
   → 版本与审计（变更日志 CSV、版本 diff）
   → 导出（md/docx 含章末词句卡）
```

## 当前状态：v1.0.0 ✅

| 能力 | 说明 |
|---|---|
| 任意导入 | .md / .txt / **.docx**（Word 直接打开自动转章节格式） |
| 自动质检 | 生词率/覆盖率/句长/被动/定从/过去完成/专名一致性 + OOV 清单，报告自动落盘 |
| 审校工作台 | 三态高亮正文、点词/拖选标记（7+8 类）、要点配额、终审门禁、标记清单跳转 |
| AI 分层初稿 | 按 B/M/A 逐段整章改写（方向指令+词库边界+黑名单约束），生成后自动质检 |
| AI 修订候选 | 标记→建议（对话/批量/逐句）→**正文行内对照**→点 ✓ 采纳（原稿不覆盖，工作稿+变更日志留痕） |
| AI 助手 | 右侧流式对话，AI 调用本地工具（跑质检/查句子/提候选），每条建议经引擎复核 |
| 新手友好 | 首启动向导、四步导览、AI 服务商预设+Key 教程、错误人话化、分层标准可调、本书配置随文件夹 |
| 导出 | Word 版（含章末词句卡）/ 朗读音频（系统语音）/ 标记 JSON / 变更日志 CSV |
| 版本对比 | 双版本逐段 diff（原文 vs 初稿 vs 工作稿） |

引擎质量：**43 项回归测试全绿**（防坑规则 + 审校 DOM + 应用逻辑）；TS 引擎与 Python 原型在示例与真实章节上逐字段一致（[M1 对照报告](docs/M1-对照测试报告.md)）。
产品文档：[PRD（一页）](docs/PRD.md) · [CHANGELOG](CHANGELOG.md) · [工程化开发提示词](docs/工程化开发提示词_v1.0.md)。

## 安装（macOS）

1. 下载 `LayerText_1.0.0_universal.dmg`（[Releases](../../releases) 页，或本地构建见下）；
2. 双击打开 dmg，把 **LayerText** 拖入"应用程序"文件夹；
3. 首次打开：**右键 → 打开 → 再点"打开"**（开源个人项目未做苹果签名公证，此提示属正常）。

本地构建 dmg：

```bash
npm install && cd app && npm install
npm run tauri build --target universal-apple-darwin
# 产物：app/src-tauri/target/universal-apple-darwin/release/bundle/dmg/*.dmg
```

## 图形界面（v0.1 先行版）

打开应用后三步上手：

1. 点 **「载入示例」**（或"打开章节文件…"选择自己的 md/txt）；
2. 点 **「▶ 开始质检」**，查看指标报告（覆盖率/生词率/句长/被动/定从/过去完成/专名一致性…）与 OOV 生词清单；
3. 切到 **「正文」** 页看三态高亮：词表外（红点）/待定词（橙点）/术语（蓝点），风险句淡红底并带「被/从/完/长」角标。

报告自动落盘：文件模式存到源文件同目录，示例模式存到 `文稿/LayerText质检报告/`。

## 命令行（CLI）

```bash
git clone https://github.com/<your-org>/layertext.git
cd layertext
npm install
npm test        # 43 项回归测试（防坑规则 + 审校 DOM + 应用逻辑）
npm run eval    # 金标准评测：黑名单命中率/OOV 对齐 vs 质量基线（低于基线退出码 1）

# 对示例文本跑一次质检（报告自动落盘到文本同目录）
node dist/src/cli.js qc examples/texts/aesop_tortoise_hare.md --tier M

# 使用自定义教材词库
node dist/src/cli.js qc examples/texts/school_story_club.md \
  --vocab examples/vocab/sample_teaching_vocab.csv
```

## QC 指标：为什么这些句法是"黑名单"

被动语态、定语从句、过去完成时按初中教学进度属于未学/后学结构，出现在低难度层即计为风险；
引语豁免、假阳性豁免、词形还原等防坑规则的完整说明见
[docs/QC指标说明.md](docs/QC指标说明.md)。

## 示例数据与版权

- `examples/texts/` 与 `examples/evals/`（金标准评测集）全部为本项目**自写文本（CC0）**，
  含一个刻意覆盖全部防坑规则的 [torture test](examples/texts/qc_torture_test.md)；
- 内置词表来自《义务教育英语课程标准（2022年版）》三级词汇表存档
  （`assets/wordlists/`，由 `tools/convert_wordlist.py` 展开为纯文本格式；
  存档缺失的数词/星期/月份等基础词由 `curriculum_2022_amendment.txt` 补录，见 W1 交付报告）；
- 自定义词库 CSV 格式样例：`examples/vocab/sample_teaching_vocab.csv`。

## 仓库结构

```
src/core/    QC 引擎（纯 TypeScript，无框架依赖：irregular / lexicon / textpipe / qc / risks）
src/cli.ts   命令行入口
app/         macOS 桌面应用（Tauri 2：前端 Vite + 主进程 Rust，复用 src/core）
tests/       防坑规则回归测试（node:test）
tools/       qc_chapter_ref.py（Python 参照版）、convert_wordlist.py、compare.ts（对照测试）
docs/        PRD、QC 指标说明、M1 对照报告、工程化提示词、交付报告（docs/reports/）
assets/      内置词表
examples/    示例文本与示例词库（全部自写，CC0）
```

## 方法论

**AI 出候选为主、可选直改为辅；教师握定稿权，一切改动留痕。** 本工具源自一个真实项目（英文原著三难度层
全书调适）的完整原型验证：七步流程、双闸质检、人机分工。默认模式下 AI 建议以"候选"呈现、由教师逐条采纳；
教师也可在设置中开启直改模式（标记即改写 / 信任模式 / 原地编辑原稿）——无论哪种模式，每一次修改都写入
变更日志（轮次/位置/修改前后/规则号/依据），原稿可随时还原（原始备份或工作稿），AI 的每处改动均可追溯。

## 路线图

**已交付 ✅**

- QC 引擎（M1）：21 项防坑规则、TS 与 Python 参照版逐字段对照一致
- macOS 应用（M3 先行）：Tauri 2 · Universal dmg
- 审校工作台（M2）：三态高亮、点词/划句标记、配额、终审门禁、标记自动落盘
- AI 审核建议闭环（v0.4–0.6）：标记→建议→行内对照→采纳留痕
- AI 助手侧栏（v0.5）：本地工具调用（跑质检/查句子/提候选）
- 分层初稿（v0.7）：整章按方向逐段改写 + 自动质检
- 新手可用性（v0.8–v1.0.0）：首启动向导、四步导览、服务商预设、人话错误、任意导入、导出、版本对比
- 书级改写规则（v1.0.0）：人名替换/叙事视角随书稿文件夹生效
- AI 直改体系（v1.0.0）：标记即改写、信任模式、原地编辑原稿（首改自动备份）

**进行中 🚧**（工程化 W0–W5，见 [docs/工程化开发提示词_v1.0.md](docs/工程化开发提示词_v1.0.md) 与 [CHANGELOG](CHANGELOG.md)）

- W0 文档校准与版本对齐 ✅
- W1 金标准评测集 + `npm run eval` + 质量基线 ✅
- W2 采纳率数据闭环（分析脚本 + 应用内复盘页）✅
- W3 提示词版本化 + 供应商 failover + 成本台账 ✅
- W4 CI / Release 流水线 + 发布流程文档 ✅（首次推送 GitHub 后实跑验收）
- W3 提示词版本化 + 供应商 failover + 成本台账
- W4 CI / Release 流水线 + 发布流程文档
- W5 诊断包导出 + 本地错误日志 + 复盘模板

**规划 📌**（素材库，未立项；实现前先过红线检查）

- 内容生产：全书进度看板（章×层质检/审校/终审矩阵）、整本书流水线（逐章排队 AI 初稿，人只处理卡住的章）、书架式多书管理、层数自定义（入门层）、跨章词汇复现统计、AI 出题（阅读理解/词汇练习，沿用候选-采纳-留痕）
- 研究侧（课题向）：分层质量档案（指标随版本演进曲线，一键导出课题数据表）、B/M/A 同段改写策略对照报告、改写策略标签库（拆句/换词/去被动/释义/合并）
- 界面体验：三区定锚布局、阶段步骤条常驻、高亮密度自动降噪、diff 同句连线对齐、投屏演示模式、指标"数字+人话判读"成对、纸面打印预览

## 许可

[MIT](LICENSE)。示例文本以 CC0 奉献。
