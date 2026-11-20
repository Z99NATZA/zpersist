import { useEffectEvent, useLayoutEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { Compartment, EditorState, Prec } from '@codemirror/state';
import { drawSelection, EditorView, keymap, lineNumbers } from '@codemirror/view';
import { getCM, vim } from '@replit/codemirror-vim';
import { useI18n } from './i18n';

export function selectedSql(state: EditorState): string | null {
  const ranges = state.selection.ranges.filter((range) => !range.empty);
  return ranges.length ? ranges.map(({ from, to }) => state.sliceDoc(from, to)).join('\n').trim() : null;
}

export function SqlEditor({ editor, initialSql, vimEnabled, autoFocus, onChange, onSelectionChange, onRun }: {
  editor: RefObject<EditorView | null>;
  initialSql: string;
  vimEnabled: boolean;
  autoFocus: boolean;
  onChange: (sql: string) => void;
  onSelectionChange: (length: number | null) => void;
  onRun: () => void;
}) {
  const { t, number } = useI18n();
  const label = t('sqlEditor');
  const container = useRef<HTMLDivElement>(null);
  const [initialDoc] = useState(initialSql);
  const [vimMode] = useState(() => new Compartment());
  const [localization] = useState(() => new Compartment());
  const changeSql = useEffectEvent(onChange);
  const changeSelection = useEffectEvent(onSelectionChange);
  const runSql = useEffectEvent(onRun);

  useLayoutEffect(() => {
    const parent = container.current;
    if (!parent) return;

    const view = new EditorView({
      parent,
      doc: initialDoc,
      extensions: [
        Prec.highest(EditorView.domEventHandlers({
          keydown(event) {
            if (event.key !== 'Enter' || !(event.ctrlKey || event.metaKey)) return false;
            runSql();
            return true;
          },
        })),
        vimMode.of([]),
        localization.of([]),
        EditorState.allowMultipleSelections.of(true),
        EditorState.tabSize.of(4),
        drawSelection(),
        history(),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        EditorView.updateListener.of(({ docChanged, selectionSet, state }) => {
          if (docChanged) changeSql(state.doc.toString());
          if (docChanged || selectionSet) changeSelection(selectedSql(state)?.length ?? null);
        }),
      ],
    });
    view.scrollDOM.classList.add('workspace-scrollbar');
    editor.current = view;
    return () => {
      editor.current = null;
      view.destroy();
    };
  }, [editor, initialDoc, localization, vimMode]);

  useLayoutEffect(() => {
    const view = editor.current;
    const parent = container.current;
    if (!view || !parent) return;

    view.dispatch({ effects: vimMode.reconfigure(vimEnabled ? vim({ status: true }) : []) });
    const cm = getCM(view);
    if (!cm) return;

    const updateMode = ({ mode, subMode }: { mode: string; subMode?: string }) => {
      parent.dataset.vimMode = subMode || mode;
    };

    updateMode({ mode: 'normal' });
    cm.on('vim-mode-change', updateMode);
    return () => {
      cm.off('vim-mode-change', updateMode);
      delete parent.dataset.vimMode;
    };
  }, [editor, vimEnabled, vimMode]);

  useLayoutEffect(() => {
    editor.current?.dispatch({ effects: localization.reconfigure([
      lineNumbers({ formatNumber: number }),
      EditorView.contentAttributes.of({ 'aria-label': label, spellcheck: 'false', autocapitalize: 'off' }),
    ]) });
  }, [editor, label, localization, number]);

  useLayoutEffect(() => {
    if (autoFocus) editor.current?.focus();
  }, [autoFocus, editor]);

  return <div className="editor-body" ref={container} />;
}
