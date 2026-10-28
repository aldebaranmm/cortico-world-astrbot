import { chromium } from 'playwright-core';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// 命令行参数：--headful 有头（窗口前置）、--duration=N 持续刷 N 秒、
// --wait=N 未登录时等 N 秒让主人扫码、--hold=N 刷完后把窗口留 N 秒再关
const argv = process.argv.slice(2);
const headful = argv.includes('--headful');
const durArg = argv.find((a) => a.startsWith('--duration='));
// 0 = 不限时（没叫停就一直看）；注意别用 Math.max(10,...)，那会把 0 顶成 10 秒
const durationSec = durArg ? Math.max(0, parseInt(durArg.split('=')[1], 10)) : 300;
const waitArg = argv.find((a) => a.startsWith('--wait='));
const waitSec = waitArg ? Math.max(0, parseInt(waitArg.split('=')[1], 10)) : 0;
const holdArg = argv.find((a) => a.startsWith('--hold='));
const holdSec = holdArg ? Math.max(0, parseInt(holdArg.split('=')[1], 10)) : 0;
// --watch=N 点开一条看 N 秒（0 = 只翻不看）；--every=N 每翻几轮点开一条
const watchArg = argv.find((a) => a.startsWith('--watch='));
const watchSec = watchArg ? Math.max(0, parseInt(watchArg.split('=')[1], 10)) : 45;
const everyArg = argv.find((a) => a.startsWith('--every='));
const everyN = everyArg ? Math.max(1, parseInt(everyArg.split('=')[1], 10)) : 2;
// --bvid=BVxxx 桌宠按自己的口味挑了一条，先去看这条，再接着刷 feed
const bvArg = argv.find((a) => a.startsWith('--bvid='));
const bvid = bvArg ? (bvArg.split('=')[1] || '').trim() : '';

// 登录态持久化：固定 profile 目录（扩展目录下），登录一次以后都算登录
const PROFILE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '.browser-profile-bilibili');

// 浏览器按常见路径自动探测，别硬编码——不同机器 Edge/Chrome 位置不一样
function findBrowser() {
  const candidates = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    `${process.env.LOCALAPPDATA || ''}\\Microsoft\\Edge\\Application\\msedge.exe`,
  ];
  for (const p of candidates) {
    try {
      if (p && existsSync(p)) return p;
    } catch {
      /* 继续试下一个 */
    }
  }
  return candidates[0];
}

const EDGE = findBrowser();
const URL = 'https://www.bilibili.com/';

function rand(min, max) { return min + Math.random() * (max - min); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// 抓当前视口内的视频卡片：标题、UP主、播放量/弹幕、封面图 URL
// B 站首页 feed 卡片：.feed-card > .bili-video-card.is-rcmd
async function scrapeCards(page) {
  return page.evaluate(() => {
    const out = [];
    for (const card of document.querySelectorAll('.feed-card, .bili-video-card.is-rcmd')) {
      const titleEl = card.querySelector('.bili-video-card__info--tit');
      const ownerEl = card.querySelector('.bili-video-card__info--owner');
      const imgEl = card.querySelector('.bili-video-card__wrap img, img');
      const title = (titleEl?.innerText || '').trim();
      if (!title) continue;
      let cover = imgEl ? (imgEl.getAttribute('src') || imgEl.getAttribute('data-src') || '') : '';
      if (cover.startsWith('//')) cover = 'https:' + cover; // 协议相对 URL 补 https
      // UP 主那格可能是「名字\n· 日期」两行，只取第一行
      const owner = (ownerEl?.innerText || '').trim().split('\n')[0].trim();
      const stats = [...card.querySelectorAll('.bili-video-card__stats--item')]
        .map((s) => (s.innerText || '').trim())
        .filter(Boolean);
      out.push({
        text: title.slice(0, 180),
        author: owner,
        like: stats.join('/'),
        cover,
      });
    }
    return out;
  });
}

// 挑一条还没点开过的：按主人的口味打分，收藏过的 UP 主最优先，
// 标题里命中收藏关键词的其次；前几名里随机挑一个，别每次都点同一条
async function pickUnwatched(page, seen, taste, recent) {
  return page.evaluate((arg) => {
    const { seenList, owners, keywords, recentWords } = arg;
    const cands = [];
    for (const a of document.querySelectorAll('a[href*="/video/"]')) {
      const href = a.getAttribute('href') || '';
      const m = href.match(/\/video\/(BV[0-9A-Za-z]+)/);
      if (!m || seenList.includes(m[1])) continue;
      const card = a.closest('.bili-video-card') || a;
      const titEl = card.querySelector('.bili-video-card__info--tit');
      const ownEl = card.querySelector('.bili-video-card__info--owner');
      const title = (titEl?.innerText || '').trim();
      const owner = (ownEl?.innerText || '').trim().split('\n')[0].trim();
      let score = 0;
      if (owner && owners.includes(owner)) score += 5; // 主人收藏过的 UP 主
      for (const kw of keywords) {
        if (kw && title.includes(kw)) { score += 2; break; } // 命中收藏里的关键词
      }
      // 主人明确看烦的两类：工具/软件教程类，跟「大肥鱼」自己相关的。
      // 不硬排除（怕没得挑），重罚到基本排不上号。
      const BORING = [
        '教程', '教学', '攻略', '指南', '入门', '手把手', '保姆级', '从零',
        '如何', '怎么', '安装', '部署', '配置', '详解', '讲解', '一键', '脚本',
        '大肥鱼', '肥鱼', '鲸鱼娘', '桌宠',
      ];
      for (const w of BORING) {
        if (title.includes(w)) { score -= 8; break; }
      }
      // 同一个题材别连着看：和刚看过的几条撞词越多，分压得越低
      const ws = [...title.matchAll(/[\u4e00-\u9fa5A-Za-z0-9]{2,6}/g)].map((x) => x[0]);
      for (const rw of recentWords) {
        let dup = 0;
        for (const w of ws) if (rw.includes(w)) dup++;
        score -= Math.min(dup, 5) * 3; // 压得过「收藏过的 UP 主 +5」，同一个题材才不会连着看
      }
      cands.push({ bv: m[1], title: title.slice(0, 80), owner, score });
    }
    if (!cands.length) return null;
    cands.sort((x, y) => y.score - x.score);
    const top = cands.slice(0, Math.min(3, cands.length));
    return top[Math.floor(Math.random() * top.length)];
  }, { seenList: [...seen], owners: taste?.owners ?? [], keywords: taste?.keywords ?? [], recentWords: recent ?? [] });
}

/**
 * 读播放页上这条视频的标题、UP 主和简介。
 * 有简介，桌宠说出来的才是「这条讲什么」，而不只是干念一遍标题。
 * 选择器随 B 站改版会变，所以每个都给几个备选，读不到就返回 null 由调用方兜底。
 */
async function videoInfo(target) {
  return target
    .evaluate(() => {
      const pick = (sels) => {
        for (const s of sels) {
          const el = document.querySelector(s);
          const t = (el?.innerText || '').trim();
          if (t) return t;
        }
        return '';
      };
      const title = pick(['h1.video-title', '.video-title', 'h1']).slice(0, 80);
      if (!title) return null;
      return {
        title,
        up: pick(['.up-name', '.up-info .name', '.up-detail .name', '.up-info--name']).slice(0, 30),
        desc: pick(['.desc-info-text', '.video-desc', '.basic-desc-info', '#v_desc']).slice(0, 160),
      };
    })
    .catch(() => null);
}

/** 读播放页里视频的时长（秒）。播放器异步加载，读不到就隔一会儿再试。 */
async function videoDuration(target) {
  for (let i = 0; i < 5; i++) {
    const d = await target
      .evaluate(() => {
        const v = document.querySelector('video');
        return v && Number.isFinite(v.duration) ? v.duration : 0;
      })
      .catch(() => 0);
    if (d > 0) return d;
    await sleep(1500);
  }
  return 0;
}

/** 一直看到这条播完（短片用）。最多等 maxSec 秒，免得卡在加载上。 */
async function watchToEnd(target, maxSec) {
  const started = Date.now();
  let lastT = 0;
  while (Date.now() - started < maxSec * 1000) {
    const st = await target
      .evaluate(() => {
        const v = document.querySelector('video');
        if (!v) return null;
        return {
          t: Number(v.currentTime) || 0,
          d: Number.isFinite(v.duration) ? v.duration : 0,
          ended: v.ended === true,
        };
      })
      .catch(() => null);
    if (!st) break;
    if (st.ended) return true; // 播完了
    if (st.d > 0 && st.t >= st.d - 1.5) return true; // 到片尾了
    if (st.t + 1 < lastT) return true; // 自动连播跳到下一条，这条算看完
    lastT = st.t;
    await sleep(2000);
  }
  return false;
}

// 点开一条看一会儿——真人刷视频是会点进去看的，光翻封面不算「在看」
// B 站首页点击通常开新标签，所以一边点一边等 popup；没开就是当前页跳转，看完退回来
async function watchOneVideo(page, bv, sec, title) {
  const popupPromise = page.waitForEvent('popup', { timeout: 10000 }).catch(() => null);
  await page.evaluate((id) => {
    const a = [...document.querySelectorAll('a[href*="/video/"]')].find(
      (x) => (x.getAttribute('href') || '').includes(id),
    );
    if (a) a.click();
  }, bv);
  const popup = await popupPromise;
  if (popup) await popup.waitForLoadState('domcontentloaded').catch(() => {});
  const target = popup || page;
  // 打开就报这条的内容（标题 + 简介），桌宠好就着眼前这个说；
  // 等看完再报，屏幕上早换成下一条了
  await sleep(2000);
  const info = await videoInfo(target);
  const shown = info?.title || title || '';
  if (shown) {
    console.log(
      JSON.stringify({
        v: `正在看：${shown}${info?.desc ? `。这条讲的是：${info.desc}` : ''}`,
        a: info?.up || '',
      }),
    );
  }
  // 五分钟以内的短片：一直看到播完。更长的看一段就划走——真人也不会把长片从头看到尾。
  const dur = await videoDuration(target);
  if (dur > 0 && dur <= 300) {
    // 五分钟以内的短片：一直看到播完
    await watchToEnd(target, Math.ceil(dur) + 90);
  } else {
    // 长片：至少看满五分钟，再多看一点随缘——看两眼就走太假了
    await sleep((300 + Math.round(Math.random() * 90)) * 1000);
  }
  if (popup) {
    await popup.close().catch(() => {});
    await page.bringToFront().catch(() => {}); // 关掉播放页后把 feed 拉回最前面
    return;
  }
  // 没开新标签：页面在当前标签跳转了，看完按返回键退回去
  await page.goBack({ waitUntil: 'domcontentloaded' }).catch(() => {});
}

// 已登录时把主人的收藏夹**整个**抓一遍——这是「他喜欢什么」最直接的证据。
// 全部收藏夹都要，每个夹翻到最后一页；之前只取前 8 个夹的第 1 页，1435 条只捞到 109 条。
// 在页面内 fetch，自带登录 cookie，不用管鉴权。
async function fetchFavorites(page) {
  return page.evaluate(async () => {
    const out = [];
    const pause = (ms) => new Promise((r) => setTimeout(r, ms));
    try {
      const nav = await fetch('https://api.bilibili.com/x/web-interface/nav', { credentials: 'include' }).then((r) => r.json());
      const mid = nav?.data?.mid;
      if (!mid) return out;
      const folders = await fetch(`https://api.bilibili.com/x/v3/fav/folder/created/list-all?up_mid=${mid}`, { credentials: 'include' }).then((r) => r.json());
      for (const f of folders?.data?.list ?? []) {
        for (let pn = 1; pn <= 200; pn++) {
          let res;
          try {
            res = await fetch(`https://api.bilibili.com/x/v3/fav/resource/list?media_id=${f.id}&pn=${pn}&ps=20`, { credentials: 'include' }).then((r) => r.json());
          } catch {
            break;
          }
          if (!res || res.code !== 0) break; // 被限流或没权限就换下一个夹
          const medias = res?.data?.medias ?? [];
          for (const m of medias) {
            out.push({ title: m.title, owner: m.upper?.name || '', bvid: m.bvid || '', folder: f.title || '' });
          }
          if (!res?.data?.has_more || medias.length === 0) break;
          await pause(150); // 别把接口打太急，容易触发限流
        }
      }
    } catch {
      /* 抓不到就按已有部分处理 */
    }
    return out;
  });
}

// 从收藏里提炼口味：收藏过的 UP 主 + 收藏夹名 + 标题里**反复出现**的词。
// 收藏上千条时词会非常多，只留出现 2 次以上的高频词，才真的代表口味。
function buildTaste(list) {
  const owners = new Set();
  const folders = new Set();
  const wordCount = new Map();
  for (const it of list) {
    if (it.owner) owners.add(it.owner);
    if (it.folder) folders.add(it.folder);
    for (const m of (it.title || '').matchAll(/[\u4e00-\u9fa5A-Za-z0-9]{2,6}/g)) {
      wordCount.set(m[0], (wordCount.get(m[0]) || 0) + 1);
    }
  }
  const hot = [...wordCount.entries()]
    .filter(([, n]) => n >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 300)
    .map(([w]) => w);
  return { owners: [...owners], keywords: [...folders, ...hot].slice(0, 400) };
}

// 标题拆成词，用来判断两条是不是同一个题材
function wordsOf(t) {
  return [...(t || '').matchAll(/[\u4e00-\u9fa5A-Za-z0-9]{2,6}/g)].map((m) => m[0]);
}

// 判断登录态：顶部有头像且无「登录」按钮 = 已登录
async function checkLogin(page) {
  return page.evaluate(() => {
    const hasLoginBtn = [...document.querySelectorAll('a,div,span')].some(
      (el) => /^登录$/.test((el.innerText || '').trim()),
    );
    const avatar = document.querySelector('.header-avatar-wrap img, [class*="avatar"] img');
    return !!avatar && !hasLoginBtn;
  });
}

async function main() {
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    executablePath: EDGE,
    headless: !headful,
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
    viewport: { width: 1280, height: 800 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    locale: 'zh-CN',
  });
  const page = context.pages()[0] || await context.newPage();
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(5000);
  await page.keyboard.press('Escape'); // 关「登录哔哩哔哩」提示框
  await sleep(1500);
  if (headful) await page.bringToFront(); // 窗口前置
  // 先检测登录态，上报给扩展（扩展据此决定要不要问主人登录）
  let loggedIn = await checkLogin(page);
  console.log(JSON.stringify({ loginStatus: loggedIn }));
  if (!loggedIn && waitSec > 0) {
    // 未登录：停下来等主人登录（扩展会问主人要不要登录）
    console.log(JSON.stringify({ msg: `未登录，等主人决定（${waitSec} 秒）` }));
    await sleep(waitSec * 1000);
    loggedIn = await checkLogin(page); // 重新检测，看主人是否登录了
  }

  // 收藏：一天内抓过就直接用缓存，没有才抓——上千条全量要十几秒，不该每次刷都抓一遍
  const FAV_FILE = join(dirname(fileURLToPath(import.meta.url)), '..', 'favorites.json');
  const FAV_MAX_AGE = 24 * 3600 * 1000;
  let favs = [];
  if (existsSync(FAV_FILE)) {
    try {
      const j = JSON.parse(readFileSync(FAV_FILE, 'utf8'));
      if (Array.isArray(j?.items) && j.items.length && Date.now() - (j.at || 0) < FAV_MAX_AGE) {
        favs = j.items;
      }
    } catch {
      /* 坏文件就当没有，下面重新抓 */
    }
  }
  if (loggedIn && favs.length === 0) {
    favs = await fetchFavorites(page);
    if (favs.length) {
      try {
        writeFileSync(FAV_FILE, JSON.stringify({ at: Date.now(), items: favs }, null, 1), 'utf8');
      } catch {
        /* 存不下不影响刷 */
      }
    }
  }
  let taste = { owners: [], keywords: [] };
  if (favs.length) {
    taste = buildTaste(favs);
    console.log(JSON.stringify({ msg: `照收藏挑：${favs.length} 条，认得 ${taste.owners.length} 个 UP 主` }));
  }

  // 最近看过的几条的标题词：同一个题材别连着看
  const recentWords = [];
  // 主页上翻到的，开场报几句就够了；之后桌宠该说的是点开看的视频，
  // 再报列表就会出现「嘴里念的」和「屏幕上放的」不是一回事。
  const FEED_MAX = 6;
  let feedLines = 0;

  // 桌宠按自己的口味挑了一条：先点开真的看一会儿，再回 feed 接着刷
  if (bvid) {
    await page.goto(`https://www.bilibili.com/video/${bvid}`, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    if (headful) await page.bringToFront().catch(() => {});
    const bvTitle = await page.title().catch(() => '');
    recentWords.push(wordsOf(bvTitle || bvid));
    // 同样是打开就报，桌宠好就着眼前这条说
    console.log(JSON.stringify({ v: `正在看：${bvTitle || bvid}`, a: '' }));
    // 同样是短片看完、长片看一段
    const dur = await videoDuration(page);
    if (dur > 0 && dur <= 300) {
      await watchToEnd(page, Math.ceil(dur) + 90);
    } else {
      // 同样是至少看满五分钟
      await sleep((300 + Math.round(Math.random() * 90)) * 1000);
    }
    await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(3000);
  }

  const all = [];
  const seen = new Set();
  const watched = new Set(); // 已经点开看过的 BV 号，避免重复点同一条
  let round = 0;
  const started = Date.now();
  // durationSec=0 表示不限时：没让停就一直看，直到主人自己关掉浏览器 / 桌宠叫停
  const endless = durationSec <= 0;
  const REPORT_EVERY = 10;
  let pending = []; // 攒够一批就上报一次——不限时的话永远等不到「刷完」，必须边刷边报
  let reportedAny = false;
  let curLoggedIn = loggedIn;
  while (endless || Date.now() - started < durationSec * 1000) {
    try {
      const batch = await scrapeCards(page);
      for (const c of batch) {
        const key = c.text.slice(0, 40);
        if (!seen.has(key)) {
          seen.add(key); all.push(c); pending.push(c); // 全都攒着上报，只是不再逐条念给桌宠
          if (feedLines < FEED_MAX) {
            console.log(JSON.stringify({ v: c.text.slice(0, 80), a: c.author }));
            feedLines++;
          }
        }
      }
      // 攒够一批就上报：不限时的情况下根本没有「刷完」这一刻，必须边刷边交
      if (pending.length >= REPORT_EVERY) {
        console.log(JSON.stringify({ loggedIn: curLoggedIn, count: all.length, cards: pending }));
        pending = [];
        reportedAny = true;
      }
      // 每隔几轮点开一条真的看一会儿（--watch=0 就只翻不看）
      round++;
      if (watchSec > 0 && round % everyN === 0) {
        const pick = await pickUnwatched(page, watched, taste, recentWords);
        if (pick) {
          watched.add(pick.bv);
          recentWords.push(wordsOf(pick.title));
          if (recentWords.length > 3) recentWords.shift(); // 只跟最近 3 条比，别管太远
          await watchOneVideo(page, pick.bv, watchSec, pick.title);
          continue;
        }
      }
      const delta = rand(500, 1300);          // 自然滚动幅度
      await page.mouse.wheel(0, delta);
      await sleep(rand(1600, 4000));          // 自然停顿
    } catch {
      // 浏览器被主人手动关了，停止刷
      break;
    }
  }

  // 收尾：把还没报出去的补上（不限时的话走到这儿，通常是主人自己关了浏览器）
  const finalLoggedIn = await checkLogin(page).catch(() => curLoggedIn);
  if (pending.length) {
    console.log(JSON.stringify({ loggedIn: finalLoggedIn, count: all.length, cards: pending }));
  } else if (!reportedAny && all.length) {
    // 一次都没报过（刷得太短），把攒下的全交上去
    console.log(JSON.stringify({ loggedIn: finalLoggedIn, count: all.length, cards: all }));
  }
  if (holdSec > 0) {
    // 主人要看它刷：刷完别立刻关窗口，留在屏幕上让他看够、自己接着翻
    console.log(JSON.stringify({ msg: `刷完了，窗口再留 ${holdSec} 秒` }));
    await sleep(holdSec * 1000);
  }
  await context.close();
}

main().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
