import { useEffect, useRef, useState } from 'react';
import type { JSX } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { resolveProducedFileMention } from '../produced-files';

interface MarkdownContentProps {
  content: string;
  className?: string;
  sessionId?: string | null;
  producedFiles?: readonly string[];
  streaming?: boolean;
  onOpenError?(message: string): void;
}

/** Markdown 禁用原始 HTML、本地链接与本地图片；文件入口只来自结构化产出位置。 */
export function MarkdownContent({
  content,
  className = '',
  sessionId,
  producedFiles = [],
  streaming = false,
  onOpenError,
}: MarkdownContentProps): JSX.Element {
  const renderedContent = useStreamingFrame(content, streaming);
  const openFile = (target: string): void => {
    if (!sessionId) return;
    const client = window.agentClient;
    if (!client) return;
    void client.openSessionFile(sessionId, target).then((result) => {
      if (!result.ok) onOpenError?.(result.error.message || '无法打开文件');
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
        {renderedContent}
      </ReactMarkdown>
    </div>
  );
}

/** Coalesces token bursts into animation-sized frames so Markdown does not visibly reflow per chunk. */
function useStreamingFrame(content: string, streaming: boolean): string {
  const [visible, setVisible] = useState(content);
  const latest = useRef(content);
  const frame = useRef<number | null>(null);
  latest.current = content;
  useEffect(() => {
    if (!streaming) {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = null;
      setVisible(content);
      return;
    }
    if (frame.current !== null) return;
    let remaining = 3;
    const paint = () => {
      remaining -= 1;
      if (remaining > 0) {
        frame.current = requestAnimationFrame(paint);
        return;
      }
      frame.current = null;
      setVisible(latest.current);
    };
    frame.current = requestAnimationFrame(paint);
  }, [content, streaming]);
  useEffect(() => {
    return () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = null;
    };
  }, []);
  return visible;
}

function isExternalLink(href: string | undefined): boolean {
  return href?.startsWith('mailto:') === true || isHttpUrl(href);
}

function isHttpUrl(value: string | undefined): value is string {
  return typeof value === 'string' && /^https?:\/\//i.test(value);
}
