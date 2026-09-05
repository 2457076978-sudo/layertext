/**
 * LayerText · 不规则动词/名词全表与句法黑名单豁免表
 *
 * 权威逻辑源：原型项目 scripts/qc_chapter.py（2026-09 Animal Farm 三版调适，
 * 规则经真实全书三轮质检迭代验证）。以下所有表为**逐字移植**，勿随意增删——
 * 每一条豁免都是踩过坑的（详见 docs/QC指标说明.md）。
 */

/** 词形还原用：不规则变化全表（含 be/have/do 变位、情态动词、不规则三叠式、比较级）。
 *  表内所有形（went/sang/worse/…）本身即视为已知词。 */
export const IRR_RAW = `
was were been being am is are have has had do does did done shall should will would can could may might must
cost cost cut cut hit hit hurt hurt let let put put set set shut shut read read beat beat bet bet
arise arose arisen awake awoke awoken bear bore born beat beat beaten become became become begin began begun
bend bent bent bite bit bitten bleed bled bled blow blew blown break broke broken breed bred bred bring brought brought
build built built burn burnt burnt buy bought bought catch caught caught choose chose chosen come came come
dig dug dug draw drew drawn dream dreamt dreamt drink drank drunk drive drove driven eat ate eaten fall fell fallen
feed fed fed fight fought fought find found found fly flew flown forbid forbade forbidden forget forgot forgotten
freeze froze frozen get got got give gave given go went gone grow grew grown hang hung hung have had had
hear heard heard hide hid hidden hit hit hit hold held held hurt hurt hurt keep kept kept know knew known
lay laid laid lead led led lean leant leant learn learnt learnt leave left left lend lent lent lie lay lain
light lit lit lose lost lost make made made mean meant meant meet met met pay paid paid put put put
read read read ride rode ridden ring rang rung rise rose risen run ran run say said said see saw seen
sell sold sold send sent sent shake shook shaken shine shone shone shoot shot shot show showed shown
shut shut shut sing sang sung sink sank sunk sit sat sat sleep slept slept smell smelt smelt speak spoke spoken
spend spent spent spill spilt spilt stand stood stood steal stole stolen stick stuck stuck sweep swept swept
swim swam swum take took taken teach taught taught tear tore torn tell told told think thought thought
throw threw thrown understand understood understood wake woke woken wear wore worn win won won write wrote written
bad worse worst far farther farthest little less least much more most many more most good better best
old older oldest well better best badly worse worst
`;

/** 不规则名词复数 → 单数（hit() 先查此表再剥后缀） */
export const IRR_NOUN: Record<string, string> = {
  men: 'man', sheep: 'sheep', beasts: 'beast', tidings: 'tiding',
  teeth: 'tooth', feet: 'foot', geese: 'goose', children: 'child',
};

/** 被动语态假阳性豁免（负向先行断言，接在 be 动词之后）：
 *  had red / was bed / was mixed / was exhausted / was interested 类——
 *  这些 -ed/-d 结尾词是形容词或实义动词过去式，不是被动分词。 */
export const FAKE = String.raw`(?!red\b|bed\b|shed\b|naked\b|need\b|indeed\b|feed\b|seed\b|wed\b|mixed\b|exhausted\b|interested\b)`;

/** was/were + 不规则过去分词（第二被动模式词表） */
export const PASSIVE_IRR =
  'driven|made|given|beaten|broken|taken|chosen|elected|seen|heard|told|taught|caught|fed|sent|set|put|cut|hit';

/** 过去完成时不规则分词全表（had + 以下任一词） */
export const PART_LIST =
  'been|made|cut|drawn|built|bought|brought|caught|taught|sold|told|kept|left|lost|meant|met|paid|set|put|shut|hit|hurt|let|sung|drunk|eaten|fallen|felt|found|got|given|gone|come|seen|done|taken|grown|begun|forgotten|stood|understood|spoken|spent|slept|sat|run|risen|hidden|held|heard|flown|fed|driven|broken|become|beaten|bitten|blown|chosen|frozen|torn|thrown|woken|worn|won|written|awoken|lent|wept|struck|stuck|swept|spun|laid|led|lit|lain';

/** had 与分词之间可插入的副词（零个或多个） */
export const HAD_ADVERBS = String.raw`(?:not\s+|never\s+|ever\s+|just\s+|already\s+|also\s+|really\s+)*`;

/** that 后接以下词开头时不算 that 定语从句（宾从/时间名词/代词等假阳性豁免） */
export const THAT_EXEMPT =
  'was\\b|is\\b|are\\b|were\\b|has\\b|had\\b|always\\b|it\\b|the\\b|a\\b|an\\b|his\\b|its\\b|this\\b|I\\b|he\\b|she\\b|they\\b|we\\b|you\\b|to\\b|not\\b|no\\b|evening\\b|morning\\b|night\\b|day\\b|time\\b|week\\b|year\\b|moment\\b|season\\b|thing\\b|something\\b|anything\\b|nothing\\b|everything\\b|afternoon\\b|summer\\b|winter\\b';

/**
 * 认知动词 lookbehind 表（said/agreed/knew 后的 that 是宾语从句，不算定从）。
 * ⚠️ 保真说明：原型 qc_chapter.py 中该表**已定义但未参与计数**（that 定从的宾从
 * 豁免实际由 THAT_EXEMPT 的代词/名词先行词表承担）。此处同样仅导出不使用，
 * 保持与 Python 版行为一致；是否启用留待产品层决策（见 docs/M1-对照测试报告.md）。
 */
export const COGNITIVE_LOOKBEHIND =
  ['said', 'agreed', 'knew', 'thought', 'believed', 'hoped', 'sure', 'afraid', 'explained', 'remembered',
   'saw', 'heard', 'felt', 'found', 'meant', 'declared', 'announced', 'reported', 'cried', 'shouted',
   'whispered', 'asked', 'wondered', 'learned', 'forgot', 'promised', 'noticed', 'watched', 'showed',
   'proved', 'seemed', 'appeared', 'denied', 'doubted']
  .map((w) => `(?<!${w})`)
  .join('');

export const IRR: Set<string> = new Set(IRR_RAW.trim().split(/\s+/));
