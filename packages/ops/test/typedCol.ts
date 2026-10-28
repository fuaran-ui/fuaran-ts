// Test helper (Phase 2205): a typed column built from cells, throwing on a cell its type refuses.
import type { Cell, ColumnType, DataColumn } from '@fuaran-ui/schema';

import { columnOfCells } from '../src/index.js';

export const typedCol = (name: string, type: ColumnType, cells: readonly Cell[]): DataColumn => {
  const c = columnOfCells(name, type, cells);
  if (!c.ok) throw new Error(c.error);
  return c.value;
};
