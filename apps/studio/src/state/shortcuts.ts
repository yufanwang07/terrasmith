/**
 * Keyboard shortcuts.
 *
 * The set is deliberately small and matches what every other creative tool
 * uses. A shortcut someone has to learn is worse than no shortcut; a shortcut
 * that already lives in their fingers is free.
 */

import { useEffect } from 'react';
import { useEditor } from './store.js';

export interface ShortcutHandlers {
  onExport(): void;
  onTemplates(): void;
}

export function useKeyboardShortcuts(handlers: ShortcutHandlers): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // Never steal a key from a text field. Doing so is the single most
      // common shortcut bug in editors.
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable)
      ) {
        return;
      }

      const mod = event.metaKey || event.ctrlKey;
      const store = useEditor.getState();

      if (mod && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        if (event.shiftKey) store.redo();
        else store.undo();
        return;
      }
      if (mod && event.key.toLowerCase() === 'y') {
        event.preventDefault();
        store.redo();
        return;
      }
      if (mod && event.key.toLowerCase() === 'd') {
        event.preventDefault();
        if (store.selection.length > 0) store.duplicateNodes(store.selection);
        return;
      }
      if (mod && event.key.toLowerCase() === 'e') {
        event.preventDefault();
        handlers.onExport();
        return;
      }
      if (mod && event.key.toLowerCase() === 'n') {
        event.preventDefault();
        handlers.onTemplates();
        return;
      }

      // Bare keys, the way a 3D tool assigns them.
      switch (event.key.toLowerCase()) {
        case 'b':
          if (store.selection.length > 0) {
            event.preventDefault();
            store.toggleBypass(store.selection);
          }
          break;
        case 'g':
          event.preventDefault();
          store.setCenterView(store.centerView === 'graph' ? 'split' : 'graph');
          break;
        case 'f':
          event.preventDefault();
          store.setCenterView(store.centerView === 'terrain' ? 'split' : 'terrain');
          break;
        case 'tab':
          event.preventDefault();
          store.setGuided(!store.guided);
          break;
        default:
          break;
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [handlers]);
}

/** Shortcut reference, shown in the help dialog. */
export const SHORTCUTS: { keys: string; action: string }[] = [
  { keys: 'Ctrl/Cmd Z', action: 'Undo' },
  { keys: 'Ctrl/Cmd Shift Z', action: 'Redo' },
  { keys: 'Ctrl/Cmd D', action: 'Duplicate selected nodes' },
  { keys: 'Ctrl/Cmd E', action: 'Export the map' },
  { keys: 'Ctrl/Cmd N', action: 'Start from a template' },
  { keys: 'B', action: 'Bypass the selected nodes' },
  { keys: 'G', action: 'Focus the graph' },
  { keys: 'F', action: 'Focus the terrain' },
  { keys: 'Tab', action: 'Switch between guided and graph mode' },
  { keys: 'Delete', action: 'Delete the selection' },
];
