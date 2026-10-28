import { chromium } from 'playwright-core';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// 命令行参数：--headful 有头（窗口前置）、--duration=N 持续刷 N 秒、--wait=N 等 N 秒让主人登录
const argv = process.argv.slice(2);
const headful = argv.includes('--headful');
const durArg = argv.find((a) => a.startsWith('--duration='));
const durationSec = durArg ? Math.max(10, parseInt(durArg.split('=')[1], 10)) : 300;
const waitArg = argv.find((a) => a.startsWith('--wait='));
const waitSec = waitArg ? Math.max(0, parseInt(waitArg.split('=')[1], 10)) : 0;

// 登录态持久化：固定 profile 目录（扩展目录下），登录一次以后都算登录
const PROFILE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '.browser-profile-douyin');

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
const URL = 'https://www.douyin.com/jingxuan';

function rand(min, max) { return min + Math.random() * (max - min); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// 抓当前视口内的视频卡片：标题、作者、点赞、封面图 URL
async function scrapeCards(page) {
  return page.evaluate(() => {
    const out = [];
    // 抖音精选页卡片：包含「@作者」和数字的块。逐个卡片取。
    const anchors = [...document.querySelectorAll('a, li, [class*="card"], [class*="item"]')];
    for (const el of anchors) {
      const text = (el.innerText || '').trim();
      // 卡片特征：有 @作者 且 有数字（点赞/时长）
      if (!/@[\u4e00-\u9fa5\w]/.test(text) || !/[0-9]/.test(text)) continue;
      const img = el.querySelector('img');
      const imgSrc = img ? (img.getAttribute('src') || img.getAttribute('data-src') || '') : '';
      // 提取 @作者（第一个 @xxx）
      const authorMatch = text.match(/@([^\s|·#@]+)/);
      // 点赞：先去掉开头的时长「04:30」，再匹配「xx万」或纯数字
      const body = text.replace(/^\d{1,2}:\d{2}(?::\d{2})?\s*/, '');
      const likeMatch = body.match(/(\d+(?:\.\d+)?[万亿]|\d+)/);
      out.push({
        text: text.replace(/\s+/g, ' ').slice(0, 180),
        author: authorMatch ? authorMatch[1] : '',
        like: likeMatch ? likeMatch[1] : '',
        cover: imgSrc,
      });
    }
    return out;
  });
}

function dedupe(cards) {
  const seen = new Set();
  return cards.filter((c) => {
    const key = c.text.slice(0, 40);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// 判断登录态：有头像/用户信息且无登录面板 = 已登录
async function checkLogin(page) {
  return page.evaluate(() => {
    const text = document.body?.innerText || '';
    const hasLoginPanel = /扫码登录|验证码登录|密码登录/.test(text);
    const hasAvatar = document.querySelector('[class*="avatar"],[class*="Avatar"],[class*="user-info"],[class*="nickname"]') !== null;
    return hasAvatar && !hasLoginPanel;
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
  await page.keyboard.press('Escape'); // 关登录弹窗
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

  const all = [];
  const seen = new Set();
  const started = Date.now();
  while (Date.now() - started < durationSec * 1000) {
    try {
      const batch = await scrapeCards(page);
      for (const c of batch) {
        const key = c.text.slice(0, 40);
        if (!seen.has(key)) {
          seen.add(key); all.push(c);
          // 实时输出给扩展，让桌宠边刷边评论（标题只给前 80 字，够判断内容）
          console.log(JSON.stringify({ v: c.text.slice(0, 80), a: c.author }));
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

  // 末尾重新检测登录态（主人可能中途登录了）
  const finalLoggedIn = await checkLogin(page);
  console.log(JSON.stringify({ loggedIn: finalLoggedIn, count: all.length, cards: all }));
  await context.close();
}

main().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
