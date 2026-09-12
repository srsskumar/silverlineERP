import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/cn';
import { Spinner } from './Spinner';

const buttonVariants = cva(
  'inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded font-medium transition-colors ' +
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-surface ' +
    'disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        primary: 'bg-primary text-primary-fg shadow-sm hover:bg-primary-hover',
        secondary: 'border border-border bg-surface text-text shadow-sm hover:bg-surface-sunken',
        danger: 'bg-danger text-white shadow-sm hover:bg-danger/90',
        ghost: 'text-text-muted hover:bg-surface-sunken hover:text-text',
        link: 'text-primary underline-offset-4 hover:underline',
      },
      size: {
        // Dense default: 28px tall, matching the 36px table row.
        sm: 'h-7 px-2 text-xs',
        md: 'h-8 px-3 text-sm',
        lg: 'h-9 px-4 text-sm',
        icon: 'h-8 w-8 p-0',
      },
    },
    defaultVariants: { variant: 'primary', size: 'md' },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  loading?: boolean;
  /** Render the child element instead of a <button> (e.g. to wrap a Link). */
  asChild?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant, size, loading = false, asChild = false, className, children, disabled, ...rest },
  ref,
) {
  const Comp = asChild ? Slot : 'button';
  return (
    <Comp
      ref={ref}
      className={cn(buttonVariants({ variant, size }), className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading && <Spinner size="sm" />}
      {children}
    </Comp>
  );
});

export { buttonVariants };
