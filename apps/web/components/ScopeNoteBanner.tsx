'use client';

/** Info banner for the dashboard `scope_note` (rendered only when present). */
export function ScopeNoteBanner({ note }: { note?: string | null }) {
  if (!note) return null;
  return (
    <div role="note" className="rounded-lg border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-900">
      <p className="font-medium">Scope note</p>
      <p className="mt-1">{note}</p>
    </div>
  );
}
