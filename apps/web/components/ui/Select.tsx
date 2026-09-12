'use client';

import * as React from 'react';
import * as SelectPrimitive from '@radix-ui/react-select';
import { Check, ChevronDown } from 'lucide-react';
import { cn } from '@/lib/cn';

export const Select = SelectPrimitive.Root;
export const SelectValue = SelectPrimitive.Value;
export const SelectGroup = SelectPrimitive.Group;

export const SelectTrigger = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Trigger>
>(function SelectTrigger({ className, children, ...rest }, ref) {
  return (
    <SelectPrimitive.Trigger
      ref={ref}
      className={cn(
        'flex h-8 w-full items-center justify-between gap-2 rounded border border-border bg-surface px-2.5 text-sm text-text shadow-sm',
        'data-[placeholder]:text-text-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1',
        'focus-visible:ring-offset-surface disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...rest}
    >
      {children}
      <SelectPrimitive.Icon asChild>
        <ChevronDown className="size-3.5 shrink-0 text-text-subtle" />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  );
});

export const SelectContent = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Content>
>(function SelectContent({ className, children, position = 'popper', ...rest }, ref) {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content
        ref={ref}
        position={position}
        className={cn(
          'z-50 max-h-72 min-w-[8rem] overflow-hidden rounded-lg border border-border bg-overlay shadow-lg',
          'data-[state=open]:animate-zoom-in',
          position === 'popper' && 'data-[side=bottom]:translate-y-1 data-[side=top]:-translate-y-1',
          className,
        )}
        {...rest}
      >
        <SelectPrimitive.Viewport className="p-1">{children}</SelectPrimitive.Viewport>
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  );
});

export const SelectItem = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Item>
>(function SelectItem({ className, children, ...rest }, ref) {
  return (
    <SelectPrimitive.Item
      ref={ref}
      className={cn(
        'relative flex cursor-default select-none items-center rounded py-1 pl-6 pr-2 text-sm text-text outline-none',
        'data-[highlighted]:bg-surface-sunken data-[disabled]:pointer-events-none data-[disabled]:opacity-50',
        className,
      )}
      {...rest}
    >
      <span className="absolute left-1.5 flex size-3.5 items-center justify-center">
        <SelectPrimitive.ItemIndicator>
          <Check className="size-3.5 text-primary" />
        </SelectPrimitive.ItemIndicator>
      </span>
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
    </SelectPrimitive.Item>
  );
});

export function SelectLabel({ className, ...rest }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <SelectPrimitive.Label
      className={cn('px-2 py-1 text-2xs font-semibold uppercase tracking-wide text-text-subtle', className)}
      {...rest}
    />
  );
}

export function SelectSeparator({ className }: { className?: string }) {
  return <SelectPrimitive.Separator className={cn('my-1 h-px bg-border', className)} />;
}
