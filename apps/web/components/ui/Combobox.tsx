'use client';

import * as React from 'react';
import { cn } from '@/lib/cn';
import { Button } from './Button';

export interface ComboOption {
  id: string;
  label: string;
  /** Shown faintly after the label — an employee number, a code. */
  hint?: string;
}

/**
 * A picker you can type into.
 *
 * A plain `<select>` is fine for five options and unusable for two hundred:
 * finding one client in a long alphabetical list means scrolling past every
 * other, and the browser's own type-ahead only matches from the first
 * character. Ours matches anywhere in the label or the hint, so "cctv" finds
 * "Hyderabad CCTV Phase II" and an employee number finds its owner.
 *
 * It stays a real input rather than a custom listbox widget, so typing,
 * clearing and keyboard navigation behave the way people already expect.
 */
export function Combobox({
  value, onChange, options, placeholder, disabled, isLoading,
  onCreate, createLabel, id, emptyHint,
}: {
  value: string;
  onChange: (id: string) => void;
  options: ComboOption[];
  placeholder?: string;
  disabled?: boolean;
  isLoading?: boolean;
  /** Offered when the typed text matches nothing. Omit to disable creating. */
  onCreate?: (name: string) => Promise<{ id: string }>;
  createLabel?: string;
  id?: string;
  emptyHint?: React.ReactNode;
}) {
  const [query, setQuery] = React.useState('');
  const [open, setOpen] = React.useState(false);
  const [active, setActive] = React.useState(0);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const boxRef = React.useRef<HTMLDivElement>(null);

  const selected = options.find((o) => o.id === value) ?? null;

  // Matches anywhere, not just the start: an alphabetical list is not how
  // people remember a client, and the first word is rarely the memorable one.
  const needle = query.trim().toLowerCase();
  const matches = needle
    ? options.filter((o) =>
        o.label.toLowerCase().includes(needle) || (o.hint ?? '').toLowerCase().includes(needle))
    : options;
  const visible = matches.slice(0, 50);
  const exact = options.some((o) => o.label.toLowerCase() === needle);
  const canCreate = Boolean(onCreate) && needle.length > 0 && !exact;

  React.useEffect(() => {
    function onAway(e: MouseEvent) {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onAway);
    return () => document.removeEventListener('mousedown', onAway);
  }, []);

  React.useEffect(() => setActive(0), [needle, open]);

  async function create() {
    if (!onCreate || !needle) return;
    setBusy(true);
    setError(null);
    try {
      const created = await onCreate(query.trim());
      onChange(created.id);
      setQuery('');
      setOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not add that');
    } finally {
      setBusy(false);
    }
  }

  function choose(option: ComboOption) {
    onChange(option.id);
    setQuery('');
    setOpen(false);
  }

  const inputClass =
    'w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-text ' +
    'placeholder:text-text-subtle focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-1 ' +
    'disabled:opacity-50';

  return (
    <div ref={boxRef} className="relative">
      <div className="flex gap-2">
        <input
          id={id}
          className={inputClass}
          role="combobox"
          aria-expanded={open}
          aria-autocomplete="list"
          autoComplete="off"
          disabled={disabled || isLoading}
          // The selected label shows when the box is closed; typing replaces
          // it, so the field always reads as what it holds.
          value={open ? query : (selected?.label ?? '')}
          placeholder={isLoading ? 'Loading…' : (placeholder ?? 'Type to search…')}
          onFocus={() => setOpen(true)}
          onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setActive((i) => Math.min(i + 1, visible.length - 1)); }
            if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => Math.max(i - 1, 0)); }
            if (e.key === 'Enter') {
              e.preventDefault();
              if (visible[active]) choose(visible[active]);
              else if (canCreate) void create();
            }
            if (e.key === 'Escape') { setOpen(false); setQuery(''); }
          }}
        />
        {value ? (
          <Button
            type="button"
            variant="secondary"
            onClick={() => { onChange(''); setQuery(''); }}
            aria-label="Clear"
          >
            Clear
          </Button>
        ) : null}
      </div>

      {error ? <p className="mt-1 text-2xs text-danger">{error}</p> : null}
      {!open && emptyHint && !value ? (
        <p className="mt-1 text-2xs text-text-subtle">{emptyHint}</p>
      ) : null}

      {open ? (
        <ul
          role="listbox"
          className="absolute z-30 mt-1 max-h-64 w-full overflow-auto rounded-md border border-border bg-overlay py-1 shadow-lg"
        >
          {visible.map((o, i) => (
            <li key={o.id}>
              <button
                type="button"
                role="option"
                aria-selected={o.id === value}
                className={cn(
                  'flex w-full items-baseline justify-between gap-2 px-3 py-1.5 text-left text-sm',
                  i === active ? 'bg-surface-sunken text-text' : 'text-text-muted hover:bg-surface-sunken',
                )}
                onMouseEnter={() => setActive(i)}
                onClick={() => choose(o)}
              >
                <span className="truncate">{o.label}</span>
                {o.hint ? <span className="shrink-0 text-2xs text-text-subtle">{o.hint}</span> : null}
              </button>
            </li>
          ))}

          {visible.length === 0 && !canCreate ? (
            <li className="px-3 py-2 text-xs text-text-subtle">
              {needle ? 'Nothing matches' : 'Nothing to choose from yet'}
            </li>
          ) : null}

          {canCreate ? (
            <li className="border-t border-border">
              <button
                type="button"
                className="w-full px-3 py-2 text-left text-sm text-primary hover:bg-surface-sunken disabled:opacity-50"
                disabled={busy}
                onClick={() => void create()}
              >
                {busy ? 'Adding…' : `${createLabel ?? 'Add'} “${query.trim()}”`}
              </button>
            </li>
          ) : null}

          {matches.length > visible.length ? (
            <li className="border-t border-border px-3 py-1.5 text-2xs text-text-subtle">
              {matches.length - visible.length} more — keep typing to narrow it
            </li>
          ) : null}
        </ul>
      ) : null}
    </div>
  );
}
