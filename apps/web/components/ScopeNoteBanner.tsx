'use client';

/** Info banner for the dashboard `scope_note` (rendered only when present). */
export function ScopeNoteBanner({ note }: { note?: string | null }) {
  if (!note) return null;
  return (
    <div role="note" className="rounded-lg border border-info/30 bg-info-subtle px-4 py-3 text-sm text-info">
      <p className="font-medium">Scope note</p>
      <p className="mt-1">{note}</p>
    </div>
  );
}
