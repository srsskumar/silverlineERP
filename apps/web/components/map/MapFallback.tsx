import { MapPinned } from 'lucide-react';
import { cn } from '@/lib/cn';

/**
 * Shown in place of a map when WebGL2 is unavailable. Lists the coordinates so
 * the page still carries its information rather than just apologising.
 */
export function MapFallback({
  height = 320,
  className,
  items = [],
}: {
  height?: number;
  className?: string;
  items?: ReadonlyArray<{ id: string; label: string; detail?: string }>;
}) {
  return (
    <div
      style={{ height }}
      className={cn(
        'flex w-full flex-col items-center justify-center gap-2 overflow-y-auto rounded-lg border border-dashed border-border bg-surface-sunken p-4 text-center',
        className,
      )}
    >
      <MapPinned className="size-5 text-text-subtle" aria-hidden="true" />
      <p className="text-sm font-medium text-text">Map unavailable</p>
      <p className="max-w-sm text-xs text-text-muted">
        This browser does not support WebGL2, which the map needs. Everything below still works.
      </p>
      {items.length > 0 && (
        <ul className="mt-2 w-full max-w-md space-y-1 text-left">
          {items.slice(0, 8).map((item) => (
            <li key={item.id} className="flex justify-between gap-3 text-xs">
              <span className="truncate text-text">{item.label}</span>
              {item.detail && <span className="shrink-0 font-mono text-text-subtle">{item.detail}</span>}
            </li>
          ))}
          {items.length > 8 && (
            <li className="text-xs text-text-subtle">+{items.length - 8} more</li>
          )}
        </ul>
      )}
    </div>
  );
}
