import { ApiError } from './api';
import type { CellValue, EditableResult, QueryResponse, ResultTable } from './api';

export type RowDraft = Partial<Record<number, CellValue>>;
export type GridDraft = Partial<Record<number, RowDraft>>;
export type ResultDrafts = Partial<Record<number, GridDraft>>;
export type ChangeCell = (result: number, row: number, column: number, value: CellValue) => void;

export function changeDraft(drafts: ResultDrafts, result: number, row: number, column: number, original: CellValue, value: CellValue): ResultDrafts {
  const draft = drafts[result]?.[row]?.[column];
  if ((draft === undefined ? original : draft) === value) return drafts;
  const nextRow = { ...drafts[result]?.[row] };
  if (value === original) delete nextRow[column];
  else nextRow[column] = value;

  const nextGrid = { ...drafts[result] };
  if (Object.keys(nextRow).length) nextGrid[row] = nextRow;
  else delete nextGrid[row];

  const next = { ...drafts };
  if (Object.keys(nextGrid).length) next[result] = nextGrid;
  else delete next[result];
  return next;
}

type CellPosition = [result: number, row: number, column: number];
type PendingCell = {
  column: string;
  original: CellValue;
  value: CellValue;
  positions: CellPosition[];
};
type PendingRow = Pick<EditableResult, 'table' | 'object_id'> & {
  key: { column: string; value: string }[];
  changes: PendingCell[];
};

export function pendingRows(results: ResultTable[], drafts: ResultDrafts): PendingRow[] {
  const pending = new Map<string, PendingRow>();
  for (const [resultIndex, grid] of Object.entries(drafts)) {
    const result = results[Number(resultIndex)];
    const editable = result.editable!;
    for (const [rowIndex, rowDraft] of Object.entries(grid!)) {
      const row = result.rows[Number(rowIndex)];
      const key = editable.key.map(({ column, index }) => ({ column, value: row[index]! }));
      const { table, object_id } = editable;
      const identity = JSON.stringify([table, object_id, key]);
      let entry = pending.get(identity);
      if (!entry) {
        entry = { table, object_id, key, changes: [] };
        pending.set(identity, entry);
      }
      for (const [columnIndex, value] of Object.entries(rowDraft!)) {
        const index = Number(columnIndex);
        const column = editable.columns[index]!.column;
        const original = row[index];
        const position: CellPosition = [Number(resultIndex), Number(rowIndex), index];
        const existing = entry.changes.find((change) => change.column === column);
        if (existing) {
          if (existing.value !== value || existing.original !== original) {
            throw new ApiError(409, { code: 'result_edit_duplicate' });
          }
          existing.positions.push(position);
        } else {
          entry.changes.push({ column, original, value: value!, positions: [position] });
        }
      }
    }
  }
  return [...pending.values()];
}

export function applySavedRows(response: QueryResponse, pending: PendingRow[], values: CellValue[][]): QueryResponse {
  const results = [...response.results];
  pending.forEach(({ changes }, rowIndex) => {
    changes.forEach(({ positions }, columnIndex) => {
      for (const [result, row, column] of positions) {
        if (results[result] === response.results[result]) {
          results[result] = { ...results[result], rows: [...results[result].rows] };
        }
        if (results[result].rows[row] === response.results[result].rows[row]) {
          results[result].rows[row] = [...results[result].rows[row]];
        }
        results[result].rows[row][column] = values[rowIndex][columnIndex];
      }
    });
  });
  return { ...response, results };
}
