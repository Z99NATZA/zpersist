import { memo, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, PointerEvent } from 'react';
import { Table2 } from 'lucide-react';
import type { CellValue, EditableColumn, ResultTable } from './api';
import { useI18n } from './i18n';
import type { ChangeCell, GridDraft, RowDraft } from './resultEdits';

const PREVIEW_ROWS = 3;
const PREVIEW_PEEK_HEIGHT = 18;
const MIN_COLUMN_WIDTH = 32;
const MAX_COLUMN_WIDTH = 4096;
const RESIZE_STEP = 24;

type ColumnDrag = {
  pointer: number;
  column: number;
  widths: number[];
  startX: number;
  edge: number;
  startScroll: number;
};

function clampWidth(width: number, initialWidth: number) {
  return Math.max(MIN_COLUMN_WIDTH, Math.min(width, Math.max(MAX_COLUMN_WIDTH, initialWidth)));
}

function measureColumns(header: HTMLTableCellElement) {
  const row = header.parentElement as HTMLTableRowElement;
  return Array.from(row.cells).slice(0, -1).map((cell) => cell.getBoundingClientRect().width);
}

export const ResultGrid = memo(function ResultGrid({ index, result, draft, saving, onChange }: {
  index: number;
  result: ResultTable;
  draft?: GridDraft;
  saving: boolean;
  onChange: ChangeCell;
}) {
  const { t } = useI18n();
  const viewportRef = useRef<HTMLDivElement>(null);
  const tableRef = useRef<HTMLTableElement>(null);
  const guideRef = useRef<HTMLDivElement>(null);
  const drag = useRef<ColumnDrag | null>(null);
  const [widths, setWidths] = useState<number[] | null>(null);
  const title = t('resultTitle', { number: index + 1 });
  const count = result.rows.length;
  const rows = t(count === 1 ? 'rowCount' : 'rowsCount', { count });
  const columns = ['#', ...result.columns.map((column) => column || t('unnamedColumn'))];
  const tableWidth = widths?.reduce((total, width) => total + width, 0);
  const clipped = useMemo(() => {
    const rows = new Map<number, Set<number>>();
    for (const [row, column] of result.clipped ?? []) {
      let cells = rows.get(row);
      if (!cells) rows.set(row, cells = new Set());
      cells.add(column);
    }
    return rows;
  }, [result.clipped]);
  const body = useMemo(() => (
    <tbody>
      {result.rows.map((row, i) => (
        <ResultRow
          key={i}
          resultIndex={index}
          rowIndex={i}
          row={row}
          draft={draft?.[i]}
          labels={result.columns}
          clipped={clipped.get(i)}
          editable={!saving && result.editable?.key.every(({ index }) => row[index] != null && !clipped.get(i)?.has(index))
            ? result.editable.columns : undefined}
          onChange={onChange}
        />
      ))}
    </tbody>
  ), [clipped, draft, index, onChange, result, saving]);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    const table = tableRef.current;
    const bodyRows = table?.tBodies[0]?.rows;
    const nextRow = bodyRows?.item(PREVIEW_ROWS);
    if (!viewport || !table || !bodyRows || !nextRow) return;

    let frame = 0;
    const fitPreview = () => {
      frame = 0;
      const shownHeight = nextRow.getBoundingClientRect().top - table.getBoundingClientRect().top;
      const horizontalBar = viewport.offsetHeight - viewport.clientHeight;
      const height = `${shownHeight + horizontalBar + PREVIEW_PEEK_HEIGHT}px`;
      if (viewport.style.getPropertyValue('--result-preview-height') !== height) {
        viewport.style.setProperty('--result-preview-height', height);
      }
    };

    fitPreview();
    const observer = new ResizeObserver(() => {
      if (!frame) frame = window.requestAnimationFrame(fitPreview);
    });
    observer.observe(viewport);
    if (table.tHead) observer.observe(table.tHead);
    for (let index = 0; index < PREVIEW_ROWS; index++) observer.observe(bodyRows[index]);
    return () => {
      observer.disconnect();
      window.cancelAnimationFrame(frame);
      viewport.style.removeProperty('--result-preview-height');
    };
  }, [result]);

  useLayoutEffect(() => {
    const headers = tableRef.current?.tHead?.rows[0].cells;
    if (!headers) return;
    const observer = new ResizeObserver((entries) => {
      for (const { target, borderBoxSize } of entries) {
        const handle = target.lastElementChild;
        const width = Math.round(borderBoxSize[0].inlineSize);
        handle?.setAttribute('aria-valuenow', String(width));
        handle?.setAttribute('aria-valuemax', String(Math.max(MAX_COLUMN_WIDTH, width)));
      }
    });
    for (const header of Array.from(headers).slice(0, -1)) observer.observe(header, { box: 'border-box' });
    return () => observer.disconnect();
  }, [result.columns]);

  function resizeColumn(initial: number[], column: number, width: number) {
    if (width === initial[column]) return;
    const next = [...initial];
    next[column] = width;
    setWidths(next);
  }

  function widthAtPointer(current: ColumnDrag, x: number, scrollLeft: number) {
    const initial = current.widths[current.column];
    return clampWidth(initial + x - current.startX + scrollLeft - current.startScroll, initial);
  }

  function showGuide(current: ColumnDrag, x: number) {
    const viewport = viewportRef.current;
    const guide = guideRef.current;
    if (!viewport || !guide) return;

    const width = widthAtPointer(current, x, viewport.scrollLeft);
    const edge = current.edge + width - current.widths[current.column] - (viewport.scrollLeft - current.startScroll);
    const offset = edge - viewport.getBoundingClientRect().left;
    const left = Math.max(0, Math.min(offset, viewport.clientWidth - 1));
    guide.style.left = `${viewport.offsetLeft + left}px`;
    guide.style.top = `${viewport.offsetTop}px`;
    guide.style.height = `${viewport.clientHeight}px`;
    guide.hidden = false;
  }

  function startDrag(event: PointerEvent<HTMLSpanElement>) {
    const handle = event.currentTarget;
    const header = handle.closest('th');
    const viewport = viewportRef.current;
    if (!event.isPrimary || event.button !== 0 || drag.current || !header || !viewport) return;

    event.preventDefault();
    handle.focus({ preventScroll: true });
    handle.setPointerCapture(event.pointerId);
    drag.current = {
      pointer: event.pointerId,
      column: header.cellIndex,
      widths: measureColumns(header),
      startX: event.clientX,
      edge: header.getBoundingClientRect().right,
      startScroll: viewport.scrollLeft,
    };
    showGuide(drag.current, event.clientX);
  }

  function moveDrag(event: PointerEvent<HTMLSpanElement>) {
    const current = drag.current;
    if (current?.pointer === event.pointerId) showGuide(current, event.clientX);
  }

  function clearDrag() {
    drag.current = null;
    if (guideRef.current) guideRef.current.hidden = true;
  }

  function finishDrag(event: PointerEvent<HTMLSpanElement>) {
    const current = drag.current;
    if (current?.pointer !== event.pointerId) return;

    clearDrag();
    const viewport = viewportRef.current;
    if (event.type === 'pointerup' && viewport) {
      resizeColumn(current.widths, current.column, widthAtPointer(current, event.clientX, viewport.scrollLeft));
    }
  }

  function resizeWithKeyboard(event: KeyboardEvent<HTMLSpanElement>) {
    const handle = event.currentTarget;
    if (drag.current) {
      if (event.key === 'Escape') {
        event.preventDefault();
        const { pointer } = drag.current;
        clearDrag();
        if (handle.hasPointerCapture(pointer)) handle.releasePointerCapture(pointer);
      }
      return;
    }

    const header = handle.closest('th');
    if (!header || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const initial = measureColumns(header);
    const width = initial[header.cellIndex];
    const target = event.key === 'Home' ? MIN_COLUMN_WIDTH : event.key === 'End' ? Math.max(MAX_COLUMN_WIDTH, width) :
      width + (event.key === 'ArrowLeft' ? -RESIZE_STEP : RESIZE_STEP);
    resizeColumn(initial, header.cellIndex, clampWidth(target, width));
    window.requestAnimationFrame(() => handle.scrollIntoView({ block: 'nearest', inline: 'nearest' }));
  }

  return (
    <section className="result-grid" id={`result-grid-${index}`} aria-labelledby={`result-title-${index}`}>
      <div className="result-title">
        <h3 id={`result-title-${index}`}><Table2 size={15} aria-hidden="true" />{title}</h3>
        <span>{result.truncated ? t('truncatedRows', { rows }) : rows}</span>
      </div>
      <div className="table-scroll workspace-scrollbar" ref={viewportRef} role="region" aria-label={t('resultData', { result: title })} tabIndex={0}>
        <table
          ref={tableRef}
          aria-label={title}
          data-sized-columns={widths ? '' : undefined}
          style={{ minWidth: tableWidth === undefined ? undefined : `calc(${tableWidth}px + var(--column-filler-width))` }}
        >
          <colgroup>
            {columns.map((_, i) => <col key={i} style={{ width: widths?.[i] }} />)}
            <col />
          </colgroup>
          <thead>
            <tr>
              {columns.map((column, i) => (
                <th key={i} scope="col">
                  <span title={column}>{column}</span>
                  <span
                    className="column-resize-handle"
                    role="separator"
                    tabIndex={0}
                    aria-label={t('resizeColumn', { column })}
                    aria-orientation="vertical"
                    aria-valuemin={MIN_COLUMN_WIDTH}
                    onPointerDown={startDrag}
                    onPointerMove={moveDrag}
                    onPointerUp={finishDrag}
                    onPointerCancel={finishDrag}
                    onLostPointerCapture={finishDrag}
                    onKeyDown={resizeWithKeyboard}
                  />
                </th>
              ))}
              <th className="result-column-filler" aria-hidden="true" />
            </tr>
          </thead>
          {body}
        </table>
      </div>
      <div className="column-resize-guide" ref={guideRef} aria-hidden="true" hidden />
    </section>
  );
});

const ResultRow = memo(function ResultRow({ resultIndex, rowIndex, row, draft, labels, clipped, editable, onChange }: {
  resultIndex: number;
  rowIndex: number;
  row: CellValue[];
  draft?: RowDraft;
  labels: string[];
  clipped?: Set<number>;
  editable?: (EditableColumn | null)[];
  onChange: ChangeCell;
}) {
  const { number, t } = useI18n();
  return (
    <tr>
      <th scope="row">{number(rowIndex + 1)}</th>
      {row.map((original, column) => {
        const value = draft?.[column];
        return (
          <ResultCell
            key={column}
            value={value === undefined ? original : value}
            dirty={value !== undefined}
            label={labels[column] || t('unnamedColumn')}
            editable={clipped?.has(column) ? undefined : editable?.[column] ?? undefined}
            first={rowIndex === 0 && column === 0}
            onChange={(value) => onChange(resultIndex, rowIndex, column, value)}
          />
        );
      })}
      <td className="result-column-filler" aria-hidden="true" />
    </tr>
  );
});

function ResultCell({ value, dirty, label, editable, first, onChange }: {
  value: CellValue;
  dirty: boolean;
  label: string;
  editable?: EditableColumn;
  first: boolean;
  onChange: (value: CellValue) => void;
}) {
  const { t } = useI18n();
  const [edit, setEdit] = useState<{ initial: CellValue } | null>(null);
  const startedFocused = useRef(false);
  const cell = useRef<HTMLTableCellElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const editing = edit !== null && editable !== undefined;
  const text = value ?? t('nullValue');

  useLayoutEffect(() => {
    if (!editing || !input.current) return;
    const field = input.current;
    field.focus({ preventScroll: true });
    field.setSelectionRange(field.value.length, field.value.length);
  }, [editing]);

  function cellKeys(event: KeyboardEvent<HTMLTableCellElement>) {
    if (event.target !== event.currentTarget) return;
    const current = event.currentTarget;
    if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'c') {
      const selection = window.getSelection();
      const display = current.querySelector('.result-cell-text');
      if (selection?.isCollapsed && display) {
        const range = document.createRange();
        range.selectNodeContents(display);
        selection.removeAllRanges();
        selection.addRange(range);
        // Let the browser copy the value on HTTP origins as well.
        window.setTimeout(() => {
          if (selection.rangeCount && selection.getRangeAt(0) === range) selection.removeAllRanges();
        }, 0);
      }
      return;
    }
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (editable && (event.key === 'Enter' || event.key === 'F2')) {
      event.preventDefault();
      setEdit({ initial: value });
      return;
    }

    const row = current.parentElement as HTMLTableRowElement;
    let next: Element | null = null;
    switch (event.key) {
      case 'ArrowLeft': next = current.previousElementSibling; break;
      case 'ArrowRight': next = current.nextElementSibling; break;
      case 'ArrowUp': next = (row.previousElementSibling as HTMLTableRowElement | null)?.cells[current.cellIndex] ?? null; break;
      case 'ArrowDown': next = (row.nextElementSibling as HTMLTableRowElement | null)?.cells[current.cellIndex] ?? null; break;
      default: return;
    }
    if (!(next instanceof HTMLTableCellElement) || !next.classList.contains('result-cell')) return;
    event.preventDefault();
    next.focus();
  }

  function inputKeys(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.nativeEvent.isComposing) return;
    if (event.altKey && event.key === 'Delete' && editable?.nullable) {
      event.preventDefault();
      onChange(null);
    } else if (event.key === 'Escape' || (event.key === 'Enter' && !event.shiftKey)) {
      event.preventDefault();
      if (event.key === 'Escape' && edit) onChange(edit.initial);
      setEdit(null);
      cell.current?.focus({ preventScroll: true });
    }
  }

  return (
    <td
      className={value === null ? 'result-cell null-cell' : 'result-cell'}
      data-draft={dirty || undefined}
      data-editing={editing || undefined}
      ref={cell}
      tabIndex={first ? 0 : -1}
      title={editing ? undefined : text}
      onMouseDown={(event) => {
        startedFocused.current = event.button === 0 && document.activeElement === event.currentTarget && !editing;
        if (startedFocused.current && editable && !event.shiftKey) event.preventDefault();
      }}
      onClick={(event) => {
        if (editing) return;
        if (startedFocused.current && editable && !event.shiftKey) setEdit({ initial: value });
        else event.currentTarget.focus({ preventScroll: true });
        startedFocused.current = false;
      }}
      onKeyDown={cellKeys}
    >
      <div className="result-cell-content">
        <span className="result-cell-text" aria-hidden={editing || undefined}>{text}</span>
        {editing && (
          <textarea
            ref={input}
            rows={1}
            aria-label={label}
            title={editable.nullable ? t('editNullableCell') : undefined}
            placeholder={value === null ? t('nullValue') : undefined}
            value={value ?? ''}
            onChange={(event) => onChange(event.target.value)}
            onBlur={() => setEdit(null)}
            onKeyDown={inputKeys}
          />
        )}
      </div>
    </td>
  );
}
