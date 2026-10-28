/** 桥接服务的 HTTP 客户端：配对、身份、主动消息、记忆检索。 */
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

const DEFAULT_BASE = 'http://127.0.0.1:6190';
const TIMEOUT_MS = 6000;

export interface PairResult {
  token: string;
  device_id: string;
  name: string;
  identity_label: string;
}

export interface IdentityResult {
  identity_label: string;
  device_name: string;
  nickname: string;
}

export interface InboxMessage {
  text: string;
  meta?: Record<string, unknown>;
  ts?: number;
}

/** 文件夹摘要：只有文件名/时间/大小，没有内容。 */
export interface FolderSummary {
  path: string;
  files: Array<{ name: string; mtime: number; size: number }>;
}

/** 一条「主人在干什么」的上报体。 */
export interface ActivityPayload {
  window: { title: string; process: string; fullscreen: boolean };
  idle_seconds: number;
  folders: FolderSummary[];
}

/** 一轮对话：主人说了什么 + 桌宠回了什么。 */
export interface ChatItem {
  user: string;
  assistant: string;
}

/** 补上协议头、去掉末尾斜杠。 */
export function normalizeBase(raw: string): string {
  const s = (raw ?? '').trim().replace(/\/+$/, '');
  if (!s) return DEFAULT_BASE;
  return /^https?:\/\//i.test(s) ? s : `http://${s}`;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

interface RequestInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

/**
 * 用 node:http / node:https 发请求，不用全局 fetch。
 * 应用内的 fetch（undici）在部分机器上对公网明文地址会直接 `fetch failed`，
 * 且错误里看不出原因；原生模块的行为可预期，错误码也能原样带出来。
 */
async function request(url: string, init: RequestInit): Promise<Record<string, unknown>> {
  const target = new URL(url);
  const send = target.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    const req = send(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (target.protocol === 'https:' ? 443 : 80),
        path: `${target.pathname}${target.search}`,
        method: init.method ?? 'GET',
        headers: init.headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let data: Record<string, unknown> | null = null;
          try {
            data = JSON.parse(text) as Record<string, unknown>;
          } catch {
            data = null;
          }
          const status = res.statusCode ?? 0;
          if (status < 200 || status >= 300) {
            const detail = (data?.error as string) ?? text.slice(0, 120) ?? '';
            reject(new Error(detail ? `桥接服务返回 ${status}：${detail}` : `桥接服务返回 ${status}`));
            return;
          }
          resolve(data ?? {});
        });
        res.on('error', (error: Error) => reject(new Error(`读取响应失败（${error.message}）`)));
      },
    );
    req.setTimeout(TIMEOUT_MS, () => {
      req.destroy(new Error(`请求超时（${TIMEOUT_MS}ms）`));
    });
    req.on('error', (error: NodeJS.ErrnoException) => {
      reject(new Error(`连不上桥接服务（${error.code ?? ''} ${error.message}）`));
    });
    if (init.body) req.write(init.body);
    req.end();
  });
}

/** 用一次性配对码换长期机器令牌。令牌只在返回里出现这一次。 */
export async function pairDevice(base: string, code: string, deviceName: string): Promise<PairResult> {
  const data = await request(`${normalizeBase(base)}/bridge/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: (code ?? '').trim(), device_name: (deviceName ?? '').trim() }),
  });
  if (data.ok === false) throw new Error(String(data.error ?? '配对失败'));
  if (!data.token) throw new Error(String(data.error ?? '配对失败：没拿到令牌'));
  return {
    token: String(data.token),
    device_id: String(data.device_id ?? ''),
    name: String(data.name ?? ''),
    identity_label: String(data.identity_label ?? ''),
  };
}

export class BridgeClient {
  readonly base: string;
  readonly token: string;

  constructor(base: string, token: string) {
    this.base = normalizeBase(base);
    this.token = (token ?? '').trim();
  }

  /** 没有令牌时一切调用都不该发生。 */
  get ready(): boolean {
    return this.token !== '';
  }

  private headers(): Record<string, string> {
    return { authorization: `Bearer ${this.token}` };
  }

  async health(): Promise<Record<string, unknown>> {
    return request(`${this.base}/bridge/health`, { method: 'GET' });
  }

  async identity(): Promise<IdentityResult> {
    const data = await request(`${this.base}/bridge/identity`, { method: 'GET', headers: this.headers() });
    return {
      identity_label: String(data.identity_label ?? ''),
      device_name: String(data.device_name ?? ''),
      nickname: String(data.nickname ?? ''),
    };
  }

  /** 取走待发的主动消息；服务端取走即出队。 */
  async inbox(): Promise<InboxMessage[]> {
    const data = await request(`${this.base}/bridge/inbox`, { method: 'GET', headers: this.headers() });
    const raw = Array.isArray(data.messages) ? data.messages : [];
    return raw
      .map((m) => (m && typeof m === 'object' ? (m as Record<string, unknown>) : {}))
      .map((m) => ({ text: String(m.text ?? ''), meta: (m.meta as Record<string, unknown>) ?? {}, ts: Number(m.ts ?? 0) }))
      .filter((m) => m.text.trim() !== '');
  }

  /** 检索 AstrBot 侧的记忆；空 query 时返回最近的偏好条目。 */
  async recall(query: string, limit: number): Promise<Record<string, unknown>> {
    return request(`${this.base}/bridge/recall`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...this.headers() },
      body: JSON.stringify({ query: query ?? '', limit: limit || 0 }),
    });
  }

  /** 上报一条活动（前台窗口 / 可选的文件名）。 */
  async activityPost(payload: ActivityPayload): Promise<Record<string, unknown>> {
    return request(`${this.base}/bridge/activity`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...this.headers() },
      body: JSON.stringify(payload),
    });
  }

  /** 读最近一条活动（含一句给模型看的描述）。 */
  async activityGet(): Promise<Record<string, unknown>> {
    return request(`${this.base}/bridge/activity`, { method: 'GET', headers: this.headers() });
  }

  /** 把桌宠里的一轮对话回传给 AstrBot，写进同一个人的会话历史。 */
  async chat(items: ChatItem[]): Promise<Record<string, unknown>> {
    return request(`${this.base}/bridge/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...this.headers() },
      body: JSON.stringify({ items }),
    });
  }

  /** 上报刷视频（抖音/B站）抓到的一批卡片（标题 + 封面图 + 登录态），供 AstrBot 分析后写记忆。 */
  async videoPost(platform: string, payload: { loggedIn: boolean; cards: Array<Record<string, unknown>> }): Promise<Record<string, unknown>> {
    return request(`${this.base}/bridge/video`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...this.headers() },
      body: JSON.stringify({ platform, ...payload }),
    });
  }
}
