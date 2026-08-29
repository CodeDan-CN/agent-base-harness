import type { JSX } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { resolveProducedFileMention } from '../produced-files';

interface MarkdownContentProps {
  content: string;
  className?: string;
  sessionId?: string | null;
  producedFiles?: readonly string[];
}

/** Markdown 禁用原始 HTML、本地链接与本地图片；文件入口只来自结构化产出位置。 */
export function MarkdownContent({
  content,
  className = '',
  sessionId,
  producedFiles = [],
}: MarkdownContentProps): JSX.Element {
  const openFile = (target: string): void => {
    if (!sessionId) return;
    const client = window.agentClient;
    if (!client) return;
    void client.openSessionFile(sessionId, target).then((result) => {
      if (!result.ok) window.alert(result.error.message || '无法打开文件');
    });
  };
  return (
    <div className={`markdown-content ${className}`.trim()}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        components={{
          a({ href, children, title }) {
            if (!isExternalLink(href)) return <>{children}</>;
            return (
              <a href={href} title={title} target="_blank" rel="noreferrer">
                {children}
              </a>
            );
          },
          code({ className: codeClassName, children }) {
            const value = String(children).replace(/\n$/, '');
            const target = codeClassName
              ? undefined
              : resolveProducedFileMention(producedFiles, value);
            if (!target || !sessionId) return <code className={codeClassName}>{children}</code>;
            return (
              <button
                type="button"
                className="markdown-file-mention"
                title={target}
                aria-label={`打开文件 ${target}`}
                onClick={() => openFile(target)}
              >
                <code>{children}</code>
              </button>
            );
          },
          img({ src, alt }) {
            return isHttpUrl(src) ? (
              <img src={src} alt={alt ?? ''} referrerPolicy="no-referrer" />
            ) : (
              <>{alt}</>
            );
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

function isExternalLink(href: string | undefined): boolean {
  return href?.startsWith('mailto:') === true || isHttpUrl(href);
}

function isHttpUrl(value: string | undefined): value is string {
  return typeof value === 'string' && /^https?:\/\//i.test(value);
}
