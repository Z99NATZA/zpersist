import { useEffect, useRef } from 'react';
import type { KeyboardEvent, PointerEvent } from 'react';

const MIN_RESULT_HEIGHT = 88;
const RESIZE_STEP = 24;
const DRAG_SCROLL_EDGE = 36;
const DRAG_SCROLL_SPEED = 0.65;

type ResizeTarget = {
  controls: string;
  kind: 'editor' | 'result';
};

function fullResultHeight(pane: HTMLElement) {
  const viewport = pane.querySelector<HTMLElement>('.table-scroll');
  const table = viewport?.querySelector('table');
  if (!viewport || !table) return pane.offsetHeight;

  const chrome = pane.getBoundingClientRect().height - viewport.getBoundingClientRect().height;
  const horizontalBar = viewport.offsetHeight - viewport.clientHeight;
  return Math.max(MIN_RESULT_HEIGHT, Math.ceil(chrome + table.getBoundingClientRect().height + horizontalBar));
}

function measure(handle: HTMLDivElement, { controls, kind }: ResizeTarget) {
  const pane = handle.ownerDocument.getElementById(controls);
  if (!pane || !handle.parentElement) return null;
  const height = pane.offsetHeight;

  if (kind === 'editor') {
    const available = Math.max(0, handle.parentElement.clientHeight - handle.offsetHeight);
    const editorMinimum = Math.min(120, Math.floor(available * 0.36));
    const resultsPane = handle.nextElementSibling;
    const bottomSpace = resultsPane ? Number.parseFloat(getComputedStyle(resultsPane).paddingBlockEnd) || 0 : 0;
    const resultsMinimum = Math.min(available - editorMinimum, Math.min(136, Math.floor(available * 0.52)) + bottomSpace);
    return { pane, height, min: editorMinimum, max: available - resultsMinimum };
  }

  const max = fullResultHeight(pane);
  return { pane, height: Math.min(height, max), min: MIN_RESULT_HEIGHT, max };
}

type Split = NonNullable<ReturnType<typeof measure>>;

type PointerDrag = {
  handle: HTMLDivElement;
  pointer: number;
  startY: number;
  y: number;
  split: Split;
  viewport: HTMLElement | null;
  startScroll: number;
  grabOffset: number;
  handleHeight: number;
  appliedHeight: number;
  draftHeight: number | null;
  frame: number;
};

function clampHeight(split: Split, height: number) {
  return Math.max(split.min, Math.min(height, split.max));
}

function resize(split: Split, height: number) {
  split.pane.style.height = `${clampHeight(split, height)}px`;
  split.pane.dataset.resized = '';
}

function clearDraft(handle: HTMLDivElement) {
  delete handle.dataset.draft;
  handle.style.removeProperty('--resize-draft-offset');
}

function updateDrag(drag: PointerDrag, height: number, renderedHeight = drag.appliedHeight) {
  const target = clampHeight(drag.split, height);
  const displayedHeight = Math.max(drag.appliedHeight, target);
  if (displayedHeight !== renderedHeight) resize(drag.split, displayedHeight);
  drag.appliedHeight = displayedHeight;

  const draft = target < displayedHeight ? target : null;
  if (draft === drag.draftHeight) return;
  drag.draftHeight = draft;
  if (draft === null) {
    clearDraft(drag.handle);
  } else {
    drag.handle.dataset.draft = '';
    drag.handle.style.setProperty('--resize-draft-offset', `${draft - displayedHeight}px`);
  }
}

function heightAtPointer(drag: PointerDrag, bounds?: DOMRect) {
  let y = drag.y;
  if (bounds) {
    const gripHeight = Math.min(drag.handleHeight, bounds.height);
    const grab = Math.min(drag.grabOffset, gripHeight);
    y = Math.max(bounds.top + grab, Math.min(y, bounds.bottom - gripHeight + grab));
  }
  const scroll = (drag.viewport?.scrollTop ?? 0) - drag.startScroll;
  return drag.split.height + y - drag.startY + scroll;
}

function scrollDuringDrag(drag: PointerDrag, elapsed: number) {
  const viewport = drag.viewport;
  if (!viewport) return false;
  const bounds = viewport.getBoundingClientRect();
  const edge = Math.min(DRAG_SCROLL_EDGE, bounds.height / 3);
  if (edge <= 0) return false;

  const down = Math.max(0, drag.y - (bounds.bottom - edge));
  const up = Math.max(0, bounds.top + edge - drag.y);
  const strength = Math.max(-1, Math.min(1, (down - up) / edge));
  if (strength === 0) return false;

  const scroll = viewport.scrollTop;
  const height = heightAtPointer(drag, bounds);
  const growsAtEdge = strength > 0 && drag.y >= bounds.bottom - drag.handleHeight + drag.grabOffset;
  const scrollRoom = viewport.scrollHeight - viewport.clientHeight - scroll;
  const room = strength > 0
    ? Math.min(drag.split.max - height, growsAtEdge ? Infinity : scrollRoom)
    : Math.min(height - drag.split.min, scroll);
  if (room <= 0) return false;

  const distance = Math.min(room, Math.max(1, elapsed * DRAG_SCROLL_SPEED * Math.abs(strength)));
  // Extending the result can create the scroll room for this frame.
  const renderedHeight = growsAtEdge ? Math.max(drag.appliedHeight, clampHeight(drag.split, height + distance)) :
    drag.appliedHeight;
  if (renderedHeight > drag.appliedHeight) resize(drag.split, renderedHeight);
  viewport.scrollTop = scroll + Math.sign(strength) * distance;
  const moved = viewport.scrollTop - scroll;
  updateDrag(drag, height + moved, renderedHeight);
  return moved !== 0;
}

export function VerticalResizeHandle({ label, controls, kind }: ResizeTarget & { label: string }) {
  const handleRef = useRef<HTMLDivElement>(null);
  const drag = useRef<PointerDrag | null>(null);

  useEffect(() => {
    const handle = handleRef.current;
    if (!handle) return;
    const target = { controls, kind };
    const initial = measure(handle, target);
    if (!initial) return;

    function sync() {
      if (!handle) return;
      const split = measure(handle, target);
      if (!split) return;
      const height = clampHeight(split, split.height);
      if (height !== split.pane.offsetHeight) resize(split, height);
      handle.setAttribute('aria-valuemin', String(split.min));
      handle.setAttribute('aria-valuemax', String(split.max));
      handle.setAttribute('aria-valuenow', String(height));
    }

    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(initial.pane);
    if (kind === 'editor' && handle.parentElement) observer.observe(handle.parentElement);
    if (kind === 'result') {
      const table = initial.pane.querySelector('table');
      if (table) observer.observe(table);
    }
    window.addEventListener('resize', sync);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', sync);
      const current = drag.current;
      if (current) {
        window.cancelAnimationFrame(current.frame);
        drag.current = null;
        delete handle.dataset.dragging;
        clearDraft(handle);
        if (handle.hasPointerCapture(current.pointer)) handle.releasePointerCapture(current.pointer);
      }
    };
  }, [controls, kind]);

  function onPointerDown(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || !event.isPrimary) return;
    const handle = event.currentTarget;
    const split = measure(handle, { controls, kind });
    if (!split) return;
    const viewport = kind === 'result' ? handle.closest<HTMLElement>('.results-scroll') : null;
    const bounds = handle.getBoundingClientRect();
    event.preventDefault();
    handle.dataset.pointerFocus = '';
    handle.focus({ preventScroll: true });
    handle.setPointerCapture(event.pointerId);
    handle.dataset.dragging = '';
    drag.current = {
      handle,
      pointer: event.pointerId,
      startY: event.clientY,
      y: event.clientY,
      split,
      viewport,
      startScroll: viewport?.scrollTop ?? 0,
      grabOffset: event.clientY - bounds.top,
      handleHeight: bounds.height,
      appliedHeight: split.height,
      draftHeight: null,
      frame: 0,
    };
  }

  function onPointerMove(event: PointerEvent<HTMLDivElement>) {
    const current = drag.current;
    if (current?.pointer !== event.pointerId) return;
    current.y = event.clientY;
    updateDrag(current, heightAtPointer(current, current.viewport?.getBoundingClientRect()));
    if (!current.viewport || current.frame) return;

    let previous = performance.now();
    const step = (time: number) => {
      current.frame = 0;
      if (drag.current !== current) return;
      const elapsed = Math.min(32, Math.max(0, time - previous));
      previous = time;
      if (scrollDuringDrag(current, elapsed)) current.frame = window.requestAnimationFrame(step);
    };
    current.frame = window.requestAnimationFrame(step);
  }

  function stopDragging(event: PointerEvent<HTMLDivElement>) {
    const current = drag.current;
    if (current?.pointer !== event.pointerId) return;
    window.cancelAnimationFrame(current.frame);
    drag.current = null;
    if (event.type === 'pointerup' && current.draftHeight !== null) resize(current.split, current.draftHeight);
    delete event.currentTarget.dataset.dragging;
    clearDraft(event.currentTarget);
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
    const split = measure(event.currentTarget, { controls, kind });
    if (!split) return;
    event.preventDefault();
    delete event.currentTarget.dataset.pointerFocus;
    const height = event.key === 'Home' ? split.min : event.key === 'End' ? split.max :
      split.height + (event.key === 'ArrowUp' ? -RESIZE_STEP : RESIZE_STEP);
    resize(split, height);
    if (kind === 'result') event.currentTarget.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  return (
    <div
      className="vertical-resize-handle"
      ref={handleRef}
      role="separator"
      tabIndex={0}
      aria-label={label}
      aria-orientation="horizontal"
      aria-controls={controls}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={stopDragging}
      onPointerCancel={stopDragging}
      onLostPointerCapture={stopDragging}
      onBlur={(event) => { delete event.currentTarget.dataset.pointerFocus; }}
      onKeyDown={onKeyDown}
    />
  );
}
