/**
 * 内置 WordNet 3.1（英英词库 · App 资产 wordnet/*.gz，普林斯顿许可证可再分发）
 *
 * 用途：词面板「加英语释义」的**纯本地**释义源（零网络零 AI，与"中文标注走系统
 * 词典"同一原则）。WordNet 本身就是 Lesk 消歧的原生搭档：每个词多义项、每义项
 * 带 definition + 用例，直接喂 sensematch.pickSense 按语境句选义。
 *
 * 文件格式（WNDB 3.1）：
 *   index.<pos>：lemma pos synset_cnt p_cnt ptr… sense_cnt tags_cnt offsets…
 *   data.<pos> ：offset lex_filenum ss_type w_cnt words… p_cnt ptrs… | gloss
 *   gloss = definition; "example1" "example2" —— def 取到首个 ';' 或引号前。
 */

const POS_FILES = ['noun', 'verb', 'adj', 'adv'] as const;
type PosName = (typeof POS_FILES)[number];

let loadPromise: Promise<Map<PosName, { index: Map<string, string[]>; data: string }>> | null = null;

async function gunzip(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`内置词典资产缺失：${url}`);
  const buf = await res.arrayBuffer();
  const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'));
  return await new Response(stream).text();
}

async function loadAll(): Promise<Map<PosName, { index: Map<string, string[]>; data: string }>> {
  const out = new Map<PosName, { index: Map<string, string[]>; data: string }>();
  await Promise.all(
    POS_FILES.map(async (pos) => {
      const [indexText, dataText] = await Promise.all([gunzip(`wordnet/index.${pos}.gz`), gunzip(`wordnet/data.${pos}.gz`)]);
      const index = new Map<string, string[]>();
      for (const line of indexText.split('\n')) {
        if (!line || line.startsWith(' ')) continue; // 许可头与空行
        const t = line.split(' ');
        const lemma = t[0]!;
        const synCnt = Number(t[2]);
        const pCnt = Number(t[3]);
        const offsets = t.slice(6 + pCnt); // 4..4+p_cnt-1 指针符，5+p_cnt=sense_cnt，6+p_cnt=tags_cnt 之后才是偏移
        if (offsets.length >= synCnt) index.set(lemma, offsets.slice(0, Math.max(1, synCnt)));
      }
      out.set(pos, { index, data: dataText });
    }),
  );
  return out;
}

/** 惰性加载（首次"加英语释义"时 ~0.5s 解压解析，之后常驻内存） */
function ensureLoaded(): Promise<Map<PosName, { index: Map<string, string[]>; data: string }>> {
  return (loadPromise ??= loadAll());
}

export interface WordnetSense {
  pos: 'n' | 'v' | 'a' | 'r';
  /** 义项英文释义（学生可直接读的定义句） */
  def: string;
  /** WordNet 用例（Lesk 原料） */
  examples: string[];
  /** 原始 gloss（诊断用） */
  raw: string;
}

const dataCache = new Map<string, WordnetSense | undefined>();

/** 查一个词（或它的某词形）的全部义项；词形归一并集由调用方拼好传入。上限 12 义项。 */
export async function wordnetSenses(forms: string[]): Promise<WordnetSense[]> {
  const db = await ensureLoaded();
  const seen = new Set<string>();
  const out: WordnetSense[] = [];
  for (const form of forms) {
    const lemma = form.toLowerCase().replace(/[^a-z-]/g, '');
    if (!lemma || seen.has(lemma)) continue;
    seen.add(lemma);
    for (const pos of POS_FILES) {
      const offsets = db.get(pos)!.index.get(lemma);
      if (!offsets) continue;
      for (const off of offsets) {
        const key = `${pos}:${off}`;
        if (dataCache.has(key)) {
          const s = dataCache.get(key)!;
          if (s) out.push(s);
          continue;
        }
        const data = db.get(pos)!.data;
        const at = data.indexOf(`\n${off} `);
        const sense = at >= 0 ? parseDataLine(data.slice(at + 1, data.indexOf('\n', at + 1)), pos) : undefined;
        dataCache.set(key, sense);
        if (sense) out.push(sense);
      }
    }
    if (out.length >= 12) break;
  }
  return out.slice(0, 12);
}

/** data 文件单行 → 义项。gloss 在 ' | ' 之后：definition; "ex1" "ex2" */
export function parseDataLine(line: string, pos: PosName): WordnetSense | undefined {
  const bar = line.indexOf(' | ');
  if (bar < 0) return undefined;
  const gloss = line.slice(bar + 3);
  const examples = [...gloss.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
  const def = gloss
    .replace(/"[^"]*"/g, '')
    .split(';')[0]!
    .trim();
  if (!def) return undefined;
  return { pos: pos === 'noun' ? 'n' : pos === 'verb' ? 'v' : pos === 'adj' ? 'a' : 'r', def, examples, raw: gloss.slice(0, 200) };
}
