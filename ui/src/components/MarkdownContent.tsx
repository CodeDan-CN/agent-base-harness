import { useEffect, useRef, useState } from 'react';
import type { JSX } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { basename, resolveProducedFileMention } from '../produced-files';

interface MarkdownContentProps {
  content: string;
  className?: string;
  sessionId?: string | null;
  producedFiles?: readonly string[];
  streaming?: boolean;
  streamKey?: string;
  onOpenError?(message: string): void;
}

interface StreamingFrameCacheEntry {
  visible: string;
  touchedAt: number;
}

const STREAM_FRAME_INTERVAL_MS = 32;
const STREAM_FRAME_CACHE_TTL_MS = 60_000;
const STREAM_FRAME_CACHE_LIMIT = 32;
const streamingFrameCache = new Map<string, StreamingFrameCacheEntry>();

/** Markdown 禁用原始 HTML、本地链接与本地图片；文件入口只来自结构化产出位置。 */
export function MarkdownContent({
  content,
  className = '',
  sessionId,
  producedFiles = [],
  streaming = false,
  streamKey,
  onOpenError,
}: MarkdownContentProps): JSX.Element {
  const renderedContent = useStreamingFrame(content, streaming, streamKey);
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
                title={basename(target)}
                aria-label={`打开文件 ${basename(target)}`}
                onClick={() => openFile(target)}
              >
                <code>{basename(target)}</code>
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

/** Smooths provider bursts while letting slow streams paint without an artificial typing delay. */
function useStreamingFrame(content: string, streaming: boolean, streamKey?: string): string {
  const [visible, setVisible] = useState(() =>
    initialStreamingFrame(content, streaming, streamKey),
  );
  const latest = useRef(content);
  const stillStreaming = useRef(streaming);
  const visibleRef = useRef(visible);
  const frame = useRef<number | null>(null);
  const lastPaintAt = useRef(0);
  latest.current = content;
  stillStreaming.current = streaming;
  visibleRef.current = visible;

  useEffect(() => {
    if (!content.startsWith(visibleRef.current)) {
      visibleRef.current = content;
      setVisible(content);
      if (streamKey) streamingFrameCache.delete(streamKey);
      return;
    }
    if (visibleRef.current === content) {
      if (!streaming && streamKey) streamingFrameCache.delete(streamKey);
      return;
    }
    if (frame.current !== null) return;

    const paint = (now: number) => {
      if (lastPaintAt.current > 0 && now - lastPaintAt.current < STREAM_FRAME_INTERVAL_MS) {
        frame.current = requestAnimationFrame(paint);
        return;
      }
      lastPaintAt.current = now;
      const target = latest.current;
      const current = visibleRef.current;
      if (!target.startsWith(current)) {
        visibleRef.current = target;
        setVisible(target);
      } else if (current.length < target.length) {
        const next = target.slice(0, nextStreamingEnd(target, current.length));
        visibleRef.current = next;
        setVisible(next);
        if (streamKey) {
          streamingFrameCache.set(streamKey, { visible: next, touchedAt: Date.now() });
        }
      }

      if (visibleRef.current.length < latest.current.length) {
        frame.current = requestAnimationFrame(paint);
      } else {
        frame.current = null;
        lastPaintAt.current = 0;
        if (!stillStreaming.current && streamKey) streamingFrameCache.delete(streamKey);
      }
    };
    frame.current = requestAnimationFrame(paint);
  }, [content, streaming, streamKey]);

  useEffect(() => {
    return () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = null;
    };
  }, []);
  return visible;
}

function initialStreamingFrame(content: string, streaming: boolean, streamKey?: string): string {
  pruneStreamingFrameCache();
  const cached = streamKey ? streamingFrameCache.get(streamKey) : undefined;
  if (cached && content.startsWith(cached.visible)) return cached.visible;
  if (streamKey && streaming) {
    streamingFrameCache.set(streamKey, { visible: '', touchedAt: Date.now() });
  }
  return streaming ? '' : content;
}

function nextStreamingEnd(content: string, visibleLength: number): number {
  const backlog = content.length - visibleLength;
  const revealCount =
    backlog <= 4
      ? backlog
      : backlog <= 16
        ? Math.min(4, backlog)
        : Math.min(64, Math.max(4, Math.ceil(backlog / 10)));
  let end = Math.min(content.length, visibleLength + revealCount);
  const previousCodeUnit = content.charCodeAt(end - 1);
  if (previousCodeUnit >= 0xd800 && previousCodeUnit <= 0xdbff && end < content.length) end += 1;
  if (content[end - 1] === '\r' && content[end] === '\n') end += 1;
  return end;
}

function pruneStreamingFrameCache(): void {
  const now = Date.now();
  for (const [key, entry] of streamingFrameCache) {
    if (now - entry.touchedAt > STREAM_FRAME_CACHE_TTL_MS) streamingFrameCache.delete(key);
  }
  while (streamingFrameCache.size >= STREAM_FRAME_CACHE_LIMIT) {
    const oldest = streamingFrameCache.keys().next().value as string | undefined;
    if (!oldest) break;
    streamingFrameCache.delete(oldest);
  }
}

function isExternalLink(href: string | undefined): boolean {
  return href?.startsWith('mailto:') === true || isHttpUrl(href);
}

function isHttpUrl(value: string | undefined): value is string {
  return typeof value === 'string' && /^https?:\/\//i.test(value);
}
