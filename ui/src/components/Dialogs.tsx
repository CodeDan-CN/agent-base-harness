import { useCallback, useEffect, useRef, useState } from 'react';
import type { JSX } from 'react';
import { AlertTriangle, Loader2, X } from 'lucide-react';

interface ConfirmOptions {
  title: string;
  description: string;
  confirmLabel?: string;
  tone?: 'default' | 'warning' | 'danger';
  acknowledgementLabel?: string;
}

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = '确认',
  tone = 'default',
  acknowledgementLabel,
  busy = false,
  onCancel,
  onConfirm,
}: ConfirmOptions & {
  open: boolean;
  busy?: boolean;
  onCancel(): void;
  onConfirm(): void;
}): JSX.Element | null {
  const confirmRef = useRef<HTMLButtonElement>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  useEffect(() => {
    if (!open) return;
    setAcknowledged(false);
    if (!acknowledgementLabel) confirmRef.current?.focus();
    const close = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) onCancel();
    };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [acknowledgementLabel, busy, onCancel, open]);
  if (!open) return null;
  return (
    <div
      className="dialog-backdrop"
      onMouseDown={(event) => event.target === event.currentTarget && !busy && onCancel()}
    >
      <section
        className={`app-dialog confirm-dialog ${tone}`}
        role="alertdialog"
        aria-modal="true"
      >
        <div className={`dialog-symbol ${tone}`}>
          <AlertTriangle size={18} />
        </div>
        <div className="app-dialog-copy">
          <h2>{title}</h2>
          <p>{description}</p>
        </div>
        {acknowledgementLabel && (
          <label className="dialog-acknowledgement">
            <input
              type="checkbox"
              checked={acknowledged}
              disabled={busy}
              onChange={(event) => setAcknowledged(event.target.checked)}
            />
            <span>{acknowledgementLabel}</span>
          </label>
        )}
        <button
          className="dialog-close icon-button"
          disabled={busy}
          onClick={onCancel}
          aria-label="关闭"
        >
          <X size={16} />
        </button>
        <div className="app-dialog-actions">
          <button className="secondary-button" disabled={busy} onClick={onCancel}>
            取消
          </button>
          <button
            ref={confirmRef}
            className={tone === 'danger' ? 'danger-button' : 'dark-button'}
            disabled={busy || (Boolean(acknowledgementLabel) && !acknowledged)}
            onClick={onConfirm}
          >
            {busy && <Loader2 className="spin" size={14} />}
            {confirmLabel}
          </button>
        </div>
      </section>
    </div>
  );
}

export function useConfirmDialog(): {
  confirm(options: ConfirmOptions): Promise<boolean>;
  dialog: JSX.Element | null;
} {
  const resolver = useRef<((confirmed: boolean) => void) | null>(null);
  const [options, setOptions] = useState<ConfirmOptions | null>(null);
  const settle = useCallback((confirmed: boolean) => {
    resolver.current?.(confirmed);
    resolver.current = null;
    setOptions(null);
  }, []);
  const confirm = useCallback((next: ConfirmOptions) => {
    resolver.current?.(false);
    setOptions(next);
    return new Promise<boolean>((resolve) => {
      resolver.current = resolve;
    });
  }, []);
  return {
    confirm,
    dialog: options ? (
      <ConfirmDialog
        open
        {...options}
        onCancel={() => settle(false)}
        onConfirm={() => settle(true)}
      />
    ) : null,
  };
}

export function TextPromptDialog({
  open,
  title,
  description,
  value,
  label,
  confirmLabel = '保存',
  maxLength = 2000,
  multiline = false,
  onChange,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  title: string;
  description: string;
  value: string;
  label: string;
  confirmLabel?: string;
  maxLength?: number;
  multiline?: boolean;
  onChange(value: string): void;
  onCancel(): void;
  onConfirm(): void;
}): JSX.Element | null {
  const inputRef = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    inputRef.current?.select();
    const close = (event: KeyboardEvent) => event.key === 'Escape' && onCancel();
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [onCancel, open]);
  if (!open) return null;
  const valid = value.trim().length > 0 && value.trim().length <= maxLength;
  return (
    <div
      className="dialog-backdrop"
      onMouseDown={(event) => event.target === event.currentTarget && onCancel()}
    >
      <form
        className="app-dialog prompt-dialog"
        role="dialog"
        aria-modal="true"
        onSubmit={(event) => {
          event.preventDefault();
          if (valid) onConfirm();
        }}
      >
        <div className="app-dialog-copy">
          <h2>{title}</h2>
          <p>{description}</p>
        </div>
        <button
          type="button"
          className="dialog-close icon-button"
          onClick={onCancel}
          aria-label="关闭"
        >
          <X size={16} />
        </button>
        <label className="prompt-field">
          <span>{label}</span>
          {multiline ? (
            <textarea
              ref={inputRef}
              value={value}
              maxLength={maxLength}
              rows={5}
              onChange={(event) => onChange(event.target.value)}
            />
          ) : (
            <input
              ref={inputRef}
              value={value}
              maxLength={maxLength}
              onChange={(event) => onChange(event.target.value)}
            />
          )}
          <small>
            {value.trim().length}/{maxLength}
          </small>
        </label>
        <div className="app-dialog-actions">
          <button type="button" className="secondary-button" onClick={onCancel}>
            取消
          </button>
          <button type="submit" className="dark-button" disabled={!valid}>
            {confirmLabel}
          </button>
        </div>
      </form>
    </div>
  );
}
