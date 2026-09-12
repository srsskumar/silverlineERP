import * as React from 'react';
import { cn } from '@/lib/cn';

export function Card({ className, ...rest }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('rounded-lg border border-border bg-surface shadow-sm', className)}
      {...rest}
    />
  );
}

export function CardHeader({ className, ...rest }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('flex items-center justify-between gap-3 border-b border-border px-3 py-2', className)}
      {...rest}
    />
  );
}

export function CardTitle({ className, ...rest }: React.HTMLAttributes<HTMLHeadingElement>) {
  return <h3 className={cn('text-sm font-semibold text-text', className)} {...rest} />;
}

export function CardDescription({ className, ...rest }: React.HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cn('text-xs text-text-muted', className)} {...rest} />;
}

export function CardContent({ className, ...rest }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('p-3', className)} {...rest} />;
}

export function CardFooter({ className, ...rest }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('flex items-center gap-2 border-t border-border px-3 py-2', className)}
      {...rest}
    />
  );
}

/**
 * Single metric tile. `delta` is rendered by the caller so the sign, unit and
 * comparison window stay explicit rather than inferred here.
 */
export function StatTile({
  label,
  value,
  delta,
  hint,
  className,
}: {
  label: string;
  value: React.ReactNode;
  delta?: React.ReactNode;
  hint?: string;
  className?: string;
}) {
  return (
    <Card className={cn('p-3', className)}>
      <p className="text-xs font-medium text-text-muted">{label}</p>
      <div className="mt-1 flex items-baseline gap-2">
        <span className="tabular text-2xl font-semibold tracking-tight text-text">{value}</span>
        {delta}
      </div>
      {hint && <p className="mt-0.5 text-2xs text-text-subtle">{hint}</p>}
    </Card>
  );
}
