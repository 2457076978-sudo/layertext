#!/usr/bin/env node
/**
 * LayerText MCP Server（stdio）——把质检引擎接进任何 MCP 客户端
 * （Claude Desktop / ZCode / Cursor 等）
 *
 * 启动：
 *   node dist/src/mcp-server.js [--vocab 教材词库.csv]... [--wordlist 词表.txt]... [--terms 术语.txt] [--proper 专名.txt]
 *
 * 工具（5 个，全部本地计算、零遥测、不落盘）：
 *   layer_qc              全文体检：生词率/覆盖率/句长/被动/定从/过去完成/OOV清单
 *   layer_word_status     单词词表状态与原形（词库=难度锚点）
 *   layer_sentence_risks  句法黑名单逐句检测（被动/定从/过去完成/超长）
 *   layer_check_revision  改写句复核：AI 改写后自查黑名单与超长残留
 *   layer_align           两版逐句核对：丢句/新增/数字专名缺失（简化交付前机器核对）
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
import { buildMcpLexicon, toolAlignPairs, toolCheckRevision, toolQcText, toolSentenceRisks, toolWordStatus, type McpLexiconOptions } from './core/mcpTools.js';

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
        'LayerText 分层读质检引擎：面向初中英语教师的文本简化质检。词库=难度锚点（词表内=学生已学）；被动/定语从句/过去完成按初中教学进度一律禁用；直接引语内豁免。改写英文后务必用 layer_check_revision 自查残留。',
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

  await server.connect(new StdioServerTransport());
}

void main();
