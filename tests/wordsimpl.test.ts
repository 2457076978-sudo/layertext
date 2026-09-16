/**
 * applyWordSimplifications 原样直测（2026-09-16，核心链补测第 ① 位——不拆生产代码，L3 端到端）。
 *
 * 三条产品纪律各至少一条 case（(a) 最重）：
 *   (a) 教师亲手指定的替换词，AI 不得覆盖——两道防线都验：needAi 排除（连问都不问）+ 指定词最后覆盖
 *   (b) 同一词一次决策（uniq Map），正文内多处命中全部替换、互不错位
 *   (c) AI 兜底路径——无指定的词走 AI 表；AI 值含中文 → 拒用 → 降级本地词典加注
 *
 * ── mockIPC 协议知识（2026-09-16 活探针实测，见 CHANGELOG）──────────────────
 * AI 注入走 plugin-http 的三条 invoke 命令：
 *   plugin:http|fetch          → 入参 clientConfig（.data = 请求体 JSON 串），返回 rid
 *   plugin:http|fetch_send     → 返回 { status, statusText, url, headers: [[k,v]], rid }
 *   plugin:http|fetch_read_body→ **分块字节流协议**：数据块 = [...字节, 0]（末位 0=后续还有），
 *                                终止块 = [1]（末位 1=流结束，本块不携带数据）。
 *                                喂错会 OOM（0 循环）或拿到空体（把 1 拼在数据块尾部）。
 * 另需 load_api_key（钥匙串）+ 文件三命令 + dict_lookup_zh（本地词典，降级加注用）。
 * ──────────────────────────────────────────────────────────────────────
 *
 * 夹具表驱动，预留「语法档」参数位（备案：未系统学/学过没把握/扎实，现仅缺省档；
 * 落地后本表加一列即可参数化，不把断言写死单档）。
 */

import './_dom_env.js'; // 必须第一个：uikit 等在顶层挂 window 事件
import test from 'node:test';
import assert from 'node:assert/strict';
import { mockIPC, clearMocks } from '@tauri-apps/api/mocks';
import type { FileSession, Mark } from '../app/src/types.js';
/* app 模块一律动态 import：?raw 钩子在 _dom_env 求值时注册，静态导入的链接先于注册、
 * 会在无钩子状态下解析 `assets/*.txt?raw` 而失败。 */
const { applyWordSimplifications } = await import('../app/src/pipew.js');
const { uibus } = await import('../app/src/uibus.js');
const { S } = await import('../app/src/state.js');

/* 测试扮演 main.ts 的装配角色：注册本路径会触发的总线槽位（服务定位器的用法即如此） */
Object.assign(uibus, { flashApplied: () => undefined });

/* ────────────────────── mock 后端：内存文件表 + AI/词典捕获 ────────────────────── */

interface Backend {
  files: Record<string, string>;
  writes: { path: string; content: string }[];
  aiRequests: { model: string; userContent: string }[];
  aiTable: Record<string, string>;
  dict: Record<string, string>;
  nextBody: string; // 当前 AI 响应体（fetch 命令时生成，read_body 时消费）
}

function installBackend(b: Backend): void {
  let bodySent = false;
  const enc = new TextEncoder();
  mockIPC((cmd: string, args: Record<string, unknown>) => {
    switch (cmd) {
      case 'load_api_key':
        return 'test-key';
      case 'plugin:http|fetch': {
        /* 请求体 data 是**字节数组**（plugin-http 序列化形态），先解码再 parse（2026-09-16 探针实证） */
        const raw = (args.clientConfig as { data?: unknown }).data;
        const rawStr = typeof raw === 'string' ? raw : String.fromCharCode(...(raw as number[]));
        const body = JSON.parse(rawStr) as {
          model?: string;
          messages?: { role: string; content: string }[];
        };
        const user = (body.messages ?? [])
          .filter((m) => m.role === 'user')
          .map((m) => m.content)
          .join('\n');
        b.aiRequests.push({ model: body.model ?? '', userContent: user });
        const content = JSON.stringify(b.aiTable);
        b.nextBody = JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
        bodySent = false;
        return 1;
      }
      case 'plugin:http|fetch_send':
        return { status: 200, statusText: 'OK', url: 'https://mock/v1/chat/completions', headers: [['content-type', 'application/json']], rid: 2 };
      case 'plugin:http|fetch_read_body': {
        const full = b.nextBody;
        const bytes = Array.from(enc.encode(full));
        if (!bodySent) {
          bodySent = true;
          return [...bytes, 0]; // 数据块：末位 0 = 后续还有
        }
        return [1]; // 终止块：末位 1 = 流结束（本块无数据）
      }
      case 'read_text_file': {
        const p = String(args.path);
        if (p in b.files) return b.files[p]!;
        throw new Error(`no such file: ${p}`);
      }
      case 'describe_path': {
        const p = String(args.path);
        return p in b.files ? 'exists' : 'missing';
      }
      case 'write_text_file':
        b.writes.push({ path: String(args.path), content: String(args.content) });
        b.files[String(args.path)] = String(args.content);
        return null;
      case 'append_text_file': {
        const p = String(args.path);
        b.files[p] = (b.files[p] ?? '') + String(args.content);
        return null;
      }
      case 'dict_lookup_zh': {
        const words = args.words as string[];
        return words.map((w) => b.dict[w] ?? null);
      }
      case 'reports_dir':
        return '/rep';
      default:
        throw new Error(`wordsimpl 测试后端不认识命令: ${cmd}`);
    }
  });
}

/* ────────────────────── 夹具 ────────────────────── */

const mdOf = (...paras: string[]): string => `## Chapter One\n\n${paras.map((p, i) => `[P${String(i + 1).padStart(2, '0')}] ${p}`).join('\n\n')}\n`;

const mk = (id: string, word: string, pi: number, over: Partial<Mark> = {}): Mark => ({ id, level: 'word', pi, si: 0, word, type: 'simpl', ts: 1, ...over }) as Mark;

const sess = (md: string, marks: Mark[]): FileSession =>
  ({
    md,
    fileName: 'ch.md',
    sourcePath: '/b/ch.md',
    markPath: '/b/ch_审校标记.json',
    review: { marks, warns: [], quota: [], gate: {}, bookmarks: [], updatedAt: 0 },
    report: null,
    reportSavedPath: null,
    dirty: false,
  }) as unknown as FileSession;

/* 表驱动（语法档位预留：备案字段，现仅缺省档） */
interface CaseRow {
  name: string;
  md: string;
  marks: Mark[];
  ai: Record<string, string>;
  dict?: Record<string, string>;
  语法档?: '未系统学' | '学过没把握' | '扎实';
  expect: { mdIncludes: string[]; mdExcludes: string[]; aiUserMustExclude?: string[]; aiCalls: number; marksLeft: number };
}

const CASES: CaseRow[] = [
  {
    name: '(a) 教师指定优先：AI 连问都不问，诱惑值不出现',
    md: mdOf('The cynical boy was cynical again.'),
    marks: [mk('a1', 'cynical', 0, { note: '教师指定替换：cynical → doubtful' })],
    ai: { cynical: 'bitter' }, // 诱惑值：若防线破，教师词会被它覆盖
    expect: {
      mdIncludes: ['doubtful boy', 'doubtful again'],
      mdExcludes: ['cynical', 'bitter'],
      aiUserMustExclude: ['cynical'],
      aiCalls: 0, // 第一道防线：教师指定的词不进 AI 输入（本例全部由教师指定 → 一次 AI 都不发）
      marksLeft: 0,
    },
  },
  {
    name: '(b) 同词一次决策：uniq Map，段内 3 处全部替换、互不破坏',
    md: mdOf('The abandoned farm had abandoned tools and an abandoned house.'),
    marks: [mk('b1', 'abandoned', 0), mk('b2', 'abandoned', 0), mk('b3', 'abandoned', 0)],
    ai: { abandoned: 'left alone' },
    expect: {
      mdIncludes: ['The left alone farm had left alone tools and an left alone house.'],
      mdExcludes: ['abandoned'],
      aiCalls: 1,
      marksLeft: 0, // 同词其余标记一并完成
    },
  },
  {
    name: '(c) AI 兜底 + 中文诱惑拒用降级：furious 走 AI，gorgeous 拒换改本地加注',
    md: mdOf('The furious boy saw a gorgeous car.'),
    marks: [mk('c1', 'furious', 0), mk('c2', 'gorgeous', 0)],
    ai: { furious: 'angry', gorgeous: '华丽的' }, // gorgeous 的 AI 值含中文 → 边界防线拒用
    dict: { gorgeous: '极好的' }, // 降级：本地词典加注
    expect: {
      mdIncludes: ['The angry boy', 'gorgeous（极好的）'],
      mdExcludes: ['furious', '华丽的'],
      aiCalls: 1,
      marksLeft: 0,
    },
  },
];

for (const row of CASES) {
  test(`applyWordSimplifications · ${row.name}`, async () => {
    const b: Backend = { files: {}, writes: [], aiRequests: [], aiTable: row.ai, dict: row.dict ?? {}, nextBody: '{}' };
    installBackend(b);
    S.appConfig.aux = { enabled: false };
    S.appConfig.baseUrl = 'https://mock/v1'; // 不设则 activeTargets 为空，AI 调用前就败（探针实证）
    S.appConfig.model = 'fake-model';
    S.currentKnown = new Set(['the', 'boy', 'saw', 'a', 'car', 'farm', 'had', 'tools', 'and', 'an', 'house', 'again']);
    const s = sess(
      row.md,
      row.marks.map((m) => ({ ...m })),
    );

    await applyWordSimplifications(s, s.review.marks);

    for (const inc of row.expect.mdIncludes) assert.ok(s.md.includes(inc), `正文应含「${inc}」，实得：${s.md}`);
    for (const exc of row.expect.mdExcludes) assert.ok(!s.md.includes(exc), `正文不应再含「${exc}」，实得：${s.md}`);
    assert.equal(b.aiRequests.length, row.expect.aiCalls, `AI 请求次数应为 ${row.expect.aiCalls}（实得 ${b.aiRequests.length}）`);
    for (const w of row.expect.aiUserMustExclude ?? []) assert.ok(!b.aiRequests.some((r) => r.userContent.includes(w)), `教师指定的「${w}」不得出现在 AI 请求里——防线一是 needAi 排除`);
    assert.equal(s.review.marks.filter((m) => m.level !== 'sent').length, row.expect.marksLeft, '词级标记应清理到位');
    /* 变更日志落盘（段4 的一部分，顺手锁定） */
    const log = b.writes.find((w) => w.path.includes('变更日志_AI审核.csv'));
    assert.ok(log, '变更日志应写入');
    clearMocks();
    clearTimeout((s as FileSession & { _t?: ReturnType<typeof setTimeout> })._t);
  });
}
