// Host state + message contract for the dispatch loop.
//
// The Fuaran tree is a pure projection of `Model`; user interaction emits an
// `AppMsg` through the renderer's `dispatch`, the reducer folds it into the
// next `Model`, and React re-renders the projected tree. This is the MVU shape
// the F# tier drives with Elmish — here `useReducer` plays Elmish's role.

export interface Model {
  readonly counter: number;
}

export type AppMsg = { readonly t: 'Increment' } | { readonly t: 'Decrement' };

export const initialModel: Model = {
  counter: 0,
};

export const update = (model: Model, msg: AppMsg): Model => {
  switch (msg.t) {
    case 'Increment':
      return { ...model, counter: model.counter + 1 };
    case 'Decrement':
      return { ...model, counter: model.counter - 1 };
  }
};
