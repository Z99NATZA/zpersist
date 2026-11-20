import { useCallback, useEffect, useRef, useState } from 'react';
import type { KeyboardEvent, UIEvent } from 'react';
import { Database, ListFilter, Play, RefreshCw, Table2, Terminal } from 'lucide-react';
import { api, ApiError, problemFromError } from './api';
import type { Problem, QueryResponse, ResultTable } from './api';
import { ErrorNotice } from './ErrorNotice';
import { useI18n } from './i18n';

const MAX_VISIBLE_RESULTS = 5;
const INITIAL_SQL = 'SELECT DB_NAME() AS [database_name];\nSELECT SYSDATETIME() AS [server_time];';

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
              <ul className="database-list">
                {databases.map((name) => (
                  <li key={name}>
                    <button className="database-item" aria-pressed={name === database} disabled={running} onClick={() => setDatabase(name)}>
                      <Database size={16} aria-hidden="true" /><span>{name}</span>
                    </button>
                  </li>
                ))}
              </ul>
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
