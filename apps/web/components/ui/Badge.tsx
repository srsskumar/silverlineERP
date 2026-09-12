import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/cn';

const badgeVariants = cva(
  'inline-flex items-center gap-1 rounded font-medium whitespace-nowrap [&_svg]:size-3',
  {
    variants: {
      tone: {
        neutral: 'bg-neutral-status-subtle text-text-muted',
        success: 'bg-success-subtle text-success',
        warning: 'bg-warning-subtle text-warning',
        danger: 'bg-danger-subtle text-danger',
        info: 'bg-info-subtle text-info',
      },
      size: {
        sm: 'px-1.5 py-0.5 text-2xs',
        md: 'px-2 py-0.5 text-xs',
      },
    },
    defaultVariants: { tone: 'neutral', size: 'md' },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

export function Badge({ tone, size, className, children, ...rest }: BadgeProps) {
  return (
    <span className={cn(badgeVariants({ tone, size }), className)} {...rest}>
      {children}
    </span>
  );
}

/** Badge with a leading status dot — the standard row-status treatment. */
export function StatusBadge({ tone = 'neutral', children, className, ...rest }: BadgeProps) {
  return (
    <Badge tone={tone} className={cn('pl-1.5', className)} {...rest}>
      <span className="size-1.5 rounded-full bg-current opacity-80" aria-hidden="true" />
      {children}
    </Badge>
  );
}

export { badgeVariants };
