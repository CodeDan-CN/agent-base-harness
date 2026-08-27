import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent, JSX } from 'react';
import { ArrowUp, Edit3, Paperclip, Square, X, Zap } from 'lucide-react';
import type { InboxItem } from '@client-contracts';

interface InputAreaProps {
  processing: boolean;
  disabled: boolean;
  queue: InboxItem[];
  busyActionId: string | null;
  onSend(text: string, mode: 'queue' | 'steer'): Promise<boolean>;
  onStop(): void;
  onRemove(item: InboxItem): void;
  onReplace(item: InboxItem): void;
  onPromote(item: InboxItem): void;
}

export function InputArea(props: InputAreaProps): JSX.Element {
  const [text, setText] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const target = textareaRef.current;
    if (!target) return;
    target.style.height = 'auto';
    target.style.height = `${Math.max(160, Math.min(target.scrollHeight, 360))}px`;
  }, [text]);

  const submit = async (mode: 'queue' | 'steer') => {
    const content = text.trim();
    if (!content || props.disabled) return;
    if (await props.onSend(content, mode)) setText('');
  };

  const keyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void submit('queue');
    }
  };

  return (
    <div className="input-wrap">
      {props.queue.length > 0 && (
        <section className="queue-panel" aria-label="输入队列">
          <div className="queue-title">
            <span>输入队列 ({props.queue.length})</span>
            {props.processing && <span className="queue-processing">排队处理中...</span>}
          </div>
          <div className="queue-list custom-scrollbar">
            {props.queue.map((item, index) => (
              <div
                className={`queue-item ${item.scope === 'next-step' ? 'promoted' : ''}`}
                key={item.id}
              >
                <span className="queue-index">{index + 1}</span>
                <p title={item.content}>“{item.content}”</p>
                {item.scope === 'next-step' ? (
                  <span className="promote-state">
                    <Zap size={12} /> 将在下一步介入
                  </span>
                ) : (
                  <button
                    className="queue-action"
                    disabled={!props.processing || props.busyActionId === item.id}
                    onClick={() => props.onPromote(item)}
                  >
                    立刻介入
                  </button>
                )}
                <button
                  className="queue-icon"
                  onClick={() => props.onReplace(item)}
                  aria-label="修改队列消息"
                >
                  <Edit3 size={13} />
                </button>
                <button
                  className="queue-icon danger"
                  onClick={() => props.onRemove(item)}
                  aria-label="移出队列"
                >
                  <X size={14} />
                </button>
              </div>
            ))}
          </div>
        </section>
      )}

      <div className="composer">
        <textarea
          ref={textareaRef}
          value={text}
          disabled={props.disabled}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={keyDown}
          placeholder={props.processing ? '补充问题或加入队列...' : '给 AI 助手发送消息...'}
          aria-label="消息输入"
        />
        <div className="composer-actions">
          <button className="icon-button" disabled title="附件将在受控导入功能启用后开放">
            <Paperclip size={19} />
          </button>
          {props.processing && (
            <button className="icon-button stop" onClick={props.onStop} title="停止处理">
              <Square size={15} fill="currentColor" />
            </button>
          )}
          {props.processing && text.trim() && (
            <button
              className="steer-button"
              onClick={() => void submit('steer')}
              title="下一步补充当前任务"
            >
              <Zap size={13} /> 补充当前任务
            </button>
          )}
          <button
            className="send-button"
            disabled={!text.trim() || props.disabled}
            onClick={() => void submit('queue')}
          >
            {props.processing ? '加入队列' : '发送'} <ArrowUp size={14} />
          </button>
        </div>
      </div>
      <p className="composer-hint">Enter 发送 · Shift + Enter 换行</p>
    </div>
  );
}
