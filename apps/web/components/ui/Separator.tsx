'use client';

import * as Primitive from '@radix-ui/react-separator';
import { cn } from '@/lib/cn';

export function Separator({
  className,
  orientation = 'horizontal',
  ...rest
}: React.ComponentPropsWithoutRef<typeof Primitive.Root>) {
  return (
    <Primitive.Root
      decorative
      orientation={orientation}
      className={cn(
        'shrink-0 bg-border',
        orientation === 'horizontal' ? 'h-px w-full' : 'h-full w-px',
        className,
      )}
      {...rest}
    />
  );
}
