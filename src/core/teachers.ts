// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// © 2026 Wayne（LayerText 作者）。本文件为判定引擎核心，本仓库已部署版权验证体系，细节不予公开（docs/版权与授权.md）。
/**
 * LayerText · 教师身份（Teacher）：稳定 ID + 名录（roster）
 *
 * 《LayerText 工程优化总计划》阶段 3 的第一句：「把『单机目录』升级为可部署的本地优先服务：
 * **Run/Artifact/Decision/Teacher 四类实体有稳定 ID**」。
 * 前三类已经各有各的那一个：`runId`（`newManifest`）、`artifactIdOf`（逻辑身份：种类+层级+章节）、
 * `eventId`（`eventIdOf`）。教师**一直只是一个自由字符串**，而它同时决定了三样东西：
 *   · `runId`（`newManifest` 把它拼进哈希）——**拼错一个字母就是另一次运行**；
 *   · 指针文件名（`pointerNameOf({teacher, tier})`）——**拼错一个字母就是另一个分片指针**，
 *     于是 `readRunIdentity` 那套「按 (教师, 层级) 分片」的分区实际上是按**字符串**分的，
 *     而字符串不等于人；
 *   · 每条决定事件（`DecisionEvent.teacherId`）——**拼错一个字母，这个人的决定就不再合成一份**。
 *
 * 三种真实的坏法（都不是"看起来坏了"，而是"看起来好好的"）：
 *   ① `--teacher wayne` / `--teacher Wayne` / `--teacher 'wayne '` 是**三个人**：
 *      三次运行、三个 runId、三份指针、三堆决定事件。没有任何地方会说一句话。
 *   ② 脚本默认取 `process.env.USER`——那是**机器账号**，不是人。两位教师共用一台笔记本，
 *      拿到的是同一个身份；一个人两台机器（用户名不同），拿到的是两个身份。两个方向都错。
 *   ③ 回答不了「谁在这本书上干过活」——而这正是总计划「多教师」那一整段要问的第一个问题。
 *
 * ── 稳定 ID 选的是什么、为什么 ──────────────────────────────────────────────
 * **`id = 归一化后的名字`**（`teacherIdOf`）：NFKC → 空白折叠 → 去首尾 → 转小写。
 * 于是 `Wayne`、`wayne `、`Ｗａｙｎｅ` 全是同一个 id：`wayne`。
 *
 * 为什么**不是**另外两种常见做法：
 *  · **随机 UUID / 首次使用时分配一个 id**：它要求身份必须被**持久化**——名录一丢、被手抄一份、
 *    被拷到另一台机器，身份就没了；而旧运行里已经写死了自由字符串（真实项目里是 `wayne`），
 *    要让它们继续能用就只能写迁移脚本，而"不许有迁移步骤"是这一轮的硬约束。
 *    本仓库对"身份"已经有一条成文的口径（见 `manifest.ts` 里 `artifactIdOf` 的注释）：
 *    「身份是**算出来的**，所以任何一份旧清单，读的时候都算得出它的产物身份」——
 *    教师 ID 走的是同一条路，这是**与既有设计一致**的选择，不是新发明。
 *  · **名录里显式写一个 id**：同上，且多一层——`id` 与 `name` 一旦可以分开，就出现了两个事实源：
 *    运行清单里记的是哪个？名录改了名，旧运行还算不算同一个人？这里选的做法让这两个问题不存在。
 *
 * ── 归一化 vs 身份：`Wayne` 就是 `wayne` 吗 ────────────────────────────────
 * **是。** 理由：大小写、首尾空白、全半角是**输入方式的差异**，不是人的差异；
 * 把它们当成两个人才是那个 bug（本期要治的第一个坏法）。所以归一化**改名字**。
 *
 * 但"改名字"这件事**绝不允许静默**（`resolveTeacherName` 的 `notices` / `changed`）：
 *   · 命令行给的是 `Wayne`、记下来的是 `wayne`，这句话会打印出来，并写进本次运行的
 *     `warnings`（于是 `--verify` 与摘要里永远看得见，不是一行跑过去就没了的 stderr）；
 *   · **归一化之前写下的运行照常读得出来**：`teacherRosterOf` 把旧清单里的 `Wayne`
 *     归到 `wayne` 名下，同时把**原始写法**留在 `rawNames` 里说出来——
 *     "谁被并到了谁名下"必须看得见，否则这就是一次静默的历史改写。
 *
 * 归一化统一不了的（中文名 vs 英文工号、`洪梓境` vs `wayne`）**不猜**，交给名录的 `aliases`：
 * 只有人能说"这两个写法是同一个人"。别名命中同样**必须说出来**（status: `别名命中`）。
 *
 * ── 名录里没有这个人时（`未知教师`）怎么办 ─────────────────────────────────
 * 三条路都不好，取中间那条，并且**把话说到底**：
 *   · 拒绝开工——对第一次用的人是敌意（总计划的商业闭环第一步就是"导入文本、选层级、生成"，
 *     卡在这里等于产品不可用）；
 *   · 静默登记——错字从此隐形，正是本期要治的病根（"静默但错"比"响亮但烦"坏得多）；
 *   · **本次选中：登记，但大声**。`--new` 会把这个名字登记进名录（否则"谁在这本书上干过活"
 *     永远答不出来），同时打印 + 写进清单 `warnings`：名字被归一化过、名录里已经有谁、
 *     以及**疑似拼错**（`suggestions`，编辑距离近的名字）——"你是不是想写 `wayne`？"。
 *     于是第二个人出现的那一刻，是**被看见**的，而不是三个月后对不上账才发现。
 *
 * ── 名录**不是**什么（边界，写清楚免得它长成第二个事实源） ──────────────────
 * · **不是画像**：不存学生、班级、成绩、任何个人画像——总计划阶段 3 明文
 *   「学生数据仍只在本机工作区，发布包默认不含画像、成绩和个人信息」。
 *   名录里只有"谁"这一件事，且它是本机工作区里的一份 JSON（`_运行/教师名录.json`），
 *   不是账号、不上传、不进发布包（发布包里那个 `teacher` 字段来自**运行清单**）。
 * · **不是权限系统**：不回答"谁能改哪一层、哪本书"。它是名册，不是门禁。
 * · **不是事实源**：「谁在这本书上干过活」的答案永远来自**各次运行自己的清单**
 *   （`清单_<runId>.json` 里的 `teacher`）。名录只回答"这个 id 还有哪些写法"。
 *   所以名录里**刻意没有运行计数**：有就会漂移（删掉一次运行，名录还记着 3 次），
 *   而 `teacherRosterOf()` 是**当场**从清单数出来的——两个数字永远不会对不上，
 *   因为只有一个数字。
 * · **不区分重名的人**：归一化之后相同就是同一个人（`张老师` 与 `张老师` 无从分辨）。
 *   这是刻意的取舍：真要区分，得由人在 `aliases` 里写明，而不是让工具猜。
 *
 * 本模块是**纯逻辑**（归一化、比对、造名录对象、算名册），不碰文件系统：
 * 读/写 `_运行/教师名录.json` 由共享模块 `tools/af_pipeline/LayerText_AF词表与词典.mjs` 负责
 * （与 `LexiconSnapshot`/`RunManifest` 的分工完全一样：引擎算，脚本读写）。
 */

/** 名录文件的名字。**放在 `_运行/` 下**：它与清单、指针同处一地，随产物目录整体搬走。
 *  刻意**不做全局名录**——问的是"谁**在这本书**上干过活"，全局名录会变成第二个要对账的地方。 */
export const TEACHER_REGISTRY_FILE = '教师名录.json';

export const TEACHER_SCHEMA_VERSION = 1;

/** 「不知道是谁」的占位 id。它**不是**一个人：不进名录、不参与撞名。
 *  与 `manifest.ts` 里 `knownTeacher()` 的既有口径一致（空串与 `unknown` 都表示"不知道"）。 */
export const UNKNOWN_TEACHER = 'unknown';

/* ────────────────────── ① 稳定 ID：归一化的名字 ────────────────────── */

/**
 * 教师名的稳定 ID。**这就是本轮的"稳定 ID"**：算出来的、不需要持久化、不看盘、不看名录。
 *
 * 规则（三步，都可复现，任何机器上同一个答案）：
 *   ① `NFKC`：全角 `Ｗａｙｎｅ`、`ｗａｙｎｅ` 与半角是同一个人的同一种笔误；
 *      顺带把全角空格 `\u3000` 变成普通空格，于是"用中文输入法敲了个空格"不再制造第二个人。
 *   ② 空白折叠 + 去首尾：`'wayne '` / `'way ne'`（多个空格）不再制造第二个人。
 *   ③ 转小写：`Wayne` = `wayne`。**用 `toLowerCase()` 而不是 locale 版本**——
 *      要的是"任何机器、任何语言环境下同一个答案"，不是语言学上正确的折叠。
 *
 * **不做**的事：不拼音化、不纠错、不做姓名拆分。`lǐ` 与 `li`、`张老师` 与 `zhang` 是**不同**的 id，
 * 工具不猜——那是 `aliases` 的活（只有人写得出来）。
 *
 * 返回空串表示"根本没说名字"（调用方要按 `teacherIdOrUnknown` 处理）。
 */
export function teacherIdOf(raw: string | null | undefined): string {
  if (raw === null || raw === undefined) return '';
  return String(raw).normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
}

/** 缺省口径的入口：空名 → `unknown`。
 *  写决定事件、算指针文件名、比对运行身份都该用这个——它复刻的是脚本里那句既有的
 *  `process.env.LAYERTEXT_TEACHER ?? process.env.USER ?? 'unknown'`，一个字不改。 */
export function teacherIdOrUnknown(raw?: string | null): string {
  return teacherIdOf(raw) || UNKNOWN_TEACHER;
}

/** 是不是"一个人"。`unknown` 与空串都不是——它们回答不了"谁"。 */
export const isRealTeacher = (id: string): boolean => !!id && id !== UNKNOWN_TEACHER;

/* ────────────────────── ② 名录 ────────────────────── */

/**
 * 名录里的一条。**没有运行计数**（理由见文件头：有就会漂移）。
 *
 * · `id`   —— 稳定 ID（`teacherIdOf` 算出来的那个）；
 * · `name` —— 人写的那一种写法（显示用）。**刻意与 id 分开**：id 要稳定、要能进文件名，
 *              显示名要好看（`Wayne` 与 `wayne` 是同一个 id，但人希望看到自己写的那一种）；
 * · `aliases` —— 归一化**统一不了**的其它写法（`洪梓境` 之于 `wayne`）。
 *              与 id 归一化后相同的别名是多余的，`withTeacher` 会丢掉并说明——
 *              名录里堆一排 `wayne`/`Wayne`/`wayne ` 只会让人以为它们有区别。
 */
export interface TeacherRecord {
  id: string;
  name: string;
  aliases: string[];
  /** 首次/最近一次**在命令行上见到**这个人的时间（不是运行时间——运行时间在清单里） */
  firstSeenAt?: string;
  lastSeenAt?: string;
  /** 人写的备注（"张老师，九年级备课组"之类）。工具不读它，只负责别丢。 */
  note?: string;
}

export interface TeacherRegistry {
  schemaVersion: number;
  updatedAt: string;
  teachers: TeacherRecord[];
}

export const emptyTeacherRegistry = (updatedAt = ''): TeacherRegistry => ({
  schemaVersion: TEACHER_SCHEMA_VERSION,
  updatedAt,
  teachers: [],
});

export interface RegistryParse {
  registry: TeacherRegistry;
  /** 读名录时的问题（人话）。**不抛**：一份坏名录不该让整本书打不开，
   *  但**必须有人说话**——问题给调用方，由它决定是打印还是拒绝开工。 */
  problems: string[];
}

/**
 * 解析名录文本。**坏名录不许被当成空名录悄悄咽下去**（本项目纪律第 3 条：
 * 任何 catch 必须产生 warning/error event 或显式返回失败）——所以 `problems` 非空时，
 * 调用方（`清单.mjs`）会**拒绝在它上面登记**，而不是覆盖掉一份读不出来的名册。
 */
export function parseTeacherRegistry(text: string | null | undefined): RegistryParse {
  const problems: string[] = [];
  if (text === null || text === undefined || !String(text).trim()) {
    return { registry: emptyTeacherRegistry(), problems };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(String(text));
  } catch (e) {
    return { registry: emptyTeacherRegistry(), problems: [`名录不是合法 JSON：${(e as Error)?.message ?? e}`] };
  }
  const obj = (raw ?? {}) as Partial<TeacherRegistry>;
  if (typeof obj !== 'object' || Array.isArray(obj)) {
    return { registry: emptyTeacherRegistry(), problems: ['名录的顶层不是一个对象'] };
  }
  const seen = new Map<string, string>();
  const teachers: TeacherRecord[] = [];
  for (const t of Array.isArray(obj.teachers) ? obj.teachers : []) {
    const id = teacherIdOf((t as TeacherRecord)?.id ?? '');
    if (!isRealTeacher(id)) {
      problems.push(`名录里有一条没有可用 id 的记录（name=${JSON.stringify((t as TeacherRecord)?.name ?? '')}）——已跳过；id 是它的唯一键，缺了它这条记录指不到任何人`);
      continue;
    }
    if (seen.has(id)) {
      problems.push(`名录里有重复的 id「${id}」（${seen.get(id)} 与 ${(t as TeacherRecord)?.name ?? ''}）——只保留第一条；重名会让"谁做过什么"分成两半`);
      continue;
    }
    seen.set(id, String((t as TeacherRecord)?.name ?? id));
    teachers.push({
      id,
      name: String((t as TeacherRecord)?.name ?? id) || id,
      aliases: [...new Set((Array.isArray((t as TeacherRecord)?.aliases) ? (t as TeacherRecord).aliases : []).map((a) => String(a)).filter(Boolean))],
      ...((t as TeacherRecord)?.firstSeenAt ? { firstSeenAt: String((t as TeacherRecord).firstSeenAt) } : {}),
      ...((t as TeacherRecord)?.lastSeenAt ? { lastSeenAt: String((t as TeacherRecord).lastSeenAt) } : {}),
      ...((t as TeacherRecord)?.note ? { note: String((t as TeacherRecord).note) } : {}),
    });
  }
  return { registry: { schemaVersion: Number(obj.schemaVersion) || TEACHER_SCHEMA_VERSION, updatedAt: String(obj.updatedAt ?? ''), teachers }, problems };
}

/** 序列化（与其它落盘产物一致：2 空格缩进 + 结尾换行）。 */
export const serializeTeacherRegistry = (reg: TeacherRegistry): string => JSON.stringify(reg, null, 2) + '\n';

/** 按稳定 ID 找记录；找不到再按**别名**找（别名是"归一化统一不了的另一种写法"）。 */
export function findTeacherRecord(reg: TeacherRegistry | null | undefined, id: string): { record: TeacherRecord; via: 'id' | 'alias' } | null {
  if (!reg || !id) return null;
  const hit = reg.teachers.find((t) => t.id === id);
  if (hit) return { record: hit, via: 'id' };
  const byAlias = reg.teachers.find((t) => t.aliases.some((a) => teacherIdOf(a) === id));
  return byAlias ? { record: byAlias, via: 'alias' } : null;
}

export interface RegisterInput {
  /** 命令行/环境变量给出的原始写法 */
  raw: string;
  now?: string;
  note?: string;
}

export interface RegisterResult {
  registry: TeacherRegistry;
  /** 落定之后的稳定 ID（别名命中时是**被指向那条记录的 id**） */
  id: string;
  record: TeacherRecord | null;
  created: boolean;
  /** 这次新记下的别名（归一化统一不了的那种写法） */
  addedAlias?: string;
  /** 别名里与 id 归一化后相同、被丢掉的写法（说出来，不静默丢） */
  droppedAliases: string[];
}

/**
 * 登记一条（**纯函数**：返回新名录，不改入参）。`清单.mjs --new` 在解析完教师名之后调它。
 *
 * 三件事必须同时成立，否则这个名册就是错的：
 *   ① 归一化之后同一个人**只有一条**记录（`Wayne` 不会在 `wayne` 旁边再长一条）；
 *   ② 别名命中的写法**并进那条记录**（`洪梓境` 与 `wayne` 是一个人时，名录里是一条两条别名）；
 *   ③ `unknown` / 空名**不登记**——它不是人，登记进去只会让「谁在这本书上干过活」多一个假条目。
 */
export function withTeacher(reg: TeacherRegistry | null | undefined, input: RegisterInput): RegisterResult {
  const now = input.now ?? new Date().toISOString();
  const base: TeacherRegistry = reg ?? emptyTeacherRegistry(now);
  const droppedAliases: string[] = [];
  const rawId = teacherIdOf(input.raw);
  if (!isRealTeacher(rawId)) {
    // 没名的人：名录不动。**由调用方负责大声**（`resolveTeacherName` 会给出 warn 级的说明）
    return { registry: base, id: UNKNOWN_TEACHER, record: null, created: false, droppedAliases };
  }
  const hit = findTeacherRecord(base, rawId);
  const teachers = base.teachers.map((t) => ({ ...t, aliases: [...t.aliases] }));
  if (hit) {
    const rec = teachers.find((t) => t.id === hit.record.id)!;
    rec.lastSeenAt = now;
    if (!rec.firstSeenAt) rec.firstSeenAt = now;
    if (input.note) rec.note = input.note;
    // 别名命中：把**人写的那种写法**记成别名，下一次（以及别人）能直接找到这条
    if (hit.via === 'alias') return { registry: { ...base, teachers, updatedAt: now }, id: rec.id, record: rec, created: false, droppedAliases };
    const written = String(input.raw).normalize('NFKC').replace(/\s+/g, ' ').trim();
    // 与 id 归一化后相同的写法当别名是多余的（`Wayne` 之于 `wayne`）——丢掉并说出来
    if (written && teacherIdOf(written) === rec.id && written !== rec.id) droppedAliases.push(written);
    return { registry: { ...base, teachers, updatedAt: now }, id: rec.id, record: rec, created: false, droppedAliases };
  }
  const record: TeacherRecord = { id: rawId, name: String(input.raw).normalize('NFKC').replace(/\s+/g, ' ').trim() || rawId, aliases: [], firstSeenAt: now, lastSeenAt: now };
  if (input.note) record.note = input.note;
  teachers.push(record);
  return { registry: { ...base, updatedAt: now, teachers }, id: record.id, record, created: true, droppedAliases };
}

/* ────────────────────── ③ 解析一个名字：它到底是谁 ────────────────────── */

/** 名录**故意不写日期**的场景（读的时候才知道"现在"，纯函数不许读表）。 */
export type TeacherStatus =
  /** 名录里有这个人 */
  | '在册'
  /** 名录里没有，但某个人的别名里有这个写法 */
  | '别名命中'
  /** 名录里没有，本次把它登记上（--new 的路径） */
  | '首次登记'
  /** 名录里没有，且**本次不写盘**（只看不登记：--verify / 摘要 / 只读脚本） */
  | '未登记'
  /** 根本没给名字（空/空白） */
  | '空名'
  /** 引擎里读不到名录（老 dist / 项目里还没有名录文件）——按"没有名录"处理 */
  | '无名录';

export interface TeacherNotice {
  /** warn = 必须让人看见（会进清单 warnings）；info = 说明白就好 */
  level: 'info' | 'warn';
  /** 进清单 `warnings[].kind` 用的稳定标识 */
  kind: 'teacher-normalized' | 'teacher-typo-suspect' | 'teacher-unnamed' | 'teacher-unregistered' | 'teacher-first' | 'teacher-alias' | 'teacher-no-registry' | 'teacher-registry-broken';
  message: string;
}

export interface TeacherResolution {
  /** 命令行/环境变量给的原始写法（原样留证） */
  raw: string;
  /** 稳定 ID：**写进清单、指针文件名、决定事件的就是它** */
  id: string;
  /** 显示名（名录里的写法；没登记时就是 id） */
  name: string;
  status: TeacherStatus;
  /** 归一化改动了写法（`Wayne ` → `wayne`）——**这件事必须被说出来** */
  changed: boolean;
  record: TeacherRecord | null;
  /** 名录里已有的其他人（"你是不是想用这个名字"用） */
  suggestions: TeacherRecord[];
  notices: TeacherNotice[];
}

const notice = (level: TeacherNotice['level'], kind: TeacherNotice['kind'], message: string): TeacherNotice => ({ level, kind, message });

/**
 * 编辑距离（Levenshtein）。名字都很短，不需要更快的算法——
 * 要的是"能 reproducibly 说出哪两个名字像"，而不是性能。
 */
function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost);
    }
    prev = cur;
  }
  return prev[b.length]!;
}

/** 阈值：短名（≤4 字符）只认 1 步，长名认 2 步。
 *  放宽到"包含关系"之类的会更"聪明"，但也更容易报假警——
 *  而项目里已经有教训：报警报多了，人就开始忽略整个队列。 */
const maxDistanceFor = (id: string): number => (id.length <= 4 ? 1 : 2);

/**
 * "你是不是想写这两个人之一"：名录里与它相近的名字（按距离升序，同距离按 id 定序 → 可复现）。
 * **只提示，不改写**——工具不替人改名字（改了就真的变成另一个人了）。
 */
export function suggestTeachers(id: string, reg: TeacherRegistry | null | undefined, opts: { max?: number } = {}): TeacherRecord[] {
  if (!reg || !isRealTeacher(id)) return [];
  const max = opts.max ?? 3;
  return reg.teachers
    .map((t) => ({ t, d: editDistance(id, t.id) }))
    .filter((x) => x.d > 0 && x.d <= maxDistanceFor(id))
    .sort((x, y) => x.d - y.d || (x.t.id < y.t.id ? -1 : 1))
    .slice(0, max)
    .map((x) => x.t);
}

/**
 * 把一个名字解析成"它到底是谁"。**纯函数、不看盘、不写盘**（`清单.mjs --new` 拿到结果后
 * 再决定要不要登记：写盘那一步在共享模块里）。
 *
 * @param raw      命令行/环境变量给的原始写法
 * @param registry 当前名录（`null` = 这本项目还没有名录文件）
 */
export function resolveTeacherName(raw: string, registry?: TeacherRegistry | null): TeacherResolution {
  const id = teacherIdOf(raw);
  const notices: TeacherNotice[] = [];
  const changed = !!id && id !== String(raw);
  if (!registry) {
    notices.push(
      notice(
        'info',
        'teacher-no-registry',
        '这本项目还没有教师名录（_运行/教师名录.json）——跑一次 --new 会顺手建立。' + '旧运行里记的教师名照常解析：ID 是**算出来**的，不需要任何迁移（与产物身份同一条口径）。',
      ),
    );
  }
  if (!isRealTeacher(id)) {
    notices.push(
      notice(
        'warn',
        'teacher-unnamed',
        '没有拿到教师名（命令行 --teacher、环境变量 LAYERTEXT_TEACHER、机器账号 USER 都是空的）——本次按「unknown」记。' +
          '这样写下的运行**事后分不清是谁做的**：同一本书上出现第二个名字时，没人能告诉你是两个人还是同一个人的两次输入。请显式给一个，例如 --teacher wayne。',
      ),
    );
    return { raw, id: UNKNOWN_TEACHER, name: UNKNOWN_TEACHER, status: '空名', changed: false, record: null, suggestions: [], notices };
  }
  if (changed) {
    notices.push(
      notice(
        'info',
        'teacher-normalized',
        `教师名「${raw}」已归一成「${id}」——大小写、首尾/连续空白、全半角不算两个人的差别。` + `本次运行、指针文件名、决定事件记的都是「${id}」（这正是"拼错一个字母就多出一个人"那个漏洞的修法）。`,
      ),
    );
  }
  const hit = findTeacherRecord(registry, id);
  if (hit) {
    const viaAlias = hit.via === 'alias';
    if (viaAlias) {
      notices.push(notice('info', 'teacher-alias', `「${raw}」按名录算作「${hit.record.id}」（名录里把它记成了别名）——本次运行、指针与决定事件都记「${hit.record.id}」。`));
    }
    return { raw, id: hit.record.id, name: hit.record.name || hit.record.id, status: viaAlias ? '别名命中' : '在册', changed, record: hit.record, suggestions: [], notices };
  }
  const suggestions = suggestTeachers(id, registry);
  for (const s of suggestions) {
    notices.push(
      notice(
        'warn',
        'teacher-typo-suspect',
        `名录里已经有「${s.id}」，与本次的「${id}」只差 ${editDistance(id, s.id)} 个字符：若**是同一个人**，请改用「${s.id}」（否则这本书会出现两个教师身份）；确实**是另一个人**就忽略这条。`,
      ),
    );
  }
  const existing = registry?.teachers.map((t) => t.id) ?? [];
  if (registry) {
    notices.push(notice('info', 'teacher-unregistered', `教师「${id}」不在名录里（名录现有：${existing.length ? existing.join('、') : '（空）'}）。`));
  }
  return { raw, id, name: id, status: '未登记', changed, record: null, suggestions, notices };
}

/** 说明白就够的那些（打印出来即可，不进清单的账） */
export const infoNoticesOf = (r: TeacherResolution): TeacherNotice[] => r.notices.filter((n) => n.level === 'info');

/**
 * 要**进清单的账**的那些（`RunManifest.warnings` 同形：`{kind,message}`）。
 *
 * 为什么把这两类分开：一句 `stderr` 跑过去就没了，而"这本书上出现了第二个教师名"这种事
 * 三个月后必须还查得到。写进清单的 warnings，`--verify` 与摘要每次都会把它摆到眼前
 * ——这正是项目那条"响亮但烦，好过静默但错"。
 */
export const warningNoticesOf = (r: TeacherResolution): { kind: string; message: string }[] => r.notices.filter((n) => n.level === 'warn').map((n) => ({ kind: n.kind, message: n.message }));

/**
 * 解析结果的人读文本。**一句话的措辞只写一份**——命令行、共享模块、报告各写一份的下场，
 * 是这个项目已经见过很多次的那种"三处说法不一致"。
 */
export function describeTeacherResolution(res: TeacherResolution, opts: { label?: string } = {}): string[] {
  const label = opts.label ?? '教师';
  const lines = [` ${label}：${res.id}（${res.status}${res.record?.name && res.record.name !== res.id ? `，显示名 ${res.record.name}` : ''}）`];
  for (const n of res.notices) lines.push(` ${n.level === 'warn' ? '⚠' : '·'} ${n.message}`);
  return lines;
}

/* ────────────────────── ④ 名册：谁在这本书上干过活 ────────────────────── */

/** 名册的一行需要的输入。**来自各次运行自己的清单**（事实源），不是名录。 */
export interface TeacherRunRef {
  runId: string;
  teacher: string;
  book?: string;
  version?: string;
  tiers?: string[];
  layout?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface TeacherRosterEntry {
  id: string;
  name: string;
  /** 名录里有这个人 */
  registered: boolean;
  aliases: string[];
  /** 盘上真的出现过、但**写法不是 id** 的名字（`Wayne`）——归一化把它们并到了一起，但要看得见 */
  rawNames: string[];
  runCount: number;
  /** 最近一次运行的时间（取 updatedAt ?? createdAt 的最大值；没有时间的运行记空串） */
  lastAt: string;
  tiers: string[];
  runs: string[];
}

export interface TeacherRosterOptions {
  registry?: TeacherRegistry | null;
  runs: TeacherRunRef[];
}

/**
 * 名册：**名录 × 盘上的清单**。
 *
 * 两个来源各出一半、谁也不取代谁，这正是本模块最要紧的一条边界：
 *   · 「谁**真的**在这本书上跑过」——只有清单说了算（名录里没有计数，也不该有）；
 *   · 「这个 id 还有哪些写法（别名）、显示名叫什么」——只有名录说了算。
 * 一边有、另一边没有的，**两个方向都要报出来**：
 *   · 名录里登记了却一次都没跑过（`registered && runCount===0`）：可能是刚登记、也可能是名字改过；
 *   · 盘上有运行却不在名录里（`!registered`）：**旧运行的遗留**（归一化之前写下的名字、
 *     或 `--new` 之外的方式建出来的清单）——这条尤其要说，否则"名录"会先于"事实"被当成权威。
 */
export function teacherRosterOf(input: TeacherRosterOptions): TeacherRosterEntry[] {
  const byId = new Map<string, TeacherRosterEntry>();
  const ensure = (id: string): TeacherRosterEntry => {
    const hit = byId.get(id);
    if (hit) return hit;
    const rec = findTeacherRecord(input.registry, id)?.record ?? null;
    const entry: TeacherRosterEntry = {
      id,
      name: rec?.name || id,
      registered: !!rec,
      aliases: rec ? [...rec.aliases] : [],
      rawNames: [],
      runCount: 0,
      lastAt: '',
      tiers: [],
      runs: [],
    };
    byId.set(id, entry);
    return entry;
  };
  for (const t of input.registry?.teachers ?? []) ensure(t.id);
  for (const r of input.runs) {
    const id = teacherIdOrUnknown(r.teacher);
    const e = ensure(id);
    e.runCount++;
    e.runs.push(r.runId);
    const written = String(r.teacher ?? '');
    if (written && written !== id && !e.rawNames.includes(written)) e.rawNames.push(written);
    const at = String(r.updatedAt ?? r.createdAt ?? '');
    if (at > e.lastAt) e.lastAt = at;
    for (const t of r.tiers ?? []) if (!e.tiers.includes(t)) e.tiers.push(t);
  }
  const list = [...byId.values()];
  for (const e of list) {
    e.tiers.sort();
    e.runs.sort();
    e.rawNames.sort();
  }
  // 跑过的排前面、跑得多的排前面；同数按 id 定序（可复现——报表要能逐字对比）
  return list.sort((a, b) => b.runCount - a.runCount || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** 名录里有、盘上一次都没跑过的人 */
export const registryOnlyTeachers = (list: TeacherRosterEntry[]): TeacherRosterEntry[] => list.filter((e) => e.registered && e.runCount === 0);

/** 盘上跑过、名录里没有的人（旧运行遗留）——**这一条最容易被忽略，所以单独给一个函数** */
export const diskOnlyTeachers = (list: TeacherRosterEntry[]): TeacherRosterEntry[] => list.filter((e) => !e.registered && e.runCount > 0);

/**
 * 名册的人读文本（命令行 `清单.mjs --teachers` 用）。
 * **一句话的措辞只写一份**——命令行、报告、摘要各写一份的下场是有一天三处说法不一样。
 */
export function formatTeacherRoster(list: TeacherRosterEntry[], opts: { header?: string; registryExists?: boolean; registryProblems?: string[] } = {}): string[] {
  const lines: string[] = [];
  if (opts.header) lines.push(opts.header);
  if (!list.length) {
    lines.push(' （这本书上还没有任何教师记录：没有名录，也没有建过运行清单）');
    lines.push('   建一次运行就是登记一次：node tools/af_pipeline/LayerText_AF清单.mjs --new --tier A --teacher <你>');
    return lines;
  }
  for (const e of list) {
    const parts = [`${e.runCount} 次运行`];
    if (e.lastAt) parts.push(`最近 ${e.lastAt.slice(0, 16).replace('T', ' ')}`);
    if (e.tiers.length) parts.push(`层 ${e.tiers.join('/')}`);
    if (e.aliases.length) parts.push(`别名 ${e.aliases.join('、')}`);
    if (e.rawNames.length) parts.push(`盘上还写过 ${e.rawNames.join('、')}（已归到同一个 ID）`);
    if (!e.registered) parts.push('**不在名录里**');
    lines.push(` ${e.id.padEnd(12)} ${parts.join('｜')}`);
    if (e.runs.length) lines.push(`   └ ${e.runs.slice(0, 3).join('、')}${e.runs.length > 3 ? `…（共 ${e.runs.length} 次）` : ''}`);
  }
  const regOnly = registryOnlyTeachers(list);
  if (regOnly.length) lines.push(` ⚠ 名录里还有 ${regOnly.length} 位从没在这本书上跑过：${regOnly.map((e) => e.id).join('、')}（登记过但没运行；也可能是名字改过之后留下的）`);
  const diskOnly = diskOnlyTeachers(list);
  if (diskOnly.length) {
    lines.push(
      ` ⚠ 盘上有 ${diskOnly.length} 位不在名录里：${diskOnly.map((e) => e.id).join('、')}` +
        `——这些是**归一化之前**（或手工建清单）写下的运行，照常可用（ID 是算出来的，不需要迁移）；` +
        `下次用它的名字 --new 一次就会自动登记。`,
    );
  }
  if (opts.registryExists === false) lines.push(' （这本项目还没有教师名录：跑一次 --new 会自动建立；不影响任何旧运行）');
  for (const p of opts.registryProblems ?? []) lines.push(` ⚠ 名录本身有问题：${p}`);
  return lines;
}
