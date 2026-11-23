import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { Check, ChevronDown, Search } from 'lucide-react';
import { useI18n } from './i18n';

interface DatabaseSelectProps {
  databases: string[] | null;
  value: string;
  disabled: boolean;
  errorId?: string;
  onChange: (name: string) => void;
}

export function DatabaseSelect({ databases, value, disabled, errorId, onChange }: DatabaseSelectProps) {
  const { t } = useI18n();
  const id = useId();
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const activeOption = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState<string | null>(null);

  const unavailable = disabled || !databases?.length;
  const visible = open && !unavailable;
  const filter = query.trim().toLowerCase();
  const options = visible && databases
    ? (filter ? databases.filter((name) => name.toLowerCase().includes(filter)) : ['', ...databases])
    : [];
  const preferredOption = active ?? (filter ? '' : value);
  const activeIndex = options.length ? Math.max(0, options.indexOf(preferredOption)) : -1;
  const listId = `${id}-list`;
  const activeId = activeIndex === -1 ? undefined : `${listId}-${activeIndex}`;
  const label = t('database');
  const emptyLabel = t('chooseDatabase');
  const searchLabel = t('searchDatabases');

  useLayoutEffect(() => {
    if (visible) search.current?.focus({ preventScroll: true });
    else if (open) setOpen(false);
  }, [open, visible]);

  useLayoutEffect(() => {
    activeOption.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [activeId, filter]);

  useEffect(() => {
    if (!visible) return;

    function dismissOutside(event: PointerEvent) {
      if (event.target instanceof Node && !container.current?.contains(event.target)) setOpen(false);
    }

    document.addEventListener('pointerdown', dismissOutside);
    return () => document.removeEventListener('pointerdown', dismissOutside);
  }, [visible]);

  function openPicker() {
    setQuery('');
    setActive(null);
    setOpen(true);
  }

  function closeAndFocusTrigger() {
    setOpen(false);
    trigger.current?.focus({ preventScroll: true });
  }

  function select(name: string) {
    onChange(name);
    closeAndFocusTrigger();
  }

  function handleSearchKeys(event: KeyboardEvent<HTMLInputElement>) {
    if (event.nativeEvent.isComposing) return;
    const { key } = event;
    if (key === 'Escape' || (key === 'Tab' && event.shiftKey)) {
      event.preventDefault();
      closeAndFocusTrigger();
    } else if (key === 'Enter' && activeIndex !== -1) {
      event.preventDefault();
      select(options[activeIndex]);
    } else if ((key === 'ArrowDown' || key === 'ArrowUp') && activeIndex !== -1) {
      event.preventDefault();
      const step = key === 'ArrowDown' ? 1 : -1;
      setActive(options[(activeIndex + step + options.length) % options.length]);
    }
  }

  return (
    <div className="database-select" ref={container} onBlur={(event) => {
      if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) setOpen(false);
    }}>
      <label id={`${id}-label`} htmlFor="active-database">{label}</label>
      <div className="database-picker">
        <button
          type="button"
          id="active-database"
          className="database-trigger"
          ref={trigger}
          disabled={unavailable}
          aria-labelledby={`${id}-label ${id}-value`}
          aria-haspopup="dialog"
          aria-expanded={visible}
          aria-controls={visible ? `${id}-popup` : undefined}
          aria-invalid={errorId ? true : undefined}
          aria-describedby={errorId}
          title={value || undefined}
          onClick={() => { if (visible) closeAndFocusTrigger(); else openPicker(); }}
          onKeyDown={(event) => {
            if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
            event.preventDefault();
            openPicker();
          }}
        >
          <span id={`${id}-value`}>{value || emptyLabel}</span>
          <ChevronDown size={15} aria-hidden="true" />
        </button>
        {visible && (
          <div className="database-popup" id={`${id}-popup`} role="dialog" aria-labelledby={`${id}-label`}>
            <div className="database-search">
              <Search size={15} aria-hidden="true" />
              <input
                type="search"
                ref={search}
                role="combobox"
                aria-label={searchLabel}
                aria-autocomplete="list"
                aria-expanded="true"
                aria-controls={listId}
                aria-activedescendant={activeId}
                placeholder={searchLabel}
                value={query}
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
                onKeyDown={handleSearchKeys}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setActive(null);
                }}
              />
            </div>
            <div id={listId} className="database-options workspace-scrollbar" role="listbox" aria-label={t('databases')} tabIndex={-1}>
              {options.map((name, index) => (
                <div
                  key={name}
                  id={`${listId}-${index}`}
                  className="database-option"
                  role="option"
                  aria-selected={name === value}
                  data-active={index === activeIndex || undefined}
                  ref={index === activeIndex ? activeOption : undefined}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => select(name)}
                >
                  <span title={name || undefined}>{name || emptyLabel}</span>
                  {name === value && <Check size={15} aria-hidden="true" />}
                </div>
              ))}
            </div>
            {!options.length && <p className="database-no-matches" role="status">{t('noMatchingDatabases')}</p>}
          </div>
        )}
      </div>
    </div>
  );
}
