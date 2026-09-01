import { useEffect, useRef, useState } from 'react';
import type { CSSProperties, JSX, ReactNode } from 'react';

interface ContextTokenRingProps {
  name: string;
  used: number | null;
  budget: number | null;
  compressed: boolean;
  popoverLabel: string;
  children: ReactNode;
}

export function ContextTokenRing(props: ContextTokenRingProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const ratio =
    props.used !== null && props.budget && props.budget > 0
      ? Math.min(1, props.used / props.budget)
      : 0;
  const percent = Math.round(ratio * 100);
  const pressure = ratio >= 0.9 ? 'critical' : ratio >= 0.72 ? 'near' : 'safe';
  const className = [
    'context-token-indicator',
    pressure,
    props.compressed ? 'compressed' : '',
    props.used === null || !props.budget ? 'unknown' : '',
  ]
    .filter(Boolean)
    .join(' ');
  const style = { '--context-percent': `${percent}%` } as CSSProperties;
  const value = props.used === null ? '尚未测量' : formatCompactToken(props.used);
  const limit = props.budget ? formatCompactToken(props.budget) : '未知';

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: globalThis.KeyboardEvent) => event.key === 'Escape' && setOpen(false);
    window.addEventListener('pointerdown', close);
    window.addEventListener('keydown', escape);
    return () => {
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('keydown', escape);
    };
  }, [open]);

  return (
    <div className="context-token-wrap" ref={containerRef}>
      <button
        type="button"
        className={className}
        style={style}
        aria-label={`${props.name} ${value} / ${limit} Token${props.compressed ? '，已压缩' : ''}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      />
      {open && (
        <section className="context-token-popover" role="dialog" aria-label={props.popoverLabel}>
          {props.children}
        </section>
      )}
    </div>
  );
}

export function formatCompactToken(value: number): string {
  if (value >= 1_000_000) return `${trimTokenDecimal(value / 1_000_000)}M`;
  if (value >= 1_000) return `${trimTokenDecimal(value / 1_000)}K`;
  return String(Math.max(0, Math.round(value)));
}

export function formatOptionalToken(value: number | null): string {
  return value === null ? '—' : formatCompactToken(value);
}

function trimTokenDecimal(value: number): string {
  return value >= 100 ? value.toFixed(0) : value >= 10 ? value.toFixed(1) : value.toFixed(2);
}
