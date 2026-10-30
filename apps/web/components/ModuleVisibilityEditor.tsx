'use client';

import * as React from 'react';
import { MODULE_CATALOG } from '@silverline/shared';
import { NativeSelect } from '@/components/ui/Select';

/**
 * One person's (or a selection's) choice per module: show it, hide it, or
 * follow what the role decides. `mixed` is the bulk case where the selected
 * people disagree today; it is displayed, never sent.
 */
export type EditorChoice = 'show' | 'hide' | 'follow' | 'mixed';
export type EditorState = Record<string, EditorChoice>;

/**
 * The API changes for an editor state: `null` means "follow the role"; `mixed`
 * sends nothing. With `initial`, only the modules the administrator actually
 * changed in this dialog are sent -- opening the editor and pressing Apply
 * must not rewrite every untouched module.
 */
export function editorChanges(
  state: EditorState,
  initial?: EditorState,
): Array<{ module_code: string; visible: boolean | null }> {
  const out: Array<{ module_code: string; visible: boolean | null }> = [];
  for (const [module_code, choice] of Object.entries(state)) {
    if (initial && initial[module_code] === choice) continue;
    if (choice === 'show') out.push({ module_code, visible: true });
    else if (choice === 'hide') out.push({ module_code, visible: false });
    else if (choice === 'follow') out.push({ module_code, visible: null });
  }
  return out;
}

/** The editor state for a selection: the shared choice where everyone agrees, `mixed` where not. */
export function editorStateFor(
  rows: Array<{ modules: Record<string, { visible: boolean; source: string }> }>,
): EditorState {
  const state: EditorState = {};
  for (const m of MODULE_CATALOG) {
    const choices = new Set(rows.map((r) => {
      const cell = r.modules[m.code];
      if (!cell) return 'follow';
      if (cell.source !== 'user') return 'follow';
      return cell.visible ? 'show' : 'hide';
    }));
    state[m.code] = choices.size === 1 ? ([...choices][0] as EditorChoice) : 'mixed';
  }
  return state;
}

export function ModuleVisibilityEditor({
  state,
  onChange,
}: {
  state: EditorState;
  onChange: (next: EditorState) => void;
}) {
  const groups = [...new Set(MODULE_CATALOG.map((m) => m.group))];
  return (
    <div className="space-y-4">
      {groups.map((group) => (
        <section key={group}>
          <h3 className="text-xs font-semibold uppercase tracking-wide text-text-muted">{group}</h3>
          <ul className="mt-1 divide-y divide-border">
            {MODULE_CATALOG.filter((m) => m.group === group).map((m) => {
              const choice = state[m.code] ?? 'follow';
              return (
                <li key={m.code} className="flex items-center justify-between gap-3 py-1.5">
                  <label htmlFor={`editor-${m.code}`} className="text-sm text-text">{m.label}</label>
                  <NativeSelect
                    id={`editor-${m.code}`}
                    data-testid={`editor-${m.code}`}
                    value={choice}
                    onChange={(e) => onChange({ ...state, [m.code]: e.target.value as EditorChoice })}
                  >
                    <option value="follow">Follow role</option>
                    <option value="show">Show</option>
                    <option value="hide">Hide</option>
                    {choice === 'mixed' ? <option value="mixed">Mixed (leave as is)</option> : null}
                  </NativeSelect>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}
