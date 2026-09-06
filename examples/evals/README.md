# 金标准评测集（examples/evals/）

3 篇自写 CC0 文本 + 人工标注的金标准，用来回答两个问题：

1. **引擎检测准不准**——被动/定从/过去完成/超长句的命中、漏报、误报，OOV 清单是否与人工核定一致；
2. **AI 简化质量有没有客观标尺**——每篇附 B/M/A 三层目标特征（句长上限、生词率上限、黑名单清零、
   情节词必须保留），配置 key 后 `npm run eval` 会实际跑 AI 分层初稿并逐项核对。

## 目录结构

```
eval01_the_rematch/   龟兔再赛（寓言续写，易词；引语豁免/词表边界）
eval02_science_fair/  科学展（校园故事，中词；that/who 定从、被动密集）
eval03_lighthouse/    灯塔（文学叙事；倒装过去完成、词句卡并入已知、专名一致性⑧）
  ├─ source.md        评测文本（## Chapter One + [P01] 段落标记；eval03 含词句卡）
  ├─ proper.txt       专名表（一行一词）
  └─ golden.json      金标准：annotations（四类黑名单句子的精确清单）+ oovExpected（人工核定 OOV 词型全集）
                      + targets（B/M/A 三层目标特征，key 模式下核对 AI 初稿）
baseline.json         机器可读质量基线（npm run eval -- --update-baseline 维护）
```

## 怎么跑

```bash
npm run eval                    # QC 金标准对照 + 与基线对比（CI 无 key 即此模式）
npm run eval -- --calibrate     # 逐句打印检测明细（新增/修订标注时核对用）
npm run eval -- --update-baseline  # 有意变更规则后刷新基线（同步更新 docs/质量基线.md）

# AI 初稿评测（可选）：
LAYERTEXT_API_KEY=sk-xxx LAYERTEXT_MODEL=deepseek-chat npm run eval
```

低于基线时命令以非零码退出（CI 不绿不许合并）。

## 新增一篇评测文本的流程

1. 自写 CC0 文本（刻意埋入要覆盖的黑名单结构，避免使用连字符/破折号——分句与词数口径按空格计）；
2. `golden.json` 先放空标注 → `npm run eval -- --calibrate` 看引擎逐句输出；
3. **逐句人工核定**：每个引擎标出的句子判断"该不该标"（对照 `src/core/irregular.ts` 的规则与
   课标词表），该标的进 annotations，不该标的就是引擎误报（要么改文本消除歧义，要么作为已知问题记录）；
4. OOV 清单同理：引擎报出的每个词去 `assets/wordlists/` 里查证，确实词表外的进 oovExpected；
5. 跑 `npm run eval` 直到 100% 命中、零漏报零误报、OOV 完全一致，再更新基线与 `docs/质量基线.md`。

## 已知口径说明

- 引擎把 `keeper` 判为已知（hit() 剥 `-er` 后缀命中 `keep`），`running` 判为词表外
  （双写辅音还原仅对 `-ed` 编码）——金标准按引擎实际口径记录，这是设计行为不是 bug。
- 直接引语内的被动/定从整体豁免（引语只降词不降句式），标注时引语句不计入黑名单。
