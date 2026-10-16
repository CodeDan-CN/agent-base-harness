import { describe, expect, it } from 'vitest';
import { approvalDisplay } from '../../packages/app-ui/src/approval-presentation';

describe('工具审批展示', () => {
  it('不向用户展示 MCP 原始英文工具说明', () => {
    const display = approvalDisplay('mcp__web_search__web_search_exa', {
      title:
        'Search the web for any topic and get clean, ready-to-use content. Best for: Finding current information, news, facts, people, companies, or answering questions about any topic.',
      detail: 'web_search',
    });

    expect(display).toEqual({
      title: '联网搜索',
      detail: '将连接外部网络并执行搜索。',
      technicalDetail: false,
    });
  });

  it('展示已整理的搜索动作和关键参数', () => {
    expect(
      approvalDisplay('mcp__web_search__web_search_exa', {
        title: '联网搜索',
        detail: '搜索内容：Magnificent 7 最新新闻',
      }),
    ).toEqual({
      title: '联网搜索',
      detail: '搜索内容：Magnificent 7 最新新闻',
      technicalDetail: false,
    });
  });

  it('旧审批事件可从当前 Tool Call 参数补出搜索内容', () => {
    expect(
      approvalDisplay(
        'mcp__web_search__web_search_exa',
        {
          title:
            'Search the web for any topic and get clean, ready-to-use content. Best for: Finding current information and news.',
          detail: 'web_search',
        },
        { query: 'Magnificent 7 latest news', numResults: 8 },
      ),
    ).toEqual({
      title: '联网搜索',
      detail: '搜索内容：Magnificent 7 latest news',
      technicalDetail: false,
    });
  });

  it('文件路径和命令保持技术格式', () => {
    expect(
      approvalDisplay('write', { title: '写入文件', path: '/tmp/report.md' }),
    ).toEqual({
      title: '写入文件',
      detail: '/tmp/report.md',
      technicalDetail: true,
    });
  });
});
