/**
 * QuestionChannel — ask_user_question 的 QQ 交互通道
 *
 * 背景：`ask_user_question` 工具通过 `ctx.userQuestions` 的单一 provider 等待
 * 人类回答；宿主默认 provider（dsh-host-apiproxy）把问题推给 Web 客户端渲染成
 * 弹出框。QQ 是纯文本通道，QQ 用户原本看不到问题、也无法作答。
 *
 * 本通道包装 `ctx.userQuestions` 服务的 `ask` 方法（不动 provider 注册机制）：
 *   - 提问会话属于 QQ bot（SessionManager 按 sessionId 找到活跃记录，或经
 *     持久化对端映射桥接——如网页端继续的 QQ 会话）→ 问题**双端出现**：
 *     QQ 端收到编号选项文本（单选带选项时附带可点击的内联按钮），Web 端
 *     照常弹出卡片；任一端先作答即定案，另一端自动清理（QQ 先答 → 中止
 *     signal 撤下 Web 卡片；Web 先答 → 释放 QQ 待答登记）；
 *   - 其他会话 → 原样委托给原 `ask`（Web 弹出框行为不变）。
 *
 * 按钮链路：`sendMarkdown(..., { keyboard })` 附带 `action.type=1`（回调）按钮；
 * 用户点击触发 `interaction` 事件，由 bootstrap 的监听器转给 `handleInteraction`，
 * 按 `button_data` 解析出所选选项并 ACK（平台要求 5 秒内）。按钮发送失败
 * （如机器人无按钮权限）自动回退为纯文本编号问答。
 *
 * 平台实测结论（与部分文档/示例不一致，见注释内标注）：
 *   - `action.type`：0=跳转链接，1=回调（点击即发 INTERACTION_CREATE），
 *     2=把 data 填入输入框（需用户手动发送）。要实现"点击即确认"必须用 1。
 *   - `action.permission.type`：0 在部分机器人上点击报"无权限操作"；
 *     2（指定用户不可点，列表为空即全员可点）行为正常。
 *
 * 答案契约与宿主一致：`{ answers: [{ id, selected: string[], custom? }] }`，
 * selected 使用选项的原文 label。
 */
import type { InlineKeyboard, InteractionEvent } from '@tencent-connect/qqbot-nodejs';
import type { ChatScope, Logger, ReplyTarget } from '../types.js';
import { detectTrailingOptions } from './quick-reply.js';

// ── user-questions 契约（结构化类型，避免硬依赖 dsh-user-questions） ──

export interface UserQuestionOption {
  label: string;
  description?: string;
}

export interface UserQuestion {
  id: string;
  question: string;
  header?: string;
  options?: UserQuestionOption[];
  multiSelect?: boolean;
}

export interface UserQuestionAnswer {
  id: string;
  selected: string[];
  custom?: string;
}

export interface UserQuestionRequest {
  questions: UserQuestion[];
  agent?: { id: string };
  signal?: AbortSignal;
}

export interface UserQuestionResult {
  answers: UserQuestionAnswer[];
}

export interface UserQuestionsServiceLike {
  ask(request: UserQuestionRequest): Promise<UserQuestionResult>;
}

// ── 依赖的最小结构（SessionManager / QQBotSender 均结构化满足） ──

export interface QuestionSessionRecordLike {
  sessionKey: string;
  scope: ChatScope;
  replyTarget: ReplyTarget;
}

/** PeerMap 桥接信息：无活跃记录时据此起草 QQ 投递目标（Web 回合提问场景） */
export interface QuestionPeerInfoLike {
  scope: ChatScope;
  peerId: string;
  lastMsgId?: string;
}

export interface QuestionChannelManagerLike {
  findBySessionId(sessionId: string): QuestionSessionRecordLike | undefined;
  sessionKey(scope: ChatScope, peerId: string): string;
  /** 可选：按 sessionId 查持久化的 QQ 对端映射（Web 回合桥接用） */
  resolvePeer?(sessionId: string): QuestionPeerInfoLike | undefined;
}

export interface QuestionChannelSenderLike {
  sendMarkdown(target: ReplyTarget, content: string, opts?: { keyboard?: InlineKeyboard }): Promise<unknown>;
  /** 可选：c2c 唤醒投递（主动消息也被限流时的最后手段，不支持键盘） */
  sendWakeup?(target: ReplyTarget, content: string): Promise<unknown>;
}

export interface QuestionChannelConfigLike {
  requireMention: boolean;
}

interface PendingEntry {
  request: UserQuestionRequest;
  resolve: (result: UserQuestionResult) => void;
  reject: (err: Error) => void;
  onAbort?: () => void;
}

/** 按钮点击的处理结果 */
export type InteractionOutcome =
  /** 命中待答问题，已作为答案提交 */
  | { kind: 'answered' }
  /** 命中出站层挂的快捷按钮：需把 text（选项编号）作为用户消息注入会话 */
  | { kind: 'quick-reply'; scope: ChatScope; peerId: string; senderId: string; text: string }
  /** 未命中任何待处理按钮 */
  | { kind: 'none' };

/** QQ 按钮 label 有长度限制，超长截断（正文保留完整文本） */
const BUTTON_LABEL_MAX = 18;

function buttonLabel(text: string | undefined): string {
  const s = String(text ?? '').trim();
  return s.length > BUTTON_LABEL_MAX ? s.slice(0, BUTTON_LABEL_MAX - 1) + '…' : s;
}

/** 由选项标签构建内联键盘（一行一按钮）；button_data 编码 `{"i":<下标>}` */
export function keyboardFromLabels(labels: readonly string[]): InlineKeyboard {
  return {
    content: {
      rows: labels.map((label, i) => ({
        buttons: [{
          id: `q-opt-${i}`,
          render_data: {
            label: buttonLabel(label),
            visited_label: buttonLabel(label),
            style: 1,
          },
          action: {
            // action.type：0=跳转链接，1=回调（点击即发 INTERACTION_CREATE，
            //   无需再发送），2=把 data 填入输入框（需用户手动发送）。
            //   这里必须用 1 才能"点击即确认"。
            type: 1,
            // permission.type 用 2（指定用户不可点、列表为空即全员可点）；
            // 实测 type 0 会导致点击报"无权限操作"。
            permission: { type: 2 },
            data: JSON.stringify({ i }),
          },
        }],
      })),
    },
  };
}

/**
 * 为"单题、单选、带选项"的问题构建内联键盘；不适用时返回 undefined。
 * button_data 编码 `{"i":<选项下标>}`，由 handleInteraction 解码。
 */
export function buildKeyboard(questions: readonly UserQuestion[]): InlineKeyboard | undefined {
  if (questions.length !== 1) return undefined;
  const q = questions[0];
  if (!q) return undefined;
  const opts = q.options ?? [];
  if (opts.length === 0 || q.multiSelect) return undefined;
  return keyboardFromLabels(opts.map((o) => o.label));
}

/** 把请求中的问题渲染成 QQ 文本 */
export function formatQuestions(
  questions: readonly UserQuestion[],
  requireMentionHint: boolean,
  withButtons: boolean,
): string {
  const lines: string[] = [];
  for (const q of questions) {
    if (q.header) lines.push(`**${q.header}**`);
    lines.push(q.question);
    const opts = q.options ?? [];
    opts.forEach((o, i) => {
      lines.push(`${i + 1}. ${o.label}${o.description ? ` — ${o.description}` : ''}`);
    });
    if (q.multiSelect && opts.length > 0) lines.push('（可多选：回复多个编号，如 1,3）');
  }
  if ((questions[0]?.options?.length ?? 0) > 0) {
    lines.push('');
    const mention = requireMentionHint ? '（需 @机器人）' : '';
    if (withButtons) lines.push(`点击下方按钮选择${mention}，或直接输入文字作为自定义回答。`);
    else lines.push(`回复编号选择${mention}，或直接输入文字作为自定义回答。`);
  }
  return lines.join('\n');
}

/** 把用户的 QQ 文本回复解析为答案（单题精确解析；多题降级为整段文字） */
export function parseAnswers(questions: readonly UserQuestion[], text: string): UserQuestionAnswer[] {
  if (questions.length === 1) {
    const q = questions[0];
    if (!q) return [];
    const opts = q.options ?? [];
    if (opts.length > 0) {
      // 纯数字/分隔符 → 按编号选择
      if (/^[\d\s,，、;；./]+$/.test(text)) {
        const nums = [...text.matchAll(/\d+/g)]
          .map((m) => parseInt(m[0], 10))
          .filter((n) => n >= 1 && n <= opts.length);
        if (nums.length > 0) {
          const picked = q.multiSelect ? nums : nums.slice(0, 1);
          const selected = [...new Set(picked.map((n) => opts[n - 1]?.label).filter((l): l is string => typeof l === 'string'))];
          return [{ id: q.id, selected }];
        }
      }
      // 文本与某个选项 label 完全一致（忽略大小写）
      const exact = opts.find((o) => o.label.toLowerCase() === text.toLowerCase());
      if (exact) return [{ id: q.id, selected: [exact.label] }];
    }
    return [{ id: q.id, selected: [], custom: text }];
  }
  // 多问题：把整段回复作为每个问题的自定义回答（agent 自行解读）
  return questions.map((q) => ({ id: q.id, selected: [], custom: text }));
}

export class QuestionChannel {
  /** sessionKey → pending entry */
  private readonly pending = new Map<string, PendingEntry>();
  /** sessionKey → 最近一条"尾部编号选项"消息的选项标签（快捷按钮点击解析用） */
  private readonly quickReplies = new Map<string, string[]>();
  private uq: (UserQuestionsServiceLike & { __qqQuestionPatched?: boolean }) | undefined;
  private origAsk: ((request: UserQuestionRequest) => Promise<UserQuestionResult>) | undefined;

  public constructor(
    private readonly manager: QuestionChannelManagerLike,
    private readonly sender: QuestionChannelSenderLike,
    private readonly config: QuestionChannelConfigLike,
    private readonly logger: Logger,
  ) {}

  /**
   * 安装：包装 userQuestions 服务的 `ask` 方法。
   *
   * 选择包装 `ask` 而非替换 `provider`：
   *   - provider 注册在宿主的 effect 里延迟赋值且查重（DUPLICATE_PROVIDER），
   *     直接换 provider 会受插件加载顺序影响、甚至引发冲突；
   *   - `ask` 是服务实例方法，工具/计划模式都经 `ctx.userQuestions.ask(...)` 调用，
   *     在实例上覆写即可稳定拦截，且非 QQ 会话原样委托给原实现（Web 弹出框不受影响）。
   */
  install(ctx: { get(name: string): unknown }): void {
    let uq: (UserQuestionsServiceLike & { __qqQuestionPatched?: boolean }) | undefined;
    try {
      const svc = ctx.get('userQuestions') as UserQuestionsServiceLike | undefined;
      if (svc && typeof svc.ask === 'function') uq = svc as UserQuestionsServiceLike & { __qqQuestionPatched?: boolean };
    } catch {
      uq = undefined;
    }
    if (!uq) {
      this.logger.warn('im-qqbot: userQuestions service unavailable; QQ question channel disabled');
      return;
    }
    if (uq.__qqQuestionPatched) {
      this.logger.warn('im-qqbot: userQuestions already patched; skipping duplicate install');
      return;
    }
    const self = this;
    const origAsk = uq.ask.bind(uq);
    uq.ask = async function qqRoutedAsk(request: UserQuestionRequest): Promise<UserQuestionResult> {
      const sessionId = request?.agent?.id;
      const record = sessionId ? self.manager.findBySessionId(sessionId) : undefined;
      if (record) return self.askDual(record, request, origAsk);
      // Web 回合桥接：无活跃记录，但持久化映射知道这是 QQ 会话（如网页端继续的
      // QQ 会话）→ 起草投递目标，问题同样双端出现（QQ 可作答，Web 弹卡片）
      const peer = sessionId ? self.manager.resolvePeer?.(sessionId) : undefined;
      if (peer) {
        const bridged: QuestionSessionRecordLike = {
          sessionKey: self.manager.sessionKey(peer.scope, peer.peerId),
          scope: peer.scope,
          replyTarget: { scope: peer.scope, targetId: peer.peerId, msgId: peer.lastMsgId },
        };
        return self.askDual(bridged, request, origAsk);
      }
      return origAsk(request);
    };
    uq.__qqQuestionPatched = true;
    this.uq = uq;
    this.origAsk = origAsk;
    this.logger.info('im-qqbot: QQ question channel installed (ask-wrap)');
  }

  /** 卸载：恢复原 `ask`，拒绝所有待答问题 */
  uninstall(): void {
    if (this.uq && this.origAsk) {
      this.uq.ask = this.origAsk;
      delete this.uq.__qqQuestionPatched;
      this.uq = undefined;
      this.origAsk = undefined;
    }
    for (const [, entry] of this.pending) {
      entry.reject(new Error('QQ question channel was unloaded before the user answered'));
    }
    this.pending.clear();
  }

  /**
   * 入站截获：该会话若有待答问题且本条消息有文本，解析为答案并提交。
   * @returns true 表示消息已被消费为答案（调用方应停止常规处理）
   */
  tryAnswer(sessionKey: string, text: string): boolean {
    const entry = this.pending.get(sessionKey);
    if (!entry) return false;
    if (!text) return false; // 纯图片/表情等：继续等待，消息走常规流程
    this.pending.delete(sessionKey);
    if (entry.onAbort && entry.request.signal) {
      entry.request.signal.removeEventListener('abort', entry.onAbort);
    }
    let answers: UserQuestionAnswer[];
    try {
      answers = parseAnswers(entry.request.questions, text);
    } catch (err) {
      entry.reject(err instanceof Error ? err : new Error(String(err)));
      return true;
    }
    this.logger.info(`im-qqbot: question answered via QQ key=${sessionKey} text="${text.slice(0, 80)}"`);
    entry.resolve({ answers });
    return true;
  }

  /**
   * 双端提问：QQ 会话的问题同时投到 QQ（文本/按钮）与 Web（弹卡片），
   * 任一端先作答即定案，另一端随即清理：
   *   - QQ 先答 → 中止传给 Web 的 signal（宿主 provider 收到 abort 即撤下卡片）；
   *   - Web 先答 → 移除 QQ 待答登记（之后的 QQ 文本/点击不再被当作答案）。
   * QQ 投递失败不影响 Web 端作答；Web provider 缺失/拒绝也不影响 QQ 端作答；
   * 两端都失败才整体拒绝。
   */
  async askDual(
    record: QuestionSessionRecordLike,
    request: UserQuestionRequest,
    origAsk: (request: UserQuestionRequest) => Promise<UserQuestionResult>,
  ): Promise<UserQuestionResult> {
    // 链接中止：回合中止 → 撤 Web 卡片；QQ 先答 → 撤 Web 卡片
    const linked = new AbortController();
    const forwardAbort = (): void => linked.abort();
    if (request.signal) {
      if (request.signal.aborted) linked.abort();
      else request.signal.addEventListener('abort', forwardAbort, { once: true });
    }
    const detachForward = (): void => {
      if (request.signal) request.signal.removeEventListener('abort', forwardAbort);
    };

    const webPromise = origAsk({ ...request, signal: linked.signal });
    const qqPromise = this.askViaQQ(record, request).catch((err) => {
      this.logger.warn(`im-qqbot: QQ question unavailable, web only: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    });

    return new Promise<UserQuestionResult>((resolve, reject) => {
      let settled = false;
      let qqAlive = true;
      let webAlive = true;
      let webError: unknown;

      const failIfBothDead = (): void => {
        if (settled || qqAlive || webAlive) return;
        settled = true;
        detachForward();
        reject(webError instanceof Error ? webError : new Error('failed to ask the user on both QQ and Web'));
      };

      void qqPromise.then((qqResult) => {
        if (qqResult === undefined) {
          qqAlive = false;
          failIfBothDead();
          return;
        }
        if (settled) return;
        settled = true;
        detachForward();
        linked.abort(); // 宿主 provider 广播 question/resolved(cancelled)，Web 卡片撤下
        webPromise.catch(() => undefined); // 吞掉随之而来的 ASK_ABORTED
        resolve(qqResult);
      });

      void webPromise.then((webResult) => {
        if (settled) return;
        settled = true;
        detachForward();
        this.releaseQqPending(record.sessionKey);
        resolve(webResult);
      }).catch((err) => {
        webAlive = false;
        webError = err;
        failIfBothDead();
      });
    });
  }

  /** Web 先作答后放弃 QQ 端等待：移除待答登记，QQ 文本/点击回归常规消息流 */
  private releaseQqPending(key: string): void {
    const entry = this.pending.get(key);
    if (!entry) return;
    this.pending.delete(key);
    if (entry.onAbort && entry.request.signal) {
      entry.request.signal.removeEventListener('abort', entry.onAbort);
    }
    this.logger.info(`im-qqbot: QQ pending question released (answered elsewhere) key=${key}`);
  }

  /**
   * 容错投递：被动回复（带 msgId）→ 主动消息（不带 msgId，应对过期 msgId）
   * → c2c 唤醒（仅纯文本，键盘不支持）。全部失败抛出最后一个错误。
   */
  private async deliverResilient(target: ReplyTarget, text: string, keyboard?: InlineKeyboard): Promise<void> {
    const opts = keyboard ? { keyboard } : undefined;
    try {
      await this.sender.sendMarkdown(target, text, opts);
      return;
    } catch (err) {
      if (!target.msgId) throw err;
      this.logger.warn(`im-qqbot: question send (passive) failed, retry active: ${err instanceof Error ? err.message : String(err)}`);
      try {
        await this.sender.sendMarkdown({ ...target, msgId: undefined }, text, opts);
        return;
      } catch (err2) {
        if (target.scope === 'c2c' && keyboard === undefined && this.sender.sendWakeup) {
          this.logger.warn(`im-qqbot: question send (active) failed, retry wakeup: ${err2 instanceof Error ? err2.message : String(err2)}`);
          await this.sender.sendWakeup(target, text);
          return;
        }
        throw err2;
      }
    }
  }

  /** QQ 通道提问：发送编号选项文本（单选附带可点击按钮），等待回复或按钮点击 */
  async askViaQQ(record: QuestionSessionRecordLike, request: UserQuestionRequest): Promise<UserQuestionResult> {
    const key = record.sessionKey;
    // 同会话已有待答问题（理论上不会发生：回合阻塞在第一个问题上）→ 拒绝旧的
    const prev = this.pending.get(key);
    if (prev) {
      this.pending.delete(key);
      prev.reject(new Error('superseded by a new question'));
    }
    const hint = record.scope === 'group' && this.config.requireMention === true;
    const keyboard = buildKeyboard(request.questions);
    const text = formatQuestions(request.questions, hint, keyboard !== undefined);
    try {
      if (keyboard !== undefined) {
        try {
          await this.deliverResilient(record.replyTarget, text, keyboard);
        } catch (kbErr) {
          // 按钮发送失败（常见：机器人无按钮权限）→ 回退纯文本编号问答（重排提示语）
          this.logger.warn(`im-qqbot: keyboard send failed, fallback to text: ${kbErr instanceof Error ? kbErr.message : String(kbErr)}`);
          await this.deliverResilient(record.replyTarget, formatQuestions(request.questions, hint, false));
        }
      } else {
        await this.deliverResilient(record.replyTarget, text);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`im-qqbot: question send failed key=${key}: ${msg}`);
      throw new Error(`failed to deliver question to QQ: ${msg}`);
    }
    return new Promise<UserQuestionResult>((resolve, reject) => {
      const entry: PendingEntry = { request, resolve, reject };
      if (request.signal) {
        const onAbort = (): void => {
          if (this.pending.get(key) !== entry) return;
          this.pending.delete(key);
          reject(new Error('ask_user_question was aborted before the user answered'));
        };
        entry.onAbort = onAbort;
        request.signal.addEventListener('abort', onAbort, { once: true });
      }
      this.pending.set(key, entry);
      this.logger.info(`im-qqbot: question sent to QQ (${keyboard !== undefined ? 'with buttons' : 'text only'}), waiting for answer key=${key}`);
    });
  }

  /**
   * 出站快捷按钮：检测助手消息尾部的编号选项块，登记选项并返回键盘。
   *
   * 模型不一定总走 ask_user_question（被中断后继续推进时常直接列编号文本），
   * 出站层对这类消息补挂按钮作确定性兜底：点击等同用户回复编号。
   * 流式消息本身挂不了键盘，调用方把键盘放在随后的附加短消息上。
   *
   * @param key 规范会话键（`manager.sessionKey(scope, peerId)`；桥接记录的
   *            `record.sessionKey` 是 `bridge:*`，不能直接用）
   * @returns 键盘与选项标签；无选项块或该会话已有待答问题时返回 undefined
   */
  prepareQuickReply(key: string, text: string): { keyboard: InlineKeyboard; labels: string[] } | undefined {
    if (this.pending.has(key)) return undefined; // 正式提问在等待时不叠加快捷按钮
    const labels = detectTrailingOptions(text);
    if (labels === undefined) return undefined;
    this.quickReplies.set(key, labels);
    return { keyboard: keyboardFromLabels(labels), labels };
  }

  /**
   * 按钮点击回调：按事件来源定位会话，解码 button_data——
   * 命中待答问题则提交答案；否则尝试快捷按钮（出站层登记的编号选项）。
   */
  handleInteraction(event: InteractionEvent): InteractionOutcome {
    const raw = event?.data?.resolved?.button_data;
    if (typeof raw !== 'string' || raw.length === 0) {
      this.logger.warn('im-qqbot: interaction without button_data ignored');
      return { kind: 'none' };
    }
    const peerId = event.group_openid ?? event.user_openid;
    if (!peerId) {
      this.logger.warn('im-qqbot: interaction without peer openid ignored');
      return { kind: 'none' };
    }
    const scope: ChatScope = event.group_openid ? 'group' : 'c2c';
    const key = this.manager.sessionKey(scope, peerId);
    let idx: unknown;
    try {
      idx = (JSON.parse(raw) as { i?: unknown }).i;
    } catch {
      this.logger.warn(`im-qqbot: unparseable button_data="${raw}"`);
      return { kind: 'none' };
    }

    // 1) 待答正式提问 → 提交答案
    const entry = this.pending.get(key);
    if (entry) {
      const q = entry.request.questions?.[0];
      const opts = q?.options ?? [];
      if (typeof idx !== 'number' || !opts[idx]) {
        this.logger.warn(`im-qqbot: button index out of range idx=${String(idx)} options=${opts.length}`);
        return { kind: 'none' };
      }
      const option = opts[idx];
      if (!option || !q) return { kind: 'none' };
      this.pending.delete(key);
      if (entry.onAbort && entry.request.signal) {
        entry.request.signal.removeEventListener('abort', entry.onAbort);
      }
      this.logger.info(`im-qqbot: question answered via QQ button key=${key} option=${option.label}`);
      entry.resolve({ answers: [{ id: q.id, selected: [option.label] }] });
      return { kind: 'answered' };
    }

    // 2) 快捷按钮 → 解析为"回复编号"，由调用方注入为用户消息
    const labels = this.quickReplies.get(key);
    if (labels && typeof idx === 'number' && labels[idx] !== undefined) {
      const senderId = scope === 'group'
        ? (event.group_member_openid ?? event.user_openid ?? peerId)
        : (event.user_openid ?? peerId);
      this.logger.info(`im-qqbot: quick-reply clicked key=${key} option=${idx + 1} ("${labels[idx]}")`);
      return { kind: 'quick-reply', scope, peerId, senderId, text: String(idx + 1) };
    }

    this.logger.warn(`im-qqbot: button click with no pending question or quick reply key=${key}`);
    return { kind: 'none' };
  }
}
