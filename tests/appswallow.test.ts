/**
 * App 层「catch 不许静默吞掉」· 结构性守卫
 *
 * 来源：《LayerText 工程优化总计划》「最关键的代码纪律」第 3 条——
 * 「任何 catch 必须产生 warning/error event 或显式返回失败；禁止『尽力而为』掩盖质量状态。」
 *
 * 为什么 App 层要单独守一遍：`tests/discipline.test.ts` 守的是引擎（判定链路上一个 catch 都不许有、
 * 写正文那一个 catch 必须让人看得见）。App 层是另一回事——它**必须有** catch（磁盘会满、
 * 文件会被搬走、教师会中途取消），但它是教师唯一直接面对的一层：
 * 引擎那边"尽力而为"顶多让一个数不准，App 这边"尽力而为"就是计划里点名的那种症状——
 * 「点了没反应、卡片还在」：教师点了什么都没发生，也没有任何人告诉他为什么。
 *
 * 判据（每一个 catch 至少要占一样，四选一，**没有第五种**）：
 *   ① 说出去 —— 调了状态出口（toast / setStatus / onStatus / reportError / setStep / renderRiskPane flash…）
 *   ② 抛出去 —— `throw`
 *   ③ 显式返回失败 —— `return { ok: false, error }` / `reject(...)` / `warned:` / 返回值里明说是失败
 *   ④ 写明理由的**有意兜底** —— 注释里带 `有意兜底：`，把"为什么这样吞是可以的"写清楚
 *
 * 为什么用 TypeScript 编译器而不是正则：这个仓库的注释里**本来就出现过**「被 catch 静默吞掉」
 * 「这个 catch 静默吞掉」这类话（`app/src/datapanel.ts`），裸正则会把它数成一处 catch；
 * 模板字符串与正则字面量里的花括号也会把"数到哪儿结束"搞错。编译器 API 给的是真正的语法树，
 * 顺带还能把 catch 前面那段注释一起算进来（④ 的标记常常写在上面一行）。
 *
 * 守卫本身有效吗：见本文件最后一条用例——它把违规注入**合成源码**后再跑同一套判据，
 * 断言"该报的报出来、合规的不误伤"。也就是说这条守卫不是"永远为真"的摆设。
 */

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const APP_SRC = join(REPO, 'app', 'src');

/**
 * 「失败说得出口」的形状清单。
 *
 * 每一条都是**这个仓库里真实存在**的写法，写在这里是为了让下一个人一眼看到
 * "什么样的出口算数"——而不是自己发明一个新出口再把它加进白名单。
 * 加之前先问一句：加进来以后，`catch { }` 这种形状还拦得住吗？拦不住就别加。
 */
export const SURFACES: { re: RegExp; why: string }[] = [
  /* ① 说出去：四个状态出口 + 两处面板自带的"把话说出来"位 */
  { re: /toast\(/, why: 'toast 弹窗（uikit.ts）' },
  { re: /setStatus\(/, why: '状态行（uikit.ts）' },
  { re: /onStatus/, why: '可注入的状态出口（ai.ts / review.ts，供无界面测试注入）' },
  { re: /reportError\(/, why: '本地错误日志（report.ts，会进诊断包）' },
  { re: /setStep\(/, why: '批处理的进度行（batch.ts，对话框里那一行）' },
  { re: /renderRiskPane\(/, why: '风险面板页首那条 flash（risk.ts 自己的"说出口"）' },
  { re: /\.(textContent|innerHTML)\s*=/, why: '就地写进界面（弹层/面板/步骤行）' },
  /* ② 抛出去 */
  { re: /\bthrow\b/, why: '抛给上层' },
  /* ③ 显式返回失败（具体的失败对象/字段，不是"空值") */
  { re: /return \{ ok: false/, why: '显式失败返回（{ ok: false, error/message }）' },
  { re: /reject\(/, why: 'adoptrewrite 的显式失败返回' },
  { re: /warned:/, why: 'datapanel 的"改动成功但留痕失败"显式警告' },
  { re: /\berrs[:.]/, why: 'datapanel 的校验错误（渲染进面板与页签徽标）' },
  { re: /\berror = /, why: 'risk 的 error 字段（渲染进面板）' },
  { re: /return .{0,40}(失败|错误|出错|读不到|没核到|不可信)/, why: '返回值/文案里明说是失败（不装作成功）' },
  /* ③' 把"少了什么"记进账再渲染出来——这是本次审计为 App 层补的一类出口 */
  { re: /(ankiMisses|skippedTargets|missing|failedFiles|skipped)\.push\(/, why: '把"跳过/没装进去/没读到"的记进账，随后渲染出来' },
  { re: /unread\+\+/, why: '把读不到的文件计入账，随后写进 notes（rewritegate 的已注词账本）' },
  { re: /riskError\b/, why: '把失败带出函数的字段（grading 的 riskError，报告与 AI 摘要里点名）' },
  { re: /failed: true/, why: '整行不可信的显式标记（grading 的班级批改行）' },
  { re: /没核到/, why: '把"没核到"与"0"分开的返回值（报告里渲染成 —，不是 0）' },
  /* ④ 写明理由的有意兜底（准许存在，但不准许"没想过就吞掉"） */
  { re: /有意兜底/, why: '写明理由的有意兜底（含"交给调用方说"的交接）' },
];

/**
 * ④ 的写法标记——**在带注释的原文里查**（剥掉注释后它们就没了）。
 *   · `有意兜底：`  —— 允许存在，但不允许"没想过就吞掉"：理由必须写在这处 catch 里或它上面一行
 *   · `没核到`      —— 本次审计为 App 层补的一类明确用词：把"没核到"与"0/空"分开的返回值
 *                      （`countRuleLeft` 解析失败时返回 null 而不是 0，报告里渲染成"—（没核到）"）
 */
const REASONS = /有意兜底|没核到/;

interface Finding {
  file: string;
  line: number;
  kind: 'try' | 'promise';
  /** 命中的出口（没命中＝这处 catch 在静默吞掉） */
  surface?: string;
  /** 这一处是不是靠「有意兜底：」这项豁免过的 */
  marked: boolean;
  /** 供报错信息用的片段 */
  snippet: string;
}

/**
 * 把注释换成等长空格（用编译器的词法扫描器，字符串/模板里的 `//`、`/*` 不会被误当成注释）。
 *
 * 为什么要这一步：判据是"catch 里**调了**出口"，而"把出口注释掉"恰好是最容易发生的假修复
 * （去掉一行、留个 `// setStatus(…)`）。不剥注释的话，那种代码会被判成合规——
 * 这条守卫会在最需要它的那一刻失效。剥掉注释之后，「有意兜底」那项单独在原文里查（它是注释，本来就不该被剥）。
 */
function stripComments(text: string): string {
  const scanner = ts.createScanner(ts.ScriptTarget.ES2022, /* skipTrivia */ false, ts.LanguageVariant.Standard, text);
  let out = '';
  let pos = 0;
  for (let kind = scanner.scan(); kind !== ts.SyntaxKind.EndOfFileToken; kind = scanner.scan()) {
    const start = scanner.getTokenPos();
    const end = scanner.getTextPos();
    out += text.slice(pos, start);
    out += kind === ts.SyntaxKind.SingleLineCommentTrivia || kind === ts.SyntaxKind.MultiLineCommentTrivia ? ' ' : text.slice(start, end);
    pos = end;
  }
  return out + text.slice(pos);
}

/**
 * 扫一个源文件，返回每一处 catch 的判定。
 *
 * 取的是「这个 catch 自己 ＋ 它上面那几行注释」这一段。两个刻意的取舍：
 *   · **要算上 catch 上面的注释**——「有意兜底：…」的理由常常写在 try 那一行之前，
 *     只看 catch 的括号里会把这类合规写法误判成违规，误报多了守卫就会被关掉。
 *   · **不算 try 里那一大段代码**——那样 `try { setStatus(…) } catch { }`
 *     （状态行写在 try 里、catch 里什么都不做）会被算成"说得出口"，而它恰恰是要拦的那种。
 */
export function scanSource(file: string, text: string): Finding[] {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const out: Finding[] = [];
  /** 这个 catch 上面那几行注释（只看最近的外层语句之前的那一段） */
  const leadingComments = (node: ts.Node): string => {
    let n: ts.Node | undefined = node;
    while (n && !ts.isStatement(n)) n = n.parent;
    if (!n) return '';
    const ranges = ts.getLeadingCommentRanges(text, n.getFullStart()) ?? [];
    return ranges.map((r) => text.slice(r.pos, r.end)).join('\n');
  };
  const visit = (node: ts.Node): void => {
    const isCatch = ts.isCatchClause(node);
    /* `.catch(fn)` 也算：`x.catch(() => undefined)` 与 `catch { }` 是同一种静默 */
    const isPromiseCatch = ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'catch';
    if (isCatch || isPromiseCatch) {
      /* promise 链只看 `.catch(...)` 那一段：链前面 `.then(() => setStatus(…))` 不算它的出口；
       * try 也只取 catch 自己，不取 try 里那一大段（否则"状态行写在 try 里、catch 空着"会被放行） */
      const body = isCatch ? text.slice(node.getStart(sf), node.getEnd()) : text.slice(node.expression.getStart(sf), node.getEnd());
      const region = `${leadingComments(node)}\n${body}`;
      /* 判据跑在"没有注释的这段"上：注释掉的 `// setStatus(…)` 不算出口 */
      const codeOnly = stripComments(region);
      out.push({
        file,
        line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
        kind: isCatch ? 'try' : 'promise',
        surface: SURFACES.find((s) => s.re.test(codeOnly))?.why,
        marked: REASONS.test(region),
        snippet: region.replace(/\s+/g, ' ').trim().slice(-120),
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/** 扫整个 App 层（含全部 .ts，纯函数模块也算——它们将来一样会被人加 catch） */
function scanApp(): Finding[] {
  return readdirSync(APP_SRC)
    .filter((f) => f.endsWith('.ts'))
    .sort()
    .flatMap((f) => scanSource(f, readFileSync(join(APP_SRC, f), 'utf-8')));
}

/* ────────────────────── 纪律 3（App 层）：catch 不许静默吞掉 ────────────────────── */

test('★ App 层每一个 catch 都必须**让失败说得出口**（说出去/抛出去/显式失败/写明有意兜底）', () => {
  const findings = scanApp();
  /* 先钉住"确实扫到了东西"：目录改名、过滤写错、编译器 API 变了，
   * 都会让下面这条断言在**零命中**的情况下"通过"——那才是真正危险的那种绿。 */
  assert.ok(findings.length >= 140, `只扫到 ${findings.length} 处 catch，比实际少太多——扫描本身很可能坏了（app/src 还在吗？），先修扫描再看结论`);
  const silent = findings.filter((f) => !f.surface && !f.marked);
  assert.equal(
    silent.length,
    0,
    '这些 catch 把错误吞了（既没说出去、也没抛、也没显式返回失败、也没写「有意兜底：」）：\n' +
      silent.map((f) => `  · ${f.file}:${f.line} [${f.kind}] ${f.snippet}`).join('\n') +
      '\n\n四选一，没有第五种。若这处确实是"正常状态不是错误"，请把理由写成 `有意兜底：…` 放在 catch 里或其上一行。',
  );
});

test('★ 「有意兜底」的标记还活着（不是有人把它删光了却没人发现）', () => {
  /* 上面那条判据允许用标记换取豁免。豁免额度必须有下限，否则"把标记全删掉、
   * 再把判据改成永远为真"这种退化不会有人察觉——这个仓库上一次就是这么失效的。 */
  const marked = scanApp().filter((f) => f.marked);
  assert.ok(marked.length >= 60, `只找到 ${marked.length} 处写明理由的有意兜底，比实际少太多——判据或标记可能已经失效`);
});

test('★ 守卫自己有效：把违规注入合成源码，同一套判据必须当场拦下', () => {
  /* 这一条是"守卫不是摆设"的**活证据**（不是注释里的一句话）：
   * 下面这份合成源码里既有合规形状，也有三类典型的静默吞（空 catch / 吞成空值 / 吞成 0），
   * 判据必须**只**拦下后面那几处。 */
  const injected = `
export function demo(): number {
  try {
    return JSON.parse('{}').n ?? 0;
  } catch {
    /* 违规 1：什么都没干 */
  }
  try {
    return load().length;
  } catch {
    /* 违规 2：吞成空值，上层看不出"没读到"与"本来是空"的区别 */
    return [];
  }
  try {
    return count();
  } catch {
    /* 违规 3：兜成一个数字 0——正是"用一个假的 0 替质量状态签字" */
    return 0;
  }
  try {
    return read();
  } catch (e) {
    /* 合规：说了出去 */
    toast('读不到：' + e, 'err');
    return 0;
  }
  try {
    return read();
  } catch {
    /* 合规：有意兜底：这份配置本来就允许不存在，缺了按默认值走 */
    return 0;
  }
  return 0;
}
`;
  const found = scanSource('合成.ts', injected);
  assert.equal(found.length, 5, '合成源码里有 5 处 catch，扫描没数对');
  const silent = found.filter((f) => !f.surface && !f.marked);
  assert.deepEqual(
    silent.map((f) => f.line),
    [5, 10, 16],
    '注入的三处静默吞（第 5/10/16 行）必须被拦下，且两处合规的不许被误伤',
  );
  assert.ok(/什么都没干/.test(silent[0]!.snippet), '第 5 行那处应当在列（空 catch）');
  assert.ok(/吞成空值/.test(silent[1]!.snippet), '第 10 行那处应当在列（吞成 `[]`）');
  assert.ok(/假的 0/.test(silent[2]!.snippet), '第 16 行那处应当在列（吞成 `0`）');
  /* 反面：合规的两处必须认出来，否则这条守卫就是在乱杀，迟早被人关掉 */
  assert.ok(found[3]?.surface, '调了 toast 的那处应当算"说得出口"');
  assert.equal(found[4]?.marked, true, '写了「有意兜底：」的那处应当算合规');
});

test('★ 守卫的判据不认"空 catch"这种白板形状（哪怕它裹着花括号与注释）', () => {
  /* 只写注释、什么都不做，是最容易被写出来的那种吞。它必须失败——
   * 上面的合成用例已经覆盖一次，这里再单独钉一条，防止有人把判据放宽到"有注释就算合规"。 */
  const onlyComment = `function f() { try { g(); } catch { /* 出错了 */ } }`;
  const found = scanSource('合成.ts', onlyComment);
  assert.equal(found.length, 1);
  assert.equal(found[0]!.surface, undefined, '「catch { /* 出错了 */ }」不许算合规——注释不是出口');
});
