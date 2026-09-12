#!/usr/bin/env node
/** AF 管线 · AI 调用台账（四方向方案 v2 批次 0a）
 *
 * 为什么需要：三档生成/三档精修/两轮调适 2026-09-12 换 ChatECNU 后是管线主力
 * 路径，但 callChat 不记 usage/finishReason——每章花了多少 token、有没有被截断，
 * 全都说不清（会话改写脚本一直有台账，主力路径反而没有）。
 *
 * 同一次调用落两份：
 *   ① _运行/token台账.jsonl —— 逐调用事件流，字段与会话改写的 stats 事件同口径
 *      （in/out/cached/finishReason）。**拿不到记 null，不伪造 'stop'**：
 *      "不知道"和"没截断"是两件事（会话改写踩过并固化的规矩）。
 *   ② _运行/AI成本台账_管线.csv —— 列序 = src/core/aiops.ts 的 COST_HEADER，
 *      与 App 的 reports_dir/AI成本台账.csv **同格式**，拼接后可直接喂 summarizeCost。
 *      刻意不与 App 共写一份：App 是读-改-写整文件，管线并发追加会互相覆盖；
 *      同格式分文件，互通靠拼接不靠共写。
 *
 * 台账写失败不拦生成（如实 warning 一次）——账坏不能把活干坏，口径同 App logCost。
 * 纯逻辑说明：本模块属于管线侧（tools/），允许用 fs；不带业务判断。
 */
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const SHARED = await import('./LayerText_AF词表与词典.mjs');

/**
 * 打开（或创建）一个脚本的调用台账。
 * 用法：const LEDGER = await openLedger(P, '三档生成');
 *       LEDGER.scene = { tier: 'A', chapter: '第一章', tag: 'R1' };   // 随循环更新
 *       const { content } = await LEDGER.call(messages, { baseUrl, key, model, maxTokens });
 *       LEDGER.flush();   // 收尾：追加累计 stats 事件并返回累计值
 */
export async function openLedger(P, script) {
  const { toCostLine, COST_HEADER, providerNameOf } = await import(`${SHARED.distOf(P.引擎目录)}/src/core/aiops.js`);
  const dir = join(P.产物目录, '_运行');
  const jsonl = join(dir, 'token台账.jsonl');
  const csv = join(dir, 'AI成本台账_管线.csv');
  let warned = false;
  const warnOnce = (e) => {
    if (warned) return;
    warned = true;
    console.warn(`⚠ 调用台账写不上（本次运行之后的用量不再记账）：${String(e).slice(0, 120)}`);
  };

  const ledger = {
    /** 调用上下文：脚本随循环更新（tier/chapter/tag 任一可空） */
    scene: { tier: '', chapter: '', tag: '' },
    stats: { calls: 0, ok: 0, err: 0, in: 0, out: 0, cached: 0 },

    /** 一次对话补全：记完台账再返回。HTTP 错误同样记账（ok:false, note=错误摘要）后原样抛出 */
    async call(messages, { baseUrl, key, model, maxTokens = 2500, errSlice = 200 }) {
      const t0 = Date.now();
      const ctx = { ...ledger.scene };
      const base = {
        t: 'call', at: new Date().toISOString(), script,
        tier: ctx.tier, chapter: ctx.chapter, tag: ctx.tag, model,
        inputTokens: null, cachedTokens: null, outputTokens: null, finishReason: null,
      };
      try {
        const resp = await fetch(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
          body: JSON.stringify({ model, max_tokens: maxTokens, messages }),
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${(await resp.text()).slice(0, errSlice)}`);
        const data = await resp.json();
        const u = data.usage ?? null;
        const finishReason = typeof data.choices?.[0]?.finish_reason === 'string'
          ? data.choices[0].finish_reason
          : null;
        ledger.emit(base, {
          ok: true,
          inputTokens: u?.prompt_tokens ?? null,
          cachedTokens: u?.prompt_cache_hit_tokens ?? null,
          outputTokens: u?.completion_tokens ?? null,
          finishReason,
          elapsedMs: Date.now() - t0,
        }, { baseUrl, toCostLine, csv, COST_HEADER, P });
        return {
          content: data.choices?.[0]?.message?.content ?? '',
          finishReason,
          usage: { in: u?.prompt_tokens ?? null, out: u?.completion_tokens ?? null, cached: u?.prompt_cache_hit_tokens ?? null },
        };
      } catch (e) {
        ledger.emit(base, { ok: false, note: String(e).slice(0, 120), elapsedMs: Date.now() - t0 }, { baseUrl, toCostLine, csv, COST_HEADER, P });
        throw e;
      }
    },

    /** 落两份台账并累计（内部用；写失败只 warning 一次，不拦调用） */
    emit(base, r, { baseUrl, toCostLine, csv, COST_HEADER, P }) {
      const evt = { ...base, ...r };
      try {
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        appendFileSync(jsonl, JSON.stringify(evt) + '\n', 'utf-8');
        if (!existsSync(csv)) appendFileSync(csv, COST_HEADER.join(',') + '\n', 'utf-8');
        appendFileSync(csv, toCostLine({
          ts: evt.at.replace('T', ' ').slice(0, 19),
          scene: `${evt.script}${evt.tag ? ':' + evt.tag : ''}`,
          book: P.书名 ?? '',
          chapter: `${evt.chapter}${evt.tier ? '·' + evt.tier : ''}`,
          provider: providerNameOf(baseUrl),
          model: evt.model,
          promptVer: evt.script,
          promptTokens: evt.inputTokens ?? undefined,
          completionTokens: evt.outputTokens ?? undefined,
          elapsedMs: evt.elapsedMs ?? 0,
          failover: false,
          ok: evt.ok,
          note: evt.note,
        }), 'utf-8');
      } catch (e) {
        warnOnce(e);
      }
      ledger.stats.calls++;
      if (evt.ok) {
        ledger.stats.ok++;
        ledger.stats.in += evt.inputTokens ?? 0;
        ledger.stats.out += evt.outputTokens ?? 0;
        ledger.stats.cached += evt.cachedTokens ?? 0;
      } else ledger.stats.err++;
    },

    /** 收尾：追加一条累计 stats 事件（与会话改写的 {t:'stats'} 同款），返回累计值 */
    flush() {
      try {
        if (ledger.stats.calls && existsSync(dir)) {
          appendFileSync(jsonl, JSON.stringify({ t: 'stats', at: new Date().toISOString(), script, v: ledger.stats }) + '\n', 'utf-8');
        }
      } catch (e) {
        warnOnce(e);
      }
      return ledger.stats;
    },
  };
  return ledger;
}
