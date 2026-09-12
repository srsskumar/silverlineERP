import { cn } from '@/lib/cn';

export function Spinner({
  size = 'md',
  className,
}: {
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}) {
  const dims = size === 'sm' ? 'size-3.5' : size === 'lg' ? 'size-7' : 'size-5';
  return (
    <span
      role="status"
      aria-label="Loading"
      className={cn(
        'inline-block animate-spin rounded-full border-2 border-current border-t-transparent',
        dims,
        className,
      )}
    />
  );
}
