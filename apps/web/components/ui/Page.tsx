import * as React from 'react';
import { cn } from '@/lib/cn';

/**
 * Standard page frame. Every route uses this so the title block, action slot
 * and content rhythm are identical everywhere — the main thing the old screens
 * lacked, since each one hand-rolled its own header spacing.
 */
export function PageHeader({
  title,
  description,
  actions,
  breadcrumb,
  className,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  breadcrumb?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('mb-4', className)}>
      {breadcrumb && <div className="mb-1.5 text-xs text-text-subtle">{breadcrumb}</div>}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="truncate text-xl font-semibold tracking-tight text-text">{title}</h1>
          {description && <p className="mt-0.5 text-xs text-text-muted">{description}</p>}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </div>
    </div>
  );
}

export function PageBody({ className, ...rest }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('space-y-4', className)} {...rest} />;
}

/** Toolbar above a table: filters left, actions right, one 32px row. */
export function Toolbar({ className, ...rest }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn('flex flex-wrap items-center gap-2', className)} {...rest} />
  );
}

export function ToolbarSpacer() {
  return <div className="ml-auto" />;
}
