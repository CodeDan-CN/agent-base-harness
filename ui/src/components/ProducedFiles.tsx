import { FileText } from 'lucide-react';
import type { JSX } from 'react';
import { basename } from '../produced-files';

export function ProducedFiles({
  sessionId,
  paths,
  onOpenError,
}: {
  sessionId: string | null;
  paths: readonly string[];
  onOpenError?(message: string): void;
}): JSX.Element | null {
  if (!sessionId || paths.length === 0) return null;
  const open = (path: string): void => {
    const client = window.agentClient;
    if (!client) return;
    void client.openSessionFile(sessionId, path).then((result) => {
      if (!result.ok) onOpenError?.(result.error.message || '无法打开文件');
    });
  };
  return (
    <section className="produced-files" aria-label="产出文件">
      <div className="produced-files-list">
        {paths.map((path) => (
          <button key={path} type="button" title={path} onClick={() => open(path)}>
            <FileText size={14} aria-hidden="true" />
            <span>{basename(path)}</span>
          </button>
        ))}
      </div>
    </section>
  );
}
