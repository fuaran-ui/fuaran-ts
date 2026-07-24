// ============================================================================
//  panel — the DOM glue binding the pure models to panel.html.
//
//  Deliberately framework-free: the panel is a small, mostly-static surface
//  and the interesting logic lives in the pure models (treeModel /
//  guestStreams / timelineModel), which are unit-tested without a DOM. This
//  file only wires events and paints.
//
//  Read-only by default: hovering highlights, clicking inspects, scrubbing
//  replays a copy. The single mutation affordance (the apply box) is hidden
//  behind an explicit toggle and routes through the page's policy-gated
//  `__fuaran.apply` — the panel never applies an op itself (FGP 3).
// ============================================================================

import type { TreeIntrospection } from '@fuaran-ui/ai-tools';

import type {
  OpRecordSummary,
  OpStreamOverview,
  OpStreamRecordsResult,
  PingResult,
} from '../protocol.js';
import { PanelBridge } from './bridge.js';
import {
  classifyStreams,
  selectionFromValue,
  selectionToValue,
  type StreamSelection,
} from './guestStreams.js';
import { mergeTimelineRows, rowViews, scrubCapability } from './timelineModel.js';
import { findIntrospection, flattenTree } from './treeModel.js';

const bridge = new PanelBridge(chrome.devtools.inspectedWindow.tabId);

// ─── State ──────────────────────────────────────────────────────────

interface PanelState {
  ping: PingResult | undefined;
  liveTree: TreeIntrospection | undefined;
  /** A scrub-replayed snapshot, shown in place of the live tree. */
  historicalTree: TreeIntrospection | undefined;
  selectedNodeId: string | undefined;
  collapsed: Set<string>;
  overview: OpStreamOverview | undefined;
  recordsByStream: Map<string, readonly OpRecordSummary[]>;
  selection: StreamSelection;
  scrubSequence: number | undefined;
  timelineError: string | undefined;
}

const state: PanelState = {
  ping: undefined,
  liveTree: undefined,
  historicalTree: undefined,
  selectedNodeId: undefined,
  collapsed: new Set(),
  overview: undefined,
  recordsByStream: new Map(),
  selection: { kind: 'host' },
  scrubSequence: undefined,
  timelineError: undefined,
};

// ─── DOM handles ────────────────────────────────────────────────────

const el = <T extends HTMLElement>(id: string): T => {
  const found = document.getElementById(id);
  if (found === null) throw new Error(`panel.html is missing #${id}`);
  return found as T;
};

const statusEl = el<HTMLSpanElement>('status');
const treeEl = el<HTMLDivElement>('tree');
const treeTitleEl = el<HTMLHeadingElement>('tree-title');
const detailEl = el<HTMLDivElement>('detail');
const streamSelectEl = el<HTMLSelectElement>('stream-select');
const timelineStatusEl = el<HTMLSpanElement>('timeline-status');
const timelineRecordsEl = el<HTMLOListElement>('timeline-records');
const scrubRowEl = el<HTMLDivElement>('timeline-scrub-row');
const scrubEl = el<HTMLInputElement>('timeline-scrub');
const scrubPositionEl = el<HTMLSpanElement>('timeline-position');
const liveButtonEl = el<HTMLButtonElement>('timeline-live');
const applyBoxEl = el<HTMLDivElement>('apply-box');
const mutationToggleEl = el<HTMLInputElement>('mutation-toggle');
const applyJsonEl = el<HTMLTextAreaElement>('apply-json');
const applyResultEl = el<HTMLPreElement>('apply-result');

const text = (parent: HTMLElement, tag: string, className: string, value: string): HTMLElement => {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = value;
  parent.appendChild(node);
  return node;
};

// ─── Tree pane ──────────────────────────────────────────────────────

const visibleTree = (): TreeIntrospection | undefined => state.historicalTree ?? state.liveTree;

const renderTree = (): void => {
  treeEl.replaceChildren();
  treeTitleEl.textContent =
    state.historicalTree !== undefined ? 'Typed tree — historical (scrubbed)' : 'Typed tree';
  const tree = visibleTree();
  if (tree === undefined) {
    text(treeEl, 'div', 'empty', 'No tree yet — waiting for a Fuaran app in debug mode.');
    return;
  }
  for (const row of flattenTree(tree, state.collapsed)) {
    const rowEl = document.createElement('div');
    rowEl.className = `tree-row${row.id === state.selectedNodeId ? ' selected' : ''}`;
    rowEl.style.paddingLeft = `${row.depth * 14 + 4}px`;
    rowEl.setAttribute('role', 'treeitem');

    const twisty = text(
      rowEl,
      'span',
      'twisty',
      row.hasChildren ? (row.collapsed ? '▸' : '▾') : '',
    );
    if (row.hasChildren) {
      twisty.addEventListener('click', (event) => {
        event.stopPropagation();
        if (state.collapsed.has(row.id)) state.collapsed.delete(row.id);
        else state.collapsed.add(row.id);
        renderTree();
      });
    }

    text(rowEl, 'span', 'kind', row.kind);
    text(rowEl, 'span', 'node-id', `#${row.id}`);
    if (row.bindingCount > 0) text(rowEl, 'span', 'badge', `⛓ ${row.bindingCount}`);

    rowEl.addEventListener('click', () => {
      state.selectedNodeId = row.id;
      renderTree();
      void renderDetail();
    });
    // Hover-highlight rides live DOM geometry — meaningful for the live tree
    // only (a scrubbed snapshot has no rendered elements to locate).
    rowEl.addEventListener('mouseenter', () => {
      if (state.historicalTree === undefined)
        void bridge.request('highlight', { nodeId: row.id }).catch(() => {});
    });
    rowEl.addEventListener('mouseleave', () => {
      void bridge.request('unhighlight').catch(() => {});
    });

    treeEl.appendChild(rowEl);
  }
};

// ─── Detail pane ────────────────────────────────────────────────────

interface NodeStateLike {
  readonly id?: string;
  readonly kind?: string;
  readonly bindings?: readonly { slot: string; expression: string; source: string }[];
  readonly childIds?: readonly string[];
  readonly error?: string;
}

interface GeometryLike {
  readonly x?: number;
  readonly y?: number;
  readonly width?: number;
  readonly height?: number;
  readonly overflowing?: boolean;
  readonly hidden?: boolean;
  readonly error?: string;
}

const renderDetail = async (): Promise<void> => {
  detailEl.replaceChildren();
  const nodeId = state.selectedNodeId;
  if (nodeId === undefined) {
    detailEl.className = 'empty';
    detailEl.textContent = 'Select a node to inspect it.';
    return;
  }
  detailEl.className = '';

  // Historical snapshots are inspected from the snapshot itself; the live
  // tree is inspected through the page's introspection surface (and gains
  // live geometry + on-demand binding resolution).
  const historical = state.historicalTree;
  const nodeState: NodeStateLike =
    historical !== undefined
      ? ((findIntrospection(historical, nodeId) as NodeStateLike | undefined) ?? {
          error: `Node '${nodeId}' does not exist at this point in the timeline.`,
        })
      : await bridge
          .request<NodeStateLike>('getNodeState', { nodeId })
          .catch((e: Error) => ({ error: e.message }));

  const table = document.createElement('table');
  const addRow = (label: string, value: string | HTMLElement): void => {
    const tr = document.createElement('tr');
    text(tr, 'th', '', label);
    const td = document.createElement('td');
    if (typeof value === 'string') td.textContent = value;
    else td.appendChild(value);
    tr.appendChild(td);
    table.appendChild(tr);
  };

  if (nodeState.error !== undefined) {
    addRow('Error', nodeState.error);
    detailEl.appendChild(table);
    return;
  }

  addRow('Id', nodeState.id ?? nodeId);
  addRow('Kind', nodeState.kind ?? '—');
  addRow('Children', String(nodeState.childIds?.length ?? 0));

  const bindings = nodeState.bindings ?? [];
  if (bindings.length === 0) {
    addRow('Bindings', 'none');
  } else {
    for (const binding of bindings) {
      const cell = document.createElement('span');
      cell.textContent = `${binding.expression} (${binding.source}) `;
      if (historical === undefined) {
        const resolveBtn = document.createElement('button');
        resolveBtn.type = 'button';
        resolveBtn.textContent = 'resolve';
        resolveBtn.title = 'Resolve this slot against the live binding sources';
        resolveBtn.addEventListener('click', () => {
          void bridge
            .request('getBindingValue', { nodeId, slot: binding.slot })
            .then((value) => {
              resolveBtn.replaceWith(document.createTextNode(`= ${JSON.stringify(value)}`));
            })
            .catch((e: Error) => resolveBtn.replaceWith(document.createTextNode(`⚠ ${e.message}`)));
        });
        cell.appendChild(resolveBtn);
      }
      addRow(`Slot ${binding.slot}`, cell);
    }
  }

  if (historical === undefined) {
    const geometry = await bridge
      .request<GeometryLike>('getRenderedDom', { nodeId })
      .catch((e: Error) => ({ error: e.message }) as GeometryLike);
    if (geometry.error !== undefined) {
      addRow('Geometry', geometry.error);
    } else {
      addRow(
        'Geometry',
        `${Math.round(geometry.x ?? 0)}, ${Math.round(geometry.y ?? 0)} · ${Math.round(geometry.width ?? 0)}×${Math.round(geometry.height ?? 0)}`,
      );
      const flags: string[] = [];
      if (geometry.hidden === true) flags.push('hidden');
      if (geometry.overflowing === true) flags.push('overflowing');
      if (flags.length > 0) {
        const flagEl = document.createElement('span');
        flagEl.className = 'geometry-flag';
        flagEl.textContent = flags.join(', ');
        addRow('Issues', flagEl);
      }
    }
  }

  detailEl.appendChild(table);
};

// ─── Timeline pane ──────────────────────────────────────────────────

const renderStreamSelector = (): void => {
  streamSelectEl.replaceChildren();
  const streams = state.overview?.streams ?? [];
  const { guestScopes } = classifyStreams(streams);

  const addOption = (value: string, label: string): void => {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    streamSelectEl.appendChild(option);
  };

  addOption('host', 'Host');
  for (const scopeId of guestScopes) addOption(`guest-${scopeId}`, `Guest: ${scopeId}`);
  if (guestScopes.length > 0) addOption('all', 'All guests + host (rollup)');
  streamSelectEl.value = selectionToValue(state.selection);
};

const renderTimeline = (): void => {
  timelineRecordsEl.replaceChildren();

  if (state.timelineError !== undefined) {
    timelineStatusEl.textContent = state.timelineError;
    scrubRowEl.hidden = true;
    return;
  }

  const streams = state.overview?.streams ?? [];
  const rows = mergeTimelineRows(state.recordsByStream, state.selection, streams);
  const capability = scrubCapability(state.selection, streams);

  timelineStatusEl.textContent = capability.scrubable
    ? `${rows.length} op(s)`
    : `${rows.length} op(s) — ${capability.reason ?? ''}`;

  scrubRowEl.hidden = !capability.scrubable;
  if (capability.scrubable && capability.latestSequence !== undefined) {
    scrubEl.max = String(capability.latestSequence);
    scrubEl.value = String(state.scrubSequence ?? capability.latestSequence);
    scrubPositionEl.textContent =
      state.scrubSequence === undefined ? 'live' : `@ seq ${state.scrubSequence}`;
    liveButtonEl.hidden = state.scrubSequence === undefined;
  }

  const scrub =
    state.scrubSequence !== undefined && capability.streamId !== undefined
      ? { streamId: capability.streamId, sequence: state.scrubSequence }
      : undefined;
  for (const view of rowViews(rows, scrub)) {
    const li = document.createElement('li');
    if (view.beyondScrub) li.className = 'beyond-scrub';
    text(li, 'span', 'seq', String(view.sequence));
    text(li, 'span', 'op-kind', view.opKind);
    text(li, 'span', 'target', view.target);
    text(li, 'span', 'stream', `${view.streamId} · ${view.attribution}`);
    timelineRecordsEl.appendChild(li);
  }
};

const refreshTimelineData = async (): Promise<void> => {
  state.timelineError = undefined;
  if (state.ping?.opStream !== true) {
    state.overview = undefined;
    state.recordsByStream.clear();
    state.timelineError =
      'No op-stream wired — expose `window.__fuaranOpStream = { sink, initialTrees }` (DEBUG-only) to light this up.';
    renderStreamSelector();
    renderTimeline();
    return;
  }
  try {
    state.overview = await bridge.request<OpStreamOverview>('opStreamOverview');
    state.recordsByStream.clear();
    for (const stream of state.overview.streams) {
      const result = await bridge.request<OpStreamRecordsResult>('opStreamRecords', {
        streamId: stream.streamId,
      });
      state.recordsByStream.set(stream.streamId, result.records);
    }
  } catch (error) {
    state.timelineError = error instanceof Error ? error.message : String(error);
  }
  renderStreamSelector();
  renderTimeline();
};

const scrubTo = async (sequence: number | undefined): Promise<void> => {
  const capability = scrubCapability(state.selection, state.overview?.streams ?? []);
  if (!capability.scrubable || capability.streamId === undefined) return;

  if (sequence === undefined || sequence >= (capability.latestSequence ?? 0)) {
    state.scrubSequence = undefined;
    state.historicalTree = undefined;
  } else {
    state.scrubSequence = sequence;
    try {
      state.historicalTree = await bridge.request<TreeIntrospection>('opStreamTreeAt', {
        streamId: capability.streamId,
        sequence,
      });
    } catch (error) {
      state.timelineError = error instanceof Error ? error.message : String(error);
      state.historicalTree = undefined;
    }
  }
  renderTree();
  void renderDetail();
  renderTimeline();
};

// ─── Status + refresh ───────────────────────────────────────────────

const renderStatus = (): void => {
  if (state.ping === undefined) {
    statusEl.className = 'status-detecting';
    statusEl.textContent = 'Detecting Fuaran app…';
  } else if (state.ping.detected) {
    statusEl.className = 'status-detected';
    statusEl.textContent = `Fuaran app detected (debug global v${state.ping.version ?? '?'})`;
  } else {
    statusEl.className = 'status-absent';
    statusEl.textContent =
      'No Fuaran app detected — render with <FuaranRenderer debug> (DEV builds) and reload.';
  }
};

const refreshAll = async (): Promise<void> => {
  try {
    state.ping = await bridge.request<PingResult>('ping');
  } catch {
    state.ping = { detected: false, opStream: false };
  }
  renderStatus();

  state.historicalTree = undefined;
  state.scrubSequence = undefined;
  if (state.ping.detected) {
    state.liveTree = await bridge.request<TreeIntrospection>('inspectTree').catch(() => undefined);
  } else {
    state.liveTree = undefined;
  }
  renderTree();
  void renderDetail();
  await refreshTimelineData();
};

// ─── Events ─────────────────────────────────────────────────────────

el<HTMLButtonElement>('refresh').addEventListener('click', () => void refreshAll());

streamSelectEl.addEventListener('change', () => {
  state.selection = selectionFromValue(streamSelectEl.value);
  state.scrubSequence = undefined;
  state.historicalTree = undefined;
  renderTree();
  renderTimeline();
});

scrubEl.addEventListener('change', () => void scrubTo(Number(scrubEl.value)));
liveButtonEl.addEventListener('click', () => void scrubTo(undefined));

mutationToggleEl.addEventListener('change', () => {
  applyBoxEl.hidden = !mutationToggleEl.checked;
});

el<HTMLButtonElement>('apply-run').addEventListener('click', () => {
  applyResultEl.textContent = '…';
  void bridge
    .request('apply', { opJson: applyJsonEl.value })
    .then((envelope) => {
      applyResultEl.textContent = JSON.stringify(envelope, null, 2);
      return refreshAll();
    })
    .catch((e: Error) => {
      applyResultEl.textContent = `⚠ ${e.message}`;
    });
});

// Re-detect on page navigation, and kick off the first read.
chrome.devtools.network.onNavigated.addListener(() => void refreshAll());
void refreshAll();
