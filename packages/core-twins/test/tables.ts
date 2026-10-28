// Test helper: a typed column built from cells (Phase 2205), throwing on a cell its type refuses.
import type { Cell, ColumnType, DataColumn } from '@fuaran-ui/schema';

import { columnOfCells } from '../src/column.js';

export const col = (name: string, type: ColumnType, cells: readonly Cell[]): DataColumn => {
  const c = columnOfCells(name, type, cells);
  if (!c.ok) throw new Error(c.error);
  return c.value;
};
