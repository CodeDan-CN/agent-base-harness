import { describe, expect, it } from 'vitest';
import { shouldSubmitComposerOnKeyDown } from '../../packages/app-ui/src/composer-input-policy';

describe('输入框回车策略', () => {
  it('没有输入法组合时回车发送', () => {
    expect(
      shouldSubmitComposerOnKeyDown({
        key: 'Enter',
        shiftKey: false,
        isComposing: false,
        keyCode: 13,
      }),
    ).toBe(true);
  });

  it.each([
    { name: '输入法正在组合', isComposing: true, keyCode: 13, shiftKey: false },
    { name: 'Chromium 输入法兜底键码', isComposing: false, keyCode: 229, shiftKey: false },
    { name: 'Shift + Enter', isComposing: false, keyCode: 13, shiftKey: true },
  ])('$name 时不发送', ({ isComposing, keyCode, shiftKey }) => {
    expect(
      shouldSubmitComposerOnKeyDown({
        key: 'Enter',
        shiftKey,
        isComposing,
        keyCode,
      }),
    ).toBe(false);
  });
});
