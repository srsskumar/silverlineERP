'use client';

import type { Label } from '@/lib/labels';

/**
 * Small label chip. Background/border derive from the label color when it is
 * a valid #RRGGBB value; otherwise a neutral slate chip.
 */
export function LabelPill({
  label,
  onRemove,
  removing = false,
}: {
  label: Pick<Label, 'id' | 'name' | 'color'>;
  onRemove?: () => void;
  removing?: boolean;
}) {
  const color = typeof label.color === 'string' ? label.color : null;
  const colored = !!color && /^#[0-9a-fA-F]{6}$/.test(color);
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium ring-1"
      style={
        colored
          ? { backgroundColor: `${color}1a`, borderColor: `${color}66`, color: '#1e293b' }
          : undefined
      }
      title={colored ? `${label.name} (${color})` : label.name}
    >
      {colored ? (
        <span
          aria-hidden="true"
          className="inline-block h-2 w-2 rounded-full"
          style={{ backgroundColor: color as string }}
        />
      ) : null}
      <span className={colored ? '' : 'rounded-full bg-surface-sunken px-0 text-text-muted'}>{label.name}</span>
      {onRemove ? (
        <button
          type="button"
          onClick={onRemove}
          disabled={removing}
          aria-label={`Remove label ${label.name}`}
          className="ml-1 text-text-muted hover:text-danger disabled:opacity-50"
        >
          ×
        </button>
      ) : null}
    </span>
  );
}
