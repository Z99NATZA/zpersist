import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { ChevronDown, Trash2 } from 'lucide-react';
import { useI18n } from './i18n';

interface HistoryOption {
  key: string;
  value: string;
  label?: string;
}

interface HistoryInputProps<Option extends HistoryOption> {
  id: string;
  label: string;
  historyLabel: string;
  value: string;
  options: Option[];
  placeholder?: string;
  autoFocus?: boolean;
  onChange: (value: string) => void;
  onSelect: (option: Option) => void;
  onRemove: (key: string) => void;
}

export function HistoryInput<Option extends HistoryOption>({
  id, label, historyLabel, value, options, placeholder, autoFocus, onChange, onSelect, onRemove,
}: HistoryInputProps<Option>) {
  const { t } = useI18n();
  const input = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [hoveredKey, setHoveredKey] = useState<string | null>(null);
  const query = value.trim().toLowerCase();
  const matches = options.filter((option) => option.value.toLowerCase().includes(query));
  const visible = open && matches.length > 0;
  const listId = `${id}-history`;
  const activeIndex = matches.findIndex((option) => option.key === activeKey);
  const activeId = visible && activeIndex !== -1 ? `${listId}-${activeIndex}` : undefined;
  const highlightedKey = hoveredKey ?? activeKey;

  useEffect(() => {
    if (activeId) document.getElementById(activeId)?.scrollIntoView({ block: 'nearest' });
  }, [activeId]);

  function close() {
    setOpen(false);
    setActiveKey(null);
    setHoveredKey(null);
  }

  function accept(option: Option) {
    onSelect(option);
    close();
    input.current?.focus();
  }

  function remove(key: string) {
    onRemove(key);
    setActiveKey(null);
    setHoveredKey(null);
    input.current?.focus();
  }

  function handleKeys(event: KeyboardEvent<HTMLInputElement>) {
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'Tab') {
      close();
      return;
    }
    if (event.key === 'Escape' && open) {
      event.preventDefault();
      close();
    } else if (event.key === 'Enter' && visible && activeIndex !== -1) {
      event.preventDefault();
      accept(matches[activeIndex]);
    } else if (event.key === 'Delete' && event.shiftKey && visible && activeIndex !== -1) {
      event.preventDefault();
      remove(matches[activeIndex].key);
    } else if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && matches.length > 0) {
      event.preventDefault();
      const down = event.key === 'ArrowDown';
      const next = activeIndex === -1
        ? (down ? 0 : matches.length - 1)
        : (activeIndex + (down ? 1 : -1) + matches.length) % matches.length;
      setOpen(true);
      setHoveredKey(null);
      setActiveKey(matches[next].key);
    }
  }

  return (
    <div className="sign-in-field">
      <label htmlFor={id}>{label}</label>
      <div className="history-input" onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) close();
      }}>
        <input
          ref={input}
          id={id}
          name={id}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={visible}
          aria-controls={visible ? listId : undefined}
          aria-activedescendant={activeId}
          aria-keyshortcuts="Shift+Delete"
          value={value}
          placeholder={placeholder}
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          required
          autoFocus={autoFocus}
          onClick={() => setOpen(true)}
          onKeyDown={handleKeys}
          onChange={(event) => {
            onChange(event.target.value);
            setActiveKey(null);
            setOpen(true);
          }}
        />
        <button
          type="button"
          className="history-toggle"
          aria-label={historyLabel}
          aria-expanded={visible}
          aria-controls={visible ? listId : undefined}
          disabled={matches.length === 0}
          tabIndex={-1}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            input.current?.focus();
            if (visible) close();
            else setOpen(true);
          }}
        ><ChevronDown size={16} aria-hidden="true" /></button>
        {visible && (
          <div
            className="history-popup"
            onPointerOver={(event) => {
              const item = event.target instanceof Element
                ? event.target.closest<HTMLElement>('[data-history-key]')
                : null;
              setHoveredKey(item?.dataset.historyKey ?? null);
            }}
            onPointerLeave={() => setHoveredKey(null)}
          >
            <div id={listId} role="listbox" aria-label={historyLabel}>
              {matches.map((option, index) => (
                <div
                  id={`${listId}-${index}`}
                  key={option.key}
                  role="option"
                  aria-selected={option.key === activeKey}
                  className="history-option"
                  data-history-key={option.key}
                  data-highlighted={option.key === highlightedKey}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => accept(option)}
                >
                  <span className="history-value" title={option.label ?? option.value}>{option.label ?? option.value}</span>
                </div>
              ))}
            </div>
            <div className="history-removals">
              {matches.map((option) => {
                const removeLabel = t('deleteHistoryItem', { value: option.label ?? option.value });
                return (
                  <button
                    type="button"
                    key={option.key}
                    className="history-remove"
                    data-history-key={option.key}
                    data-highlighted={option.key === highlightedKey}
                    aria-label={removeLabel}
                    title={removeLabel}
                    onClick={() => remove(option.key)}
                  ><Trash2 size={15} aria-hidden="true" /></button>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
