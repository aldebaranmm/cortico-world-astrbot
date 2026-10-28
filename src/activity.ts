/** 采集「主人现在在干什么」：前台窗口 + 空闲时长；文件夹仅在用户显式同意后读取（M8）。 */
import { execFile } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { ActivityPayload, FolderSummary } from './bridge.ts';

const PS_TIMEOUT_MS = 6000;

/**
 * 一次 PowerShell 拿齐：前台窗口标题、进程名、是否全屏、键鼠空闲秒数。
 * 全部只读系统状态，不碰任何文件。
 */
const PS_SCRIPT = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -Namespace CoopA -Name U -MemberDefinition @'
[DllImport("user32.dll")] public static extern System.IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(System.IntPtr hWnd, out uint pid);
[DllImport("user32.dll")] public static extern bool GetWindowRect(System.IntPtr hWnd, out RECT lpRect);
[DllImport("user32.dll")] public static extern int GetSystemMetrics(int nIndex);
[DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);
[DllImport("shell32.dll")] public static extern int SHQueryUserNotificationState(out int state);
[StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
[StructLayout(LayoutKind.Sequential)] public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
'@

// Windows 通知系统用的同一套状态：2=全屏 3=D3D独占全屏 4=演示模式 5=正常
$quns = 5
$qunsOk = $false
try {
  $hr = [CoopA.U]::SHQueryUserNotificationState([ref]$quns)
  $qunsOk = ($hr -eq 0)
} catch { $qunsOk = $false }

$h = [CoopA.U]::GetForegroundWindow()
$title = ''
$proc = ''
$fullByRect = $false
if ($h -ne [System.IntPtr]::Zero) {
  $pid2 = 0
  [CoopA.U]::GetWindowThreadProcessId($h, [ref]$pid2) | Out-Null
  $p = Get-Process -Id $pid2 -ErrorAction SilentlyContinue
  if ($p) { $proc = $p.ProcessName; $title = $p.MainWindowTitle }
  $r = New-Object CoopA.U+RECT
  if ([CoopA.U]::GetWindowRect($h, [ref]$r)) {
    $sw = [CoopA.U]::GetSystemMetrics(0)
    $sh = [CoopA.U]::GetSystemMetrics(1)
    if ($sw -gt 0 -and $sh -gt 0) {
      $fullByRect = (($r.Right - $r.Left) -ge $sw) -and (($r.Bottom - $r.Top) -ge $sh)
    }
  }
}

$idle = 0
$lii = New-Object CoopA.U+LASTINPUTINFO
$lii.cbSize = [System.Runtime.InteropServices.Marshal]::SizeOf($lii)
if ([CoopA.U]::GetLastInputInfo([ref]$lii)) {
  $idle = [int]((([Environment]::TickCount - $lii.dwTime) / 1000))
  if ($idle -lt 0) { $idle = 0 }
}

$full = ($quns -eq 2) -or ($quns -eq 3) -or ($quns -eq 4)
if (-not $qunsOk) { $full = $fullByRect }

[pscustomobject]@{ title = $title; process = $proc; fullscreen = $full; quns = $quns; idle_seconds = $idle } | ConvertTo-Json -Compress
`;

function runPowerShell(script: string): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script],
      { timeout: PS_TIMEOUT_MS, windowsHide: true },
      (error, stdout) => resolve(error ? '' : String(stdout || '').trim()),
    );
  });
}

interface WindowInfo {
  title: string;
  process: string;
  fullscreen: boolean;
  /** Windows 的 QUERY_USER_NOTIFICATION_STATE：2/3/4 表示全屏或演示 */
  quns: number;
  idle_seconds: number;
}

function parseWindow(raw: string): WindowInfo {
  const blank: WindowInfo = { title: '', process: '', fullscreen: false, quns: 5, idle_seconds: 0 };
  if (!raw) return blank;
  try {
    const data = JSON.parse(raw) as Record<string, unknown>;
    return {
      title: String(data.title ?? '').slice(0, 200),
      process: String(data.process ?? '').slice(0, 80),
      fullscreen: data.fullscreen === true,
      quns: Number(data.quns) || 5,
      idle_seconds: Math.max(0, Number(data.idle_seconds) || 0),
    };
  } catch {
    return blank;
  }
}

/** 列出有可见窗口的进程：只给进程名与窗口标题，不碰命令行参数。 */
const WINDOW_LIST_SCRIPT = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Get-Process | Where-Object { $_.MainWindowTitle -ne '' } |
  Select-Object -First 40 ProcessName, MainWindowTitle |
  ConvertTo-Json -Compress
`;

export interface WindowProcess {
  process: string;
  title: string;
}

/** 当前所有带窗口的程序。读不到就返回空数组，绝不抛。 */
export async function listWindows(limit = 20): Promise<WindowProcess[]> {
  const raw = await runPowerShell(WINDOW_LIST_SCRIPT);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    const items = Array.isArray(parsed) ? parsed : [parsed];
    return items
      .map((item) => {
        const row = (item ?? {}) as Record<string, unknown>;
        return {
          process: String(row.ProcessName ?? '').slice(0, 60),
          title: String(row.MainWindowTitle ?? '').slice(0, 120),
        };
      })
      .filter((item) => item.process !== '')
      .slice(0, Math.max(1, Math.min(40, limit)));
  } catch {
    return [];
  }
}

/** 一次最多扫这么多个目录项：几万文件的目录会把同步 IO 拖死。 */
const SCAN_LIMIT = 400;

/** 只列文件名/修改时间/大小，绝不读内容。 */
function listFolder(path: string, limit: number): FolderSummary | null {
  try {
    const entries = readdirSync(path, { withFileTypes: true })
      .slice(0, SCAN_LIMIT)
      .filter((entry) => entry.isFile())
      .map((entry) => {
        try {
          const stat = statSync(join(path, entry.name));
          return { name: entry.name.slice(0, 120), mtime: Math.floor(stat.mtimeMs / 1000), size: stat.size };
        } catch {
          return null;
        }
      })
      .filter((item): item is { name: string; mtime: number; size: number } => item !== null)
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, limit);
    return { path, files: entries };
  } catch {
    return null;
  }
}

/** 定时上报只采窗口与空闲；文件夹不自动读，改由工具在你同意后按需读。 */
export async function collectActivity(): Promise<ActivityPayload> {
  const window = parseWindow(await runPowerShell(PS_SCRIPT));
  return {
    window: { title: window.title, process: window.process, fullscreen: window.fullscreen },
    idle_seconds: window.idle_seconds,
    folders: [],
  };
}

/**
 * 路径读不了时，把「这台机器实际有哪些用户目录」告诉调用方。
 * 模型经常把用户名猜错（比如猜 Administrator，实际是 Admin）——
 * 有这个提示它就能自己纠正，不用主人来教。只列目录名，不碰任何内容。
 */
export function suggestFolders(path: string): string {
  if (!/^[a-z]:[\\/]users[\\/]/i.test(path)) return '';
  const drive = path.slice(0, 2);
  try {
    const users = readdirSync(`${drive}\\Users`, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .slice(0, 8)
      .map((entry) => entry.name);
    if (users.length === 0) return '';
    return `\n这台机器的用户目录有：${users.join('、')}。请用真实用户名，不要用 Administrator 之类的猜测名。`;
  } catch {
    return '';
  }
}

/** 按需列一个目录（只文件名/时间/大小），供工具在你同意后调用。 */
export function readFolder(path: string, maxFiles = 12): FolderSummary | null {
  return listFolder(path, Math.max(1, Math.min(20, maxFiles)));
}

/** 给日志看的一句摘要。 */
export function summarize(payload: ActivityPayload): string {
  const title = payload.window?.title || payload.window?.process || '(无窗口)';
  const idle = Number(payload.idle_seconds || 0);
  const bits = [title.slice(0, 60)];
  if (idle >= 60) bits.push(`空闲 ${Math.floor(idle / 60)} 分钟`);
  if (payload.folders?.length) {
    const count = payload.folders.reduce((sum, folder) => sum + (folder.files?.length ?? 0), 0);
    bits.push(`${payload.folders.length} 个文件夹/${count} 个文件`);
  }
  return bits.join(' · ');
}
