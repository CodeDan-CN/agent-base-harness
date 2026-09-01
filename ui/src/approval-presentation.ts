export interface ApprovalDisplay {
  title: string;
  detail: string;
  technicalDetail: boolean;
}

export function approvalDisplay(
  toolName: string,
  presentation: unknown,
  argumentsValue?: unknown,
): ApprovalDisplay {
  const view = recordOf(presentation);
  const rawTitle = stringAt(view, 'title');
  const command = stringAt(view, 'command');
  const path = stringAt(view, 'path');
  const rawDetail = stringAt(view, 'detail');
  const fallbackTitle = friendlyToolTitle(toolName);
  const title = rawTitle && !looksLikeToolDocumentation(rawTitle) ? rawTitle : fallbackTitle;

  if (command) return { title, detail: command, technicalDetail: true };
  if (path) return { title, detail: path, technicalDetail: true };
  if (rawDetail && !looksLikeToolIdentifier(rawDetail) && !looksLikeToolDocumentation(rawDetail)) {
    return { title, detail: rawDetail, technicalDetail: false };
  }
  const argumentDetail = summarizeArguments(argumentsValue);
  if (argumentDetail) return { title, detail: argumentDetail, technicalDetail: false };
  return {
    title,
    detail:
      fallbackTitle === '联网搜索'
        ? '将连接外部网络并执行搜索。'
        : `将调用外部工具“${fallbackTitle}”。`,
    technicalDetail: false,
  };
}

function summarizeArguments(value: unknown): string | undefined {
  const args = recordOf(value);
  if (!args) return undefined;
  const preferred: Array<[string, string]> = [
    ['query', '搜索内容'],
    ['url', '访问地址'],
    ['prompt', '请求内容'],
    ['path', '目标'],
    ['name', '对象'],
  ];
  for (const [key, label] of preferred) {
    const candidate = args[key];
    if (typeof candidate === 'string' && candidate.trim()) {
      return `${label}：${truncate(candidate.trim())}`;
    }
  }
  return undefined;
}

function truncate(value: string): string {
  return value.length > 240 ? `${value.slice(0, 237)}…` : value;
}

function friendlyToolTitle(toolName: string): string {
  const normalized = toolName.toLowerCase();
  if (/web[_-]?search|search[_-]?web|search[_-]?exa/.test(normalized)) return '联网搜索';
  if (/web[_-]?fetch|fetch[_-]?url|read[_-]?url/.test(normalized)) return '读取网页';
  if (/\bdelete\b|[_-]delete|remove/.test(normalized)) return '删除外部数据';
  if (/\bsend\b|[_-]send|message|email/.test(normalized)) return '发送外部内容';
  if (/\bwrite\b|[_-]write|create|update|edit/.test(normalized)) return '修改外部数据';
  if (/\bread\b|[_-]read|list|get|search/.test(normalized)) return '读取外部数据';
  const lastSegment = toolName.split('__').filter(Boolean).at(-1) ?? toolName;
  return lastSegment.replace(/[_-]+/g, ' ').trim() || '外部工具调用';
}

function looksLikeToolDocumentation(value: string): boolean {
  return (
    value.length > 96 ||
    /\b(best for|returns|query tips|use category|follow up with|ideal page)\b/i.test(value)
  );
}

function looksLikeToolIdentifier(value: string): boolean {
  return /^[A-Za-z0-9_.:-]+$/.test(value.trim());
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringAt(value: Record<string, unknown> | undefined, key: string): string | undefined {
  const candidate = value?.[key];
  return typeof candidate === 'string' && candidate.trim() ? candidate.trim() : undefined;
}
