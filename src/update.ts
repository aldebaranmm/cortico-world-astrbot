/** 自动更新：从配置里的更新源拉版本号对比，下载 zip，触发覆盖重启。
 *
 * 所有网络/文件操作都失败兜底、绝不抛——更新是加分项，不能拖垮桌宠主流程。
 * 覆盖与重启不由本进程做（不能覆盖自己正在跑的代码），交给独立的
 * `scripts/apply-update.ps1`（detached）在 Coopanion 退出后完成。
 */
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { createWriteStream, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { request as httpRequest, type ClientRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { tmpdir } from 'node:os';

const ZIP_FILE = 'cortico-world-astrbot-latest.zip';

/**
 * 更新服务器地址**不写死在包里** —— 由配置 `worlds.astrbot.updateUrl` 提供，
 * 谁部署的更新服务谁自己填。留空表示这台机器不检查更新（默认）。
 * 这样安装包里不会带上任何人的真实服务器地址。
 */
function normalizeBase(base: string): string {
  return String(base ?? '').trim().replace(/\/+$/, '');
}

/**
 * 比较版本号：a 比 b 新返回 1，一样返回 0，更旧返回 -1。
 * 容忍 `v` 前缀（`v0.9.1`）和位数不同（`1.2` vs `1.2.0`）。
 * 更新只看「服务器版本更高」，这样本机比服务器新时不会被提示降级。
 */
function compareVersion(a: string, b: string): number {
  const parts = (s: string) =>
    String(s ?? '')
      .trim()
      .replace(/^v/i, '')
      .split('.')
      .map((p) => parseInt(p, 10) || 0);
  const x = parts(a);
  const y = parts(b);
  const len = Math.max(x.length, y.length);
  for (let i = 0; i < len; i++) {
    const diff = (x[i] ?? 0) - (y[i] ?? 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

export interface UpdateStatus {
  hasUpdate: boolean;
  current: string;
  latest: string;
  note: string;
  /** 实际要下载的 zip 地址；version.json 里给了绝对地址就用它，否则回退到 `<base>/<ZIP_FILE>`。 */
  zip: string;
}

/** 读本地扩展版本（package.json 的 version 字段）。 */
export function currentVersion(packageDir: string): string {
  try {
    const pkg = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')) as Record<string, unknown>;
    return String(pkg.version ?? '');
  } catch {
    return '';
  }
}

/** 从扩展目录反推 Coopanion 根目录：<root>/data/extensions/node_modules/cortico-world-astrbot。 */
export function coopRootOf(packageDir: string): string {
  return resolve(packageDir, '../../../..');
}

/** 按协议挑 http / https 模块；地址非法或协议不支持返回 null（绝不抛）。 */
function requestFor(url: string): typeof httpRequest | null {
  try {
    const { protocol } = new URL(url);
    if (protocol === 'https:') return httpsRequest as unknown as typeof httpRequest;
    if (protocol === 'http:') return httpRequest;
    return null;
  } catch {
    return null;
  }
}

/**
 * 发起 GET 并把回调包在 try 里 —— 协议不对、URL 残缺都只会让这次请求失败，
 * 不会变成未捕获异常。（之前用 node:http 硬发 https 地址就会同步抛。）
 */
function startRequest(url: string, onResponse: (res: IncomingMessage) => void): ClientRequest | null {
  const fn = requestFor(url);
  if (!fn) return null;
  try {
    return fn(url, { method: 'GET' }, onResponse);
  } catch {
    return null;
  }
}

/** http→https 的站点很常见，3xx 要自己跟，最多 3 跳。 */
function redirectOf(from: string, res: IncomingMessage): string {
  const status = res.statusCode ?? 0;
  if (status < 300 || status >= 400) return '';
  const raw = res.headers.location;
  const loc = Array.isArray(raw) ? raw[0] : raw;
  if (!loc) return '';
  try {
    return new URL(loc, from).toString();
  } catch {
    return '';
  }
}

/** HTTP(S) GET 返回文本；失败/超时/协议不支持都返回空串。 */
function httpText(url: string, timeoutMs = 15000, hop = 0): Promise<string> {
  return new Promise((resolve) => {
    const req = startRequest(url, (res) => {
      const next = hop < 3 ? redirectOf(url, res) : '';
      if (next) {
        res.resume();
        resolve(httpText(next, timeoutMs, hop + 1));
        return;
      }
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    if (!req) {
      resolve('');
      return;
    }
    req.setTimeout(timeoutMs, () => req.destroy());
    req.on('error', () => resolve(''));
    req.end();
  });
}

/** 检查是否有新版本。任何失败都返回 hasUpdate=false。 */
export async function checkUpdate(packageDir: string, updateUrl = ''): Promise<UpdateStatus> {
  const current = currentVersion(packageDir);
  const base = normalizeBase(updateUrl);
  if (!base) {
    return { hasUpdate: false, current, latest: '', note: '未配置更新地址，跳过检查', zip: '' };
  }
  const raw = await httpText(`${base}/version.json`);
  let latest = '';
  let note = '';
  // 只有 http(s) 的 base 才拼得出可下载的地址；其它情况留空，别把废地址传下去
  let zip = /^https?:\/\//i.test(base) ? `${base}/${ZIP_FILE}` : '';
  try {
    const info = JSON.parse(raw) as Record<string, unknown>;
    latest = String(info.version ?? '');
    note = String(info.note ?? '');
    // version.json 里允许直接给 zip 的绝对地址（把包放 GitHub Releases、只在静态站放一个 json 的用法）
    const abs = String(info.zip ?? '').trim();
    if (/^https?:\/\//i.test(abs)) zip = abs;
  } catch {
    /* 版本号解析失败就当作没更新 */
  }
  // 只有服务器版本更高才算「有新版本」，避免本机更新反而被提示降级
  return {
    hasUpdate: !!(latest && current && compareVersion(latest, current) > 0),
    current,
    latest,
    note,
    zip,
  };
}

/** 把 url 下载到 dest；3xx 自己跟（最多 3 跳），失败返回空串。 */
function downloadFrom(url: string, dest: string, hop = 0): Promise<string> {
  return new Promise((resolve) => {
    const req = startRequest(url, (res) => {
      const next = hop < 3 ? redirectOf(url, res) : '';
      if (next) {
        res.resume();
        resolve(downloadFrom(next, dest, hop + 1));
        return;
      }
      if ((res.statusCode ?? 0) >= 300) {
        res.resume();
        resolve('');
        return;
      }
      const ws = createWriteStream(dest);
      res.pipe(ws);
      ws.on('finish', () => resolve(dest));
      ws.on('error', () => resolve(''));
    });
    if (!req) {
      resolve('');
      return;
    }
    req.setTimeout(180000, () => req.destroy());
    req.on('error', () => resolve(''));
    req.end();
  });
}

/** 下载最新 zip 到临时目录，返回本地路径；失败返回空串。 */
export function downloadUpdate(updateUrl = '', zipUrl = ''): Promise<string> {
  const base = normalizeBase(updateUrl);
  const target = zipUrl || (base ? `${base}/${ZIP_FILE}` : '');
  if (!target) return Promise.resolve('');
  const dir = join(tmpdir(), 'cortico-update');
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    return Promise.resolve('');
  }
  return downloadFrom(target, join(dir, 'latest.zip'));
}

/** 触发独立的覆盖重启脚本（detached），返回是否成功拉起。 */
export function applyUpdate(zipPath: string, packageDir: string, log?: (m: string) => void): boolean {
  const ps1 = join(packageDir, 'scripts', 'apply-update.ps1');
  const extDir = packageDir;
  const coopRoot = coopRootOf(packageDir);
  const workDir = dirname(zipPath);
  const logPath = join(workDir, 'apply-update.log');
  const psExe = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

  // 关键：不能再直接 spawn powershell。
  // 从 Electron 里 detached 出来的子进程仍挂在宿主的 Job 对象上，宿主一退它就被回收——
  // 实测「已触发更新脚本」打完日志后什么都没发生（Coopanion 进程号都没变）。
  // 改成写一个 .cmd，交给 explorer.exe 用 shell 打开：新进程的爹是资源管理器，不是我们。
  const runner = join(workDir, 'apply-update.cmd');
  const body = [
    '@echo off',
    'chcp 65001 >nul',
    `echo [%date% %time%] start >> "${logPath}"`,
    `"${psExe}" -NoProfile -ExecutionPolicy Bypass -File "${ps1}" -ZipPath "${zipPath}" -ExtDir "${extDir}" -CoopRoot "${coopRoot}" >> "${logPath}" 2>&1`,
    `echo [%date% %time%] exit=%errorlevel% >> "${logPath}"`,
  ].join('\r\n');

  try {
    writeFileSync(runner, body, 'utf8');
  } catch (err) {
    log?.(`写更新脚本失败：${err instanceof Error ? err.message : String(err)}`);
    return false;
  }

  try {
    const child = spawn('explorer.exe', [runner], { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
    log?.(`已触发更新脚本：${runner}（日志 ${logPath}）`);
    return true;
  } catch (err) {
    log?.(`触发更新脚本失败：${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}
