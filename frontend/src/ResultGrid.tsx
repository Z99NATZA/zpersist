import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, PointerEvent } from 'react';
import { Table2 } from 'lucide-react';
import type { ResultTable } from './api';
import { useI18n } from './i18n';

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

export function ResultGrid({ index, result }: { index: number; result: ResultTable }) {
  const { t, number } = useI18n();
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
  const body = useMemo(() => (
    <tbody>
      {result.rows.map((row, i) => (
        <tr key={i}>
          <th scope="row">{number(i + 1)}</th>
          {row.map((cell, j) => cell === null ?
            <td className="null-cell" key={j}>{t('nullValue')}</td> :
            <td key={j} title={cell}>{cell}</td>,
          )}
          <td className="result-column-filler" aria-hidden="true" />
        </tr>
      ))}
    </tbody>
  ), [number, result.rows, t]);

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
}
