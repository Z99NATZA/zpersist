import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import type { EditorView } from '@codemirror/view';
import { ChevronRight, Database, ListFilter, Play, Plus, RefreshCw, Save, Table2, Terminal, X } from 'lucide-react';
import { api, ApiError, problemFromError } from './api';
import type { CellValue, DatabaseTable, Problem, QueryResponse, ResultTable } from './api';
import { DatabaseSelect } from './DatabaseSelect';
import { useEditorTabs } from './editorTabs';
import type { EditorTab } from './editorTabs';
import { ErrorNotice } from './ErrorNotice';
import { useI18n } from './i18n';
import { ResultGrid } from './ResultGrid';
import { applySavedRows, changeDraft, pendingRows } from './resultEdits';
import type { ChangeCell, ResultDrafts } from './resultEdits';
import { SidebarResizeHandle } from './SidebarResizeHandle';
import { selectedSql, SqlEditor, startsWithUse } from './SqlEditor';
import { VerticalResizeHandle } from './VerticalResizeHandle';

const MAX_VISIBLE_RESULTS = 5;
const RESULT_WARNING_CELLS = 10_000;
const RESULT_WARNING_TEXT_LENGTH = 1_000_000;
const MAX_EXPLORER_STRETCH = 26;
const EXPLORER_SPRING_RATE = 0.038;
const EXPLORER_SKELETON_MIN_MS = 320;

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
  saving: boolean;
  response: QueryResponse | null;
  visible: number[];
  issue: ReportedProblem | null;
  drafts: ResultDrafts;
};

const EMPTY_QUERY: TabQuery = { running: false, saving: false, response: null, visible: [], issue: null, drafts: {} };

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
  const { running, saving, response, visible, drafts, issue: queryIssue } = queries[activeId] ?? EMPTY_QUERY;
  const hasDrafts = Object.keys(drafts).length > 0;
  const [databases, setDatabases] = useState<string[] | null>(null);
  const [databasesOpen, setDatabasesOpen] = useState(true);
  const [tablesOpen, setTablesOpen] = useState(true);
  const [loadingDatabases, setLoadingDatabases] = useState(true);
  const [selectionSize, setSelectionSize] = useState<number | null>(null);
  const [picking, setPicking] = useState(false);
  const [closingTab, setClosingTab] = useState<number | null>(null);
  const [replacingResults, setReplacingResults] = useState<string | null>(null);
  const [autoFocusEditor, setAutoFocusEditor] = useState(false);
  const errorNotice = useRef<HTMLDivElement>(null);
  const editor = useRef<EditorView>(null);
  const activeQueries = useRef(new Map<number, AbortController>());
  const sharedIssue = issue?.source === 'tables' && issue.database !== database ? null : issue;
  const displayedIssue = queryIssue && (!sharedIssue || queryIssue.reportedAt >= sharedIssue.reportedAt)
    ? queryIssue : sharedIssue;
  const isQueryIssue = displayedIssue === queryIssue;
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
    if (!isQueryIssue && !editor.current?.hasFocus) notice?.focus({ preventScroll: true });
  }, [displayedIssue, isQueryIssue]);

  function updateTab(change: Partial<Pick<EditorTab, 'sql' | 'database'>>) {
    updateEditorTabs((current) => ({
      ...current,
      tabs: current.tabs.map((item) => item.id === activeId ? { ...item, ...change } : item),
    }));
  }

  function updateQuery(id: number, change: Partial<TabQuery>) {
    setQueries((current) => ({ ...current, [id]: { ...(current[id] ?? EMPTY_QUERY), ...change } }));
  }

  const editCell = useCallback<ChangeCell>((result, row, column, value) => {
    setQueries((current) => {
      const tabQuery = current[activeId];
      if (!tabQuery?.response || tabQuery.saving) return current;
      const original = tabQuery.response.results[result].rows[row][column];
      const drafts = changeDraft(tabQuery.drafts, result, row, column, original, value);
      if (drafts === tabQuery.drafts) return current;
      return { ...current, [activeId]: { ...tabQuery, drafts } };
    });
  }, [activeId]);

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
    if (closingTab === null || tabs.length < 2 || queries[closingTab]?.saving) return;
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

  function runSql() {
    const view = editor.current;
    if (!view || activeQueries.current.has(activeId)) return;
    const { state } = view;
    const query = selectedSql(state) ?? state.doc.toString().trim();
    if (!query) return;
    if (!view.hasFocus) view.focus();
    if (!database && !startsWithUse(query)) {
      updateQuery(activeId, { issue: { problem: { code: 'database_required' }, reportedAt: performance.now() } });
      return;
    }
    if (hasDrafts) setReplacingResults(query);
    else void executeSql(query);
  }

  async function executeSql(query: string) {
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

  async function saveEdits() {
    if (!response || !hasDrafts || activeQueries.current.has(activeId)) return;
    const controller = new AbortController();
    activeQueries.current.set(activeId, controller);
    updateQuery(activeId, { saving: true, issue: null });
    try {
      const pending = pendingRows(response.results, drafts);
      const rows = pending.map((row) => ({
        ...row,
        changes: row.changes.map(({ column, original, value }) => ({ column, original, value })),
      }));
      const saved = await api<CellValue[][]>('/query/edits', {
        method: 'POST',
        body: { rows },
        signal: controller.signal,
      });
      if (!controller.signal.aborted) {
        updateQuery(activeId, { response: applySavedRows(response, pending, saved), drafts: {} });
      }
    } catch (error) {
      if (controller.signal.aborted) return;
      if (error instanceof ApiError && error.status === 401) onSessionExpired();
      else updateQuery(activeId, { issue: { problem: problemFromError(error), reportedAt: performance.now() } });
    } finally {
      if (activeQueries.current.get(activeId) === controller) activeQueries.current.delete(activeId);
      if (!controller.signal.aborted) updateQuery(activeId, { saving: false });
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
        <DatabaseSelect
          databases={databases}
          value={database}
          disabled={running}
          errorId={databaseRequired ? 'workspace-notice' : undefined}
          onChange={chooseDatabase}
        />
        <button
          className="button button-primary"
          disabled={!hasSqlToRun || running || saving}
          onMouseDown={(event) => event.preventDefault()}
          onClick={runSql}
          title={t('runSqlShortcut')}
        >
          <Play size={15} fill="currentColor" aria-hidden="true" />
          {t(running ? 'running' : 'runSql')}
        </button>
      </div>

      <div className="workspace-body">
        <aside id="explorer-pane" className="explorer workspace-scrollbar" aria-label={t('databases')}>
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
                data-loading={loadingDatabases || undefined}
                aria-label={t('refreshDatabases')}
                title={t('refreshDatabases')}
                disabled={loadingDatabases}
                onClick={loadDatabases}
              ><RefreshCw size={16} aria-hidden="true" /></button>
            </div>
            <ExplorerListPanel
              id="explorer-databases"
              open={databasesOpen}
              loading={loadingDatabases}
              loadingLabel={t('loadingDatabases')}
              emptyLabel={databases ? t('noDatabases') : undefined}
            >
              {databases?.length ? <DatabaseList databases={databases} selected={database} disabled={running} onSelect={chooseDatabase} /> : null}
            </ExplorerListPanel>
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

        <SidebarResizeHandle controls="explorer-pane" label={t('resizeSidebar')} />

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
                        disabled={queries[item.id]?.saving}
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
                <h2 id="results-title">
                  <button
                    type="button"
                    className="button button-secondary"
                    aria-haspopup="dialog"
                    title={results.length ? t('chooseResultsCount', { visible: visible.length, total: results.length }) : undefined}
                    disabled={!results.length || running}
                    onClick={() => setPicking(true)}
                  >
                    <ListFilter size={16} aria-hidden="true" />
                    {t('results')}
                  </button>
                </h2>
                {response && <span className="query-metrics">{t('elapsedTime', { count: response.elapsed_ms })}</span>}
              </div>
              <button type="button" className="button button-primary" disabled={!hasDrafts || running || saving} onClick={saveEdits}>
                <Save size={15} aria-hidden="true" />
                {t(saving ? 'savingResults' : 'saveResults')}
              </button>
            </div>
            <div className="results-scroll workspace-scrollbar" role="region" aria-labelledby="results-title" tabIndex={0} key={activeId}>
              <div className="results-content">
                {displayedIssue && (
                  <div className="workspace-notice" id="workspace-notice" ref={errorNotice} tabIndex={-1}>
                    <ErrorNotice problem={displayedIssue.problem} />
                  </div>
                )}
                <div aria-busy={running || saving}>
                  {visible.length ? (
                    <div className="result-stack">
                      {warnAboutResults && <p className="notice result-warning" role="status">{t('largeResultsWarning')}</p>}
                      {visible.map((index) => (
                        <Fragment key={index}>
                          <ResultGrid index={index} result={results[index]} draft={drafts[index]} saving={saving} onChange={editCell} />
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
        <ConfirmationDialog
          title={t('confirmCloseQueryTab', { tab: tabTitle(closingTab) })}
          description={t(Object.keys(queries[closingTab]?.drafts ?? {}).length ? 'closeQueryTabDraftWarning' : 'closeQueryTabWarning')}
          confirmLabel={t('closeTab')}
          onCancel={() => setClosingTab(null)}
          onConfirm={confirmCloseTab}
        />
      )}
      {replacingResults !== null && (
        <ConfirmationDialog
          title={t('confirmReplaceResults')}
          description={t('replaceResultsWarning')}
          confirmLabel={t('runSql')}
          onCancel={() => setReplacingResults(null)}
          onConfirm={() => { setReplacingResults(null); void executeSql(replacingResults); }}
        />
      )}
    </main>
  );
}

function ConfirmationDialog({ title, description, confirmLabel, onCancel, onConfirm }: {
  title: string;
  description: string;
  confirmLabel: string;
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
      aria-labelledby="confirmation-title"
      aria-describedby="confirmation-description"
      onClose={onCancel}
    >
      <div className="dialog-header"><h2 id="confirmation-title">{title}</h2></div>
      <p className="dialog-description" id="confirmation-description">{description}</p>
      <div className="dialog-footer close-tab-footer">
        <div>
          <button type="button" className="button button-secondary" onClick={() => dialog.current?.close()} autoFocus>{t('cancel')}</button>
          <button type="button" className="button button-primary" onClick={() => { dialog.current?.close(); onConfirm(); }}>{confirmLabel}</button>
        </div>
      </div>
    </dialog>
  );
}

function ExplorerListPanel({ id, open, loading, loadingLabel, emptyLabel, children }: {
  id: string;
  open: boolean;
  loading: boolean;
  loadingLabel: string;
  emptyLabel?: string;
  children: ReactNode;
}) {
  const [visible, setVisible] = useState(loading);
  const startedAt = useRef<number | null>(null);

  useEffect(() => {
    if (loading) {
      startedAt.current = performance.now();
      setVisible(true);
      return;
    }
    if (startedAt.current === null) return;
    const remaining = EXPLORER_SKELETON_MIN_MS - (performance.now() - startedAt.current);
    if (remaining <= 0) {
      setVisible(false);
      return;
    }
    const timer = window.setTimeout(() => setVisible(false), remaining);
    return () => window.clearTimeout(timer);
  }, [loading]);

  const skeleton = loading || visible;
  return (
    <>
      <span className="explorer-status" role="status">{loading ? loadingLabel : ''}</span>
      <div className="explorer-panel" id={id} hidden={!open} aria-busy={skeleton}>
        {children || skeleton ? (
          <ExplorerScrollList skeleton={skeleton}>
            {children ?? Array.from({ length: 6 }, (_, index) => <li className="explorer-item explorer-placeholder" key={index} />)}
          </ExplorerScrollList>
        ) : emptyLabel && <p className="explorer-message">{emptyLabel}</p>}
      </div>
    </>
  );
}

function DatabaseList({ databases, selected, disabled, onSelect }: {
  databases: string[];
  selected: string;
  disabled: boolean;
  onSelect: (name: string) => void;
}) {
  return databases.map((name) => (
    <li key={name}>
      <button className="explorer-item database-item" aria-pressed={name === selected} disabled={disabled} onClick={() => onSelect(name)}>
        <Database size={16} aria-hidden="true" /><span>{name}</span>
      </button>
    </li>
  ));
}

function ExplorerScrollList({ skeleton, children }: { skeleton: boolean; children: ReactNode }) {
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
        <ul className="explorer-list" ref={listRef} data-skeleton={skeleton || undefined} inert={skeleton}>{children}</ul>
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
          data-loading={(!!database && loading) || undefined}
          aria-label={t('refreshTables')}
          title={t('refreshTables')}
          disabled={!database || loading}
          onClick={refreshTables}
        ><RefreshCw size={16} aria-hidden="true" /></button>
      </div>
      <ExplorerListPanel
        id="explorer-tables"
        open={expanded}
        loading={!!database && loading}
        loadingLabel={t('loadingTables')}
        emptyLabel={tables ? t('noTables') : undefined}
      >
        {tables?.length ? tables.map(({ schema, name }) => {
          const label = `${schema}.${name}`;
          return (
            <li className="explorer-item" key={JSON.stringify([schema, name])} title={label}>
              <Table2 size={16} aria-hidden="true" /><span>{label}</span>
            </li>
          );
        }) : null}
      </ExplorerListPanel>
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
