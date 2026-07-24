// Host state + message contract for the demo's dispatch loop.
//
// The Fuaran tree is a pure projection of `Model`; user interaction emits an
// `AppMsg` through the renderer's `dispatch`, the reducer folds it into the
// next `Model`, and React re-renders the projected tree. This is the same
// MVU shape the F# tier drives with Elmish — here `useReducer` plays Elmish's
// role.

export interface Channel {
  readonly rowId: number;
  readonly channel: string;
  readonly mediaType: string;
  readonly grps: number;
  readonly audienceShare: number;
}

export interface Model {
  readonly channels: readonly Channel[];
  readonly counter: number;
  readonly selectedRow: number | undefined;
  readonly contributorPick: string | undefined;
  readonly textFilter: string;
  readonly formText: string;
  readonly formChoice: string | undefined;
  readonly formSubmitted: boolean;
  readonly step: number;
  readonly uploadedFiles: readonly string[];
  readonly dark: boolean;
}

export type AppMsg =
  | { readonly t: 'Increment' }
  | { readonly t: 'Decrement' }
  | { readonly t: 'SetCounter'; readonly value: number }
  | { readonly t: 'UpdateGrps'; readonly rowId: number; readonly value: number }
  | { readonly t: 'SelectRow'; readonly rowId: number }
  | { readonly t: 'PickContributor'; readonly value: string | undefined }
  | { readonly t: 'SetTextFilter'; readonly value: string }
  | { readonly t: 'SetFormText'; readonly value: string }
  | { readonly t: 'SetFormChoice'; readonly value: string | undefined }
  | { readonly t: 'SubmitForm' }
  | { readonly t: 'FilesSelected'; readonly names: readonly string[] }
  | { readonly t: 'NextStep' }
  | { readonly t: 'PrevStep' }
  | { readonly t: 'ToggleTheme' };

export const initialChannels: readonly Channel[] = [
  { rowId: 1, channel: 'Search', mediaType: 'Digital', grps: 18.4, audienceShare: 0.42 },
  { rowId: 2, channel: 'Display', mediaType: 'Digital', grps: 12.1, audienceShare: 0.18 },
  { rowId: 3, channel: 'TV — peak', mediaType: 'Linear', grps: 35.6, audienceShare: 0.27 },
  { rowId: 4, channel: 'TV — offpeak', mediaType: 'Linear', grps: 22.3, audienceShare: 0.09 },
  { rowId: 5, channel: 'OOH', mediaType: 'Out of home', grps: 7.8, audienceShare: 0.04 },
];

export const initialModel: Model = {
  channels: initialChannels,
  counter: 0,
  selectedRow: undefined,
  contributorPick: undefined,
  textFilter: '',
  formText: '',
  formChoice: undefined,
  formSubmitted: false,
  step: 0,
  uploadedFiles: [],
  dark: false,
};

const MAX_STEP = 2;

export const update = (model: Model, msg: AppMsg): Model => {
  switch (msg.t) {
    case 'Increment':
      return { ...model, counter: model.counter + 1 };
    case 'Decrement':
      return { ...model, counter: model.counter - 1 };
    case 'SetCounter':
      return { ...model, counter: msg.value };
    case 'UpdateGrps':
      return {
        ...model,
        channels: model.channels.map((c) =>
          c.rowId === msg.rowId ? { ...c, grps: msg.value } : c,
        ),
      };
    case 'SelectRow':
      return { ...model, selectedRow: msg.rowId };
    case 'PickContributor':
      return { ...model, contributorPick: msg.value };
    case 'SetTextFilter':
      return { ...model, textFilter: msg.value };
    case 'SetFormText':
      return { ...model, formText: msg.value };
    case 'SetFormChoice':
      return { ...model, formChoice: msg.value };
    case 'SubmitForm':
      return { ...model, formSubmitted: true };
    case 'FilesSelected':
      return { ...model, uploadedFiles: msg.names };
    case 'NextStep':
      return { ...model, step: Math.min(MAX_STEP, model.step + 1) };
    case 'PrevStep':
      return { ...model, step: Math.max(0, model.step - 1) };
    case 'ToggleTheme':
      return { ...model, dark: !model.dark };
  }
};

/** Filtered channel view used by both the grid and the inline-chart Custom node. */
export const visibleChannels = (model: Model): readonly Channel[] => {
  const needle = model.textFilter.trim().toLowerCase();
  if (needle === '') return model.channels;
  return model.channels.filter((c) => c.channel.toLowerCase().includes(needle));
};
