import { describe, it, expect, vi } from 'vitest';
import {
  registerQuestionStyleSection,
  QUESTION_STYLE_SECTION_NAME,
  QUESTION_STYLE_SECTION_TEXT,
} from './question-style.js';

describe('registerQuestionStyleSection', () => {
  it('注册 section：名称/排序/正文要求使用 ask_user_question', () => {
    const section = vi.fn();
    const ctx = { get: (k: string) => (k === 'systemPrompt' ? { section } : undefined) };

    registerQuestionStyleSection(ctx as never);

    expect(section).toHaveBeenCalledTimes(1);
    const arg = section.mock.calls[0]?.[0];
    expect(arg.name).toBe(QUESTION_STYLE_SECTION_NAME);
    expect(typeof arg.order).toBe('number');
    expect(arg.text).toContain('ask_user_question');
    expect(arg.text).toBe(QUESTION_STYLE_SECTION_TEXT);
  });

  it('systemPrompt 服务缺失：静默跳过', () => {
    const ctx = { get: () => undefined };
    expect(() => registerQuestionStyleSection(ctx as never)).not.toThrow();
  });

  it('get 抛错：静默跳过（fail-soft）', () => {
    const ctx = {
      get: () => {
        throw new Error('service unavailable');
      },
    };
    expect(() => registerQuestionStyleSection(ctx as never)).not.toThrow();
  });

  it('section 方法缺失：静默跳过', () => {
    const ctx = { get: () => ({}) };
    expect(() => registerQuestionStyleSection(ctx as never)).not.toThrow();
  });
});
