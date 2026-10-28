/** 自动更新：从阿里云 VPS 拉版本号对比，下载 zip，触发覆盖重启。
 *
 * 所有网络/文件操作都失败兜底、绝不抛——更新是加分项，不能拖垮桌宠主流程。
 * 覆盖与重启不由本进程做（不能覆盖自己正在跑的代码），交给独立的
 * `scripts/apply-update.ps1`（detached）在 Coopanion 退出后完成。
 */
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { createWriteStream, mkdirSync, readFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
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

/** HTTP GET 返回 JSON 文本；失败/超时返回空串。 */
function httpText(url: string, timeoutMs = 15000): Promise<string> {
  return new Promise((resolve) => {
    const req = httpRequest(url, { method: 'GET' }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
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
    return { hasUpdate: false, current, latest: '', note: '未配置更新地址，跳过检查' };
  }
  const raw = await httpText(`${base}/version.json`);
  let latest = '';
  let note = '';
  try {
    const info = JSON.parse(raw) as Record<string, unknown>;
    latest = String(info.version ?? '');
    note = String(info.note ?? '');
  } catch {
    /* 版本号解析失败就当作没更新 */
  }
  // 只有服务器版本更高才算「有新版本」，避免本机更新反而被提示降级
  return {
    hasUpdate: !!(latest && current && compareVersion(latest, current) > 0),
    current,
    latest,
    note,
  };
}

/** 下载最新 zip 到临时目录，返回本地路径；失败返回空串。 */
export function downloadUpdate(updateUrl = ''): Promise<string> {
  const base = normalizeBase(updateUrl);
  if (!base) return Promise.resolve('');
  const dest = join(tmpdir(), 'cortico-update', 'latest.zip');
  return new Promise((resolve) => {
    try {
      mkdirSync(join(dest, '..'), { recursive: true });
    } catch {
      /* 目录建不起来就失败 */
    }
    const req = httpRequest(`${base}/${ZIP_FILE}`, { method: 'GET' }, (res) => {
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
    req.setTimeout(180000, () => req.destroy());
    req.on('error', () => resolve(''));
    req.end();
  });
}

/** 触发独立的覆盖重启脚本（detached），返回是否成功拉起。 */
export function applyUpdate(zipPath: string, packageDir: string, log?: (m: string) => void): boolean {
  const ps1 = join(packageDir, 'scripts', 'apply-update.ps1');
  const extDir = packageDir;
  const coopRoot = coopRootOf(packageDir);
  try {
    const child = spawn(
      'powershell.exe',
      [
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1,
        '-ZipPath', zipPath, '-ExtDir', extDir, '-CoopRoot', coopRoot,
      ],
      { detached: true, stdio: 'ignore', windowsHide: true },
    );
    child.unref();
    log?.(`已触发更新脚本：${zipPath}`);
    return true;
  } catch (err) {
    log?.(`触发更新脚本失败：${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}
