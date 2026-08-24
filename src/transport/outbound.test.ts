import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createOutboundHandler } from './outbound.ts';
import type { QQBotSender, StreamSessionLike } from './outbound-buffer.ts';
import type { SessionManager, SessionRecord } from '../session/index.ts';
import type { ImQQBotConfig } from '../config.ts';
import type { Logger, ReplyTarget } from '../types.ts';

function createLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function createSession(): StreamSessionLike {
  return { update: vi.fn().mockResolvedValue(undefined), complete: vi.fn().mockResolvedValue(undefined) };
}

function createBot(session: StreamSessionLike): QQBotSender {
  return {
    sendMarkdown: vi.fn().mockResolvedValue(undefined),
    openStream: vi.fn(() => session),
  };
}

const c2cTarget: ReplyTarget = { scope: 'c2c', targetId: 'user1', msgId: 'msg1' };
const groupTarget: ReplyTarget = { scope: 'group', targetId: 'group1', msgId: 'msg1' };

function createRecord(target: ReplyTarget, sessionId = 'sess-qq'): SessionRecord {
  return {
    sessionKey: 'k',
    sessionId,
    replyTarget: target,
    agent: {},
    handle: {},
    createdAt: 0,
    lastActiveAt: 0,
  } as unknown as SessionRecord;
}

function createConfig(overrides?: Partial<ImQQBotConfig>): ImQQBotConfig {
  return {
    streaming: true,
    textChunkLimit: 4500,
    showToolResults: false,
    ...overrides,
  } as unknown as ImQQBotConfig;
}

/** 组装 handler：manager 按 sessionId 返回 record（默认 c2c 私聊） */
function setup(opts?: { record?: SessionRecord | undefined; config?: ImQQBotConfig }) {
  const session = createSession();
  const bot = createBot(session);
  const record = 'record' in (opts ?? {}) ? opts!.record : createRecord(c2cTarget);
  const manager = {
    findBySessionId: vi.fn((id: string) => (id === 'sess-qq' ? record : undefined)),
  } as unknown as SessionManager;
  const outbound = createOutboundHandler(manager, bot, opts?.config ?? createConfig(), createLogger());
  return { outbound, bot, session };
}

const delta = (attemptId: string, text: string) => ({ kind: 'text-delta' as const, attemptId, text });
const start = (attemptId: string) => ({ kind: 'attempt-start' as const, attemptId });

describe('OutboundRouter.routeStreamFrame', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('流式帧路由到会话 buffer：openStream + update', async () => {
    const { outbound, bot, session } = setup();

    outbound.routeStreamFrame('sess-qq', start('a1'));
    outbound.routeStreamFrame('sess-qq', delta('a1', 'hello'));
    await vi.advanceTimersByTimeAsync(200);

    expect(bot.openStream).toHaveBeenCalledTimes(1);
    expect(session.update).toHaveBeenCalledWith('hello');
  });

  it('attempt 切换 reset：同一条流式消息被新内容全量重写', async () => {
    const { outbound, bot, session } = setup();

    outbound.routeStreamFrame('sess-qq', start('a1'));
    outbound.routeStreamFrame('sess-qq', delta('a1', 'partial'));
    await vi.advanceTimersByTimeAsync(200);
    expect(session.update).toHaveBeenCalledWith('partial');

    outbound.routeStreamFrame('sess-qq', start('a2'));
    outbound.routeStreamFrame('sess-qq', delta('a2', 'full'));
    await vi.advanceTimersByTimeAsync(200);

    expect(bot.openStream).toHaveBeenCalledTimes(1); // 流式会话复用
    expect(session.update).toHaveBeenNthCalledWith(2, 'full'); // 全量替换
  });

  it('agent replacement（attemptId 重叠）：start 帧无条件重置', async () => {
    const { outbound, bot, session } = setup();

    outbound.routeStreamFrame('sess-qq', start('sess-qq:1'));
    outbound.routeStreamFrame('sess-qq', delta('sess-qq:1', 'stale'));
    await vi.advanceTimersByTimeAsync(200);
    expect(session.update).toHaveBeenCalledWith('stale');

    // agent replacement 后 attempt 计数重启，attemptId 与旧 agent 相同
    outbound.routeStreamFrame('sess-qq', start('sess-qq:1'));
    outbound.routeStreamFrame('sess-qq', delta('sess-qq:1', 'fresh'));
    await vi.advanceTimersByTimeAsync(200);

    expect(bot.openStream).toHaveBeenCalledTimes(1);
    expect(session.update).toHaveBeenNthCalledWith(2, 'fresh'); // 全量替换，无残留
  });

  it('迟到帧（旧 attemptId）被丢弃', async () => {
    const { outbound, session } = setup();

    outbound.routeStreamFrame('sess-qq', start('a1'));
    outbound.routeStreamFrame('sess-qq', delta('a1', 'x'));
    outbound.routeStreamFrame('sess-qq', start('a2'));
    outbound.routeStreamFrame('sess-qq', delta('a1', 'late')); // a1 的迟到帧
    await vi.advanceTimersByTimeAsync(200);

    expect(session.update).not.toHaveBeenCalledWith(expect.stringContaining('late'));
  });

  it('非 QQ 会话（无 record）忽略流式帧', async () => {
    const { outbound, bot } = setup({ record: undefined });

    outbound.routeStreamFrame('sess-web', start('a1'));
    outbound.routeStreamFrame('sess-web', delta('a1', 'hello'));
    await vi.advanceTimersByTimeAsync(200);

    expect(bot.openStream).not.toHaveBeenCalled();
    expect(bot.sendMarkdown).not.toHaveBeenCalled();
  });

  it('群聊不流式：帧累积后由 assistant/message 静态发送', async () => {
    const { outbound, bot } = setup({ record: createRecord(groupTarget) });

    outbound.routeStreamFrame('sess-qq', start('a1'));
    outbound.routeStreamFrame('sess-qq', delta('a1', 'group reply'));
    await vi.advanceTimersByTimeAsync(200);

    outbound.routeSessionEvent({ header: { id: 'sess-qq' } }, {
      type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text: 'group reply' }] } },
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(bot.openStream).not.toHaveBeenCalled();
    expect(bot.sendMarkdown).toHaveBeenCalledWith(groupTarget, 'group reply');
  });

  it('assistant/message 到达时收尾流式：complete 且不重复静态发送', async () => {
    const { outbound, bot, session } = setup();

    outbound.routeStreamFrame('sess-qq', start('a1'));
    outbound.routeStreamFrame('sess-qq', delta('a1', 'hello'));
    await vi.advanceTimersByTimeAsync(200);

    outbound.routeSessionEvent({ header: { id: 'sess-qq' } }, {
      type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text: 'hello' }] } },
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(session.complete).toHaveBeenCalledTimes(1);
    expect(bot.sendMarkdown).not.toHaveBeenCalled();
  });

  it('旧通道回归：durable assistant/chunk 事件仍进 buffer', async () => {
    const { outbound, bot, session } = setup();

    outbound.routeSessionEvent({ header: { id: 'sess-qq' } }, {
      type: 'assistant/chunk',
      data: { chunk: { type: 'text-delta', text: 'legacy' } },
    });
    await vi.advanceTimersByTimeAsync(200);

    expect(bot.openStream).toHaveBeenCalledTimes(1);
    expect(session.update).toHaveBeenCalledWith('legacy');
  });
});

describe('OutboundRouter — 快捷按钮（尾部编号选项兜底）', () => {
  beforeEach(() => vi.useRealTimers());
  afterEach(() => vi.restoreAllMocks());

  const flush = async () => {
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
  };

  const OPTIONS_TEXT = '下一步你要哪个？\n1. 合并文件存档就好，零风险不动活跃文件。\n2. 真正加载进活跃会话，需要你确认时机。\n3. 改成时间交错合并再出一版看看效果。\n回 1 / 2 / 3 即可。';

  /** 带 sessionKey 的 manager（快捷按钮登记用规范键） */
  function createKeyedManager(record?: SessionRecord): SessionManager {
    return {
      findBySessionId: vi.fn().mockReturnValue(record),
      getSessionRecord: vi.fn().mockReturnValue(record ? { sessionKey: record.sessionKey } : undefined),
      resolvePeer: vi.fn().mockReturnValue(undefined),
      liveAgent: vi.fn().mockReturnValue(undefined),
      sessionKey: (scope: ChatScope, peerId: string) => `qqbot:app:${scope}:${peerId}`,
    } as unknown as SessionManager;
  }

  async function createQuickChannel(manager: SessionManager) {
    const { QuestionChannel } = await import('../features/question-channel.js');
    return new QuestionChannel(
      manager as never,
      { sendMarkdown: async () => undefined },
      { requireMention: false, askTimeoutMs: 60_000, quickReplyButtons: true },
      createLogger(),
    );
  }

  it('尾部编号选项：正文发送后追加快捷消息并附带键盘', async () => {
    const record = createRecord(qqTarget, 0);
    const bot = createBot();
    const manager = createKeyedManager(record);
    const ch = await createQuickChannel(manager);
    const handler = createOutboundHandler(manager, bot, createConfig({ quickReplyButtons: true }), createLogger(), undefined, ch);

    handler(session, assistantMessageEvent(OPTIONS_TEXT));
    await flush();

    const calls = (bot.sendMarkdown as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.length).toBe(2);
    expect(calls[0]?.[1]).toContain('下一步你要哪个');
    expect(calls[1]?.[1]).toContain('快速选择');
    const kb = (calls[1]?.[2] as { keyboard?: { content?: { rows?: unknown[] } } } | undefined)?.keyboard;
    expect(kb?.content?.rows).toHaveLength(3);
  });

  it('点击快捷按钮：解析为编号注入载荷（t:"quick" 判别编码）', async () => {
    const record = createRecord(qqTarget, 0);
    const bot = createBot();
    const manager = createKeyedManager(record);
    const ch = await createQuickChannel(manager);
    const handler = createOutboundHandler(manager, bot, createConfig({ quickReplyButtons: true }), createLogger(), undefined, ch);

    handler(session, assistantMessageEvent(OPTIONS_TEXT));
    await flush();

    const click = ch.consumeQuickReply({
      id: 'i', type: 1, version: 1, user_openid: 'user1',
      data: { type: 1, resolved: { button_data: JSON.stringify({ t: 'quick', i: 1 }) } },
    } as never);
    expect(click).toMatchObject({ scope: 'c2c', peerId: 'user1', text: '2' });
  });

  it('正式提问按钮（t:"question"）不被当作快捷按钮', async () => {
    const record = createRecord(qqTarget, 0);
    const bot = createBot();
    const manager = createKeyedManager(record);
    const ch = await createQuickChannel(manager);
    const handler = createOutboundHandler(manager, bot, createConfig({ quickReplyButtons: true }), createLogger(), undefined, ch);

    handler(session, assistantMessageEvent(OPTIONS_TEXT));
    await flush();

    const click = ch.consumeQuickReply({
      id: 'i', type: 1, version: 1, user_openid: 'user1',
      data: { type: 1, resolved: { button_data: JSON.stringify({ t: 'question', q: 'some-question', i: 1 }) } },
    } as never);
    expect(click).toBeUndefined();
  });

  it('普通消息：不追加快捷消息', async () => {
    const record = createRecord(qqTarget, 0);
    const bot = createBot();
    const manager = createKeyedManager(record);
    const ch = await createQuickChannel(manager);
    const handler = createOutboundHandler(manager, bot, createConfig({ quickReplyButtons: true }), createLogger(), undefined, ch);

    handler(session, assistantMessageEvent('合并完成，一切正常，无需你做任何选择。'));
    await flush();

    expect((bot.sendMarkdown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
  });

  it('quickReplyButtons 关闭：不追加快捷消息', async () => {
    const record = createRecord(qqTarget, 0);
    const bot = createBot();
    const manager = createKeyedManager(record);
    const { QuestionChannel } = await import('../features/question-channel.js');
    const ch = new QuestionChannel(
      manager as never,
      { sendMarkdown: async () => undefined },
      { requireMention: false, askTimeoutMs: 60_000 }, // 通道侧未开启
      createLogger(),
    );
    const handler = createOutboundHandler(manager, bot, createConfig({ quickReplyButtons: false }), createLogger(), undefined, ch);

    handler(session, assistantMessageEvent(OPTIONS_TEXT));
    await flush();

    expect((bot.sendMarkdown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
  });

  it('流式路径：chunk 缓冲经 assistant/message 收尾后同样追加快捷消息', async () => {
    const record = createRecord(qqTarget, 0);
    const bot = createBot();
    const manager = createKeyedManager(record);
    const ch = await createQuickChannel(manager);
    const handler = createOutboundHandler(manager, bot, createConfig({ quickReplyButtons: true }), createLogger(), undefined, ch);

    handler(session, { type: 'assistant/chunk', data: { chunk: { type: 'text-delta', text: OPTIONS_TEXT } } });
    handler(session, assistantMessageEvent(OPTIONS_TEXT));
    await new Promise((r) => setTimeout(r, 30)); // 流式节流窗口
    await flush();

    const calls = (bot.sendMarkdown as ReturnType<typeof vi.fn>).mock.calls;
    const quick = calls.find((c) => String(c[1]).includes('快速选择'));
    expect(quick).toBeDefined();
    expect((quick?.[2] as { keyboard?: unknown } | undefined)?.keyboard).toBeDefined();
  });
});
