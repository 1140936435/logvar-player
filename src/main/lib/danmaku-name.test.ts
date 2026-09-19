import { describe, it, expect } from 'vitest'
import {
  DANMAKU_AUTO_MATCH_MIN_SCORE,
  buildSearchVariants,
  cn2num,
  extractEpisodeNumberFromTitle,
  extractYear,
  inferSeasonFromTitle,
  locateEpisodeIndex,
  normalizeTitleForCompare,
  rankAnimeCandidates,
  scoreAnimeCandidate,
  stripNoiseKeepSeason,
  stripSeasonYearSuffix,
  titleSimilarity,
  toHalfWidth,
  toSimplified,
  toTraditional
} from './danmaku-name'

// 真实服务端样本（http://100.66.1.2:9321）
const REAL_ANIME_TITLE = '田耕纪(2023)【电视剧】from 360'
const REAL_EPISODES = Array.from({ length: 26 }, (_, i) => ({
  episodeId: 15385 + i,
  episodeTitle: `【qiyi】 第${i + 1}集`
}))

describe('名称归一化', () => {
  it('全角转半角', () => {
    expect(toHalfWidth('田耕纪（２０２３）')).toBe('田耕纪(2023)')
  })

  it('简繁互转（常用字）', () => {
    expect(toSimplified('田耕紀')).toBe('田耕纪')
    expect(toTraditional('田耕纪')).toBe('田耕紀')
    expect(toSimplified('仙劍奇俠傳')).toBe('仙剑奇侠传')
  })

  it('去括号年份与来源标记', () => {
    expect(stripNoiseKeepSeason('田耕纪(2023)【电视剧】from 360')).toBe('田耕纪')
    expect(stripNoiseKeepSeason('庆余年 第二季 [1080p]')).toBe('庆余年 第二季')
    expect(stripNoiseKeepSeason('庆余年.S01E03.1080p.WEB-DL.mkv')).toBe('庆余年')
  })

  it('去季号/年份后缀保留核心名', () => {
    expect(stripSeasonYearSuffix('庆余年 第二季')).toBe('庆余年')
    expect(stripSeasonYearSuffix('庆余年 Season 2')).toBe('庆余年')
    expect(stripSeasonYearSuffix('庆余年 S02')).toBe('庆余年')
    expect(stripSeasonYearSuffix('田耕纪 2023')).toBe('田耕纪')
  })

  it('提取年份与季号', () => {
    expect(extractYear(REAL_ANIME_TITLE)).toBe(2023)
    expect(extractYear('无年份的剧')).toBeNull()
    expect(inferSeasonFromTitle('庆余年 第二季')).toBe(2)
    expect(inferSeasonFromTitle('Xxx Season 3')).toBe(3)
    expect(inferSeasonFromTitle('田耕纪(2023)【电视剧】from 360')).toBeNull()
  })
})

describe('搜索变体构建', () => {
  it('干净名优先原样使用（保持既有行为不回归）', () => {
    const v = buildSearchVariants('田耕纪')
    expect(v[0]).toEqual({ name: '田耕纪', kind: 'raw' })
  })

  it('中文名带季号后缀 → 变体中出现核心名（服务端对「田耕纪 第一季」返回 0 候选）', () => {
    const names = buildSearchVariants('田耕纪 第一季').map((v) => v.name)
    expect(names).toContain('田耕纪')
    expect(names[0]).toBe('田耕纪 第一季')
  })

  it('名称含年份括号 → 变体中出现去括号核心名', () => {
    const variants = buildSearchVariants('田耕纪(2023)')
    const names = variants.map((v) => v.name)
    expect(names).toContain('田耕纪')
    expect(variants.find((v) => v.name === '田耕纪')?.kind).toBe('cleaned')
    expect(names[1]).toBe('田耕纪')
  })

  it('繁简差异 → 变体同时覆盖简体与繁体写法', () => {
    const names = buildSearchVariants('田耕紀').map((v) => v.name)
    expect(names).toContain('田耕纪')
    expect(names).toContain('田耕紀')
    expect(new Set(names).size).toBe(names.length)
  })

  it('主标题带副标题 → 出现首段变体', () => {
    const names = buildSearchVariants('田耕纪 - 沈诺连蔓儿').map((v) => v.name)
    expect(names).toContain('田耕纪')
  })

  it('空名 / 过短名 → 不生成变体；数量受限', () => {
    expect(buildSearchVariants('')).toEqual([])
    expect(buildSearchVariants('   ')).toEqual([])
    expect(buildSearchVariants('A')).toEqual([])
    expect(buildSearchVariants('田耕纪(2023)【电视剧】from 360 第二季', 3).length).toBeLessThanOrEqual(3)
  })

  it('变体去重（同一名称不重复出现）', () => {
    const v = buildSearchVariants('田耕纪')
    const names = v.map((x) => x.name)
    expect(new Set(names).size).toBe(names.length)
  })
})

describe('候选打分与择优', () => {
  const meta = { seriesName: '田耕纪', parentIndexNumber: 1, productionYear: 2023 }

  it('标题相似度：真机候选标题与元数据剧名视为同一部', () => {
    expect(titleSimilarity('田耕纪', REAL_ANIME_TITLE)).toBe(1)
    expect(titleSimilarity('田耕纪', '田耕紀')).toBe(1)
    expect(titleSimilarity('田耕纪', '庆余年')).toBeLessThan(0.4)
  })

  it('年份吻合加分、年份不符减分', () => {
    const hit = scoreAnimeCandidate(meta, { animeTitle: REAL_ANIME_TITLE })
    const miss = scoreAnimeCandidate({ ...meta, productionYear: 2019 }, { animeTitle: REAL_ANIME_TITLE })
    expect(hit.score).toBeGreaterThan(miss.score)
    expect(hit.yearHint).toBe(2023)
  })

  it('季号不符显著降分（防跨季串弹幕）', () => {
    const s1 = scoreAnimeCandidate(meta, { animeTitle: '田耕纪 第一季' })
    const s2 = scoreAnimeCandidate(meta, { animeTitle: '田耕纪 第二季' })
    expect(s1.score).toBeGreaterThan(s2.score)
    expect(s1.score - s2.score).toBeGreaterThanOrEqual(0.25)
  })

  it('多候选打分择优：年份 + 季号吻合者排第一', () => {
    const ranked = rankAnimeCandidates(meta, [
      { animeTitle: '田耕纪 第二季【电视剧】from 360' },
      { animeTitle: '田耕纪(2023)【电视剧】from 360' },
      { animeTitle: '田耕纪实录 2021' }
    ])
    expect(ranked[0].anime.animeTitle).toBe(REAL_ANIME_TITLE)
    expect(ranked[0].score).toBeGreaterThanOrEqual(ranked[1].score)
    expect(ranked[0].score).toBeGreaterThanOrEqual(DANMAKU_AUTO_MATCH_MIN_SCORE)
  })

  it('无候选时降级：排序结果为空，不抛异常', () => {
    expect(rankAnimeCandidates(meta, [])).toEqual([])
  })

  it('候选均不相关时最高分低于自动命中阈值（走人工选择）', () => {
    const ranked = rankAnimeCandidates(meta, [{ animeTitle: '武林外传(2006)【电视剧】from 360' }])
    expect(ranked[0].score).toBeLessThan(DANMAKU_AUTO_MATCH_MIN_SCORE)
  })

  it('同名前缀不同剧（田耕纪 vs 田耕纪实录）不得自动命中', () => {
    expect(titleSimilarity('田耕纪', '田耕纪实录')).toBeLessThan(DANMAKU_AUTO_MATCH_MIN_SCORE)
    const ranked = rankAnimeCandidates(meta, [{ animeTitle: '田耕纪实录 2021' }])
    expect(ranked[0].score).toBeLessThan(DANMAKU_AUTO_MATCH_MIN_SCORE)
  })

  it('归一化比对会剔除类型词与来源标记', () => {
    expect(normalizeTitleForCompare(REAL_ANIME_TITLE)).toBe('田耕纪')
  })
})

describe('集号解析与定位', () => {
  it('解析真实 episodeTitle', () => {
    expect(extractEpisodeNumberFromTitle('【qiyi】 第1集')).toBe(1)
    expect(extractEpisodeNumberFromTitle('第26集')).toBe(26)
    expect(extractEpisodeNumberFromTitle('【youku】 第10期')).toBe(10)
    expect(extractEpisodeNumberFromTitle('EP07')).toBe(7)
    expect(cn2num('二十三')).toBe(23)
  })

  it('按标题集号定位（顺序与集号不一致时仍正确）', () => {
    const eps = [
      { episodeId: 1, episodeTitle: '第2集' },
      { episodeId: 2, episodeTitle: '第1集' }
    ]
    expect(locateEpisodeIndex(eps, 1)).toEqual({ index: 1, byTitle: true })
    expect(locateEpisodeIndex(eps, 2)).toEqual({ index: 0, byTitle: true })
  })

  it('标题无集号时按第 N 集 = 第 N 项兜底', () => {
    const eps = REAL_EPISODES.map((e) => ({ episodeId: e.episodeId, episodeTitle: '正片' }))
    expect(locateEpisodeIndex(eps, 3)).toEqual({ index: 2, byTitle: false })
  })

  it('真实 26 集样本：第 1 集定位到 episodeId 15385', () => {
    const located = locateEpisodeIndex(REAL_EPISODES, 1)
    expect(located).not.toBeNull()
    expect(REAL_EPISODES[located!.index].episodeId).toBe(15385)
  })

  it('越界集号返回 null（不强制回退第 1 集）', () => {
    expect(locateEpisodeIndex(REAL_EPISODES, 99)).toBeNull()
    expect(locateEpisodeIndex(REAL_EPISODES, null)).toBeNull()
    expect(locateEpisodeIndex([], 1)).toBeNull()
  })
})
