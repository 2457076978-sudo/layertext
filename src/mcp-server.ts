#!/usr/bin/env node
/**
 * LayerText MCP Server（stdio）——把质检引擎接进任何 MCP 客户端
 * （Claude Desktop / ZCode / Cursor 等）
 *
 * 启动：
 *   node dist/src/mcp-server.js [--vocab 教材词库.csv]... [--wordlist 词表.txt]... [--terms 术语.txt] [--proper 专名.txt]
 *
 * 工具（9 个，全部本地计算、零遥测、不落盘）：
 *   layer_qc              全文体检：生词率/覆盖率/句长/被动/定从/过去完成/OOV清单
 *   layer_word_status     单词词表状态与原形（词库=难度锚点）
 *   layer_sentence_risks  句法黑名单逐句检测（被动/定从/过去完成/超长）
 *   layer_check_revision  改写句复核：AI 改写后自查黑名单与超长残留
 *   layer_align           两版逐句核对：丢句/新增/数字专名缺失（简化交付前机器核对）
 *   layer_rework_gates    回炉四闸：一段改写自查（红词必减/段长比/注释不丢/句长·引语豁免）
 *   layer_rework_ledger   回炉台账汇总：挂起按原因分组 + 下一轮建议顺序
 *   layer_source_probe    R0 源完整性探针：词数骤降/章末无收束/碎片残留
 *   layer_acceptance_v2   验收 v2 七维度（可本地计算子集）：未注率排序/同段倒挂/句长梯度/注密度/结构/语义
 *
 * 配置示例见 docs/MCP.md。
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { readWordFile } from './core/files.js';
import { parseZipfTable, type ZipfTable } from './core/wordfreq.js';
import {
  buildMcpLexicon,
  toolAcceptanceV2,
  toolAlignPairs,
  toolCheckRevision,
  toolQcText,
  toolReworkGates,
  toolReworkLedger,
  toolSentenceRisks,
  toolSourceProbe,
  toolWordStatus,
  type McpLexiconOptions,
} from './core/mcpTools.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** 内置词表（课标1600 + 补录）——词库三源之一 */
function bundledWordlists(): string[] {
  const files = [join(ROOT, 'assets', 'wordlists', 'curriculum_2022_level3_1600.txt'), join(ROOT, 'assets', 'wordlists', 'curriculum_2022_amendment.txt')];
  return files.map((f) => readFileSync(f, 'utf-8'));
}

/** 词频/习得年龄先验表（wordfreq + Kuperman 2012 AoA，纯离线）——OOV"疑似漏收"双信号分诊；缺失时跳过分诊列 */
function bundledZipfTable(): ZipfTable | undefined {
  try {
    return parseZipfTable(readFileSync(join(ROOT, 'assets', 'wordfreq', 'en_zipf.tsv'), 'utf-8'));
  } catch {
    return undefined;
  }
}

function bundledAoaTable(): ZipfTable | undefined {
  try {
    return parseZipfTable(readFileSync(join(ROOT, 'assets', 'wordfreq', 'en_aoa.tsv'), 'utf-8'));
  } catch {
    return undefined;
  }
}

function parseArgs(argv: string[]): McpLexiconOptions {
  const opts: McpLexiconOptions = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--vocab') (opts.vocabCsvTexts ??= []).push(readFileSync(next(), 'utf-8'));
    else if (a === '--wordlist') (opts.plainWordlistTexts ??= []).push(readFileSync(next(), 'utf-8'));
    else if (a === '--terms') opts.terms = readWordFile(next());
    else if (a === '--proper') opts.properNouns = readWordFile(next());
    else if (a === '-h' || a === '--help') {
      console.error('用法: node dist/src/mcp-server.js [--vocab x.csv]... [--wordlist x.txt]... [--terms x.txt] [--proper x.txt]');
      process.exit(0);
    }
  }
  return opts;
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const lex = buildMcpLexicon(opts, bundledWordlists());
  const zipf = bundledZipfTable();
  const aoa = bundledAoaTable();

  const server = new McpServer(
    { name: 'layertext-qc', version: '1.0.0' },
    {
      instructions:
        'LayerText 分层读质检引擎：面向初中英语教师的文本简化质检。词库=难度锚点（词表内=学生已学）；被动/定语从句/过去完成按初中教学进度一律禁用；直接引语内豁免。改写英文后务必用 layer_check_revision 自查残留；差量修订段落用 layer_rework_gates 过回炉四闸；交付前用 layer_align 核对丢句；三层产物用 layer_acceptance_v2 验收；回炉规划用 layer_rework_ledger；喂生成管线前用 layer_source_probe 查源完整性。',
    },
  );

  server.registerTool(
    'layer_qc',
    {
      title: 'LayerText 全文体检',
      description:
        '对一段英文文本做全面质检：词表覆盖率/生词率/句长/被动/定语从句/过去完成/OOV 生词清单。适合教师在简化前评估原文难度、简化后验收。OOV 清单带 zipf 词频先验分诊：高频未收=疑似漏收（教师核对后入词库），低频=真·生词教学优先。可传已学词集（复现队列）：队列词不再计 OOV，并输出⑩复现命中指标。',
      inputSchema: z.object({
        text: z.string().describe('英文文本（任意格式；按空行分段自动处理）'),
        reinforce: z.array(z.string()).optional().describe('已学词集/复现队列（词形家族按词种计命中）'),
      }),
    },
    async ({ text, reinforce }) => ({ content: [{ type: 'text', text: JSON.stringify(toolQcText(text, lex, 50, reinforce, zipf, aoa), null, 1) }] }),
  );

  server.registerTool(
    'layer_word_status',
    {
      title: 'LayerText 单词词表状态',
      description: '查一个英文单词是否在词库内（学生已学）/待定/词表外（生词），并给出词形还原原形。',
      inputSchema: z.object({ word: z.string().describe('英文单词（自动小写、还原词形）') }),
    },
    async ({ word }) => ({ content: [{ type: 'text', text: JSON.stringify(toolWordStatus(word, lex), null, 1) }] }),
  );

  server.registerTool(
    'layer_sentence_risks',
    {
      title: 'LayerText 句法黑名单检测',
      description: '逐句检测句法黑名单：被动语态/定语从句/过去完成时/超长句。初中生未学这些结构，简化版中不应出现（直接引语内豁免）。',
      inputSchema: z.object({
        text: z.string().describe('一个或多个英文句子'),
        max_len: z.number().int().min(8).max(40).default(16).describe('句长上限（词/句），默认 16'),
      }),
    },
    async ({ text, max_len }) => ({ content: [{ type: 'text', text: JSON.stringify(toolSentenceRisks(text, max_len), null, 1) }] }),
  );

  server.registerTool(
    'layer_check_revision',
    {
      title: 'LayerText 改写句复核',
      description: '改写英文句子后自查：是否残留被动/定从/过去完成/超长（按句拆分逐句检测，超长=最长一句超限）。AI 改写英文后应调用本工具复核再交付。',
      inputSchema: z.object({
        revised: z.string().describe('改写后的英文（可多句）'),
        max_len: z.number().int().min(8).max(40).default(16).describe('句长上限（词/句），默认 16'),
      }),
    },
    async ({ revised, max_len }) => ({ content: [{ type: 'text', text: JSON.stringify(toolCheckRevision(revised, max_len), null, 1) }] }),
  );

  server.registerTool(
    'layer_align',
    {
      title: 'LayerText 两版逐句核对',
      description:
        '把改写/简化版与基准版（如原文）逐句核对：机器找出丢句（基准有此处无，疑似丢情节）、新增句、配对句中缺失的数字与专名（three↔3 互认）。AI 交付简化稿前应先跑本工具确认零丢句、信号缺失有解释。',
      inputSchema: z.object({
        base_text: z.string().describe('基准版英文文本（如原文/上一版）'),
        cur_text: z.string().describe('待核对的当前版英文文本'),
      }),
    },
    async ({ base_text, cur_text }) => ({ content: [{ type: 'text', text: JSON.stringify(toolAlignPairs(base_text, cur_text), null, 1) }] }),
  );

  server.registerTool(
    'layer_rework_gates',
    {
      title: 'LayerText 回炉四闸自查',
      description:
        '段级回炉的验收闸：改写一个段落后自查四条——①红词必减（词库外未注词不得增、改前有则必须减少）②段长比 [0.7,1.4] ③已有中文注释一处不丢 ④句长上限（直接引语豁免：引语内的长句不否决）。AI 差量修订段落、写回产物前应调用本工具，过闸才许交付。',
      inputSchema: z.object({
        before: z.string().describe('改前段原文（含 [P##] 标记与 word（中文）注释原样）'),
        after: z.string().describe('改后段（AI 修订稿）'),
        max_len: z.number().int().min(8).max(40).default(16).describe('句长上限（词/句），默认 16'),
      }),
    },
    async ({ before, after, max_len }) => ({ content: [{ type: 'text', text: JSON.stringify(toolReworkGates(before, after, max_len, lex), null, 1) }] }),
  );

  server.registerTool(
    'layer_rework_ledger',
    {
      title: 'LayerText 回炉台账汇总',
      description:
        '解析回炉台账 JSONL（_运行/回炉台账.jsonl 的文件内容）：决定计数（✓锁修复/✓换词降红/挂起）、挂起按原因分组（锁失败/未注超标/段长越界/句长超线/注释丢失）、下一轮建议顺序。规划下一轮回炉前先看本工具。',
      inputSchema: z.object({
        ledger_text: z.string().describe('台账文件全文（一行一条 JSON 的 JSONL；agent 自行读文件后传入）'),
        sent_limits: z.record(z.string(), z.number()).optional().describe('各层句长判定线（如 {"A":19,"M":17,"B":16}）；不给则 v1 遗留行的句 max 判不了'),
      }),
    },
    async ({ ledger_text, sent_limits }) => ({ content: [{ type: 'text', text: JSON.stringify(toolReworkLedger(ledger_text, sent_limits), null, 1) }] }),
  );

  server.registerTool(
    'layer_source_probe',
    {
      title: 'LayerText 源完整性探针（R0）',
      description:
        '喂管线之前先查源文本身：①词数骤降（本章词数<相邻章中位数一半，如 ch10 残缺 367 词 vs 中位 3871）②章末无收束（断章形态：逗号/悬垂连词/无句读收尾/末段过短）③碎片残留（连续孤词/词表行混入）。命中任何一条，R0 应拒绝把这份源喂进生成。整本书的章一起给。',
      inputSchema: z.object({
        chapters: z
          .array(z.object({ name: z.string().describe('章名，如 第一章'), text: z.string().describe('该章 md 全文') }))
          .min(1)
          .describe('整本书各章（词数骤降要比较相邻章）'),
      }),
    },
    async ({ chapters }) => ({ content: [{ type: 'text', text: JSON.stringify(toolSourceProbe(chapters), null, 1) }] }),
  );

  server.registerTool(
    'layer_acceptance_v2',
    {
      title: 'LayerText 验收 v2（七维度·可本地计算子集）',
      description:
        '对三层产物整章跑验收：全书未注率排序 B<M<A、同段倒挂（B 段未注>A 同段）、句长梯度（B 均≤A×1.15）、注密度（注/百词+最差段）、结构（段ID对齐/空段/注释外中文/近重复）、语义（凭空数字/专名丢失/否定归零，需给 source）、重复注。照抄检测与注位审计要读 recap/注位审计.json，走管线脚本 验收v2.mjs。',
      inputSchema: z.object({
        tiers: z.object({ A: z.string(), M: z.string().optional(), B: z.string() }).describe('三层整章 md（[P##] 段格式；A、B 必给，M 可选）'),
        source: z.record(z.string(), z.string()).optional().describe('源段表 {"P01":"原文段",…}；给了才做语义确定性校验'),
        proper_nouns: z.array(z.string()).optional().describe('专名表（小写）；给了才做专名丢失校验'),
      }),
    },
    async ({ tiers, source, proper_nouns }) => ({ content: [{ type: 'text', text: JSON.stringify(toolAcceptanceV2(tiers, source, proper_nouns, lex), null, 1) }] }),
  );

  await server.connect(new StdioServerTransport());
}

void main();
