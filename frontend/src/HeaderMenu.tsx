import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { Check } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

interface HeaderMenuProps<Value extends string> {
  label: string;
  icon: LucideIcon;
  value: Value;
  options: { value: Value; label: string; lang?: string }[];
  onChange: (value: Value) => void;
}

export function HeaderMenu<Value extends string>({ label, icon: Icon, value, options, onChange }: HeaderMenuProps<Value>) {
  const menuId = useId();
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const selectedOption = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);

  useLayoutEffect(() => {
    if (open) selectedOption.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;

    function dismissOutside(event: PointerEvent) {
      if (event.target instanceof Node && !container.current?.contains(event.target)) setOpen(false);
    }

    document.addEventListener('pointerdown', dismissOutside);
    return () => document.removeEventListener('pointerdown', dismissOutside);
  }, [open]);

  function closeAndFocusTrigger() {
    setOpen(false);
    trigger.current?.focus();
  }

  function handleMenuKeys(event: KeyboardEvent<HTMLDivElement>) {
    const { key } = event;
    if (key === 'Escape' || key === 'Tab') {
      if (key === 'Escape') event.preventDefault();
      closeAndFocusTrigger();
      return;
    }

    if (key !== 'ArrowDown' && key !== 'ArrowUp' && key !== 'Home' && key !== 'End') return;
    event.preventDefault();
    const items = Array.from(event.currentTarget.querySelectorAll('button'));
    const current = items.findIndex((item) => item === event.target);
    const step = key === 'ArrowUp' ? -1 : 1;
    const next = key === 'Home' ? 0 : key === 'End' ? items.length - 1 : (current + step + items.length) % items.length;
    items[next]?.focus();
  }

  return (
    <div className="header-menu" ref={container} onBlur={(event) => {
      if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) setOpen(false);
    }}>
      <button
        type="button"
        className="header-menu-trigger"
        ref={trigger}
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        onClick={() => setOpen((current) => !current)}
      >
        <Icon size={17} aria-hidden="true" />
      </button>
      <div id={menuId} className="header-menu-popup" role="menu" aria-label={label} hidden={!open} onKeyDown={handleMenuKeys}>
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            className="header-menu-option"
            role="menuitemradio"
            aria-checked={option.value === value}
            ref={option.value === value ? selectedOption : undefined}
            tabIndex={-1}
            onClick={() => {
              onChange(option.value);
              closeAndFocusTrigger();
            }}
          >
            <span lang={option.lang}>{option.label}</span>
            {option.value === value && <Check size={15} aria-hidden="true" />}
          </button>
        ))}
      </div>
    </div>
  );
}
