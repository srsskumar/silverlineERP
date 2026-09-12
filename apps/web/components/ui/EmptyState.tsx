import * as React from 'react';
import { cn } from '@/lib/cn';

export function EmptyState({
  title,
  description,
  action,
  icon,
  className,
}: {
  title: string;
  description?: string;
  action?: React.ReactNode;
  icon?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-1.5 rounded-lg border border-dashed border-border bg-surface-sunken px-6 py-12 text-center',
        className,
      )}
    >
      {icon && (
        <div className="mb-1 flex size-9 items-center justify-center rounded-full bg-surface text-text-subtle [&_svg]:size-4">
          {icon}
        </div>
      )}
      <p className="text-sm font-medium text-text">{title}</p>
      {description && <p className="max-w-sm text-xs text-text-muted">{description}</p>}
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}
