import { useEffect, useRef } from 'react';
import { Archive, Edit3, LogOut, Plus, Server, X } from 'lucide-react';
import type { Session } from '@client-contracts';

export function MobileSidebar(props: {
  sessions: Session[];
  activeSessionId: string | null;
  onSelect(id: string): void;
  onNew(): void;
  onRename(session: Session): void;
  onArchive(session: Session): void;
  onClose(): void;
  onLogout(): void;
  onDisconnect?(): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const previous = document.activeElement;
    dialog.current?.showModal();
    return () => {
      if (previous instanceof HTMLElement) previous.focus();
    };
  }, []);
  return (
    <dialog
      ref={dialog}
      className="mobile-drawer"
      aria-label="会话列表"
      onCancel={props.onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) props.onClose();
      }}
    >
      <div className="mobile-drawer-body">
        <header>
          <strong>对话</strong>
          <button onClick={props.onClose} aria-label="关闭会话列表">
            <X size={22} />
          </button>
        </header>
        <button className="mobile-new" onClick={props.onNew}>
          <Plus size={20} /> 新建对话
        </button>
        <nav aria-label="历史会话">
          {props.sessions.length === 0 && <p className="mobile-muted">你的对话会显示在这里</p>}
          {props.sessions.map((session) => (
            <div
              key={session.id}
              className={`mobile-session${session.id === props.activeSessionId ? ' selected' : ''}`}
            >
              <button
                className="mobile-session-title"
                onClick={() => props.onSelect(session.id)}
                aria-current={session.id === props.activeSessionId ? 'page' : undefined}
              >
                {session.title}
              </button>
              <button
                aria-label={`重命名 ${session.title}`}
                onClick={() => {
                  props.onClose();
                  props.onRename(session);
                }}
              >
                <Edit3 size={17} />
              </button>
              <button
                aria-label={`归档 ${session.title}`}
                onClick={() => {
                  props.onClose();
                  props.onArchive(session);
                }}
              >
                <Archive size={17} />
              </button>
            </div>
          ))}
        </nav>
        <footer>
          <p>模型与工具请在 Web 或桌面端设置</p>
          {props.onDisconnect && (
            <button onClick={props.onDisconnect}>
              <Server size={18} /> 切换服务器
            </button>
          )}
          <button onClick={props.onLogout}>
            <LogOut size={18} /> 退出登录
          </button>
        </footer>
      </div>
    </dialog>
  );
}
