/** Console panel: bind this machine with a pairing code, and try a recall. */
import type { WebUiClientBundle, WebUiPanel, WebUiPanelContext } from 'cortico/web/shared/client-panel.ts';

interface Status {
  bound: boolean;
  baseUrl: string;
  deviceName: string;
  identityLabel: string;
  deviceId: string;
  bubble: boolean;
  pollSeconds: number;
  lastPollAt: number;
  delivered: number;
  lastError: string;
  nickname?: string;
}

interface TestResult {
  ok: boolean;
  count?: number;
  items?: Array<{ source: string; kind: string; text: string }>;
  error?: string;
}

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

function clock(ts: number): string {
  if (!ts) return '还没拉过';
  return new Date(ts).toLocaleTimeString('zh-CN', { hour12: false });
}

const bindPanel: WebUiPanel = {
  mount(ctx: WebUiPanelContext) {
    const { ui, root } = ctx;

    const sheet = ui.sheet({
      title: '绑定状态',
      desc: '绑定后这台机器才能用 AstrBot 的记忆，也才会收到 AstrBot 的主动消息。',
    });
    const statusBox = document.createElement('div');
    const message = ui.msgline();
    sheet.body.append(statusBox, message);

    const code = ui.input({ placeholder: '8 位配对码', cls: 'mono' });
    const name = ui.input({ placeholder: '留空用机器名' });
    const bindButton = ui.button('绑定', { variant: 'primary' });
    const unbindButton = ui.button('解绑这台机器', { variant: 'danger' });
    const pairActions = ui.actions();
    pairActions.append(bindButton, unbindButton);

    const pairSheet = ui.sheet({ title: '配对', desc: '在 QQ 里给机器人发「配对」，把收到的 8 位码填进来，10 分钟内有效。' });
    pairSheet.body.append(ui.field('配对码', code), ui.field('本机名称', name), pairActions);

    const query = ui.input({ placeholder: '想查什么，比如「唱歌 杂口」' });
    const testButton = ui.button('试一次检索');
    const testSheet = ui.sheet({ title: '记忆检索', desc: '确认绑定的人能查到 AstrBot 记下的东西。' });
    const testOut = document.createElement('div');
    const testActions = ui.actions();
    testActions.append(testButton);
    testSheet.body.append(ui.field('检索词', query), testActions, testOut);

    const selfSheet = ui.sheet({
      title: '自检：推一条测试事件',
      desc: '不惊动 AstrBot，直接往主会话推一条同类型事件，用来试「事件唤醒」这条路径。注意 piggyback 只是入队，要再跟桌宠说一句话才会被带出来。',
    });
    const pushText = ui.input({ placeholder: '留空用默认测试话术' });
    const triggerSel = ui.select({ options: ['preempt', 'flush', 'interrupt', 'debounce', 'piggyback'], value: 'piggyback' });
    const tagSel = ui.select({ options: ['speak', 'none'], value: 'speak' });
    const pushButton = ui.button('推一条', { variant: 'primary' });
    const pushOut = ui.msgline();
    const pushActions = ui.actions();
    pushActions.append(pushButton);
    selfSheet.body.append(
      ui.field('测试文本', pushText),
      ui.field('触发方式', triggerSel),
      ui.field('事件标签', tagSel),
      pushActions,
      pushOut,
    );

    root.append(sheet.el, pairSheet.el, testSheet.el, selfSheet.el);

    const render = (s: Status): void => {
      const rows = [
        { k: '桥接地址', v: s.baseUrl },
        { k: '绑定身份', v: s.bound ? s.identityLabel || '已绑定' : '未绑定' },
        { k: '本机名称', v: s.deviceName },
        { k: '主动消息气泡', v: s.bubble ? `开 · 每 ${s.pollSeconds} 秒拉取 · 已送达 ${s.delivered} 条` : '关' },
        { k: '最近拉取', v: clock(s.lastPollAt) },
      ];
      if (s.nickname) rows.push({ k: '备注昵称', v: s.nickname });
      if (s.lastError) rows.push({ k: '最近错误', v: s.lastError });
      statusBox.replaceChildren(ui.kv(rows));
    };

    const refresh = async (): Promise<void> => {
      try {
        render(await ctx.invoke<Status>('status'));
      } catch (error) {
        message.textContent = errText(error);
      }
    };

    bindButton.addEventListener('click', () => {
      void (async () => {
        const value = code.value.trim();
        if (!value) {
          message.textContent = '先填配对码';
          return;
        }
        const busy = ui.disable(bindButton, unbindButton, code, name);
        message.textContent = '正在配对…';
        try {
          if (name.value.trim()) await ctx.setConfig('astrbot', { 'worlds.astrbot.deviceName': name.value.trim() });
          await ctx.invoke('bind', [value, name.value.trim()]);
          code.value = '';
          message.textContent = '绑定成功。';
        } catch (error) {
          message.textContent = `绑定失败：${errText(error)}`;
        } finally {
          busy.dispose();
          await refresh();
        }
      })();
    });

    unbindButton.addEventListener('click', () => {
      void (async () => {
        if (!(await ui.confirm({ title: '解绑这台机器？', body: '解绑后要重新用配对码绑定才能继续用。', danger: true }))) return;
        try {
          await ctx.invoke('unbind');
          message.textContent = '已解绑。';
        } catch (error) {
          message.textContent = `解绑失败：${errText(error)}`;
        } finally {
          await refresh();
        }
      })();
    });

    testButton.addEventListener('click', () => {
      void (async () => {
        testOut.replaceChildren();
        try {
          const result = await ctx.invoke<TestResult>('test', [query.value.trim()]);
          if (!result.ok) {
            testOut.textContent = `检索失败：${result.error ?? '未知错误'}`;
            return;
          }
          const items = result.items ?? [];
          if (items.length === 0) {
            testOut.textContent = '没有检索到相关记忆。';
            return;
          }
          const list = document.createElement('div');
          for (const item of items) list.append(`${item.source ? `[${item.source}] ` : ''}${item.text}`);
          testOut.append(`命中 ${result.count ?? items.length} 条：`, list);
        } catch (error) {
          testOut.textContent = errText(error);
        }
      })();
    });

    pushButton.addEventListener('click', () => {
      void (async () => {
        pushOut.textContent = '推送中…';
        try {
          const result = await ctx.invoke<{ ok: boolean; cursor?: number; error?: string }>('push-test', [
            { trigger: triggerSel.value, speak: tagSel.value !== 'none', text: pushText.value.trim() },
          ]);
          pushOut.textContent = result.ok ? `已推送（cursor ${result.cursor}），看桌宠有没有说话。` : `推送失败：${result.error ?? '未知错误'}`;
        } catch (error) {
          pushOut.textContent = errText(error);
        }
      })();
    });

    void refresh();
    ctx.interval(() => void refresh(), 10_000);
  },
};

export default { panels: { bind: bindPanel } } satisfies WebUiClientBundle;
