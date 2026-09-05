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

## 当前状态

| 里程碑 | 内容 | 状态 |
|---|---|---|
| M1 | QC 引擎 TypeScript 移植 + CLI + 与 Python 原型对照测试 | ✅ 完成（21/21 回归测试，双引擎 76/76 字段一致） |
| M3（先行） | macOS 应用安装包（Tauri 2 · Universal dmg）：导入 → 质检报告 → 三态高亮正文 | ✅ v0.1 先行版 |
| M2 | 审校工作台（点词/划句标记、配额、门禁、多版本、修订执行） | 🚧 下一版 |
| M4 | GitHub Release v0.1.0 | ⏳ |

详见 [docs/M1-对照测试报告.md](docs/M1-对照测试报告.md) 与 [路线图](#路线图)。

## 安装（macOS）

1. 下载 `LayerText_0.1.0_universal.dmg`（[Releases](../../releases) 页，或本地构建见下）；
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
npm test        # 21 项防坑规则回归测试

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

- `examples/texts/` 全部为本项目**自写文本（CC0）**，含一个刻意覆盖全部防坑规则的
  [torture test](examples/texts/qc_torture_test.md)；
- 内置词表来自《义务教育英语课程标准（2022年版）》三级词汇表存档
  （`assets/wordlists/`，由 `tools/convert_wordlist.py` 展开为纯文本格式）；
- 自定义词库 CSV 格式样例：`examples/vocab/sample_teaching_vocab.csv`。

## 仓库结构

```
src/core/    QC 引擎（纯 TypeScript，无框架依赖：irregular / lexicon / textpipe / qc / risks）
src/cli.ts   命令行入口
app/         macOS 桌面应用（Tauri 2：前端 Vite + 主进程 Rust，复用 src/core）
tests/       防坑规则回归测试（node:test）
tools/       qc_chapter_ref.py（Python 参照版）、convert_wordlist.py、compare.ts（对照测试）
docs/        QC 指标说明、M1 对照测试报告
assets/      内置词表
examples/    示例文本与示例词库（全部自写，CC0）
```

## 方法论

**AI 只出候选，教师握定稿权；一切修改留痕。** 本工具源自一个真实项目（英文原著三难度层
全书调适）的完整原型验证：七步流程、双闸质检、人机分工。简化建议永远以"候选"呈现，
应用与否由教师决定，每一次修改写入变更日志（轮次/位置/修改前后/规则号/依据）。

## 路线图

- **M2** 审校工作台：三态高亮正文、点词/划句标记面板、配额打勾表、终审门禁、多版本 tab、
  标记防抖自动落盘、修订对照表与批量应用
- **M3** macOS Universal dmg（不签名公证，首次打开右键→打开）
- **M4** Release v0.1.0
- **P1** AI 简化候选（OpenAI 兼容 API，key 存本地钥匙串）、分层版本并排对照、跟读 TTS 导出

## 许可

[MIT](LICENSE)。示例文本以 CC0 奉献。
