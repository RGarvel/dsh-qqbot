/**
 * QQ 通道提问规约 prompt section
 *
 * 背景：模型在给出选择时，有时直接输出编号文本（如「1. xxx 2. yyy」）
 * 而不调用 ask_user_question。QQ 问题通道只拦截 ask_user_question 调用
 * 渲染可点击按钮——编号纯文本只会让用户手动输入，体验倒退，且终端无任何报错。
 *
 * 本 section 在会话 create/resume 的 setup 阶段注入，明确要求模型：
 * 让读者做选择/确认/补信息时必须走 ask_user_question 工具。
 *
 * fail-soft：systemPrompt 服务缺失或注册失败仅 debug 日志，不影响会话。
 */
import type { Context } from '@deepseek-ai/cordis';
import type { Logger } from '../types.js';

export const QUESTION_STYLE_SECTION_NAME = 'qqbot:question-style';

export const QUESTION_STYLE_SECTION_TEXT = `## QQ 通道提问规范
需要用户选择、确认操作或补充信息时，一律用 ask_user_question 工具提问（选项 label 简洁；确需多选才设 multi_select 为 true），不要用编号纯文本列选项让用户手动回复。无固定选项的开放式问题可直接文字提问。`;

interface SystemPromptLike {
  section(section: { name: string; order: number; text: string }): unknown;
}

/**
 * 向 agent 上下文注册提问规约 section（order 取大值，排在系统提示尾部更显眼）。
 * 由 SessionManager 在 composePreset 的 setup hook 中、预设挂载之后调用。
 */
export function registerQuestionStyleSection(agentCtx: Context, logger?: Logger): void {
  try {
    const getter = agentCtx as unknown as { get?(key: string): unknown };
    const sp = typeof getter.get === 'function'
      ? (getter.get('systemPrompt') as SystemPromptLike | undefined)
      : undefined;
    if (sp && typeof sp.section === 'function') {
      sp.section({ name: QUESTION_STYLE_SECTION_NAME, order: 900, text: QUESTION_STYLE_SECTION_TEXT });
    }
  } catch (err) {
    logger?.debug(`im-qqbot: question-style section skipped: ${err instanceof Error ? err.message : String(err)}`);
  }
}
