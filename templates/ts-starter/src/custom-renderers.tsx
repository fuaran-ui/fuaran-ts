// Custom-node escape hatch (NodeKind.Custom) — registry stub.
//
// A host registers a React component against a `moduleId`/`componentId` pair;
// `fuaran.custom({ moduleId, componentId, props })` nodes carrying that pair
// dispatch to it. This is the one audited boundary anything outside the typed
// vocabulary routes through. The starter ships an EMPTY registry — uncomment the
// example to register your first custom component, then author a
// `fuaran.custom({ moduleId: 'app', componentId: 'badge', props: { … } })` node
// in `tree.ts`.

import { createCustomRendererRegistry } from '@fuaran-ui/renderer';

// import type { CustomRendererProps } from '@fuaran-ui/renderer';
// import type { ReactElement } from 'react';
//
// function Badge({ props }: CustomRendererProps): ReactElement {
//   const label = typeof props['label'] === 'string' ? props['label'] : 'Badge';
//   return <span className="app-badge">{label}</span>;
// }

export const buildRegistry = (): ReturnType<typeof createCustomRendererRegistry> =>
  createCustomRendererRegistry();
// .register('app', 'badge', Badge);
