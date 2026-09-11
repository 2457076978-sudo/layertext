// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// © 2026 Wayne（LayerText 作者）。本文件为判定引擎核心，本仓库已部署版权验证体系，细节不予公开（docs/版权与授权.md）。
/**
 * LayerText · 决定索引（SQLite，可查询；JSONL 仍是正本）
 *
 * 审查报告 §四 的原话：「文件作为数据层在需要版本、并发、查询『**某位教师对某词的所有决定**』时崩溃；
 * 不必立刻上重型数据库，可先用 SQLite manifest + append-only events，产物仍导出 Markdown/JSON。」
 *
 * 分工（这是本模块存在的全部理由）：
 *   · **JSONL 是正本**：append-only、人可读、可 git、坏了只坏一行；
 *   · **SQLite 是索引**：可以随时删掉重建（`rebuild`），它不产生任何新事实。
 *   所以任何"从 SQLite 读到的东西"都必须能由 JSONL 重放出来——否则就是又一处口径漂移。
 *
 * 为什么需要它：一百名学生/多位教师的场景下，"某位教师对某个词做过的所有决定"
 * 是最高频的查询（离线汇总器提议入库前要它，教师复核自己的判断也要它），
 * 而拿 JSONL 每次全量扫一遍在几百次运行之后就不好用了。
 *
 * 实现用 Node 内置 `node:sqlite`（22.5+，实验特性）：不引第三方依赖、
 * 与"本地、零遥测"的项目定位一致。没有它时本模块整体降级为"不可用"，
 * 调用方回落到 JSONL 全扫——功能不缺席，只是慢。
 */

import { createRequire } from 'node:module';

import type { DecisionEvent, DecisionKind } from './decision.js';

/** 一条决定在索引里的行（与 DecisionEvent 同形，只是摊平了 subject） */
export interface DecisionRow {
  itemId: string;
  decision: DecisionKind;
  before: string;
  after: string;
  reason: string;
  ruleIds: string;
  teacherId: string;
  timestamp: string;
  sourceVersion: string;
  book: string;
  chapter: string;
  tier: string;
  segIndex: number | null;
  subjectKind: string;
  subjectValue: string;
  /** 词的归一键（小写）：查询"某词的所有决定"靠它 */
  word: string;
}

export const rowOf = (e: DecisionEvent): DecisionRow => ({
  itemId: e.itemId,
  decision: e.decision,
  before: e.before,
  after: e.after,
  reason: e.reason,
  ruleIds: e.ruleIds.join('+'),
  teacherId: e.teacherId,
  timestamp: e.timestamp,
  sourceVersion: e.sourceVersion,
  book: e.book ?? '',
  chapter: e.chapter ?? '',
  tier: e.tier ?? '',
  segIndex: e.segIndex ?? null,
  subjectKind: e.subject?.kind ?? '',
  // 词/数字/专名都归一到小写，查"某词"时不必区分它是哪一类
  subjectValue: e.subject?.value ?? '',
  word: (e.subject?.value ?? '').toLowerCase(),
});

export interface DecisionQueryInput {
  teacherId?: string;
  /** 按词（或数字/专名）查——报告点名的那一句 */
  word?: string;
  ruleId?: string;
  decision?: DecisionKind;
  book?: string;
  tier?: string;
  /** 只返回某个时间点之后的（`2026-09-11T00:00:00Z`） */
  since?: string;
  limit?: number;
}

/** SQLite 索引的驱动接口（把 node:sqlite 收在这一个口子里，便于测试与降级） */
export interface SqliteLike {
  exec(sql: string): void;
  prepare(sql: string): { run(...args: unknown[]): unknown; all(...args: unknown[]): unknown[] };
  close(): void;
}

export class DecisionStore {
  private db: SqliteLike | null;

  constructor(db: SqliteLike | null) {
    this.db = db;
    if (db) {
      db.exec(`CREATE TABLE IF NOT EXISTS decisions (
        itemId TEXT NOT NULL, decision TEXT NOT NULL, before TEXT, after TEXT, reason TEXT,
        ruleIds TEXT, teacherId TEXT NOT NULL, timestamp TEXT NOT NULL, sourceVersion TEXT,
        book TEXT, chapter TEXT, tier TEXT, segIndex INTEGER,
        subjectKind TEXT, subjectValue TEXT, word TEXT,
        PRIMARY KEY (itemId, timestamp, decision)
      )`);
      db.exec('CREATE INDEX IF NOT EXISTS idx_dec_word ON decisions(word)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_dec_teacher ON decisions(teacherId)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_dec_rule ON decisions(ruleIds)');
    }
  }

  /** 可用吗（没有 node:sqlite 时为 false，调用方回落到 JSONL 全扫） */
  get available(): boolean {
    return this.db !== null;
  }

  /**
   * 灌入事件。**幂等**：主键是 (itemId, timestamp, decision)，同一份日志灌两次不会翻倍。
   * 这也是"可随时删掉重建"的前提。
   */
  ingest(events: DecisionEvent[]): number {
    if (!this.db) return 0;
    const stmt = this.db.prepare(
      'INSERT OR IGNORE INTO decisions VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    );
    let n = 0;
    for (const e of events) {
      const r = rowOf(e);
      stmt.run(
        r.itemId, r.decision, r.before, r.after, r.reason, r.ruleIds, r.teacherId, r.timestamp,
        r.sourceVersion, r.book, r.chapter, r.tier, r.segIndex, r.subjectKind, r.subjectValue, r.word,
      );
      n++;
    }
    return n;
  }

  /** 清空重建（索引不是正本，任何时候都可以重建） */
  rebuild(events: DecisionEvent[]): number {
    if (!this.db) return 0;
    this.db.exec('DELETE FROM decisions');
    return this.ingest(events);
  }

  query(q: DecisionQueryInput): DecisionRow[] {
    if (!this.db) return [];
    const where: string[] = [];
    const args: unknown[] = [];
    const eq = (col: string, v: unknown): void => {
      where.push(`${col} = ?`);
      args.push(v);
    };
    if (q.teacherId) eq('teacherId', q.teacherId);
    if (q.word) eq('word', q.word.toLowerCase());
    if (q.decision) eq('decision', q.decision);
    if (q.book) eq('book', q.book);
    if (q.tier) eq('tier', q.tier);
    // ruleIds 是 `A+B` 拼起来的：查单条规则要按"分隔符包围"匹配，不能 substr 蒙
    if (q.ruleId) {
      where.push("('+' || ruleIds || '+') LIKE ?");
      args.push(`%+${q.ruleId}+%`);
    }
    if (q.since) {
      where.push('timestamp >= ?');
      args.push(q.since);
    }
    const sql = `SELECT * FROM decisions${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY timestamp DESC, itemId LIMIT ?`;
    args.push(q.limit ?? 200);
    return this.db.prepare(sql).all(...args) as DecisionRow[];
  }

  /** 报告点名的那一句：某位教师对某词的所有决定（不带 teacherId = 所有人对这个词的决定） */
  decisionsAbout(word: string, teacherId?: string): DecisionRow[] {
    return this.query({ word, teacherId, limit: 1000 });
  }

  /**
   * 按规则聚合：误报率是规则噪音水平的直接度量（与 summarizeDecisions 同一口径的查询版）。
   *
   * ruleIds 在行里是 `A+B` 拼起来的，而一条决定可能同时挂着两条规则——
   * 所以**不能** `GROUP BY ruleIds` 之后再拆：那样 `ANNO-01` 与 `ANNO-01+FACT-02`
   * 会各出一行，同一个规则在结果里出现两次、数字还各算各的（第一版就是这个错）。
   * 正确做法是按 (ruleIds, decision) 取计数，再在累加时把每条规则的计数摊回去。
   */
  byRule(): { ruleId: string; total: number; falsePositive: number }[] {
    if (!this.db) return [];
    const rows = this.db
      .prepare('SELECT ruleIds, decision, COUNT(*) AS n FROM decisions GROUP BY ruleIds, decision')
      .all() as { ruleIds: string; decision: string; n: number }[];
    const acc = new Map<string, { total: number; falsePositive: number }>();
    for (const r of rows) {
      for (const id of String(r.ruleIds).split('+').filter(Boolean)) {
        const cur = acc.get(id) ?? { total: 0, falsePositive: 0 };
        cur.total += Number(r.n);
        if (r.decision === 'false-positive') cur.falsePositive += Number(r.n);
        acc.set(id, cur);
      }
    }
    return [...acc]
      .map(([ruleId, v]) => ({ ruleId, ...v }))
      .sort((a, b) => b.total - a.total || (a.ruleId < b.ruleId ? -1 : 1));
  }

  count(): number {
    if (!this.db) return 0;
    const r = this.db.prepare('SELECT COUNT(*) AS n FROM decisions').all() as { n: number }[];
    return Number(r[0]?.n ?? 0);
  }

  close(): void {
    this.db?.close();
    this.db = null;
  }
}

/**
 * 打开索引。拿不到 `node:sqlite` 时返回一个 `available=false` 的 store，
 * 调用方据此回落到 JSONL 全扫——**功能不缺席，只是慢**。
 */
export function openDecisionStore(path: string, loader?: () => SqliteLike): DecisionStore {
  try {
    const db = loader ? loader() : defaultLoader(path);
    return new DecisionStore(db);
  } catch {
    return new DecisionStore(null);
  }
}

function defaultLoader(path: string): SqliteLike {
  // `node:sqlite` 在旧版 Node 上不存在，静态 import 会让整个模块加载失败，所以延迟取。
  // 取它的**方式**要注意：本文件是 ESM，没有 `require` 全局——
  // 曾经写成 `require('node:module')`，抛 ReferenceError 后被外层 try/catch 吞掉，
  // 表现成"索引永远不可用"（静默降级，最难查的那种）。createRequire 静态 import 才对。
  const sqlite = createRequire(import.meta.url)('node:sqlite') as { DatabaseSync: new (p: string) => SqliteLike };
  return new sqlite.DatabaseSync(path);
}
