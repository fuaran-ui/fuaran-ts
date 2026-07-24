// The authored Fuaran tree — a pure projection of `Model`.
//
// Authored entirely through the `@fuaran-ui/ui` smart-constructor surface
// (`fuaran.*` / `binding.*` / `action.*`). Controlled values use
// `binding.state(key, default)`, resolved against the `BindingSources` returned
// by `buildSources`. Interaction emits an `AppMsg` via `action.dispatch`, which
// the renderer hands back to `dispatch`.
//
// This is the one file you grow as your app grows: add nodes here, add the state
// they read in `buildSources`, add the messages they emit in `model.ts`.

import { action, binding, fuaran } from '@fuaran-ui/ui';
import type { Action, Node } from '@fuaran-ui/schema';
import type { BindingSources } from '@fuaran-ui/renderer';

import type { AppMsg, Model } from './model';

const dispatch = (msg: AppMsg): Action<AppMsg> => action.dispatch<AppMsg>(msg);

export const buildTree = (_model: Model): Node<AppMsg> =>
  fuaran.dashboard<AppMsg>({
    id: 'app-root',
    children: [
      fuaran.heading<AppMsg>({ id: 'title', text: 'Hello, Fuaran', level: 1 }),
      fuaran.metric<AppMsg>({
        id: 'counter-kpi',
        label: 'Counter',
        value: binding.state('counter', 0),
      }),
      fuaran.stack<AppMsg>({
        id: 'counter-buttons',
        orientation: 'Horizontal',
        children: [
          fuaran.button<AppMsg>({
            id: 'btn-decrement',
            label: '− Decrement',
            onClick: dispatch({ t: 'Decrement' }),
            variant: 'Secondary',
          }),
          fuaran.button<AppMsg>({
            id: 'btn-increment',
            label: '+ Increment',
            onClick: dispatch({ t: 'Increment' }),
            variant: 'Primary',
          }),
        ],
      }),
    ],
  });

// `BindingSources` is the data side of the tree: every `binding.state(key, …)`
// in the tree above reads `state[key]` here. Rebuilt each render from `Model`.
export const buildSources = (model: Model): BindingSources => ({
  state: {
    counter: model.counter,
  },
});
