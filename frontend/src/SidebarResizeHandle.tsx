import { useLayoutEffect, useRef } from 'react';
import type { KeyboardEvent, PointerEvent } from 'react';

const RESIZE_STEP = 24;

type SidebarDrag = {
  pointer: number;
  startX: number;
  startWidth: number;
  x: number;
};

function measure(handle: HTMLDivElement) {
  const layout = handle.parentElement;
  const sidebar = handle.previousElementSibling;
  if (!layout || !sidebar || !handle.offsetWidth) return null;

  const styles = getComputedStyle(layout);
  const min = Number.parseFloat(styles.getPropertyValue('--explorer-min-width'));
  const sidebarMax = Number.parseFloat(styles.getPropertyValue('--explorer-max-width'));
  const editorMin = Number.parseFloat(styles.getPropertyValue('--work-area-min-width'));
  const max = Math.max(min, Math.min(sidebarMax, layout.clientWidth - handle.offsetWidth - editorMin));
  return { layout, min, max, width: sidebar.getBoundingClientRect().width };
}

type Split = NonNullable<ReturnType<typeof measure>>;

function clampWidth(split: Split, width: number) {
  return Math.max(split.min, Math.min(Math.round(width), split.max));
}

function pointerWidth(drag: SidebarDrag) {
  return drag.startWidth + drag.x - drag.startX;
}

function showDraft(handle: HTMLDivElement, split: Split, drag: SidebarDrag) {
  handle.style.setProperty('--resize-draft-offset', `${clampWidth(split, pointerWidth(drag)) - split.width}px`);
}

function resize(split: Split, width: number) {
  const next = clampWidth(split, width);
  if (next !== split.width) split.layout.style.setProperty('--explorer-width', `${next}px`);
}

export function SidebarResizeHandle({ controls, label }: { controls: string; label: string }) {
  const handleRef = useRef<HTMLDivElement>(null);
  const drag = useRef<SidebarDrag | null>(null);

  function clearDrag(handle: HTMLDivElement) {
    const current = drag.current;
    if (!current) return;
    drag.current = null;
    delete handle.dataset.dragging;
    handle.style.removeProperty('--resize-draft-offset');
    if (handle.hasPointerCapture(current.pointer)) handle.releasePointerCapture(current.pointer);
  }

  useLayoutEffect(() => {
    const handle = handleRef.current;
    const layout = handle?.parentElement;
    const sidebar = handle?.previousElementSibling;
    if (!handle || !layout || !sidebar) return;

    function sync() {
      if (!handle) return;
      const split = measure(handle);
      if (!split) {
        clearDrag(handle);
        return;
      }
      handle.setAttribute('aria-valuemin', String(split.min));
      handle.setAttribute('aria-valuemax', String(split.max));
      handle.setAttribute('aria-valuenow', String(Math.round(split.width)));
      if (drag.current) showDraft(handle, split, drag.current);
    }

    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(layout);
    observer.observe(sidebar);
    return () => {
      observer.disconnect();
      clearDrag(handle);
    };
  }, []);

  function startDrag(event: PointerEvent<HTMLDivElement>) {
    if (!event.isPrimary || event.button !== 0 || drag.current) return;
    const handle = event.currentTarget;
    const split = measure(handle);
    if (!split) return;

    event.preventDefault();
    handle.focus({ preventScroll: true });
    handle.setPointerCapture(event.pointerId);
    drag.current = { pointer: event.pointerId, startX: event.clientX, startWidth: split.width, x: event.clientX };
    handle.dataset.dragging = '';
  }

  function moveDrag(event: PointerEvent<HTMLDivElement>) {
    const current = drag.current;
    if (current?.pointer !== event.pointerId) return;
    current.x = event.clientX;
    const split = measure(event.currentTarget);
    if (split) showDraft(event.currentTarget, split, current);
  }

  function finishDrag(event: PointerEvent<HTMLDivElement>) {
    const current = drag.current;
    if (current?.pointer !== event.pointerId) return;
    const handle = event.currentTarget;
    clearDrag(handle);
    if (event.type !== 'pointerup') return;
    const split = measure(handle);
    current.x = event.clientX;
    if (split) resize(split, pointerWidth(current));
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const handle = event.currentTarget;
    if (drag.current) {
      if (event.key === 'Escape') {
        event.preventDefault();
        clearDrag(handle);
      }
      return;
    }

    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const split = measure(handle);
    if (!split) return;
    event.preventDefault();
    const width = event.key === 'Home' ? split.min : event.key === 'End' ? split.max :
      split.width + (event.key === 'ArrowLeft' ? -RESIZE_STEP : RESIZE_STEP);
    resize(split, width);
  }

  return (
    <div
      className="sidebar-resize-handle"
      ref={handleRef}
      role="separator"
      tabIndex={0}
      aria-label={label}
      aria-orientation="vertical"
      aria-controls={controls}
      onPointerDown={startDrag}
      onPointerMove={moveDrag}
      onPointerUp={finishDrag}
      onPointerCancel={finishDrag}
      onLostPointerCapture={finishDrag}
      onKeyDown={onKeyDown}
    />
  );
}
