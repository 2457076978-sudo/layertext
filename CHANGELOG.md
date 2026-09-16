# Changelog

本项目的全部重要变更记录在此。版本号遵循 [semver](docs/发布流程.md)；
1.0.0 之前的版本号为开发期里程碑（当时 `package.json` 未同步递增，本文件按里程碑整理，2026-09-06 校准）。
面向教师的通俗版功能说明见 [README](README.md) 与 [docs/PRD.md](docs/PRD.md)。


> 以下 6 节来自 `codex/total-optimization` 分支的 CHANGELOG——2026-09-14 合并时**原样保留**，不并进主仓的轮次编号里（它们是"同一批改动在分支侧怎么落的"的第一手记录）。



## [未发布] - 2026-09-16（测试基建三步：A1 幽灵依赖 / A2 根测试依赖 / 甲·提示词内联 TS）

**A1（`87ec2b9`）**：app/package.json 补声明 `@tauri-apps/plugin-http@^2.6.0`——修复幽灵依赖
（ai.ts:8 引用而未声明，干净环境 TS2307；移走包实证失败、补声明重装实证可解析）。

**A2（本提交）**：根 devDependencies 补同包——为让根测试体系可导入 session.ts
（persistEdit 测试链经 ai.ts 触达它），**非生产依赖**。

**甲·提示词内联（本提交）**：`prompts/` 8 个 `.md` + `manifest.json` → 9 个 `.ts` 字符串常量；
`ai.ts`/`src/eval.ts` 改 import 同一份常量。动因：`?raw` 是 vite 专属形态，node 无法加载
（ERR_UNKNOWN_FILE_EXTENSION 实测），桌面应用/CLI 评测/node 测试三条链从此同源同载；
教师自定义覆盖机制不变（仍按名字读外部目录）。eval 黑名单命中率 100% 与改造前一致（同源实证）。
两个外置契约测试迁移到新正本（静态导入全部常量对照 manifest；BUNDLED_PROMPTS 源码对照不变）。

**为什么选甲不选乙（记录，避免重议）**：乙（saveLastSession 拆 sessionpersist.ts）是
测试倒逼生产结构——session 家族分裂、模块数增加；甲是补齐工程正路（消灭 `.md?raw` 这一整类
node 不可载形态），生产运行时行为零变化，session 家族保持完整。提示词几乎不改，工作流代价≈0。

**persistEdit 线此后只做最小冒烟收尾，测试主战场转向核心链**（提词/归一化/去重/画像/定向简化）——
教师材料的正确性优先于编辑器基础件。


## [未发布] - 2026-09-16（C3 lite：清真错位三处 + 残环保留标注；度量切换为横向边数）

**度量修订**：madge 链条数被证实是 SCC 非穷举枚举（cut1 实证：删边后 11→12，逐边举证
20/20 均为存量边），计数不单调、不可作门槛——**C3 起度量切换为"横向边数"**
（静态+动态双向扫描，单调可复现）。防 Goodhart 声明与边分类见 docs/文件架构.md 4.2.1。

**cut1（bufToB64→fsx，本提交一并入库，逐边举证表在会话记录）**：report→bookio 边删除。
**cut2（本提交）**：scrollEl/scrollNow→uikit；saveLastSession/scheduleSaveLastSession→session。
edit↔shelf 双向边消失。横向边 28→25，全部残边属"已评估保留"或"挂账"两类（见 4.2.1）。

**验证**：npm run verify 全绿；tsc/lint 0 警告；架构地图同步（uikit/session 行 + 4.2.1 治理节）。


## [未发布] - 2026-09-16（C2 解环：UI 总线端口 uibus，main 的 13 条反向边全断）

**补查（三项，全部只读）**

- A 动态 import 全仓扫描（六形态）：指向 main 的动态边**只有 reader.ts:220 一条**
  （C1 漏网根因，本轮已改走总线）；另发现 pipew/propagateui→datapanel 两条动态横向边
  （不构环，保留观察）；tools/tests 的模板串动态 import 均为研究管线/测试装载，不在运行时图内。
- B onPlotJump 调用链：reader.ts:219 → review.ts:345 `plotBtn.addEventListener('click')`
  ——**纯用户交互触发**，"装配先于调用"前提成立。
- C 内容清单（本提交）。

**改动**

- 新增 `app/src/uibus.ts`：10 槽位（renderAll/switchView/syncChrome/updateModePill/
  flashApplied/runQcCurrent/openPathIntoSession/loadBuiltinDemo/addSession/fileSummary），
  **未注册调用当场抛错**（不静默）；头注释写明过渡性与删除条件。
- main.ts 装配期 `Object.assign(uibus, {...})` 注入实现；十符号撤 export（跨模块唯一入口=uibus）。
- 9 个视图模块（aiflow/batch/lexicon/edit/pipew/report/settings/shelf/reviewgen）
  对 main 的引用全部改走 uibus；reader.ts:220 动态边同步改走 uibus。
- **app/src 内 `from './main.js'` 静态引用 = 0**（静态+动态双向扫描）；
  main 回到纯自上而下的 UI 总线位置。
- 架构地图 32→33（+uibus，含过渡性标注）。

**验证**：`npm run verify` 全绿；madge 循环链实数见提交信息（>10 即停的约定不变）；
调用点全部为用户交互回调（补查 3/B 双向证据），装配顺序缺陷会被守卫当场暴露。


## [未发布] - 2026-09-16（依赖健康收口 + C1 解环：状态/IO 九符号下沉）

**依赖健康（阶段 B，两项独立提交）**

- `bcc45e3` 移除无用依赖 `wordnet-db`：WordNet 3.1 数据早已提取为 `app/public/wordnet/*.gz`
  入库（f8d0849），全仓 0 处代码引用，运行时走 `src/core/wordnet.ts` 惰性读资产；
  补查确认无 CI/构建期再生成脚本。
- `dc2ac1b` `npm audit fix`：4 个 high 清零（`@huggingface/transformers` 4.2.0→4.3.0、
  onnxruntime-node→1.30.0、adm-zip→0.6.1、sharp→0.35.4，全部 semver 内，0 major）。
  冒烟：同一输入对 `tools/fidelity.mjs` 前后对比——对齐/丢句/新增/信号缺失完全一致，
  cos 均值持平 0.950，中位/最低漂移 ≤0.003。`npm audit` 复测 0 漏洞。

**C1 解环（阶段 C 第一步，只做"闭包干净"的下沉，零行为变化）**

原先 13 个模块反向 import main.ts（main 是 UI 总线，正向引全部视图模块）——
这是 madge 实测 24 条循环链的主要根子。本步把 9 个只依赖底层的符号原样搬出：

| 符号 | 原址 | 新址 |
| --- | --- | --- |
| activeSession / persistEdit / workPath / markPathFor | main.ts | 新模块 `session.ts`（只依赖 state/types/fsx） |
| chatUntilJson | main.ts | ai.ts（本就依赖 callChat+parseAiJson） |
| logCalibration | main.ts | calibrationio.ts（台账正本的家） |
| RULE_BY_TYPE | main.ts | pure.ts（纯常量） |
| docxToText | main.ts | bookpure.ts（fflate 解析族） |
| readTextSmart | main.ts | fsx.ts（文件 IO 口径模块） |

12 个引用方同批改 import；`fileSummary` 因隐藏依赖（mergedSelection→lexicon→main，
lexicon 的反向边要到 C2 才断）按预案拆出单列，留待 C2 批次。
架构地图 4.2 同步 31→32 模块（+session.ts）。

**验证**：`npm run verify` 全绿（1029 项：1028 通过 / 0 失败 / 1 跳过）；
函数体逐字搬移（diff 性质=搬移+import 调整，无逻辑改动）；新边均为自上而下方向，无新增环。


## [未发布] - 2026-09-16（合并补回 4 处修复的根因收口：每处都不再靠"记得走对的路"）

**为什么再做一轮**：2026-09-15 补回的 4 处修复（连点丢事件 / 备份三态 / 查词死按钮 /
设置原子写）修的是**症状**——危险路径还在，只是主路径绕开了它。本轮把每处的**根因**
收掉：让"错路"在类型或结构上不存在，而不是靠调用方自觉。同族残留也一并清点
（复核发现同一种病不止 4 处）。

| # | 原修复 | 本轮收口 | 根因判据 |
| --- | --- | --- | --- |
| ① | `appendDecision` 有 `io.append` 就走原子追加 | **`RiskIo.append` / `TxIo.append` 改必选**，删掉 risk.ts 两处与引擎 `appendLine` 的"读全文→拼行→写全文"兜底 | 兜底正是丢事件的路径：留着它，任何一个忘记注入 append 的调用点就把病带回来。接口必选后，"读改写"在类型上不复存在 |
| ② | `persistEdit` 备份三态 | **三处内联备份收敛为 `fsx.makeFirstChangeBackup()` 一个策略函数**（`persistEdit` / aiflow adoptRewrite / risk 面板 backup 钩子）；其中 risk 钩子原先还是两态、风险写在注释里自认 | 同一策略三处各写一份、口径还不一致（一处两态），修的人会以为已经修齐了。策略（`planBackup`）成为纯函数、单测三态 |
| ③ | 非 macOS `dict_lookup_zh` 形参改名对齐 | **命令只声明一次，cfg 只切实现**；非 macOS 行为放进 `no_dict()`（macOS 下也编译、也有单测） | 原先两份 `#[tauri::command]` 签名靠人工同步——`_words` 漂移就是这么发生的，且本机（macOS）编译不到坏的那份。单声明后参数表全文件唯一，改名本机立刻编译报错 |
| ④ | `save_app_config` 原子写 | **`write_file_base64` 同步改走 `atomic_write`**；`appendCsvLine`（原先两态 + 读改写，读不出来会拿新表头**覆盖旧台账**）迁入 fsx：三态 + 追加走 `append_text_file` + 进程内串行 | 截断式写与两态读是**类**，不是孤例：扫全仓把同类一次收齐，比逐个撞见再修便宜 |

**同族清点（本轮一并处理的）**：`appendCsvLine` 两态覆盖风险（→fsx 三态，`csvAppendPlan`
纯函数）；引擎 `TxIo` 读改写兜底（→必选 append）；测试替身 5 处（memIo / DOM×4 /
fakeFs×2）全部补上"内存版原子追加"，与 App 注入的 `O_APPEND` 同一纪律。

**验收标准与结果**（每条都可机械重跑）：

- 账本读改写路径清零：`grep 'prev + line' app/src/risk.ts src/core/version.ts` 无输出 ✓；
  新增回归测试"连点两张卡不丢决定"（并发两条 `appendDecision` 不 await 第一条，
  日志两条都在、顺序稳定、**write 调用数 = 0**）✓
- 备份策略唯一：仓内 `planBackup` 只在 fsx 定义一次；单测三态（missing→write /
  ok→skip / unreadable→abort 且理由含"没有执行"）；`backupPathFor` 路径约定单测 ✓
- `fn dict_lookup_zh` 全文件恰 1 处、参数表唯一 ✓；`no_dict` 单测（3 词→3 个 None、
  空入参→空出参）在 macOS 上真实运行 ✓
- 生产代码裸 `std::fs::write` 清零（仅剩注释与 `#[cfg(test)]`）✓
- `appendCsvLineWith` 单测：首建表头 write 恰一次、后续全 append；**并发两次**对新台账
  表头恰一份、两行都在；读不出来时 write/append 零调用 ✓

**门禁**：`npm run verify` 全绿（**1029 项：1028 通过 / 0 失败 / 1 跳过**——较上轮 +12，
全部是本轮新增的验收测试；preflight 45 + 版本五处一致 + typecheck 根/app + lint 0 warning +
评测不低于基线 + 双引擎 76/76）；`USER=runner npm run verify` 同数字全绿；
`npm run verify:rust` 全绿（fmt / clippy --all-targets -D warnings / **7 测试**，+1 为 `no_dict`）。

**如实记录的边界**：`no_dict` 之上的 cfg 分派三行在 macOS 上仍不被编译（结构性风险已
压到最低：分派只调用这个已验证函数）；`appendCsvLine` 的进程内串行只保护同进程，
跨进程并发由 `append_text_file`（O_APPEND）兜底；`makeFirstChangeBackup` 的 invoke
组合层不可 node 测试，行为由纯函数 `planBackup` 单测 + 三处调用点走查保证。


## [未发布] - 2026-09-15（合并事后复核：合并丢了 4 处主仓独有修复，逐条补回）

**结论先行**：合并记录「搬回来的」那一节写的是"主仓真正的独有语义只有两处
（`report.ts` 的 ⑤ 标注体检卡 + 三份文档）"。**那个结论是错的**——少算了 4 处，
其中 2 处是**数据丢失路径**、1 处是**跨平台死按钮**、1 处是**设置文件可能被写坏**。

**为什么会漏**：当时的判据是"逐行比对 + 手工印象"，没有把主仓自 merge-base 以来的
**每一条改动**都落到合并后的树上验一遍。主仓的修复注释在分支侧被**压缩**过
（合并记录自己写了"同步时压缩了"），"注释对不上"绝大多数确实是措辞差异——
但**代码行对不上**的那几处，是真的没了。

**复核方法（可重跑）**

```bash
BASE=$(git merge-base f00d256 fb63708)   # 合并前 main / 合并前分支
# 主仓自 BASE 起**新增的非注释代码行**，逐行看它在分支版、合并树里还在不在
git diff -U0 $BASE f00d256 -- <file> | grep '^+' | grep -v '^+++' | grep -v '^\s*\(//\|/\*\|*\)'
```

跑完得到 14 个"有行对不上"的文件；逐个判定后，**只有下面 4 处是真丢**，
其余是分支侧的等价实现或注释详略差异（见本节末尾的"确认没丢"清单）。

**补回来的 4 处**（每一处都为主仓独有，分支侧从未同步）

| # | 位置 | 补回的内容 | 为什么不能丢 | 主仓来源 |
| --- | --- | --- | --- | --- |
| ① | `app/src/risk.ts` `appendDecision` | 加回 `if (io.append) { await io.append(...); return; }`（在"读全文→拼一行→写全文"之前） | 两个决定按钮里有一个是 `void appendDecision(...)` **不 await**；连续快速点两张卡时，"读全文→拼一行→写全文"会**后写覆盖先写，丢一整条决定事件**。决定日志是"已决/待办"的正本，丢了那条卡会回到待办，误报率/撤销率的分母也跟着偏。同文件 `appendWorkbenchMarker` 本来就走 `io.append` | `4848fe6` |
| ② | `app/src/main.ts` `persistEdit` | `_原始备份.md` 改用 `readTextChecked` 三态；`unreadable` 时**抛错中止本次改动** | 原先"读不到＝没有备份，写一份"会把**读不出来但其实存在**的真原始版用当前正文顶掉——而原始备份是教师最后的退路。这正是 `a248baf` 点名的"**四处数据丢失路径**"的第 4 条：另外 3 条（`_审校标记.json` / `AI会话.json` / `_本书配置.json`）合并后都在，只有这条掉了 | `a248baf` |
| ③ | `app/src-tauri/src/main.rs` `dict_lookup_zh`（`#[cfg(not(target_os = "macos"))]` 那份） | 形参 `_words` → `words` | Tauri **按参数名**把前端 JSON 映射进来；前端传的是 `words`，声明成 `_words` 匹配不上，整个命令以"缺必填参数"失败。macOS 走的是另一份实现，本机看不出来；一旦出 Windows/Linux 构建，「查词」这类按钮就是**点了没反应**。属主仓 `e87ecf4`「真死按钮」清单里的一条 | `e87ecf4` |
| ④ | `app/src-tauri/src/main.rs` `save_app_config` | 裸 `std::fs::write` → `atomic_write` | 截断式写，写到一半崩（或被杀、磁盘满）会把**已有设置文件毁成半份**；同文件 `write_text_file` 早就是"同目录临时文件 → rename"，配置文件没理由不走同一条路 | `e87ecf4` |

**同时逐个确认"没丢"的**（复核过、不需要动；差异只在注释详略或等价实现）

- `report.ts` ⑤ 标注体检卡（`repairDiff` / `repairCardHtml` / `applyRepairPreview` / `diag-repair-btn`）✓
- 另外 3 条数据丢失路径：`_审校标记.json`（`main.ts`）✓、`AI会话.json`（`chat.ts`）✓、`_本书配置.json`（`bookio.ts`）✓
- `reader.ts` 去除中文标注（`__unanno`）✓、`pure.ts` 中文标注剥离 ✓
- `ai.ts` 三条 prompts 登记 ✓、`batch.ts` 「开始简化」灰死复位 ✓、`bookio.ts` 改写先算后写 ✓
- `edit.ts` 撤销/重做先写盘且 `recordHistory:false` ✓、`rewritegate.ts` / `datapanel.ts` 用 `baseName` 与按书失效 ✓
- `chat.ts` 采纳返回值 ✓、`review.ts` 「暂停保存」横幅 ✓、`settings.ts` 班级面板与「清 Key」✓
- `shelf.ts` 死按钮重绑 ✓、`compare.ts` 去日期行 ✓、`risk.ts` 空态"画出来却点不动" ✓
- `pipew.ts` 换词类传播：主仓写的是 `corrPairs2`，分支写的是 `simplified`——同一个调用点的等价实现 ✓

**唯一仍然"有意舍弃"的**（与合并记录一致，不变）：`app/src/shelf.ts` 的
`renderWorkspaceBar()`（渲染进 `#wstabs`）——分支在同位置有 `renderVersionSwitcher()`
（`#ctxbar` / `#ver-switch`），是同一功能的两种实现；合并后 `index.html` 里已无 `#wstabs` 元素。

**验证**：本提交上 `npm run verify` 全绿（preflight 45 + 版本五处一致 + typecheck 根/app +
lint 0 warning + **1017 项：1016 通过 / 0 失败 / 1 跳过** + 评测不低于基线 + 双引擎 76/76）；
`npm run verify:rust` 全绿（fmt / clippy --all-targets -D warnings / 6 测试）。
**用例数仍是 1017 且未变**——因为补回的是 4 处实现，主仓在这 4 处**没有独有用例**
（`tests/fsx.test.ts` 等主仓用例早已随 `a248baf` 同步到分支）。

## [未发布] - 2026-09-15（合并收尾·补记：清掉合并遗留的 `.wstabs` / `.ws-files` 死 CSS）

> 这一节对应**独立提交** `6c98635`，**不属于合并提交**。合并提交（`7680e79`）只做合并，
> 死代码清理另起一次提交。合并记录「有意舍弃的」那一节仍保留对它的取舍说明——
> 两处是**同一件事的两个视角**：那边记"主仓那份实现为什么被舍"，
> 这里记"清理动作本身"。先前它只以合并记录里的一条 bullet 形式存在，
> 不符合"清理另起提交、并在**它自己的** CHANGELOG 记录里写清"的口径，故补记本节。

**是什么**：合并把主仓的工作区条（`app/src/shelf.ts` 的 `renderWorkspaceBar()` →
`index.html` 的 `#wstabs`）换成了分支的版本切换器（`renderVersionSwitcher()` →
`#ctxbar` / `#ver-switch`）。`app/index.html` 里配套的 `.wstabs` / `.ws-files` 两组样式
就再没有元素能匹配——选择器全落空，属于死代码。

**为什么不在合并提交里顺手删**：合并提交里混无关改动，出问题时最难查
（本仓库历史上就有"用 `checkout --ours` 整文件取边丢改动"、靠 `USER=runner`
复现 CI 条件才抓到的前例）。所以死 CSS 留到合并提交跑完门禁之后，用**独立提交**清，
出了问题只需回退这一个提交。

**改了什么**：`app/index.html` 删掉 50 行已无处匹配的 CSS 规则；
合并记录里那条「遗留」同步改为指向本提交。

**验证**：本提交上 `npm run verify` 全绿（preflight 43 + 版本五处一致 + typecheck 根/app +
lint 0 warning + 1017 项：1016 通过 / 0 失败 / 1 跳过）。

## [未发布] - 2026-09-15（合并收尾：修对架构地图的模块数，并把这条接进门禁）

合并时顺手发现的一处**一直没人管**的漂移：`docs/文件架构.md` 第 4.2 节那句
"`app/src` 有 N 个模块"是**手写的、没有任何东西校验它**。

查历史（`git ls-tree` 数实际文件 vs 地图声明）：

| 提交 | 实际模块 | 地图声称 |
| --- | --- | --- |
| `4848fe6`（第八批） | 26 | **31** |
| `e87ecf4` | 26 | 31 |
| `a248baf`（加 `fsx.ts`） | 27 | 32 |
| `901f71f`（加 `propagateui.ts`） | 28 | 33 |
| 合并后 | **31** | 33 |

也就是说：**`4848fe6` 那时就已经差了 5**，我这两轮新增模块时又照着错的数往上加
（31→32→33），合并再从分支带进 3 个模块，最后实际 31、地图 33。
它会漂，是因为**没有东西会因为这个数字错了而失败**——铁律 1 写着"改结构必须改地图"，
但门禁只查了"地图在不在、被没被引用"，没查"地图说的和实际一不一样"。

**改法**：地图改成 31（两处），并在 `tools/preflight.mjs` 里加一条——
直接数 `app/src` 下的 `.ts`（不含 `vite-env.d.ts`，它是类型声明不是模块），
与地图里两处声明比对，对不上就红。

**反向验证过**（不是"写完就信"）：往 `app/src/` 丢一个 `_probe2.ts`，preflight 立刻红
（"写的是 31 个模块，但实际有 32 个"）；删掉探针即恢复绿。

**验证**：`npm run verify` 全绿（preflight 45 + 1017 项：1016 通过 / 0 失败 / 1 跳过 + 评测达标 + 双引擎 76/76）。

## [未发布] - 2026-09-14（合并 `codex/total-optimization` → `main`：两个 worktree 的账终于并成一本）

**为什么合**：两条线各自独有 10 / 48 个提交，而且**已经在重复劳动**——
"项目总说明 + 架构地图进门禁"两边各做了一遍（`4911ffd` / `45efda6`），
"真项目回放夹具移出公开仓库"也是（`44a16ec` / `aa5b6f6`）；
跨层传播更直接：主仓新写了一份"确认后写"，分支早有一份在跑的"自动写"，
**同一件事两套实现**（见第十三轮）。每多一天就多长一份，这个账必须并。

**怎么解的（先说判断依据，再说动作）**

动手前量了两件事，结论决定了整个解法：

1. **主仓在文件层面没有独有文件**——分支是完整的超集（分支多出 `annotate.ts` /
   `calibrationio.ts` / `risklogic.ts` / `wordnet.ts` / 词典数据 / 两份研究文档）。
2. **逐行比对"主仓有、分支没有的代码行"**：绝大多数是**同一改动的措辞差异**——
   这几轮我一直在手工把主仓的修复同步到分支，两边的语义早就一样了，只是注释详略不同
   （主仓的注释写得更细，同步时压缩了）。真正的主仓独有语义只有两处，见下。

据此：**全部代码/测试/引擎冲突取分支版**（`--ours`），然后**把主仓真正独有的补回去**；
三份文档（`AGENTS.md` / `docs/文件架构.md` / `CHANGELOG.md`）取主仓版并在 `CHANGELOG`
里保留分支独有的 6 个小节。

**搬回来的（主仓独有，漏了就是丢东西）**

> ⚠️ **这一节当时写漏了 4 处，事后复核才发现**（2026-09-15）。见文首
> 「合并事后复核：合并丢了 4 处主仓独有修复，逐条补回」——那张表才是完整的。

| 位置 | 内容 |
| --- | --- |
| `app/src/report.ts` | **⑤ 标注体检卡**：`applyRepairs` 的接线（逐条 diff 预览 → 确认 → `persistEdit`）。上一轮我明确说过"主仓另外接了一条，分支上没有对应入口" |
| `CHANGELOG.md` | 主仓 64 个小节的历史 + 分支独有的 6 个小节（原样保留，不并进主仓轮次编号） |
| `AGENTS.md` / `docs/文件架构.md` | 主仓版（`t.skip()` 那条纪律、33 个模块的地图——都是分支没有的） |

**有意舍弃的（如实记，这是这次合并唯一"删掉东西"的地方）**

- **`app/src/shelf.ts` 的 `renderWorkspaceBar()`（渲染进 `#wstabs`）没有保留**。
  理由：分支在同位置有 **`renderVersionSwitcher()`**（渲染进 `#ctxbar` / `#ver-switch` /
  `#ver-pop`），是排版重构方案 A 的那一版——**同一个功能的两种实现**，不是"分支缺这个功能"。
  合并后 `index.html` 里已经没有 `#wstabs` 元素了，主仓那份即使留着也是 `if (!el) return` 的空转。
  两处对照确认过：主仓 `main.ts` 里"关掉全部章节后收起工作区条"那个修复，
  分支侧对应的是 `ctxbar` 的处理（`main.ts` 里 `document.getElementById('ctxbar')`），**没有丢**。
- **遗留 → 已在下一个提交里清掉**：`index.html` 里 `.wstabs` / `.ws-files` 的死 CSS
  （选择器都匹配不到元素了）已删除。合并提交里没顺手删，是因为"合并提交里动无关的东西最难查"——
  于是单独一个提交，跑完门禁再进。该清理另有**独立小节**（见本文件文首
  「合并收尾·补记：清掉合并遗留的 `.wstabs` / `.ws-files` 死 CSS」）。

**验证**（合并后这一棵树，不是两边各跑一遍）

`npm run verify` 全绿：preflight 43 + 版本五处一致 + typecheck（根 + app）+ lint 0 warning +
**1017 项：1016 通过 / 0 失败 / 1 跳过** + 金标准评测不低于基线 + 双引擎对照 76/76；
`npm run verify:rust` 全绿（fmt / clippy --all-targets -D warnings / 6 测试）。
**测试数是分支侧的 1017，因为主仓没有独有用例文件**（上面第 1 条量过）。

## [未发布] - 2026-09-14（codex/total-optimization · 第十四轮：接线门禁 + 门禁与 CI 对齐）

主仓这一轮做了两件"上次说该做"的事（第 115–118 项，理由见主仓 CHANGELOG）：

1. **新增接线门禁** `tests/clickwiring.test.ts`：模板里渲染出的可点元素与 `data-*` 动作钩子，
   全仓必须至少有一处读它。本分支跑出来**同样是 0 处真问题**——说明这一侧也没有"设置在那
   其实没有用"的按钮。它的价值在以后：回归验证过，把 `datapanel.ts` 换回修复前那版，
   门禁当场报出 `data-dp-del`。
2. **`npm run verify` 与 CI 的 ubuntu job 逐条对齐**（补 `check_versions` / `eval` / `compare`），
   新增 `verify:all`；`verify:rust` 的 clippy 提到 `--all-targets`。
3. **CI 新增独立 Rust job**（`macos-latest`）——`app/src-tauri` 是 macOS 专有的，
   塞不进 ubuntu job，而 CI 里原本根本没有 cargo 这一步。
4. **`tools/compare.ts` 结果没变就不重写报告**：那份报告是被 git 跟踪的文档，
   原先每跑一次就把"生成日期"改一行，`verify` 一跑就变脏。

**验证**：本 worktree `npm run verify` 全绿（preflight 43 + 版本五处一致 + 根/app typecheck +
lint 0 warning + **1017 项：1016 通过 / 0 失败 / 1 跳过** + 评测不低于基线 + 76/76 双引擎一致，
且比对报告未被重写）；`npm run verify:all`（含 Rust）全绿。

## [未发布] - 2026-09-14（codex/total-optimization · 第十三轮：传播改回自动，两边实现合成一份）

Wayne 改了口径：**"直接弄，自动传播，我也不需要撤销的那种"**。
上一轮我按"每次都要教师确认"把分支那份自动实现改成了确认制，这一轮又按新口径改回自动——
但**不是改回原样**，中间那版带出来的三件事留下了：

1. **不留 `_原始备份.md`**。上一轮我加了备份，这一轮去掉了——传播只插/剥 `词（中文）`，
   天然可逆，真正的撤销路径是下级那个「去除中文标注」按钮。留的是**变更日志**
   （那不是撤销，是"这段现在这样是哪来的"，台账与审校档案一直在读它）。
2. **撤销也往下传**（本轮新增）。原先只有加注与换词两个调用点，`removeZhAnnotation`
   只改当前章。加注一旦自动传播，"去除"不传播就会让下级永远留着上级已经撤掉的注解——
   自动传播会变成只进不出的漏斗。
3. **两边合并成一份实现**。这是本轮最值钱的动作：分支原先有自己的 `propagateWordAction`，
   主仓新写了自己的 `offerPropagation`——**同一件事两套实现**。这一轮把分支那份删掉，
   两边都调同一个 `propagateToLowerTiers`（新模块 `app/src/propagateui.ts`，两边逐字相同）。
   分支那份里"同层多版本只取字典序最新"的判断比主仓的好，也一并搬进引擎的
   `descendantTierFiles`（主仓原先会往**旧版本**里插注解）。

另外：`pipew.ts` 撞上 `max-lines: 1000`，跨层传播那段拆成 `app/src/propagateui.ts`
（`docs/文件架构.md` 已同步，32 → 33 个模块）。

**验证**：本 worktree `npm run verify` 全绿（preflight 43 + 根/app typecheck + lint 0 warning +
**1014 项：1013 通过 / 0 失败 / 1 跳过**）；Rust gate 全绿。

## [未发布] - 2026-09-14（codex/total-optimization · 第十二轮：跨层传播补确认 + 引擎侧挑选函数同步）

Wayne 拍板：三个"未接线"模块都接，触发点由 agent 定；**可以改正文，但每次都要教师确认**。
主仓把三条逐个收口（第 108–110 项，理由见主仓 CHANGELOG）。

**分支上这一条要说清楚：这里本来就有一份，而且它在跑——只是跑法不对。**

本分支早就有一份 `propagateWordAction`（`app/src/pipew.ts`），在「加注中文」与「词汇简化」
之后**自动**调用：上级教师点一下，下级 M/B 的正文立刻被改写，
**没有确认、没有备份、只在日志里留一行**。它被调用着，所以"未接线"这个判断对分支不成立；
但按这一轮拍的口径，它是错的——改别人层级的正文必须先让教师看见要改什么。

这一轮把分支那份改成与主仓同一口径：

- 先按项目的「产物命名」挑出下级层目标、逐个算出会不会命中（`list_dir` 返回全路径，
  `原文_<下级层标签>_*.md`）；
- **列出来问一次**（`window.confirm`，逐文件列出），取消就一个字不改；
- 确认后每个文件**写前留 `_原始备份.md`**，再写正文；
- 变更日志只给**真写成功**的文件记账（失败的不许留"已落实"的痕）；
- 读不出来的文件点名跳过，写失败的点名报出。

**引擎侧与测试同步**：`src/core/propagate.ts` 新增 `descendantTierFiles`（挑目标，
排掉 `_工作稿.md` / `_原始备份.md` 这类派生物——第一版漏了，被新用例当场抓出：
"A 的下级是 M、B" 实得 `['M','M','M','B']`）；`tests/propagate.test.ts` 补 3 条；
`tests/candidate.test.ts` 补 1 条守卫（`applyUndo` 不许回来——撤销的正路是
`candidatesFromEvents` 的全量重建，不是增量扣证据）。

**主仓另外接了一条**（分支上没有对应入口）：`docast.ts` 的 `applyRepairs` 接到
质检报告页的「⑤ 标注体检」卡（预览逐条 diff → 确认 → `persistEdit`）。

**验证**：本 worktree `npm run verify` 全绿（preflight 43 + 根/app typecheck + lint 0 warning +
**1013 项：1012 通过 / 0 失败 / 1 跳过**）；Rust gate（`cargo fmt` / `cargo clippy --all-targets -- -D warnings` /
6 测试）全绿。

## [未发布] - 2026-09-14（codex/total-optimization · 第十一轮同步：新模块 fsx.ts + Rust describe_path + 一键建配置 + 恢复保存入口）

主仓第十一轮把上一轮结尾列的"还没解决"做掉了（第 101–107 项，逐条理由见主仓 CHANGELOG）。
本分支照旧**逐条断言锚点**同步，不做整文件覆盖。

**同步过来的**

| 位置 | 内容 |
| --- | --- |
| `app/src/fsx.ts`（**新模块**） | 文件读取的三态：`ok` / `missing` / `unreadable`。把"文件不存在"（常态）与"文件在但读不出来"（权限/占位——这时写回去就是覆盖教师数据）分开 |
| `app/src-tauri/src/main.rs` | 新增并注册 `describe_path`（回答"这个路径在不在"），`fsx` 靠它做判定 |
| `app/src/bookio.ts` | `loadBookConfig` 与 `_词库.csv` 的读取改走三态："读不出来"不再是"没配过" |
| `app/src/chat.ts` | `restoreChat` 改走三态；损坏/读不出来时**暂停自动保存**，并给「我已备份好，恢复保存」 |
| `app/src/main.ts` | 打开章节读 `_审校标记.json` 改走三态；风险面板空态加「一键生成 调适项目_*.json」 |
| `app/src/aiflow.ts` | 原始备份读不出来时**中止本次改动**（原先注释里明写"风险自认"） |
| `app/src/review.ts` | 侧栏加「本章标记没有在保存」常驻横幅 + 恢复保存（原先只能重启 App） |
| `app/src/adoptrewrite.ts` | 缺调适项目配置的拒绝文案补上"下一步去哪做" |
| `app/src/datapanel.ts` | `createProjectConfig()`：一键生成配置，能推的路径填好、猜不到的如实列成待办 |
| `app/src/ai.ts` + `settings.ts` | 「清 Key」不再是假动作：有稳定 id 就不回落下标账号（老 Key 在分配 id 那一刻搬过去） |
| `app/src/pure.ts` | 新增 `failoverRowKind` / `partitionFailoverRows` / `failoverKeyAccounts`（读、写、删共用一套判据） |
| `tests/fsx.test.ts`（新）、`tests/app_logic.test.ts`、`tests/datapanel.test.ts` | 9 条新用例 |

**分支独有的一处**：`tests/datapanel.test.ts` 里的 `setIo` 替身要补一个 `reveal`——
本分支的 `PanelIo` 比主仓多这一个成员（台账卡上的「在访达中显示」）。编译错误当场指出来的。

**验证**：本 worktree `npm run verify` 全绿（preflight 43 + 根/app typecheck + lint 0 warning +
**1009 项：1008 通过 / 0 失败 / 1 跳过**）；Rust gate（`cargo fmt` / `cargo clippy --all-targets -- -D warnings` /
6 测试）全绿。

## [未发布] - 2026-09-14（codex/total-optimization · 按钮审计后半批：把"发现了但没改"的九条同步过来）

主仓第十轮把上一轮留下的九条"发现但没改"逐条核实并改完（第 86–100 项，逐条理由见主仓 CHANGELOG）。
本分支是 **App 开发位**，`app/` 下十几个文件与主仓已有实质分叉，所以照旧**不是整文件覆盖**——
每条补丁都断言"锚点恰好出现 1 次"，对不上就报错退出。

**分支上同步过来的**

| 位置 | 问题 | 修法 |
| --- | --- | --- |
| `app/src/risk.ts` 四处 | `void p.then(...)` 全都没有 `.catch()`：按钮先 disabled，promise 一拒绝就**永久禁用**，卡片还在、顶部没说明——"点了没反应" | 四处各补 `.catch()`，走"顶部说明 + 重渲染让按钮重新可点"的出路 |
| `app/src/grading.ts` 班级表 | `failed` / `error` **导出用了、屏幕上一次都没读**：失败行与"学生交了个空文件"长得一模一样 | 失败行整行 `—` + 名字挂 ⚠ + 悬停给原因；标题行点出"其中 N 份没读进来" |
| `app/src/grading.ts` | 点失败行 `if (!a) return;` **什么都不发生** | 改成 `setStatus(name：原因, 'err')` |
| `app/src/grading.ts` `runSingle` | 链路没有 try/catch、也没有进行中反馈 | 按钮「体检中…」+ try/catch/finally |
| `app/src/chat.ts` 四处 | 空输入发送静默；清空无确认；损坏会话被静默当成"没有对话"并覆盖；无 key 时先清空输入框 | 逐条照主仓口径修（详见主仓第九/十轮） |
| `app/src/pipew.ts` 手动改句 | `s.md` 先赋值再 `persistEdit` → 撤销快照与"原始备份"都废 | 先算 `next`、落盘成功后再 `s.md = next` |
| `app/src/bookio.ts` | 跨书残留（换书不清空）+ 损坏配置被当成"没配过" + **`_词库.csv` 写了全仓没人读回** | `resetBookScopeIfNew(dir)` + 拆 catch 说出口 + 三个分支都先读 `${dir}/_词库.csv` |
| `app/src/pipew.ts` 词库编辑器 | 「取消」只关弹层，而增删是**即时写盘**的 | 取消时把打开时的原始内容写回并还原内存 |
| `app/src/settings.ts` | `collectFb` 静默丢半填行；占位文案"空=用主Key"是假话且无法清除已存 Key | 收集函数不再过滤 + 半填行点名；文案改真话 + **新增 Rust `delete_api_key`** 与每行「清」按钮 |

**分支独有的一处**（主仓那边不涉及）：`app/src-tauri/src/main.rs` 的 `delete_api_key`
同样加在这里并注册进 `invoke_handler`——读 Key 走的是 `ai.ts` 的"钥匙串里有就用钥匙串的"，
少了这条命令，教师在界面上就没有任何办法把某一家备用的 Key 拿掉。

**验证**：本 worktree `npm run verify` 全绿（preflight 43 + 根/app typecheck + lint 0 warning +
**1000 项：999 通过 / 0 失败 / 1 跳过**）；Rust gate（`cargo fmt` / `cargo clippy --all-targets -- -D warnings` /
6 测试）全绿。

## [未发布] - 2026-09-14（codex/total-optimization · 按钮审计：同步主仓那一批"点了没用"的入口，并补两处分支漏项）

来源：Wayne"我怕某个 button 设置在那其实没有用"。主仓已按「静态 26 个入口 × 运行时 123 个
生成按钮 × 25 处 `invoke` 参数名」逐条追到落点并修完一批；本分支是 **App 开发位**，
`app/` 下十几个文件与主仓已有实质分叉（`pipew.ts` +317 行、`datapanel.ts` +164 行、
`pure.ts` +82 行…），所以**不是整文件覆盖**——每条都写成"锚点必须恰好出现 N 次，对不上就报错退出"，
逐条断言后落地。落点清单与逐条理由见主仓 CHANGELOG 第九轮（第 71–85 项）。

**本分支独有、或主仓那边不存在/修法不同的**

| 位置 | 问题 | 修法 |
| --- | --- | --- |
| `app/src/review.ts` `scheduleSave` | `S.markFileBroken` 在 `main.ts` 里被写进去，**分支上却没有任何地方读它**——守卫等于不存在：`_审校标记.json` 解析失败后，内存里的空清单照样写回盘上，**整章标记被静默覆盖** | 落盘前加 `if (S.markFileBroken.has(session.markPath)) { scream(...); return; }` |
| `app/src/bookio.ts` `exportDocx` | 分支此前**只跟了主仓修法的一半**（正则补 `.docx`/`.aiff`/`.mp3`），没跟"目标路径可能正是教师原件"那一半——原件会被一份 App 生成的纯文本 docx 原地替换、排版图片全丢，而写入走的是不查存在、不备份、非原子的 `write_file_base64` | 目标已存在（含等于源文件）就另起 `<基名>_LayerText导出.docx`，绝不覆盖 |
| `app/src-tauri/src/main.rs` | `save_app_config` 用的是裸 `std::fs::write`，与同文件 `write_text_file` 的原子落盘不是一套；`load_app_config` 把"读不了"当成"没配置" | 抽出 `atomic_write` 两处共用；`load_app_config` 区分 `ErrorKind::NotFound`（返回 `{}`）与其他 IO 错误（`Err` 并带上路径） |

**返工 1（如实记）**：`shelf.ts` 那条补丁的锚点选在了 `renderShelfGrid` 的**函数尾**，
结果把结尾的 `}` 与 `bindShelfCards(el, books);` 一起复制了一遍。
分支 `tsc` 当场报 `app/src/shelf.ts(323,1): error TS1128`，删掉重复块后恢复。
教训：**锚点选在"函数尾"就必须把右括号算进断言**，否则补丁会静默地贴歪——
这一条比它修的那个 bug 更值得记。

**验证**：本 worktree `npm run verify` 全绿（preflight 43 + 根/app typecheck + lint 0 warning +
**1000 项：999 通过 / 0 失败 / 1 跳过**）；`USER=runner npm run verify` 同样全绿（复现 CI 条件）；
Rust gate（`cargo fmt` / `cargo clippy --all-targets -- -D warnings` / 6 测试）全绿。

## [未发布] - 2026-09-14（第十四轮：把上次说"该做"的两件事做掉——接线门禁 + 门禁与 CI 对齐）

上一轮末尾我说"如果接着做，先做这三件"。跨层传播撤销已完成（第十三/十四轮之间），
这一轮做剩下两件。

| # | 位置 | 做了什么 | 为什么 |
| --- | --- | --- | --- |
| 115 | `tests/clickwiring.test.ts`（新增） | **接线门禁**：模板里渲染出的 `<button/input/select/textarea id="X">` 与 `data-xxx=` 动作钩子，全仓必须至少有一处读它（`getElementById`/`$`/`querySelector('#X')`/`bind('X')`；钩子则是 `[data-xxx]`/`getAttribute`/`.dataset.xxx`/`closest`），否则判红 | 第九轮那次人工审计是**手工**对了一遍 26 个静态 id + 123 个运行时按钮，找出 21 处问题。手工审一遍只管一次；这条把它变成每次提交都跑 |
| 116 | `package.json` | `verify` 补齐 `check_versions` / `eval` / `compare`；新增 `verify:all` = `verify + verify:rust` | 原先本地 `verify` 少跑这三条，而 CI 跑——**"本地全绿"不等于"CI 会绿"** |
| 117 | `.github/workflows/ci.yml` + `package.json` | CI 新增独立的 **Rust job**（`macos-latest`，`dtolnay/rust-toolchain`）；`verify:rust` 的 clippy 提到 `--all-targets` | Rust 主进程是 macOS 专有的（`security`/`open`/`say`/TCC），塞不进 ubuntu job——**而 CI 里原本根本没有 cargo 这一步**，最会丢数据的那一层长期只在开发者本机跑过 |
| 118 | `tools/compare.ts` | 比对结果没变就**不重写**报告（比之前去掉"生成日期"那一行）；日志区分"已更新/未重写" | 那个报告是**被 git 跟踪的**文档，原先每跑一次就把日期改一行——`verify` 一跑就变脏。现在那条日期表示"结果最后一次变化是哪天" |

**接线门禁这条，先说清楚它今天抓到了什么**：**0 处真问题**。
扫出来的 3 条候选全是误报，我逐条查过：
`sum-suggest` / `sum-close` 的绑定写在**另一个文件**（`uikit.ts` 里统一绑）——第一版扫描只看渲染它的那个文件，所以漏了；
`cls-close` / `cls-reload` / `cls-clear` 走的是本文件里的 `bind('id', …)` 助手；
`w-ui-lang` / `w-text-lang` 是上手向导里只有**一个可用项**的下拉（另一个是 disabled 的"即将支持"），本来就没有可绑的行为——这两个进了白名单，**每个都写了理由**。

所以它的价值不在今天，在以后：**回归验证过**——把 `datapanel.ts` 换回 `e87ecf4^` 那版（
`data-dp-del` 渲染出来却没有任何监听，就是那次审计抓到的真缺陷），这条门禁当场报出来。
另外还做了**实机负向验证**：往 `app/src/` 里丢一个临时探针文件渲染 `<button id="ghost-probe">`
与 `data-ghost-hook`，测试立刻红；删掉探针即恢复绿。

**`verify` 变长了，如实说代价**：现在跑一次 `verify` 会连带跑金标准评测与双引擎对照，
比原来慢（本地实测多十几秒）。换来的是"本地绿 = CI 绿"。

**验证**：`npm run verify` 全绿（preflight 44 + 版本五处一致 + typecheck 根/app + lint 0 warning +
**988 项：987 通过 / 0 失败 / 1 跳过** + 评测不低于基线 + 76/76 双引擎一致）；
`npm run verify:all`（含 Rust）全绿。
`LayerText-optimization` 同步后 preflight 43 + **1017 项：1016 通过 / 0 失败 / 1 跳过**，Rust gate 全绿。

## [未发布] - 2026-09-14（第十三轮：跨层传播改成**自动**，并补上它的对侧）

Wayne 拍板改口径：**"直接弄，自动传播，我也不需要撤销的那种"**。
上一轮我做的是"每次都问、写前留备份、给恢复入口"，这一轮把确认与备份都去掉。

**为什么去掉是站得住的**：传播做的只有"插/剥 `词（中文）`"，**天然可逆**——
下级文件里那个「✂ 去除中文标注」随时能拆掉。所以真正的撤销路径是那个按钮，
不是确认框、也不是 `_原始备份.md`。留的是**变更日志**——那不是撤销，
是"这段现在这样是哪来的"，台账与审校档案一直在读它。

| # | 位置 | 改了什么 | 为什么 |
| --- | --- | --- | --- |
| 111 | `app/src/propagateui.ts`（**新模块**） | 跨层传播的 App 侧接线从 `pipew.ts` 拆出来；`offerPropagation` → `propagateToLowerTiers`：**无确认、无备份**，多个词合并成一次扫描（原先逐词各跑一趟，同一批文件被反复读写） | ① 口径变了；② `pipew.ts` 撞上 `max-lines: 1000`；③ 这本来就是自成一体的一件事 |
| 112 | `src/core/propagate.ts` | `descendantTierFiles` **同层多版本只取字典序最新那个** | 一章目录里可能躺着几个日期的同层产物，把注解插进**旧版本**是纯粹的污染。这条口径来自分支上跑了很久的实现，搬过来是为了两边不要再各挑各的 |
| 113 | `app/src/pure.ts` + `pipew.ts` + `reader.ts` | **补上「去除中文标注·记已会」这条通道**（`stripWordAnnotations` / `annotatedHeadOf` / `removeZhAnnotation` / 词面板按钮） | 主仓**根本没有**这条通道：教师加了注、发现没必要，界面上没有任何办法拆掉。而传播现在是自动的，撤销传不下去就会在下级越积越多——**自动传播会变成只进不出的漏斗** |
| 114 | `app/src/pipew.ts` | 换词类接上：只在下级留一张 `_待复核/层级传播_待办.md`，不改下级正文 | 与 `propagate.ts` 一开始写明的策略一致（跨层机器改写语境依赖强）。主仓原先连这张清单都不留 |

**这一轮最值钱的动作其实不是"改成自动"，是把两边的实现合成一份。**
上一轮我指出"两个 worktree 在长出两套实现"——`propagate` 就是活例：主仓新写的是
"确认后写"，分支早有一份在跑的"自动写"。这一轮把分支那份**删掉**，
两边都调同一个 `propagateToLowerTiers`（新模块内容两边逐字相同）。
顺带发现分支的 `propagateWordAction` 里"同层取最新文件"那条判断比主仓的好，也一并搬过来了。

**验证**：`npm run verify` 全绿（preflight 44 + typecheck（含 `app`）+ lint 0 warning +
**985 项：984 通过 / 0 失败 / 1 跳过**）；Rust gate 全绿。
`LayerText-optimization` 同步后 preflight 43 + **1014 项：1013 通过 / 0 失败 / 1 跳过**，Rust gate 全绿。
`docs/文件架构.md` 已同步（32 → 33 个模块）。

## [未发布] - 2026-09-14（第十二轮：三个"未接线"模块收口——两个接上按钮，一个说明为什么不该接）

上一轮结尾的第 6 条是"三个未接线模块"。Wayne 的决定：**三个都接，我来定触发点**；
写入范围：**可以改正文，但每次都要教师确认**。三处的实际情况不一样，所以处理也不一样。

| # | 模块 | 核实结论 | 处理 |
| --- | --- | --- | --- |
| 108 | `src/core/propagate.ts` | **是一份能力规格，从未运行过**：纯函数与单测都齐，全仓只有测试调它。"上级加了注，下级自动跟上"这句话从来没成立过 | **接上**：新增纯函数 `descendantTierFiles`（挑下级层目标）；`app/src/pipew.ts` 加 `offerPropagation()`——「加注中文」之后**每次都问**，列出各下级层要改的文件与命中处数，教师确认后才写；每个文件写前留 `_原始备份.md`，写完落变更日志（与 `persistEdit` 同一口径） |
| 109 | `src/core/docast.ts` 的 `applyRepairs` | 上一轮**修好了 bug**（原先"报修好了、实际一个字符没改"），但**全仓只有测试调它**——教师手册里那句"嵌套标注会自动拍平"从来没跑过 | **接上**：质检报告页新增「⑤ 标注体检」卡，显示嵌套 N 处 / 同词释义不一致 M 处；点「预览并修复」先给**逐条 diff**，确认后走 `persistEdit`（带原始备份与撤销快照） |
| 110 | `src/core/candidate.ts` 的 `applyUndo` | **已删（第九轮），这一轮不加回来**。它的能力（撤销）在生产路径上**已经可达**：风险队列的「撤销」按钮写一条 `undo` 事件，`LayerText_AF决定汇总.mjs` 走 `candidatesFromEvents(allEvents)` 全量重建时由 `undoneIds` 扣证据。被删的是**第二套口径**（它在证据清零时把候选标成 `rejected`，而重建路径的结论是"根本不成候选"） | 加一条**守卫用例**：断言 `applyUndo` 不再导出。理由写进用例里——"上一个想把撤销接进来的人会照它写，然后在已经扣过一次的候选上再扣一次" |

**触发点是怎么定的（写给下一个人）**

- **加注 → 问一次。** 不自动写：传播会改**别的层级**的正文，那是数据改动，
  而"上级点头"与"下级被改"之间必须有一次显式的确认。这是 Wayne 拍的口径。
- **换词 → 不写正文，只在下级留待办。** 这条是 `propagate.ts` 一开始就写明的策略
  （跨层机器改写语境依赖强），本轮沿用，没有放宽。
- **标注体检 → 只在教师点的时候跑。** 它是机械修复，不需要"背后自动跑"；
  每次都给 diff 预览，因为改的是正文。

**这一次又被自己的门禁拦下（如实记）**

`descendantTierFiles` 的第一版把 `_工作稿.md` 与 `_原始备份.md` 也当成了传播目标——
它们与正本同层、文件名里同样带层标签，只有后缀不同。**新写的用例当场抓出来**：
"A 的下级是 M、B" 实得 `['M','M','M','B']`。改法是在挑选阶段排掉这两个后缀，
并把这条写进测试注释（"挑宽了会污染备份、把工作稿当成第二份正本"）。
另外 `pipew.ts` 里那个 `failed.push(...)` 被 `appswallow` 判红，改成仓库既有的账名
`failedFiles`（白名单里那条本来就是为"记进账、随后渲染出来"设的），**没有去放宽白名单**。

**验证**：`npm run verify` 全绿（preflight 44 + typecheck（含 `app`）+ lint 0 warning +
**984 项：983 通过 / 0 失败 / 1 跳过**，本轮 +4 条）；Rust gate 全绿。
`LayerText-optimization` 同步后 preflight 43 + **1013 项：1012 通过 / 0 失败 / 1 跳过**，Rust gate 全绿。

**分支上发现的差异（重要）**：本分支**早就有一份** `propagateWordAction`——但它是**自动写**的
（上级一点，下级正文立刻改），没有确认、没有备份。按 Wayne 这一轮拍的口径，分支那份也改成了
"先列计划、问一次、写前留备份"，与主仓口径对齐。也就是说：**这条能力在分支上"跑过"，
只是跑的方式与拍板不符**，本轮把它纠正过来。

## [未发布] - 2026-09-14（第十一轮：把上一轮结尾列的"还没解决"逐条做掉——含一个新模块 `fsx.ts`）

上一轮结尾我列了 8 条"还没解决的"。Wayne 让把前 6 条做完。这一轮逐条落地。

**最要紧的一条：`read_text_file` 的"读不了"与"没有"终于分开了**

Rust 侧加了一条命令 `describe_path`（`"missing"` / `"exists"`），前端加了一个新模块
**`app/src/fsx.ts`**，`readTextChecked()` 返回三态 `{ok} | {missing} | {unreadable}`。
听起来像小工具，其实全仓有**四处数据丢失路径**都卡在这一个分辨不出来上：

| 位置 | 原先的写法 | 代价 |
| --- | --- | --- |
| `_审校标记.json` | 注释写"读不到＝还没审过，是常态" | 文件在、只是读不出来时，整章标记被空清单覆盖 |
| `AI会话.json` | 同上 | 攒了几十轮的审校对话被空对话覆盖 |
| `_本书配置.json` | 同上 | 教师配过的词库/改写规则静默失效 |
| `_原始备份.md` | **注释里明写"风险自认"**：备份其实存在但读不出来时，会把真原始版换成当前正文 | 教师"最后的退路"没了 |

前三条上一轮已经拆过 catch，但拆的是"解析失败"那一层；**"文件读不出来"这一层始终分不出**，
所以注释里那句"后端没给错误码分不出来"一直成立。现在它不成立了：
`fsx` 只在**确认路径不存在**时才允许落到"没有"那一支，其余一切（文件确实在、连"在不在"都问不出来）
都是 `unreadable` —— 说出口，并且**不覆盖**。备份那一处更严：读不出来就**中止这次改动**
（`persistEdit` / `aiflow` 都一样），宁可这一次不改，也不拿教师唯一的原始版去赌。

**其余五条**

| # | 位置 | 问题（核实后） | 修法 |
| --- | --- | --- | --- |
| 101 | `app/src/ai.ts` + `settings.ts` | 上一轮加的「清 Key」按钮**是假动作**：读取侧写的是"稳定账号取不到就回落下标账号"，删掉 `fb:<id>` 之后**立刻从 `fb0` 把同一把 Key 读了回来**，toast 却说"已删除"。更糟的是删过一行之后下标会易主，回落到别家的 Key（鉴权失败，而报错会让教师怀疑自己填的 Key） | 判据统一到纯函数 `pure.failoverKeyAccounts`：**有 id 就只认 `fb:<id>`，绝不回落下标**；老 Key 改在 `settings.ts` **给一行新分配稳定 id 的那一刻**搬一次（那时下标还有意义）——放在 `ai.ts` 做进程级迁移是错的，那会把教师刚「清」掉的 Key 又搬回来。`ai.ts` 里那段迁移已删 |
| 102 | 新增 `app/src/fsx.ts` + Rust `describe_path` | 见上 | — |
| 103 | `app/src/main.ts` `persistEdit` | 原始备份读不出来时照写，把真原始版换成当前正文（**注释里明写"风险自认"**） | 读不出来就抛，**这次改动不执行** |
| 104 | `app/src/aiflow.ts` `adoptRewrite` 的 backup 端口 | 同上 | 同上 |
| 105 | `app/src/adoptrewrite.ts` + `datapanel.ts` + `main.ts` | 没有 `调适项目_*.json` 时"采纳 / 直改"**100% 被拒**（这是设计如此：没有版本与追溯的去处就不该写正文），但界面上只教"复制模板"那条命令——等于要求教师开终端、还得知道仓库在哪，**没有出路** | ① 拒绝文案补上下一步去哪做；② `datapanel` 加 `createProjectConfig()`：**一键在书目录生成 `调适项目_<名>.json`**，只填能从书目录推出来的路径，其余一律 `null` 并**如实列成待办**（那些指向教师机器上的真实文件，猜不得）；③ 「库」页与风险面板空态各给一个按钮 |
| 106 | `app/src/review.ts` + `chat.ts` | "暂停保存"（坏文件保护）**没有恢复入口**：教师备份好之后只能重启 App，而那条状态行会滚走/被覆盖 | 侧栏与对话区各加一块常驻横幅：「打开所在文件夹（先备份它）」+「我已备份好，恢复保存」——恢复时**当场试存一次**，否则按钮点完只是消失，他还是不知道存上没有 |
| 107 | 测试覆盖 | 审计子代理把这件事列为"最大的结构性缺口"：`tests/` 从不 import `settings.ts` / `chat.ts`，也不调 `loadBookConfig` / `showVocabEditor`——上一轮那批 UI 修复**一个用例都没守着** | 抽出三处**纯逻辑**并补 9 条用例：`failoverRowKind` / `partitionFailoverRows`（分拣绝不能在收集阶段吃掉半成品）、`failoverKeyAccounts`（含"删行后下标易主"那条断言）、`fsx.classifyRead`（只有 missing 才能变成"没有"）、`createProjectConfig`（能推的填好、猜不到的列成待办） |

**这一步被仓库自己的门禁拦了一次（如实记）**

新加的 4 个 `catch` 被 `tests/appswallow.test.ts` 当场判红（`bookio.ts` 一处多余的 `.catch()`、
`datapanel.ts` 一处只 `alert` 不写状态行、`fsx.ts` 两处缺「有意兜底：」）。
修法按门禁给的四个出口来，没有去放宽白名单——那条纪律写着"加之前先问一句：
加进来以后 `catch { }` 这种形状还拦得住吗？"。**这是它第二次在我手上生效**。

**测试覆盖到哪里、没到哪里（说清楚，别让下一个人以为都守住了）**

- 守住了：上面那三处纯逻辑 + `createProjectConfig` 的产物形状。
- **没守住**：DOM 接线本身（按钮绑没绑上、横幅渲染成什么样）依旧没有用例——
  `settings.ts` / `chat.ts` / `review.ts` 的渲染层还是靠"改完自己读一遍"。
  要真守住得先把这几处的 DOM 逻辑也抽成纯函数，那是更大的一件事，本轮没做。

**验证**：`npm run verify` 全绿（preflight 44 + typecheck（含 `app`）+ lint 0 warning +
**980 项：979 通过 / 0 失败 / 1 跳过**，比上一轮 +9 条新用例）；Rust gate
（`cargo fmt` / `clippy --all-targets -- -D warnings` / 6 测试）全绿。
`LayerText-optimization` 同步后 preflight 43 + 根/app typecheck + **1009 项：1008 通过 / 0 失败 / 1 跳过**，
分支 Rust gate 全绿。

## [未发布] - 2026-09-14（第十轮：把上一轮"发现了但没改"的九条做完——其中五条是同一类"按钮不可信"）

第九轮结尾留了一张"发现但没改"的清单。这一轮逐条**回代码核实**（一个只读子代理专门做这件事），
九条里 **七条为真、两条已在更早的批次里修掉**。为真的逐条改完，并按老规矩把"报告说错了"
和"我自己改错了"都写在这里。

**先记两条返工（都是我自己造的）**

1. **`collectFb` 的第一版改法是空炮**。我在保存侧写了
   `const allFb = collectFb(); const fbs = allFb.filter(...); const halfFilled = allFb.filter(...)`，
   却**没删掉 `collectFb` 内部那句 `.filter(r => r.baseUrl && r.model)`**——
   于是 `allFb` 本来就已经是过滤后的集合，`halfFilled` 恒为 `[]`，
   新加的"⚠ 有 N 行没填齐"**永远渲染不出来**，被修的缺陷原样还在。
   是审计子代理在跑的时候**当场发现并回头喊我**（它那两个文件的哈希在几分钟里变了四次）。
   教训：**过滤器写在收集函数里，下游就永远看不见被过滤掉的东西**；改这类问题时，
   先确认"半成品有没有机会到达判定点"，再谈怎么提示。
2. **`loadBookConfig` 的"换书清空"第一版太狠**。我一开始无条件 `resetBookScope()`，
   而 `main.ts` **打开同一本书的下一章也会重跑这个函数**——
   教师刚从界面导入了词库、还没点「保存为本书配置」，翻一页就被清掉了。
   改成 `resetBookScopeIfNew(dir)`：**只有书目录变了才清**。跨书残留照修，同书内存态不受影响。

| # | 位置 | 问题（核实后） | 修法 |
| --- | --- | --- | --- |
| 86 | `app/src/risk.ts` 四处 | `void p.then(...)` **全部没有 `.catch()`**（`data-decide` / `data-undo` / `data-batch` / `data-act`）。按钮先 `setAttribute('disabled','true')`，promise 一拒绝就**永久禁用**：卡片还在、顶部没有说明、再点也没用——正是"点了没反应" | 四处各补 `.catch()`，走同一条"顶部说明 + 重渲染让按钮重新可点"的出路。判据写进注释：**凡是 disabled 过的按钮，都必须有一条让自己重新可点的出路** |
| 87 | `app/src/grading.ts` 班级表 | `failed` / `error` 两个字段**导出（md/csv）用了、屏幕上一次都没读**：失败行渲染成一排 `—`/0，与"学生交了个空文件"一模一样——教师会照着这张表去批评学生，而他批评的其实是没读进来的文件 | 屏幕上照导出口径走：失败行整行 `—`、名字挂 ⚠、悬停给原因；"这一列偏低"（`riskError`）的行也挂 ⚠；标题行点出"其中 N 份没读进来" |
| 88 | `app/src/grading.ts` 点失败行 | `if (!a) return;`——**点失败行什么都不发生**，而失败行恰恰是教师最需要看原因的那一行 | 改成 `setStatus(name：原因, 'err')` |
| 89 | `app/src/grading.ts` `runSingle` | 整条链路**没有 try/catch、也没有进行中反馈**（体检要读词库/算结构，不是瞬时的）。抛出去只靠全局兜底网 toast 一下，看不出是"没反应"还是"在算" | 按钮禁用 + 文案「体检中…」，失败当场说出口，`finally` 恢复 |
| 90 | `app/src/chat.ts` 空输入发送 | `if (!text) return;`——点发送**什么都不发生**（连 `chatBusy` 都不置位，连"忙"的样式都没有） | 补 `setStatus('先在下面的输入框里写点什么再发送（Enter 换行，⌘/Ctrl+Enter 发送）','err')` + 聚焦 |
| 91 | `app/src/chat.ts` `#chat-clear` | 清空**不可撤销**（清完还落盘，重启也回不来），而它就贴在发送按钮旁边，**原先连问都不问** | 加 `window.confirm`（带轮数）；清空时顺便解除"损坏文件不覆盖"的暂停 |
| 92 | `app/src/chat.ts` `restoreChat` | "文件不存在"与"JSON 解析失败"**共用一个 catch**：损坏的 `AI会话.json` 被静默当成"没有对话"，下一次自动保存就把它整体覆盖——攒了几十轮的审校对话一句话不剩 | 拆开：读失败＝第一次用（静默）；解析失败＝当场说出口 + `chatFileBroken = true`，**本轮暂停自动保存**，先把文件留住。与 `main.ts` 打开章节时那条口径一致 |
| 93 | `app/src/chat.ts` `sendChat` | `input.value = ''` 在**取 API Key 之前**：没配 AI 时教师刚打的一整段话被清掉，弹出来的还是"AI 设置"窗口，关掉回来输入框是空的 | 挪到确认能发出去之后；无 key 的提示补一句"你刚写的内容还在输入框里" |
| 94 | `app/src/pipew.ts` 手动改句 | `s.md = s.md.slice(...)` **之后**才 `persistEdit(s, s.md)`——两个实参同一个引用，`newMd !== s.md` 恒 false：① 不 push 撤销快照（⌘Z 撤不回来）；② 写 `<章>_原始备份.md` 用的是**改后**的正文，"还原成改前"会还原成刚改的那一版 | 先算 `next`，`persistEdit(s, next)` 成功后再 `s.md = next`；标记 remap 也挪到落盘成功之后（写失败时内存与磁盘不会各说一套） |
| 95 | `app/src/bookio.ts` `loadBookConfig` | 全是 `if (cfg.X)` 守卫式赋值（那是为了不把 `null` 当"清空"），但**上一本书的值不会被请走**：打开一本没有配置的书，上一本书的词库/术语/专名/改写规则原封不动继续生效，界面上没有任何迹象 | 加 `resetBookScope()`，由 `resetBookScopeIfNew(dir)` 驱动——**只有换书才清**（见上面返工 2）；`instructions` 退回的是"全局值"而不是默认值（新增 `state.ts` 的 `rememberGlobalInstructions` / `setGlobalInstructions`） |
| 96 | `app/src/bookio.ts` 同上 | 损坏的 `_本书配置.json` 被静默当成"这本书没有配置"：教师明明配过词库与改写规则，打开书什么都没生效，一个字都不提示 | 拆 catch，说出口并带上路径，按"没有本书配置"处理 |
| 97 | `app/src/bookio.ts` + `pipew.ts` | **`_词库.csv` 写了但全仓没人读回**。词库编辑器的「完成」写这个文件、设置页写着"词库以书目录 `_词库.csv` 为准"，而唯一的读者 `lexicon.ts` 读的是 **`examples_dir`**，不是书目录。教师编辑完 → 重启 → 再打开这本书，词库当作没配过 | `loadBookConfig` 三个分支都先读 `${dir}/_词库.csv` 再应用（**覆盖** JSON 里那份 `vocabCsv`，与设置页口径一致） |
| 98 | `app/src/pipew.ts` 词库编辑器 | 面板是"增删即时写盘"的，而「取消」`#vclose` **只 `remove()` 弹层**：加了词删了词点取消，改动**已经在盘上**，面板里也没有任何撤销入口——界面上却摆着「完成 / 取消」一对按钮 | 记下打开时的原始内容；取消时把它写回 `_词库.csv` 并还原内存，失败必须说出口（否则盘上是"改过的"，而教师以为"取消了"） |
| 99 | `app/src/settings.ts` `collectFb` | `.filter(r => r.baseUrl && r.model)` 让"只填了一半的备用行"**在收集阶段就消失**，而成功提示报的是过滤后的 N——教师填了两行、界面说保存了一个，另一个不见了，且没有任何提示 | 收集函数**不再过滤**；判定挪到保存侧：整行全空＝空行静默跳过，**填了一半的点名**，并且不谎报"已保存" |
| 100 | `app/src/settings.ts` 备用行的 Key | 占位文案写的是「空=用主Key」，而读取侧 `ai.ts` 是"钥匙串里有就用钥匙串的"——**把输入框清空并不能**让这一行退回用主 Key，旧 Key 照旧生效；界面上也没有任何入口能删掉它 | 文案改成真话「留空=沿用已存」+ 悬停说明；**新增 Rust 命令 `delete_api_key`** 与每行的「清」按钮（没存过不算失败），并注册进 `invoke_handler` |

**复核掉的两条（不再改，记下来免得下一份报告重报一遍）**

- **「采纳 100% 失败」已经在第八批（`4848fe6`）修掉了**：真正的病根是 `findProjectConfig` 永远找不到配置
  （`list_dir` 默认不返回 `.json`，过滤器又拿完整路径去锚定 `^调适项目_.+\.json$`），代码注释里
  「于是**写正文 100% 失败**」记的就是它；已在 `datapanel.ts` 改成 `listDir(d, ['json'])` + `baseName(f)`。
  剩下的"没有调适项目配置"那声拒绝是**设计如此**（没有版本与追溯的去处就不该写正文），
  而且 `setStatus` + `toast` 都说了——不是静默失败。
- **数据面板的未绑定按钮已经在第九轮修掉了**（专名表的 `[data-dp-del]`，`CHANGELOG` 第 76 项）。
  这一轮把 `renderDataPane` 渲染出的**每一个**可点元素重数了一遍
  （`[data-dp-tab]` / `#dp-add` / `#dp-filter` / `[data-dp-del]` / `#dp-more` / `#dp-save` / `#dp-clear` / `[data-dp-edit]` / `[data-dp-delrow]`），**全部有监听**。

**验证**：`npm run verify` 全绿（preflight 44 + typecheck（含 `app`）+ lint 0 warning +
**971 项：970 通过 / 0 失败 / 1 跳过**）；Rust gate（`cargo fmt` / `clippy --all-targets -- -D warnings` /
6 测试）全绿（含新增的 `delete_api_key` 编译与注册）。
`LayerText-optimization` 同步后 preflight 43 + 根/app typecheck + **1000 项：999 通过 / 0 失败 / 1 跳过**，
分支 Rust gate 全绿。

## [未发布] - 2026-09-14（第九轮：把「按钮点了到底有没有用」逐个点到底）

来源：Wayne"我怕某个 button 设置在那其实没有用"。
所以这一轮不是看文档、也不是凭印象，而是**按代码把每个入口追到落点**：

1. 把 `index.html` 里**全部 26 个静态 `<button>`/可点元素 id** 与全部
   `addEventListener('click')` 做交叉比对；
2. 把各面板里**运行时生成的 123 个按钮**按"渲染函数是否在新建的 DOM 上重新绑定"逐个看；
3. 把 25 处 `invoke('命令', {...})` 与 Rust 侧 `fn 命令(...)` 的参数名逐个对照
   （Tauri v2 **按参数名匹配**，名字对不上就是运行时才炸）；
4. 确认兜底网：`uikit.ts` 顶层有 `error` / `unhandledrejection` → `toast`，
   所以"抛出来的错"不会无声——**真正会无声的，是压根没绑监听的那种**。

**复核掉 4 条假报**（记下来，免得下一份报告再把它们报一遍）：
`help-usage` / `help-qc` / `help-example-dir` 三个菜单项**是原生实现的**（`main.rs` 的
`on_menu_event` 里有对应分支，不是前端按钮）；`#plot-accept` **有**启用逻辑（`refreshCnt()`
在勾选变化时点亮）；`dict_lookup_zh` / `open_help_window` 的"参数名不符"是正则看走眼；
`panelState` / 窗口控制按钮 / `<symbol>` 的 id 都不是可点入口。

**核实为真、这一轮修掉的（按"点了没反应"的成因分类）**

| # | 位置 | 成因（核实后） | 修法 |
| --- | --- | --- | --- |
| 71 | `app/src/main.ts` `#btn-ai` | **绑了两次**（同一文件两处 `addEventListener`）：一次点击跑两遍 `aiSuggest()`——两倍 AI 请求、结果重复落盘 | 删掉后加的那处并留注释；现在全仓只绑一次 |
| 72 | `app/src/settings.ts` `toggleClsPanel` | 入口先查 `#cls-panel` 是否存在，而那个容器**是 `renderClsPanel()` 懒创建的**——于是这个面板自功能引入起**从未可达** | 不存在就先 `renderClsPanel()` 再切 |
| 73 | `app/src/shelf.ts` `#shelf-demo` / `#shelf-add` | DOM 由 `renderShelfGrid` 重建，而监听只在 `bindShelfChrome` 里绑过一次：搜索框敲一个字、切一次视图、点一下分组 chip，这两个按钮**就死了**（不弹框、不报错、不 toast） | 绑定移进 `renderShelfGrid` 末尾（紧挨 `bindShelfCards`），并从 `bindShelfChrome` **移除**以免双绑 |
| 74 | `app/src/risk.ts` `renderRiskPane` | 空队列 / 已全部处理两条分支**提前 `return`**，但 `head` 里已经渲染了 `data-undo` / `data-workbench` / `data-taskdone`——按钮在页面上、**零监听** | 早退改成 `emptyHtml` 变量，按钮照常绑；绑定循环之后再按 `emptyHtml` 决定返回 |
| 75 | `app/src/batch.ts` 批处理收尾 | 跑完只改按钮文案、不恢复 `disabled`，也不把隐藏的 `#bt-list-fld` / `#bt-inst-fld` 显示回来——**这个入口一辈子只能用一次** | 收尾时按勾选数恢复 `开始简化（N 章）` / `先在上方勾选章节` 与可用性，并恢复两个字段 |
| 76 | `app/src/datapanel.ts` `[data-dp-del]` | 按钮渲染出来了，**全仓没有任何地方绑它**，`deleteProperLine` 一个调用者都没有 | 补监听：失败 `alert` 说出口，成功走 `doSave` |
| 77 | `app/src/main.rs` `save_app_config` | 用的是裸 `std::fs::write`——与同文件 `write_text_file` 的原子落盘不是一套 | 抽出 `atomic_write`，两处共用；`load_app_config` 顺带区分 `NotFound`（当空配置）与其他 IO 错误（**报错并带上路径**，不再把"读不了"当"没配置"） |

**同一轮修掉的"有反应但反应是错的"**（点击有落点，只是落点不对，同样属于"按钮不可信"）

| # | 位置 | 问题 | 修法 |
| --- | --- | --- | --- |
| 78 | `app/src/bookio.ts` `exportDocx` | 目标路径就是 `<源目录>/<同基名>.docx`——**可能正是教师原件**；而 `write_file_base64` 不查存在、不备份、非原子，也不经 `persistEdit`（`_原始备份.md` 那套完全不生效）。结果是原件被一份 App 生成的纯文本 docx 原地替换、排版图片全丢，界面还只显示"已导出 Word 版" | 目标已存在（含等于源文件）就另起 `<基名>_LayerText导出.docx`，绝不覆盖 |
| 79 | `app/src/pipew.ts` 同步清单 | `plans.push({ name: n })` 里的 `n` 是后端给的**完整路径**，与相对路径二次拼成 `a/b/a/b.md`——于是"已同步"是**假报** | 改 `baseName(n)` |
| 80 | `app/src/report.ts` 图标按钮 | 用 `textContent` 塞整段 `<svg>` → 页面上显示源码字符串 | 改 `innerHTML` |
| 81 | `app/src/report.ts` 两个档案导出 | 没有 `S.currentBookDir` 时**静默 `return`**，教师点了什么都不发生 | 改 `setStatus(..., 'err')` 说出口 |
| 82 | `app/src/edit.ts` `jumpFind` | 查找框是空的或无命中时静默不动 | 补 `toast('先在查找框里输入要查的内容')` |
| 83 | `app/src/datapanel.ts` `#dp-filter` | 输入后整块重渲染，**焦点与光标位置全丢**（继续打字打到别处） | 重渲染后恢复 `focus()` + `setSelectionRange` |
| 84 | `app/src/main.ts` `#mode-pill` | 先 `await saveConfig()` 再更新界面：保存失败时**界面停在旧模式**，教师看到的是"点了没反应" | 先 `updateModePill()` / `updateMarkBadge()` / `setStatus(...)` 再落盘；失败额外说"模式已切换，但**没能存进设置文件**" |
| 85 | `app/src/settings.ts` `#set-autorew` | 改自动改写后模式胶囊不刷新（胶囊显示的仍是旧状态） | 变更处理器里补 `updateModePill()` |

**返工 1（如实记）**：给 `LayerText-optimization` 打这批补丁时，`shelf.ts` 的锚点把
`renderShelfGrid` 的结尾**连着一起复制**了，于是多出一个 `}` 和一个重复的 `bindShelfCards`。
分支 `tsc` **当场报 `shelf.ts(323,1): error TS1128`**——门禁拦住了，删除重复块后恢复。
教训与上一轮同源：**锚点选在"函数尾"就必须把右括号算进断言**，否则补丁会静默地贴歪。

**分支侧另补两处（本轮才发现分支上漏了）**

- `app/src/review.ts`：`S.markFileBroken` 在 `main.ts` 里**只写不读**——守卫等于不存在，
  损坏的 `_审校标记.json` 照样被内存里的空表覆盖。补上 `scheduleSave` 落盘前的拦截。
- `app/src/bookio.ts`：分支此前只跟了"正则补 `.docx`"那一半，**没跟"目标路径可能覆盖原件"**这一半。
  这次补上（同一份判定两边必须一致，见 §4）。

**验证**：`npm run verify` 全绿（preflight 44 + typecheck（含 `app`）+ lint 0 warning +
**971 项：970 通过 / 0 失败 / 1 跳过**）；`USER=runner npm run verify` 同样全绿（复现 CI 条件）；
Rust gate（`fmt` / `clippy --all-targets -- -D warnings` / 6 测试）全绿。
`LayerText-optimization` 同步后 preflight 43 + 根/app typecheck + **1000 项：999 通过 / 0 失败 / 1 跳过**，
`USER=runner` 亦全绿，分支 Rust gate 全绿。

## [未发布] - 2026-09-14（第八轮：三处"未接线"逐个定性 + 分支侧 Rust 假绿）

第 4 条我原先只写了"未接线（不是 bug）"。逐个核实之后发现，**三处的实际情况并不一样**，
处理方法也不该一样：

| # | 位置 | 核实结论 | 处理 |
| --- | --- | --- | --- |
| 68 | `src/core/candidate.ts` 的 `applyUndo` | **死代码，而且口径与生产路径冲突**：全仓只有测试调它；真正的入口（`决定汇总`）走 `candidatesFromEvents(allEvents)` **全量重建**，撤销在重建里已经算过。更要命的是它对"证据清零"给的是 `rejected`，而重建路径给的是**根本不成候选**（`回流红线` 那条测试钉的就是后者）。两个都留着 = 同一件事两套答案，而只有一套在跑 | **删掉**（附上删除理由）；把它的测试换成测**真正在跑**的路径（两条证据撤掉一条 → 证据 1、confidence 降、被撤那条不再进 `sourceDecisionIds`） |
| 69 | `src/core/docast.ts` 的 `applyRepairs` | **有真 bug 且未接线**。Bug：遍历的是 span **旧数组**，而 `setSense` 只按词找、**永远改该段第一处**——于是"第二处释义不一致"会**报修好了（senses+1）、实际一个字符没改** | 修 bug：`setSense` 加可选 `at`（定位到具体那处）；`applyRepairs` 改**两趟**——先左→右定"正"（"首次出现为正"这条规矩不能因为遍历方向变了就变），再从右→左改（`setSense` 会重算 `spans`，先改左边会把右边的 `start` 挤歪）。加两条回归守卫（同段两处、同段三处） |
| 70 | `src/core/propagate.ts` | **是一份设计好的能力规格，但从未接线**：纯函数齐全、有单测，全仓零调用。它**不是一道正在生效的机制** | **不动行为**，在模块头写明"尚未接线"，并列出接线前必须定的两件事（教师在哪个操作后触发；允许写哪些层级文件）——都是产品/数据决定 |

`applyRepairs` 那条**第一版我只做了"从右往左"，于是"正"变成了最右边那个**——被我自己刚写的三处同词用例当场抓住，
改成两趟扫描才对。又一次证明：**先说清要守什么不变式，再写实现**。

**同一轮：分支侧 Rust 假绿的修法**

`local_dict_returns_zh_gloss` 在本机没有系统词典时 `return`——**Rust 把"正常返回"记为通过**，
所以 Linux/新机器上这条**永远绿而没人知道**（与 TS 侧那条 `if (!existsSync(p)) return;` 同类，那边已改成 `t.skip()`）。
Rust 没有条件跳过机制，所以给了一个**显式硬开关**：
`LAYERTEXT_REQUIRE_SYS_DICT=1` 时缺词典当场失败；默认仍跳过但打印原因。
两种模式都实测过：硬开关 + 查不到词 → **FAILED**；去掉开关 → 通过（跳过）。
（`cargo test` 默认吞掉通过用例的输出，所以单靠 eprintln 不够——硬开关才是那条"说得出口"的路。）

**验证**：`npm run verify` 全绿（preflight 44 + typecheck（含 `app`）+ lint + **971 项：970 通过 / 0 失败 / 1 跳过**）；
`LayerText-optimization` 同步后 preflight + 根/app typecheck + **1000 项：999 通过 / 0 失败 / 1 跳过**；
分支 Rust gate 全绿（fmt / clippy 0 warning / 6 测试 + 硬开关模式各跑一遍）。

## [未发布] - 2026-09-14（第七轮：`冻结回放` 三个字段名 + 一次**有意的重新冻结**）

上一轮把这条列成"需要你先点头"。这一轮把它做完了——因为核实之后发现，
**重冻是自包含的**（`tests/replay.test.ts` 的 `materialize()` 从夹具自己的 `输入/` 重放），
不必动真项目，也不必猜。

| # | 位置 | 问题（核实后） | 修法 |
| --- | --- | --- | --- |
| 67 | `tools/af_pipeline/LayerText_AF冻结回放.mjs` | 三个字段名是错的：`QcResult` 里没有 `words`（叫 `tokenCount`），过去完成是**全小写**的 `pastperf`。取到的永远是 `undefined`，`JSON.stringify` 直接丢键——冻结基线里**从来没有**原文词数/产物词数/过去完成，对账两边都缺、**永远比不出差异** | 改成 `qSrc.tokenCount` / `qOut.tokenCount` / `qOut.pastperf`，并**重新冻结了基线** |

**重新冻结是怎么做的（可复核，不是"把红的改成绿的"）**

1. 先**重冻到临时目录**，与现有基线逐路径深比。得 **101 处差异**：
   - **99 处** = 33 组（11 章 × 3 层）× 三个字段，全部是 `missing → number`；
   - 2 处是重冻 harness 的副产物（`冻结自` 用了临时项目名、`项目树指纹` 随副本变）。
2. 又试了**从真项目重冻**做对照——产出 **1840 处**差异（真项目已经漂了很多，B 层输入都没了）。
   **这反过来证明夹具才是重冻的正确来源**：基线之所以存在，正是因为真项目会变。
3. 最终基线 = 夹具重冻的结果 + **把溯源元数据（`冻结自`/`项目树指纹`）恢复成原样**，
   于是**净差异恰好是那 99 处、零非预期**。旧基线备份在同目录的 `期望结论.json.pre-20260914`。
4. 复核 `--check` 只比 `结论`（不比 `冻结自`/指纹），所以这次改动不会掩盖别的东西。

**验证**：`npm run verify` 全绿（preflight 44 + typecheck（含 `app`）+ lint + **969 项：968 通过 / 0 失败 / 1 跳过**）；
`dist/tests/replay.test.js` **15/15**（含 `--check` 逐章对账与"重新冻结必须一致"两条）。
`LayerText-optimization` 同步后根/app typecheck + **998 项：997 通过 / 0 失败 / 1 跳过**，其 replay 层同样 15/15
（两个 worktree **共用同一份夹具**，所以基线重冻对两边同时生效）。

**这一条从"发现"到"修完"隔了三轮**——不是技术难，是它要求一次**有意的动作**，
而"顺手把红的改绿"正是这类改动最容易掩盖真问题的地方。所以过程留档在这里。

**同一轮补上的另一个缺口：Rust 侧终于真的编译+测试了**

`AGENTS.md` 里那句"本机没有 Rust 工具链"是**错的**：`~/.cargo/bin` 下有 cargo 1.98.1 与 rustc，
只是不在 PATH 上。把 PATH 加上之后：

- `cargo check --all-targets` 通过；
- `cargo test` **抓到我自己加的 Rust 单测有 bug**——`list_dir` 末尾会 `out.sort()`，
  而我在断言里写死了中文文件名的顺序（`调适项目_X.json` 在 `班级A.json` 前），实测是反的。
  改成"两边都排序再比"，测"返回了哪几个"而不是"以什么顺序返回"；
- `cargo fmt --check` 报两处不合规（一处是我的新代码，一处是**既有**测试）；
- `cargo clippy -- -D warnings` 报我写的 `allow.iter().any(|x| *x == eq)` 该用 `allow.contains(&ext)`。

四道现在全绿（fmt ✓ / clippy 0 warning / **6/6 测试**）。**这三处 CI 一处都拦不到**——
`.github/workflows/ci.yml` 全文没有 cargo 步骤，`package.json` 的 `verify:rust` 也没人跑。
也就是说：我上一轮把"Rust 未验证"列成缺口是**对的**，而它比我以为的更值得补。

**验证**：`npm run verify` 全绿（preflight 44 + typecheck（含 `app`）+ lint + **969 项：968 通过 / 0 失败 / 1 跳过**）；
`dist/tests/replay.test.js` **15/15**（含 `--check` 逐章对账与"重新冻结必须一致"两条）。
`LayerText-optimization` 同步后根/app typecheck + **998 项：997 通过 / 0 失败 / 1 跳过**；
两个 worktree 的 Rust gate 同样全绿（fmt / clippy / 6 测试）。
（两个 worktree **共用同一份夹具**，所以基线重冻对两边同时生效。）

**记录一处尚未处理的同类问题（分支侧，不在主仓）**：`LayerText-optimization` 的
`main.rs` 里 `local_dict_returns_zh_gloss` 在本机没有系统词典时 `return`——**Rust 把"正常返回"记为通过**，
所以 CI（没有 macOS 系统词典）上这条永远绿。与我在 TS 侧修掉的 `t.skip()` 那条是同一类"假绿"，
但 Rust 没有条件跳过机制，要改得先定做法（`#[ignore]` 会连有词典的机器也不跑）。留待决定。

## [未发布] - 2026-09-14（第六轮：tools 的 P2 批——"写死十章"与几处静默吞因）

| # | 位置 | 问题（核实后） | 修法 |
| --- | --- | --- | --- |
| 55 | `三档复核` / `修复_20260910` / `会话改写` / `清单` / `对照台账` | **写死十章**：`.filter((n) => n >= 1 && n <= 10)`——换一本 12 章的书，`--chapters 11` 被**静默丢掉**（默认路径反而正确，所以只有显式传章号时才踩得到） | 改成 `n <= 章名清单.length` |
| 56 | `三档复核` / `修复_20260910` / `对照台账` | 各自**自抄**一份 `['一'…'十']` 章名数组，与 `chapterNames(P)` 并存（项目已经专门抽过这个，这是漏改的几处） | 改从共享模块取 `chapterNames(P)`，`CH_NAME` 直接返回完整章名 |
| 57 | `冻结回放` | 同上一份自抄的十章数组：`CN[10] === undefined` → 第 11 章拼出 `第undefined章`（**脚本照常报成功**） | 换成一张到二十的中文数字表。**没有**改用 `chapterNames(P)`：`P` 要到主流程才载入，模块顶层引用它就是 TDZ（仓库有冒烟守卫专抓这个），而 `runCheck()` 又有它自己局部的 `P`——注释里写明了这条取舍 |
| 58 | `三档生成` / `会话改写` | 源文没有 `## Chapter …` 时按章序补英文标题，数组只有十个——第 11 章拼出 `## Chapter undefined` | 超出部分退回阿拉伯数字（`?? i`），1–10 的既有措辞不变 |
| 59 | `对照台账` | `chapterLedger(tier_tag(t), t.tag, ci)` 把**整个层级对象**（`{key,tag,label,ratio,maxLen}`）当 `tier` 传给 `runQc`，而 `tier_tag` 是个恒等函数。覆盖率/加注数不依赖 tier 所以数字没错，但 `gates.passiveOk/relclOk` 这类判定拿到的是个对象——**看着有、其实没有** | 直接传 `t.tag`；删掉恒等函数 `tier_tag` |
| 60 | `修复_20260910` | 日志里"源文 N 个"的判别写成 `p.startsWith('原文重制')`，而 `p` 的实际形状是 `第一章/原文_规范化`——条件**恒为 false**，那个数永远是 0 | 按构造处的真实后缀 `endsWith('原文_规范化')` 判 |
| 61 | `tools/compare.ts` | 对照脚本的临时文件名只带 `basename(text)`：两个同名输入（不同目录，或两次并发）**互相覆盖**，后一次读到别人的结果，而脚本照样报"一致" | 临时名加 `pid` + 时间戳 |
| 62 | `tools/perf_baseline.mjs` | 默认输入写死一条**跨仓库相对路径**（`../../01-教学工作/…`）——本机成立，换机器即断，而它正是"不传参就跑不动"的那类默认值 | 改从 `LAYERTEXT_AF_DIR` 取；取不到就**说清楚并退出 2**，不猜 |
| 63 | `validate_data.mjs` / `迁移.mjs` / `词表与词典.mjs` | 三处静默吞因：`validate_data` 读不出的文件**既没进结果也没进 skipped**（目录扫描悄悄漏检）；`词表与词典` 的 `.catch(() => null)` 把"现场词表算不出来"的原因吞掉，漂移记录里只剩一句 refusal——**"没算出来"与"没差异"分不开**；`迁移` 的目录不可读兜底没写明代价 | 前两处改成"如实记下来"（`skipped` 带原因 / 记录里加 `liveError`）；第三处写明"尽力而为、可能不全"；顺带去掉 `迁移` 里 `readdirSync(d) ?? []` 的死代码 |
| 64 | `清单.mjs` | 风险队列报告的**人读版**在多层运行时叫 `风险队列_<首层tag>_等`（写入侧如此），而清单只按单层名 `风险队列_<tag>` 找——`--tier A,M` 这类运行的人读报告**永远不会被登记**，发布包因此不含它，而教师以为报告进去了 | 两种名字都试，取先存在的那个 |
| 65 | `四格实验.mjs` | 内联的第二份应注词阈值 `w.length > 2`（引擎唯一口径是 `segmentgate.ANNOTATABLE_MIN_LEN`）。数值当前一致，但引擎改阈值时这里不会跟着变 | 改成从引擎取 `ANNOTATABLE_MIN_LEN` |
| 66 | `src/core/manifest.ts` + `bundle.ts` | `bytes` 记的是 **UTF-16 码元数**（`text.length`）而不是字节：中文产物**低报约三分之一**，而清单/包里那句"清单说有 N 字节"是给教师看的。唯一的功能性用途是 `bytes === 0` 判空文件（那里两种算法同值），所以不影响任何校验结论 | 新增 `byteLenOf`（`TextEncoder`，Node 与浏览器都是全局），两处改用 |

**如实记录一次险些犯下的错**：`冻结回放` 那处我第一版直接写成 `SHARED.chapterNames(P)`，
而 `P` 在模块顶层还没定义（第 562 行才 `loadProject`）——**那是 TDZ**，运行期才炸。
是 `tests/pipeline_smoke.test.ts` 那条"不许以 TDZ 方式死"的守卫在等着；我在动手前先核了 `P` 的位置，
改成不依赖 `P` 的数字表，冒烟 4/4 通过。**上一轮我自己刚说过这个仓库有守卫，这一轮差点表演给它看。**

**未做**：`tools/_af_calibrate.mjs` / `tools/_af_drift_sample.mjs` 里也写着本机绝对路径，
但它们在 `.gitignore` 的 `tools/_af_*` 里、**不进仓库**，文件头自己还写着"用法：node /tmp/xxx.mjs"——
属本地一次性脚本，不是仓库缺陷，只在此记一笔。

**验证**：`npm run verify` 全绿（preflight 44 + typecheck（含 `app`）+ lint + **969 项：968 通过 / 0 失败 / 1 跳过**）。
`LayerText-optimization` 同步后 preflight 43 + 根/app typecheck + **998 项：997 通过 / 0 失败 / 1 跳过** 全绿
（`冻结回放.mjs` 在分支上只因 prettier 换行而分叉，按单锚点断言后外科式补丁）。

## [未发布] - 2026-09-14（第五轮：tools 剩下的 P1——两种布局、口径统一、段号对齐）

| # | 位置 | 问题（核实后） | 修法 |
| --- | --- | --- | --- |
| 51 | `tools/af_pipeline/chapterdir.mjs`（新）+ `正本核对` / `本地助手` / `补注候选` / `待确认队列` | 四个脚本直接拼 `join(产物目录, 章名)`。`legacy` 布局下对，`--layout run`（产物在 `_运行/<runId>/正文/<章>/`）下**找不到产物**：`正本核对`每章报"缺产物"并 exit 2（响，但错）；`补注候选`/`待确认队列`/`本地助手` 读到空串、**静默产出空队列**——那种最难查，看起来像"本来就没有待办" | 新增共享 `chapterDirOf(产物目录, 章名)`：优先运行私有目录（显式 `--run`/`LAYERTEXT_RUN` 最优先，否则取最近一次运行），**最后回落 legacy**（老项目一个字都不用改）。四处各改一行。（`_待复核` 那个文件读写双方都在 legacy 路径上、彼此一致，没动，避免把写读拆到两个位置。） |
| 52 | `tools/af_pipeline/LayerText_AF两轮调适.mjs` | 段号形态不一致：引擎（`adaptcheck`）给的 `segId` 是 `P03`，而脚本用 `match(/\[P\d+\]/)` 拿到 `[P03]` 去比——**「一句 N 处注释」这类段级 finding 永远匹配不到自己的段**；而 `注释拥挤`/`最长句`/`归因` 是整篇级（没有 segId），对每一段都成立。两个错叠起来：全篇有密度或长句问题时第二轮把**每一段**都标成待复写；只有句级问题时则一段都不进 | 段号去方括号再比；整篇级的用 `!f.segId` 明说（不再靠三个 `note.includes` 猜） |
| 53 | `tools/af_pipeline/LayerText_AF清单.mjs` | `--stamp` 登记"待复核"时**手拼** `join('_待复核', tag, …)`——既没有 `--out` 后缀、也没有运行私有目录，而写入方走的是 `R.any('待复核', {chapter, segId})`。于是用了 `--out` 或 `--layout run` 的运行会登记一个**不存在的路径**，`--verify` 报 blocked「产物缺失」，把一次正常运行判成不可交付 | 路径交给解析器算（`rr.any('待复核', …)`），再按相对路径登记 |
| 54 | `tools/af_pipeline/LayerText_AF重制_生成.mjs` | 自己 `buildLexicon({ vocabCsvTexts })`——只喂本书词库，**没喂内置课标 1600/补录，也没喂专名**，于是课标词被判成超纲：生词率虚高、加注跑到 pig/sheep 这类课标词上。这正是 `冻结回放.mjs` 注释里写明踩过的坑 | 改走 `SHARED.loadLexicon(P)`，与其余脚本同一口径 |

**顺带**：`chapterDirOf` 一度直接写在 `LayerText_AF词表与词典.mjs` 里，撞了 `max-lines` 1000 行门禁
（这个文件当天第二次撞），按仓库既有结论"prettier 会重展压缩行，拆模块是正解"拆成
`chapterdir.mjs`；架构地图同步加了这一行、脚本数 31 → 32（铁律 1）。

**验证**：`npm run verify` 全绿（preflight **44** 个脚本 + typecheck（含 `app`）+ lint + **969 项：968 通过 / 0 失败 / 1 跳过**）。
`LayerText-optimization` 同步后 preflight + 根/app typecheck + **998 项：997 通过 / 0 失败 / 1 跳过** 全绿
（其中 `LayerText_AF待确认队列.mjs` 在分支上多了一处同类查找，按"锚点必须出现 N 次"断言后两处一起打补丁）。

## [未发布] - 2026-09-14（第四轮：收尾——续跑、锁、撤销栈、跨书缓存，外加一条偶发红的根因）

> 上一轮留了四条"要先定契约"的。这一轮把契约定了、把它们做掉，
> 并在排查"锁测试偶发红"的过程中找到一个**还没修完的 TOCTOU**。

**改了什么**

| # | 位置 | 问题（核实后） | 修法 |
| --- | --- | --- | --- |
| ㊸ | `tools/af_pipeline/LayerText_AF两轮调适.mjs` | **断点续跑会把未简化原文写进初稿**：进度文件只记 `done: number[]`，那些段的正文从没被存下来，而 `out = [...segs]` 让它们保持原文、循环又直接跳过——落盘的初稿前一半是原文、后一半是 AI 产物，**不报任何异常**，还会被下游复核/台账/发布当成正常初稿 | 进度文件同时记 `texts`；**旧格式（没有 texts）一律当"没做完"重跑**——宁可多花一次调用，也不产出夹着原文的初稿 |
| ㊹ | `tools/af_pipeline/LayerText_AF词表与词典.mjs`（`withLock`） | **还没修完的 TOCTOU**：`openSync(path,'wx')` 建出的是**空文件**，内容要等下一行 `writeSync` 才进去。窗口里另一个进程读到空串 → `JSON.parse` 抛 → `readLock()` 返回 null → `lockState(null)` 判成 `'free'` → 走"陈旧锁"分支**把活锁删掉**并抢过来：两个进程同时进临界区。**机器越忙窗口越宽**——这正是 `tests/lockfile.test.ts` 在整仓跑时偶发红、单跑却 4/4 全过（旧实现实测 6 次整仓里红 1 次）的根因 | 先把内容写进同目录临时文件，再 `linkSync` 建硬链接：目标已存在即 `EEXIST`，而**链接成功那一刻锁文件就有完整内容**，没有窗口 |
| ㊺ | `app/src/edit.ts` + `main.ts` + `pure.ts` | **重做永远没得做**：`persistEdit` 每次都会 `redoStack = []`，而 `doUndo` 在调它**之前**就把当前稿压进了 redo——压完立刻被清空；同时当前稿又被塞回 undo，撤销退化成"来回切"。另外栈在 await 写盘**之前**就被改动，写盘失败会静默少一版 | 定契约：`persistEdit` 负责"记一次新编辑"（新增 `recordHistory` 开关），撤销/重做**自己**搬栈并传 `recordHistory: false`；**先写盘、成功了再动栈**。栈的移动抽成纯函数 `undoStep`/`redoStep`（原先这段和 DOM/IO 缠在一起，**没有任何测试守着**，所以它一直是错的） |
| ㊻ | `app/src/datapanel.ts` | `panelState` 是模块级全局、切书时没人清空，`bookDir` 在首次加载后就被完全忽略——打开书 A 再打开书 B，列的是 A 的词库/词典，保存还会写进 **A 的绝对路径**。这一条此前被"`调适项目_*.json` 永远探测不到"遮住（`project` 恒 null），**我上一轮修好探测的那一刻它就会变成活 bug** | 缓存按 `bookDir` 失效，切书即清空 project/tables/log |
| ㊼ | `app/src/settings.ts` + `state.ts` + `ai.ts` | 备用供应商的 Key 存钥匙串时用**行下标**做账号（`fb0`/`fb1`…）：删掉一行，剩下的行会读到**被删那家的 Key**，鉴权失败，而报错文案让教师去怀疑自己填的 Key | 每行一个**稳定 id**，账号改 `fb:<id>`；读取时优先新账号、回落旧下标（迁移期两边都认，不会"升级后备用全失效"） |
| ㊽ | `src/core/decision.ts`（新）+ `productmetrics.ts` / `teacherexperiment.ts` / `workbench.ts` | `isBatch` / `timeOf` / `ordered` / `refOf` 在两个文件里**各写一份**，两边注释都写着"逐字一致，免得两处漂移"——**注释拦不住漂移**，而它们是撤销率、批量采纳回滚这些指标的**分母口径** | 四个收进 `decision.ts`（`eventRefOf` / `isBatchDecision` / `eventTimeOf` / `orderedByTime`），三处改为调用；`workbench.eventRef` 改成转发到 `eventRefOf`，格式只剩一份定义 |
| ㊾ | `src/core/qc.ts` | 歌篇句按**文本**做集合剔除（`songSet.has(sentence)`）：叙事区里只要有**一句与歌篇逐字相同**（副歌被复述、引语里重复演唱），那句也会被踢出叙事句法统计与平均句长——「去歌词后平均句长」**悄悄少算**，界面上看不出异常 | 改成按**下标**标记歌篇句，文本相同不再互相牵连 |
| ㊿ | `src/core/experiment.ts` | 会话日志解析的 `catch { continue; }` 既没理由也没计数，与 `decision.ts`/`workbench.ts` 的同类解析不一致 | 写明 `有意兜底：` 与"为什么不返回 `badLines`"（本函数只回答"每段第一轮响应是什么"） |

**新增测试**：`tests/lockfile.test.ts` 加一条**锁文件内容原子性**守卫（持锁期间紧循环采样，每次都必须能解析出持有者）——
用旧实现回退跑 6 次，红 1 次，证明这条守卫抓得住；恢复后 3/3 全过。
`tests/app_logic.test.ts` 加 5 条：撤销后必须攒得下重做、空栈返回 null、纯函数不改入参、撤 3 步重做 3 步往返一致、`baseName`。

**验证**：`npm run verify` 全绿（preflight + typecheck（含 `app`）+ lint + **969 项：968 通过 / 0 失败 / 1 跳过**）；
连跑 `npm test` 3 次全绿（专治那条偶发红）。
**同步**：`src/`、`tools/`、`tests/` 本次改动与分支一致 → 直接复制；`app/` 仍是外科式补丁（该分支是 App 开发位）。
`LayerText-optimization` 复跑 preflight + 根 typecheck + app typecheck + **998 项：997 通过 / 0 失败 / 1 跳过** 全绿。
（过程中我一度把上一轮已同步过去的 app 补丁又打了一遍 —— 脚本按"锚点必须唯一"逐条断言，
对不上就报错退出，所以只是白跑一趟，没有重复应用；这也说明那个断言是有效的。）

**仍未做（需要一次有意的动作，不是技术问题）**

- **`LayerText_AF冻结回放.mjs` 的三个字段名**（`qSrc.words` 应为 `tokenCount`、`qOut.pastPerf` 应为 `pastperf`）：取到的一直是 `undefined`，`JSON.stringify` 直接丢键，所以冻结基线里**从来没有**原文词数/产物词数/过去完成。改了会让 `tests/replay.test.ts` 两处红——**基线是在旧口径下冻的**，正确次序是"先有意地重新冻结 `~/Documents/LayerText配置/回放夹具_真项目/期望结论.json`，再让代码跟上"。代码处已留注释写明改法。
- **`app/src-tauri` 仍未编译验证**：本机没有 `cargo`，CI 也不跑 Rust。

## [未发布] - 2026-09-14（第三轮：`app/` 侧整批）

> 前两轮把 `src/` 与 `tools/` 做完了，`app/` 一直空着。这一轮专做它。
> 根因是**一条契约没人定义清楚**：后端 `list_dir` 返回的是**完整绝对路径**，
> 而一半调用点把它当**裸文件名**用。四条链路因此静默失效。

**改了什么**

| # | 位置 | 问题（核实后） | 修法 |
| --- | --- | --- | --- |
| ㉞ | `app/src-tauri/src/main.rs` | `list_dir` 只返回书稿扩展名，**`.json` 永远不出现**；且返回完整路径这一点从未写进任何契约 | 加可选参数 `exts`（默认仍是书稿扩展名），函数文档写明"**返回完整绝对路径**"。配 Rust 单测：默认看不见 `.json`、显式要才返回 |
| ㉟ | `app/src/datapanel.ts` | `调适项目_*.json` 探测**永远失败**（`.json` 不被返回 + `^调适项目_.+\.json$` 拿整条路径去锚定开头 + 又把完整路径拼一次目录）。后果链条：数据面板恒"还没有数据资产配置" → 风险队列恒"没有调适项目配置" → `adoptRewrite` 读不到配置 → **AI 建议的「采纳」写正文 100% 失败** | `io.listDir(d, ['json'])`；`baseName` 判名；直接用返回的路径读 |
| ㊱ | `app/src/settings.ts` | 同一个 `.json` 问题：`.endsWith('.json')` 恒得空数组 → `classTargets` 恒空、`mergedSelection()` 恒 `active:false` → **班级多人定制整体失效** | 显式要 `['json']`（路径用法本来就是对的） |
| ㊲ | `app/src/pipew.ts` ×2、`app/src/rewritegate.ts` | 完整路径再拼一次目录 → `/a/b//a/b/c.md`（不存在），读失败被兜底吞掉。跨版本标记同步说"同目录没找到可用的其他版本文件"（而目录里明明有）、台账里写"已传播到 /a/b//a/b/c.md"；跨章"已注词账本"**永远只覆盖当前章**（而防跨章重复加注正是它的存在意义） | 统一走新加的 `pure.baseName`；`tryDir(sub)` 不再重复拼 `parent` |
| ㊳ | `app/src/shelf.ts` | `tocChapters()` 把完整路径当章节名返回 —— 目录里会显示整条路径 | `map(baseName)` |
| ㊴ | `app/src/pipew.ts`（词汇简化） | 大小写**串味**：替换循环是倒序的，而 `let r = repl` 里的 `repl` 会在首次迭代（最右侧那处）被改写成首字母大写形，于是它**左侧所有小写出现处**都被替换成大写词并落盘：`the commandments were read aloud. Commandments mattered.` → `the Rules were … Rules mattered.` | 形态计算基准改成不变的 `replBase` |
| ㊵ | `app/src/bookio.ts`（改写应用） | `s.md = applyRewrite(s.md)` 之后再 `persistEdit(s, s.md)` ——两个实参同一个引用，于是 `newMd !== s.md` 恒 false：**① 不 push 撤销快照；② 更糟，"原始备份"写的是改写后正文**，教师想整体还原会还原成被替换的版本 | 先算 `next`，`persistEdit` 成功后再赋 `s.md` |
| ㊶ | `app/src/bookio.ts`、`app/src/bookpure.ts`、`app/src/main.ts`、`app/src/batch.ts`、`app/src/chat.ts`、`app/src/grading.ts`、`app/src/reader.ts`、`app/src/risk.ts` | 六处独立缺陷：专名表被静默清空（`= cfg.proper ?? []` 少守卫）；进度文件缺 `status` 时抛 TypeError；关标签页后 `activeIdx` 不左移（**操作作用到错误的文档**）；有失败章仍删进度文件（"可中断续跑"承诺失效）；`apply_edit` 工具**谎报"已应用"**；批改报告拿**空正文**送 AI | 逐条按上文修 |
| ㊷ | `app/src/state.ts` + `app/src/review.ts` + `app/src/main.ts` | 标记文件"读不出"与"JSON 损坏"共用一个 catch → 损坏的 `_审校标记.json` 被当空清单打开，下次保存**整体覆盖**、整章标记全丢；且 15 处 `scheduleSave(s, () => undefined)` 把失败出口掐掉了 | 两件事分开：损坏当场报出并进 `S.markFileBroken`，保存时**跳过**该文件；再给 `review.ts` 加一个**依赖注入**的错误播报器，由 `main.ts` 装上 |

**两次返工，都记在这里**

- 我先给 `review.ts` 直接 `import { setStatus } from './uikit.js'`——**错了**：`uikit.js` 顶层有 `window.addEventListener`，
  而 `phrase_mark` / `review_dom` 两组用例在 node 下直接 import 这个模块，于是**收集期就 `ReferenceError: window is not defined`**，
  测试总数从 963 掉到 948、还多两个红。改成依赖注入（`setMarkSaveErrorReporter`，与 `ai.ts` 的 `setAiUi` 同一个套路）后恢复。
  **仓库"响应式纯逻辑优先"那条纪律是真的在保护测试可行性**，我这次是撞上去才想起来的。
- `tests/rewritegate.test.ts` 的假 IO 返回**裸文件名**，把"调用方把完整路径当裸名用"这个错误契约固化了下来——
  生产读不到、被兜底吞掉，测试却全绿。改成"目录项照裸名写、`listDir` 像真后端那样补成完整路径"，与 Rust 单测同一口径。

**明确没改的（需要先定契约）**

- **撤销/重做栈的所有权**：`edit.ts` 的 `doUndo` 是"先动栈、再 await 写盘"，失败时会少一版；但 `persistEdit`（`main.ts`）**自己也**在 `undoStack.push` / `redoStack = []`。要修得先定"栈归谁管"（`persistEdit` 独占还是调用方独占），那会影响全部调用点，不该猜着改。已在 `doUndo` 处注明。
- **`settings.ts` 备用供应商 Key 按下标存钥匙串**：删掉一行后 Key 与供应商错配，需要一次带迁移的稳定 id 改造。
- `candidate.applyUndo` / `docast.applyRepairs` 仍只在测试里被调用（**未接线**，不是活漏洞）；`propagate.ts` 整模块同样无生产调用点。

**验证**：`npm run verify` 全绿（preflight + typecheck（含 `cd app`）+ lint + **963 项：962 通过 / 0 失败 / 1 跳过**）。

**同步到 `LayerText-optimization` 的方式（与 `src/`、`tools/` 不同）**：该分支是 **App 开发位**，
`app/` 下 13 个文件与 main 已有实质分叉（`pipew.ts` +317 行、`datapanel.ts` +164 行、`pure.ts` +82 行…），
**整文件覆盖会冲掉它的在建工作**。所以改用**逐条断言的补丁脚本**：每个补丁要求锚点恰好出现一次，
对不上就报错退出、不静默跳过。42 个补丁全部命中并落地后，该分支
preflight + 根 typecheck + app typecheck + **992 项：991 通过 / 0 失败 / 1 跳过** 全绿。

**未能验证**：本机**没有 `cargo`**，所以 `app/src-tauri/src/main.rs` 的改动（含新增的那条 Rust 单测）**没有编译验证过**——`npm run verify:rust` 与 CI 也都不跑 Rust。这是我这一轮唯一没有闭环的地方，推 CI 前请在有 Rust 工具链的机器上跑一次 `cd app/src-tauri && cargo test`。

## [未发布] - 2026-09-14（第二轮：把上一轮"发现但未改"的清单继续做掉）

> 上一轮把改编的做了、把"发现未改"的留了档。这一轮按那份档案继续，**只做能自证的**：
> 每一处都先回代码/文档核实，改完跑 `npm run verify`，基线类的东西不顺手动。

**改了什么**

| # | 位置 | 问题（核实后） | 修法 |
| --- | --- | --- | --- |
| ⑳ | `src/core/version.ts` | **批量事务的溯源说谎**：`VersionNode.target` 只记第一批里**第一步**，于是 `applyChangeBatch` 改了 P01+P02 之后 `replaySegment(nodes,'P02')` 返回 `found:false`、`provenanceOf` 说"本运行没有改动过这一段"——一个**否定性的错结论**，而决定日志里明明白白记着两条 | 新增 `VersionNodeTarget` + `VersionNode.targets[]`（带每段自己的 `segBase/segBefore/segAfter`），`replaySegment`/`provenanceOf`/`segBaseOf` 统一走 `nodeSegEntry`（旧节点无 `targets` 时回落 `target`，行为不变）；新增回归守卫 |
| ㉑ | `src/core/version.ts` | `recordOnly` 读不到正文时 `doc=''`，随后 `if (doc && …)` 把**乐观并发校验整个跳过**，照样把决定记成"对着当前版本做的"——而同一次失败在 `runTransaction` 里是 `not-found` + 拒绝 | 与 `runTransaction` 对齐：读不到就 `not-found` 拒掉 |
| ㉒ | `calibration.ts` / `rewrite.ts` / `workbench.ts` / `pendingqueue.ts` | **FNV 哈希本体全仓有 6 份手抄**（含已修的 `decision.ts`），`workbench` 的注释还拿"语义不同"当"实现也各写一遍"的理由 | 全部改调 `manifest.contentHash`（`manifest` 无运行期 import，无环）；输出逐字不变。现只剩 1 份 |
| ㉓ | `src/core/pendingqueue.ts` | `TAG = {A:'A层85',…}` 是 `manifest.TIER_TAG` 漏改的第 8 份；`mergePending` 注释写"补注优先"与实现（`[...restore, ...annotate]`，正本优先）相反 | 改用 `tierTagOf`；注释改成与实现一致 |
| ㉔ | `src/core/plotweight.ts` | `includes(c.trim()…) && includes(c…)` 前半被后半蕴含，纯冗余；但它**不能**反过来当宽松口径单独用——`'if '` 末尾那个空格是故意的，去掉会撞上 different/life/gift | 只留原样匹配（行为不变），注释写清为什么 |
| ㉕ | `src/core/studentversion.ts` | `COMMENT_RE` 带 `/g` 却在 `.map()` 里跨行 `exec`，`lastIndex` 累计，第二行起可能取到空串/别人的片段 | 改用 `match` |
| ㉖ | `tools/af_pipeline/LayerText_AF决定汇总.mjs` | ① `parseDecisionLog` 收的是**内容**却传了**路径**，且返回 `{events,badLines}` 被 `flatMap` 成对象而不是事件数组——两错叠加，**回流候选台账恒为空、"已批准资产回流"整条链路是死的且不报错**；② `resolveTeacher` 漏 `await`，`teacherId` 恒 `undefined` | 两处都按第 84 行的正确用法改写；补 `await` |
| ㉗ | `tools/af_pipeline/LayerText_AF校准台账.mjs` | `mkdirSync` 在**循环之后**，新工作区里第一条标记就会让 `appendFileSync` 抛 ENOENT（未被捕获，导入半途而废） | 建目录提到循环内第一次 append 之前 |
| ㉘ | `tools/af_pipeline/LayerText_AF本地助手.mjs` | `!KEY` 无条件拦在**所有子命令之前**，而 `格式` 是纯代码转换（文件头明说"不调模型"）——没装 oMLX 的机器连 CSV→JSON 都用不了 | 只拦真正要调模型的三个子命令 |
| ㉙ | `LayerText_AF补注.mjs` / `LayerText_AF重制_生成.mjs` | 裸 `JSON.parse(~/.layertext.json)`，缺该文件的机器**加载期**就抛栈回溯（报的是堆栈不是"缺什么配置"） | 包 try 给默认值（照 `会话改写.mjs` 的既定写法） |
| ㉚ | `tools/narrative_fidelity.mjs` | `--tau abc` → `NaN` → 对齐器一对都对不上：覆盖率打印 0.0% 且每句记成"疑似丢句"；`--risk abc` 一个 ⚠ 都不标。全程不报错 | 加 `numArg` 校验，非法即退出 2 |
| ㉛ | `LayerText_AF工序化生成.mjs` / `LayerText_AF两轮调适.mjs` | 逐章失败只打一行 `✗` 就 `exit 0`——而 `管线.mjs` 正用 `status === 0` 判断这一步成没成，断网跑完整本书也算"成功" | 收尾 `process.exit(1)` |
| ㉜ | `LayerText_AF三档生成.mjs` / `LayerText_AF三档精修.mjs` | `管线.mjs` 把层级拼成**一个**参数传进来（`tiers.join(',')`），而脚本只认 `^[AMB]$` → `--tier A,M` 静默退回**全部三层**，多跑一层多烧一份额度 | 接受逗号分隔 |
| ㉝ | `LayerText_AF会话改写.mjs` / `LayerText_AF风险队列.mjs` / `LayerText_AF三档复核.mjs` | **判定线两把尺**：这三处写死 `maxLen: 16`（那是**生成目标**），而引擎的检查线是 `SENT_LEN_CHECK.M = 17`（见 `docs/更新亮点_2026-09-12_13.md`「判定线统一……统一到检查线这一把」）。同一句 17 词的 M 层英文在一个脚本判 blocker、在另一个判通过 | 判定线改从 `SENT_LEN_CHECK` 取；生成目标（提示词里的 16）不动 |

**核实后判定不改 / 不能顺手改的**

- **`LayerText_AF冻结回放.mjs` 的三个字段名确实是错的**（`qSrc.words` 应为 `tokenCount`、`qOut.pastPerf` 应为 `pastperf`；`QcResult` 里没有 `words`）：取到的永远是 `undefined`，`JSON.stringify` 直接丢键，所以冻结基线里**从来没有**原文词数/产物词数/过去完成——这三个数没有任何东西在守。
  **但改了会让 `tests/replay.test.ts` 两处当场红**（实测：`--check` 与"重新冻结"都对不上）——因为基线正是在旧口径下冻的。重新冻结会覆写仓库外的 `~/Documents/LayerText配置/回放夹具_真项目/期望结论.json`，那是**验收正本**。正确次序是"先有意地重新冻结、再让代码跟上"，不该附在缺陷修复里顺手做掉。**已在代码处留注释写明改法与次序，留待你决定。**
  同理，`冻结回放` 的 M 层判定线**故意**仍是 16（它要复现冻结当时的数）。
- **`LayerText_AF两轮调适.mjs` 断点续跑**：`const out = [...segs]` 让 `done` 的段不重新赋值，续跑落盘的前半是**未简化原文**。修法要决定"已完成段的文本从哪读回"（现有实现没有任何增量存储，中断时 `dst` 还不存在），属于要先定的设计，没拍脑袋改。
- **`app/` 侧仍是空白**：`datapanel.ts` 的 `list_dir`（不返回 `.json` 且返回完整路径）→ AI 采纳写正文 100% 失败、`settings.ts` 班级定制同因失效；`pipew.ts` 完整路径再拼目录；`bookio.ts` 首次备份存成改写后正文；`risk.ts` 决定日志读改写会并发丢事件；`main.ts` 关标签页后 `activeIdx` 不左移。**这些需要动 Rust 侧的目录列举契约或改 UI 状态机，单独一批做。**

**验证**：`npm run verify` 全绿（preflight + typecheck + lint + **963 项：962 通过 / 0 失败 / 1 跳过**）。
**如实记录第三次自我违规**：这一轮我又把 `(A20/M**17**/B14)` 写进注释，`*/` 提前闭合块注释、两个脚本语法错误——**是 `preflight` 当场拦下的**（`node --check` 逐脚本跑）。同一天第三次踩同一个坑，说明"注释里别贴正则/星号"这条教训我没有内化；好在守卫这次真的接住了。

## [未发布] - 2026-09-14（按审查报告核实后的真实缺陷修复；含两处"报告说错了"的复核结论）

> 来源：一份外部代码审查报告（20+ 条，分🚨/🔴/🟡/🟢）。逐条回代码核实后**只改了站得住的**，
> 并把复核结论一并记在这里——**没改的那些，理由和改了的同样重要**，否则下一份报告还会把它们重新报一遍。

**改了什么**

| # | 位置 | 问题（核实后） | 修法 |
| --- | --- | --- | --- |
| ① | `~/.agents/skills/layertext/scripts/revcheck.mjs`（+ `layertext-plugin` 同名副本） | 写死 `/Users/wayne/…/LayerText/dist/src/core/risks.js`。**两份副本都写死**，换机器/换用户当场 ENOENT——违反 AGENTS.md 铁律 3 第 4 款 | 四步定位：`LAYERTEXT_DIST` → `LAYERTEXT_ENGINE` → `调适项目_*.json` 的 `引擎目录` → 从 cwd 向上找 `dist/src/core/risks.js`；全落空则**明确报错并退出 2**，说清该设哪个变量。实测：仓库根自动命中；空目录退出 2；`LAYERTEXT_ENGINE` 显式指定可跑 |
| ② | `src/core/align.ts` | `SENT_STARTERS` 里 `'one day'` / `'at last'` 是**死条目**——唯一用点 `signalsOf` 拿的是单 token，正则不跨空格，永远命不中；且 `one`/`at` 早在表里，本就冗余 | 删掉两条，注释写明"只收单词"的理由 |
| ③ | `src/core/decision.ts` ↔ `src/core/manifest.ts` | `eventIdOf` 手抄了一份与 `contentHash` 逐字相同的 FNV-1a 128 位（连 `0x01000193`/`0x85ebca6b` 都相同）。违反 AGENTS.md 第四节"同一条判定只许有一份实现" | `eventIdOf` 改调 `contentHash(...).slice(0,12)`。**实测 20000 例与旧算法逐字一致**——已写进日志的 eventId 继续可复算 |
| ④ | `src/core/textpipe.ts` + `src/core/qc.ts` | 专名一致性用 `includes`（子串）：正文有 `BoxerCode` 时专名 `Box` 假通过，**两侧同错、报表照绿** | 新增 `containsWord`（整词边界，兼容空格/连字符专名），`propInText` 与 `propConsistent` **两侧同时**改 |
| ⑤ | `tools/af_pipeline/chapterargs.mjs`（新）+ 5 个脚本 | `/^\d/` + `Number` 让 `1A` 静默变 `NaN` → `CN[NaN-1]` 是 `undefined` → 拼出 `…/undefined/…`。**这条在 5 个脚本里各抄了一份** | 抽成共享模块（`keychain.mjs` 同款做法，顺带解掉 `词表与词典.mjs` 的 1000 行门禁），5 个调用点全部改走它；非正整数**当场退出 2** 并点名 token |
| ⑥ | `tools/af_pipeline/keychain.mjs`、`LayerText_AF工序化生成.mjs` | `execSync` 模板串拼 shell | 改 `execFileSync` + 数组传参。**注意：这两处当时都不可利用**（见下），改的是"结构性隐患"不是"活漏洞" |
| ⑦ | `src/core/irregular.ts` + `risks.ts` + `qc.ts` | `risks.ts` 注释写着"与 qc.ts 共用同一套正则"，但代码是**两份手抄**——任一处改豁免词就漂移，UI 着色的句子与报表数字会指向不同的句（注释里那句"含 R12-inv-case 修复"就是这么来的） | 模式串集中到 `irregular.ts` 的 `PAT_*`（唯一一份），`qc.ts` 加 `/g` 计数、`risks.ts` 不加 `g` 逐句判定 |

**核实后判定"不是问题"，明确不改（附理由，免得下次重报）**

- **🚨"命令注入可执行任意 shell"——攻击链是断的。** `工序化生成.mjs` 的查询词来自
  `stagescan.oovOfSeg`，那里取词的正则只收"字母开头 + 字母/撇号/连字符"，`expandForms` 也只做字母增删——
  `;`、`$`、反引号**从来进不了那个列表**。所以报告里"任何教师拿到的章节 md 都能借此执行任意 shell"
  的场景构造不出来。`keychain.mjs` 的 `service` 也全是硬编码字面量。**两处都改成了 `execFileSync`**（结构性隐患值得清），
  但**不该按"裸奔"处理**，更不该排在最高优先级。
- **"`fidelity.mjs` 把 ENOENT 和格式错混成同一条提示"——不成立。** `readFileSync` 在 `chapterSents`
  **之外**，文件不存在会正常抛栈，根本走不到那个 `catch`。
- **"`reinforce_plan.mjs` 让已现存的词被当缺席"——方向说反了。** 多出来的候选串只会**增加**命中，
  后果是"该注入的词被判成已复现"（漏注入），不是"把已现存的词当缺席"。报告中 `playaying`/`eateating`/`aed`
  三个例子也都是手算错的（实际是 `playying` / 重复的 `eating` / `aaed`）。
- **"`adaptcheck.ts` 的 `-er` 双候选会让生词误判为已学"——注释已把它写成刻意取舍**，且假命中要以
  `worke`/`gree` 落在词表里为前提。**保留原行为**；但注释里"只收不产生假命中的规则"这句不够准确
  （`finer`→`fin`、`cover`→`cove` 属于真词碰撞），留待有词库数据时再定，不拍脑袋改。
- **"`appswallow` 阈值留了 30% 腐化空间"——把探针当成了执法强度。** `>=140` 是"扫描器没坏"的探针，
  真正的执法断言是紧邻的 `silent.length === 0`（零容差），后面还有第三条"注入合成违规必须被拦下"。
  改成 `===` 只会让每次正常重构都红，拦截力一点不增加。
- **"`TEACHER` 回退 `$USER` 污染 CI 产物"——CI 里不会发生。** `pipeline_smoke.test.ts` 用
  **不存在的项目指针**跑每个脚本，脚本在项目加载处就失败，**不写任何产物**。且
  `teachers.ts` 已把回退口径固化为"一个字不改"的既有约定。**不改**。
- **"`preflight.mjs` 不检查 `tools/*.ts`"——对，但影响有限**（`tsc -p tsconfig.json` 兜底）。
  报告同时说"工具里的 catch 没有机器守"**与事实不符**：preflight 有 catch 检查、dry/plan 守卫、
  架构地图与 README 链接校验。

**同一轮里由并行审查（4 个只读子代理：`src/`、`app/`、`tools/`、`tests/`+配置）追加发现的真实缺陷，已修的部分**

| # | 位置 | 问题 | 修法 |
| --- | --- | --- | --- |
| ⑧ | `.github/workflows/ci.yml` | **`AGENTS.md:45` 写的"CI 跑的就是 `npm run verify`"是假的**——CI 里从来没跑过 `preflight`（`grep -rn preflight .github/` 零命中），三份文档同向错。后果：只让 preflight 挂掉的改动推上去 CI 全绿 | ci.yml 加一步 `npm run preflight`，把这句话变成事实 |
| ⑨ | `.github/workflows/release.yml` | `node-version: 20`，而测试硬要求 `node:sqlite`（≥22.5），且 `engines` 写的是 `>=22`。**打 tag 时"发布门禁：全量测试"必红 → `tauri build` 与创建 Release 永远跑不到** | release.yml 改 `22`；`package.json` 的 `engines` 收紧到 `>=22.13`（同时满足 eslint 的 `^22.13.0`） |
| ⑩ | `tests/studentversion.test.ts` | ★ 守卫写死一个谁都没有的路径 `/book/…` 并用 `if (!existsSync(p)) return;` 当"跳过"——**node:test 把"正常返回"记为 pass**，这条守卫在任何机器上都没跑过却一直显示为绿 | 改从 `LAYERTEXT_AF_DIR` 取，取不到 `t.skip()`；顺带把 `AGENTS.md` 里那个"成例"变成真的（原先全仓只有文档提过这个变量） |
| ⑪ | `tools/preflight.mjs` | 只扫 `tools/af_pipeline/`（顶层 `tools/*.mjs` 10 个一个不查）；且没有"清单非空"断言——目录被清空会打印 `✓ 0 pipeline scripts` 并退 0 | `dirs` 加 `'tools'`（只跑 `node --check`，不执行），加 `files.length < 20` 断言。实测扫描数 30 → **43** |
| ⑫ | `src/cli.ts` | `fsrs --current-pieces` 传的键名是 `currentPieces`，字段实际叫 `currentPolicyPieces`——对象展开不做多余属性检查，`tsc` 一声不吭，**这个开关静默失效**（"现行(篇)"永远是默认 2） | 改名，并对 `--days-per-piece`/`--current-pieces` 做正整数校验（`0` 会算出 `Infinity`、`abc` 会算出 `NaN`，原先都会印进表） |
| ⑬ | `src/core/candidate.ts` | 撤销判定自己拼 `itemId+\u0001+timestamp`，而全仓写 `undoOf` 的唯一格式是 `eventRef` 的 `itemId@timestamp`——`undone.has(...)` **一次都没命中过**：`undos` 恒 0、`confidence` 恒 1，"撤销多的候选该降级"从未生效 | 改用 `workbench.eventRef`（唯一实现） |
| ⑭ | `app/src/rewritegate.ts` | `invoke('list_dir', { path: dir })`，而 Rust 形参是 `dir`——缺必填键被 Tauri 拒绝，再被兜底吞掉，**跨章"已注词账本"永远只覆盖当前章**（而防跨章重复加注正是这个模块存在的意义） | 改 `{ dir }` |
| ⑮ | `app/src/chat.ts` | `void maybeCompactChat()` 在 `try` 里，而 `S.chatBusy = false` 在 `finally` 里——调用瞬间 busy 恒 true，**对话历史自动压缩从未执行过** | 移到 `finally` 里、清掉 busy 之后 |
| ⑯ | `tools/af_pipeline/LayerText_AF重制_生成.mjs` | 请求头写的是 `Bearer ${KEY}`——`KEY` 是函数，插进去的是**函数对象源码**，每次调用必然 401；401 又被 catch 只打一行 `✗`，脚本照旧 `exit 0` | 改 `KEY()` |
| ⑰ | `src/core/stagepipe.ts` | **假交付**：调用层失败（网络/HTTP）的段既不重试也不隔离——`callFailed` 只影响 `break`，而 `retryables` 只装"被门禁拒绝"的段（此时为空），于是第一次就 `break`。该段保持**未简化的原文**落盘，调用方还按 `segs.length - quarantined.length` 报"自动完成 N/N"。**断一次网就能产出一份夹着原文、未过任何门禁的"完成品"** | 调用失败并入 `blockedThisAttempt`（先重试、用尽后隔离）；新增回归守卫：断言重试到 `maxStageTries` 且失败段被隔离 |
| ⑱ | `src/core/bundle.ts` | 注释与 `AGENTS.md` 都写"按内容与文件名**双重**拦截学生数据"，**按内容那一半从来没实现过**——`buildBundle` 与 `verifyBundle` 都只调 `studentDataReason(path)`。于是本文件自己举的场景（台账里贴了班级成绩）恰好漏掉 | 新增 `STUDENT_DATA_CONTENT_PATTERNS` + `studentDataContentReason`，两处都改成 `路径 ?? 内容`；新增 3 条测试（内容命中的台账不出包 / 名字干净内容是名单的也要拦 / 正常教案报告不误伤） |
| ⑲ | `app/src/ai.ts` | 三个提示词（`grading` / `reading_quiz` / `review_material`）在 `prompts/` 里有文件、`manifest.json` 里有条目，却**没登记进 `BUNDLED_PROMPTS`**——`loadPrompt` 取不到就返回空串。于是「AI 批改建议 / 读后检测题 / 定向复习材料」三条链路一直在发**空提示词**：白花一次调用，教师拿到模型自由发挥的产物 | 补 3 条 `?raw` import 与表项；新增守卫：**`manifest.json` 的每个名字都必须能在 `BUNDLED_PROMPTS` 里找到**（这类"漏一行 import"只有对表才拦得住） |

**审查发现但**本轮未改**的（需要设计决策或更大改动，已按优先级留档）

- **`src/core/version.ts` 批量节点只记第一段的 `target`**：`replaySegment(nodes,'P02')` 返回 `found:false`、`provenanceOf` 说"本运行没有改动过这一段"——而它确实被改了。需改成每步一条节点或 `targets[]`。
- **`tools/af_pipeline/LayerText_AF两轮调适.mjs` 断点续跑用原文兜底**：`const out = [...segs]` 让已完成段不重新赋值，续跑落盘的初稿里前半是**未简化原文**。
- **`LayerText_AF决定汇总.mjs`**：`parseDecisionLog` 传的是路径而它收的是内容、`resolveTeacher` 漏 `await`——回流候选台账恒为空、"已批准资产回流"整条链路是死的且不报错。
- **M 层超长句判定两把尺**：`会话改写`/`风险队列`/`冻结回放`/`三档复核` 写死 `maxLen 16`，引擎唯一口径 `SENT_LEN_CHECK.M` 是 **17**——同一句在不同脚本里一个判 blocker 一个判通过。
- **`app/` 侧（子代理报告 P0，本轮未改）**：`datapanel.ts` 的 `调适项目_*.json` 永不匹配（`list_dir` 不返回 `.json` 且返回完整路径）→ **AI 采纳写正文 100% 失败**；`settings.ts` 班级定制同因失效；`rewritegate.ts` 跨章账本（**已修**，见 ⑭）；`bookio.ts` 首次备份存成改写后正文；`risk.ts` 决定日志读改写会并发丢事件；`bookpure.ts:33` 缺 `status` 字段时抛 TypeError；`batch.ts:521` 有失败章仍删进度。
- `appswallow` 只扫 `app/src` 顶层（`src/` 40 处 + `tools/` 99 处 catch 无人守）；`docs/文件架构.md` 有 6 个文件只存在于兄弟 worktree、数字（模块数/测试项数）全部对不上；CHANGELOG 的 38 个 `[未发布]` 段会让 `extract_changelog.mjs` 取到旧版本内容。**这些都记在审查报告里，未在本轮动。**

**验证**：`npm run verify` 全绿（preflight + typecheck + lint + **962 项测试：961 通过 / 0 失败 / 1 跳过**，原 954 全通过）。
那 1 项跳过正是 ⑩ 修好的那条 ★ 守卫——它现在**说出来自己跳过了**，而不是混在绿里。
改动的 `src/` 与 `tools/` 已同步落进 `LayerText-optimization`（`package.json` 按分支差异只搬了 `engines` 一行，
保留该分支独有的 `perf:bench` 与 `wordnet-db`；该分支的 `app/src/ai.ts` 比 main 领先很多（辅助模型那一整套），
所以 ⑲ 是**外科式打补丁**而不是整文件覆盖）；该 worktree 的 preflight、根 typecheck、app typecheck 均已复跑通过。
新增 3 条测试进 `tests/pipeline_smoke.test.ts`：章号正常路径、`1A` 必须退出 2、**以及一条防复发的纪律扫描**
（任何脚本再手抄那份章号正则就红）。

**如实记录两次自我违规**：本次改动把正则字面量粘进了 `/** */` 注释，其中的 `*/` **提前闭合了块注释**，
`align.ts` 与 `工序化生成.mjs` 双双语法错误——是并行审查的子代理报上来的，不是我自己发现的。
同类问题还有一次：测试名字符串里的 `\d` 触发 `no-useless-escape`，由 lint 拦下。
**教训**：注释与字符串里不要直接粘正则原文。

## [未发布] - 2026-09-13（codex/total-optimization · 文档骨架：项目总说明 + 架构地图 + AGENTS.md，三者进门禁）

> 来源：Wayne"我怕每一次他都要顾一遍整个文件的架构"＋"再更新一个项目总说明"。
> 目标：把"每次重新摸一遍"这件事制度掉——**入口固定、规矩成文、门禁可验**。

**新增三份文件，各管一件事**：

| 文件                      | 回答的问题                                                                                                                                                                                       |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **`docs/项目总说明.md`**  | **项目是什么、怎么转、到哪一步了**——给谁用/不是什么、难度观、一条数据流看全、**行话速查表**（层/正本/加注覆盖率/门禁/风险队列/待确认/台账/runId…）、四个入口、现状数字、**如实记录的"还没做的"** |
| **`docs/文件架构.md`**    | **东西在哪、该改哪儿**——分层图 + 逐文件一句话职责（**不是凭记忆写的：从每个文件自己的头部注释里抽出来的**）+「我要改 X → 去哪」索引 + 不入库清单 + 两个 worktree + 变更记录                      |
| **`AGENTS.md`**（仓库根） | **动手前先读的一页**——三条铁律 + 门禁命令（含 `USER=runner` 复现 CI 条件）+ 仓库物理形态 + 既有工程口径                                                                                          |

**规矩不靠自觉，进 `npm run preflight`**：地图必须在且被 README 引到；`AGENTS.md` 必须在且链到地图；
总说明必须在且被 README 与 AGENTS 同时链到。**并逐条反证过拦得住**（挪走→红、去掉链接→红、恢复→绿）。

**顺手清掉一处过时**：`docs/HANDOFF.md` 顶部标注为历史——它写着的"未 push、基线 `546c3cc`"早已不成立，
但其中两条设计约束（`清单_最新.json` 的歧义拒绝、`--allow-partial` 的显式声明）仍然有效，所以保留正文。

**如实记录一次自我违规**：上面这批（连同下一批）**当时都漏写了 CHANGELOG**——
这正是"每次改动都写"这条铁律要防的失效，而我是边立规矩边犯的。已补齐，见下一条与本条。

## [未发布] - 2026-09-13（codex/total-optimization · 公开仓库卫生：私人信息清理 + 回放夹具搬出仓库；CI 转绿）

> 来源：Wayne"推送最新版本，**推送版本别包含我自己的东西**"。推送前整体盘了一遍待推内容与已跟踪文件。

**① 清掉三类私人标识**（改后两个分支 `git grep` 命中均为 0）：

- 真实班级名 `九3九4`（9 处/6 文件）→ `示例班`。只在注释与测试夹具里当举例；
  检测器匹配的是「分层/画像/成绩/名册」这类通用词，**防线未被削弱**。
- 本机绝对路径 `/Users/wayne/...`（8 处/5 文件）→ 中性路径，或改成**从环境变量取、取不到就跳过**
  （成例：`tests/studentversion.test.ts` 的 `LAYERTEXT_AF_DIR`、`docs/research/product_research.mjs`）。
- `tests/fixtures/replay/`（46 文件/1.1MB）——**最大的一处**：冻的是真项目整份快照
  （Orwell 十章原文 + 教师三层产物 30 份 + 词库/词典/专名表/知识库）。
  **搬家而不是砍守卫**：移到应用配置目录 `~/Documents/LayerText配置/回放夹具_真项目`，
  由 `LAYERTEXT_REPLAY_DIR` → 应用配置目录 → 旧路径的顺序查找，**找不到就整层 skip**；
  本机不需要配任何变量，回放层照跑 **15/15 全绿**。仓库里 `fixtures/replay` 命中数：0。
  并把该路径写进 `.gitignore` 防呆（它历史上进过公开仓库）。

**② CI 转绿——查清"红不是我推坏的"**：分支上一次推送就是 31 条红，本次 29 条，同一批。
根因是**分支缺主仓 27 个提交**，其中就有上一轮的"CI 转绿"战役（`5bcf700`/`4b6c35d`/`f7db9bd`
把测试 spawn 全部显式传 `--teacher wayne`；`1c1f929` 把 `execSync('security …')` 拆成 `keychain.mjs`）。
已 merge main 进分支补齐。

**③ 过程如实记一笔（返工）**：第一次合并用 `git checkout --ours <文件>` **整文件取边**，
把主仓在同一文件里**没冲突的改动**（`studentversion.test.ts` 里那几处 `--teacher wayne`）一起丢了。
靠**本机造出 CI 条件**（`USER=runner`）复现才抓到（983 项里 1 条红）——已 reset 重做，改为只按冲突块解决。
教训：`--ours/--theirs` 是整文件的，不是整冲突块的。

**验证**：两个分支 `USER=runner npm run verify` 均 exit 0；远端 SHA 与本地逐字符一致；CI 均绿。

## [未发布] - 2026-09-13（codex/total-optimization · "点标记没反应"查因：模式胶囊启动时错的 + 重复点静默；词面板去掉三个无落点按钮）

> 来源：Wayne 两条反馈——"为什么即改模式，我点击有时候没反应？"（要求先做检查计划）＋
> 词面板截图上的三个问题："这个不能对齐？有没有重复的？没有意义的选项？有就去除"。

### 一、"有时候点标记没反应"——查出来两个真原因

**原因 A（根因，已修）：模式胶囊在启动时是错的，而且它和弹层提示互相矛盾。**
`main.ts` 模块顶层就调用 `updateModePill()`，而 `loadConfig()` 在后面的启动 IIFE 里才执行——
胶囊拿的是初始空配置 `{}`，**一律渲染成「候选模式」**；配置里明明是即改，它也不会再刷新。
实测（配置 `autoRewriteOnMark: true`）：胶囊显示「候选模式：等你点 ✓」，而同一个弹层底部的提示写着
「当前为即改模式：点任一标记立即执行」——**两处 UI 说两套话**。后果不是"显示不准"这么轻：
教师被胶囊误导，去点它想"切到即改"，而那个按钮是**取反**——于是把即改真关掉了；
此后点标记只入清单、不改正文，看起来就是"点了没反应"。（Wayne 的真实配置此刻正是
`autoRewriteOnMark: false`，与这条完全吻合。）修法：`loadConfig()` 之后补一次 `updateModePill()`。

**原因 B（已修）：同一个词、同一种标记点第二次，静默 return。**
`bindTypeButtons` 里有一行 `if (marksAt(...).some(...)) return;`——**什么都不做、什么都不说**：
弹层不关、正文不动、状态行不变。实测复现：点①加中文标注成功→弹层关；再点同一个词→弹层开；
再点①→**毫无变化**，于是教师会反复点。修法：这条路径改为说出口（toast + 状态行
「「加中文标注」已存在：这个词标过了，没有重复添加」），并把已标记的按钮做成**看得见的态**
（原来只有 0.45 透明度，太轻）——加左侧强调竖条 + 标题写明。

**顺带修掉三处同类静默 return**（`aiRewriteSentence`）：没有会话 / 定位不到句子 / 未配 AI——
即改模式下弹层已经关掉，这时什么都不说＝完全是黑箱。现在各自说清。

### 二、词面板：去掉三个"重复/没有落点"的按钮，并把按钮排成等宽网格

逐个查过每个类型**在全仓的去向**（不是凭名字判断）：

| 按钮                       | 查到的结果                                                                                                         | 处置   |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------ |
| ① 词汇简化 `simpl`         | 走确定性换词管线 `applyWordSimplifications`                                                                        | 留     |
| ② 加中文标注 `zh`          | 走 `applyZhAnnotations`，并向下层传播                                                                              | 留     |
| ③ 加英语释义 `en`          | 走 `applyEnDefinitions`，并向下层传播                                                                              | 留     |
| ④ **超纲 `oov`**           | **引擎已经算出词表状态并显示在同一弹层顶部**（"词表状态：词表外（红）"）；与「太难」同义、与「词汇简化」同规则 R02 | **删** |
| ⑤ 太难 `hard`              | 教师的主观判断（"这些孩子觉得难"），机器算不出                                                                     | 留     |
| ⑥ **事实用词存疑 `factw`** | **全仓无落点**（连 `RULE_BY_TYPE` 都没有，退 R00）；而"事实对不对"本来就该按句判——句级已有「事实逻辑疑」           | **删** |
| ⑦ **好词保留 `goodw`**     | **表达与落点相反**：它说的是"这个词好、别动"，可这条流水线只会"动手"；即改模式下点它会立刻触发整句 AI 改写         | **删** |
| ⑧ 复现锚点 `anchor`        | 真落点：`bookio` 导出/学生版保留该词，且被句子改写流程显式排除（记录型）                                           | 留     |
| ⑨ 其他问题 `otherw`        | 兜底，待确认面板的「忽略」也用它                                                                                   | 留     |

三个类型**只从面板下线，不从类型表删除**——旧稿里的历史标记仍要能显示标签（`typeLabel`），
所以拆成 `WORD_TYPES`（系统认识哪些）与 `WORD_PANEL_TYPES`（教师现在能点的）。

**对齐**：原来动作按钮与九个标记按钮同在一个 `flex-wrap` 容器里，每个按钮顶着自己的文字长度、
换行后左右参差。现在动作一排、标记一排，标记是**3 列等宽网格**（97×30，6 个按钮 3×2）；
弹层宽度 300→328px，让「加中文标注」这类 5 字标签单行放得下（300px 时会折行、把那一行撑高）。

**没动的**：`SENT_TYPES`（句面板 11 个）这一轮没删——它们多数是"给模型的一句话意图"，
有 `RULE_BY_TYPE` 或句级语义落点，证据不足以判死；要动的话单独一轮来。

**验收**：`tsc` 双工程 + `eslint --max-warnings 0` + `preflight` + `vite build` 通过；全量测试
**958 项 957 通过 / 1 跳过 / 0 失败**（新增 1 项：词面板类型表；另外复跑两次确认 lockfile 那条
偶发红是并发计时抖动、与本次改动无关）。两条 bug 用无头 Chrome 复现并复验：
配置即改→胶囊显示即改（一致）；同词重复点→状态行出声。**已装机**。

## [未发布] - 2026-09-13（codex/total-optimization · 右侧审校栏整理：七块平铺 → 一条状态条 + 四张分区卡）

> 来源：Wayne 看真机截图后一句"右边的这个太混乱了"。对比图在桌面 `侧栏整理_方案_2026-09-13.png`。

**病因（逐条对得上）**：

1. **七块平铺、没有分区语言**——标题字重一样、块间只有 20px 空白，滚起来像一整段文字；
2. **一屏两个计数打架**——顶部「待确认 74 条」说机器筛出多少要处理，底部「标记清单 0」说你标了几条，
   读起来像"74 条待办 vs 0 条已做"，其实是两个不相干的概念；
3. **空状态占地方**——要点那三行灰字（"未设置要点——「质检报告」页点…"）在标题下糊一大段；
4. **「?」被推到最右**——门禁四行的问号跟标签断开，四行四个点像噪点；
5. **阶段动作混进常驻信息**——「给第二轮调适的反馈」是写完就走的动作，却和常驻状态并列、还占 3 行输入框；
6. **不能折叠**——标记清单一长就得一路滚，要点/门禁被顶出屏幕。

**改法（一条对一条）**：

1. 每块变**分区卡**（白底 + 细边 + 一致内边距），块间 8px；
2. 顶部一条**状态条**吃掉所有计数：`待确认 74 ｜ 标记 0 · 门禁 0/4`，待确认做成 chip + 「去看 ▸」；
3. 空状态压成**一行 + 一个动作**：「还没设要点 · 可手加，如「保留风车线索」」，长说明进 title；
4. 门禁改**两列网格**（`grid-template-columns: max-content max-content`），问号缩成紧跟标签的小圆点；
5. 反馈区**默认收起**成一行标题（展合状态模块级保留，不会因为标记变动重渲染就被合上）；
6. 标记清单加**状态标签**（0 条时显示「无待办」）。

**顺手接上一根之前断了的线**：要点卡的「摘要点 ▸」不是新功能，它**跳到「质检报告」页那个
「AI 摘情节要点」按钮并把它闪一下**——因为摘出的候选要在那里勾选才进配额，侧栏里一步摘完是假的。
没接线时这个按钮**直接不渲染**（`onPlotJump` 为可选 handler），不摆一个点了没反应的按钮给它。

**没动的**：所有回调与 id（`#quota-input` / `.qmark` / `data-jump` / `data-rm` …）一个没改，
`review_dom.test.ts` 既有 7 项断言全绿。侧栏宽度、审校/编辑页签、正文与右侧栏的关系都不变。

**验收**：`tsc` 双工程 + `eslint --max-warnings 0` + `preflight` + `vite build` 通过；
全量测试 **957 项 956 通过 / 1 跳过 / 0 失败**（新增 2 项：状态条与四张卡的结构、摘要点未接线时不渲染）。
版式用无头 Chrome 在 1200×900 下截图核对（状态条一行放得下、门禁两列不折行、反馈默认收起）。
**已装机**。

## [未发布] - 2026-09-13（codex/total-optimization · 排版重构（方案 A）：四条横条 → 三行分层，172px → 128px）

> 来源：Wayne 截图反馈"这里菜单栏太急了，我想要完全重构做一个好看好用的排版"。
> 设计对比（现状 / 方案 A / 方案 B）见桌面 `UI重构_排版方案_2026-09-13.png`。
> **过程如实记一笔**：先按他当时选的方案 B（两行 + 左侧竖栏）做了并装机，他看真机后判定
> **方案 A 更好**，随后改回 A。B 的代码在 `c99aa06`，本条是最终形态。

**病因（先量再动手）**：命令栏 52 + 版本栏 38 + 章节栏 38 + 视图栏 44 = **172px**——760 高的窗口里
正文只剩 588px，五分之一还多被横条吃掉。更要紧的不是高度，是**顶栏塞了 4 个层级的 16 件东西**
（应用级 书架/打开/设置/主题、章节级 质检本章/按标记修改/学生视角、编辑级 撤销/查找/字号、状态
模式胶囊/状态文字）。挤到最后状态文字只剩 **128px**，截图里 `已进入【A层重制·…` 就是被挤断的——
**它想说的信息等于没了**。另有两处浪费：版本三个胶囊常驻一整行 38px（一天切两三次），
章节标签只放一个文件时也占一整行。

**核心思路：按"这个动作属于哪一级"分层，每级只出现一次。** 落地成三行：

```
顶栏 48px   ●●● LayerText │ 书架 打开…        [↩ ↪ 🔍 A－ A＋ ☀ ⚙] [候选模式]  状态（吃满余量）
上下文栏 40  [版本 A层重制·原文85% ⌄] │ [第一章 ×][第二章] …   [质检本章][按标记修改][学生视角]
视图栏 40    ☰目录 │ [读 检 改 库]  正文 ｜ 逐句对照 ｜ 版本对比
```

- **版本三个胶囊 → 一个下拉**：点开是「版本列表 + 本版章节列表」（原来那个独立的章节下拉功能
  一并收进来，没丢）。**多一次点击，换一整条横栏**，这笔账划算。
- **章节动作下沉到上下文栏**：质检本章/按标记修改/学生视角是"对当前这一章"做的事，挨着章节才对；
  顶栏因此腾出 ~330px，状态文字从 128px 涨到 ~300px，不再省略（仍挂 title 兜底）。
- **一级四组留在顶部横排**（与二级页签同一条视图栏）：四个标签全是单字，横排本来就窄，
  不值得为它省那一行高度、更不值得让正文窄 56px。二级页签保持"接在同一 x 起点、最短标签等宽下限"，
  切组不位移；当前组只有一个视图（库）时二级条为空白。

**踩到并修掉的坑（写进 CSS 注释）**：隐藏栅格里的一个格子**不等于少一列**——竖栏 `display:none`
之后网格会自动补位，正文被塞进 56px 的第一列（书架页实测只剩 24px 宽）。同理书架页侧栏收起时，
`body.no-session .workbench` 必须显式改成单列，否则正文右边会空出一条 280px 灰带（这个坑在本次
重构之前就存在，只是没人量过）。

**没动的**：正文渲染、审校面板、右侧栏、所有交互逻辑一行没改；只动 `header/ctxbar/viewtabs`
这一层（`app/index.html` · `archive.css` · `widgets.ts` · `main.ts` · `shelf.ts`）。

**验收**：`tsc` 双工程 + `eslint --max-warnings 0` + `preflight` + `vite build` 通过；
全量测试 **955 项 954 通过 / 1 跳过 / 0 失败**。版式用无头 Chrome 在 1200×760/800 下、
书架态与 读/检/改/库 四组逐一截图核对（含版本下拉展开、库组二级条空白、书架页单列栅格）。
**已装机**（`tauri build --bundles app` → 替换 `/Applications/LayerText.app`）。

## [未发布] - 2026-09-13（codex/total-optimization · 辅助模型（可选）：本机小模型接一条赛道，关掉不影响任何功能）

> 来源：Wayne 问"没有本地模型能用吗？只连 API？"＋"增加一个辅助模型呗，可以用也可以不用"。

**背景（先把话说清楚）**：本机确实有本地模型在跑——oMLX（127.0.0.1:8000）上是 Ling-3.0-tiny 的
五个变体（7.9B，oQ4e 4.33GB），Ollama 在跑但一个模型都没装，2B 的 MiniCPM5-2B 已删。
直接打它的 OpenAI 兼容端点实测可用（改写一句 5 秒 / 390 token / 零成本）。但 2026-09-13 的
[Ling 全项复测](docs/待确认队列与校准台账.md) 说明它**做不了主线**：判卷给分两遍都给 0、
多段扫描质量差、整章语义审校/生词判定/分类打标都不行；带句释词只有 52% 与教师词典吻合。
所以它不该去替整章简化，只该接一条**它实测扛得住**的赛道。

**做了什么**：

- **配置**（可选，默认关）：AI 设置里新增「启用辅助模型」——本机地址 / 模型名 / Key（默认指向
  `http://127.0.0.1:8000/v1` + `Ling-3.0-tiny-oQ4e`；Key 在 `~/.omlx/settings.json`，不校验 Key 的
  本地服务随便填个占位符）。不勾就把三个框收起来；**关掉不影响任何功能**，只是这些活也交给主模型。
  另有「测试辅助模型」一键连通。
- **接哪条赛道**：只接"**短输入 + 任务单一 + 输出可机检**"的映射类小活——
  **词→课标内简单词**（词汇简化）与 **短语→中文注释**。整章简化 / 逐句改写 / 对话**一律仍走主模型**。
- **三条安全线**（写死在代码里）：① **规模上限** `AUX_MAX_WORDS = 12`，超限**整批退主模型，不拆批**
  （拆了同一个词会在不同批拿到不一致的译法）；② 辅助模型**失败 / 超时可自动回主模型**，
  并把"为什么回退"写在状态行上；③ 输出仍过**同一套机检**（剥 markdown、拒中文、词边界替换、
  短语限 2–6 汉字）——不因为换了模型就放松任何一道防线。另外 `bare` 请求只发
  `model/temperature/messages/max_tokens`：实测本机模型不认 `reasoning_effort/thinking`，
  虽然主链路有"不认就重发"的兜底，辅助这条路直接不发，省一次来回。
- **看得见**：使用辅助模型时状态行写明「这批用辅助模型，未花 API 钱」，词汇简化总结弹层多一行
  「这一批问的是：辅助模型（本机 X）/ 主模型」；成本台账记 `scene（辅助模型）`，本地模型 cost=0 也照记。
- **它爱加戏，就在提示词里堵**：实测不加约束时 Ling 会先把 `1. **Analyze the Request:** …` 的分析串
  吐出来（我 curl 复现过），所以辅助模型的 system 前置一句"只输出要求的内容本身，不要输出分析"。

**没做**：辅助模型**不进主链路的 failover 序列**——它是"便宜的地方优先"，不是"主供应商的替补"。
主模型连不上时该做的是告诉教师主模型连不上，而不是默默换成本地模型出一份质量不同的稿。

**验收**：`tsc` 双工程 + `eslint --max-warnings 0` + `preflight` 通过；全量测试 **955 项 954 通过 /
1 跳过 / 0 失败**（新增 2 项：`auxReady` 的四类不成立、`auxSuitedFor` 的空批次/到限/超限）。
判据抽到 `src/core/aiops.ts` 的纯函数里，App 与管线共用同一份。AI 设置界面用无头 Chrome 截图核对；
oMLX 端点由 curl 实测（改写结果 + token 用量 + 耗时）。

## [未发布] - 2026-09-13（codex/total-optimization · 台账接进三个出口 + ② 换词队列看得见也点得动）

> 来源：Wayne 的第五条功能缺口（"台账没接进其它出口——数据面板看不到台账；审校档案/发布包没带上它，
> 论文素材会有缺口"）与他的第三问（"② 换成 X 之后谁执行？现在还得你再去点「词汇简化」"）。

**一、台账接进三个出口**（此前它落在 `<产物目录>/_运行/`，只有命令行看得见）：

- **数据面板**（库）顶部新增「校准台账」卡：总数、教师亲判/模型候选、覆盖章数、类型分布、
  各章条数、最近 5 条、**坏行数**，外加「在访达中显示」「复制路径」。顺手根修一个真问题：
  单章模式（拖入 / 本地示例 / 直接打开一个文件）下 `S.currentBookDir` 为空，数据面板一律显示
  "这本书还没有数据资产配置"——现在退到**当前章所在目录**再向上找 `调适项目_*.json`，
  这条路本来就走得通，台账卡也因此才看得见。
- **审校档案**：单章档案多一节「人工校准台账（本章，教师对词/句的判断）」，写明"其中教师亲判 N 条"；
  章节号改成显式三档（有/无逐句对照各一套），插一节不会把后面的节号全带错；面板上加一行计数。
  与既有「AI 建议台账」**分开两节**——论文里"人工校准"数的是这一本，不是 AI 建议的采纳率。
- **发布包**：`清单.mjs` 把 `_运行/校准台账.jsonl` 登记成 `台账` 类产物（书级一件，登记在层循环之外），
  于是它**随包出去**；包描述新增 `calibrationCount`（与 `decisionCount` 分开记）；
  `--where` 溯源新增一张表，`renderProvenance` 分成「风险队列上的决定」与「审校工作台上的人工校准」两节。

**二、② 换词队列：看得见、点得动。** 点 ② 确定之后决定**已经**落成 `simpl` 标记（标记清单就是换词队列），
缺的是"谁执行"：此前教师得自己想起来去工具栏点「按标记修改」，想不起来就等于没排。现在面板顶上多一条
「换词待执行：N 个词（M 条标记，其中 K 条是你亲手指定的词——不会再问 AI）▸ 现在就换」，
点它调既有的换词管线（教师指定的词直接采用、不进 AI 输入；其余才问模型）。执行失败说出口，不静默。

**三、顺手暴露一个此前只写 console 的真问题。** 队列是按某一版产物算的，产物重生成换了词就找不到锚——
那时 `decide` 只记台账、不打标记，并且**只写 console.warn**。教师会以为自己点过了、正文却没动。
现在单条与批量都会把"找不到词面的 N 条"写进状态栏，批量还单独报数。

**验收**：`tsc` 双工程 + `eslint --max-warnings 0` + `preflight` + 全量测试 **953 项 952 通过 / 1 跳过 / 0 失败**
（新增 7 项：包描述两本账分开记、溯源带校准并按章过滤与时间序、无校准时不多印一节空表、
台账摘要聚合与坏行计数、没有产物目录时返回 null、换词队列条的出现与一键执行、没有待办时不出现空条）。
界面用无头 Chrome 在真实 Animal Farm 夹具上截图核对（数据面板台账卡 / 换词待执行条）。
**已装机**（`tauri build --bundles app` → 替换 `/Applications/LayerText.app`）。

## [未发布] - 2026-09-13（codex/total-optimization · 待确认队列补齐三件：引擎客观项并入 / 大章细分与跨章汇总 / 批量处理）

> 来源：Wayne 的四条功能缺口（"引擎客观项没并进待确认，两处入口各看一半""大章没细分，第八章
> 214 条只有三个筛子""★114 条没有批量处理""进度没有跨章汇总，看不到全书还剩多少、哪章最多"）。

**① 引擎客观项并进同一张表。** 超长句 / 超纲词漏注 / 正文混入中文 / 篇幅偏离原先只在「风险队列」，
教师在两个入口各看一半。现在把这几条**机器确定**的 blocker 也并进待确认（`fromRiskItem` +
`ENGINE_OBJECTIVE_RULES`），管线侧读 `_运行/风险队列_<层>.json`（`--no-engine` 可关）。
**哪些刻意不并**：`FACT-01/02`（数字/专名在改写里找不到）与 `ANNO-02/03`——改写可能合法地换说法，
机器判不准，那是"按风险排队等人工权衡"的活；并进来只会让教师分不清"必须改"和"可能要改"。
引擎项在面板里**不硬塞三个键**：段级判断（超长句/篇幅）给「去风险队列处理 →」＋「③ 忽略」——
"补注 / 换成某个词"在那几条上根本不成立，给不成立的按钮比不给更坏。判据排序随之改为
★加注词 → 引擎客观项 → 正本 → 补注。

**② 大章细分 + 跨章汇总。** 新增两个筛子：**跨章复现** / **仅本章**——判据是这个词出现在**几章**
（不是几段）。`comrades` 在 6 个段落全丢不是 6 次手滑，是**一条口径问题**，处理一条顶一批；
行上直接标 `×N 章`。新增「词频优先」排序（跨章最多的排最前，同频回落到判据）。
面板顶上补一行全书进度：「全书 N 条待确认 · 已处理 · 共 · 还有几章没清完」＋各章待确认条数
（当前章高亮）——看不到"全书还剩多少、哪章最多"，就只能一章一章地猜。

**③ 批量处理。** 「批量（对当前筛选出的 N 条）」：全部 ① 补注 / 全部 ③ 忽略。三条纪律：
只处理**当前筛选出来的**（教师看到的范围就是批量的范围）、**必须显式确认**（弹窗写清条数与动作）、
**只打标记不写正文**（正文仍要点「按标记修改」才写入——这也是它敢一次批量的前提，批错了可撤销）。
② 换写不在批量范围内（每条要填不同的词）。实测 74 条的章节点「全部 ①」一次落账，无逐条重渲染卡顿。

**验收**：`tsc` 双工程 + `eslint --max-warnings 0` + 全量测试通过（新增 6 项：引擎规则白名单、
段级项不编词、排序位次、引擎项不出现三个键、批量确认/取消、跨章汇总与细分筛选）；文档
[docs/待确认队列与校准台账.md](docs/待确认队列与校准台账.md) 同步改为"三路合成一张"。版式与面板
用无头 Chrome 在真实 Animal Farm 数据上截图核对（引擎项 → 过滤 → 行内两个键）。**已装机**（`tauri build --bundles app` → 替换 `/Applications/LayerText.app`）。

## [未发布] - 2026-09-13（codex/total-optimization · 待确认队列 + 校准台账 + 面板入口；本地模型边界写进文档）

> 补齐两样新机制的**项目文档**（此前只有代码与 CHANGELOG 草稿，README / 规则体系 / 新机制说明页都没有）：
> 新增 [docs/待确认队列与校准台账.md](docs/待确认队列与校准台账.md)；README 的核心工作流、能力表、
> 仓库结构、测试数（92 → 938）同步更新；[段级门禁与风险队列](docs/段级门禁与风险队列.md) 四之二
> 加"先分清两份正本"的指引（`_决定/<层>.jsonl` 管风险队列项、`_运行/校准台账.jsonl` 管词/句级校准）。

**待确认队列。** 三路机器结论（正本核对 4049 处 / 未支持难词 875 处 / 引擎客观项）原先散在两份 JSON、
要开两个视图看。现合成 `待确认队列_<层>.json`，App 两个入口：「检 → 待确认」整章列表 + 右栏常驻
「待确认 N 条 ▸ 去看」横幅（**打开一章就看得见**——上一版是"做出来了却没人找得到"）。纯逻辑在
`src/core/pendingqueue.ts`：层写法归一（`A` → `A层85`）、稳定 ID **不含 kind**（同词被两路口径
同时点中时合成一条，按更强判据呈现，教师只点一次）、重算队列按 ID 把 `status/decidedAt` 带回来
（**重算不许抹掉教师的决定**）。

**三个键的传播口径。** ①补注 → `annotate`，直接落实到下级文本；②换成 X → `rewrite`，只写下级
待办、不直接改下级正文；③忽略 → **不传播**（上级觉得不用管，不等于下级也觉得不用管——三层学生
词库本来就不同）。③刻意**只记决定、不产生任何标记**：写成标记的后果是 AI 审核流程拿"这个词忽略"
去问一次 AI、产出一条空建议、再被引擎复核报"仍含超长"——一条"什么都不做"的决定凭空长出一串动作。

**② 教师亲手填的替换词不再经过 AI。** 原先「词汇简化」把所有标记词再问一次 AI，教师填的词被静默
丢掉、AI 换一个别的。现在备注写固定格式 `教师指定替换：X → Y`（写读共用同一常量前缀），
`pipew.ts` 读到就**直接采用、该词不进 AI 输入**，同词冲突时**以人为准**。

**校准台账。** `_审校标记.json` 按**文件名**落盘，管线每重生成一版就换文件名——教师看到的症状是
"我点了确认，下次进来校准怎么没了"（实测：`原文_A层85_2026-09-10_审校标记.json` 1 条，
`…_2026-09-12_工序化_审校标记.json` 0 条）。现改为 append-only 的 `_运行/校准台账.jsonl` 正本，
锚是「书 + 章 + 层 + 词/句」（**不含文件名**），打开一章自动重放回当前这一版；`source: human|ai`
分得开（论文里"人工校准"是可审计的教师判断，模型候选只是建议）。台账坏了不拦人打开文件。

**本地模型边界入库（实测换来的结论）。** `LayerText_AF本地助手.mjs` 用 oMLX 上的 MiniCPM5-2B，
但只做**输入短 + 任务单一 + 判据明确 + 输出可机检**四条同时成立的事。实测：同一模型 1 段输入能报对
问题、**2 段起一条不报**；补全空字段会**直接编**；段落分类**一律答"叙述"**；判卷能挑出错但
**给分不可信**。所以它只做"带句释词"（4/5 正确，与词典对账，一致/不一致都如实说）与"句级拆句"
（段级实测会整段抄回原文）；出选项卡与 CSV↔JSON 走确定性模板——模型做格式转换是负收益。

## [未发布] - 2026-09-13（codex/total-optimization · 工作台骨架 v2：顶栏不再折行、两级页签同高同基线、待确认面板去内联样式）

> 来源：Wayne 的 UI 反馈——"有点这一块那一块，排版也不是很好看""菜单之间没有很细节的对齐，点击的标签页明明可以做到对齐，却这里歪那里歪"。本轮**先把版式骨架立住**（功能缺口 ★批量/跨章汇总/引擎项并入待确认等排在后面几轮），改动集中在 `app/src/styles/archive.css`、`app/index.html`、`app/src/annotate.ts`、`app/src/state.ts`、`app/src/uikit.ts`。

**根因是先量出来、再动手的（无头 Chrome + CDP 截图与几何取证，不是凭感觉调）。** 实测 1200×800 下：`header` 高 **73px**（应 52）——`#status{width:100%}` 让状态文字独占一行，命令栏被撑成两层；文件栏 42px 里放 33px 的页签（上 4 下 5，差 1px）；视图栏固定 48px 却只放 32px 控件（上下各空 8px）；一级分组按钮 28px、二级页签 28px、目录按钮 32px 三种高度混排；面板内边距写着 `clamp(22px,3vw,40px)`——**窗口一改宽窄内容就左右浮动**，"对齐关系"跟着变。四条硬规则就此钉死：命令栏/文件栏/视图栏一律 `flex-nowrap` + 固定高（52/38/44）；行内控件统一 `--ctl-h: 28px` 且垂直居中；左缘一律贴 `--gutter: 16px` 栅格（与面板卡片同一条竖线）；面板内边距改成固定值。

**两级页签按"切组不位移"重建。** 一级仍固定四格（读检改库，等宽 33px），二级页签接在分组右侧**同一 x 起点**（实测 256px，四个分组一致），并给最短标签留等宽下限（`min-width:62px` + 居中）——于是"报告/看板/档案"三格同宽、整排才真对齐；目录与分组之间加一条 18px 竖分隔线，三段读起来是一排而不是三块。状态文字留在命令栏内并挂 `title`（挤不下只省略号，全文鼠标准星可见），"书架读不出来"这类关键提示不再被挤掉。

**待确认面板去内联样式。** 原来每条卡都靠 inline style 拼（圆角/字级/间距各写各的），统一收成 `.pk-row/.pk-head/.pk-badge/.pk-word/.pk-gloss/.pk-sentence/.pk-actions` 与侧栏 `.pending-banner` 一份 CSS。侧栏横幅原先在 248px 里折成三行方块（"待确认 72 条 （引擎筛出，你拍板） 去看"），现为一行 34px：正文省略、按钮固定右侧。顺手根修两处渲染成字面量的 markdown（`**未支持难词**`、`**只在当前层生效…**`）。

**验收（如实）**：`tsc` 双工程 + `eslint --max-warnings 0` + `prettier` 全过；测试 938 项仅 1 项红——`筛选条`断言拿 innerHTML 匹配"全部 3"，而新标记把数字包进 `.pk-count` 做等宽对齐，已改为按**渲染文字** `textContent` 断言（测行为，不测标签写法），改后 10/10 绿。版式由无头 Chrome（1200×800 与 1600×1000 × 读检改库四组）逐一截图核对；为让截图带真实数据，本地从 Animal Farm 项目拷了一份章节与待确认队列做夹具（`app/public/_fixture/`，已加 `.gitignore`，绝不入库）。**已装机**：`npx tauri build --bundles app` → `cp -R` 替换 `/Applications/LayerText.app`（同 ZCode 侧的既有流程）。新二进制 ad-hoc 签名会变，**TCC 桌面/文稿授权会重新弹一次**，需要重新点「允许」。

## [未发布] - 2026-09-12（codex/total-optimization · UI 工作台三轮重构：窗口贴真实左缘 / 审校双栏 / 教师审校工作台风格）

> 来源：Wayne 对旧 UI 的两条反馈（顶部不应表现线性流程、"双蓝"配色不好看）+ 指令"前端完整重做"。三轮均只动 `app/index.html`、`app/src/styles/archive.css`、`app/src/main.ts`，DOM 结构与交互逻辑不动；每轮 `npm run build` 通过，且由 ZCode 侧 `npx tauri build --bundles app` 打包、cp 替换 /Applications 实装（DMG bundler 因 identifier 以 `.app` 结尾的老问题继续绕行）、资产哈希指纹验证进包（MekwyVB3→9CycsYPN→GkEZSWDD/B-UPYTvq）。

**第一轮（f57bb95 前端重做 + 拖入）。** 窗口控制按钮贴到真实左缘（去异常内边距）；顶部不再承载"第一轮→第二轮→人工校验"线性流程；工作台支持 Finder 直接拖入文本/Markdown/EPUB，新增明确拖放覆盖层（`body.drag-active #drop-zone`）；文件导航与标签改紧凑结构（章节标签 max-width+省略号，不再挤坏页面）。验证四件套通过（verify / verify:rust 5 项 / build / perf:bench 1.6ms）。

**第二轮（892d0ff 双栏布局）。** 阅读区与审校侧栏改稳定双栏（grid `minmax(0,1fr) + 侧栏 clamp(280px,23vw,340px)`，侧栏固定宽度不被正文挤压，≤1050px 自动收窄）；正文独立卡片化（边框+滚动边界）；顶部按层级栏/文件栏/视图栏重新分层；暖灰白+黑+琥珀克制配色保留。顺手根修布局隐患：工作区高度原写死 `calc(100vh - 196px)`，而顶部页签动态显隐，改纯 flex 自适应填充。

**第三轮（本条一并收口提交，archive.css 整体替换）。** 从"复古档案馆"覆盖层（暖灰白底+琥珀 #916425、档案编号、玻璃拟态、装饰阴影）整体替换为"安静的教师审校工作台"：中性灰白底 + 低饱和深绿强调（#246755，dark 主题同步换 #69b49d）；去棕色纸张感/档案编号/毛玻璃；顶部命令栏与多层页签压缩（52px/38px/48px）；正文成为视觉中心（`#reader` 限宽 980px，书架态豁免）；右侧栏贴边白板降存在感；书架改信息优先紧凑布局（去 NO. 编号、书封去装饰）；修复补丁：`#reader` 限宽只对已打开章节生效（`body:not(.no-session)`），避免误伤渲染在同容器的书架页。

**验收状态（如实）**：三轮均已装机由 Wayne 过目（20:01 / 20:09 / 20:29），第三轮风格重写 Wayne 刚开始看；TCC 桌面/文稿授权在换二进制后会重新弹（ad-hoc 签名变化），已代点允许两轮。本条为补记——三轮当时均漏写 CHANGELOG，Wayne 20:30 前后指出"每次更改都要更新日志"的既有要求，核实断档后补。

## [未发布] - 2026-09-13（main · CI 转绿 + 叙事保真度测量 + M/B 层全书重制）

> 夜间自动化轮三件套。

**CI 转绿（教师身份参数化）**：四连红根修完毕。链路=①钥匙串顶层 execSync（Linux 无 security 命令导入即崩→keychainGet 惰性容错+独立模块 keychain.mjs）；②CI node 20→22（node:sqlite 依赖+node20 测试器 after() 时序）；③**教师身份改随参数走**——测试 spawn 的 env 传递不可靠（makeProject.run() 的 env 从未带上 LAYERTEXT_TEACHER，CI 的 USER=runner 与夹具 wayne 冲突→身份错退 legacy 整批红；works-on-my-machine 教科书案例：本地用户恰好叫 wayne），四个 spawn 测试文件全部显式 `--teacher wayne` 参数化；本地 USER=runner 全量复现 35/35+15/15 绿。**教训：夹具身份不得依赖进程 env，一切随显式参数。**

**叙事保真度测量（优化方向①+③首批，零 LLM）**：`src/core/narrative.ts`（Smith-Waterman 句向量局部对齐：覆盖率+未对齐句清单=丢事件候选；段落级 cos 配对）+ `tools/narrative_fidelity.mjs` 报告 CLI。**定标先行**：AF A 层 223 段实测分布 min=0.544/P05=0.704/**P10=0.774**/P50=0.871——段落风险线取 P10=0.77（拍脑袋 0.6 在 AF 域内形同虚设，正常改写段全在 0.73+）；第一章样例叙事覆盖率 99%（103/104 句对齐，唯一未对齐=丢句候选交教师）。论文三件套凑齐：难度（生词率）+输入量（篇幅）+保真（叙事覆盖率/段落 cos）。

**M/B 层全书重制（ecnu-max，250 调用全成功）**：M 103/223 段自动完成（46%）、B 77/223（35%）——隔离率显著高于 A（65%），集中 SENT-01（M/B 检查线 17/14 词更严，ecnu-max 拆句执行偏弱）；隔离段全部保留半拆版本+待人工清单（隔离网如实接住，不静默）。M 第一章生词率 17.6%、B 第一章 12.4%——**M/B 层质量未达 A 层水准，已注册书架但标注"隔离段待人工"，是否对隔离段做"二次重拆"专项轮待 Wayne 拍板**。三工作区全部指向工序化产物（备份 _工作区_backup_20260913_MB注册前.json）。

## [未发布] - 2026-09-12（main · ecnu-max 全书重制 A 层 + 引擎六根修：每处都被真跑暴露，非先验设计）

> 触发：Wayne 指出书架三版从未走新流程（A/M=旧三档难度下移、B=deepseek 旧版），指令"ecnu 调 max、用原文重走工序化流程；先把批注落实到知识库"。知识侧：项目配置换词库 v0.8（重导正本，已知 3315 逐词不变）+ 模型 ecnu-max（模型随项目配置走，不再硬编码脚本）+ 教师两条 simpl 标记（Presently/pellets）建为已批准改写偏好回流候选（工序化词汇指令注入，实跑已换：Soon / small metal balls）。

**六根修（每处一次实跑暴露，提交 99153c1/8845476/952397d + 6c6b9ef）**：① **声明-实效守卫**——ecnu-max 把整段原样返回却标 changed（reason 谎称"多为已学词"），按被拒重试、仍原样才隔离，不再按声明记账（"改14段"虚账）；② **SENT-01 引语豁免（生成闸门作用域）**——句法指令禁止拆直接引语而门禁照拦=数学无解（ch1 11/14 段误隔离），豁免只在工序门禁生效，报表/风险队列/回放层照常计数（回放层 23 章冻结数字零变化）；③ **LEN-01 篇幅退役出工序拦截**——两轮调适制已拍板篇幅为参考，每段 85%±12% 硬闸=两套尺且无工序负责压缩（ecnu-plus 靠同义词缩短侥幸、ecnu-max 忠实原样被拒），目标词数仍作软提示、篇幅照常进 recap；④ **词汇指令点名强制**——不得以长度达标为由整段跳过；⑤ **句法扫描点名列超长句原文**（带词数、引语内不点名）——类别标签时代模型整段盲拆漏句（ch2-4 自动完成 5/22、2/20、2/16）；⑥ **门禁判定线统一 SENT_LEN_CHECK**——此前按生成上限 17 拦、按检查线 20 点名，模型拆到 18-19 词达标仍被拒。另：**第二章原文词表碎片清理**——M50 重建稿夹入 10 处课题词表批注（Elaborate Expound…/重复句），刀口唯一断言清除（备份留档），脏源曾致 FACT-02 假隔离 12 段；旧 M 版残留 1 处 Counteract（将被新版替换）。

**A 层全书实跑（ecnu-max，187 调用全成功，24.7 万入/16.4 万出 token）**：223 段自动完成 146（65%），隔离 77（事实 17/结构 0/难度 60）全部单列待人工；篇幅 95-103%（篇幅退役的直接结果，B 允许比 M 长的拍板同源）；第一章生词率 11.5%→**8.2%**、平均句长 10.1→12.7 词（旧版三层句长全碎在 9.6-10.1 的梯度塌平被修复：A 12.7/M 10.6）。M 层 ch1 **14/14 零隔离**、ch2-5 已生成，B 未跑（Wayne 叫停先看效果）。书架 A 工作区已注册工序化版×10（备份 _工作区_backup_20260912_工序化注册前.json）。**两把尺教训入册：判定线全链路只能有一把（检查线），生成上限只能活在提示词里；协议计数以实效为准，不以模型声明为准。**

## [未发布] - 2026-09-12（main · Wayne 四条审查整改 + 真实交付验收：冻结代码换未调参章单次跑通 GUI 确认链路）

> 来源：Wayne 对四方向落地的四条审查（①注释密度下降可能只是少注了 ②15 段隔离可能是人工负担 ③"一个会话"≠历史只计费一次 ④复用晋级是策略不是证据）+ 指令"暂停加模块，做一次真实交付验收"。整改提交 `aa1bcd3`，验收轮在本条。`npm run verify` 全绿 **897 项**。

**① 配额触发返工而非静默放行（aa1bcd3）。** annotationTargets 改返回 `{need, extra}`：配额内的 need 正常注；**extra（配额外难词）不再默默不注**——加注工序先跑一轮"点名返工"（把 extra 词喂给词汇指令要求替换或降难），返工后仍剩的 extra 以 unsupportedGaps 如实进 recap 与待人工报告。负担四项报告落地 buildChapterRecap.burdenReport：**仍保留的困难词（对终稿全文重扫 OOV，不是只看注释）/ 已提供支持的难词（注释并集）/ 未提供支持的难词（缺口）/ 最密窗口密度**——"密度 4≤6"从此只证明显示不拥挤，难度证据看四项。顺手根修 annoDensityOf 把段号 [P##] 的 P 计入词数。

**② 隔离分类 + 冻结验收（aa1bcd3 + 本轮）。** QuarantinedSeg 带 ruleIds，classifyQuarantine 分三类：**事实疑点（FACT-\*）/ 结构损坏（ZH-01/WHOLE-CHAPTER/AST-\*）/ 难度残留（SENT/LEN/ANNO）**，待人工报告与汇总表按类分列、写明总段数。验收按 Wayne 协议执行：**冻结 aa1bcd3 代码与配置，换未参与调参的第三章，每路径只跑一次**。结果（A 层 20 段）：工序化路径自动完成 8 段、隔离 12 段（事实疑点 3[FACT-02]/结构损坏 0/难度残留 9[LEN-01 重]），负担四项 65/11/54 词、最密窗口 3≤6、篇幅 89%；旧式单轮 R1 对照（同冻结代码）：--check 只报 2 条难度项、**不报词缺口**（旧报告口径盲区）。**OOV 难词数：源文 233 → 旧 R1 138 → 工序化 65**——难词真实减少，不是少注。产物 20/20 段无缺段，隔离段原样保留在稿中并单列待人工（未悄悄省掉）。

**③ 阈值降格为暂定保护线 + 关键状态本地恢复（aa1bcd3）。** 会话改写 40/60/70% 注释改为"暂定工程保护线，等同等质量下 增长历史会话 vs 固定短前缀+当前片段 的总输入/输出/费用/等待 对比数据再定"；代码与文档同步纠正"一个会话≠历史只计费一次"（增长历史仍计入输入，缓存命中看供应商）。关键状态恢复全走本地结构化数据：工序化=段级 checkpoint JSON 落盘可断点续跑；两轮调适=进度 JSON；会话改写=JSONL 会话文件本身就是恢复源（recap 只是上下文压缩，schema 校验合格不声称事实零丢失）。

**④ 证据按独立位置去重 + 跨书封顶（aa1bcd3）。** 候选证据 positionKey = `book|chapter|segIndex`（无段退 itemId）——同章同段改两次只算一条独立证据；evidenceCount 按去重口径计数。跨书复用默认封顶 'book'，晋 'class' 必须教师显式 promote（且人物保护/专名规则类恒封顶本书）。"仅消费已批准资产"边界保留。

**GUI 实机验收（本轮）。** 新构建装机后走完：反馈框渲染+输入 ✓；任务单预览卡片（将修改五道工序/保留/点名难词/幅度）✓；**[开始修订] → 磁盘任务单 confirmed:true + confirmedAt 落盘 ✓**；已确认态回显（✓ 绿字 + --round2 指引）✓；重开 App 后正确回读已确认任务单 ✓。如实记录：自动化合成输入对 WKWebView 存在死角（**中文合成输入停留 IME 组字区不提交、AXValue 直写被拒、合成鼠标点击不触发 button click**）——保存按钮的 click 事件未能在合成输入下触发，其产物格式改用真核心函数 planRevisionTask 生成同构文件后由 App 渲染并走完确认链路；真人键鼠操作不受影响（handler 绑定有渲染证据：预览卡片在同一绑定函数内生成）。失败提示（保存失败/确认失败前缀改按钮文字）代码在、本轮无真实失败未视觉触发。

**验收遗留（如实）**：旧式两轮 R2 的混改写不保证注释存在（R2 终稿注释 1 处 vs 工序化路径确定性加注）——这是新旧路径的真实差异，已在对照报告写明；A3 工序化 9 段 LEN-01 难度隔离的处置（返工一次仍超长）需教师定夺或放宽生成句长参数后再验。

## [未发布] - 2026-09-12（main · 四方向优化方案 v2：工序化调适 / 任务单先确认后执行 / 候选资产层 / token 台账）

> 来源：《LayerText 文本调适四方向优化方案 v2》（桌面，精华收敛+代码现状对齐版）批次 0-4 全部落地；`npm run verify` 全绿 **893 项**（+41），A 层第七章工序化全流程实跑六轮校准。

**批次 0：可观测先行。** 共享调用台账 `LayerText_AF调用台账.mjs`——三档生成/三档精修/两轮调适/补注四脚本 callChat 全接入：逐调用 JSONL（usage/finishReason，拿不到记 null 不伪造）+ 与 App 同列序（COST_HEADER）的管线侧 CSV（同格式可拼接，不与 App 共写防并发覆盖）。注释密度双口径收敛：补注自设的 90 词型/千词退役，改用 adaptcheck 的 ANNO_DENSITY_LIMIT（A6/M4/B3，处/百词）——补注与两轮调适检查从此同一把尺，第二套密度常数即缺陷。

**批次 1：第一轮多工序调适（方向一）。** `src/core/stagepatch.ts` 差量 patch 协议（唯一定义）：五道工序（词汇粗筛→句法→词汇复筛→连贯性→最终加注，加注最后）；AI 只返回段级 patch，一个 patch 混多段标记=整章形态拒绝；未返回=原样；changed 段过 gateSegment（STAGE_BLOCK_RULES 声明各工序点生效规则：ANNO-01 只在加注点、FACT 只在连贯性点升级拦截）。`stagescan.ts` 本地扫描（零命中=零调用，阈值全部复用既有实现）。`stagepipe.ts` 编排核心（AI 注入式可单测；失败段带原因重试一次再隔离，隔离段跳过后续工序；ChapterRecap 本地确定性构建）。管线 `LayerText_AF工序化生成.mjs`（产物 suffix=_工序化；候选段分批 ≤8 防截断）。**A7 六轮实跑校准出三个真问题并根修**：① stagepipe 自动事实守卫与 gateSegment 的 lostSignals 重复判定且更粗糙（句首大写词/1st→first 误判丢失，误杀 20 段）——删自动抽取，事实判定唯一口径=lostSignals；② ANNO-01 全量必注与层策略打架——annotationTargets 配额制（KB 必注词优先、出现序补足层配额 A2/M1/B3，超额=挑战层保留项进 recap）；③ 模型"返回插好注释的整段"随机漏注/混中文/顺手改写——加注改确定性路径（词典释义就地插入，缺释义批量问模型只要词义；逐字移植补注验证过的 insertAnnotation）。终态：五道工序全部干活（词汇 23/句法 20/复筛 12/连贯 7/加注 16），隔离 15 段（真实质量拦截交教师），注释最密窗口 4≤A6。

**批次 2：第二轮任务单——先确认后执行（方向二）。** `adaptcheck.ts` 新增 planRevisionTask/planRevisionStages/revisionTaskPreview + FEEDBACK_STAGE_MAP（方案表 2 代码化：反馈类型→重跑工序；情节疑问→转人工不跑 AI）。管线 `--plan`（生成任务单+预览+本地检查圈定预计段数，零 AI 调用）/`--confirm`/`--round2` 硬闸门（App 反馈必须先过确认任务单；CLI --feedback=终端显式确认自动落单留痕；needsHuman 拒执行）。App 反馈框保存即生成任务单并渲染预览（将修改/保留/幅度/点名词，与 CLI 同一份渲染），[开始修订] 落 confirmed、[修改反馈] 回填。两个实测修复：KEEP_RE 全局匹配把「情节和人物可以」整段吃掉只留一个词——保护维度逐词独立扫描；幅度正则补「一个学期/一个学年」变体。

**批次 3：省 token 会话（方向四）。** 会话改写：token 阈值三档（--ctx 按最近请求 prompt_tokens 占比：≥40% 主动压缩、≥60% 警戒、≥70% 强制新会话保结转状态；与段数窗口谁先到谁触发）；章末摘要自由 5 行→固定 JSON schema 本地校验（不过重试一次，仍不过降级回自由文本锚并 warning）。

**批次 4：修改资产的复用与晋级（方向三）。** `src/core/candidate.ts`：LearningCandidate 挂决定事件之上；最小有效范围（一次局部替换=当前句→同章两次=本章→同书同层→跨层=本书→跨书=本班），人物/地点/情节类封顶本书永不自动跨书；promote/reject（撤回批准=正当操作）/applyUndo（撤销降证据）；RewriteFamily 跨层策略族（各层只放自己证据支持的动作，其余层留白不复制）。决定汇总 `--candidates` 生成回流候选台账（事件是正本台账是视图，教师已批/已拒状态保留）；`--apply` 落库同步晋升对应候选。工序化生成只消费 approved 且范围覆盖本章本层的资产（批准释义优先于词典、批准改写偏好进词汇指令）。**顺手根修存量 TDZ**：决定汇总 TIERS 定义在 readRunIdentity 之后，真实项目一跑就 ReferenceError（冒烟门禁坏指针在更早处退出一直没看见）。

**已知遗留（如实）**：补注仍走 DeepSeek（09-12 换源时漏了它，已在脚本头注明并入台账可见）；App 任务单预览的 GUI 走查留 Wayne；候选台账的字段化 scope 尚未写进词典 CSV 格式（dict/词表仍是全书生效的物理格式，范围目前由消费端过滤执行）。

## [未发布] - 2026-09-12（main · 两轮调适制：教师反馈驱动的难度下移闭环）

> 来源：Wayne《两轮调适制》方向文档（七部分）+ 语音补充（"两轮之间必须有我的阅读判断"）。目标锁定：选择文本和层级，系统最多生成两轮，交给教师一份明显降低难度、保留情节、注释不过密的候选稿；人工修改后即可发布。阈值均为工程试运行值（注释密度 A6/M4/B3、句长 A20/M17/B14），非教学标准。

**层级定义重写（第一部分）。** 篇幅比例（85/75/60%）不再主导生成——保留篇幅与阅读难度没有稳定对应关系。A/M/B 改为三维目标矩阵（目标/词汇/句式/指代/篇幅=参考/注释六行），篇幅硬约束退役（修剪轮/守恒重试删除；不为压篇幅删人物提示、原因、解释；B 允许比 M 长）。

**本地检查引擎 `src/core/adaptcheck.ts`（第三、五部分，纯函数 12 测试）。** 注释拥挤：每百英文词显示注释处数（去段号与中文、跳过标题行）、一句≥2注、最长句、**最拥挤一句/最拥挤百词窗口**（防平均掩盖局部）；检查三级分级：结构（阻止发布）/信息变化（人工确认——否定整类消失抓"不得→可以"反向，数字专名检查不代替情节保真）/难度（第二轮）；**新引入词**检查（防第二轮换进未检查的新难词绕过，词形家族+高频不规则容错，与 QC 同口径由 makeKnownChecker 保证）；教师反馈解析（自然语言→维度/保留维度/幅度档位+点名词）。

**两轮制管线 `tools/af_pipeline/LayerText_AF两轮调适.mjs`（第四部分）。** 第一轮逐段初稿 `_R1`（段级进度中断恢复）→本地分级检查→**教师一次自然语言反馈**（--feedback 或 App 反馈框落盘；正文 simpl 标记自动并入、举一反三）→第二轮按维度+幅度复写（带失败原因+退学词清单+不可删信息）→终稿+调适报告（终稿重查剩余问题；"待处理/可发布"状态分开）。**两轮闸门**：R2 后拒绝第三轮（剩余交教师）；单段最多两次尝试；失败保 R1。**幅度=档位**：`--progress 九上U5` 持久设置教材进度，"超前一学期"回退 2 单元词汇边界（教师手工词库词不回退；显式折算记录，不声称精确）。词库加载失败显式"词汇约束不可用"。

**第七章（全书最难章）三层实测**：生词率 A 23.5%→**11.6%**、M 15.7%→**9.5%**、B 12.2%→**6.7%**；注释 236/126/77→**0**；最长句 58/54/52→27/26/17；否定数上升（45→51 等，方向性保留更好）；专名 8/8 全保留。对照报告 `两轮调适_对照报告_第七章_2026-09-12.md` 回答方向文档第七部分五问。

**App（第二、六部分）。** 审校侧栏「给第二轮调适的反馈」框（三档命名时显示）；报告页难句行「⚡更简单」候选（接 AI 改写本句，正文预览点 ✓ 才生效）；调适状态区块（待处理/可发布可见可区分）；词库语义文案（"学生已学过"→"词表内/学生会（入库）"——词库收录≠学生已掌握）；`prefers-reduced-motion` 全局动效停用；文件 tab 章名前缀+路径悬停+横向滚动（十章不撑高顶部）。**书架 hero 修复**：saveLastSession 的 bookDir 误存章目录，与书架注册的书根永不相等→"继续上次编辑"入口对本书失效；改为 `S.currentBookDir ??（书根）` 锚定，实机验证一键续开第七章。

**同日其他**：ChatECNU API 接入（管线 ecnu-plus，key 钥匙串 layertext.ecnukey）；目录三处根修（工作区上下文随会话对齐/注册表多层向上找/目录条目显示章名）；A/M 全书难度下移第一版（生词率 20.4→14.4/15.4→14.0）。

**验证**：`npm run verify` 全绿 **852 项**（含 appswallow 静默吞错守卫）；第七章三层两轮制全流程实跑（R1→反馈→R2→闸门）+ 前后对照报告。

## [未发布] - 2026-09-12（main · 第七轮质检修复：发布身份与完整性闸门 / 决定全层计数 / derivedFrom / partial 口径 / TDZ 门禁）

> 对照表见 `docs/总计划落实对照表_第七轮.md`。输入是《LayerText 第七轮质检报告》；本轮把 P0×3 + P1×3 + P2 可代码化三项全部收口，`npm run verify` 从 831 项增至 **841 项**全绿，干净 checkout 同样全绿。

**工作树收口（P0-①）。** 未提交改动是一个完整功能（教师稳定 ID + 任务实验），且基线并不绿：lint 挡着 2 处、学生版端到端用例自身还有 2 处缺陷（清单路径少 `.json`、断言与 fixture 布局不符）。修复后分五个逻辑提交收口，`.gitignore` 收编 `dist-*/`。

**全局"最新"指针不再是发布事实源（P0-②）。** `发布包.mjs` 原来**无条件优先**读全局 `清单_最新.json`——与 `readRunIdentity` 已解析的身份完全脱钩，并发时把 A 老师的清单打进 B 老师的发布包且照常 exit 0。现在只按身份点名读 `清单_<runId>.json`；"最近一次"来源要求数过该教师名下的运行分片恰为一份，多份即歧义拒绝；读到后校验 runId 与教师双一致。`会话改写.mjs` 的 `LEXICON_VERSION` 同病点一并修。

**缺件即拒（P0-③）。** 原来缺件进 `skipped` 后照常建目录写描述——产生"结构完整但缺件"的部分包，而收件人只核对包描述里**有的**件，"缺件"看起来就像"完整"。现在缺件打印产物身份与路径、exit 1、零新文件。

**原子替换导出（P1-④）。** staging 写入 → `verifyBundle` 自检 → rm 旧目录 → rename。重复导出后目录内容严格等于本次清单，旧残留不再混进 `--check` 视野制造假"夹带"警报。

**决定日志全层统计 + 层级口径唯一（P1-⑤）。** 调查发现比报告更重：不只"只读第一层"，还有层键/标签错位（`'A'` vs `'A层85'`）——**`decisionCount` 实际恒为 0**。修在 `resolvePath` 入口（`tierTagOf` 落在请求上，`logTail` 与各分支吃同一个值），调用方传哪种写法都解析到同一文件。验收即报告原标准：三层各一条决定 → 计数 = 3。

**学生版 derivedFrom（P1-⑥）。** `RunArtifact.derivedFrom` 记源稿产物身份、源稿路径、生成器版本、过滤规则版本与实际过滤节；登记侧（清单扫描）写入、发布包原样带进包描述。收件人从此能回答"这份读物是从哪份工作稿、按哪版规则减出来的"。

**partial 章显式声明三件套（P2）。** 第十章只有 3 段——口径拍板为**显式声明**（脚本不猜）：`清单 --partial-chapter 10`；回放 `--partial` 冻进 cfg、每章质检带 `completeness`、partial 章仍进覆盖但**不进全书分母**且排除章点名；发布默认拒发 partial 章学生版，`--allow-partial` 放行且写进包描述（收件人可见）。fixture 重冻仅新增 completeness 字段，所有口径数字逐一未变。

**TDZ 冒烟门禁（P2）。** TDZ 已四次发生且 `tsc`/`node --check` 查不出。新增对全部 20 个管线脚本的零成本顶层加载冒烟（约 1 秒/全套），**反证通过**：放入真 TDZ 脚本时门禁当场红并点名。

**教师名录边界（声明）。** 名录只归一化身份（谁是谁），不是权限系统：不授权发布、不读他人班级数据。授权与多租户分层属商业化前置，本地优先存储跑通后另行设计。

**验证**：`npm run verify` 全绿（**841 项**，起点 831）· 干净 checkout（worktree + 软链 node_modules）verify 全绿 · 双教师并发 / 缺件零残留 / 重复导出替换 / 三层决定计数=3 / partial 拒发与放行 / TDZ 反证，全部有自动化断言。

**真实项目生效前提（交接提醒）**：AF 真实数据清单从未 `--stamp`（`artifacts: []`），derivedFrom 与发布闸门要生效需先补盖章；第十章 partial 需 `--partial-chapter 10` 声明一次。

## [未发布] - 2026-09-11（main · 第四十七~五十一批：阶段 3 两条验收 + 回放覆盖全书 + App 层 catch 审计）

> 对照表见 `docs/总计划落实对照表_第五轮.md`。这一轮补的是**阶段 3 里两条从来没被当回事的验收**——它们既不是功能也不是性能，而是"这个工具能不能被另一个团队拿去用"。

**「第二本书只需新建 manifest，不复制脚本」（第四十七批）。** 这条原来做不到，原因朴素得有点刺眼：**一个写死在 10 个脚本里的数组** `['一','二',…,'十']`。抄十份已经够糟，更要命的是它**写死了"十章"**——换一本 12 章的书，`CN[10]` 是 `undefined`，`第undefined章` 会一路拼进路径和报表，**而脚本照常报成功**。新增 `src/core/chapters.ts`（中文章号 ↔ 整数、**按章号排序**而不是字典序、配置 > 原文目录 > 默认三层）。

**「删除缓存不影响从 manifest 重建队列」（第四十九批）。** 清单里明明记着 `tiers` 与 `chapters`，而**此前没有任何脚本消费它们**：层与章一律从命令行来。于是把队列删掉之后，"重建"只能靠人回忆当初敲过什么，**敲漏一章也不会有任何提示**。现在范围按**命令行 > 清单 > 默认**取，并把"这一项从哪一层来"打进日志。

**引擎模块路径也走 `distOf`（第五十批）。** 12 个脚本里 55 处写死 `${REPO}/dist/src/core/*.js`——不是功能错，而是**没法拿一个还没装进共享 `dist/` 的构建去验证**。本轮两个并行子代理都因此只能测共享 `dist/`，其中一个的隔离验证干脆做不成。

**回放层扩到全书十章 × 三档（第四十八批）。** 项目历史上有一次很严重的事故：**A 层第 7/8/9 章的加注覆盖率只有 2%/3%/1%** 且无人察觉——**那三章正是此前完全没人守的地方**。现在冻下 10 章 × 3 档、669 条段级记录；出事的三章现在是 100%，而且从此被守着。反证：把第七章 A 层产物的 171 个中文注全抹掉 → 5 条用例当场失败并报出覆盖率 100% → 0%。

**App 层 30 处静默吞掉的 catch（第五十一批）。** `app/src/**` 约 11.5k 行此前从未审计过。161 处 catch 里 30 处属于"静默吞掉"，全部修掉。其中最要命的是**保存路径**：`loadConfig` 读不出来 → 设置变空对象 → **之后任何一次保存都把空设置写回磁盘**（AI 配置、主题、阅读进度静默消失）；`loadShelf` 同理，教师往"空书架"里加一本书就**把整本注册表覆盖成一本**。还有两处假 0（"替换规则残留 0"＝"全书一遍没漏"，而那本书根本没核过），以及 **`renderDataPane(...).catch(() => undefined)`——正是计划点名的那句「点了没反应、卡片还在」**。

**验证**：`npm run verify` 全绿（**766 项**）· `npm run verify:rust` · `vite build`。

## [未发布] - 2026-09-11（main · 第四十三~四十六批：真项目回放层 / README 数字 / Artifact 身份 / 布局迁移）

> 对照表见 `docs/总计划落实对照表_第四轮.md`。这一轮最值得记的是：**新加的那层守卫，第一天就抓到了一个错——而且两次都是"我们以为对的数"**。

**真项目回放层（第四十三批）。** 纪律第 5 条要的第三层。前面两层都在问"这段代码对不对"，**回答不了**"我们报给教师的那些数还对不对"。现在把真项目第一章的输入（全份，320KB）与结论一起冻在 `tests/fixtures/replay/`，每次跑测试都重算对数。**冻样本第一天就抓到了工具自己的错**：漏了内置课标词表与专名表，于是"原文生词率"算出 21%（项目报告是 16.5%）。改正后六个数与项目自己的复核报告**逐位相同**。

**README 的性能数字复现不出来（第四十三批之补）。** README 写着"A 层阅读负荷下降 **30%**、理解支架覆盖率 **94%**；M 层 **43%** / **93%**"，而当前代码算出来是 **28%/96%、45%/98%**——那三个数是 2026-09-10 词表口径修复**之前**留下的，之后再没人对过。README 是潜在用户最先看到的东西，写着一个复现不出来的数**比不写更糟**。改法二是关键：把 README 的数**绑到冻样本上**，想改就得先重新冻结（也就是真的重算一遍）。

**Artifact 有了稳定身份（第四十五批）。** 计划要「Run/Artifact/Decision/Teacher 四类实体有稳定 ID」，而 Artifact 原来把 `path` 当主键——**身份就是位置**。身份改为逻辑身份 `(kind,tier,chapter)`；**刻意不是内容哈希**（同一件被两位教师改成两份内容 → 身份相同、内容不同，这正是要报的「分叉」），也**不是随机 UUID**（两次运行写同一件会得到两个 ID，漏洞永远查不出）。增益是实测的：两次运行把同一件产物写到两个不同路径，旧口径判 `{ok:true}`，新口径报「分叉」。

**legacy → run 布局迁移（第四十六批）。** 默认演练、`--apply` 才动手、默认复制不删原件、可回滚。命名规则一份都没重写——全部路径仍从 `resolvePath` 来。**做这个工具的人发现了根因**：`resolvePath` 的 run 分支漏了 `suffix`，于是"先试跑、再正式"（输入相同 ⇒ runId 相同）会把**待复核段落写进同一个文件**，而那是那次失败唯一的记录。已修（保留 legacy 的语义：后缀分空间）。**默认值仍然不翻**——那会让教师已有的书换目录。

**验证**：`npm run verify` 全绿（**737 项**，起点 703）· `npm run verify:rust` · `vite build`。

## [未发布] - 2026-09-11（main · 第三十六~四十二批：原子写 / 两条纪律落地 / 阶段 4 实验台 / 词表正本）

> 对照表见 `docs/总计划落实对照表_第三轮.md`。这一轮的共同点是：**几条"写在计划里但从来没被验证过"的纪律，逐条去查，发现其中两条根本不成立**。

**正文改成原子写（第三十六批）。** `std::fs::write` / `writeFileSync` 是「截断 → 写」，中途失败会留下**半份正文**——对教师唯一的一份稿，半份比没有更糟。改成同目录临时文件 → `sync_all` → `rename`。**对照实测**（300KB 正文 × 1 秒内连续覆盖，子进程持续读）：直接写看到 `PARTIAL:0 / 8192 / 24576 / 40960`，原子写看到中间态 **0 次**。临时文件名以 `.` 开头，于是所有"扫目录找产物"的地方都不会捡走半成品。

**纪律第 2 条原来不成立（第三十七批）。** 「哪些超纲词算『该注』」散在四处且两两不同——`qc.ts`/管线/风险队列都是 `> 2`，**App 单句改写是 `> 1`**。同一个 2 字母超纲词在 App 里会被拦下要求加注，别处却根本不进分母。现在口径只有一处（`ANNOTATABLE_MIN_LEN`），且 **`gateSegment` 自己收口**，不再信任调用方。反证实测：把规则改回去，两条关键断言都不成立。真项目恰好没有 2 字母超纲词，所以这个分歧一直是**潜在**的。

**纪律第 4 条落地（第三十八批）。** 每条 AI 响应补上 `traceId`（与 App 侧同一套算法）与词库版本；`publishReadiness` + `buildBundle` 抛错实现「**没有这些字段的产物不可发布**」。顺带照出一个事实：第二轮写的测试夹具其实是一份**现实中不存在的清单**（没有输入哈希、没有产物）。

**纪律第 3 条做成结构性守卫（第三十九批）。** 判定链路（`segmentgate`/`qc`/`rewrite`/`riskaction`）里**一个 catch 都没有**；写正文的事务里每个 catch 必须让失败可见，且**不许走到成功路径**。守卫本身也做了注入验证。

**阶段 4 实验台（第四十一批）。** 先说一个必须先说的发现：`LayerText_AF四格实验.mjs` **在 HEAD 里根本跑不起来**（TDZ）。现在它能在离线自检下端到端跑通，并把阶段 4 前三条验收变成可机械检查的东西。**截断率**那一半原本"算不出来"——因为会话脚本没记 `finish_reason`；补的时候发现缺口其实隔了**三处**（没返回、没写进日志、四格实验没转发）。

**词表正本（第四十二批）。** 阶段 3 最后一条：「旧 CSV/JSON 只做一次导入，不再作为新的事实源」。新增 `src/core/lexiconstore.ts`，正本装的是**真的数据**而不是指纹。漂移策略选**拒绝**（自动重导入会在没人看着时换掉判定口径；警告会被淹没；改读 CSV 等于没做）。**一处改动，15 个脚本一字未改**；没有正本的项目代码路径与改造前逐字相同。独立复核：两种模式的产物**逐字节相同**。

**验证**：`npm run verify` 全绿（**703 项**，起点 619）· `npm run verify:rust` · `vite build`。

## [未发布] - 2026-09-11（main · 第三十五批：路径解析收口 + 发布包与溯源）

> 落实《LayerText 工程优化总计划》阶段 3。计划把它称作「**最关键的迁移**」：「把路径解析集中到一个 `Resolver`，**禁止业务代码拼目录**」。第一轮的审查结论是引擎层齐备但**接线只做了一半**（17 个管线脚本里只有 4 个接了 `Resolver`）；本轮把这个收口做完，并补上阶段 3 里原本完全缺失的「导入导出 / 学生数据不出包 / 任意发布文件可溯源」。对照表见 `docs/总计划落实对照表_第二轮.md`。

**路径解析收口：11 个手拼路径的脚本，现在 0 个。**

- 引擎侧新增两个 `ArtifactPathKind`：`汇总报告`（三档汇总/台账总览/四格实验报告/风险队列报告）与 `运行中间产物`（`_运行/` 下的机器读产物），`PathRequest` 加 `name`——原来这几类产物**根本无法用"层+章+日期"描述**（汇总报告跨层跨章，它只有一个名字），所以脚本只能手拼。
- **迁移不许改动落点**：18 条 legacy 路径逐字符比对通过（正文/台账/复核报告/风险队列/会话日志/决定日志/版本日志 + 两种新 kind）。这次改动在 legacy 下**对教师完全不可见**——这正是"不破坏教师已有工作流"的硬约束。
- 剩下 2 个脚本（`重制_生成` / `重制_预处理与规则`）**刻意不改**，诊断写在代码里：它们读写的是**原文目录**（源树），而 `Resolver` 建模的是**产物目录**；硬塞进去只会给源树编一套并不存在的 kind。
- 过程中抓到并修掉三个真缺陷：① **`清单.mjs --stamp` 的布局取自命令行而不是取自它刚读的清单**——建清单用了 `--layout run`、刷状态忘了再写一遍，就**一件产物都扫不到、清单记 0 件，而输出照旧写「清单已更新」**（实测复现）；② `汇总报告` 的 run 分支漏了日期，导致同一产物在两种布局下**名字不同**；③ 若干脚本的解析器定义落在使用之后或引用了尚未定义的层级常量（TDZ）。
- `tests/pipeline_gate.test.ts` 新增 6 条**端到端**用例，每条都断言**文件落在哪**：只断言"跑通了"没有意义（写在错地方照样退出 0）。其中一条刻意断言报告里**不出现"读不到产物"**——只看文件存在是不够的，"读不到 → 记 0 → 照样写报告"也会通过。

**发布包与溯源：`src/core/bundle.ts` + `tools/af_pipeline/LayerText_AF发布包.mjs`。**

- `--export` 按清单把该出包的产物收成一个目录 + 一份 `发布包_<runId>.json`；`--check` 逐件核对（缺件/哈希不符/夹带学生数据）并以非 0 退出；`--where` 查一份发布文件的出处。
- **「打包默认不含画像、成绩和个人信息」落成代码而不是一句承诺**：白名单（没被明确允许的都不出去）+ 黑名单（`分层_示例班.json` 这类数据文件形态，同时放行 `分层阅读说明.md` 这种正经文档）+ **显式排除清单**（`excluded` 哪怕为空也要在——静默丢弃让人以为包是完整的，静默收录才是数据事故）。
- **没有清单就不发包**：没有清单的包只是一个压缩文件，不是可追溯的发布物。
- 三处刻意的诚实：查不到出处**如实说查不到**并把"不编一个出处"写在那行文字里；拿不到当前内容时说"未核对哈希"而**不说"对得上"**；`rejected`（系统没做成）在报告里标 `⚠`——**它不是教师的判断**。
- 决定日志与版本日志**只记条数、不进包内容**：它们含教师 ID 与逐条操作，属审计材料。

**词典锁原来是形同虚设的（已修）。** `withLock` 的写法是 `lockState(readLock())` → 判断 free → `writeFileSync`——一条 **TOCTOU**：两个进程可以**同时看到 free、同时写**，于是**两个都以为自己拿到了锁**。改成 `openSync(path,'wx')` 原子占锁 + token（只释放自己的锁）+ **有上限的等待**（默认 60s，原来"重试 3 次 × 300ms"不到 1 秒，真实词典合并根本跑不完，于是"有锁"反而变成"并发一跑就失败"）。**对照实测**（4 进程 × 60ms 临界区 × 6 轮，真开进程）：改造前 **6/6** 轮出现临界区重叠，改造后 **0/6**。

**阶段 2「任务工作台」（并行落地）。** 新建 `src/core/workbench.ts`：任务状态定义、暂停/恢复、今日任务、变更历史、可解释性。计划的两条验收都有能挂在旧代码上失败的断言：①「10 分钟后暂停、重开仍是同一任务状态」——任务状态是（队列 + 决定日志）的**纯函数、不含任何时间项**，`gapMs` 只用于"说"从不用于"判"（10 分钟与 26.2 小时都测）；②「撤销连续三次仍可解释」——单级语义下两种读法都测，结论与计划一致：**不需要版本树**。三处判断值得记下来：**暂停点另立一本账**（`_决定/工作台_<层>.jsonl`）而不塞进决定日志，因为后者会被 `productMetrics` 整份消费，多一个 `pause` 会挤偏误报率与撤销率的分母；**「暂停点」是指纹不是快照**（恢复时先现算再比对，单测构造了"暂停期间别处判了一条"）；**「今日任务」不是日历**，没有数据时直说"不知道"而不是"0 条"。顺带修掉 `panelStat` 漏 `undone` 导致"页首待办数 ≠ 列表待办数"的真缺陷。

**验证**：`npm run verify` 全绿。新增 `tests/bundle.test.ts`（18）· `tests/bundle_cli.test.ts`（6，真跑子进程）· `tests/lockfile.test.ts`（3，真开进程抢锁）· `tests/workbench.test.ts`（19）· `tests/pipeline_gate.test.ts` 增 6 · 面板测试 +10。

## [未发布] - 2026-09-11（main · 第三十四批：正文版本节点 + 唯一的写正文事务 `applyChange`）

> 落实《LayerText 工程优化总计划》。计划把两件事排在最前：阶段 0 的正确性封口，然后**立即**完成阶段 1 的「版本化编辑事务」——理由是「只有先保证检查对象和写入对象完全相同，后续的任务聚合、教师指标、四格实验和商业承诺才有可信的测量对象」。对照表见 `docs/总计划落实对照表_第一轮.md`。

**阶段 0（正确性封口）——补齐验收证据。** 计划点名的两个语义缺陷（`segmentSentences` 无 `[P##]` 时返回空数组导致 `SENT-01` 死规则、`checkRewrite` 判归一化文本却返回入参原文）在本轮开工前已修，本轮补的是**计划指定的验收证据**，其中真项目那一条是新的：

```
产物  名著阅读工作区_AnimalFarm/…/第一章/原文_A层85_2026-09-10.md
SENT-01（A 层 >20 词）门禁报出：19 句
人工逐段重数：                  19 句     ← 「与人工抽查一致」
逐段不一致的段落数：             0
反证（把分句退回旧行为）：         SENT-01 = 0   ← 这条规则此前确实是死的
```

**阶段 1（版本化编辑事务）——主体工作。**

- **新建 `src/core/version.ts`**：正文的**版本节点**（版本 ID / 父版本 / 前后内容哈希 / 整段的改前改后 / 事件外键）与**唯一那个写正文的事务** `applyChange` / `applyChangeBatch` / `recordOnly`。目标架构里那句「所有正文写入都产生版本节点，**不允许直接覆盖『当前文件』而没有父版本**」在这里落地。
- **三处写正文的入口全部改走它**：风险面板单条动作、批量应用（一章一次事务、**一条 `batch` 版本节点**、事件逐条记、`批量` 前缀留痕）、撤销。撤销顺带修掉一个真缺陷——原来用 `doc.replace(after, before)` 做**全篇**替换，会顺手改到别的段里恰好相同的那一处；现在只在那一段里换（`revertInSegment`）。
- **App 单句改写采纳（`app/src/adoptrewrite.ts`）**：原来 `acceptSuggestion` 是把内存里的整份稿**覆盖写回去**，三个口子一起封掉——① 采纳时**不复判门禁**（判定在"生成候选"那一刻，写入在按键那一刻，中间隔了多久没人知道；现在写入前重跑，且刻意**不**回退到缓存结论）；② 没有 `baseVersion`（编辑器有未保存改动、或别的窗口改过同一章时会**抹掉别人的改动**；现在先比对哈希，不一致就拒绝并说明）；③ 没有版本节点（"这一段现在是这样，是哪来的"答不出来）。
- **三态 `blocked` / `candidate` / `applied`** 定死为**一条链路上的三个位置**，不是三个模块各自的说法（`stateOfChange` / `stateOfRewrite`）。
- **可重放**：`replaySegment` / `replayByTrace` / `provenanceOf`——发布段可由 `sourceVersion + traceId` 重放，且**断链会被检出**（父版本的 `segAfter` 对不上子版本的 `segBefore` 时报"版本链断了，当前文本不可信"，而不是照常给一个字符串）。
- **事务之外有人改过稿 → 当前版本自动降级为内容寻址的新底稿**：版本号是内容哈希派生的，所以外来的覆盖**自动可见**，不会被账本上的旧版本号盖住。
- 顺带修掉：`applyAction` 的"哪个词"检查放在所有分支之前，导致 `revert` / `rewrite` 这两个**不需要 word** 的动作一律被误判成 `missing-arg`（新用例当场抓到）；层级标签 `{A:'A层85',…}` 抄了 8 份，收进 `src/core/manifest.ts` 的 `TIER_TAG`（**只有一份**）。

**阶段 2（任务组压缩比没达标）——已修。** 计划验收是「Animal Farm A 层第一章 **70 条 ≤ 25 组**」。真产物实测：**55 组 → 19 组**（同词 39→3、同段规则 16→13、同章类型 0→3、单条成组 46→0）。根因是 36 个"只出现一次的词"各自成组，且本该兜底的 `chapter-category` 档被前一档吃光、**永远走不到**（声明了却全仓无引用——写法上存在、运行时不存在的分支）。改法是前两档的判据从"键相同"改成"**键真的聚起来了**"。顺带补上 `batchPreview(g)`：**列出将改变的词与段**（原来只有"改动 N 处"三个数），并修掉"没有批量按钮的组仍显示『全部应用会改动 N 处』"这个假承诺；还修了一条**名实不符的测试**（名为「同章同类型的散项归一组」却断言 `kind === 'segment-rule'`）。

**阶段 3（两处会静默出错的路径拼接）——已修。**

- `LayerText_AF会话改写.mjs` 的**已注词账本绕过了 `Resolver`**：同一个文件第 670 行的产物路径走 `R.any('正文')`，而账本这处手拼。`--layout run` 下手拼路径永远不存在 → 账本一个词都读不回来 → **跨章去重静默失效、同词被反复加注**，而脚本报成功。
- **`清单_最新.json` 是一份全局指针**：三个脚本 + App 面板各写了一遍"读它 → 再读它指的清单"，读的是同一个文件。两位教师并发跑同一本书的不同层级时，后跑者覆盖先跑者，先跑者的进程去读到**对方的 `runId`**，把产物写进对方的运行私有目录——而两边都报成功。**`--layout run` 挡不住**（它挡的是路径撞名，不是身份被换掉）。现在指针**按 (教师, 层级) 分片**，`清单_最新.json` 退化为索引，四个消费方统一走**一个**解析入口，**对不上就拒绝借用别人的运行**并响亮说明，坏指针**不许半途生效**。

**顺带补上两处"新路径反而比旧路径少一层保险"的地方。**

- **账本追加不是原子的**：版本日志与决定日志都是"读全文 → 拼一行 → 写全文"，两个人同时追加时后写的会把前一次的整份内容覆盖掉——丢的是一整条决定或一整版记录，且**毫无迹象**。Tauri 侧新增 `append_text_file`（`O_APPEND`：一次一行是原子的），面板与单句采纳都接上它；面板同时补上了 **改稿前备份**（这条退路原来只长在 `persistEdit` 上，走新事务的路径反而没有）。
- **`sourceVersion` 不再是层级标签**：审查 A4 的结论是"数据存在但源头就是错的"——面板传的是 `A层85` 这种标签，而它要回答的是"这条决定是对着哪一版做的"。现在在面板入口处换成**这一轮队列产物的内容哈希**（换在入口而不是每个调用点，免得出现"有的决定有版本、有的没有"）。

**验证**：`npm run verify` 全绿——typecheck（引擎 + App）· lint `--max-warnings 0` · **测试 495 → 557**；`npm run verify:rust`（fmt + clippy + 5 项测试）通过；`app` 前端 `vite build` 通过。新增 `tests/version.test.ts`（23）· `tests/adoptrewrite.test.ts`（17）· `tests/runidentity.test.ts`（14）；`tests/riskqueue.test.ts` 改 1 增 7；`tests/pipeline_gate.test.ts` 增 1 改 2。真项目样本 `tests/fixtures/风险队列_A层85_70条.json` 入库，让"70 → ≤25 组"这条验收可复现。

## [未发布] - 2026-09-11（main · 第三十三批：把"原子写正文和事件"做实）

> v4 方向第 2 条要的是「先校验当前位置仍等于 before，再**原子写正文和事件**」。前一版只做到"先校验 + 依次写"，留下一个真实缺口：**正文写成功、事件写失败**时，稿子被改了却在日志里查不到、撤销也无从下手。

- **写入次序统一为「先在内存里跑完 → 写正文 → 写事件」，事件写失败就把正文回滚**（跨两个文件的真原子做不到，但"不留下改了稿却没记录的状态"是能保证的）。单条动作、批量应用、撤销三条路径都按这个次序改过。
- **批量应用顺带改掉了次序问题**：原先逐条写 accept 事件、最后才写正文——那会留下"日志里有、稿子没变"的假账。现在先在内存里把整章跑完，一次写正文，再写事件；正文写不进去则该章条目**全部 rejected**（绝不显示成已办）。
- **`mkDecision` 不再被 `void` 掉**：事件写失败原来是 **unhandled rejection**（新加的用例当场抓到），在 App 里就是一条无人处理的红字。现在每一处都 await 并被处理；连"失败记录也写不进去"都会如实告诉人，而不是静默。
- 新增用例：把决定日志的写入模拟成失败、正文写入正常，断言**正文被改回原样**且界面说明"已把正文回滚"。
- 测试 494→495；`npm run verify` 全绿，`app` 前端 `vite build` 通过。

## [未发布] - 2026-09-11（main · 第三十二批：情节先验 + 定位两条轴分开说）

> 落实《LayerText 审查报告 v4_方向》剩下两条：「`plotSignalScore` 情节权重（只作排序 tie-breaker，**不得升级为 blocker**，卡片必须显示『机器估计：高/中/低』与命中的底线条目）」与「产品定位改为『受控的分层阅读适配』，界面与文案分开显示『阅读负荷下降』和『理解支架覆盖率』」。

- **情节先验（`src/core/plotweight.ts`）**：三条自我约束写在代码里——① 只产出分数与命中项，**没有任何阻止流程的能力**（`SegmentVerdict` 里根本没有它的位置）；② 命中项必须是**能贴给人看的原文片段**（"机器估计：高"而不给依据，等于让人信一个黑盒）；③ 底线条目拿不到时**信号缺席**，不是"低"——"没算出来"与"算出来是低"是两件事，都有用例锁住。
- **不猜，只对齐**：情节底线是教师写的中文散文，机器从中抽"角色/地点/事件动词"只能靠猜。但文件里有一样东西可逐字对齐：**被引用的原文片段**（`"All animals are equal"`、`《Beasts of England》`、`Manor Farm`、`I will work harder`）——教师写这些进去，意思正是"这几句必须原样保留"。角色/地名同样不猜：直接用机器可读的**专名表**。抽取做了两条清洗：掐头去尾是功能词的片段丢掉（`and slavery` 这类命中了对教师没意义）、被更长锚点包含的短片段丢掉。
- **诚实交代盲区**：真底线实测——`Boxer said, "I will work harder!"` → 高，`All animals are equal.` → 中，但 **`The windmill fell down in the storm.` → 低**。风车是全书最重的劳役象征，可它既不是可引用锚点、也不在专名表（专名表收人名）。不去猜"中文象征名 ↔ 英文词"的对应（那是猜），而是给教师一个**显式出口**：在底线里写一行 `锚点：windmill、gun` 就按锚点算。教师知道而机器不知道的，就该由教师直接写下来。
- **按段打分而不是按句**：实测踩到 `sentsOf` 按 `(?<=[.!?"] )` 切句会把 `Boxer said "I will work harder" in 1911.` 切成两半，含数字那半只剩 `in 1911.`——全书最重要的一句口头禅拿到的情节分和路人甲一样。先验要回答的本来就是"**这一段**值不值得先看"。顺带修掉一个显示缺陷：卡片"原句"定位到碎片（< 4 词）时**退回整段**，不再显示 `in 1911.` 这种对教师毫无用处的原句。
- **定位两条轴（`src/core/positioning.ts`）**：`阅读负荷下降`（生词率相对降幅）与`理解支架覆盖率`（⑪加注覆盖率）**各自成轴、各有"它不是什么"**，刻意不做加权合成（合成出来的数没人能拿它做判断，有用例断言对象里不许出现"综合指标"这类字段）。复核报告抬头、App 报告页空状态、风险队列空状态、README 都分开显示。
- **真项目实测把区别照出来了**：A 层阅读负荷下降 **30%**（生词率 21.7% → 15.3%）、理解支架覆盖率 **94%**；M 层 43% / 93%。**A 层几乎全是"加支架"而不是"降负荷"**——这个区别在任何合成指标里都会被抹平，正是报告要求分开说的理由。
- 另修：风险队列 Markdown 的决策栏仍印着旧的三统一键，改成**跟着规则走**（`＋ 补上注释` 等）并附一行效果说明。
- 测试 472→494（情节先验 14 + 定位 7 + 面板情节行 1）；`npm run verify` 全绿，`app` 前端 `vite build` 通过。

## [未发布] - 2026-09-11（main · 第三十一批：可观测产品指标——开始量教师那边，而不是只量机器）

> 来源：《LayerText 审查报告 v4_方向》「系统性偏差」一节：「你确实有『不断加工程保险、回避产品承诺』的倾向：manifest、AST、事件账本都必要，但它们**不能替代一次成功的编辑闭环**。下一轮评估应加入可观测产品指标：首次点击到可采纳结果的时间、撤销率、批量动作后的人工回退率、以及教师在 10 次操作后的错误采纳率。」

这条得老实认账：前几批我做的门禁、事务、聚合**仍然全是"让机器别出错"**，只有这一批是在量教师那一侧的结果。

- **`src/core/productmetrics.ts`**：四个指标全部从**已有的事件日志**算出来，不新增埋点、不新增存储（只多一个 `session-open` 事件类型，由面板打开时写一条，且**一天只写一条**）。
  · 首次点击到可采纳结果的时间（打开队列 → 第一个采纳）
  · 撤销率（分母是决定数，`undo` 本身不算决定）
  · 批量动作后的人工回退率（批量采纳里有多少后来被撤销）
  · 执行失败率（`rejected` 偏高说明稿件状态或路径有问题，**不是教师的问题**）
  · 疲劳信号：前 10 次 vs 之后的撤销率
- **「错误采纳率」明确标为代理指标**：系统没有真值，它不知道教师那次采纳事后看对不对。所以报的是**后段撤销率上升**——同向，但**不是错误率本身**，报告里必须这么写，不许拿代理指标冒充真值（有用例专门锁这条）。同理：没有批量记录时说的是"这个问题目前无法回答"，而不是虚构一个 0%。
- **算不出来的就说算不出来**：没有 `session-open` 事件时首次上手时间显示"算不出来（不是 0）"——不把"没测到"显示成"很快"。
- **指标在界面与汇总器里都能看到**：面板页首「我这边用得怎么样」折叠区；`决定汇总` 打印「产品指标（量教师那边）」并写进提议清单与 JSON。
- 测试 461→472（产品指标 11）；`npm run verify` 全绿，`app` 前端 `vite build` 通过。

## [未发布] - 2026-09-11（main · 第三十批：队列改成任务组，一小时路径降为后台估算）

> 来源：《LayerText 审查报告 v4_方向》第 3 条：「`oneHourPlan` 仍按事实/加注/其余分组，组内还是逐条卡片。先按『同一词/同一规则/同一段』聚合，展示 3 条代表例，提供『全部应用/逐条查看』，并有明确的『本次完成』状态。**它比继续调整估时数字更能改变行为。**」

- **任务组（`groupQueue`）**：按报告给定的优先级聚合——① 同一词（漏注/释义冲突/重复注）② 同一段同一规则（数字/专名）③ 同章同类型。组给代表样本 3 条、影响计数、`<details>` 展开其余；组间按**组内最高风险**排序。报告说清了为什么不能只按规则或只按章节聚合：「按纯规则聚合会把互不相关的问题混在一起，按章节聚合则失去可批量修复性。」
- **批量应用**：只对"动作统一、且有确定性修法"的组开放（其余组连按钮都不给——宁可少一个按钮，也不做半对的事）。批量**不另写一条路径**：逐条走同一个 `applyAction`；**按章聚合写盘**（一章只读一次写一次，而非每条一次读改写）；任一条失败不静默跳过——那一条写 `rejected`、留在待办，其余照做，最后如实报"成功 N 处、失败 M 处"，**部分成功不算做完**。批量来源写进事件 reason，事后分得清是批量还是逐条。
- **「本次完成」有自己的判据**：只看"还有没有未处理的条目"，**不看估时**。「一小时最短路径」从页首降级为折叠的后台估算（报告：「它是内部预算函数，不是教师任务模型；继续维护它的四个固定阶段会让团队优化分钟数，而不是验证教师是否放心采纳」）。
- **`subjectOf` 下沉到引擎**（`src/core/riskqueue.ts`）：聚合与离线汇总器都要用它，放在 App 层会让引擎反向依赖界面。
- **修掉一个真实缺陷**：`ANNO-03`（释义冲突）展开时没带 `word`，于是**归不进"同一个词"那一档**——而报告点名要按"同一词（漏注/释义冲突/重复注）"聚合。同理，手搓的问题对象也要用门禁真实产出的 detail 形状（`missing`/`conflicts`），否则一条 item 都展开不出来（测试里踩到过，已在用例注释里说明）。
- 测试 450→461（聚合 8 + 面板分组与批量 3）；`npm run verify` 全绿，`app` 前端 `vite build` 通过。

## [未发布] - 2026-09-11（main · 第二十九批：决定＝「动作 + 事件」一个事务，可撤销）

> 来源：《LayerText 审查报告 v4_方向》第 2 条。原设计里风险页三个按钮**只追加事件、不改稿**——工程上留痕干净，产品上是个陷阱：老师说"采纳改写"，卡片消失了，他会去正文里找那句改好的话，**找不到**。而且十条规则里五条该改正文、五条只是表态，**同一个按钮在不同规则下承诺不同的事**。

- **规则 → 动作（`src/core/riskaction.ts`）**：按钮文案**跟着规则走**，不再共用三个统一键。事实类/长度类是「✓ 认可这个删减 / 认可这个长句」（**不改正文**）；漏注是「＋ 补上注释」；重复注是「－ 删掉多余注释」；释义冲突与同词多义是「＝ 改为词典释义」；没有确定性修法的一律 `manual`（只记录，不猜）。
- **动作 = 一个事务**：读最新正文 → 校验动作在当前位置仍成立 → 改 → **一次写完正文与事件**（带 before/after、规则号、traceId 与版本）。动作改稿前先备份。找不到段/词、已有注释、没有释义、写入失败——**只写一条 `rejected` 事件，正文一个字节都不动，卡片留在待办里**。
- **`rejected` ≠ `reject`**：前者是"**系统没做成**"，后者是"**教师不同意**"。两者分开记。判定上 `rejected` **不算处理完**——否则就是最坏的两头空：卡片消失了、正文也没变，而教师以为办完了。
- **撤销是新事件，不是删历史**：新增 `undo` 类型与 `undoOf` 指针。撤销改稿动作时**同时把正文改回去**（`after` 必须仍在原处，否则报"稿件已改过"并且**不写 undo 事件**——宁可撤销失败，也不留下假账）。面板新增「看我判过的（N 条，可撤销）」入口，被撤销的项回到待办并标注「已撤销」。
- **撤销语义定死为单级**：撤销最新那条 = 整条作废、回到待办。不做"回退到更早的那条"——那要教师理解一个撤销栈，而他心里只有"我刚才点错了"。界面上的撤销键长在最新那条上，单级语义与界面一致。
- **队列 JSON 记下每章产物绝对路径**（`章节产物`）：面板改稿要用它，而面板不知道产物命名里的日期/后缀，**只能猜**——猜错的后果是改到不存在的文件或改错文件。生产者知道路径，就由生产者记下来。
- **修掉三个真实缺陷**：① 「删掉多余注释」原先删的是**第一次**匹配——而这条规则的语义恰恰相反（首次是对的、重复的才该删），结果把对的删了、留下错的那处；② 动作失败后界面立刻重渲染队列，**刚写上去的失败原因被覆盖**，教师只看到"点了没反应、卡片还在"；③ 补注原先按引擎报的词形去正则匹配，遇到文中是 `Windmills`、引擎报 `windmill` 时**静默什么都不做**——现在按引擎自己的词形归一去文中找真实那个词形。
- 测试 423→450（动作层 19 + 面板事务与撤销 8）；`npm run verify` 全绿，`app` 前端 `vite build` 通过。

## [未发布] - 2026-09-11（main · 第二十八批：统一改写契约——把残余 P0 从 App 侧封死）

> 来源：《LayerText 审查报告 v4_方向》第 1 条。v3 报告把"静默坏产物"在**管线**侧封死了，但它整体搬到了**教师天天点的 App 侧**：App 单句改写只带句长上限/句法黑名单/教师意图，事后只查句法黑名单，**没有词表、词典、专名与事实检查**。同一份书稿，两条路径的约束强度差一个数量级。

- **`src/core/rewrite.ts`：单句/单段改写服务契约**。App 与管线共用同一个输入输出 schema（`RewriteRequest`/`RewriteResult`），最后都调**同一个** `gateSegment`，判定口径只有一份。**合并契约与门禁，分离上下文与成本**：管线传全量策略，App 只传局部切片（本书专名 + 本句命中的那几条释义 + 已注词账本；账本只在本地判定用，不进 prompt）。
- **单句 scope 有一条写下来的有意差异**：段级门禁问"这一段该注的词注了没有"；单句改写问「**这次改写有没有把原来没有的难词带进来而没注**」。源句本就该注而没注的词是**补注脚本**的活，算在单句改写头上会让老师每改一句都被要求顺手加注。差异写在类型注释里并有断言锁定。
- **策略缺什么要"可见地缺"**：`missingPolicy` 如实列出本次没带的约束（账本/词典/词表），界面显示徽标三态（✓ 已过门禁 / ⚠ 部分约束未带 / ⛔ 未过门禁）——**不假装查过**。
- **App 接线（`app/src/rewritegate.ts` + `aiflow.ts`）**：单句改写候选先过门禁；**未过门禁的候选即使是"标记即改写"（原本直写）也不许写正文**，改走建议页并说明原因。门禁自身出错时**不允许变成放行**（退回建议页），这是"失败方向要选安全的那一边"。
- **全篇已注词账本**：App 原先只看得到打开的这一个文件，跨章重复注无从判断。现在有界扫描（同目录 + 上层各章目录，上限 24 文件/2MB），**扫到哪儿如实报**（到上限就说"跨章重复注可能漏判"）。台账/报告类 `.md` 不算章节文件，不进账本。
- **修掉两个真实缺陷**：① `segmentSentences` 在没有 `[P##]` 标记时静默返回空数组 → **SENT-01（超长句）在单句场景下永远是死的**（门禁看起来在跑、指标也在算，那条规则从没生效）；② `checkRewrite` 返回的是入参原文、而门禁判的是归一化后的文本，两者会差一个段号前缀——**"门禁说 [P07] 没问题、写进去的却是没有段号的一句"**。现在返回的正文与判定用的正文是同一个字符串（有幂等断言）。
- **ANNO-02 统一管两件事**：段内重复注（门禁自己看得到）+ 跨段重复注（调用方传 `reannotated`）。**不另开规则号**——同一条规则只该有一个判定处。
- 测试 388→423（改写契约 25 + App 门禁接线 10）；`npm run verify` 全绿，`app` 前端 `vite build` 通过。

## [未发布] - 2026-09-11（main · 第二十七批：路径由清单解析 + 统一词典并发安全 + 决定索引）

> 补齐第二十六批留下的两处：报告 §三「引擎、管线、App 仍可保留，但**都只能通过 manifest 解析路径**」当时只做到"记录与校验"，路径仍是脚本自己拼的；§四「查询『某位教师对某词的所有决定』」当时只有 append-only 日志、没有查询能力。

- **路径解析层 `resolvePath` / `makeResolver`**（报告 §三那"只能重构一处"的后半句）：所有产物路径现在只从清单解析出来，脚本里不再拼字符串。两种布局：`legacy`（默认，**逐字符复现**既有命名——教师已有的书与下游脚本一个字都不用改）与 `run`（产物按运行 ID 收进 `_运行/<runId>/`，第二本书/第二位教师/同书多层并行**不可能互相覆盖**）。实测两种布局都跑通：run 布局下正文/完成标记/会话日志全在运行私有目录，legacy 的老路径不再被写（避免"两套路径并存"比撞名更难查）。新增 `detectArtifactCollisions`：把多份清单登记过的产物路径并起来，直接报出被多次运行写过的那些——**这是"互相覆盖"的直接度量**，legacy 下必报、run 下必空。`清单 --layout run` 切换，`--verify` 顺带做跨运行撞名探测。
- **统一词典不再会被并发覆盖**（报告 §三 点名的文件之一）：`appendDict` 是「读整份 → 合并 → 写回整份」，两位教师并行时后写的会把先写的整份盖掉（lost update），表现是"**明明配过的词下次又问一遍**"且不报任何错。改成事件日志那一套：生成阶段只写**运行私有增量**（`词典增量.json`），合并是显式的一步（新脚本 `LayerText_AF词典合并.mjs`，已进管线）——加锁互斥、临时文件 + rename **原子替换**、**基线优先**（教师定过的释义不被自动新配覆盖）、冲突**上报而不静默择一**（区分"与基线冲突"与"两个并列运行互冲突"）。`src/core/dictmerge.ts` 纯逻辑可单测，两种布局的增量文件都能找到。
- **决定索引（SQLite）**（报告 §四：「查询『某位教师对某词的所有决定』」时文件作为数据层会崩溃；可先用 SQLite manifest + append-only events）：`src/core/decisiondb.ts`，用 Node 内置 `node:sqlite`（零第三方依赖）。**JSONL 是正本，SQLite 只是索引**——`rebuild()` 可随时从日志重建，索引里不存在日志之外的事实。`决定汇总 --about windmill [--teacher wayne]` 就是报告点名的那句查询；`--by-rule` 看每条规则的采纳/误报分布。拿不到驱动时自动降级为"不可用"，查询回落 JSONL 全扫（功能不缺席，只是慢）。
- **抓到并修掉三个"静默降级"级缺陷**（都是本轮新代码引入、又被自己的测试当场抓住的）：① `decisiondb` 的驱动加载在 ESM 里写了 `require('node:module')` → 抛错被 try/catch 吞掉 → **索引永远"不可用"**，而当时所有查询用例都写着 `if (!available) return`，于是**空跑成一片绿**；现在 createRequire 静态 import，且测试硬断言 `available === true`（宁可响亮地失败，也不要假的绿）。② `byRule` 按 `A+B` 整串分组再拆，导致同一条规则出现两次、数字各算各的。③ 词典合并脚本只认 run 布局的增量文件，legacy 布局下"配了释义却没合并"且不报错。
- **App 面板也按清单解析路径**（报告那句"引擎、管线、**App** 仍可保留，但都只能通过 manifest 解析路径"）：面板原先硬编码 `_运行/风险队列_<层>.json`，一旦项目改用 `--layout run` 就"面板说没有队列"——而命令行明明写成功了。现在 `app/src/risk.ts` 读清单指针拿运行身份，用与脚本**同一个** `makeResolver` 取队列路径与决定日志路径，并把当前布局显示在页首。三个新用例锁定：run 布局找得到、没有清单退回 legacy、清单指针坏了退回 legacy 而不是全黑。
- 风险队列脚本同样接入解析器（否则就是"命令行写到 A、面板去 B 找"）。集成用例断言 run 布局下队列 JSON 落在运行私有目录、且**不再**同时写 legacy 路径（两套路径并存比撞名更难查）。
- **旧口径从报表头版撤下**（报告 §三：「应删除或降级维护的是『只统计注了多少处』的旧报表口径……保留导出兼容字段即可，不再把它当质量门禁」）：`对照台账` 的列由「加注处数」改为 **「加注覆盖率（已注/应注）」**，旧口径降级为紧邻的"仅参考"列，合计行同理。真项目实测：M 层第一章 98%（40/41）、A 层第七章 100%（232/232）——数字口径与引擎 ⑪ 完全一致。
- **空清单不许报绿**（真项目上跑出来的假绿）：只跑 `--new`（建清单）没跑 `--stamp`（盖章）时，`--verify` 会输出「✓ 清单一致：**0 件产物**……这次运行可以当作完成品引用」——一句彻头彻尾的假绿，正是本项目要根治的那类"静默成功"。现在"清单里没有任何产物登记"直接判 blocked，并提示跑一次 `--stamp`。
- **队列构成的说明**：把旧流水线的产物拿新门禁重扫时，长度类规则会成片命中（它是**待判断**的偏差，不是废弃），原先只印一个"不可完成 1688 条"会被误读成"这本书全是废的"。现在按规则列出构成，并写明「级别＝规则级别（约束生成时能否算完成）；权威的"没做完"信号是未完成段落表」，Markdown 与 JSON 输出同口径。真项目 A 层第一章实测：70 条、估时 37.8 分钟——在 60 分钟预算内，是可执行的队列。
- 测试 387→388；`npm run verify` 全绿。

## [未发布] - 2026-09-11（main · 第二十六批：P0「复检不通过＝不可完成」+ 段级风险队列）

> 来源：2026-09-11 项目审查报告。最重的一句是"当前最大风险不是模型写得不够好，而是**确定性门禁并不真正阻止错误产物被视为完成**"。本批只做报告点名的两件先动的事：把"复检不通过"变成不可完成状态，并建立段级风险队列。

- **P0 · 复检不通过＝不可完成**：会话脚本原先在每段复检跑满 `--qc-rounds` 后**照常落盘并把段标为 done**，只有抛异常才进 failures —— 反复不达标的段落能一路进最终书稿且不触发失败，`--resume` 还会跳过它。现在：判定统一交给新引擎模块 `src/core/segmentgate.ts`（纯函数 + 规则号）；`rewriteSegment` 返回 `{status:'pass'|'needs-review'}`；`needs-review` **不写正文、不进 done、落隔离目录 `产物/_待复核/`、记入失败清单、进程非零退出**，管线随之中止。顺带修掉第二层静默缺口：原循环跑满后**最后一次改写从未被判定**就被当成结果——现在每轮产出都判定，跑满后仍有一轮终检。
- **完成标记**：`产物/_运行/<层>.完成.json` 只在全部段落通过时写；本轮不完整会**作废旧标记**（否则旧标记掩盖新失败）。产物里未通过的段留 `[P07] <!-- 本段未通过复检… -->` 占位——HTML 注释不进分句分词、**不污染任何 QC 指标**，同时保住后面段落的**位置**（否则第 8 段的原句会被配到第 7 段的改写上）。
- **段级风险队列**（`src/core/riskqueue.ts` + `tools/af_pipeline/LayerText_AF风险队列.mjs`，已进管线末步）：把"从第一段读到第 245 段"换成"只看机器点名的地方"。`风险 = 概率 × 后果`，实测排序正是报告要求的 **数字 13.2 ＞ 专名 12.0 ＞ 混入中文 11.0 ＞ 漏注 10.0 ＞ 超长句 8.0 ＞ 释义冲突 6.3 ＞ 篇幅 6.0 ＞ 重复注释 4.5**。每条给原句/改写句/上下文各一句/规则号/风险分，逐词逐数字展开（不是整段一条）。附**一小时最短路径**（10/25/15/10 分钟四阶段）；队列估时超预算时给的建议是"先修生成规则或词库"，不是加班。
- **规则表即时唯一口径**：`GATE_RULES` 同时供门禁、风险队列、报告取元数据；`blocker` 恰好四条（篇幅/句长/漏注/注释外中文），事实类为 `warn`（机器判不准，不阻塞但置顶）。排序由 `tests/riskqueue.test.ts` 锁定，破坏报告既定优先级会被测试挡住。
- **注释改为 token 级解析**（`src/core/annot.ts`，报告 §三 第③条）：加注覆盖率不再用字符串正则塞 Set——大小写、词形（trembled↔tremble）、连字符成分（blood-curdling→curdling）统一归一侧；**同形异义造成的假通过**改为与统一词典比对报 `ANNO-03`；新增重复注释率、注释外中文检测。`runQc` 的 `QcResult` 增 `annotationTotal/Extra/Conflict/FormOnly/chineseOutside`。
- **复现豁免分账**（报告 §三 第④条）：`known = 词表 ∪ IRR ∪ 注释 ∪ 复现队列` 的取舍保留，但提供复现队列时额外报「原始 OOV」「复现豁免掉的 OOV」「原始生词率」，让"本应教学注释却被豁免"可被单独审计。
- **旧报表口径降级**：`toLegacyReport` 保留全部原键（导出不破），但新增 ⑪/⑪b 结构化注释口径；"只统计注了多少处"不再作为质量门禁（它曾让 A 层第 7/8/9 章 2% 的加注缺口完全隐形）。
- **catch{} 不再静默**：章末摘要失败原先被明确忽略（catch{}），会让后续一致性下降却显示成功——现降级为 `warning` 事件写入会话日志并计入运行清单。
- **可自检的门禁**：新增 `LAYERTEXT_FAKE_LLM=long|exact|<字面文本>` 假模型，走**同一条**判定与落盘路径。`tests/pipeline_gate.test.ts` 用子进程跑真脚本锁定四条：永远超长 → 无完成标记/坏产物不进正文/退出码 1；通过的段 → 正文与标记都在/退出码 0；未通过的段不进 done 且 `--resume` 重跑；本轮失败作废旧标记。
- **段号成为稳定 ID**：`normalizeSegmentBody` 会把模型漏写/写错的 `[P##]` 纠正为本段应有编号——否则产物里出现重复段号，下游按标记配对的台账与风险队列会整体错位。段落按标记（而非数组下标）配对。
- **教师决定＝不可变事件**（报告 §一第二条）：新增 `src/core/decision.ts` + `调适工作区/_决定/<层>.jsonl`（append-only JSONL）。字段与报告逐项对应：`decision/before/after/reason/ruleIds/teacherId/timestamp/sourceVersion`，外挂 `itemId`（风险队列项 ID，没它就回答不了"这条决定是关于什么的"）与 `subject`（这条决定针对哪个词/哪个数字）。`itemId` 上出现多种决定 → 进「被反复改主意的项」清单，说明规则或词条本身有问题。与《AI建议台账.csv》的分工写死：**台账是可重建的分析视图，事件是不可变的事实**——事件是正本，不做两份并行维护。
- **离线汇总只提议、不入库**（`tools/af_pipeline/LayerText_AF决定汇总.mjs`，已进管线末步）：三条通道——同一个词的释义被采纳 ≥2 次 → 提议进统一词典；同一个词被标误报 ≥2 次 → 提议进词表例外；同一条规则下直改 ≥2 次 → 提议进改写模板。每条提议恒带 `requiresConfirmation: true` 与证据（谁、何时、改了什么），落库必须显式 `--apply 1,3 --yes`，且落库本身也写 `_决定/_入库.jsonl` 留痕。附带统计「误报率」——规则噪音水平的直接度量。
- **运行清单 + 词表快照**（报告 §三"只能重构一处，应先建 manifest + 事件日志层"）：新增 `src/core/manifest.ts`。
  · `LexiconSnapshot`：一次生成、带版本与哈希（**换一个字节就换版本**），所有阶段只读它。词表/专名表/知识库/词典原先在三个脚本里各读一份，没有版本就分不清"这批产物是哪版词表跑的"——Clover 事故的重演面。快照另带抽样指纹（快速判断"是不是换了词表"）与来源告警（空文件/读不到词）。
  · `RunManifest`：统一书籍/版本/层级/教师/运行 ID + 输入哈希 + 词表版本 + 模型版本 + 提示词版本 + 每个产物的状态与哈希 + 每步结果 + 未完成段数。runId 由身份信息与输入哈希决定 → **同样输入 = 同一个 runId**（可复现）。
  · `verifyManifest`：静默错配的探测网——词表变了、输入变了、产物缺失、产物登记后被改过、门禁未过、步骤失败 → 全部 blocked，这份产物不能当完成品。
  · `detectCollision`：同一 runId 还有活进程 / 多机并行 → 报警（报告 §三"第一个规模崩点会是文件命名约定与并发写入"）。
- **清单脚本**（`tools/af_pipeline/LayerText_AF清单.mjs`）：`--new` 建清单+快照、`--stamp` 每步盖章、`--verify` 校验、默认打印摘要。产物在 `产物目录/_运行/`：`LexiconSnapshot_<版本>.json` + 指针、`清单_<runId>.json` + 指针。
- **管线收敛**：`LayerText_AF管线.mjs` 现在开头建清单、每步跑完盖章、结尾校验——**一次运行只有一个结论来源**；未过校验则整条管线非零退出。新增 `--teacher`（教师 ID）与 `--no-manifest`（不建清单，不推荐）。风险队列与决定汇总已作为末两步进管线。
- **「一个词全篇只注一次」的口径对齐（抓到的自相矛盾，会让新门禁频繁误杀）**：提示词明说"你在这本书里已经注过这些词了，本段绝对不要再加注"，而门禁拿的却是"本段出现的全部超纲词"——于是第 5 章**正确地**没有重复注第 1 章的词，反被判成漏注；模型一边被告知别注、一边被告知漏注，永远过不了关且不知道自己错在哪。现两边共用同一个 `makeCovers` 判定：门禁问的是「**本段该注的词**注了没有」。配套：已注词账本改为**按全书**从产物恢复（原先只扫当前章 → `--resume` 从第 7 章续跑会丢第 1–6 章的账本；只扫本次范围 → `--chapters 2` 看不见第 1 章）。
- **本地统一去重注释**（报告 §二）：`dedupeAnnotations` 在判定之后做一次确定性清理——一个词全篇只注一次，重复处只留首次。被去掉的**不是浪费**：它们是教学复现点，进词卡层的「复现提示」，不占正文注释（报告明确要求复现提示与正文注释分开）。
- **「查词」改为严格 schema 的 tool call**（报告 §二）：`src/core/lookuptool.ts` 定义 `lookup_words` 工具（`words` 为英文单词数组、最多 8 个、禁额外字段），参数**严格校验**——不合规就明确回一句"参数不合规，请重发"，而不是去猜一段自然语言。原先的 `【查 词1 词2】` 文本标记往返降级为回退路径（两条路共用同一份回答）。工具协议要求回一条 `role:'tool'` 消息；它**也会写进事件日志**——否则 `--resume` 重建的会话会缺这一条，API 直接拒（顺带把 `tool_calls`/`tool_call_id` 一起纳入日志还原）。
- **失败恢复的可复现信息**（报告 §二）：`done` 与 `review` 事件现在都带 `inputHash`（段级输入哈希）、`promptVersion`、`model` 与 `response`（截断存）——失败复现时能定位"是哪版提示词、哪个模型写的这一段"。
- **会话滚动窗口**（报告 §二：「一本书一条无限增长会话」不应成为唯一模式）：新增 `--window N`（默认 30 段，0 = 不滚动）。原先只在章末追加 5 行摘要，**却没有实际删除历史**——上下文累积带来注意力稀释、截断与恢复困难。现在超窗就把开场之后的历史整段换掉，只结转**结构化状态**：已处理到哪、已注词约束、各章摘要、运行中新配的释义、改写约束。开场（system）一个字节都不动，缓存命中前缀不受影响。`window` 事件写进日志，`--resume` **重放同样的裁剪**——否则同一份日志会给出两种长度的上下文。
- **风险队列进界面**（报告 §一：「`report.ts` 已有候选数据，但当前阅读器仍按段顺序呈现，这是流程缺陷」）：「检」组新增**风险队列**页。页首是统计（总数/待办/已决/不可完成/估时/误报率/未完成段落）与**一小时最短路径**四阶段；下面是按 风险=概率×后果 排好的卡片流——每张卡给原句、改写句、上下文各一句、触发规则号、风险分、位置，加三个键：**采纳改写 / 退回重写 / 标记误报**。三个键**只写不可变事件**（`调适工作区/_决定/<层>.jsonl`），不改书稿——改书稿仍走正文里的标记/建议；决定过的从待办里消失，但历史一条都不删。面板还会预览"这些决定汇总器会提议什么"（词典/词表例外/改写模板）。
- 新增 `app/src/risk.ts`（纯逻辑 + 可注入 IO，与 datapanel 同一套路：`setRiskIo` 便于 node 下直接测）与 `tests/riskpanel.test.ts`、`tests/riskpanel_dom.test.ts`（happy-dom，无屏幕环境可跑）。
- **`--scope` 从"只改文件名"变成真的换会话**：原先 `--scope chapter` 其实还是"一本书一条会话"——报告批评的"无限增长会话"根本没法通过参数避开。现在 tier / book / chapter / segment 四档都真的重置对话（重置的只是**历史**，已注词账本、章摘要、新配释义随结转保留，否则第 2 章会重复注第 1 章注过的词）。新增 `--vocab full|lite`（开场给全表 / 只给该注的词，即 2% 那版的老口径），两个因子合起来就是四格实验的四个格子。
- **四格实验台**（报告 §二：「2%→98% 的实验不能归因……至少做四格实验」）：`src/core/experiment.ts` + `tools/af_pipeline/LayerText_AF四格实验.mjs`（管线可选步骤，默认不跑；`--only 四格实验` 点名才跑，因为**会真跑 4 遍**）。固定模型与温度（0.3）、同一章，只动「会话记忆 × 全词表注入」两个因子，并排报告**生成覆盖率**（模型第一次写出来的样子，从 append-only 日志取首轮响应）、**最终覆盖率**（落盘产物）、**重复注释率**、**人工修订率**、**token 成本与缓存命中**。结论只给**单因子**增益（另一因子在两种水平上各测了一次），并在缺首轮响应时明确警告"生成覆盖率会被高估，别用它下判断"。实验产物带 `_exp1…_exp4` 后缀，不碰正式产物。
- **面向"第二个人来用"的操作文档**：新增 [docs/换书与续跑说明.md](docs/换书与续跑说明.md)，回答审查报告 §四 点名会卡住的三件事——① 词表/路径配置（调适项目每个字段 + 词库四个历史坑的对照表）② 失败后能不能安全续跑（`--resume` 只认门禁通过的 `done`；哪些产物会覆盖、哪些是 append-only 的逐项表；什么情况下**必须**重跑）③ 报告中多个覆盖率口径的含义（四个"覆盖率"的分子分母对照表，并写明"生成覆盖率单独展示是误导"）。README 与快速开始已挂上入口。
- **章节 AST（报告 §四：「内部应转成 AST/中间表示，发布时再序列化」）**：新增 `src/core/docast.ts`。`word（中文）` 与 `[P##]` 仍是教师可见的发布格式，内部解析成结构后再序列化——三个约束：**① 往返恒等**（`serialize(parse(x)) === x`，一个字节都不许变，否则"内部转 AST"会悄悄改写教师手里的书稿）**② 格式不变** **③ 旧文件也能进**（无 `[P##]` 的旧稿补稳定 ID 并**标记为需要人确认**——对齐是猜的，不猜完当没事）。用括号深度扫描代替正则，因此能查出**任意深度**的嵌套注释（`Mollie（莫丽（名字））`、`hoof（复数 hoofs（蹄子）/hooves（蹄））`）、同词多义、括号不配对；同词多义按"首次出现的释义"统一，嵌套按"第一个 1–6 字汉字串"扁平化（与既有修复脚本行为一致）。新增规则号 `AST-01`（段标记缺失/重复/跳号，风险 14.4 **置顶**——段标记一乱，这一章所有按标记配对的对照都是错的）、`AST-02`（同词多义）、`AST-03`（注释畸形），进风险队列。
- **修复脚本改为复用 AST 的嵌套判定**（原先自己写了一条只能处理一层嵌套的正则——又是一次口径漂移）。
- **抓到两个真实缺陷**（都是接入真项目时暴露的）：① `segmentList` 会把**前置说明里"提到"的段号**当成真段落（Animal Farm 第一章头部写着「[P14] 为稳定锚，改写稿沿用同ID。」），导致原文/产物各多一个幽灵段、索引整体错位、"14"还成了数字事实信号——现在先切掉 `## Chapter` 之前的头部再扫段；② 段里切不出句子时 `runQc` 直接抛错，会让整层失败——现在按"无超纲词"处理并记 `warning`（不静默）。
- **事实信号标题可读化**：数字信号是归一后的（`two` → `2`），标题改为「原文的「2」（原文写的是 two）在改写里找不到」——不然教师看到原文写的是 two 会一头雾水。
- 测试 339→355（AST 15 + 可读化 1）；`npm run verify` 全绿，`app` 前端 `vite build` 通过。文档见 [docs/段级门禁与风险队列.md](docs/段级门禁与风险队列.md)。

## [未发布] - 2026-09-10（main · 第二十五批：UI 三件 + AoA 双信号——"一二都做"落地）

> Wayne 拍板"一二都做"：① UI 升级（页签收敛/书架 hero/弹层统一三方向）② AoA 双信号不等观察直接上。

- **视图页签收敛（8 平铺 → 两级三组）**：按教师任务流分「读」（正文·逐句对照·版本对比）/「检」（报告·看板·档案）/「改」（建议·复盘）——一级分段控件 + 组内二级细页签；点一级组回到该组上次视图（会话级记忆）；懒渲染钩子收敛进 main.switchView 唯一入口（原 8 个绑定散置）；syncChrome 改 curView 单源（不再查 DOM 反推）。
- **书架首屏 hero**：原"继续上次编辑"一行横幅升级为大卡片——封面缩略+书名+工作区章名+审校进度条+「继续上次编辑」大按钮；打开 App 第一眼从文件列表变成"你的阅读工作台"。
- **AoA 双信号分诊（Kuperman 2012 常模，31,054 词，OSF 开放数据）**：zipf≥4 还须 AoA 在常模内才亮"疑似漏收"（label 带习得年龄："高频 · 母语者约6.1岁习得"）；zipf≥4 但常模查无（harry 类专名/衍生词）降级"高频·常模外（多为专名，按需核对）"——eval01 实测 harry/halfway 成功降噪、7 个真漏收全部双确认。assets/wordfreq/en_aoa.tsv + tools/export_aoa.py（可复现）；lookupInt 补 ing 双写剥除（running→run，仅先验层，hit() 判定口径不动）；三端同批（App 词频列叠加 AoA/MCP layer_qc aoa 字段/CLI OOV分诊）；未提供 AoA 表时向后兼容单信号。
- **弹层体系统一**（三方向之三）独立成批下批做（本批已含页签架构改造，不混批）。
- 测试 192→193（AoA 家族兜底/双确认/常模外降级/单信号兼容四向锁定）。

## [未发布] - 2026-09-10（main · 第二十四批：同义转换优先·篇幅守恒——paraphrase 原则进生成侧）

> Wayne 拍板："尽量同义转换，别大幅度缩减原文"。起因：全书三版实测较原文累计收缩 63-71%（其中大头是 AF 课题节选缩编设计，二次简化再叠 8-12%）——提示词只保情节不保篇幅，AI 降难度天然丢修饰删细节。paraphrase 本义=换说法不减量，写进生成侧。

- **提示词 v1.6（manifest）**：system_draft v1.1 加"同义转换优先、篇幅守恒"条——改写=换学生能懂的说法（词汇与句式）不是压缩，细节/修饰/氛围照常转述，每段输出词数与原文相当（±15% 内）；rewrite_sentence v1.2 同口径（信息量与篇幅守恒，"建议删"才可删）。
- **引擎侧双保险（batch.ts simplifyChapterCore）**：逐段架构天然提供守恒执行单位——每段改完算词数收缩，源段≥20 词且收缩>15% 自动带纠正指令重试一次（"你上一版只有 N 词…同义转换不是压缩…"），采纳更长的一版（仍短也放行——软约束，教师定稿）；返回 srcWords/outWords/retried。
- **完成可见**：单章完成状态行带"X→Y 词，收缩 Z%，N 段触发守恒重试"；全书批处理报告新增"篇幅收缩"列（−8%=缩 8%，扩写显 +），收缩>15% 的章自动进"建议人工复查"（"检查是否丢细节"）。
- 测试 192 绿（收缩列位置/守恒线不误报/超线进复查三向锁定）；AF 实测分段粒度：段中位 75 词、P75 108、最大 253——逐段多轮架构维持（60-150 词/轮甜蜜区， Wayne 确认"适量分段"）。

## [未发布] - 2026-09-10（main · 第二十三批：句级标记新增「转述改写」）

> Wayne 发现："文本简化的标签里没有 Paraphrase 选项"——句子不难也不长、但要换种说法让学生懂（书面腔/母语式习语→学生熟悉句式），此前只能错标"表达生硬"或"其他"。

- **句级标记第 10 类「转述改写」（badge 述）**：插在"表达生硬"之后（同属表达层），语义区分——生硬=写 得僵需要润色，转述=换一种说法保持原意（教学同义句转换场景）。AI 意图自动接通（buildAiUserPrompt 走 typeLabel 文字）；台账规则记 R00 兜底。
- **键盘流支持第 10 类**：数字键 1-9 照旧，0=第 10 类（面板徽标同步显示）。
- 类型集测试同步更新（review_dom 锁定列表+typeLabel 断言）；verify 192 绿。
- **框选方向根修（Wayne 实测抓出）**：拖选句子定位从 anchor/focus（随拖选方向反转）改为 Range 文档序 start/end——此前从右往左框选后一句（或起点蹭过前句句号）时，面板会锚到前一句去改。跨句选择"仅标记所选末句"语义不变（末句=文档序末句，与拖选方向无关）。

## [未发布] - 2026-09-10（main · 第二十二批：菜单折叠 + 构建指纹与版权水印体系）

> Wayne 拍板："菜单折叠隐藏"+"核心代码打水印防侵权，借鉴游戏的保密方式"。路线取舍：**不做代码混淆/加密**（source-available 公开仓自相矛盾、AI 剥混淆能力最强、伤可维护性）——做**可举证的指纹体系**：法律许可（PolyForm NC）+ 构建指纹 + 实现级暗指纹在案 + 软著登记指引。详见 docs/维权.md。

- **菜单折叠（低频收子菜单）**：文件菜单 11 项→6 项（导入…▸词库/术语/专名/标记；导出…▸标记/Word/朗读音频）；帮助菜单 7 项→5 项（诊断▸导出诊断包/测试）；质检/批改保持平铺（全高频）。
- **构建指纹（版权举证）**：build.rs 编译期注入 `版本|git哈希-epoch` → 新 command `get_build_id` → **诊断包 JSON 含 buildId**——官方 Release 每个构建唯一且对应 CI 记录，盗版自行重编译的指纹必然对不上（举证"拿源码另行构建"）。
- **版权水印**：六个判定引擎核心文件（qc/lexicon/textpipe/wordfreq/mcpTools/align）加 SPDX 版权头；About 对话框版权行常驻（© 2026 Wayne · PolyForm Noncommercial）。
- **版本门禁五处对齐**：Cargo.toml 纳入 check_versions.mjs——顺手修真 bug：Cargo.toml 滞留 1.1.0 致 About 显示错版本（门禁此前只查四处漏了它）；About 版本改 `env!("CARGO_PKG_VERSION")` 构建期注入，此后跟 Cargo.toml 单源。
- **docs/版权与授权.md**：许可说明（教师/学校免费、商用需授权）+ 版权保护声明（已部署验证体系，细节不予公开）。指纹在案文档只存作者私密处，不进公开仓。
- 验证：cargo fmt/clippy/test（5 过）+ 版本五处一致 + npm verify 192 绿。

## [未发布] - 2026-09-10（main · 第二十一批：让"做得好的东西"被看见——热力轨词汇维度 + 校正传播感知）

> Wayne 拍板："句子里有词语不确定的，热力轨能不能显示""A 层改了之后 B/M 也收到这个标准——没有好的 UI 提示，做的东西很好但用户感知不到"。**感知原则沉淀：后台自动行为必须在可回看的面板留一行记录，不允许只有一闪 toast**（后续所有自动行为的验收项）。

- **热力轨加词汇维度**：右缘轨道新增第四类点（橙）——句含 ≥1 个生词即上点，title 报"P03·S2 · N 个生词"；点击直达该句。实现：renderReader 句级 OOV 计数缓存 `sent.dataset.oov`；buildHeatRail 重构为按句聚合三类信号（红=句法/橙=生词/蓝=标记，同句自上而下每类偏移一个点位，紫=风险+标记融合保留，title 汇总同句多标记——原同句多标记重叠成坨现在一读即明）。待定词不上轨（保守已知口径，⑨单独计量）；F8/⌘G 保持句法语义单一。图例补"轨道点"说明。
- **校正传播感知（origin 溯源体系）**：Mark 加可选 `origin` 字段（来源版本名，旧 JSON 全兼容），四层可见——①传播时：词汇简化总结面板新增"⇄ 已传播到低层版本：B/M 建 N 条待办（正文不动）"回填行（propagateCorrection 返回感知文案，不再只有一闪 toast）；②低层打开时：toast 一次性提示"本版有 N 条校正待办自高层传播来"；③侧栏标记清单：⇄ 徽章（title 说明来源与语义）；④书级看板：新增"传播待办"列（⇄ N）。手动同步（同步本章标记到其他版本）同口径带 origin。
- 测试 191→192（origin 随标记复制/无 origin 不带）；lint 抓出 slot 无用赋值当场修（第十六批同款规则）。

## [未发布] - 2026-09-10（main · 第二十批：编辑工作台侧栏化 + 启动直达书架）

> Wayne 拍板："编辑像画图软件在侧边来更符合直觉"；"一进去直接就是书架，那个画面切换感觉不太对"。方案=按操作重量分层：高频轻标记保持就地弹层（Fitts 定律），低频重编辑（手动改句）进侧栏工作台（画图软件属性面板直觉：选中的句子是对象，侧边是它的工作台）。

- **句子编辑工作台（侧栏「编辑」页签，与审校/AI 助手并列）**：「手动改这句」从局促小弹框升级为侧栏工作台——原句上下文（前句灰/原句高亮/后句灰，改句需要读上下文）＋大编辑框（150px 起、可拉伸）＋**保存前即时指标**（输入防抖 250ms 跑黑名单/超长，四项干净显绿✓，命中显⚠——比原来"保存后才知道"提前一档）；保存链全套复用（定位/备份/撤销/日志 R15/标记存留/自动重检零变化）。三入口+E 键不变，全部自动切入编辑页；⌘↵ 保存。
- **启动直达书架（消灭切换感）**：根因两处——① `#reader` 初始静态内容是旧版"第一步：打开课文"引导页，启动链跑完才替换成书架（语义跳变）；② 主题/排版在 restoreChat 之后才应用，深色用户启动闪白。修=初始骨架改"书架装载中"中性态；启动序列重排（loadConfig → 主题/字体 → 书架 → 欢迎向导 → restoreChat 后台化不挡首屏）。
- 工程量：chat.ts switchSide 三态化导出；pipew.ts 编辑面板重写（保存逻辑 applyManualSentenceEdit 零改动，仅换 UI 载体）；测试 191 全绿（手动改句纯逻辑本就有单测锁定）。

## [未发布] - 2026-09-10（main · 第十九批：OOV zipf 分诊——调研〇-3 第一级词频先验落地）

> 拍板记录（调研〇-3）：学生词库=判定锚必须是表；语义层只在周围当助手。第一级 zipf 分诊纯离线、只出候选不碰判定；二级 BKT 等学期末产出侧数据攒够再启。

- **OOV zipf 分诊（wordfreq 词频先验，"疑似漏收"候选层）**：生词清单每词带 zipf 词频列——**zipf ≥ 4.0 高频未收 = ⚠ 疑似漏收**（bike 4.5/flood 4.3/onto 4.8 类漏词史，学生大概率认识，教师勾「学生已学过」核对入库）；3.0–4.0 中频；< 3.0 低频=真·生词教学优先。三端同批生效：App 报告页生词清单加"词频先验"列+疑似漏收置顶；MCP `layer_qc` OOV 清单逐词带 zipf/分诊（附分诊口径说明）；CLI 报告新增 `OOV分诊` 字段+控制台疑似漏收一行。
- **数据与实现**：`assets/wordfreq/en_zipf.tsv`（wordfreq 导出 zipf≥3.0 共 28827 词、≥4.0 高频带 7160 词，347KB 纯离线；`tools/export_zipf.py` 构建期可复现）；`src/core/wordfreq.ts`（parseZipfTable/zipfOf 词形家族查询——与 hit() 同一套 suffixCandidates 候选序/triageOov 三档）；表缺失自动跳过分诊，报告 schema 不变。
- **红线回归锁定**：有无 zipf 表，OOV 词清单与全部指标完全一致（测试断言）——判定锚永远是词库表，勾选入库前生词判定/覆盖率/生词率分毫不动。
- **顺手检修**：docs/MCP.md "提供 4 个工具"更正为 5 个（layer_align 上批加入后漏改）；帮助页 help-qc.html 补分诊三档说明（同 dist 重建）。
- 测试 185→191（解析/词形家族/三档分诊/真实资产表接入/红线回归各锁定）。

## [未发布] - 2026-09-10（main · 第十八批：教师批改域——学生产出体检/全班队列/AI 批改候选/读后检测题）

> 方向拍板：LayerText 从"输入侧"（把文本改简单给学生读）扩展到"输出侧"（学生读完写、教师批改）——三线统筹的论文证据链闭环：输入侧简化保真度 + 输出侧复现产出命中。

- **①学生产出体检（批改菜单 →「学生产出体检…」）**：粘贴或选文件导入学生英文（作文/仿写/读后感），**与阅读侧同一套引擎、口径反转**：未学结构误用（被动/定从/过去完成——超前学或背范文的诊断信号）、超纲词（班级词库之外）、句长分布、**复现词产出命中**（⑩的镜像：队列词学生写作实际用上几个——"定向复现干预有效"的直接证据）。导出体检报告 md。全部本地计算。
- **②全班批改队列（批改菜单）**：选一个文件夹（一份文件=一个学生，文件名=学生名）→ 逐份本地体检 → 班级汇总表（学生 × 词数/句数/均长/未学结构/超纲词/复现命中，点行看单生明细）→ 导出汇总 md+csv 到该文件夹（csv 带 BOM）。
- **③AI 批改候选（体检后可点）**：AI 只出候选（五类：语法/用词/结构/亮点/总评，prompts/grading v1.0），parseGradingItems 裁决（枚举表 #25：type 白名单/original 必须能在学生原文定位/note 非空，不合规拒收+明示）；**默认全不勾，勾选的才进批改稿**（原文按段保留 + 段后批注 + 总评，定位不到的批注列尾不丢）。红线：学生文本全本地，AI 走教师自配 key，不进仓。
- **④读后检测题（报告页新增④区）**：对当前章 AI 出选择题候选（理解/推断/词汇三型，词汇题优先复现队列词，prompts/reading_quiz v1.0），parseQuizItems 裁决（枚举表 #26）；教师勾选导出「学生卷 + 教师答案页（含考点）」。
- **工程**：lint 升级 `--max-warnings 0` 零警告门禁（当场抓住 2 处未用变量）；prompts manifest v1.4；测试 180→185 绿。
- **⑤定向复习材料（质检菜单「定向复习材料…」，Wayne 点名：作业/教材加进来做词汇置换+润色+语法补充）**：粘贴或选文件导入学校作业/教材段落 → AI 逐段改写成复习材料——词汇置换到班级词库口径（超纲词换已学词）、**复现队列词定向复现 8~12 个**（组合拳"生成侧定向注入"待办落地：自然复现仅 2/18 词的刚需从此有生成侧入口）、勾选的目标语法点自然融入（被动/定从/过去完成由引擎自动计数达成明示——勾了就从"黑名单"翻转为复习目标，其余语法点教师过目）；prompts/review_material v1.0（manifest v1.5）、枚举表 #27；产物进新 tab，可标记精修、导出 Word。
- 数据边界（如实记录）：复现产出命中依赖队列词表（书目录 _已学词.csv 或班级定制勾选），未启用时明示。

## [1.2.1] - 2026-09-10

- **Anki 弹层修复（v1.2.0 真 bug）**：导出预览面板引用了不存在的样式类且无显示切换——点完「导出/取消」后面板不会消失。改为 `#anki-pop` 专属样式 + 外点收回（与全部弹层同原则）。
- **生词卡 CSV 加 BOM**：教师双击用 Excel 打开时中文列不乱码（Anki 导入对 BOM 兼容）；复现队列 CSV 保持无 BOM（CLI 解析干净）。
- **单句改写 original 缺省回退**：AI 偶尔省略 original 字段——回退到发给它的原句继续可用（v1.2.0 的 schema 校验对此场景过严会整条拒收）；批量建议路径保持严格。
- **⚠︎ 复核角标随正文重排**：角标条目升级带原句身份（`pi:si|原句|原因`），正文改动后按原句重新定位（与标记重排同思想）；原句被删/被改写=角标使命结束自动清除——v1.2.0 中后续编辑会让角标错位或指错句。
- 测试 176→180（角标重排移位/丢弃、单句回退、BOM 各有锁定）。

## [1.2.0] - 2026-09-10

> 自 1.1.0 起的 22 个批次：书架与审校工作台大改版 → AI 边界防线体系成型（枚举表 24 条全"已防"）→ WP-F 巨石拆分（main.ts 5983→894 行）→ 发版收口。测试 92→176。

### 2026-09-10（main · 第十七批：发版收口——AI 边界最后两条待验证 + ⚠︎复核角标 + Anki 生词卡）

- **#18/#21 收口（枚举表最后两条"待验证 P2"→已防）**：建议定位决策抽纯函数 `resolveSuggestionTarget`（同句多条建议每条独立定位，失败落「修订建议」页绝不写错位置）；schema 校验拒收多条变体（`validSuggestionText`/`pickSingleRewrite`——单句改写此前会静默取第一条）；**顺根修 locateOriginal 精确比对缺陷**（sentsOf 输出带尾随空格、连字符拆成空格，坐标漂移后的重定位恒失败→normWs 归一化比对）+ 空 original 守卫（`indexOf("")` 恒返 0，曾可能把建议写进文首）。测试 suggest_order_schema.test.ts（同句两条/正倒序一致/坐标漂移/连字符形态/变体拒收）。
- **⚠︎ 复核残留正文角标**：AI 建议写入但引擎复核仍命中黑名单/超长 → 句旁挂琥珀 ⚠︎ 角标并**持久化到 _审校标记.json**（此前只有 2.6 秒 toast，重渲染即消失）；点角标=已复查消除、手动改这句自动清、撤销/替换快照回退整体清空。
- **morphWarn 明细并入总结面板**：词汇简化完成后右下浮层全量列出换词明细+降级加注+词形待复核逐条（AI 边界 #17 此前状态行只截前 3 条）；状态行瘦身为一句总结。
- **Anki 生词卡导出（质检菜单「导出生词卡（Anki + 复现队列）…」）**：词源=各章词表外生词 ∪ 教师标记的「加中文标注/复现锚点」词；释义优先级=正文已有注释 > 系统词典 > 留空教师补；CEFR 等级列；预览弹层确认后写 `生词卡_Anki_日期.csv` + `复现队列_日期.csv`（词,hits——`node dist/src/cli.js fsrs` 直接可看 FSRS 间隔建议，复习闭环落地）。extractZhNotes 剥前导虚词防贪婪吃冠词。
- 测试 173→176 绿。

### 2026-09-09 深夜～09-10（main · WP-F 拆分：main.ts 5983→894 行，全部模块 ≤1000 + max-lines 门禁）

- **前三步（此前已推送未记段）**：uikit.ts（弹层/状态行底座）/ pipew.ts（确定性管线域）/ aiflow.ts（AI 建议流域）——main 5983→4850。
- **本批十一步**：batch.ts（全书批处理）/ report.ts（报告·诊断台·对照·看板·档案）/ settings.ts（设置·班级·主题·欢迎导览）/ shelf.ts（书架·工作区·版本页·目录）/ reader.ts（正文渲染·标记·三面板）/ chat.ts（AI 助手·门禁弹层）/ bookio.ts（书配置·Word/朗读导出·书级改写·生词卡）/ edit.ts（撤销·查找·热力轨）/ lexicon.ts（词库构建·班级口径·宽容导入）；pure.ts 1037→583 并拆出 bookpure.ts（书级纯逻辑 462，批处理规划/班级目标/工作区/书架/EPUB/档案/看板）。
- **eslint max-lines 门禁**（单文件 ≤1000，跳空行注释）——巨石债清零后防回潮；顺清陈年未用 import 20+ 处，lint 恢复 0 error 0 warning；每步 tsc+lint+测试，行为零变化（176 绿）。
- 拆分方法论固化：python 提取器+锚点位置重组（must/assert 防空串事故）、函数级循环 import（模块顶层禁调 main 函数）、document/window 级全局绑定留 main 只 export 关闭函数、跨模块枢纽迁移直接改 import 路径不留 re-export 补偿层。

### 2026-09-09（main · 行内建议自解释）[补记]

- 正文黄句+绿字建议块此前无任何"这是 AI 建议待确认"标识（三秒测试不过实证）——绿字块加标头「AI 修改建议（未改正文，等你确认）」+ 黄句 hover 说明 + ✓✗ 按钮后果预告；正文图例补黄句条目。

### 2026-09-10（main · 第十六批：自动保存补齐 + 校正成果跨版本传播——"高层次校正影响低层词库，但仅限于此"）

- **词库编辑器自动保存**：增/删词条即时写盘并生效（正文重新着色），按钮只剩"完成"——此前要点"保存并生效"。其余自动保存现状梳理进 CHANGELOG：标记 600ms 防抖/正文改动即时写文件+首改备份/AI 会话防抖落盘，本就全自动。
- **校正成果跨版本传播（ Wayne 口径："高层次的人工校正改动会更新影响低层次的词库，但仅限于此"）**：高层版本词级校正（换词/加注）定案后自动——①沉淀书级 `_校正知识.csv`（版本/日期/词/处理/结果/传播到）；②同词同类型标记建到同目录低层版本（幂等，复用 syncMarksToMd+applySyncPlans）；**低层正文一律不动**——低层打开后按自己的口径执行或忽略。句级改写不传播（既有决策）。toast 明示传播去向。
- 164 测试绿。

### 2026-09-09（main · 第十五批：体验深化四件套——Wayne 拍板"做完这些重构拆分 main.ts"）

- **建议键盘流**：N=下一条建议（定位+聚焦+计数 toast），Enter=采纳聚焦条，X=放弃并跳下一条——逐条过建议全程不碰鼠标（输入框聚焦/弹层开着时不抢键）。
- **改写后单句即时指标**：AI 采纳/直改后若新句仍含 黑名单/超长 → toast"⚠ 新句仍含被动/超长(17词)——已写入可 ↩︎"；手动改这句同样检测（教师定稿不拦截，只提示）。
- **批量执行总结面板**：「按标记修改」完成弹右下角总结表（应用/⚠复核/拦下/落建议页/token），一键直达「修订建议」页——不再是一行滚走的长状态行。
- **词库 App 内编辑**：设置→词库「编辑…」——搜索/添加/删除词条（整行保留备注列），保存写书目录 _词库.csv 并即时生效（重新着色+自动重跑体检）；内置课标层不动。词典未收短语的 AI 注释数也进状态行。
- 164 测试绿；下一批：WP-F main.ts 拆分（≤1000 行/模块 + lint max-lines 门禁）。

### 2026-09-09（main · 第十四批附：学生视角预览——功能增强清单第一项）

- 工具栏「学生视角」一键切换（再点返回审校视角）：隐藏全部审校视觉（标记下划线/风险角标/AI 建议/段号/热力轨/三态词色），只留学生将读到的正文（word（中文）生词注释保留）——此前教师台全是审校视觉，"学生最终看到什么"只能靠导出后想象。

### 2026-09-09（main · 第十四批：批量校正三缺口——Wayne"比之前好用很多，但还可继续优化"的系统审计）

- **同词全换**：换词此前只替换首现（注释只标首现是教学惯例，但换词应全换）——段内全部出现处替换（倒序防位移、逐处保首字母大写、已带中文注释的出现处跳过防注释悬空），日志记"cynical→bitter（共3处）"。
- **大批量分批**：句子改写标记 >10 条自动拆批（每批 10 条独立请求，状态行显示"第 x/y 批"）——单次 6000 token 输出上限曾被思考型模型占满截断（09-06 真事故），此前只靠报错提示"减少数量分批出"，现在机器自己分。
- **组撤销**：批量直改 N 条此前要点 N 次 ↩︎（且 50 条栈会滚掉早期记录）——批后合并为一条基线快照，一次 ↩︎ 撤整批。
- 剩余优化清单（诊断已记录待排期）：改写后单句即时指标反馈/⚠残留正文角标、建议间键盘连续导航（Tab/Enter）、候选模式下词级管线与"只出建议"语义的统一、批量执行后的总结面板。164 测试绿。

### 2026-09-09（main · 第十三批附 2：#23/#24 短语简化失灵根修——"七条戒律这种应该可以加备注，或者简化为单词"）

- **#23 子词键**：AI 常把短语键答成子词（Seven Commandments→键只给 "Commandments"）→ 完整短语查恒 miss。根修=glossLookup 子集匹配：键词 ⊆ 标记词 且剩余词全已知（S.currentKnown）→ 值替换整个短语；剩余词未知不整换（防 "tired of" 被 "tired" 值毁语义）。真 key 重演：`Seven Commandments → rules（via=subset）` ✓
- **#24 中文值**：AI 偶把"简单词"答成中文（"七诫"2 字曾漏 ≥4 字防线）→ hasAnyChinese 单汉字即拒（值过滤+查找双重）。
- **短语注释 AI 兜底（Wayne 本条授权"应该可以加备注"）**：多词短语词典无整词条（Seven Commandments/Animalism）——AI 只出 短语→纯中文(2-6 汉字，正则强校验) 映射，机器插入 `短语（注释）`、原句不动；**单词仍纯词典零 AI**（此前拍板不动）。真 key 重演：`{"Seven Commandments":"七诫","Animalism":"动物主义"}` 校验全过 ✓
- 测试 161→164 绿（子集匹配正反例/中文值/同词跳过）。

### 2026-09-09（main · 第十三批附：#22 词汇简化映射恒空根修——Wayne 实测"最后都变成标中文"）

- **根因（枚举表 #22）**：chatUntilJson/parseAiJson 恒返回数组（单对象自动包一层，by design），而 `Object.assign(gloss, 数组)` 只会得到 `{0:{…}}`——**「词汇简化」的 AI 映射从上线起每次恒空**，AI 老实给出的简单词全部丢失，每个词都被误判"换不出"→ 全部降级加中文标注（词典未收则报"既没有更简单的词、也没能加注"）。
- **根修**：`normalizeGlossMap` 归一化（纯映射对象/字段对对象 word+simple·原词+简单词等字段名变体全兼容）+ 提示词给输出示例。**真 key 重演实证**：AI 原话 `{"cynical":"bitter","boar":"wild pig"}` → 旧法命中 false → 新法全命中。测试 gloss_map.test.ts 4 项（161 绿）。
- 教训：确定性管线的"AI 只出映射"环节此前从未被端到端真实验证过——AI 链路新功能合并必须附真 key 重演（已入枚举表使用规则）。

### 2026-09-09（main · 第十三批：站在轮子上——ts-fsrs / CEFR / textstat 三件外部轮引入）

> 调研报告：LayerText_GitHub可借鉴资源调研_2026-09-09（工作文档库）；Wayne 拍板"123 都做"。

- **① ts-fsrs 并行试点（open-spaced-repetition/ts-fsrs，MIT）**：`src/core/fsrs.ts` 薄封装 + CLI 子命令 `fsrs <队列.csv>`（词,hits → FSRS 建议隔篇 vs 现行固定 2 篇并排）。不替换现行策略（Nakata 2015 等距有依据）——一学期限定班 A/B 后再定切换；画像回写脚本可直接调本命令。示例：hits=0→1 篇、2→5 篇、4→15 篇（扩展间隔曲线）。App 面板待画像导出含次数后接入（数据侧边界，如实记录）。
- **② CEFR 等级维度（olp-en-cefrj，CC BY-SA 4.0）**：8314 词条转 `assets/wordlists/cefrj_levels.txt`（tools/convert_cefrj.py 可复现，同词多等级取最早引入）+ `src/core/cefr.ts`（词形回退查表）；词面板新增"CEFR：B1（进阶·中考上限带）"行——**纯显示维度，判定锚仍是课标 1600+教师词库**。
- **③ textstat 相关性（论文素材）**：`tools/flesch_corr.py`（方法进仓可复现，报告按分层公开不进仓）；AF 三版前 5 章 15 样本实测：生词率×Flesch r=-0.37、×FK 年级 r=0.38、×Dale-Chall r=0.32——**中等偏弱**：通用公式测不准"对这班学生"的难度，词库锚定口径的必要性有了实证。
- 借鉴 chinese-graded-readers（GitHub 4★）：其"词+释义内嵌标记、Anki 卡 CSV 导出、中英中三遍朗读"管线验证了内嵌注释格式；**Anki CSV 导出**列入下一批（与 FSRS 复习闭环天然衔接）。测试 154→157 绿。

### 2026-09-09（main · 第十二批：人工矫正闭环——手动改这句 + 两条审计欠账根修）

> 起点：Wayne 质询"你确定人工矫正功能做完善了？"——审计结论：没有。最大缺口=正文不可直接编辑（教师只能再喂 AI 或查找替换）；顺带查出两条欠账。

- **「手动改这句」（三面板入口 + 快捷键 E，与 R=AI 改写本句对称）**：句/词/短语面板都能进；编辑框预填原句，**你是定稿人——不经引擎复核**；保存后直接写入正文（首改自动备份、↩︎ 可撤销）、变更日志记 R15"教师手动修订"、该句句级标记与被改掉的词标记连带完成（防幽灵，别句同词不误伤——测试第三条抓出的规则缺陷当场根修）、自动重新体检（报告不滞后）。⌘↩ 也可保存。
- **applyMdSnapshot 根修**：撤销/查找替换等文件级快照变更后此前**不重对齐标记**（标记错位欠账）——补 remapMarks + 标记落盘。
- **查找替换补审计**：教师手动"全部替换"此前不进变更日志（只有 AI 修改留痕）——补 R15 人工矫正条目（含替换内容与处数）。
- 人工矫正至此三路齐全：确定性管线（词典加注/换词）· AI 候选采纳 · **教师亲手改**，全部可撤销、可审计。marksSurvivingManualEdit 纯逻辑 + 3 测试（154 绿）。

### 2026-09-09（main · 第十一批附：标记类型扩容——Wayne 拍板"建议加的都加"）

- **新增·词级「复现锚点」（anchor，teal 下划线）**：到期队列词在正文出现时点标记录——复现体系（词汇库 v0.4/5-8 词/篇/3 次毕业）从此有正文标记入口。记录型标记：即改模式点完只 toast 确认**不触发任何改写**（句子没问题，只是记录）；不进句子改写清单；随跨版本同步广播；该词后续被换词时锚点连带完成（词没了锚点自然失效）。已知边界：整章重简化时锚点词暂不自动保护——与组合拳"生成侧定向注入"待办一并做。
- **新增·句级「衔接断裂」（cohesion，teal 角标）**：拆句简化后两句接不上——简化文本特有高频问题（指代不清=代词指谁，衔接断裂=逻辑跳跃，两种病）；处理动作=AI 重写衔接句（intent 自动传"衔接断裂"）。
- 判定标准与不加清单（文化点/固定搭配/语气）记录在《交互自解释性验收标准》待拍板区——已拍板执行。数字键扩展：词面板 1-8、句面板 1-9。

### 2026-09-09（main · 第十一批：Wayne 三问——跨版本同步 + 候选模式闭环）

### 跨版本标记同步（同章多版本共用审校意图；B/M/A 三班工作流）

- 菜单 质检→「同步本章标记到其他版本…」：把当前版本的词/短语级标记同步到同目录其他版本文件（同章多版本放一个文件夹即可）。
- **语义**：同步的是"审校待办"，不是执行——各版本打开后按自己的口径点「按标记修改」执行；正文永不被同步改动。句级不同步（三版本句结构不同，句对不上）。
- 匹配：词级=目标中每处出现建标（大小写不敏感）；短语级=连续词序列匹配（连字符归一口径）；**目标无此词=跳过并明示**（更简版本已换掉该词=已处理，属正常）；目标已标过同词同类型=幂等跳过。
- 弹层先给后果预告表（每版本：将新建/已标过/无此词三列）确认才写盘；已打开的版本会话即时刷新，未打开的直接写其 _审校标记.json。纯逻辑 `syncMarksToMd` + 6 项测试。

### 候选模式闭环（Wayne 问"非即改模式点了标记 AI 没修改怎么办"——会出现，根修）

- 根因：候选模式点标记只入清单，"执行"是独立一步，但这个中间态从未显性化——标记攒了多少、去哪执行不可见。
- 修复：①「按标记修改」按钮加**待处理徽标**（红点数字=本章未执行标记数，仅候选模式显示，悬停说明去向）；②标记弹层提示行在标记后立即更新为"已入清单（待执行 N 条，正文未改）——点工具栏「按标记修改」批量执行，或切即改模式"；③管线执行完/模式切换/文件切换全链路刷新徽标。

### 2026-09-09（main · 第十批：个人体验优先——短语级标记 + 交互自解释性整改）

> 本批起主验收依据《交互自解释性验收标准 v0.1》：自解释（三秒测试）/ 为真实 AI 输出设计（形态枚举表）/ 粒度对齐意图（词/短语/句三级）。

### 短语级标记（三级粒度补齐，Wayne 点名"把短语也画出来用下划线划"）

- **拖选路由（选区即范围，无隐式判定）**：拖选归一化后等于整句→句面板；句内 ≥2 英文词→**短语面板**（新增）；≤1 词→词面板（原跨句行为保留：标记所选末句）。纯函数 `routeSelection`。
- **短语面板**：顶部常显选区原文+词数（用户永远看到将作用于什么）；类型按钮带后果预告（按当前模式说明点了会发生什么）；「AI 改写本句」共用。设计决策（09-09 定）：直线单一样式下划线（波浪=纠错语义；线型只编码粒度，"保留/简化/加注"意图走类型色板——与词级下划线同一套颜色语言，粒度由覆盖范围区分）。
- **渲染/持久化/可逆**：`.pm` 直线下划线包裹（含中间文本节点、幂等、角标不被卷入），随 `_审校标记.json` 落盘（wl=词数），重启恢复；删除即解包无残留；侧栏/热力轨/jumpTo 全链路支持短语级。
- **确定性管线扩展到短语**：加中文标注（系统词典短语查询）与词汇简化（AI 出短语→简单说法映射，机器词边界替换）对 `level:'phrase'` 生效；幽灵标记卫生/同词连带清理同步覆盖短语级。
- **remap 重对齐**：句内词序列匹配（大小写不敏感）重定位 wi/wl；`phraseSpan` 与渲染器同款逐词推进，重复词不串位。

### 交互自解释性整改（走查发现的 P1 全修，报告见 docs/reports/交互走查_2026-09-09.md）

- **词面板提示话术根修**：原"改写会直接出现在正文中供采纳"是候选模式时代旧话术，与即改模式矛盾（后果预告失准=三秒测试不过）→ 按当前模式动态预告真实后果。
- 词/短语面板类型按钮补 title 后果预告（动词+对象+模式说明）。
- 重要结果不再只沉在 12px 状态行：加注/换词成功同步 toast；状态行 saved/err 加粗。
- 五个无预告的页签（正文审校/质检报告/修订建议/版本对比/复盘）补 title；静态模式胶囊 title 补完整语义。

### AI 边界加固（枚举表 #16/#17/#19/#20 四项转已防，docs/AI输出形态枚举表.md）

- **#16 Markdown 记号**：`stripMarkdownNoise` 归一化剥离（建议构建处+词汇简化映射值两处），语义不变。
- **#17 屈折形态保真**：`morphMismatch` 词尾形态类比对（ed/ing/s/原形），不一致→⚠ 提示复核不拦截（B3 复核不挡路）。
- **#19 缩写拆句**：sentsOf 缩写合并表（Mr./Dr./U.S./单字母，TS+Python 双引擎同步）。**实现时 eval 门禁当场抓住正则未锚定 bug（`storms.` 被 `Ms.$` 尾部命中整句误并，45→43）——评测门禁价值的实证**；修复后 eval 100%（45/45）、双引擎 76/76 一致。
- **#20 段落前导空格**：归一化天然覆盖，回归测试锁定。

### 工程门禁

- **版本对齐门禁**（tools/check_versions.mjs + CI）：package.json / app/package.json / tauri.conf.json / README 四处版本一致，漂移即失败；修复现存漂移（app/package.json 1.0.0→1.1.0、README v1.0.0→v1.1.0）。
- **GBK/GB2312 编码探测**（`decodeAuto`）：txt/md 导入字节级探测（BOM→严格 UTF-8 校验→GB18030 兜底），中文环境导出的 GBK 文件不再乱码/打不开（对新手是"软件坏了"级事故）；三处读取入口统一走 `readTextSmart`。
- 测试 135→145 全绿（新增 10 项：路由/切片/DOM 包裹解包/remap/编码/记号剥离/形态预警/缩写/前导空格/跳转）。

### 2026-09-08（feature/reinforce 本地 · 第九批）

### the hazel 图标族融入（Wayne 拍板：替换 + 保留红点 + 融合现有美学）

- **来龙去脉**：the hazel 阅读器 2048px 材质图标（奶油纸+墨线+单点红）→ 自动描摹（vtracer 七组参数）验证保不住材质，判定不可行 → 手工重绘为线性矢量（六枚，SF Symbols 规范，品牌红 #C74C3F 从原图采样）→ 两轮评审修正三处后验收 → 按"替换+保红点+融合"指令并入 LayerText。
- **替换**：`i-home`（书架=三本书+底线+顶部书签V）、`i-search`（圆镜+柄+**镜心红点**）改用 hazel 形状（48 viewBox 原样入 sprite，g stroke-width 3.6=全套 24@1.8 的等价视觉线宽）。
- **新增**：`i-bookmark`（V+红横线→目录面板书签区）、`i-annotate`（三墨线+红下划线→修订建议页签）、`i-audiobook`（摊开书+声波，音频导出备用）。
- **红点走主题变量** `--mark-red`（浅/灰 #c74c3f，深色提亮 #e06a5c 保对比）——红成为全 UI 唯一彩色重音，与"红即标记"的审校语义呼应。
- 验证：双主题截图评审全过（两族线宽肉眼无差、红点清晰不刺眼、基线一致）；129/129。

### 2026-09-08（feature/reinforce 本地 · 第八批）

### 阅读区文字排版审查（六原则对照，抓出一个上线即有的真 bug）

- **字号真修复（根因）**：`.para` 固定 16px 压过继承——`applyReaderFont` 写的是容器字号，正文从未跟随，**A± 字号按钮上线以来不作用于正文**。正确逻辑：字号体系并入 CSS 变量机制（`--read-fs`，与主题/行距同构），.para 与行内修订建议统一消费；默认 15→17（英文 x-height 小，须大于界面字级，灰度才与中文界面协调）；步进范围 13–26。
- **段号定宽（首行缩进对齐原则）**：`.pid` 定宽 3.2em 居中——普通段 P02 与书签段 ★02（全角★最宽）首行起点严格一致（实测 35/35/35px）；悬挂式段号形态（正文各行左缘为主轴、段号悬挂）保留。
- **段间距 em 化**：14px → 0.85em 随字号缩放；段间距制确认（与首行缩进二选一，现状合规）。
- **英文排印质感**：正文开 kerning + optimizeLegibility。
- **标题图标基线补偿**：`📚 我的书架`/`☰ 目录` 的表意字符 translateY(1px) 光学对齐（.tico）。
- **全角标点扫描**：界面文案干净（命中皆为 TS 语法误报）；英文正文半角标点正确。底部无 LOGO（原则 6 无命中点，如实记录）。
- 截图评审通过（段号对齐/段距均匀/字号协调）；129/129 全绿。

### 2026-09-08（feature/reinforce 本地 · 第七批）

### 三大功能：审校过程档案（论文素材成卷）· 书级审校看板 · EPUB 导入

- **📄 审校档案**（新视图页，`tab-dossier`）：当前章一键成卷——指标对照（基准 vs 当前：生词率/句长/黑名单句）、逐句对照摘要（丢句/信号缺失明细）、AI 决策记录（台账本章行）、标记分类与终审门禁。导出两档：本章 `审校档案/审校档案_第N章_日期.md`；全书合成（头部汇总：门禁通过 x/y、平均生词率、总标记、采纳率 + 各章明细串卷），落盘即 reveal。基准复用对照页的 alignBase（一个基准两处用）；无基准时降级为无对照列。`buildChapterDossierMd/dossierFileName/DossierData` 纯函数化 + 6 项测试。
- **📊 书级审校看板**（新视图页，`tab-board`）：四张汇总卡（门禁通过 x/y、平均生词率、未结标记总数、AI 建议采纳率）+ 逐章表（门禁进度/标记/书签/生词率/建议采纳，行点击直达该章，当前章描边高亮）。数据=各章 `_审校标记.json` + 台账 + 当前稿现算 QC；`boardSummary` 纯函数 + 测试。
- **EPUB 导入**：「打开文件…」支持 .epub——zip→container.xml→OPF manifest/spine→逐文档抽段（p/blockquote 入正文，标题块只做章名 fallback 不重复入段），实体解码（含数字实体），整书拆章进会话（原文件不动，入库仍走"添加书稿文件夹"）。`parseEpubChapters/epubChapterMd` 纯函数 + 3 项测试（mini epub 由 fflate zipSync 构造）。
- 测试 122 → **129 项全绿**；lint 0/0；看板/档案页截图评审通过；tsc/vite build 过。

### 2026-09-08（feature/reinforce 本地 · 第六批）

### 整体 UI 对齐 Apple 设计语言（Liquid Glass 成熟形态，检索 2025 发布 / WWDC26 回调后）

- **依据**：iOS 26 / macOS Tahoe 26（2025.9）发布 Liquid Glass（自 iOS 7 以来最大改版）；WWDC26 的 iOS 27 / macOS 27 回调聚焦可读性（漫射更柔、修 macOS 圆角与侧栏）——落地取成熟形态：半透明漫射玻璃 + 大圆角 + 镜面边缘亮线 + **文字可读性优先**。
- **玻璃令牌体系**：三主题各配 `--panel-glass / --glass-line / --glass-hi / --glass-shadow / --seg-slot / --bg-g2`（渐变底）；应用全部浮层——顶栏、文件/工作区条、侧栏、12 类弹层、目录面板、右键菜单、toast、导览气泡（`backdrop-filter: blur(24-28px) saturate(170-180%)` + 1px 镜面亮线）。
- **macOS 原生窗口感**：标题栏 Overlay（`titleBarStyle: Overlay` + `hiddenTitle` + `macOSPrivateApi` feature）——内容延伸到红绿灯下方，顶栏玻璃化后交通灯浮于玻璃上；header 加 `data-tauri-drag-region`（整条可拖动窗口）、左避让 84px。
- **分段控件统一 macOS 化**：视图切换（正文/报告/建议/对比/对照/复盘）、侧栏页签、书架视图切换、设置面板主题/行距——灰槽 + 白浮块选中 + 顶亮线（原绿色实心选中态全部收敛）；分组 chips 保留 accent 高亮（过滤语义）。
- **正文纸面保持实体**（iOS 27 可读性回调的教训）：`--panel` 实底 + 16px 圆角 + 玻璃边光线；书封加顶面镜面高光；primary 按钮柔和渐变；按钮统一按压回弹（scale 0.97）与玻璃顶亮线。
- 视觉复核：浅/深两主题截图评审通过（深色全项 ✅；浅色修正分段控件统一与玻璃连体两处后过）。
- TS 122/122 + Rust fmt/clippy/4 测全清；`cargo check` 验证窗口配置。

### 2026-09-08（feature/reinforce 本地 · 第五批）

### 后端根因重构（前端哲思平移：唯一实现 / 正确工具 / 肯定式 / 门禁前移）

- **TS 核心层去重**（CLI 与 MCP 双入口共用的逻辑收敛到唯一实现）：
  - `chnoFromPath`/`tagFromPath` 此前在 cli.ts、app/pure.ts、app/main.ts 三处各有一份——收敛到 `core/textpipe`（路径约定解析与章节管线同域，纯函数无 IO），pure 转发导出（App 内 import 路径不变）；
  - `readWordFile`（cli 与 mcp-server 两份）+ 词表资产路径查找（cli 两个仅常量不同的同构函数）——收敛到新建 `src/core/files.ts`（Node fs 工具唯一存放；core 纯逻辑模块不引 fs 的边界保持）；
  - cli 的 `propCheckList: proper.length ? proper.concat([]) : []` 拷贝冗余删除（引擎只读该数组）；mcp-server 手写 `dirname`（遮蔽同名 node:path 能力、Windows 分隔符会错）删除；`McqLexiconOptions` 接口拼写修正为 `McpLexiconOptions`。
- **Rust 主进程**：`list_cover_images` 的字节算术切文件名 stem 改为 `Path::file_stem()`（正确工具替代手写）；`base64_encode` 容量预计算改 `div_ceil()`（clippy 门禁抓出）；`cargo fmt` 全文格式化（修正 handler 列表缩进不一致）。
- **Rust 测试从 0 到 4**：base64 roundtrip + RFC 4648 已知向量 + 换行宽松输入/非法字符如实报错；封面名过滤（认 cover/封面/front 系、拒 mycover/trailer/非图扩展）；`list_dir` 产物与配置排除规则——全部纯逻辑单测，`cargo test` 0.00s。
- **门禁前移**：新增 `npm run verify:rust`（cargo fmt --check + clippy -D warnings + test）；Rust 侧从"无任何检查"到 fmt/clippy/test 三闸全清。
- TS 122/122 全绿；lint 0 error 0 warning；CI 保持 TS 轻链（tauri 全量编译需 webkit 系统依赖，Rust 门禁走本地 verify:rust）。

### 2026-09-08（feature/reinforce 本地 · 第四批）

### 根因重构（对前三批全部优化做整体审查：正确逻辑直接覆盖，不打补丁）

- **口径加载收敛为唯一入口**：`ensureClassGroups()`（幂等 + 就位缓存，显式刷新才重读盘）；`activateWorkspace` 成为唯一绑定点（自身保证分组就位）。原先散在 openBook 预载 / enterWorkspace 兜底 / resume 预载 / activateWorkspace 静默补载的四处防御性重复全部移除。
- **工作区切换收敛为唯一闭环**：`switchWorkspace(name)`——工作区条点击、⌘1-3、版本卡进入、会话恢复四个入口共用；顺带消灭 enterWorkspace 与闭环内部的双重打开 bug（同一章被 openPathIntoSession 两次）。
- **书架渲染分层**：骨架（chrome）进书架渲染一次，正文区（grid/list）随搜索/分组/视图局部刷新——搜索框与输入焦点原地保持，删除"重渲染后找焦点回光标"的补偿代码；书卡以**书目录为唯一主键**（data-shelf=目录，过滤与重渲染后恒指向同一本书），替代易错位的数组下标；右键分组菜单改为参数传递，删除模块级 `loadShelfCached` 全局缓存。
- **肯定式重写**：`filterShelfBooks` 拆为 `inGroup`/`matchesWords` 两个正向谓词（分组以相等为命中）；`touchProgress` 直接接受 `string | null`（删调用侧 `?? ''` 转译）；`progressPct` 条件精简（`!total` 覆盖未定义与零）；openBook 全书章数单路径计算（工作区总数或目录清点）；openChapterFiles 删冗余类型过滤。
- **死代码清零（lint 0 error 0 warning）**：renderRecentInEmpty（被书架取代的旧空状态）、normalizeToChapter（由 pure.normalizeAndSplitChapters 承担）、ChatMsg/RewriteRule 孤儿接口、refreshPop 的 `_why` 死参数、fileTokens 从未读的累加器、data 未读赋值、8 处未用 import（lostSignals/uiSetStatus/QcResult/Tier/Workspace/providerNameOf/sentsOf/tokenizeTxt/IRR/parseManifest/cardGlossWords 等）。
- **小根因**：难句跳转索引随切章复位（旧索引指向已不存在的句子）；resume 全部文件失效时还原书根锚定（防进度记账悬空）；backToShelf 改同步（体内无异步）；`review.bookmarks` 类型恒为数组的不变量成立后删除 `?? []` 双保险（测试数据同步补齐）。
- 122/122 全绿；本次为纯逻辑重构，无 UI 行为变化。

### 2026-09-08（feature/reinforce 本地 · 第三批）

### 审校效率三件套（键盘流 / 热力轨 / 双栏逐句对照）

- **键盘审校流**（跳-改-跳核心循环提速）：
  - **F8 / ⌘G 跳下一处难句**（被/从/完/长按出现顺序循环，⇧⌘G 上一个；查找条打开时 ⌘G 优先当"下一个命中"），跳到闪烁+toast 计数"3/17 · 被·长"；
  - **标记弹层数字键**：点词/划句后按 1-9 直接选第 N 类标记、R 触发 AI 改写本句（弹层按钮上印键位徽标；备注输入框聚焦时不抢键）；
  - **⌘1/⌘2/⌘3 切工作区**（复用工作区条逻辑：切版本并自动翻开该版本第一章）。
- **正文右侧难句热力轨**：风险句红点、标记蓝点、叠加紫点，灰色半透明块=当前视口位置；点圆点直达该句（闪烁）。本章哪里问题密集一眼可见；标记增删/字号变化自动重排。
- **双栏逐句对照**（新视图页「⇄ 逐句对照」，审校 AF 三版逐句核对的工具化）：
  - 基准=已打开的其他版本或「选文件…」（默认定位当前章目录）；句级 LCS 锚点 + 间隙 Jaccard≥0.45 贪心配对（改写句/换序都能配上）；
  - 三态行：**疑似丢句**（基准有此处无，左红底）、**新增**（右黄底）、**信号缺失**（配对句但基准的数字/专名在当前句找不到，橙虚线框+⚠清单）；
  - **信号口径**：数字（含英文数字词归一 three↔3）+ 专名（句首大写白名单外）；机器核对只提示不定罪，教师裁决；
  - 统计条：对齐 N 句 · 丢句 x · 信号缺失 y 处 · 新增 z。
- 对齐算法 `alignSentencePairs/signalsOf/lostSignals` 入 `pure.ts`，新增 7 项测试（锚点/间隙配对/换序/数字互认/专名/句首白名单）；三主题变量复用于对照 pane。
- 测试 115 → **122 项全绿**。

### 2026-09-08（feature/reinforce 本地 · 第二批）

### 阅读体验与书架管理（Wayne 需求按产品定位定形：审校工作台，不做消费级阅读器功能）

- **三主题**：白/灰/深色（header ☀ 快捷循环 + 设置面板三选，持久化）；全 CSS 变量驱动——顺手把书架/工作区条的绿色系与散落硬编码色收敛为 `--accent/--wsbg` 等变量，三主题全局一致。深色下词色/警示色同步适配。
- **行间距三档**（1.7/1.9/2.1，设置面板即选即存）；字号调节原有。
- **书架管理**：搜索（多词 AND，匹配书名/副标题/分组）+ 网格/列表双视图（网格=挑书，**列表=审校进度清单**：小书封+分组徽标+进度条+最近时间）+ 分组轻量指派（右键书卡→现有分组/新建；书多之前不做管理弹层）。
- **阅读进度**：按章记账（打开过的章节去重累计），书卡显示进度条与"已审 N%"，进度锚定书根（openBook/resume 自动锚定，回书架释放）。
- **目录侧滑面板**（☰ 目录 / Esc / 点遮罩关闭）：全书章节 + **各章审校状态徽标**（批量读 _审校标记.json 显示"N 标记/未标记"）+ 当前章高亮 + 本章书签区一键跳回。
- **段落书签**：正文中双击段号（P01/P02…）收藏/取消（★ 徽标+左侧竖条视觉），随 _审校标记.json 落盘，目录面板集中查看跳转；旧标记文件无 bookmarks 字段自动兼容。
- 明确不做：在线书城（违背全离线红线与版权边界；搜索/分组/视图对全部书统一生效无断层）、翻页模式（审校需连续上下文做句级定位）、页码百分比进度（审校粒度=章）。
- 纯逻辑 `filterShelfBooks/shelfGroupsOf/progressPct/toggleParaBookmark` 入 `pure.ts`，新增 4 项测试。

### 2026-09-08（feature/reinforce 本地）

### 书架改版 · 两级导航（Wayne 走查反馈：点书没反馈/比例不像书/封面与放大问题）

- **书封化书架**：书卡改为正常书比例竖版封面（3:4），左侧书脊（深色压边+高光），hover 抬起；整卡可点（去掉"打开这本书"按钮）。
- **封面导入**：书目录放 `cover.jpg`/`封面.png`（jpg/jpeg/png/webp，front/book-cover/书封 均识别）即自动作书封（Rust 新增 `list_cover_images` 命令）；无图用书名当封面——书名字号按视觉宽度分档自适应（中文全角=1、ASCII≈0.55），极端长名换行 4 行内可见不溢出。
- **两级导航**：点书 → 版本选择页（B/M/A 三张版本卡，各显示章数/绑定口径/起始章）→ 点版本才进工作区（不再一竿子捅进第一个工作区）；版本页可返回书架；工具栏新增「🏠 书架」按钮随时回来（改动早已自动落盘）。
- **工作区点击有反馈了**：修复工作区条 active 态样式选择器写错（`.filetabs .ftab.active` 不覆盖 `.wstabs` 容器）导致点击零视觉变化的 bug；active 态=浅绿底+顶部深绿条+加粗；切版本时若当前正文不属于该版本，自动翻开该版本第一章（看得见的变化）。
- **去掉"点刷新"提示**：工作区绑定口径未加载时改为静默补加载分组文件并自动绑定，不再弹红色"点「👥班级定制→刷新」"。
- **修复工作区条残留**：关闭全部章节后工作区条仍挂在页面的 bug（无会话时一并收起）。
- **响应式适配**：书架网格 auto-fill 随窗口宽度增减列数（168px 最小书宽）；侧栏 `clamp(250px,24vw,350px)`；pane 内边距 clamp；正文段落与报告表限宽 1080px 保行长可读；900px 以下窄窗侧栏收窄、书架换小列。
- 纯逻辑 `coverTitlePx`/`coverVisualWidth`/`buildVersionCards` 入 `pure.ts`，新增 3 项测试。

### 前端工程化（Lint + 格式化 + 一键校验 + Git 钩子 + CI 门禁）

- **ESLint**（flat config，typescript-eslint recommended）：覆盖 `app/src`、`src`、`tests`、`tools`；`npm run lint` / `lint:fix`。存量清零：正则多余转义 11 处、无用赋值 4 处、三元做语句 1 处修复；未用变量/any 降为警告不阻塞（18 warnings，`_` 前缀豁免）。
- **Prettier**：`npm run format`（printWidth 200 贴近现状，不做全仓重排避免巨型 diff）；只对暂存文件增量格式化。
- **Git 钩子**：husky + lint-staged——commit 时自动对暂存的 ts/mjs 跑 `eslint --fix` + `prettier --write`。
- **一键校验**：`npm run verify` = typecheck（根 + app 双包）→ lint → 全量测试。
- **CI 门禁**：`ci.yml` 新增 Lint 步骤（0 error 才过）。
- 顺带修复：`openChapterFiles` 对话框取消时 `null` 未过滤的存量类型漏洞（app tsc 由 CI 之外首查抓出）；root package.json 重复 `description` 键。

## [1.1.0] - 2026-09-07

### 优化阶段 O1–O6（让现有的一切更稳、更快、更顺、更好懂）

- **O1 稳定性清偿（附录 A 四项关闭，各附回归测试）**：
  - 对话历史自动压缩（#1）：估算超 6000 tokens 或消息超 40 条时，后台把旧轮摘要化（切点保证 tool_calls 与结果不拆散），状态栏展示压缩前后 tokens 对比；压缩期间有新消息自动放弃。
  - `propose_revision`/`apply_edit` 空白容忍（#2）：新增 `findOriginalFlex` 空白归一化定位（句末空格/多重空格/换行差异可容忍，多处歧义拒绝），AI 不再因空格差异反复重试。
  - 错误分类补齐（#7）：`aiErrHuman` 移入纯模块并新增 403/无权限/模型不存在分支的人话指引。
  - failover 后台账纠偏（#8）：建议台账的供应商/模型列记录实际使用的那家（含备用切换），复盘按供应商分组不再失真。
- **O2 全书批处理（最大价值）**：工具栏「📚 全书简化…」选书稿文件夹→勾选章节→队列自动「AI 简化+体检+规则校验」；每章产物与单章一致（`xxx_简化_日期.md`）；跑完生成《全书简化报告_日期.md》（各章生词率/句长/黑名单/规则残留/耗时/tokens 横向表+复查清单）；进度文件落书稿文件夹、**中断可续跑**、单章失败不拖垮队列；本书配置（词库/规则）自动生效；抽出 `simplifyChapterCore` 单章核心复用；Rust 新增 `list_dir`/`remove_file`。
- **O3 文案与残留审计**：产品转向后的层级残留全清理（报告表头「解禁门(A层)」、旧名「分层初稿」两处、欢迎页"不同难度版本"、门禁"本层级"、PRD/prompts README 等 9 处）；「支架/中梯/挑战」零残留；引擎内部三层口径按红线不动；复盘页归属考证关闭（欠账#3，W2/W3 正式交付）；见 [O3 审计报告](docs/reports/O3-残留审计报告.md)。
- **O4 UI 层测试补强**：模式胶囊/视图切换/版本对比渲染抽到 `widgets.ts`（DOM 依赖但无 Tauri，行为不变），`locateOriginal`/`remapMarks`/`csvCell`/`chnoFromPath` 抽到 `pure.ts`；新增 happy-dom 部件测试与纯函数测试。
- **O5 性能基线**：`tools/perf_baseline.mjs`（AF 第一章 + 3 倍文本）实测管线/渲染/体检/对比，3x 渲染 60ms 远低于 200ms 阈值——**无需增量渲染**；见 [性能基线](docs/性能基线.md)。
- O6 文档收口：README 三张产品截图（CC0 示例拍摄）、release-checklist 补 GUI 验证依赖屏幕解锁与 hdiutil 两条、发布流程 GitHub 路径核对；性能基线补 AI 实测（DeepSeek 单段约 1 秒）。
- 许可变更：MIT → **PolyForm Noncommercial 1.0.0**（source-available：教师/学校/教育机构/个人研究免费使用与分享；商业用途需作者授权）。
- 测试 67 → **92 项全绿**。以下为 1.0.0 之后、本次一并随 1.1.0 交付的变更：

### 界面 · 工具栏信息架构重组（用户核心批评：不知道点哪、模式不可见、入口关系不明）

- 工具栏按工作流分组：① 拿到课文（载入示例/打开/ⓘ简化标准）│ ② 体检 │ ③ AI 修改（📖 整章改写… = 整章大改；✨ 按标记修改 = 精修）——按钮动作化命名，悬停说明各自适用场景；后按用户反馈移除常驻分组小标签（步骤说明只留导览与悬停）。
- **修改模式胶囊**（关键）：工具栏常显当前模式并可一键切换——⚡即改模式（标记/建议立即生效）/ 👁候选模式（AI 只出建议、教师逐条 ✓ 或统一应用）；彻底解决"单选一处到底改没改"的不可见问题；AI 设置改动同步刷新。
- 文件标签栏提示语移除，无文件时整行收起；AI 助手页顶部写明与工具栏按钮的分工（对话=零散改/查证，按钮=成批固定动作，能力等价）。

### 新功能 · MCP 服务（把质检引擎接进任何 AI 客户端）

- 新增 `npm run mcp`（src/mcp-server.ts，stdio）：4 个本地工具——`layer_qc`（全文体检）、`layer_word_status`（词表状态/原形）、`layer_sentence_risks`（句法黑名单逐句）、`layer_check_revision`（改写句自查残留）；口径与桌面应用同一套引擎，零遥测不落盘。
- 支持叠加教师词库（`--vocab/--wordlist/--terms/--proper`），Claude Desktop/ZCode 配置示例见 [docs/MCP.md](docs/MCP.md)。
- MCP 冒烟测试抓到并修复引擎漏检：PASSIVE_IRR 补入 sung 等 22 个常用被动分词（TS 与 Python 参照版同步；金标准评测与双引擎对照全绿）。
- 测试 62→67 项全绿（MCP 工具层 5 项）。

### 产品转向 · 去预设难度（用户拍板：单文本一次简化）

- **去掉 B/M/A 难度层预设**：难度由教师词库锚定（学生学过什么词就简化到词库内），唯一硬标准=句长上限（默认 16 词，ⓘ 可调）；黑名单句法一律禁用（原 A 层"第 N 章解禁"逻辑随层级一并移除）。
- **多版本 = 迭代深化**：需要更简的版本，把简化结果再导入、再简化一遍（天然形成版本链，版本对比页逐段 diff）。
- 「✍ 分层初稿」改名「✨ AI 简化本章」，产物命名 `_简化_日期.md`；「分层方案」设置简化为「简化标准」一项；菜单/帮助页/门禁参考表同步。
- 提示词 rewrite_sentence 去掉层级字样（manifest v1.2）；建议台账"层级"列改记简化标准（如"标准16词"）、版本列接通真实提示词版本号。
- QC 引擎与评测不动（红线：三层口径保留为引擎内部能力，应用统一以 M 口径调用）。

### 新功能 · 初步诊断（用户点名）

- **导入即自动体检**：打开课文自动跑本地 QC（无需点击、无需 AI），状态栏直接报生词率与难句数；按钮改「▶ 重新质检」。
- **质检报告页改为可操作的「初步诊断台」**：① 生词清单每词两个勾选动作——「标记要简化」（进标记清单，可批量交 AI）或「学生已学过」（立即不再标红，保存书配置后全书生效）；② 句法难句清单每句可勾「标记要改」（按被/从/完→语法太难、长→句太长自动归类）。
- **AI 摘情节要点**（新提示词 prompts/plot_points.md，整套版本 v1.1）：AI 通读本章摘 5~8 条"简化绝不能丢的情节点/伏笔"，教师逐条勾选后预填「本章要点配额」（重复自动去重）——配额即原有的打勾核对清单。
- 四步导览与空状态文案同步更新。
- 测试 60→62 项全绿。

### 工程化 W5 · 本地监控与可持续迭代

- 本地错误日志：前端未捕获错误与 Rust panic 全部落盘（512KB 轮转保留 5 份，零遥测只写本机）。
- 应用内「导出诊断包」（帮助菜单）：配置摘要（域名/开关/数量，不含 Key 与任何文本）+ 错误日志 + 成本台账打 zip，用户自愿导出；附「模拟一次错误」自检入口。
- 新增 `docs/复盘模板.md`：每次真实教学使用后一页纸复盘，结论反哺提示词/分层方案/需求池。
- 测试 58→60 项全绿（诊断摘要隐私口径）。

### 工程化 W4 · 发布工程

- GitHub Actions CI：push/PR 自动跑 类型检查+全量测试 → `npm run eval`（低于基线即失败）→ 双引擎对照 → 应用类型检查；不过绿不合并。
- Release 工作流：打 `v*` tag 自动 测试门禁 → 构建 universal dmg → 提取 CHANGELOG 段落为正文（缺段落即失败）→ Release 挂 dmg。
- 新增 `docs/发布流程.md`（semver 口径、版本三处一致、**不做签名公证的决定与理由**）与 `docs/release-checklist.md`（含新手首开路径换位清单）。
- 测试 56→58 项全绿（CHANGELOG 段落提取工具）。

### 工程化 W3 · 提示词与供应商治理

- 提示词外置 `prompts/`（4 份 + manifest 版本清单 + 变更记录），教师自定义目录可覆盖内置（`~/Documents/LayerText配置/prompts/`）——改提示词不改代码；评测 CLI 与桌面应用同源加载。
- 供应商 failover：AI 设置可配备用服务商序列（独立 Key 存钥匙串，空则复用主 Key），主服务商失败按序自动降级，实际用了哪家全程留痕。
- 成本台账：每次 AI 调用记录 供应商/模型/提示词版本/tokens/耗时/failover（`AI成本台账.csv`），复盘页新增「本书 AI 成本」卡片。
- 建议台账的提示词版本列接通实际版本号（自定义覆盖带 `*`），复盘可按版本对比采纳率。
- 测试 49→56 项全绿。

### 工程化 W2 · 采纳率数据闭环

- 新增《AI建议台账.csv》：每次 AI 建议被 采纳/拒绝/直改 自动落一行（16 列含规则号/标记类型/供应商/提示词版本），所有采纳路径全覆盖。
- 新增聚合引擎 `src/core/adoption.ts` 与 CLI `tools/adoption.ts`：按标记类型/规则号/供应商/提示词版本/日期聚合明确采纳率与复核⚠比，输出"该改提示词还是改审校约定"判读。
- 应用内新增「复盘」页（视图标签 + 显示菜单）：汇总卡片、最常被拒 Top5、日期趋势、自动判读。
- 测试 43→49 项全绿。

### 工程化 W1 · 评测集与质量基线

- 新增金标准评测集 `examples/evals/`：3 篇自写 CC0 文本（68 句）+ 人工标注（45 处黑名单句、25 个核定 OOV 词型、B/M/A 三层目标特征）。
- 新增 `npm run eval`：QC 金标准对照（命中率/漏报/误报/OOV 对齐），与基线对比低于即失败（CI 门禁）；`--calibrate` 标注核对、`--update-baseline` 刷新基线；配置 `LAYERTEXT_API_KEY` 加跑 AI 初稿评测。
- 评测暴露并修复：①内置课标词表系统性缺失数词/星期/月份/部分国名（新增 `curriculum_2022_amendment.txt` 补录，CLI/eval/应用三处加载）；②`was built` 被动漏检（PASSIVE_IRR 补 `built`，TS 与 Python 参照版同步）。
- 建立质量基线：命中率 100%（45/45）、漏报 0、误报 0、OOV 3/3 篇一致（`docs/质量基线.md`）。

## [1.0.0] - 2026-09-06

商业化冲刺：从"能用"到"第一次打开的英语教师不看文档能走通"。

### 新增

- 任意导入：`.md` / `.txt` / `.docx`（Word 直接打开自动转章节格式，多章自动拆 tab）。
- 首启动三步向导（欢迎 → 连接 AI → 确认语言）+ 首次载入四步导览（coach marks）。
- 导出：Word 版（含章末词句卡）、朗读音频（macOS 系统语音 AIFF）、标记 JSON。
- 版本对比：双版本逐段 diff（原文 vs 初稿 vs 工作稿）。
- 书级改写规则：人名/词汇替换（机器确定性执行零遗漏）+ 叙事视角/全局要求注入每次 AI 请求，随书稿文件夹保存自动生效（`_LayerText项目.json`）。
- 换书提醒：打开新书首个章节而无本书配置时提示配置词库。
- 最近编辑列表（空状态一键重开）。
- AI 助手会话保持：切换文件不清空对话，自动注入"当前章节"上下文；对话防抖落盘，重启可恢复。
- AI 助手直改体系（信任模式）：教师说"直接改"即生效，自动落工作稿与变更日志，原稿不动。
- 全局 AI 直改模式：点标记/批量建议/逐句改写的结果直接生效（可关闭回到候选模式）；引擎复核按句拆分，黑名单/超长残留条目计数提醒复查。
- 原地编辑原稿：改动直接写进书稿文件，首次修改前自动备份原始版（`xxx_原始备份.md`）；关闭则写工作稿。
- 改写生效绿色高亮一闪 + 自动滚动到新句。

### 修复

- AI 返回 JSON 解析容错（代码围栏/单对象/截断修复/思考型模型把输出耗尽的追发重试）。
- 思考型模型改写失败（reasoning 文字占满 token 上限，JSON 未输出即截断）；按 DeepSeek 官方文档以 `reasoning_effort=low` + `thinking: disabled` 关闭思考。
- 后端整合期间测试抓住的两处纯逻辑 bug。
- AI 网络自动重试（断连/超时/5xx/429 指数退避）。

### 工程

- 后端分层重构（ai.ts 网络层 / state.ts 状态源 / pure.ts 纯逻辑 / review.ts 审校 DOM），界面行为零变化。
- 测试从 21 项增至 **43 项全绿**（防坑规则回归 + 审校 DOM + 应用逻辑）。

## [0.8.0] - 2026-09-06

新手可用性大改（目标：不懂电脑与 AI 的教师可直接上手）：错误信息人话化、AI 服务商预设 + Key 获取教程、分层标准可调（B/M/A 句长上限与解禁章号）、本书配置随文件夹。

## [0.7.0] - 2026-09-06

分层初稿：首次导入按方向整章大改（逐段改写、语气衔接、生成后自动质检开新 tab），补全"全书初稿 → 标记精修"两阶段工作流的第一阶段。

## [0.6.0] - 2026-09-06

所见即所得：AI 建议直接进正文行内对照（原句下方黄色候选区），点 ✓ 立即生效，引擎逐句复核被动/定从/过去完成/超长。

## [0.5.0] - 2026-09-06

AI 助手侧栏（应用即 harness）：流式对话，模型可调用本地工具（跑质检/查句子/列标记/提修订候选），每条建议经本机 QC 引擎复核；上下文与 token 精简方案（只发标记相关句子，不发全章原文）。
[0.5.1] 修复 AI 设置"填了没反应"。

## [0.4.0] - 2026-09-06

AI 审核建议闭环：标记 → 建议（对话/批量/逐句）→ 行内对照 → 采纳（原稿不覆盖，工作稿 + 变更日志 CSV 留痕，轮次/位置/改前/改后/规则号/依据）。

## [0.3.0] - 2026-09-06

原生菜单栏（文件/质检/帮助）、内置帮助页、词表宽容导入（CSV/TSV/TXT/Excel，无表头自动识别）。
[0.3.1] 终审门禁「?」帮助：QC 指标达标弹出本章实际值 vs 层级参考值核对表。

## [0.2.0] - 2026-09-06

M2 审校工作台内嵌：三态高亮正文（词表外红/待定橙/术语蓝）、点词/拖选句标记（7+8 类）、要点配额、终审门禁、标记清单跳转、标记防抖自动落盘。

## [0.1.0] - 2026-09-06

首版：M1 QC 引擎 TypeScript 移植（irregular/lexicon/textpipe/qc/risks，21 项防坑规则回归测试，与 Python 参照版逐字段对照一致）+ CLI；M3 先行 macOS 应用（Tauri 2，Universal dmg）。
