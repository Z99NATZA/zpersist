import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import type { EditorView } from '@codemirror/view';
import { ChevronRight, Database, ListFilter, Play, Plus, RefreshCw, Table2, Terminal, X } from 'lucide-react';
import { api, ApiError, problemFromError } from './api';
import type { DatabaseTable, Problem, QueryResponse, ResultTable } from './api';
import { useEditorTabs } from './editorTabs';
import type { EditorTab } from './editorTabs';
import { ErrorNotice } from './ErrorNotice';
import { useI18n } from './i18n';
import { selectedSql, SqlEditor } from './SqlEditor';
import { VerticalResizeHandle } from './VerticalResizeHandle';

const MAX_VISIBLE_RESULTS = 5;
const RESULT_PREVIEW_ROWS = 3;
const RESULT_PREVIEW_PEEK_HEIGHT = 18;
const RESULT_WARNING_CELLS = 10_000;
const RESULT_WARNING_TEXT_LENGTH = 1_000_000;
const MAX_EXPLORER_STRETCH = 26;
const EXPLORER_SPRING_RATE = 0.038;

type ExplorerScrollMotion = {
  direction: number;
  edge: number;
  position: number;
  velocity: number;
  target: number;
  idleTime: number;
};

type ReportedProblem = {
  problem: Problem;
  reportedAt: number;
};

export type WorkspaceProblem = ReportedProblem & {
  source: 'databases' | 'tables' | 'logout';
  database?: string;
};

type UpdateWorkspaceProblem = (source: WorkspaceProblem['source'], problem: Problem | null, database?: string) => void;

type TabQuery = {
  running: boolean;
  response: QueryResponse | null;
  visible: number[];
  issue: ReportedProblem | null;
};

const EMPTY_QUERY: TabQuery = { running: false, response: null, visible: [], issue: null };

function hasLargeResults(results: ResultTable[], visible: number[]): boolean {
  let cells = 0;
  let textLength = 0;
  for (const index of visible) {
    const { columns, rows } = results[index];
    cells += rows.length * (columns.length + 1);
    if (cells >= RESULT_WARNING_CELLS) return true;
    for (const row of rows) {
      for (const cell of row) {
        textLength += cell?.length ?? 0;
        if (textLength >= RESULT_WARNING_TEXT_LENGTH) return true;
      }
    }
  }
  return false;
}

export function Workspace({ storageKey, vimEnabled, issue, updateProblem, onSessionExpired }: {
  storageKey: string;
  vimEnabled: boolean;
  issue: WorkspaceProblem | null;
  updateProblem: UpdateWorkspaceProblem;
  onSessionExpired: () => void;
}) {
  const { t } = useI18n();
  const { state: editorTabs, update: updateEditorTabs } = useEditorTabs(storageKey);
  const { tabs, activeId } = editorTabs;
  const tab = tabs.find((item) => item.id === activeId) ?? tabs[0];
  const { sql, database } = tab;
  const [queries, setQueries] = useState<Record<number, TabQuery>>({});
  const { running, response, visible, issue: queryIssue } = queries[activeId] ?? EMPTY_QUERY;
  const [databases, setDatabases] = useState<string[] | null>(null);
  const [databasesOpen, setDatabasesOpen] = useState(true);
  const [tablesOpen, setTablesOpen] = useState(true);
  const [loadingDatabases, setLoadingDatabases] = useState(true);
  const [selectionSize, setSelectionSize] = useState<number | null>(null);
  const [picking, setPicking] = useState(false);
  const [closingTab, setClosingTab] = useState<number | null>(null);
  const [autoFocusEditor, setAutoFocusEditor] = useState(false);
  const databaseSelect = useRef<HTMLSelectElement>(null);
  const errorNotice = useRef<HTMLDivElement>(null);
  const editor = useRef<EditorView>(null);
  const activeQueries = useRef(new Map<number, AbortController>());
  const sharedIssue = issue?.source === 'tables' && issue.database !== database ? null : issue;
  const displayedIssue = queryIssue && (!sharedIssue || queryIssue.reportedAt >= sharedIssue.reportedAt)
    ? queryIssue : sharedIssue;
  const databaseRequired = displayedIssue?.problem.code === 'database_required';

  const loadDatabases = useCallback(async () => {
    setLoadingDatabases(true);
    updateProblem('databases', null);
    try {
      const list = await api<string[]>('/databases');
      setDatabases(list);
      const available = new Set(list);
      updateEditorTabs((current) => current.tabs.some((item) => item.database && !available.has(item.database)) ?
        { ...current, tabs: current.tabs.map((item) => available.has(item.database) || !item.database ? item : { ...item, database: '' }) } :
        current);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) onSessionExpired();
      else updateProblem('databases', problemFromError(error));
    } finally {
      setLoadingDatabases(false);
    }
  }, [onSessionExpired, updateEditorTabs, updateProblem]);

  useEffect(() => { void loadDatabases(); }, [loadDatabases]);

  useLayoutEffect(() => {
    document.getElementById(`sql-tab-${activeId}`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [activeId]);

  useEffect(() => {
    if (!displayedIssue) return;
    const notice = errorNotice.current;
    notice?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    const select = databaseSelect.current;
    const target = databaseRequired && select && !select.disabled ? select : notice;
    target?.focus({ preventScroll: true });
  }, [displayedIssue, databaseRequired]);

  function updateTab(change: Partial<Pick<EditorTab, 'sql' | 'database'>>) {
    updateEditorTabs((current) => ({
      ...current,
      tabs: current.tabs.map((item) => item.id === activeId ? { ...item, ...change } : item),
    }));
  }

  function updateQuery(id: number, change: Partial<TabQuery>) {
    setQueries((current) => ({ ...current, [id]: { ...(current[id] ?? EMPTY_QUERY), ...change } }));
  }

  function resetEditorSelection() {
    setSelectionSize(null);
    setPicking(false);
  }

  function activateTab(id: number) {
    if (id === activeId) return;
    setAutoFocusEditor(false);
    resetEditorSelection();
    updateEditorTabs((current) => ({ ...current, activeId: id }));
  }

  function addTab() {
    setAutoFocusEditor(true);
    resetEditorSelection();
    updateEditorTabs((current) => ({
      tabs: [...current.tabs, { id: current.nextId, sql: '', database }],
      activeId: current.nextId,
      nextId: current.nextId + 1,
    }));
  }

  function confirmCloseTab() {
    if (closingTab === null || tabs.length < 2) return;
    const id = closingTab;
    activeQueries.current.get(id)?.abort();
    activeQueries.current.delete(id);
    setQueries((current) => {
      const updated = { ...current };
      delete updated[id];
      return updated;
    });
    if (id === activeId) {
      setAutoFocusEditor(true);
      resetEditorSelection();
    }
    updateEditorTabs((current) => {
      const index = current.tabs.findIndex((item) => item.id === id);
      const remaining = current.tabs.filter((item) => item.id !== id);
      const activeId = current.activeId === id ? remaining[Math.min(index, remaining.length - 1)].id : current.activeId;
      return { ...current, tabs: remaining, activeId };
    });
    setClosingTab(null);
  }

  function tabTitle(id: number) {
    return id === 1 ? t('queryEditor') : t('numberedQueryTab', { number: id });
  }

  function tabKeys(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const { key } = event;
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(key)) return;
    event.preventDefault();
    const last = tabs.length - 1;
    const next = key === 'Home' ? 0 : key === 'End' ? last :
      (index + (key === 'ArrowLeft' ? last : 1)) % tabs.length;
    activateTab(tabs[next].id);
    document.getElementById(`sql-tab-${tabs[next].id}`)?.focus({ preventScroll: true });
  }

  function chooseDatabase(name: string) {
    updateTab({ database: name });
    if (name !== database) updateProblem('tables', null);
    if (name && queryIssue?.problem.code === 'database_required') updateQuery(activeId, { issue: null });
  }

  async function runSql() {
    const state = editor.current?.state;
    if (!state || activeQueries.current.has(activeId)) return;
    const query = selectedSql(state) ?? state.doc.toString().trim();
    if (!query) return;
    if (!database) {
      updateQuery(activeId, { issue: { problem: { code: 'database_required' }, reportedAt: performance.now() } });
      return;
    }

    const controller = new AbortController();
    activeQueries.current.set(activeId, controller);
    updateQuery(activeId, { ...EMPTY_QUERY, running: true });
    try {
      const data = await api<QueryResponse>('/query', {
        method: 'POST',
        body: { database, sql: query },
        signal: controller.signal,
      });
      if (!controller.signal.aborted) {
        updateQuery(activeId, { response: data, visible: data.results.slice(0, MAX_VISIBLE_RESULTS).map((_, index) => index) });
      }
    } catch (error) {
      if (controller.signal.aborted) return;
      if (error instanceof ApiError && error.status === 401) onSessionExpired();
      else updateQuery(activeId, { issue: { problem: problemFromError(error), reportedAt: performance.now() } });
    } finally {
      if (activeQueries.current.get(activeId) === controller) activeQueries.current.delete(activeId);
      if (!controller.signal.aborted) updateQuery(activeId, { running: false });
    }
  }

  useEffect(() => {
    const pending = activeQueries.current;
    return () => {
      pending.forEach((controller) => controller.abort());
      pending.clear();
    };
  }, []);

  const results = response?.results ?? [];
  const warnAboutResults = useMemo(() => response !== null && hasLargeResults(response.results, visible), [response, visible]);
  const hasSqlToRun = selectionSize === null ? sql.trim().length > 0 : selectionSize > 0;

  return (
    <main className="workspace">
      <div className="command-bar">
        <div className="database-select">
          <label htmlFor="active-database">{t('database')}</label>
          <select
            id="active-database"
            ref={databaseSelect}
            value={database}
            onChange={(event) => chooseDatabase(event.target.value)}
            disabled={!databases?.length || running}
            aria-invalid={databaseRequired || undefined}
            aria-describedby={databaseRequired ? 'workspace-notice' : undefined}
          >
            <option value="">{t('chooseDatabase')}</option>
            {databases?.map((name) => <option key={name} value={name}>{name}</option>)}
          </select>
        </div>
        <button
          className="button button-primary"
          disabled={!hasSqlToRun || running}
          onMouseDown={(event) => event.preventDefault()}
          onClick={runSql}
          title={t('runSqlShortcut')}
        >
          <Play size={15} fill="currentColor" aria-hidden="true" />
          {t(running ? 'running' : 'runSql')}
        </button>
      </div>

      <div className="workspace-body">
        <aside className="explorer workspace-scrollbar" aria-label={t('databases')}>
          <section className="explorer-section" data-expanded={databasesOpen}>
            <div className="pane-header explorer-header">
              <h2>
                <button
                  className="explorer-toggle"
                  aria-expanded={databasesOpen}
                  aria-controls="explorer-databases"
                  onClick={() => setDatabasesOpen((open) => !open)}
                  title={database || undefined}
                >
                  <ChevronRight size={15} aria-hidden="true" />
                  <Database className="explorer-icon" size={16} aria-hidden="true" />
                  <span>{database || t('chooseDatabase')}</span>
                </button>
              </h2>
              <button
                className="button icon-button explorer-refresh"
                aria-label={t('refreshDatabases')}
                title={t('refreshDatabases')}
                disabled={loadingDatabases}
                onClick={loadDatabases}
              ><RefreshCw size={16} aria-hidden="true" /></button>
            </div>
            <div className="explorer-panel" id="explorer-databases" hidden={!databasesOpen}>
              {databases?.length ? <DatabaseList databases={databases} selected={database} disabled={running} onSelect={chooseDatabase} /> :
                loadingDatabases ? <p className="explorer-message" role="status">{t('loadingDatabases')}</p> :
                databases && <p className="explorer-message">{t('noDatabases')}</p>}
            </div>
          </section>

          <DatabaseTables
            key={database}
            database={database}
            open={tablesOpen}
            onToggle={() => setTablesOpen((open) => !open)}
            updateProblem={updateProblem}
            onSessionExpired={onSessionExpired}
          />
        </aside>

        <div className="work-area">
          <section className="editor-pane" id="editor-pane" aria-label={t('queryEditor')}>
            <div className="editor-tabs">
              <div className="editor-tab-list" role="tablist" aria-label={t('queryEditor')}>
                {tabs.map((item, index) => (
                  <div className="editor-tab" role="presentation" key={item.id} data-active={item.id === activeId}>
                    <button
                      type="button"
                      className="editor-tab-label"
                      id={`sql-tab-${item.id}`}
                      role="tab"
                      aria-selected={item.id === activeId}
                      aria-controls="sql-tab-panel"
                      tabIndex={item.id === activeId ? 0 : -1}
                      onClick={() => activateTab(item.id)}
                      onKeyDown={(event) => tabKeys(event, index)}
                    >
                      <Terminal size={15} aria-hidden="true" />
                      <span>{tabTitle(item.id)}</span>
                    </button>
                    {tabs.length > 1 && (
                      <button
                        type="button"
                        className="editor-tab-close"
                        aria-label={t('closeQueryTab', { tab: tabTitle(item.id) })}
                        onClick={() => setClosingTab(item.id)}
                      ><X size={14} aria-hidden="true" /></button>
                    )}
                  </div>
                ))}
              </div>
              <button
                type="button"
                className="button icon-button editor-tab-add"
                aria-label={t('newQueryTab')}
                onClick={addTab}
              ><Plus size={17} aria-hidden="true" /></button>
            </div>
            <div className="editor-panel" id="sql-tab-panel" role="tabpanel" aria-labelledby={`sql-tab-${activeId}`} key={activeId}>
              <SqlEditor
                editor={editor}
                initialSql={sql}
                vimEnabled={vimEnabled}
                autoFocus={autoFocusEditor}
                onChange={(value) => updateTab({ sql: value })}
                onSelectionChange={setSelectionSize}
                onRun={runSql}
              />
            </div>
          </section>

          <VerticalResizeHandle kind="editor" controls="editor-pane" label={t('resizeEditor')} />

          <section className="results-pane">
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
            <div className="results-scroll workspace-scrollbar" role="region" aria-labelledby="results-title" tabIndex={0} key={activeId}>
              <div className="results-content">
                {displayedIssue && (
                  <div className="workspace-notice" id="workspace-notice" ref={errorNotice} tabIndex={-1}>
                    <ErrorNotice problem={displayedIssue.problem} />
                  </div>
                )}
                <div aria-busy={running}>
                  {visible.length ? (
                    <div className="result-stack">
                      {warnAboutResults && <p className="notice result-warning" role="status">{t('largeResultsWarning')}</p>}
                      {visible.map((index) => (
                        <Fragment key={index}>
                          <ResultGrid index={index} result={results[index]} />
                          <VerticalResizeHandle
                            kind="result"
                            controls={`result-grid-${index}`}
                            label={t('resizeResult', { result: t('resultTitle', { number: index + 1 }) })}
                          />
                        </Fragment>
                      ))}
                    </div>
                  ) : (!displayedIssue || running) && (
                    <div className="empty-results" role="status">
                      <Table2 size={28} strokeWidth={1.5} aria-hidden="true" />
                      <p>{t(running ? 'runningSql' : response ? (results.length ? 'chooseResultsEmpty' : 'noResults') : 'runForResults')}</p>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </section>
        </div>
      </div>
      {picking && <ResultPicker results={results} visible={visible} onClose={() => setPicking(false)} onApply={(next) => { updateQuery(activeId, { visible: next }); setPicking(false); }} />}
      {closingTab !== null && (
        <CloseTabDialog name={tabTitle(closingTab)} onCancel={() => setClosingTab(null)} onConfirm={confirmCloseTab} />
      )}
    </main>
  );
}

function CloseTabDialog({ name, onCancel, onConfirm }: {
  name: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { t } = useI18n();
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { dialog.current?.showModal(); }, []);

  return (
    <dialog
      ref={dialog}
      className="result-dialog"
      aria-labelledby="close-tab-title"
      aria-describedby="close-tab-description"
      onClose={onCancel}
    >
      <div className="dialog-header"><h2 id="close-tab-title">{t('confirmCloseQueryTab', { tab: name })}</h2></div>
      <p className="dialog-description" id="close-tab-description">{t('closeQueryTabWarning')}</p>
      <div className="dialog-footer close-tab-footer">
        <div>
          <button type="button" className="button button-secondary" onClick={() => dialog.current?.close()} autoFocus>{t('cancel')}</button>
          <button type="button" className="button button-primary" onClick={onConfirm}>{t('closeTab')}</button>
        </div>
      </div>
    </dialog>
  );
}

function DatabaseList({ databases, selected, disabled, onSelect }: {
  databases: string[];
  selected: string;
  disabled: boolean;
  onSelect: (name: string) => void;
}) {
  return (
    <ExplorerScrollList>
      {databases.map((name) => (
        <li key={name}>
          <button className="explorer-item database-item" aria-pressed={name === selected} disabled={disabled} onClick={() => onSelect(name)}>
            <Database size={16} aria-hidden="true" /><span>{name}</span>
          </button>
        </li>
      ))}
    </ExplorerScrollList>
  );
}

function ExplorerScrollList({ children }: { children: ReactNode }) {
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
    let motion: ExplorerScrollMotion | undefined;
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

    const scrollPosition = (current: ExplorerScrollMotion) =>
      current.edge + current.direction * Math.max(-scrollEnd, Math.min(0, current.position));

    const syncScroll = () => {
      if (!motion) return;
      const scroll = viewport.scrollTop;
      if (Math.abs(scroll - scrollPosition(motion)) <= 1) return;

      const position = motion.direction * (scroll - motion.edge);
      if (motion.target > 0 && motion.position < 0 && position > motion.position) {
        // A pending browser scroll can carry the list closer to the edge.
        motion.position = position;
      } else {
        reset();
      }
    };

    const extendStretch = (current: number, distance: number) =>
      MAX_EXPLORER_STRETCH - (MAX_EXPLORER_STRETCH - current) * Math.exp(-distance / 140);

    const step = (time: number) => {
      if (!motion) return;
      const elapsed = Math.min(32, Math.max(0, time - previousFrame));
      previousFrame = time;

      if (motion.target > 0) {
        // Let the stretch recede as the wheel goes quiet, keeping its current velocity.
        const releaseTime = Math.min(elapsed, Math.max(0, motion.idleTime + elapsed - 52));
        motion.idleTime += elapsed;
        motion.target *= Math.exp(-releaseTime / 69);
      }

      const before = motion.position;
      const displacement = before - motion.target;
      const momentum = motion.velocity + EXPLORER_SPRING_RATE * displacement;
      const decay = Math.exp(-EXPLORER_SPRING_RATE * elapsed);
      motion.position = motion.target + (displacement + momentum * elapsed) * decay;
      motion.velocity = (motion.velocity - EXPLORER_SPRING_RATE * momentum * elapsed) * decay;

      const settled = motion.target < 0.12 && Math.abs(motion.position - motion.target) < 0.12 &&
        Math.abs(motion.velocity) < 0.012;
      if (settled) motion.position = Math.min(0, motion.target);
      if (before < 0 || motion.position < 0) viewport.scrollTop = scrollPosition(motion);
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
      const wheelDistance = deltaY * pixelsPerUnit;
      syncScroll();
      if (motion) {
        event.preventDefault();
        const distance = motion.direction * wheelDistance;
        if (distance < 0) {
          // Carry the same motion back into the scroll range on a reversal.
          const start = Math.min(0, motion.position, motion.target);
          motion.target = Math.max(-scrollEnd, start + distance);
        } else {
          const excess = distance + Math.min(0, motion.target);
          motion.target = excess > 0 ? extendStretch(Math.max(0, motion.target), excess) : excess;
        }
        motion.idleTime = 0;
        return;
      }

      const direction = Math.sign(wheelDistance);
      const edge = direction < 0 ? 0 : scrollEnd;
      const distance = Math.abs(wheelDistance);
      const remaining = Math.max(0, direction * (edge - viewport.scrollTop));
      const excess = distance - remaining;
      if (excess <= 0) return;

      event.preventDefault();
      const target = extendStretch(0, excess);
      motion = {
        direction,
        edge,
        position: -remaining,
        velocity: Math.min(distance, remaining + target) / 68,
        target,
        idleTime: 0,
      };
      previousFrame = performance.now();
      frame = window.requestAnimationFrame(step);
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
    viewport.addEventListener('scroll', syncScroll, { passive: true });
    reducedMotion.addEventListener('change', reset);
    return () => {
      resize.disconnect();
      viewport.removeEventListener('wheel', onWheel);
      viewport.removeEventListener('scroll', syncScroll);
      reducedMotion.removeEventListener('change', reset);
      reset();
    };
  }, []);

  return (
    <div className="explorer-scroll workspace-scrollbar" ref={viewportRef}>
      <div className="explorer-scroll-track" ref={trackRef}>
        <ul className="explorer-list" ref={listRef}>{children}</ul>
      </div>
    </div>
  );
}

function DatabaseTables({ database, open, onToggle, updateProblem, onSessionExpired }: {
  database: string;
  open: boolean;
  onToggle: () => void;
  updateProblem: UpdateWorkspaceProblem;
  onSessionExpired: () => void;
}) {
  const { t } = useI18n();
  const [tables, setTables] = useState<DatabaseTable[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshCount, setRefreshCount] = useState(0);
  const expanded = !!database && open;

  useEffect(() => {
    if (!database) return;
    const controller = new AbortController();
    const search = new URLSearchParams({ database });
    void api<DatabaseTable[]>(`/tables?${search}`, { signal: controller.signal })
      .then((list) => {
        if (!controller.signal.aborted) setTables(list);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        if (error instanceof ApiError && error.status === 401) onSessionExpired();
        else updateProblem('tables', problemFromError(error), database);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [database, onSessionExpired, refreshCount, updateProblem]);

  function refreshTables() {
    setLoading(true);
    updateProblem('tables', null);
    setRefreshCount((count) => count + 1);
  }

  return (
    <section className="explorer-section explorer-tables" data-expanded={expanded}>
      <div className="pane-header explorer-header">
        <h2>
          <button
            className="explorer-toggle"
            aria-expanded={expanded}
            aria-controls="explorer-tables"
            disabled={!database}
            onClick={onToggle}
          >
            <ChevronRight size={15} aria-hidden="true" />
            <Table2 className="explorer-icon" size={16} aria-hidden="true" />
            <span>{t('tables')}</span>
          </button>
        </h2>
        <button
          className="button icon-button explorer-refresh"
          aria-label={t('refreshTables')}
          title={t('refreshTables')}
          disabled={!database || loading}
          onClick={refreshTables}
        ><RefreshCw size={16} aria-hidden="true" /></button>
      </div>
      <div className="explorer-panel" id="explorer-tables" hidden={!expanded} aria-busy={!!database && loading}>
        {database && (tables?.length ? (
          <ExplorerScrollList>
            {tables.map(({ schema, name }) => {
              const label = `${schema}.${name}`;
              return (
                <li className="explorer-item" key={JSON.stringify([schema, name])} title={label}>
                  <Table2 size={16} aria-hidden="true" /><span>{label}</span>
                </li>
              );
            })}
          </ExplorerScrollList>
        ) : loading ? <p className="explorer-message" role="status">{t('loadingTables')}</p> :
          tables && <p className="explorer-message">{t('noTables')}</p>)}
      </div>
    </section>
  );
}

function ResultGrid({ index, result }: { index: number; result: ResultTable }) {
  const { t, number } = useI18n();
  const viewportRef = useRef<HTMLDivElement>(null);
  const title = t('resultTitle', { number: index + 1 });
  const count = result.rows.length;
  const rows = t(count === 1 ? 'rowCount' : 'rowsCount', { count });

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    const table = viewport?.querySelector('table');
    const bodyRows = table?.tBodies[0]?.rows;
    const nextRow = bodyRows?.item(RESULT_PREVIEW_ROWS);
    if (!viewport || !table || !bodyRows || !nextRow) return;

    let frame = 0;
    const fitPreview = () => {
      frame = 0;
      const shownHeight = nextRow.getBoundingClientRect().top - table.getBoundingClientRect().top;
      const horizontalBar = viewport.offsetHeight - viewport.clientHeight;
      const height = `${shownHeight + horizontalBar + RESULT_PREVIEW_PEEK_HEIGHT}px`;
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
    for (let index = 0; index < RESULT_PREVIEW_ROWS; index++) observer.observe(bodyRows[index]);
    return () => {
      observer.disconnect();
      window.cancelAnimationFrame(frame);
      viewport.style.removeProperty('--result-preview-height');
    };
  }, [result]);

  return (
    <section className="result-grid" id={`result-grid-${index}`} aria-labelledby={`result-title-${index}`}>
      <div className="result-title">
        <h3 id={`result-title-${index}`}><Table2 size={15} aria-hidden="true" />{title}</h3>
        <span>{result.truncated ? t('truncatedRows', { rows }) : rows}</span>
      </div>
      <div className="table-scroll workspace-scrollbar" ref={viewportRef} role="region" aria-label={t('resultData', { result: title })} tabIndex={0}>
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
