import { describe, expect, it } from 'vitest';
import { editorChanges, type EditorState } from '../components/ModuleVisibilityEditor';

/*
 * The three-state editor (Show / Hide / Follow role) is shared by the single
 * and the bulk edit. It must emit exactly what the API expects: `null` for
 * "follow the role", nothing for a module the selection disagrees on.
 */
describe('editorChanges', () => {
  it('turns show, hide and follow-role into API changes and skips mixed modules', () => {
    const state: EditorState = { 'my-work': 'hide', inbox: 'follow', projects: 'mixed', reports: 'show' };
    expect(editorChanges(state)).toEqual([
      { module_code: 'my-work', visible: false },
      { module_code: 'inbox', visible: null },
      { module_code: 'reports', visible: true },
    ]);
  });

  it('sends only what changed from the initial state', () => {
    const initial: EditorState = { 'my-work': 'hide', inbox: 'follow', projects: 'mixed' };
    const state: EditorState = { 'my-work': 'hide', inbox: 'show', projects: 'follow' };
    expect(editorChanges(state, initial)).toEqual([
      { module_code: 'inbox', visible: true },
      { module_code: 'projects', visible: null },
    ]);
  });

  it('emits nothing when nothing was decided', () => {
    expect(editorChanges({ 'my-work': 'mixed' })).toEqual([]);
  });
});
