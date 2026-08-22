import { describe, it, expect, vi } from 'vitest';
import type { InteractionEvent } from '@tencent-connect/qqbot-nodejs';
import {
  QuestionChannel,
  buildKeyboard,
  formatQuestions,
  parseAnswers,
  type UserQuestion,
  type UserQuestionRequest,
  type UserQuestionResult,
  type QuestionSessionRecordLike,
} from './question-channel.js';
import type { ChatScope, Logger, ReplyTarget } from '../types.js';

function createLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

interface SentMessage {
  target: ReplyTarget;
  text: string;
  opts?: { keyboard?: unknown };
}

function createSender(sent: SentMessage[], opts?: { failKeyboard?: boolean }) {
  return {
    sendMarkdown: vi.fn(async (target: ReplyTarget, content: string, o?: { keyboard?: unknown }) => {
      if (o?.keyboard && opts?.failKeyboard) throw new Error('keyboard not permitted');
      sent.push({ target, text: content, opts: o });
    }),
  };
}

const sessionKey = (scope: ChatScope, peerId: string): string => `qqbot:app:${scope}:${peerId}`;

function createManager(findBySessionId?: (id: string) => QuestionSessionRecordLike | undefined) {
  return { findBySessionId: findBySessionId ?? (() => undefined), sessionKey };
}

function makeRecord(sessionKeyStr: string, scope: ChatScope = 'c2c'): QuestionSessionRecordLike {
  return { sessionKey: sessionKeyStr, scope, replyTarget: { scope, targetId: 'x', msgId: 'm' } };
}

/** 发起提问，返回答案 Promise（pending 的写入在发送完成后，作答前先等发送落定） */
function startAsk(
  ch: QuestionChannel,
  key: string,
  questions: UserQuestion[],
  scope: ChatScope = 'c2c',
  signal?: AbortSignal,
): Promise<UserQuestionResult> {
  const request: UserQuestionRequest = { questions, ...(signal ? { signal } : {}) };
  return ch.askViaQQ(makeRecord(key, scope), request);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const q2 = (id = 'q'): UserQuestion => ({ id, question: '选哪个？', options: [{ label: 'A' }, { label: 'B' }] });

describe('formatQuestions', () => {
  it('renders numbered options and text hint', () => {
    const text = formatQuestions([q2()], false, false);
    expect(text).toContain('1. A');
    expect(text).toContain('2. B');
    expect(text).toContain('回复编号选择');
  });

  it('uses button hint when withButtons', () => {
    expect(formatQuestions([q2()], false, true)).toContain('点击下方按钮选择');
  });

  it('adds @mention note for groups', () => {
    expect(formatQuestions([q2()], true, false)).toContain('需 @机器人');
  });

  it('notes multi-select usage', () => {
    const q: UserQuestion = { ...q2(), multiSelect: true };
    expect(formatQuestions([q], false, false)).toContain('可多选');
  });
});

describe('buildKeyboard', () => {
  it('builds one row per option for single-select questions', () => {
    const kb = buildKeyboard([q2()]);
    expect(kb?.content.rows).toHaveLength(2);
    const btn = kb?.content.rows[0]?.buttons[0];
    expect(btn?.action.type).toBe(1); // 1=回调：点击即确认（2=填输入框，0=跳转）
    expect(btn?.action.permission.type).toBe(2); // 0 实测会报"无权限操作"
    expect(btn?.render_data.label).toBe('A');
    expect(JSON.parse(btn!.action.data)).toEqual({ i: 0 });
  });

  it('returns undefined for multi-select, no-options, or multi-question', () => {
    expect(buildKeyboard([{ ...q2(), multiSelect: true }])).toBeUndefined();
    expect(buildKeyboard([{ id: 'q', question: 't' }])).toBeUndefined();
    expect(buildKeyboard([q2(), q2('q2')])).toBeUndefined();
  });

  it('truncates long labels', () => {
    const long = '这是一个非常非常长的选项标签超过十八个字符的限制了吧';
    const kb = buildKeyboard([{ id: 'q', question: 't', options: [{ label: long }] }]);
    const label = kb?.content.rows[0]?.buttons[0]?.render_data.label ?? '';
    expect(label.length).toBeLessThanOrEqual(18);
    expect(label.endsWith('…')).toBe(true);
  });
});

describe('parseAnswers', () => {
  it('maps numbers to option labels', () => {
    expect(parseAnswers([q2()], '2')).toEqual([{ id: 'q', selected: ['B'] }]);
  });

  it('supports multi-select numbers', () => {
    const q: UserQuestion = { id: 'q', question: 't', options: [{ label: 'A' }, { label: 'B' }, { label: 'C' }], multiSelect: true };
    expect(parseAnswers([q], '1,3')).toEqual([{ id: 'q', selected: ['A', 'C'] }]);
  });

  it('matches exact labels case-insensitively', () => {
    const q: UserQuestion = { id: 'q', question: 't', options: [{ label: 'Option X' }] };
    expect(parseAnswers([q], 'option x')).toEqual([{ id: 'q', selected: ['Option X'] }]);
  });

  it('falls back to custom for out-of-range numbers and free text', () => {
    expect(parseAnswers([q2()], '9')).toEqual([{ id: 'q', selected: [], custom: '9' }]);
    expect(parseAnswers([q2()], '自定义')).toEqual([{ id: 'q', selected: [], custom: '自定义' }]);
  });

  it('no options → custom', () => {
    expect(parseAnswers([{ id: 'q', question: 't' }], '小明')).toEqual([{ id: 'q', selected: [], custom: '小明' }]);
  });

  it('multiple questions → custom broadcast', () => {
    expect(parseAnswers([{ id: 'a', question: '1' }, { id: 'b', question: '2' }], '统一回复'))
      .toEqual([{ id: 'a', selected: [], custom: '统一回复' }, { id: 'b', selected: [], custom: '统一回复' }]);
  });
});

describe('QuestionChannel.tryAnswer', () => {
  it('resolves pending question and consumes the message', async () => {
    const sent: SentMessage[] = [];
    const ch = new QuestionChannel(createManager(), createSender(sent), { requireMention: false }, createLogger());
    const p = startAsk(ch, 'k1', [q2()]);
    await sleep(20);
    expect(ch.tryAnswer('k1', '2')).toBe(true);
    expect(await p).toEqual({ answers: [{ id: 'q', selected: ['B'] }] });
  });

  it('ignores empty text (keeps waiting)', async () => {
    const sent: SentMessage[] = [];
    const ch = new QuestionChannel(createManager(), createSender(sent), { requireMention: false }, createLogger());
    const p = startAsk(ch, 'k1', [q2()]);
    await sleep(20);
    expect(ch.tryAnswer('k1', '')).toBe(false);
    expect(ch.tryAnswer('k1', '1')).toBe(true);
    await p;
  });

  it('returns false when no pending question', () => {
    const sent: SentMessage[] = [];
    const ch = new QuestionChannel(createManager(), createSender(sent), { requireMention: false }, createLogger());
    expect(ch.tryAnswer('nope', '1')).toBe(false);
  });
});

describe('QuestionChannel.askViaQQ', () => {
  it('attaches keyboard for single-select and sends to replyTarget', async () => {
    const sent: SentMessage[] = [];
    const sender = createSender(sent);
    const ch = new QuestionChannel(createManager(), sender, { requireMention: true }, createLogger());
    const p = startAsk(ch, 's1', [q2()]);
    await sleep(20);
    expect(sent[0]?.opts?.keyboard).toBeDefined();
    expect(sent[0]?.text).toContain('点击下方按钮选择');
    expect(sender.sendMarkdown).toHaveBeenCalledWith(makeRecord('s1').replyTarget, expect.any(String), expect.any(Object));
    ch.tryAnswer('s1', '1');
    await p;
  });

  it('falls back to plain text when keyboard send fails', async () => {
    const sent: SentMessage[] = [];
    const ch = new QuestionChannel(createManager(), createSender(sent, { failKeyboard: true }), { requireMention: false }, createLogger());
    const p = startAsk(ch, 's6', [q2()]);
    await sleep(20);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.opts).toBeUndefined();
    expect(sent[0]?.text).toContain('回复编号选择');
    ch.tryAnswer('s6', '1');
    await p;
  });

  it('rejects when the question cannot be delivered at all', async () => {
    const ch = new QuestionChannel(
      createManager(),
      { sendMarkdown: vi.fn(async () => { throw new Error('network down'); }) },
      { requireMention: false },
      createLogger(),
    );
    await expect(ch.askViaQQ(makeRecord('sx'), { questions: [q2()] }))
      .rejects.toThrow('failed to deliver question to QQ');
  });

  it('rejects on abort signal', async () => {
    const sent: SentMessage[] = [];
    const ch = new QuestionChannel(createManager(), createSender(sent), { requireMention: false }, createLogger());
    const ac = new AbortController();
    const p = startAsk(ch, 'sa', [q2()], 'c2c', ac.signal);
    await sleep(20);
    ac.abort();
    await expect(p).rejects.toThrow('aborted');
  });

  it('supersedes a previous pending question for the same session', async () => {
    const sent: SentMessage[] = [];
    const ch = new QuestionChannel(createManager(), createSender(sent), { requireMention: false }, createLogger());
    const p1 = startAsk(ch, 'sk', [q2()]);
    p1.catch(() => {}); // 抑制被取代时的未处理 rejection（下方用 rejects 断言）
    await sleep(20);
    const p2 = startAsk(ch, 'sk', [q2()]);
    await sleep(20);
    await expect(p1).rejects.toThrow('superseded');
    ch.tryAnswer('sk', '1');
    await p2;
  });
});

describe('QuestionChannel.handleInteraction', () => {
  function makeEvent(data: string | undefined, peer: { user?: string; group?: string }): InteractionEvent {
    return {
      id: 'i1',
      type: 1,
      version: 1,
      ...(peer.group ? { group_openid: peer.group } : {}),
      ...(peer.user ? { user_openid: peer.user } : {}),
      data: { type: 1, resolved: { ...(data !== undefined ? { button_data: data } : {}) } },
    } as InteractionEvent;
  }

  it('answers a c2c question by button click', async () => {
    const sent: SentMessage[] = [];
    const ch = new QuestionChannel(createManager(), createSender(sent), { requireMention: false }, createLogger());
    const p = startAsk(ch, 'qqbot:app:c2c:U1', [q2()]);
    await sleep(20);
    expect(ch.handleInteraction(makeEvent(JSON.stringify({ i: 1 }), { user: 'U1' }))).toBe(true);
    expect(await p).toEqual({ answers: [{ id: 'q', selected: ['B'] }] });
  });

  it('routes group clicks by group_openid', async () => {
    const sent: SentMessage[] = [];
    const ch = new QuestionChannel(createManager(), createSender(sent), { requireMention: false }, createLogger());
    const p = startAsk(ch, 'qqbot:app:group:G1', [q2()], 'group');
    await sleep(20);
    expect(ch.handleInteraction(makeEvent(JSON.stringify({ i: 0 }), { user: 'someone', group: 'G1' }))).toBe(true);
    expect(await p).toEqual({ answers: [{ id: 'q', selected: ['A'] }] });
  });

  it('resolves with the full original label for truncated buttons', async () => {
    const sent: SentMessage[] = [];
    const ch = new QuestionChannel(createManager(), createSender(sent), { requireMention: false }, createLogger());
    const long = '这是一个非常非常长的选项标签超过十八个字符的限制了吧';
    const p = startAsk(ch, 'qqbot:app:c2c:U7', [{ id: 'q', question: 't', options: [{ label: long }] }]);
    await sleep(20);
    expect(ch.handleInteraction(makeEvent(JSON.stringify({ i: 0 }), { user: 'U7' }))).toBe(true);
    expect(await p).toEqual({ answers: [{ id: 'q', selected: [long] }] });
  });

  it('rejects malformed or stale clicks without consuming the question', async () => {
    const sent: SentMessage[] = [];
    const ch = new QuestionChannel(createManager(), createSender(sent), { requireMention: false }, createLogger());
    const p = startAsk(ch, 'qqbot:app:c2c:U2', [q2()]);
    await sleep(20);
    expect(ch.handleInteraction(makeEvent('not-json', { user: 'U2' }))).toBe(false);
    expect(ch.handleInteraction(makeEvent(JSON.stringify({ i: 9 }), { user: 'U2' }))).toBe(false);
    expect(ch.handleInteraction(makeEvent(JSON.stringify({ i: 0 }), { user: 'nobody' }))).toBe(false);
    expect(ch.handleInteraction(makeEvent(undefined, { user: 'U2' }))).toBe(false);
    ch.tryAnswer('qqbot:app:c2c:U2', '1'); // 文本仍可作答
    await p;
  });
});

describe('QuestionChannel.install routing（双端投递）', () => {
  /** 模拟宿主 Web provider：挂起等待"用户在 Web 作答"，signal 中止即拒绝（撤卡片） */
  function makeWebAsk() {
    const calls: { signal?: AbortSignal; resolve: (r: UserQuestionResult) => void }[] = [];
    const ask = vi.fn((request: UserQuestionRequest) => new Promise<UserQuestionResult>((resolve, reject) => {
      calls.push({ signal: request.signal, resolve });
      request.signal?.addEventListener('abort', () => reject(new Error('ASK_ABORTED')), { once: true });
    }));
    return { ask, calls };
  }

  it('non-QQ session delegates to the original ask untouched', async () => {
    const sent: SentMessage[] = [];
    const { ask, calls } = makeWebAsk();
    const uq = { ask };
    const ch = new QuestionChannel(createManager(), createSender(sent), { requireMention: false }, createLogger());
    ch.install({ get: (n: string) => (n === 'userQuestions' ? uq : undefined) });

    const p = uq.ask({ questions: [q2()], agent: { id: 'sess-web' } });
    await sleep(10);
    expect(calls).toHaveLength(1); // 原实现被调用
    expect(sent).toHaveLength(0); // 未触碰 QQ
    calls[0]?.resolve({ answers: [{ id: 'q', selected: ['A'] }] });
    expect(await p).toEqual({ answers: [{ id: 'q', selected: ['A'] }] });
  });

  it('QQ live record: dual delivery, QQ answers first → web card aborted', async () => {
    const sent: SentMessage[] = [];
    const record = makeRecord('qqbot:app:c2c:u9');
    const manager = createManager((id) => (id === 'sess-qq' ? record : undefined));
    const { ask, calls } = makeWebAsk();
    const uq = { ask };
    const ch = new QuestionChannel(manager, createSender(sent), { requireMention: false }, createLogger());
    ch.install({ get: (n: string) => (n === 'userQuestions' ? uq : undefined) });

    const p = uq.ask({ questions: [q2()], agent: { id: 'sess-qq' } });
    await sleep(20);
    expect(sent).toHaveLength(1); // QQ 端收到问题
    expect(calls).toHaveLength(1); // Web 端同时弹卡片

    expect(ch.tryAnswer('qqbot:app:c2c:u9', '1')).toBe(true);
    expect(await p).toEqual({ answers: [{ id: 'q', selected: ['A'] }] });
    await sleep(10);
    expect(calls[0]?.signal?.aborted).toBe(true); // QQ 先答 → Web 卡片被撤
  });

  it('QQ live record: web answers first → QQ pending released', async () => {
    const sent: SentMessage[] = [];
    const record = makeRecord('qqbot:app:c2c:u9');
    const manager = createManager((id) => (id === 'sess-qq' ? record : undefined));
    const { ask, calls } = makeWebAsk();
    const uq = { ask };
    const ch = new QuestionChannel(manager, createSender(sent), { requireMention: false }, createLogger());
    ch.install({ get: (n: string) => (n === 'userQuestions' ? uq : undefined) });

    const p = uq.ask({ questions: [q2()], agent: { id: 'sess-qq' } });
    await sleep(20);
    calls[0]?.resolve({ answers: [{ id: 'q', selected: ['B'] }] });
    expect(await p).toEqual({ answers: [{ id: 'q', selected: ['B'] }] });
    // QQ 待答登记已释放：之后的文本/点击不再被当作答案
    expect(ch.tryAnswer('qqbot:app:c2c:u9', '1')).toBe(false);
    expect(ch.handleInteraction({
      id: 'i', type: 1, version: 1, user_openid: 'u9',
      data: { type: 1, resolved: { button_data: JSON.stringify({ i: 0 }) } },
    } as InteractionEvent)).toBe(false);
  });

  it('web-originated turn: bridges via peer map and dual delivers', async () => {
    const sent: SentMessage[] = [];
    // 无活跃记录（findBySessionId 落空），但持久化映射知道这是 QQ 会话
    const manager = {
      findBySessionId: () => undefined,
      sessionKey,
      resolvePeer: (id: string) => (id === 'sess-bridge'
        ? { scope: 'c2c' as ChatScope, peerId: 'P9', lastMsgId: 'LM1' }
        : undefined),
    };
    const { ask, calls } = makeWebAsk();
    const uq = { ask };
    const ch = new QuestionChannel(manager, createSender(sent), { requireMention: false }, createLogger());
    ch.install({ get: (n: string) => (n === 'userQuestions' ? uq : undefined) });

    const p = uq.ask({ questions: [q2()], agent: { id: 'sess-bridge' } });
    await sleep(20);
    expect(sent).toHaveLength(1);
    // 桥接投递目标来自对端映射（带最近 msgId 走被动回复，过期由容错链兜底）
    expect(sent[0]?.target.targetId).toBe('P9');
    expect(sent[0]?.target.msgId).toBe('LM1');
    expect(sent[0]?.opts?.keyboard).toBeDefined();
    expect(calls).toHaveLength(1);

    expect(ch.tryAnswer('qqbot:app:c2c:P9', '2')).toBe(true);
    expect(await p).toEqual({ answers: [{ id: 'q', selected: ['B'] }] });
  });

  it('no live record and no peer mapping: web only', async () => {
    const sent: SentMessage[] = [];
    const { ask, calls } = makeWebAsk();
    const uq = { ask };
    const ch = new QuestionChannel(createManager(), createSender(sent), { requireMention: false }, createLogger());
    ch.install({ get: (n: string) => (n === 'userQuestions' ? uq : undefined) });

    const p = uq.ask({ questions: [q2()], agent: { id: 'sess-x' } });
    await sleep(10);
    expect(sent).toHaveLength(0);
    expect(calls).toHaveLength(1);
    calls[0]?.resolve({ answers: [{ id: 'q', selected: ['A'] }] });
    await p;
  });

  it('QQ delivery failure degrades to web-only asking', async () => {
    const { ask, calls } = makeWebAsk();
    const uq = { ask };
    const manager = {
      findBySessionId: (id: string) => (id === 'sess-qq' ? makeRecord('qqbot:app:c2c:uf') : undefined),
      sessionKey,
    };
    const ch = new QuestionChannel(
      manager,
      { sendMarkdown: vi.fn(async () => { throw new Error('network down'); }) },
      { requireMention: false },
      createLogger(),
    );
    ch.install({ get: (n: string) => (n === 'userQuestions' ? uq : undefined) });

    const p = uq.ask({ questions: [q2()], agent: { id: 'sess-qq' } });
    await sleep(20);
    expect(calls).toHaveLength(1);
    calls[0]?.resolve({ answers: [{ id: 'q', selected: ['A'] }] });
    expect(await p).toEqual({ answers: [{ id: 'q', selected: ['A'] }] });
  });

  it('turn abort rejects the dual ask (both sides released)', async () => {
    const sent: SentMessage[] = [];
    const record = makeRecord('qqbot:app:c2c:ua');
    const manager = createManager((id) => (id === 'sess-qq' ? record : undefined));
    const { ask } = makeWebAsk();
    const uq = { ask };
    const ch = new QuestionChannel(manager, createSender(sent), { requireMention: false }, createLogger());
    ch.install({ get: (n: string) => (n === 'userQuestions' ? uq : undefined) });

    const ac = new AbortController();
    const p = uq.ask({ questions: [q2()], agent: { id: 'sess-qq' }, signal: ac.signal });
    await sleep(20);
    ac.abort();
    await expect(p).rejects.toThrow();
    expect(ch.tryAnswer('qqbot:app:c2c:ua', '1')).toBe(false); // QQ 侧不再等待
  });

  it('uninstall restores the original ask', async () => {
    const sent: SentMessage[] = [];
    const record = makeRecord('qqbot:app:c2c:u9');
    const manager = createManager((id) => (id === 'sess-qq' ? record : undefined));
    const ch = new QuestionChannel(manager, createSender(sent), { requireMention: false }, createLogger());
    const uq: { ask: (r: UserQuestionRequest) => Promise<UserQuestionResult>; __qqQuestionPatched?: boolean } = {
      ask: async () => ({ answers: [] }),
    };
    ch.install({ get: (n: string) => (n === 'userQuestions' ? uq : undefined) });
    expect(uq.__qqQuestionPatched).toBe(true);
    ch.uninstall();
    expect(uq.__qqQuestionPatched).toBeUndefined();
  });

  it('disables gracefully when the userQuestions service is missing', () => {
    const sent: SentMessage[] = [];
    const logger = createLogger();
    const ch = new QuestionChannel(createManager(), createSender(sent), { requireMention: false }, logger);
    ch.install({ get: () => undefined });
    expect(logger.warn).toHaveBeenCalled();
  });
});

describe('QuestionChannel.deliverResilient（投递容错链）', () => {
  it('retries without msgId when the passive send fails (stale msgId)', async () => {
    const attempts: Array<{ msgId?: string; keyboard?: unknown }> = [];
    const sender = {
      sendMarkdown: vi.fn(async (target: ReplyTarget, _content: string, o?: { keyboard?: unknown }) => {
        attempts.push({ msgId: target.msgId, keyboard: o?.keyboard });
        if (target.msgId !== undefined) throw new Error('API Error: msg_id expired');
      }),
    };
    const ch = new QuestionChannel(createManager(), sender, { requireMention: false }, createLogger());
    const p = startAsk(ch, 'kr', [q2()]); // makeRecord 带 msgId='m'
    await sleep(20);
    expect(attempts).toHaveLength(2);
    expect(attempts[0]?.msgId).toBe('m');
    expect(attempts[1]?.msgId).toBeUndefined(); // 主动重发成功
    expect(attempts[1]?.keyboard).toBeDefined(); // 重发仍带键盘
    ch.tryAnswer('kr', '1');
    await p;
  });

  it('falls back to wakeup for c2c text when both markdown attempts fail', async () => {
    const wakeups: string[] = [];
    const sender = {
      sendMarkdown: vi.fn(async () => { throw new Error('proactive blocked'); }),
      sendWakeup: vi.fn(async (_target: ReplyTarget, content: string) => { wakeups.push(content); }),
    };
    const ch = new QuestionChannel(createManager(), sender, { requireMention: false }, createLogger());
    // 多题 → 无键盘 → 纯文本路径可达唤醒
    const p = startAsk(ch, 'kw', [q2(), q2('q2')]);
    await sleep(20);
    expect(wakeups).toHaveLength(1);
    expect(wakeups[0]).toContain('1. A');
    ch.tryAnswer('kw', '统一回复');
    await p;
  });
});
