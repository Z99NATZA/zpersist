import { useEffect, useRef } from 'react';
import type { KeyboardEvent, PointerEvent } from 'react';

const MIN_RESULT_HEIGHT = 88;
const RESIZE_STEP = 24;
const DRAG_SCROLL_EDGE = 36;
const DRAG_SCROLL_SPEED = 0.65;

type ResizeTarget = {
  controls: string;
  kind: 'editor' | 'explorer' | 'result';
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
  const layout = handle.parentElement;
  if (!pane || !layout || !handle.offsetHeight) return null;
  const height = pane.offsetHeight;

  if (kind === 'explorer') {
    const available = layout.clientHeight;
    const listMinimum = Number.parseFloat(getComputedStyle(layout).getPropertyValue('--explorer-list-min-height'));
    const min = Math.min(listMinimum, Math.floor(available / 2));
    const bottom = handle.nextElementSibling;
    const topOpen = pane.dataset.expanded === 'true';
    const bottomOpen = bottom?.getAttribute('data-expanded') === 'true';
    const bottomHeight = topOpen || bottomOpen ? 0 : bottom?.getBoundingClientRect().height ?? 0;
    return { pane, height, min, max: available - min, kind, topOpen, bottomOpen, available, bottomHeight };
  }

  if (kind === 'editor') {
    const available = Math.max(0, layout.clientHeight - handle.offsetHeight);
    const editorMinimum = Math.min(120, Math.floor(available * 0.36));
    const resultsPane = handle.nextElementSibling;
    const bottomSpace = resultsPane ? Number.parseFloat(getComputedStyle(resultsPane).paddingBlockEnd) || 0 : 0;
    const resultsMinimum = Math.min(available - editorMinimum, Math.min(136, Math.floor(available * 0.52)) + bottomSpace);
    return { pane, height, min: editorMinimum, max: available - resultsMinimum, kind };
  }

  const max = fullResultHeight(pane);
  return { pane, height: Math.min(height, max), min: MIN_RESULT_HEIGHT, max, kind };
}

type Split = NonNullable<ReturnType<typeof measure>>;
type ExplorerSplit = Extract<Split, { kind: 'explorer' }>;
type ExplorerPane = 'top' | 'bottom';

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
  const next = clampHeight(split, height);
  if (split.kind === 'explorer') {
    if (next !== split.height) split.pane.style.setProperty('--explorer-databases-height', `${next}px`);
    return;
  }
  split.pane.style.height = `${next}px`;
  split.pane.dataset.resized = '';
}

function clearDraft(handle: HTMLDivElement) {
  delete handle.dataset.draft;
  handle.style.removeProperty('--resize-draft-offset');
}

function showDraft(handle: HTMLDivElement, offset: number) {
  handle.dataset.draft = '';
  handle.style.setProperty('--resize-draft-offset', `${offset}px`);
}

function openingPane(split: ExplorerSplit, direction: number) {
  if (direction > 0 && !split.topOpen) return 'top';
  if (direction < 0 && !split.bottomOpen) return 'bottom';
  return null;
}

function showExplorerDraft(handle: HTMLDivElement, split: ExplorerSplit, height: number, opening: ExplorerPane | null) {
  const target = split.topOpen || split.bottomOpen ? clampHeight(split, height) :
    opening === 'top' ? split.available - split.bottomHeight : split.height;
  showDraft(handle, target - split.height);
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
    showDraft(drag.handle, draft - displayedHeight);
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

export function VerticalResizeHandle({ label, controls, kind, onExplorerPaneChange }: ResizeTarget & {
  label: string;
  onExplorerPaneChange?: (pane: ExplorerPane, open: boolean) => void;
}) {
  const handleRef = useRef<HTMLDivElement>(null);
  const drag = useRef<PointerDrag | null>(null);

  function clearDrag(handle: HTMLDivElement) {
    const current = drag.current;
    if (!current) return;
    window.cancelAnimationFrame(current.frame);
    drag.current = null;
    delete handle.dataset.dragging;
    clearDraft(handle);
    if (handle.hasPointerCapture(current.pointer)) handle.releasePointerCapture(current.pointer);
  }

  function adjustExplorer(handle: HTMLDivElement, split: ExplorerSplit, height: number, direction: number, commit: boolean) {
    const opening = openingPane(split, direction);
    if (split.topOpen && split.bottomOpen) {
      const closing = direction < 0 && height <= split.min ? 'top' :
        direction > 0 && height >= split.max ? 'bottom' : null;
      if (closing) {
        clearDrag(handle);
        onExplorerPaneChange?.(closing, false);
        return;
      }
    } else if (!opening) {
      clearDraft(handle);
      return;
    }

    if (!commit) {
      showExplorerDraft(handle, split, height, opening);
      return;
    }

    if (split.topOpen || split.bottomOpen) resize(split, height);
    if (opening) onExplorerPaneChange?.(opening, true);
  }

  function updateExplorerDrag(current: PointerDrag, commit: boolean) {
    const { handle } = current;
    const split = measure(handle, { controls, kind });
    if (split?.kind === 'explorer') adjustExplorer(handle, split, heightAtPointer(current), current.y - current.startY, commit);
  }

  useEffect(() => {
    const handle = handleRef.current;
    const pane = handle?.ownerDocument.getElementById(controls);
    if (!handle || !pane) return;
    const target = { controls, kind };

    function sync() {
      if (!handle) return;
      const split = measure(handle, target);
      if (!split) {
        clearDrag(handle);
        return;
      }
      const height = split.kind === 'explorer' ? split.height : clampHeight(split, split.height);
      if (split.kind === 'explorer') {
        const current = drag.current;
        if (current) {
          const opening = openingPane(split, current.y - current.startY);
          if ((split.topOpen && split.bottomOpen) || opening) {
            showExplorerDraft(handle, split, heightAtPointer(current), opening);
          } else {
            clearDraft(handle);
          }
        }
      } else if (height !== split.pane.offsetHeight) {
        resize(split, height);
      }
      handle.setAttribute('aria-valuemin', String(Math.min(split.min, height)));
      handle.setAttribute('aria-valuemax', String(Math.max(split.max, height)));
      handle.setAttribute('aria-valuenow', String(height));
    }

    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(pane);
    if (kind !== 'result' && handle.parentElement) observer.observe(handle.parentElement);
    if (kind === 'result') {
      const table = pane.querySelector('table');
      if (table) observer.observe(table);
    }
    window.addEventListener('resize', sync);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', sync);
      clearDrag(handle);
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
    if (kind === 'explorer') {
      updateExplorerDrag(current, false);
      return;
    }
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
    clearDrag(event.currentTarget);
    if (event.type !== 'pointerup') return;
    if (kind === 'explorer') {
      current.y = event.clientY;
      updateExplorerDrag(current, true);
    } else if (current.draftHeight !== null) {
      resize(current.split, current.draftHeight);
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (kind === 'explorer' && drag.current) {
      if (event.key === 'Escape') {
        event.preventDefault();
        clearDrag(event.currentTarget);
      }
      return;
    }
    if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
    const split = measure(event.currentTarget, { controls, kind });
    if (!split) return;
    event.preventDefault();
    delete event.currentTarget.dataset.pointerFocus;
    const direction = event.key === 'Home' || event.key === 'ArrowUp' ? -1 : 1;
    const height = event.key === 'Home' ? split.min : event.key === 'End' ? split.max :
      split.height + direction * RESIZE_STEP;
    if (split.kind === 'explorer') {
      adjustExplorer(event.currentTarget, split, height, direction, true);
      return;
    }
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
