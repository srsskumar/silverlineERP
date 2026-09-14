'use client';

import * as React from 'react';

/**
 * A toolbar filter control: a compact chip that opens its controls in a
 * popover.
 *
 * The board previously laid every filter out inline — status, search, SLA,
 * advanced fields, and one checkbox per project label. With 25 labels that ran
 * to four wrapped rows and pushed the board itself below the fold, so the page
 * opened on its own filter form rather than on the work. Collapsed to chips,
 * the whole control set is one row and the board starts at the top.
 *
 * A chip carrying a value says so in its own label ("Status: In progress"), so
 * an active filter is still visible without opening anything — the reason the
 * inline layout was worth something in the first place.
 */
export function FilterChip({
  label,
  value,
  onClear,
  children,
}: {
  label: string;
  /** Summary of the current selection. Absent means "no filter applied". */
  value?: string | null;
  onClear?: () => void;
  children: React.ReactNode;
}) {
  const [open, setOpen] = React.useState(false);
  const rootRef = React.useRef<HTMLDivElement | null>(null);
  const active = Boolean(value);

  // Dismiss on outside click and on Escape — a popover that can only be closed
  // by clicking its own trigger again is a trap when several are on one row.
  React.useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative">
      <div
        className={`flex items-center rounded-md border text-xs transition-colors ${
          active
            ? 'border-primary/40 bg-primary-subtle text-primary'
            : 'border-border bg-surface text-text-muted hover:border-border-strong hover:text-text'
        }`}
      >
        <button
          type="button"
          aria-expanded={open}
          aria-haspopup="dialog"
          onClick={() => setOpen((v) => !v)}
          className="flex items-center gap-1.5 px-2.5 py-1.5 font-medium"
        >
          <span>{label}</span>
          {active ? <span className="max-w-40 truncate font-normal opacity-80">{value}</span> : null}
          <svg aria-hidden="true" viewBox="0 0 12 12" className="h-2.5 w-2.5 opacity-60">
            <path d="M2 4.5 6 8.5 10 4.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        {active && onClear ? (
          <button
            type="button"
            aria-label={`Clear ${label} filter`}
            onClick={() => {
              onClear();
              setOpen(false);
            }}
            className="-ml-0.5 rounded-r-md px-1.5 py-1.5 opacity-70 hover:opacity-100"
          >
            <svg aria-hidden="true" viewBox="0 0 12 12" className="h-2.5 w-2.5">
              <path d="M3 3l6 6M9 3l-6 6" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </button>
        ) : null}
      </div>
      {open ? (
        <div
          role="dialog"
          aria-label={label}
          className="absolute left-0 top-full z-30 mt-1.5 min-w-56 max-w-80 rounded-lg border border-border bg-overlay p-3 shadow-lg"
        >
          {children}
        </div>
      ) : null}
    </div>
  );
}

/** Chip-row segmented control — the board/list view switch. */
export function SegmentedControl<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: { value: T; label: string; icon?: React.ReactNode }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div role="group" aria-label={label} className="flex items-center gap-0.5 rounded-md border border-border bg-surface-sunken p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={value === o.value}
          title={o.label}
          onClick={() => onChange(o.value)}
          className={`flex items-center gap-1.5 rounded px-2 py-1 text-xs font-medium transition-colors ${
            value === o.value
              ? 'bg-surface text-text shadow-sm'
              : 'text-text-subtle hover:text-text'
          }`}
        >
          {o.icon}
          <span>{o.label}</span>
        </button>
      ))}
    </div>
  );
}

/** A plain on/off chip, for toggles that need no popover (e.g. "Hide done"). */
export function ToggleChip({
  label,
  pressed,
  onChange,
}: {
  label: string;
  pressed: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={() => onChange(!pressed)}
      className={`rounded-md border px-2.5 py-1.5 text-xs font-medium transition-colors ${
        pressed
          ? 'border-primary/40 bg-primary-subtle text-primary'
          : 'border-border bg-surface text-text-muted hover:border-border-strong hover:text-text'
      }`}
    >
      {label}
    </button>
  );
}
