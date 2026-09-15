'use client';

import * as React from 'react';
import { Badge } from '@/components/ui/Badge';
import { Sheet, SheetContent, SheetHeader, SheetBody, SheetTitle } from '@/components/ui/Sheet';
import { cn } from '@/lib/cn';
import { statusLabel } from '@/lib/board-visuals';
import { financialTone } from '@/lib/finance';

/**
 * The small pieces every finance screen repeats.
 *
 * Six screens show a status, a labelled figure and a record sheet. Building
 * each one locally is how two screens end up disagreeing about what "pending"
 * looks like, so they live here once.
 */

export function StatusBadge({ status, size = 'sm' }: { status: string | null | undefined; size?: 'sm' | 'md' }) {
  if (!status) return <span className="text-2xs text-text-subtle">—</span>;
  return <Badge tone={financialTone(status)} size={size}>{statusLabel(status)}</Badge>;
}

/**
 * A labelled value in a definition list.
 *
 * `mono` is for references and document numbers, which are compared character
 * by character far more often than they are read as words.
 */
export function Field({
  label, value, mono, tone,
}: {
  label: string;
  value: React.ReactNode;
  mono?: boolean;
  tone?: 'default' | 'danger' | 'success' | 'muted';
}) {
  return (
    <div className="min-w-0">
      <dt className="text-2xs uppercase tracking-wide text-text-subtle">{label}</dt>
      <dd
        className={cn(
          'mt-0.5 truncate tabular-nums',
          mono && 'font-mono text-xs',
          tone === 'danger' && 'text-danger',
          tone === 'success' && 'text-success',
          tone === 'muted' && 'text-text-muted',
          !tone && 'text-text',
        )}
      >
        {value}
      </dd>
    </div>
  );
}

export function Section({
  title, action, children,
}: {
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="mt-5 first:mt-0">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-text-muted">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}

/** Record detail in a side panel, so the list behind it keeps its place. */
export function RecordSheet({
  open, onClose, title, subtitle, children, wide,
}: {
  open: boolean;
  onClose: () => void;
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  children: React.ReactNode;
  wide?: boolean;
}) {
  return (
    <Sheet open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <SheetContent className={wide ? 'w-[min(52rem,100vw-2.5rem)]' : undefined}>
        <SheetHeader>
          <SheetTitle className="text-base font-semibold text-text">{title}</SheetTitle>
          {subtitle ? <p className="mt-0.5 text-2xs text-text-subtle">{subtitle}</p> : null}
        </SheetHeader>
        <SheetBody>{children}</SheetBody>
      </SheetContent>
    </Sheet>
  );
}

/**
 * A headline figure.
 *
 * `hint` carries the second-order number — committed cost beside actual, or
 * what is still outstanding beside what was paid — because the figure alone
 * is usually the more flattering half of the story.
 */
export function Stat({
  label, value, hint, tone,
}: {
  label: string;
  value: React.ReactNode;
  hint?: React.ReactNode;
  tone?: 'default' | 'danger' | 'success' | 'warning';
}) {
  return (
    <div className="rounded-lg border border-border bg-surface px-3 py-2.5">
      <p className="text-2xs uppercase tracking-wide text-text-subtle">{label}</p>
      <p
        className={cn(
          'mt-1 text-lg font-semibold tabular-nums',
          tone === 'danger' && 'text-danger',
          tone === 'success' && 'text-success',
          tone === 'warning' && 'text-warning',
          !tone && 'text-text',
        )}
      >
        {value}
      </p>
      {hint ? <p className="mt-0.5 text-2xs text-text-subtle">{hint}</p> : null}
    </div>
  );
}

/**
 * A warning that names what is wrong and what to do about it.
 *
 * Used wherever a control refuses an action — an over-policy claim, an
 * eligibility gap, a mismatched invoice. The rule these screens follow is that
 * a refusal always says which permission or which step would unblock it.
 */
export function Notice({
  tone = 'warning', title, children,
}: {
  tone?: 'warning' | 'danger' | 'info';
  title: string;
  children?: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        'rounded-lg border p-3',
        tone === 'warning' && 'border-warning/40 bg-warning-subtle',
        tone === 'danger' && 'border-danger/40 bg-danger-subtle',
        tone === 'info' && 'border-info/40 bg-info-subtle',
      )}
    >
      <p
        className={cn(
          'text-xs font-semibold',
          tone === 'warning' && 'text-warning',
          tone === 'danger' && 'text-danger',
          tone === 'info' && 'text-info',
        )}
      >
        {title}
      </p>
      {children ? <div className="mt-1 text-xs text-text-muted">{children}</div> : null}
    </div>
  );
}
