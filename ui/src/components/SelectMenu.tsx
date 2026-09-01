import { useEffect, useId, useRef, useState } from 'react';
import type { JSX, ReactNode } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import { createPortal } from 'react-dom';

export interface SelectMenuOption {
  value: string;
  label: ReactNode;
  disabled?: boolean;
}

interface SelectMenuProps {
  value: string;
  options: readonly SelectMenuOption[];
  onChange(value: string): void;
  ariaLabel?: string;
  disabled?: boolean;
  className?: string;
  popoverClassName?: string;
}

/** App-owned select popover so dropdowns look and behave consistently on every OS. */
export function SelectMenu({
  value,
  options,
  onChange,
  ariaLabel,
  disabled = false,
  className = '',
  popoverClassName = '',
}: SelectMenuProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ top: 0, left: 0, width: 180, above: false });
  const listId = useId();
  const selected = options.find((option) => option.value === value) ?? options[0];

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!rootRef.current?.contains(target) && !popoverRef.current?.contains(target))
        setOpen(false);
    };
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', keydown);
    const place = () => {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const estimatedHeight = Math.min(280, options.length * 38 + 10);
      const above =
        window.innerHeight - rect.bottom < estimatedHeight + 12 && rect.top > estimatedHeight;
      setPosition({
        top: above ? rect.top - 6 : rect.bottom + 6,
        left: Math.min(rect.left, window.innerWidth - Math.max(rect.width, 180) - 10),
        width: Math.max(rect.width, 180),
        above,
      });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', keydown);
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open, options.length]);

  const move = (direction: 1 | -1) => {
    const available = options.filter((option) => !option.disabled);
    const current = available.findIndex((option) => option.value === value);
    const next =
      available[(Math.max(0, current) + direction + available.length) % available.length];
    if (next) onChange(next.value);
  };

  return (
    <div ref={rootRef} className={`select-menu ${className}`.trim()}>
      <button
        ref={triggerRef}
        type="button"
        className="select-trigger"
        aria-label={ariaLabel}
        aria-controls={listId}
        aria-expanded={open}
        aria-haspopup="listbox"
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            move(event.key === 'ArrowDown' ? 1 : -1);
            setOpen(true);
          }
        }}
      >
        <span>{selected?.label ?? value}</span>
        <ChevronDown size={14} aria-hidden="true" />
      </button>
      {open &&
        createPortal(
          <div
            ref={popoverRef}
            id={listId}
            className={`select-popover custom-scrollbar ${popoverClassName}`.trim()}
            data-above={position.above || undefined}
            role="listbox"
            style={{
              top: position.top,
              left: position.left,
              width: position.width,
              transform: position.above ? 'translateY(-100%)' : undefined,
            }}
          >
            {options.map((option) => (
              <button
                type="button"
                role="option"
                aria-selected={option.value === value}
                disabled={option.disabled}
                key={option.value}
                onClick={() => {
                  onChange(option.value);
                  setOpen(false);
                }}
              >
                <span>{option.label}</span>
                {option.value === value && <Check size={14} aria-hidden="true" />}
              </button>
            ))}
          </div>,
          document.body,
        )}
    </div>
  );
}
