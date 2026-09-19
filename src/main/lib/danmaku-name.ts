// 弹幕名称归一化 / 搜索变体 / 候选打分（纯函数，无 electron 依赖，可在 Node 环境直接单测）
//
// 背景（真机实测，自建服务 http://100.66.1.2:9321）：
//   /api/v2/search/episodes 的 anime 参数在服务端是「清理标题后做前缀匹配」，实测：
//     anime=田耕纪         → 命中 1 部（田耕纪(2023)【电视剧】from 360，26 集）
//     anime=田耕          → 命中（前缀）
//     anime=田耕紀（繁体）  → 命中（服务端做了繁简归一）
//     anime=田耕纪(2023)   → 0 候选
//     anime=田耕纪 第一季   → 0 候选
//     anime=电视剧 田耕纪   → 0 候选
//   即名称里多出「年份括号 / 季号后缀 / 全角标点 / 空格」就搜不到；
//   同时服务端偶发返回 success=true 但 animes 为空（上游瞬时失败），不能当成「名称不存在」。
//
// 因此：请求前做归一化并准备多档变体依次尝试；候选打分把「名称相似度 + 年份 + 季号」一起算，
// 全部抽成纯函数，便于单测与回归。

/** 自动命中最低分：低于该值不自动匹配，改为返回候选列表交 UI 手动确认 */
export const DANMAKU_AUTO_MATCH_MIN_SCORE = 0.4

/** 变体请求遇到「请求成功但候选为空」时的重试等待（毫秒） */
export const DANMAKU_EMPTY_RESULT_RETRY_DELAY_MS = 400

/** 单个名称变体的最多请求次数（首次 + 1 次空结果重试） */
export const DANMAKU_VARIANT_MAX_ATTEMPTS = 2

const FULLWIDTH_OFFSET = 0xfee0

/** 全角 → 半角（含全角空格） */
export function toHalfWidth(input: string): string {
  return (input || '')
    .replace(/[\uff01-\uff5e]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - FULLWIDTH_OFFSET))
    .replace(/\u3000/g, ' ')
}

// 常用简繁对照（只收低歧义字，避免误伤原名；用于搜索兜底，不做通用转换器）
const SIMP_TRAD_PAIRS: string[] = [
  '纪紀', '们們', '儿兒', '东東', '师師', '国國', '爱愛', '门門', '风風', '龙龍',
  '华華', '战戰', '线線', '绿綠', '红紅', '强強', '义義', '剑劍', '极極', '归歸',
  '来來', '关關', '头頭', '岁歲', '无無', '为為', '间間', '时時', '万萬', '与與',
  '学學', '队隊', '银銀', '铁鐵', '闻聞', '卫衛', '书書', '长長', '云雲', '梦夢',
  '泪淚', '过過', '还還', '这這', '边邊', '样樣', '终終', '组組', '绝絕', '给給',
  '统統', '网網', '缘緣', '话話', '语語', '请請', '谢謝', '远遠', '选選', '恋戀',
  '变變', '见見', '说說', '认認', '让讓', '记記', '计計', '论論', '设設', '评評',
  '试試', '词詞', '读讀', '谁誰', '课課', '车車', '轮輪', '达達', '运運', '连連',
  '进進', '违違', '适適', '难難', '庆慶', '阳陽', '圣聖', '乡鄉', '恶惡', '亚亞',
  '产產', '众眾', '会會', '体體', '党黨', '军軍', '农農', '决決', '刚剛', '创創',
  '剧劇', '动動', '务務', '势勢', '区區', '医醫', '单單', '县縣', '号號', '听聽',
  '员員', '场場', '报報', '担擔', '断斷', '桥橋', '检檢', '楼樓', '欢歡', '气氣',
  '汉漢', '测測', '济濟', '满滿', '灵靈', '热熱', '爱愛', '牵牽', '状狀', '独獨',
  '环環', '现現', '电電', '画畫', '疗療', '盘盤', '监監', '盖蓋', '离離', '种種',
  '积積', '称稱', '笔筆', '简簡', '类類', '织織', '经經', '继繼', '绩績', '练練',
  '缓緩', '编編', '罗羅', '习習', '联聯', '声聲', '职職', '脑腦', '肤膚', '脸臉',
  '临臨', '举舉', '艺藝', '苏蘇', '药藥', '虑慮', '补補', '装裝', '览覽', '观觀',
  '规規', '视視', '觉覺', '触觸', '训訓', '讲講', '许許', '诉訴', '译譯', '诗詩',
  '财財', '责責', '贤賢', '败敗', '货貨', '质質', '贵貴', '购購', '费費', '资資',
  '赏賞', '赛賽', '赞讚', '赵趙', '斋齋', '韵韻', '顾顧', '项項', '领領', '颗顆',
  '题題', '飞飛', '饭飯', '饰飾', '馆館', '马馬', '驾駕', '骆駱', '验驗', '骑騎',
  '鱼魚', '鸟鳥', '鸡雞', '鸣鳴', '鹅鵝', '鹤鶴', '侠俠', '传傳', '术術', '丽麗',
  '锋鋒', '凤鳳', '乐樂', '巅巔', '兴興', '团團', '园園', '圆圓', '围圍', '图圖',
  '处處', '备備', '复復', '实實', '审審', '宫宮', '宽寬', '宾賓', '帮幫', '帅帥',
  '广廣', '应應', '废廢', '开開', '忆憶', '怀懷', '态態', '总總', '户戶', '扫掃',
  '执執', '护護', '拥擁', '挂掛', '击擊', '旧舊', '晓曉'
]

const SIMP_TO_TRAD = new Map<string, string>()
const TRAD_TO_SIMP = new Map<string, string>()
for (const pair of SIMP_TRAD_PAIRS) {
  const [simp, trad] = [pair[0], pair[1]]
  if (!simp || !trad || simp === trad || simp === '?' || trad === '?') continue
  SIMP_TO_TRAD.set(simp, trad)
  TRAD_TO_SIMP.set(trad, simp)
}

/** 繁体 → 简体（仅覆盖常用字，用于搜索兜底） */
export function toSimplified(input: string): string {
  return (input || '').replace(/./g, (ch) => TRAD_TO_SIMP.get(ch) ?? ch)
}

/** 简体 → 繁体（仅覆盖常用字，用于搜索兜底） */
export function toTraditional(input: string): string {
  return (input || '').replace(/./g, (ch) => SIMP_TO_TRAD.get(ch) ?? ch)
}

// 分辨率 / 编码 / 容器等噪音标记
const NOISE_RE = /\b(1080p|720p|2160p|480p|4k|8k|bluray|blu-ray|web-?dl|webrip|hdtv|remux|x264|x265|h\.?264|h\.?265|hevc|avc|aac|ac3|flac|dts|10bit|8bit|hdr10\+?|hdr|dolby|atmos|mkv|mp4|avi|flv|wmv|rmvb)\b/gi

// 类型词：服务端标题里带「【电视剧】/动漫」等标记，比对时需剔除
const TYPE_WORD_RE = /电视剧|动画片|动漫|综艺|纪录片|真人秀|剧场版/g

/** 去掉括号段（年份、来源标记）、噪音标记、集号段、扩展名，保留季号文字 */
export function stripNoiseKeepSeason(input: string): string {
  let s = toHalfWidth(input || '')
  s = s.replace(/【[^】]*】|\[[^\]]*\]|\([^)]*\)|（[^）]*）/g, ' ')
  s = s.replace(NOISE_RE, ' ')
  s = s.replace(/\bfrom\s*\S+/gi, ' ')
  // 残留的点/下划线分隔符（如 .S01E03. / WEB.DL）统一转空格后再清集号段
  s = s.replace(/[._]+/g, ' ')
  s = s.replace(/[Ss]\d{1,2}[Ee]\d{1,3}/g, ' ')
  s = s.replace(/[Ee][Pp]?\d{1,3}(?![0-9])/g, ' ')
  s = s.replace(/(?:^|[\s\-])[Ss]\d{1,2}(?=$|[\s\-])/g, ' ')
  s = s.replace(/第\s*[0-9一二三四五六七八九十]+\s*[话集期回]/g, ' ')
  s = s.replace(/\s+/g, ' ').trim()
  return s.replace(/^[\s\-_·:：]+/, '').replace(/[\s\-_·:：]+$/, '')
}

/** 去掉「第X季 / Season X / Sxx / 年份」后缀，得到核心名 */
export function stripSeasonYearSuffix(input: string): string {
  let s = input || ''
  s = s.replace(/第\s*[0-9一二三四五六七八九十]+\s*[季部]/g, ' ')
  s = s.replace(/\bseasons?\s*\d{1,2}\b/gi, ' ')
  s = s.replace(/(?:^|[\s\-_·])[Ss]\d{1,2}(?=$|[\s\-_·])/g, ' ')
  s = s.replace(/[（(]?\b(19|20)\d{2}\b[)）]?/g, ' ')
  s = s.replace(/\s+/g, ' ').trim()
  return s.replace(/^[\s\-_·:：]+/, '').replace(/[\s\-_·:：]+$/, '')
}

/** 从标题中提取年份（19xx / 20xx），取第一个 */
export function extractYear(input: string): number | null {
  const m = (input || '').match(/(19|20)\d{2}/)
  return m ? Number(m[0]) : null
}

export type SearchVariantKind = 'raw' | 'cleaned' | 'core' | 'head' | 'simple' | 'traditional'

export interface SearchVariant {
  name: string
  kind: SearchVariantKind
}

/**
 * 生成搜索变体（有序、去重、最少 2 字符）：
 *   raw         原始名（保持既有行为：名字本来就能命中时优先用它）
 *   cleaned     去括号/噪音/集号（保留季号）
 *   core        再去季号 / 年份后缀（最常用的一档，如「田耕纪」）
 *   head        按分隔符取主标题首段（如「田耕纪 - 沈诺连蔓儿」→「田耕纪」）
 *   simple      core 的简体写法
 *   traditional core 的繁体写法
 */
export function buildSearchVariants(raw: string, maxVariants = 6): SearchVariant[] {
  const out: SearchVariant[] = []
  const seen = new Set<string>()
  const add = (name: string, kind: SearchVariantKind): void => {
    const n = (name || '').trim()
    if (n.length < 2 || seen.has(n)) return
    seen.add(n)
    out.push({ name: n, kind })
  }

  const src = (raw || '').trim()
  if (!src) return out

  add(src, 'raw')
  const cleaned = stripNoiseKeepSeason(src)
  add(cleaned, 'cleaned')
  const core = stripSeasonYearSuffix(cleaned)
  add(core, 'core')
  const head = core.split(/[-–—:：,，·|]/)[0] || ''
  add(head, 'head')
  const base = core || cleaned || src
  add(toSimplified(base), 'simple')
  add(toTraditional(base), 'traditional')

  return out.slice(0, maxVariants)
}

/** 比对用标题归一化：全角→半角、小写、繁→简、去括号/类型词/噪音/季号/标点空白 */
export function normalizeTitleForCompare(input: string): string {
  let s = toSimplified(toHalfWidth(input || '').toLowerCase())
  s = s.replace(/\.[a-z0-9]{2,4}$/, ' ')
  s = s.replace(/【[^】]*】|\[[^\]]*\]|\([^)]*\)|（[^）]*）/g, ' ')
  s = s.replace(/\bfrom\s*\S+/gi, ' ')
  s = s.replace(/\bseasons?\s*\d{1,2}\b/gi, ' ')
  s = s.replace(/第\s*[0-9一二三四五六七八九十]+\s*[季部]/g, '')
  s = s.replace(TYPE_WORD_RE, ' ')
  s = s.replace(NOISE_RE, ' ')
  s = s.replace(/[^0-9a-z\u4e00-\u9fa5]+/g, '')
  return s
}

/** 标题相似度（0-1）：相等 1；互相包含按长度比打折（防「同名前缀不同剧」误配）；否则字符重叠率（封顶 0.6） */
export function titleSimilarity(a: string, b: string): number {
  const na = normalizeTitleForCompare(a)
  const nb = normalizeTitleForCompare(b)
  if (!na || !nb) return 0
  if (na === nb) return 1
  if (na.includes(nb) || nb.includes(na)) {
    // 包含关系只是「前缀相同」，长度差越大越可能是另一部作品（如「田耕纪」vs「田耕纪实录」），
    // 因此按 短/长 比例打折；差距过大时直接按字符重叠率处理，避免跨剧误配弹幕
    const ratio = Math.min(na.length, nb.length) / Math.max(na.length, nb.length)
    return ratio >= 0.7 ? 0.8 * ratio : Math.min(0.6, 0.6 * ratio)
  }
  let common = 0
  for (const ch of na) if (nb.includes(ch)) common++
  return Math.min(0.6, common / Math.max(na.length, nb.length))
}

/** 中文数字 → 阿拉伯数字（十 / 十二 / 二十 / 二十三） */
export function cn2num(s: string): number {
  const map: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 }
  if (/^\d+$/.test(s)) return parseInt(s, 10)
  if (s === '十') return 10
  if (s.startsWith('十')) return 10 + (map[s[1]] || 0)
  if (s.endsWith('十')) return (map[s[0]] || 0) * 10
  if (s.includes('十')) {
    const parts = s.split('十')
    return (map[parts[0]] || 0) * 10 + (map[parts[1]] || 0)
  }
  return map[s] || 0
}

/** 从 animeTitle 推断季号（如「庆余年 第二季」→2、「Xxx Season 3」→3） */
export function inferSeasonFromTitle(title: string): number | null {
  if (!title) return null
  const s = toHalfWidth(title)
  let m = s.match(/第\s*([0-9一二三四五六七八九十]+)\s*季/)
  if (m) return cn2num(m[1])
  m = s.match(/Season\s*(\d{1,2})/i)
  if (m) return +m[1]
  return null
}

export interface CandidateMetaLike {
  seriesName?: string
  title?: string
  parentIndexNumber?: number | null
  productionYear?: number | null
}

export interface AnimeLike {
  animeId?: number
  animeTitle: string
}

export interface ScoredAnime<T extends AnimeLike> {
  anime: T
  score: number
  seasonHint: number | null
  yearHint: number | null
}

/**
 * 候选打分（0-1）：
 *   - 名称相似度为基础分
 *   - 季号吻合 +0.15 / 不符 -0.3（防跨季串弹幕）
 *   - 元数据第 1 季且候选无季号标记 +0.05
 *   - 年份吻合 +0.1 / 不符 -0.15（辅助消歧，如 2023 版 vs 老版）
 */
export function scoreAnimeCandidate<T extends AnimeLike>(
  meta: CandidateMetaLike,
  anime: T
): ScoredAnime<T> {
  const titleScore = titleSimilarity(meta.seriesName || meta.title || '', anime.animeTitle)
  const seasonHint = inferSeasonFromTitle(anime.animeTitle)
  const yearHint = extractYear(anime.animeTitle)
  let score = titleScore

  if (meta.parentIndexNumber != null && seasonHint != null) {
    score += seasonHint === meta.parentIndexNumber ? 0.15 : -0.3
  }
  if (meta.parentIndexNumber === 1 && seasonHint == null) score += 0.05
  if (meta.productionYear != null && yearHint != null) {
    score += yearHint === meta.productionYear ? 0.1 : -0.15
  }

  return { anime, score: Math.max(0, Math.min(1, score)), seasonHint, yearHint }
}

/** 对候选列表打分并按分数降序排序 */
export function rankAnimeCandidates<T extends AnimeLike>(
  meta: CandidateMetaLike,
  animes: T[]
): ScoredAnime<T>[] {
  return animes
    .map((a) => scoreAnimeCandidate(meta, a))
    .sort((x, y) => y.score - x.score)
}

/** 从 episodeTitle 解析集号（第X集/话/期/回、EP01、[01]、独立数字） */
export function extractEpisodeNumberFromTitle(title: string): number | null {
  const s = toHalfWidth(title || '')
  let m = s.match(/第\s*([0-9一二三四五六七八九十]+)\s*[话集期回]/)
  if (m) return cn2num(m[1])
  m = s.match(/[Ee][Pp]?(?:isode)?\s*0*(\d{1,4})(?![0-9])/)
  if (m) return +m[1]
  m = s.match(/\[(\d{1,4})\]/)
  if (m) return +m[1]
  m = s.match(/(?:^|[^0-9])(\d{1,4})(?:[^0-9]|$)/)
  if (m) return +m[1]
  return null
}

export interface EpisodeLike {
  episodeId: number
  episodeTitle?: string
}

/**
 * 定位目标集：
 *   1) 优先按 episodeTitle 里的集号匹配（服务端集列表顺序不保证与集号一致）；
 *   2) 标题都解析不出集号时，退化为「第 N 集 = 第 N 项」的下标定位；
 *   3) 均不可得 → null（不强制回退第 1 集，交由 UI 手动选择）。
 */
export function locateEpisodeIndex(
  episodes: EpisodeLike[],
  episode: number | null
): { index: number; byTitle: boolean } | null {
  if (episode == null || episodes.length === 0) return null
  for (let i = 0; i < episodes.length; i++) {
    const num = extractEpisodeNumberFromTitle(episodes[i].episodeTitle || '')
    if (num === episode) return { index: i, byTitle: true }
  }
  const idx = episode - 1
  if (idx >= 0 && idx < episodes.length) return { index: idx, byTitle: false }
  return null
}
