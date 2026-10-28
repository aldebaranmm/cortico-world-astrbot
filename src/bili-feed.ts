/**
 * B 站接口直取：不开浏览器、不滚动、不截图、不看封面图，一次拿一批结构化卡片。
 *
 * 用来替代 playwright 那条路。原来的做法要拉起 Edge → 打开页面 → 等加载 → 自然滚动 → 抓 DOM，
 * 慢一个数量级；走公开接口是秒级，而且标题 + UP + 分区 + 简介这些字段判断内容类型，
 * 比让模型去看封面图更准。
 */
import type { DouyinResult } from './douyin.ts';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/** 公开接口，免登录。热门偏新，排行榜偏热，两个掺着来更像"刷"。 */
const FEEDS = [
  'https://api.bilibili.com/x/web-interface/popular?ps=30&pn=1',
  'https://api.bilibili.com/x/web-interface/ranking/v2?rid=0&type=all',
];

function num(n: unknown): string {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return '';
  if (v >= 100_000_000) return `${(v / 100_000_000).toFixed(1)}亿`;
  if (v >= 10_000) return `${(v / 10_000).toFixed(1)}万`;
  return String(v);
}

function firstLine(s: unknown, n = 40): string {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  if (!t || t === '-') return '';
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

/**
 * 一条视频 → 上报用的卡片。
 * 只给 text、不给 cover：AstrBot 侧封面为空时走纯文本分析，比多模态看图快得多。
 */
function toCard(v: unknown): Record<string, unknown> | null {
  const o = (v ?? {}) as Record<string, any>;
  const title = String(o.title ?? '').trim();
  if (!title) return null;
  const parts = [title];
  const owner = String(o.owner?.name ?? '').trim();
  if (owner) parts.push(`UP：${owner}`);
  const tname = String(o.tname ?? '').trim();
  if (tname) parts.push(tname);
  const view = num(o.stat?.view);
  if (view) parts.push(`播放 ${view}`);
  const desc = firstLine(o.desc, 40);
  if (desc) parts.push(desc);
  return { text: parts.join('｜'), bvid: String(o.bvid ?? '') };
}

/** 拉热门 + 排行榜，去重后返回给 AstrBot 分析。 */
export async function fetchBilibiliCards(limit = 30): Promise<DouyinResult> {
  const cards: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();

  const absorb = (list: unknown): void => {
    if (!Array.isArray(list)) return;
    for (const v of list) {
      if (cards.length >= limit) return;
      const o = (v ?? {}) as Record<string, any>;
      const key = String(o.bvid ?? o.title ?? '');
      if (!key || seen.has(key)) continue;
      const card = toCard(o);
      if (!card) continue;
      seen.add(key);
      cards.push(card);
    }
  };

  for (const url of FEEDS) {
    try {
      const resp = await fetch(url, {
        headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9' },
        signal: AbortSignal.timeout(15_000),
      });
      if (!resp.ok) continue;
      const j = (await resp.json()) as Record<string, any>;
      if (j?.code !== 0) continue;
      absorb(j?.data?.list);
    } catch {
      // 单个源失败不影响另一个；全失败则由调用方看到空卡片
    }
    if (cards.length >= limit) break;
  }

  return { loggedIn: false, cards };
}
