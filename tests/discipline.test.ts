/**
 * 「最关键的代码纪律」· 结构性守卫
 *
 * 来源：《LayerText 工程优化总计划》「最关键的代码纪律」五条。
 * 其中几条是**结构性**的——它们说的不是"某次行为对不对"，而是"某个形状不许出现"。
 * 那些用普通用例守不住（你没法为"将来别这么写"写一条断言），但可以**读源码**来守：
 * 一旦有人把那种形状加回来，这里会当场失败，逼他在 PR 里解释。
 *
 * 这个文件里的断言全都**故意读源文件**，所以它们比普通用例脆——
 * 改动注释、改名都可能让它误报。这是有意的取舍：**宁可偶尔误报让人看一眼，
 * 也不要让一条纪律在无人察觉的情况下失效**（第 2 条就是这样失效的）。
 *
 * 守卫本身有效吗（反证实测，往源码里注入违规后再跑同样的判据）：
 *   · 往 `segmentgate.ts` 里塞一个 `catch` → 抓到 1 处 ✓
 *   · 让一个 `catch` 之后返回 `status: 'applied'` → 抓到 ✓
 * 两条守卫都不是"永远为真"的摆设。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const src = (rel: string): string => readFileSync(join(REPO, rel), 'utf-8');

/* ────────────────────── 纪律 3：catch 不许掩盖质量状态 ────────────────────── */

test('★ 判定链路的纯函数里**一个 catch 都没有**——掩盖质量状态的机会从一开始就不存在', () => {
  /* 纪律第 3 条：「任何 `catch` 必须产生 warning/error event 或显式返回失败；
   * 禁止『尽力而为』掩盖质量状态。」
   *
   * 这条链路（门禁、QC、改写契约、风险动作）的回答直接决定"这段能不能进正文"。
   * 它们里面只要出现一个 catch，就意味着"出了意外时，结果是**照常给一个判定**"——
   * 而那个判定没人能分辨是算出来的还是兜出来的。
   * 所以这几处的正确形状是：**要么返回判定，要么抛**，没有第三条路。
   *
   * 实测（本轮）：这四处 `catch` 计数为 0，所以它们本来就是合规的；
   * 这条用例的作用是**让它们保持合规**。 */
  for (const f of ['src/core/segmentgate.ts', 'src/core/qc.ts', 'src/core/rewrite.ts', 'src/core/riskaction.ts']) {
    const body = src(f);
    const hits = [...body.matchAll(/\bcatch\b/g)];
    assert.equal(hits.length, 0, `${f} 里出现了 catch。判定链路上不允许"出了意外就照常给个判定"——` + `要么返回判定，要么抛。若确有正当理由，请把理由写进注释并更新本用例。`);
  }
});

test('★ 写正文的事务里，每一个 catch 都必须**让失败可见**（不许静默吞）', () => {
  /* `version.ts` 是唯一那个写正文的入口，它当然要 catch（磁盘会满、文件会没）。
   * 要求不是"不许 catch"，而是"catch 之后必须让人知道"。
   * 判据：每个 catch「后面那段」里必须出现 throw / return ...rejected / reason / docTouched 之一。 */
  const body = src('src/core/version.ts');
  const parts = body.split(/\bcatch\b/).slice(1);
  assert.equal(parts.length > 0, true, 'version.ts 应当有 catch（IO 会失败，这是设计的一部分）');
  for (const [i, part] of parts.entries()) {
    /* 只看**这个 catch 之后的头一个 return / throw**。
     * 用固定长度的窗口会误伤：`version.ts` 里有嵌套的 catch（回滚失败那次），
     * 它的窗口会一路伸到外层 catch 之后的 `return { status: 'applied' }` 上去。
     * "头一个出口是什么"才是要问的问题。 */
    const exitAt = ((): number => {
      const r = part.search(/\b(return|throw)\b/);
      return r < 0 ? 0 : r;
    })();
    const window = part.slice(0, exitAt + 400);
    /* 合规的形状有五种，每一种都**让失败可见**：
     *   · 抛出去（`throw`）
     *   · 返回 `status: 'rejected'`（调用方一定看得见）
     *   · 记 `docTouched` / `rolledBack`（回滚成功与否必须能被区分）
     *   · 把坏行**计数**出来（`badLines`——`parseDecisionLog` / `parseVersionLog` 的约定：不静默丢弃）
     *   · 调 `recordRejected`（写一条"这条没做成"的事件；卡片会留在待办里）
     *   · 把"连失败都记不上"这件事写进返回的原话里（`未能写入日志`）
     *   · 写明理由的**有意兜底**（`有意兜底：`）——准许存在，但不准许"没想过就吞掉" */
    const tells =
      /throw /.test(window) ||
      /status: 'rejected'/.test(window) ||
      /docTouched/.test(window) ||
      /rolledBack/.test(window) ||
      /badLines/.test(window) ||
      /recordRejected/.test(window) ||
      /未能写入日志/.test(window) ||
      /有意兜底/.test(window);
    assert.equal(tells, true, `version.ts 第 ${i + 1} 个 catch 没有把失败说出来（既没抛、也没返回 rejected、也没写明是有意兜底）`);

    /* 更要紧的一条：catch 之后**不许走到成功路径**。
     * 纪律第 3 条禁的是"尽力而为掩盖质量状态"——在写正文的事务里，
     * 那具体就是"写失败了却让调用方以为写成了"。 */
    assert.equal(/status: 'applied'/.test(window), false, `version.ts 第 ${i + 1} 个 catch 之后出现了 status: 'applied' —— **失败被当成成功**，这正是纪律第 3 条禁的那种掩盖`);
  }
});
