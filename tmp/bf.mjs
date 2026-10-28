// src/bili-feed.ts
var UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
var FEEDS = [
  "https://api.bilibili.com/x/web-interface/popular?ps=30&pn=1",
  "https://api.bilibili.com/x/web-interface/ranking/v2?rid=0&type=all"
];
function num(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return "";
  if (v >= 1e8) return `${(v / 1e8).toFixed(1)}\u4EBF`;
  if (v >= 1e4) return `${(v / 1e4).toFixed(1)}\u4E07`;
  return String(v);
}
function firstLine(s, n = 40) {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  if (!t || t === "-") return "";
  return t.length > n ? `${t.slice(0, n)}\u2026` : t;
}
function toCard(v) {
  const o = v ?? {};
  const title = String(o.title ?? "").trim();
  if (!title) return null;
  const parts = [title];
  const owner = String(o.owner?.name ?? "").trim();
  if (owner) parts.push(`UP\uFF1A${owner}`);
  const tname = String(o.tname ?? "").trim();
  if (tname) parts.push(tname);
  const view = num(o.stat?.view);
  if (view) parts.push(`\u64AD\u653E ${view}`);
  const desc = firstLine(o.desc, 40);
  if (desc) parts.push(desc);
  return { text: parts.join("\uFF5C"), bvid: String(o.bvid ?? "") };
}
async function fetchBilibiliCards(limit = 30) {
  const cards = [];
  const seen = /* @__PURE__ */ new Set();
  const absorb = (list) => {
    if (!Array.isArray(list)) return;
    for (const v of list) {
      if (cards.length >= limit) return;
      const o = v ?? {};
      const key = String(o.bvid ?? o.title ?? "");
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
        headers: { "User-Agent": UA, "Accept-Language": "zh-CN,zh;q=0.9" },
        signal: AbortSignal.timeout(15e3)
      });
      if (!resp.ok) continue;
      const j = await resp.json();
      if (j?.code !== 0) continue;
      absorb(j?.data?.list);
    } catch {
    }
    if (cards.length >= limit) break;
  }
  return { loggedIn: false, cards };
}
export {
  fetchBilibiliCards
};
