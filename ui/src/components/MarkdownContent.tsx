import type { JSX } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface MarkdownContentProps {
  content: string;
  className?: string;
}

/** Markdown 原始 HTML 默认禁用，链接继续使用 react-markdown 的安全 URL 转换。 */
export function MarkdownContent({ content, className = '' }: MarkdownContentProps): JSX.Element {
  return (
    <div className={`markdown-content ${className}`.trim()}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml>
        {content}
      </ReactMarkdown>
    </div>
  );
}
