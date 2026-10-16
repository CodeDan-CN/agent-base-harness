export const MAX_SESSION_TITLE_LENGTH = 200;

/** 首条用户输入生成单行会话名；服务端契约当前最多接收 200 个 UTF-16 单元。 */
export function sessionTitleFromFirstInput(content: string): string {
  const normalized = content.replace(/\s+/gu, ' ').trim();
  if (!normalized) return '新对话';
  let title = normalized.slice(0, MAX_SESSION_TITLE_LENGTH);
  if (/[\uD800-\uDBFF]$/u.test(title)) title = title.slice(0, -1);
  return title;
}
