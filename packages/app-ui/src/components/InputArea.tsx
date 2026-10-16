import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent, JSX } from 'react';
import {
  ArrowUp,
  Check,
  ChevronDown,
  CircleAlert,
  Edit3,
  Loader2,
  Paperclip,
  Shield,
  Sparkles,
  Square,
  X,
  Zap,
} from 'lucide-react';
import type { InboxItem, ModelManagementSnapshot, PermissionPreset } from '@client-contracts';
import { shouldSubmitComposerOnKeyDown, type AttachComposerFiles } from '../composer-input-policy';
import { permissionLabel, permissionOptions } from '../permission-presets';
import { ContextTokenRing, formatCompactToken, formatOptionalToken } from './ContextTokenRing';

interface InputAreaProps {
  mobile?: boolean;
  draftKey: string;
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
  onAttachFiles?: AttachComposerFiles;
  onStop(): void;
  onRemove(item: InboxItem): void;
  onReplace(item: InboxItem): void;
  onPromote(item: InboxItem): void;
  onPermissionPresetChange(preset: PermissionPreset): void;
  onModelChange(modelId: string): void;
  onThinkingChange(
    mode: 'auto' | 'enabled' | 'disabled',
    effort: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | null,
  ): Promise<boolean>;
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
const QUEUE_PANEL_REVEAL_DELAY_MS = 80;
const REASONING_EFFORT_LABELS = {
  minimal: '极简',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '超高',
  max: '最高',
} as const;

export function InputArea(props: InputAreaProps): JSX.Element {
  const [text, setText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const [uploading, setUploading] = useState(false);
  const uploadingRef = useRef(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [permissionOpen, setPermissionOpen] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  const [thinkingBusy, setThinkingBusy] = useState(false);
  const [queuePanelVisible, setQueuePanelVisible] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const permissionRef = useRef<HTMLDivElement>(null);
  const composingRef = useRef(false);
  const draftCacheRef = useRef(new Map<string, string>());
  const activeDraftKeyRef = useRef(props.draftKey);
  const hasQueuedItems = props.queue.length > 0;
  const activeModel = props.models.find((model) => model.id === props.modelId) ?? null;
  const supportsThinking = Boolean(activeModel?.supportedReasoningEfforts.length);
  const thinkingLabel =
    activeModel?.thinkingMode === 'disabled'
      ? '关闭'
      : activeModel?.thinkingMode === 'enabled' && activeModel.reasoningEffort
        ? REASONING_EFFORT_LABELS[activeModel.reasoningEffort]
        : '自动';

  useEffect(() => {
    if (activeDraftKeyRef.current === props.draftKey) return;
    activeDraftKeyRef.current = props.draftKey;
    setText(draftCacheRef.current.get(props.draftKey) ?? '');
  }, [props.draftKey]);

  useEffect(() => {
    const target = textareaRef.current;
    if (!target) return;
    target.style.height = 'auto';
    target.style.height = `${Math.max(
      props.mobile ? 28 : 76,
      Math.min(target.scrollHeight, COMPOSER_TEXTAREA_MAX_HEIGHT),
    )}px`;
  }, [text, props.mobile]);

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

  useEffect(() => {
    if (!hasQueuedItems) {
      setQueuePanelVisible(false);
      return;
    }
    const timer = window.setTimeout(() => setQueuePanelVisible(true), QUEUE_PANEL_REVEAL_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [hasQueuedItems]);

  const submit = async (mode: 'queue' | 'steer') => {
    const content = text.trim();
    if (!content || props.disabled || submittingRef.current || uploadingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    const submittedDraftKey = activeDraftKeyRef.current;
    try {
      const sent = await props.onSend(content, mode);
      if (sent) {
        draftCacheRef.current.delete(submittedDraftKey);
        if (activeDraftKeyRef.current === submittedDraftKey) setText('');
      } else if (activeDraftKeyRef.current !== submittedDraftKey) {
        draftCacheRef.current.set(activeDraftKeyRef.current, content);
        setText(content);
      }
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  const attachFiles = async (files: File[]) => {
    if (!files.length || !props.onAttachFiles || uploadingRef.current || submittingRef.current)
      return;
    const sourceDraftKey = activeDraftKeyRef.current;
    const sourceText = text;
    uploadingRef.current = true;
    setUploading(true);
    try {
      const result = await props.onAttachFiles(files, sourceText);
      if (!result) return;
      const nextText = [sourceText, ...result.paths.map((target) => JSON.stringify(target))]
        .filter(Boolean)
        .join('\n');
      if (result.draftKey !== sourceDraftKey) draftCacheRef.current.delete(sourceDraftKey);
      draftCacheRef.current.set(result.draftKey, nextText);
      if (activeDraftKeyRef.current === result.draftKey) {
        setText(nextText);
      }
    } finally {
      uploadingRef.current = false;
      setUploading(false);
    }
  };

  const keyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (props.mobile) return;
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
      {hasQueuedItems && queuePanelVisible && (
        <section className="queue-panel" aria-label="输入队列">
          <div className="queue-title">
            <span>输入队列 ({props.queue.length})</span>
            <span className="queue-processing">
              {props.processing ? '排队处理中...' : '等待开始...'}
            </span>
          </div>
          <div className="queue-list custom-scrollbar">
            {props.queue.map((item, index) => (
              <div
                className={`queue-item ${item.scope === 'next-step' ? 'promoted' : ''}`}
                key={item.id}
              >
                <span className="queue-index">{index + 1}</span>
                <p title={item.content}>“{item.content}”</p>
                {!props.processing ? (
                  <span className="queue-waiting">等待运行资源</span>
                ) : item.scope === 'next-step' ? (
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

      <div className={`composer${props.mobile && props.processing ? ' mobile-processing' : ''}`}>
        <textarea
          rows={props.mobile ? 1 : undefined}
          ref={textareaRef}
          value={text}
          disabled={props.disabled || uploading}
          onChange={(event) => {
            const value = event.target.value;
            draftCacheRef.current.set(props.draftKey, value);
            setText(value);
          }}
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
          {!props.mobile && (
            <>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                hidden
                aria-label="选择会话文件"
                onChange={(event) => {
                  const files = Array.from(event.target.files ?? []);
                  event.target.value = '';
                  void attachFiles(files);
                }}
              />
              <button
                className="icon-button"
                type="button"
                disabled={props.disabled || submitting || uploading || !props.onAttachFiles}
                title={uploading ? '正在上传文件…' : '添加文件（每个不超过 20 MB，暂不支持图片）'}
                aria-label={uploading ? '正在上传文件' : '添加文件'}
                onClick={() => fileInputRef.current?.click()}
              >
                {uploading ? <Loader2 className="spin" size={19} /> : <Paperclip size={19} />}
              </button>
            </>
          )}
          {!props.mobile && (
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
          )}
          {props.processing && (
            <button className="icon-button stop" onClick={props.onStop} title="停止处理">
              <Square size={15} fill="currentColor" />
            </button>
          )}
          {props.processing && text.trim() && (
            <button
              className="steer-button"
              disabled={submitting || uploading}
              onClick={() => void submit('steer')}
              title="下一步补充当前任务"
            >
              <Zap size={13} /> 补充当前任务
            </button>
          )}
          {!props.mobile && (
            <div className="model-picker composer-model-picker">
              <button
                className={['model-trigger', modelOpen ? 'active' : ''].filter(Boolean).join(' ')}
                type="button"
                aria-haspopup="dialog"
                aria-expanded={modelOpen}
                disabled={props.processing || props.disabled}
                onClick={() => {
                  setPermissionOpen(false);
                  setModelOpen((open) => !open);
                }}
              >
                <Sparkles size={14} />
                <span className="model-trigger-name">{props.modelLabel}</span>
                {supportsThinking && <span className="model-thinking-label">{thinkingLabel}</span>}
                <ChevronDown className="model-trigger-chevron" size={13} />
              </button>
              {modelOpen && (
                <div className="model-popover" role="dialog" aria-label="模型与思考程度">
                  <div className="model-popover-heading">选择模型</div>
                  {props.models.length === 0 ? (
                    <p>请先在模型配置中添加可用模型。</p>
                  ) : (
                    props.models
                      .filter((model) => model.status === 'enabled')
                      .map((model) => (
                        <button
                          type="button"
                          role="radio"
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
                  {activeModel && supportsThinking && (
                    <div className="thinking-picker-section">
                      <div className="model-popover-heading">思考程度</div>
                      <div className="thinking-options" role="radiogroup" aria-label="思考程度">
                        {[
                          { mode: 'auto' as const, effort: null, label: '自动' },
                          { mode: 'disabled' as const, effort: null, label: '关闭' },
                          ...activeModel.supportedReasoningEfforts.map((effort) => ({
                            mode: 'enabled' as const,
                            effort,
                            label: REASONING_EFFORT_LABELS[effort],
                          })),
                        ].map((option) => {
                          const selected =
                            activeModel.thinkingMode === option.mode &&
                            (option.mode !== 'enabled' ||
                              activeModel.reasoningEffort === option.effort);
                          return (
                            <button
                              type="button"
                              role="radio"
                              aria-checked={selected}
                              className={selected ? 'selected' : ''}
                              disabled={thinkingBusy}
                              key={`${option.mode}-${option.effort ?? 'default'}`}
                              onClick={() => {
                                setThinkingBusy(true);
                                void props
                                  .onThinkingChange(option.mode, option.effort)
                                  .then((saved) => {
                                    if (saved) setModelOpen(false);
                                  })
                                  .finally(() => setThinkingBusy(false));
                              }}
                            >
                              {option.label}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
          {!props.mobile && <SessionContextTokenIndicator stats={props.contextStats} />}
          <button
            className="send-button"
            disabled={!text.trim() || props.disabled || submitting || uploading}
            onClick={() => void submit('queue')}
            aria-label={props.processing ? '加入队列' : '发送'}
            title={props.processing ? '加入队列' : '发送'}
          >
            <ArrowUp size={14} />
          </button>
        </div>
      </div>
      {!props.mobile && <p className="composer-hint">Enter 发送 · Shift + Enter 换行</p>}
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
