'use client';

import * as React from 'react';
import * as Primitive from '@radix-ui/react-dropdown-menu';
import { Check } from 'lucide-react';
import { cn } from '@/lib/cn';

export const DropdownMenu = Primitive.Root;
export const DropdownMenuTrigger = Primitive.Trigger;
export const DropdownMenuGroup = Primitive.Group;

export const DropdownMenuContent = React.forwardRef<
  React.ElementRef<typeof Primitive.Content>,
  React.ComponentPropsWithoutRef<typeof Primitive.Content>
>(function DropdownMenuContent({ className, sideOffset = 4, ...rest }, ref) {
  return (
    <Primitive.Portal>
      <Primitive.Content
        ref={ref}
        sideOffset={sideOffset}
        className={cn(
          'z-50 min-w-[10rem] overflow-hidden rounded-lg border border-border bg-overlay p-1 shadow-lg',
          'data-[state=open]:animate-zoom-in',
          className,
        )}
        {...rest}
      />
    </Primitive.Portal>
  );
});

export const DropdownMenuItem = React.forwardRef<
  React.ElementRef<typeof Primitive.Item>,
  React.ComponentPropsWithoutRef<typeof Primitive.Item> & { destructive?: boolean }
>(function DropdownMenuItem({ className, destructive, ...rest }, ref) {
  return (
    <Primitive.Item
      ref={ref}
      className={cn(
        'flex cursor-default select-none items-center gap-2 rounded px-2 py-1 text-sm outline-none',
        'data-[highlighted]:bg-surface-sunken data-[disabled]:pointer-events-none data-[disabled]:opacity-50',
        '[&_svg]:size-3.5 [&_svg]:text-text-subtle',
        destructive ? 'text-danger [&_svg]:text-danger' : 'text-text',
        className,
      )}
      {...rest}
    />
  );
});

export const DropdownMenuCheckboxItem = React.forwardRef<
  React.ElementRef<typeof Primitive.CheckboxItem>,
  React.ComponentPropsWithoutRef<typeof Primitive.CheckboxItem>
>(function DropdownMenuCheckboxItem({ className, children, ...rest }, ref) {
  return (
    <Primitive.CheckboxItem
      ref={ref}
      className={cn(
        'relative flex cursor-default select-none items-center rounded py-1 pl-6 pr-2 text-sm text-text outline-none',
        'data-[highlighted]:bg-surface-sunken',
        className,
      )}
      {...rest}
    >
      <span className="absolute left-1.5 flex size-3.5 items-center justify-center">
        <Primitive.ItemIndicator>
          <Check className="size-3.5 text-primary" />
        </Primitive.ItemIndicator>
      </span>
      {children}
    </Primitive.CheckboxItem>
  );
});

export function DropdownMenuLabel({ className, ...rest }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <Primitive.Label
      className={cn('px-2 py-1 text-2xs font-semibold uppercase tracking-wide text-text-subtle', className)}
      {...rest}
    />
  );
}

export function DropdownMenuSeparator({ className }: { className?: string }) {
  return <Primitive.Separator className={cn('my-1 h-px bg-border', className)} />;
}
