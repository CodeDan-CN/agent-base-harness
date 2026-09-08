import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent, JSX } from 'react';
import {
  ArrowUp,
  Check,
  CircleAlert,
  Edit3,
  Paperclip,
  Shield,
  Sparkles,
  Square,
  X,
  Zap,
} from 'lucide-react';
import type { InboxItem, ModelManagementSnapshot, PermissionPreset } from '@client-contracts';
import { shouldSubmitComposerOnKeyDown } from '../composer-input-policy';
import { ContextTokenRing, formatCompactToken, formatOptionalToken } from './ContextTokenRing';

interface InputAreaProps {
  processing: boolean;
  disabled: boolean;
  queue: InboxItem[];
  busyActionId: string | null;
  modelId: string | null;
  modelLabel: string;
  models: ModelManagementSnapshot['models'];
  permissionPreset: PermissionPreset;
  contextStats: ContextTokenStats | null;
  onSend(text: string, mode: 'queue' | 'steer'): Promise<boolean>;
  onStop(): void;
  onRemove(item: InboxItem): void;
  onReplace(item: InboxItem): void;
  onPromote(item: InboxItem): void;
  onPermissionPresetChange(preset: PermissionPreset): void;
  onModelChange(modelId: string): void;
}

interface ContextTokenStats {
  estimatedInputTokens: number;
  budgetTokens: number | null;
  exact: boolean;
  historyTokens: number | null;
  cumulativeInputTokens: number;
  cumulativeOutputTokens: number;
  memoryCompactionCount: number;
}

const COMPOSER_TEXTAREA_MAX_HEIGHT = 176;

export function InputArea(props: InputAreaProps): JSX.Element {
  const [text, setText] = useState('');
  const [permissionOpen, setPermissionOpen] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const permissionRef = useRef<HTMLDivElement>(null);
  const composingRef = useRef(false);

  useEffect(() => {
    const target = textareaRef.current;
    if (!target) return;
    target.style.height = 'auto';
    target.style.height = `${Math.max(
      76,
      Math.min(target.scrollHeight, COMPOSER_TEXTAREA_MAX_HEIGHT),
    )}px`;
  }, [text]);

  useEffect(() => {
    if (!permissionOpen && !modelOpen) return;
    const close = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!permissionRef.current?.contains(target)) setPermissionOpen(false);
      if (!(target instanceof Element) || !target.closest('.model-picker')) setModelOpen(false);
    };
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        setPermissionOpen(false);
        setModelOpen(false);
      }
    };
    window.addEventListener('pointerdown', close);
    window.addEventListener('keydown', escape);
    return () => {
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('keydown', escape);
    };
  }, [permissionOpen, modelOpen]);

  const submit = async (mode: 'queue' | 'steer') => {
    const content = text.trim();
    if (!content || props.disabled) return;
    if (await props.onSend(content, mode)) setText('');
  };

  const keyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (
      shouldSubmitComposerOnKeyDown({
        key: event.key,
        shiftKey: event.shiftKey,
        isComposing: composingRef.current || event.nativeEvent.isComposing,
        keyCode: event.nativeEvent.keyCode,
      })
    ) {
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
          onCompositionStart={() => {
            composingRef.current = true;
          }}
          onCompositionEnd={() => {
            composingRef.current = false;
          }}
          onKeyDown={keyDown}
          placeholder={props.processing ? '补充问题或加入队列...' : '给 AI 助手发送消息...'}
          aria-label="消息输入"
        />
        <div className="composer-actions">
          <button className="icon-button" disabled title="附件将在受控导入功能启用后开放">
            <Paperclip size={19} />
          </button>
          <div className="permission-picker" ref={permissionRef}>
            <button
              className={['permission-trigger', permissionOpen ? 'active' : '']
                .filter(Boolean)
                .join(' ')}
              type="button"
              aria-haspopup="menu"
              aria-expanded={permissionOpen}
              onClick={() => setPermissionOpen((open) => !open)}
            >
              <Shield size={14} />
              {permissionLabel(props.permissionPreset)}
            </button>
            {permissionOpen && (
              <div className="permission-popover" role="menu">
                {permissionOptions.map((option) => (
                  <button
                    type="button"
                    role="menuitemradio"
                    aria-checked={props.permissionPreset === option.value}
                    aria-describedby={`permission-rule-${option.value}`}
                    disabled={props.processing}
                    key={option.value}
                    onClick={() => {
                      props.onPermissionPresetChange(option.value);
                      setPermissionOpen(false);
                    }}
                  >
                    <span className="permission-option-copy">
                      <span className="permission-option-heading">
                        <strong>{option.label}</strong>
                        <span className="permission-rule-info" aria-hidden="true">
                          <CircleAlert size={12} />
                        </span>
                        <span
                          className="permission-rule-tooltip"
                          id={`permission-rule-${option.value}`}
                          role="tooltip"
                        >
                          {option.rules.map((rule) => (
                            <span key={rule}>{rule}</span>
                          ))}
                        </span>
                      </span>
                      <small>{option.description}</small>
                    </span>
                    {props.permissionPreset === option.value && <Check size={14} />}
                  </button>
                ))}
                {props.processing && <p>停止当前任务后可切换访问范围。</p>}
              </div>
            )}
          </div>
          <div className="model-picker">
            <button
              className={['model-trigger', modelOpen ? 'active' : ''].filter(Boolean).join(' ')}
              type="button"
              aria-haspopup="menu"
              aria-expanded={modelOpen}
              disabled={props.processing}
              onClick={() => {
                setPermissionOpen(false);
                setModelOpen((open) => !open);
              }}
            >
              <Sparkles size={14} />
              <span>{props.modelLabel}</span>
            </button>
            {modelOpen && (
              <div className="model-popover" role="menu">
                {props.models.length === 0 ? (
                  <p>请先在模型配置中添加可用模型。</p>
                ) : (
                  props.models
                    .filter((model) => model.status === 'enabled')
                    .map((model) => (
                      <button
                        type="button"
                        role="menuitemradio"
                        aria-checked={props.modelId === model.id}
                        key={model.id}
                        onClick={() => {
                          props.onModelChange(model.id);
                          setModelOpen(false);
                        }}
                      >
                        <span>
                          <strong>{model.displayName}</strong>
                          <small>{model.remoteModelId}</small>
                        </span>
                        {props.modelId === model.id && <Check size={14} />}
                      </button>
                    ))
                )}
              </div>
            )}
          </div>
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
          <SessionContextTokenIndicator stats={props.contextStats} />
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

function SessionContextTokenIndicator({ stats }: { stats: ContextTokenStats | null }): JSX.Element {
  const budget = stats?.budgetTokens ?? null;
  const used = stats?.estimatedInputTokens ?? 0;
  const memoryCompressed = Boolean(stats && stats.memoryCompactionCount > 0);

  return (
    <ContextTokenRing
      name="会话 QA 上下文"
      used={stats?.historyTokens ?? null}
      budget={budget}
      compressed={memoryCompressed}
      popoverLabel="会话 Token 统计"
    >
      <div className="context-token-title">
        <strong>会话 QA 上下文</strong>
        <span>{stats?.exact ? '实际测量' : '尚未请求'}</span>
      </div>
      <div className="context-token-value">
        <strong>{formatOptionalToken(stats?.historyTokens ?? null)}</strong>
        <span>/ {budget ? formatCompactToken(budget) : '未知'} Token</span>
      </div>
      <dl>
        <div>
          <dt>会话记忆压缩</dt>
          <dd>{memoryCompressed ? `已压缩 ${stats?.memoryCompactionCount ?? 0} 次` : '未压缩'}</dd>
        </div>
        <div>
          <dt>最近请求总上下文</dt>
          <dd>{formatCompactToken(used)}</dd>
        </div>
        <div>
          <dt>累计调用</dt>
          <dd>
            入 {formatCompactToken(stats?.cumulativeInputTokens ?? 0)} · 出{' '}
            {formatCompactToken(stats?.cumulativeOutputTokens ?? 0)}
          </dd>
        </div>
      </dl>
      {(!stats?.exact || stats.historyTokens === null) && (
        <p>下一次模型请求后显示精确的会话 QA 占用。</p>
      )}
    </ContextTokenRing>
  );
}

const permissionOptions: Array<{
  value: PermissionPreset;
  label: string;
  description: string;
  rules: string[];
}> = [
  {
    value: 'approval-required',
    label: '请求批准',
    description: '工作区自动读写；外部写入、联网和 MCP 默认询问',
    rules: [
      '模型直接回答与规划，缺少任务信息时会询问。',
      '工作区内读写自动执行。',
      '外部写入、联网和 MCP 调用前请求批准。',
    ],
  },
  {
    value: 'guarded',
    label: '受控自动',
    description: '低风险自动执行；高风险操作请求批准',
    rules: [
      '模型可采用低风险的合理默认值。',
      '低风险工具自动执行。',
      '高风险操作请求批准，缺少必要信息时会询问。',
    ],
  },
  {
    value: 'full-access',
    label: '完全访问',
    description: '模型自主选择合理默认值，仅在缺少必需事实时询问',
    rules: [
      '偏好、方案、格式和可逆选择由模型决定。',
      '仅缺少不可推断且任务必需的事实时询问。',
      '工具按当前系统用户权限执行，不再逐次批准。',
      '密码、验证码和 API Key 不通过普通问题框收集。',
    ],
  },
];

function permissionLabel(value: PermissionPreset): string {
  return permissionOptions.find((option) => option.value === value)?.label ?? '受控自动';
}
