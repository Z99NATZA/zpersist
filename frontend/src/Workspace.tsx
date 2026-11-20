import { useCallback, useEffect, useRef, useState } from 'react';
import type { KeyboardEvent, UIEvent } from 'react';
import { Database, ListFilter, Play, RefreshCw, Table2, Terminal } from 'lucide-react';
import { api, ApiError, problemFromError } from './api';
import type { Problem, QueryResponse, ResultTable } from './api';
import { ErrorNotice } from './ErrorNotice';
import { useI18n } from './i18n';

const MAX_VISIBLE_RESULTS = 5;
const INITIAL_SQL = 'SELECT DB_NAME() AS [database_name];\nSELECT SYSDATETIME() AS [server_time];';
const MAX_DATABASE_STRETCH = 26;
const DATABASE_SPRING_RATE = 0.038;

type DatabaseScrollMotion = {
  direction: number;
  edge: number;
  position: number;
  velocity: number;
  stretch: number;
  idleTime: number;
  recovering: boolean;
};

export function Workspace({ onSessionExpired }: { onSessionExpired: () => void }) {
  const { t, number } = useI18n();
  const [databases, setDatabases] = useState<string[]>([]);
  const [database, setDatabase] = useState('');
  const [loadingDatabases, setLoadingDatabases] = useState(true);
  const [databaseError, setDatabaseError] = useState<Problem | null>(null);
  const [sql, setSql] = useState(INITIAL_SQL);
  const [selectionSize, setSelectionSize] = useState(0);
  const [running, setRunning] = useState(false);
  const [response, setResponse] = useState<QueryResponse | null>(null);
  const [queryError, setQueryError] = useState<Problem | null>(null);
  const [visible, setVisible] = useState<number[]>([]);
  const [picking, setPicking] = useState(false);
  const editor = useRef<HTMLTextAreaElement>(null);
  const lineNumbers = useRef<HTMLDivElement>(null);
  const activeQuery = useRef<AbortController | null>(null);

  const loadDatabases = useCallback(async () => {
    setLoadingDatabases(true);
    setDatabaseError(null);
    try {
      const list = await api<string[]>('/databases');
      setDatabases(list);
      setDatabase((current) => list.includes(current) ? current : (list.find((name) =>
        !['master', 'model', 'msdb', 'tempdb'].includes(name.toLowerCase()),
      ) ?? list[0] ?? ''));
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) onSessionExpired();
      else setDatabaseError(problemFromError(error));
    } finally {
      setLoadingDatabases(false);
    }
  }, [onSessionExpired]);

  useEffect(() => { void loadDatabases(); }, [loadDatabases]);

  function updateSelection() {
    const field = editor.current;
    if (field) {
      setSelectionSize(field.value.slice(field.selectionStart, field.selectionEnd).trim().length);
    }
  }

  function updateScroll(event: UIEvent<HTMLTextAreaElement>) {
    if (lineNumbers.current) lineNumbers.current.scrollTop = event.currentTarget.scrollTop;
  }

  async function runSelection() {
    const field = editor.current;
    if (!field || !database || activeQuery.current) return;
    const selection = field.value.slice(field.selectionStart, field.selectionEnd).trim();
    if (!selection) return;

    const chosenDatabase = database;
    const controller = new AbortController();
    activeQuery.current = controller;
    setRunning(true);
    setQueryError(null);
    setResponse(null);
    setVisible([]);
    try {
      const data = await api<QueryResponse>('/query', {
        method: 'POST',
        body: { database: chosenDatabase, sql: selection },
        signal: controller.signal,
      });
      setResponse(data);
      setVisible(data.results.slice(0, MAX_VISIBLE_RESULTS).map((_, index) => index));
    } catch (error) {
      if (controller.signal.aborted) return;
      if (error instanceof ApiError && error.status === 401) onSessionExpired();
      else setQueryError(problemFromError(error));
    } finally {
      activeQuery.current = null;
      if (!controller.signal.aborted) setRunning(false);
    }
  }

  useEffect(() => () => { activeQuery.current?.abort(); }, []);

  function editorKeys(event: KeyboardEvent<HTMLTextAreaElement>) {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault();
      void runSelection();
    }
  }

  const results = response?.results ?? [];

  return (
    <main className="workspace">
      <div className="command-bar">
        <button
          className="button button-primary"
          disabled={!selectionSize || !database || running}
          onMouseDown={(event) => event.preventDefault()}
          onClick={runSelection}
          title={t('runSelectionShortcut')}
        >
          <Play size={15} fill="currentColor" aria-hidden="true" />
          {t(running ? 'running' : 'runSelection')}
        </button>
        <div className="database-select">
          <label htmlFor="active-database">{t('database')}</label>
          <select id="active-database" value={database} onChange={(event) => setDatabase(event.target.value)} disabled={!databases.length || running}>
            {!databases.length && <option value="">{t('chooseDatabase')}</option>}
            {databases.map((name) => <option key={name} value={name}>{name}</option>)}
          </select>
        </div>
      </div>

      <div className="workspace-body">
        <aside className="explorer" aria-labelledby="explorer-title">
          <div className="pane-header">
            <h2 id="explorer-title">{t('databases')}</h2>
            <button
              className="button icon-button"
              aria-label={t('refreshDatabases')}
              title={t('refreshDatabases')}
              disabled={loadingDatabases}
              onClick={loadDatabases}
            ><RefreshCw size={16} aria-hidden="true" /></button>
          </div>
          {databaseError ? <ErrorNotice problem={databaseError} /> : (
            loadingDatabases && !databases.length ? <p className="explorer-message" role="status">{t('loadingDatabases')}</p> :
            !databases.length ? <p className="explorer-message">{t('noDatabases')}</p> : (
              <DatabaseList databases={databases} selected={database} disabled={running} onSelect={setDatabase} />
            )
          )}
        </aside>

        <div className="work-area">
          <section className="editor-pane" aria-labelledby="editor-title">
            <div className="editor-tabs">
              <div className="editor-tab"><Terminal size={15} aria-hidden="true" /><h1 id="editor-title">{t('queryEditor')}</h1></div>
            </div>
            <div className="editor-body">
              <div className="line-numbers" aria-hidden="true" ref={lineNumbers}>{sql.split('\n').map((_, index) => <div key={index}>{number(index + 1)}</div>)}</div>
              <textarea
                ref={editor}
                aria-label={t('sqlEditor')}
                value={sql}
                onChange={(event) => { setSql(event.target.value); updateSelection(); }}
                onSelect={updateSelection}
                onScroll={updateScroll}
                onKeyDown={editorKeys}
                spellCheck={false}
                autoCapitalize="off"
                wrap="off"
              />
            </div>
            <div className="editor-status">
              <span>{selectionSize ? t(selectionSize === 1 ? 'selectedCharacter' : 'selectedCharacters', { count: selectionSize }) : t('highlightSql')}</span>
              <kbd>{t('keyboardShortcut')}</kbd>
            </div>
          </section>

          <section className="results-pane" aria-labelledby="results-title" aria-busy={running}>
            <div className="pane-header">
              <div className="results-heading">
                <h2 id="results-title">{t('results')}</h2>
                {response && <span className="query-metrics">{t('elapsedTime', { count: response.elapsed_ms })}</span>}
              </div>
              <button className="button button-secondary" disabled={!results.length || running} onClick={() => setPicking(true)}>
                <ListFilter size={16} aria-hidden="true" />
                {results.length ? t('chooseResultsCount', { visible: visible.length, total: results.length }) : t('chooseResults')}
              </button>
            </div>
            {queryError && <ErrorNotice problem={queryError} className="query-notice" />}
            {!queryError && (!visible.length ? (
              <div className="empty-results" role="status">
                <Table2 size={28} strokeWidth={1.5} aria-hidden="true" />
                <p>{t(running ? 'runningSelection' : response ? (results.length ? 'chooseResultsEmpty' : 'noResults') : 'runForResults')}</p>
              </div>
            ) : (
              <div className="result-stack">
                {visible.map((index) => <ResultGrid key={index} index={index} result={results[index]} />)}
              </div>
            ))}
          </section>
        </div>
      </div>
      {picking && <ResultPicker results={results} visible={visible} onClose={() => setPicking(false)} onApply={(next) => { setVisible(next); setPicking(false); }} />}
    </main>
  );
}

function DatabaseList({ databases, selected, disabled, onSelect }: {
  databases: string[];
  selected: string;
  disabled: boolean;
  onSelect: (name: string) => void;
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    const viewport = viewportRef.current;
    const track = trackRef.current;
    const list = listRef.current;
    if (!viewport || !track || !list) return;

    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    let pageHeight = viewport.clientHeight;
    let scrollEnd = viewport.scrollHeight - pageHeight;
    let motion: DatabaseScrollMotion | undefined;
    let offset = 0;
    let frame = 0;
    let previousFrame = 0;

    const setOffset = (nextOffset: number) => {
      if (nextOffset === offset) return;
      offset = nextOffset;
      if (offset === 0) list.style.removeProperty('transform');
      else list.style.transform = `translate3d(0, ${offset}px, 0)`;
    };

    const reset = () => {
      window.cancelAnimationFrame(frame);
      frame = 0;
      motion = undefined;
      setOffset(0);
    };

    const step = (time: number) => {
      if (!motion) return;
      const elapsed = Math.min(32, Math.max(0, time - previousFrame));
      previousFrame = time;

      // Let the spring target recede as the wheel goes quiet, keeping its current velocity.
      const releaseTime = Math.min(elapsed, Math.max(0, motion.idleTime + elapsed - 52));
      motion.idleTime += elapsed;
      motion.stretch *= Math.exp(-releaseTime / 69);

      const before = motion.position;
      const displacement = before - motion.stretch;
      const momentum = motion.velocity + DATABASE_SPRING_RATE * displacement;
      const decay = Math.exp(-DATABASE_SPRING_RATE * elapsed);
      motion.position = motion.stretch + (displacement + momentum * elapsed) * decay;
      motion.velocity = (motion.velocity - DATABASE_SPRING_RATE * momentum * elapsed) * decay;

      const settled = Math.abs(motion.position) < 0.12 && motion.stretch < 0.12 &&
        Math.abs(motion.velocity) < 0.012;
      if (!motion.recovering && (before < 0 || motion.position < 0)) {
        viewport.scrollTop = motion.edge + motion.direction * (settled ? 0 : Math.min(0, motion.position));
      }
      if (settled) {
        reset();
        return;
      }
      setOffset(-motion.direction * Math.max(0, motion.position));
      frame = window.requestAnimationFrame(step);
    };

    const onWheel = (event: WheelEvent) => {
      const { deltaMode, deltaY, deltaX } = event;
      if (reducedMotion.matches || !event.cancelable || event.ctrlKey || event.shiftKey ||
          deltaY === 0 || Math.abs(deltaX) > Math.abs(deltaY) || scrollEnd <= 1) return;

      const pixelsPerUnit = deltaMode === WheelEvent.DOM_DELTA_PAGE ? pageHeight :
        deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : 1;
      const direction = Math.sign(deltaY);
      const edge = direction < 0 ? 0 : scrollEnd;
      const distance = Math.abs(deltaY) * pixelsPerUnit;

      const continuing = motion?.direction === direction && !motion.recovering ? motion : undefined;
      if (!continuing && motion && !motion.recovering) {
        // Let the browser scroll back into the list while the visible stretch settles.
        motion.position = Math.max(0, motion.position);
        motion.velocity = Math.min(0, motion.velocity);
        motion.stretch = 0;
        motion.recovering = true;
      }

      const remaining = continuing ? 0 : Math.max(0, direction * (edge - viewport.scrollTop));
      const excess = distance - remaining;
      if (excess <= 0) return;

      event.preventDefault();
      const currentStretch = continuing?.stretch ?? 0;
      const stretch = MAX_DATABASE_STRETCH -
        (MAX_DATABASE_STRETCH - currentStretch) * Math.exp(-excess / 140);
      if (continuing) {
        continuing.stretch = stretch;
        continuing.idleTime = 0;
        return;
      }

      motion = {
        direction,
        edge,
        position: -remaining - direction * offset,
        velocity: Math.min(distance, remaining + stretch) / 68,
        stretch,
        idleTime: 0,
        recovering: false,
      };
      if (!frame) {
        previousFrame = performance.now();
        frame = window.requestAnimationFrame(step);
      }
    };

    const resize = new ResizeObserver(() => {
      pageHeight = viewport.clientHeight;
      const nextEnd = viewport.scrollHeight - pageHeight;
      if (scrollEnd !== nextEnd) reset();
      scrollEnd = nextEnd;
    });
    resize.observe(viewport);
    resize.observe(track);
    viewport.addEventListener('wheel', onWheel, { passive: false });
    reducedMotion.addEventListener('change', reset);
    return () => {
      resize.disconnect();
      viewport.removeEventListener('wheel', onWheel);
      reducedMotion.removeEventListener('change', reset);
      reset();
    };
  }, []);

  return (
    <div className="database-scroll" ref={viewportRef}>
      <div className="database-scroll-track" ref={trackRef}>
        <ul className="database-list" ref={listRef}>
          {databases.map((name) => (
            <li key={name}>
              <button className="database-item" aria-pressed={name === selected} disabled={disabled} onClick={() => onSelect(name)}>
                <Database size={16} aria-hidden="true" /><span>{name}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function ResultGrid({ index, result }: { index: number; result: ResultTable }) {
  const { t, number } = useI18n();
  const title = t('resultTitle', { number: index + 1 });
  const count = result.rows.length;
  const rows = t(count === 1 ? 'rowCount' : 'rowsCount', { count });
  return (
    <section className="result-grid" aria-labelledby={`result-title-${index}`}>
      <div className="result-title">
        <h3 id={`result-title-${index}`}><Table2 size={15} aria-hidden="true" />{title}</h3>
        <span>{result.truncated ? t('truncatedRows', { rows }) : rows}</span>
      </div>
      <div className="table-scroll" role="region" aria-label={t('resultData', { result: title })} tabIndex={0}>
        <table aria-label={title}>
          <thead>
            <tr><th scope="col">#</th>{result.columns.map((column, i) => <th key={i} scope="col">{column || t('unnamedColumn')}</th>)}</tr>
          </thead>
          <tbody>
            {result.rows.map((row, i) => (
              <tr key={i}>
                <th scope="row">{number(i + 1)}</th>
                {row.map((cell, j) => cell === null ?
                  <td className="null-cell" key={j}>{t('nullValue')}</td> :
                  <td key={j} title={cell}>{cell}</td>,
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function ResultPicker({ results, visible, onClose, onApply }: {
  results: ResultTable[];
  visible: number[];
  onClose: () => void;
  onApply: (selection: number[]) => void;
}) {
  const { t } = useI18n();
  const modal = useRef<HTMLDialogElement>(null);
  const [draft, setDraft] = useState(visible);
  useEffect(() => { modal.current?.showModal(); }, []);

  function toggle(index: number) {
    setDraft((items) => items.includes(index) ? items.filter((item) => item !== index) :
      items.length < MAX_VISIBLE_RESULTS ? [...items, index] : items);
  }

  return (
    <dialog ref={modal} className="result-dialog" aria-labelledby="picker-title" onClose={onClose}>
      <div className="dialog-header"><h2 id="picker-title">{t('chooseResults')}</h2></div>
      <p className="dialog-description">{t('chooseResultsLimit', { limit: MAX_VISIBLE_RESULTS })}</p>
      <fieldset className="result-choices" aria-label={t('resultsToDisplay')}>
        {results.map((result, index) => (
          <label className="result-choice" key={index}>
            <input type="checkbox" checked={draft.includes(index)} disabled={!draft.includes(index) && draft.length === MAX_VISIBLE_RESULTS} onChange={() => toggle(index)} />
            <span>{t('resultTitle', { number: index + 1 })}</span>
            <span className="choice-row-count" aria-hidden="true">{t(result.rows.length === 1 ? 'rowCount' : 'rowsCount', { count: result.rows.length })}</span>
          </label>
        ))}
      </fieldset>
      <div className="dialog-footer">
        <span className="muted" aria-live="polite">{t('selectedResults', { count: draft.length, limit: MAX_VISIBLE_RESULTS })}</span>
        <div>
          <button className="button button-secondary" onClick={() => modal.current?.close()}>{t('cancel')}</button>
          <button className="button button-primary" onClick={() => { modal.current?.close(); onApply([...draft].sort((a, b) => a - b)); }}>{t('apply')}</button>
        </div>
      </div>
    </dialog>
  );
}
