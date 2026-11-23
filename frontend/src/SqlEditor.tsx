import { useEffectEvent, useLayoutEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { MSSQL, SQLDialect } from '@codemirror/lang-sql';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { Compartment, EditorState, Prec } from '@codemirror/state';
import { drawSelection, EditorView, keymap, lineNumbers } from '@codemirror/view';
import { tags } from '@lezer/highlight';
import { getCM, vim } from '@replit/codemirror-vim';
import { useI18n } from './i18n';

// Include the N prefix in highlighted Unicode string literals.
const sqlServer = SQLDialect.define({ ...MSSQL.spec, charSetCasts: true });
const sqlHighlighting = syntaxHighlighting(HighlightStyle.define([
  { tag: tags.keyword, color: 'var(--sql-keyword, #004ba0)' },
  { tag: [tags.typeName, tags.standard(tags.name)], color: 'var(--sql-type, #633297)' },
  { tag: tags.string, color: 'var(--sql-string, #a12236)' },
  { tag: tags.special(tags.string), color: 'var(--sql-identifier, #245f64)' },
  { tag: tags.number, color: 'var(--sql-number, #985000)' },
  { tag: tags.special(tags.name), color: 'var(--sql-variable, #81395c)' },
  { tag: tags.comment, color: 'var(--sql-comment, #4e6a59)' },
]));

export function selectedSql(state: EditorState): string | null {
  const ranges = state.selection.ranges.filter((range) => !range.empty);
  return ranges.length ? ranges.map(({ from, to }) => state.sliceDoc(from, to)).join('\n').trim() : null;
}

export function startsWithUse(sql: string): boolean {
  const script = sqlServer.language.parser.parse(sql).topNode;
  for (let node = script.firstChild; node; node = node.nextSibling) {
    const first = node.firstChild;
    if (node.name !== 'Statement' || first?.name === ';') continue;
    return first?.name === 'Keyword' && sql.slice(first.from, first.to).toUpperCase() === 'USE';
  }
  return false;
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
        sqlServer.extension,
        sqlHighlighting,
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
