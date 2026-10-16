import { describe, expect, it } from 'vitest';
import {
  MAX_SESSION_TITLE_LENGTH,
  sessionTitleFromFirstInput,
} from '../../packages/app-ui/src/session-title';

describe('sessionTitleFromFirstInput', () => {
  it('uses the normalized first user question as the session title', () => {
    expect(sessionTitleFromFirstInput('  第一行\n\n第二行  ')).toBe('第一行 第二行');
  });

  it('keeps the title within the public contract without splitting an emoji pair', () => {
    const title = sessionTitleFromFirstInput(`${'问'.repeat(199)}😀后续`);
    expect(title).toBe('问'.repeat(199));
    expect(title.length).toBeLessThanOrEqual(MAX_SESSION_TITLE_LENGTH);
  });
});
