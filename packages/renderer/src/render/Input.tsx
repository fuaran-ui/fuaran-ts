// ============================================================================
//  @fuaran-ui/renderer/render/Input — every InputKind variant + form fields.
//  Mirrors the F# renderInput / renderButton / renderSelect / renderForm /
//  renderFormField / renderFilters / renderSegmentedChoiceCore / renderFileUpload.
//
//  Controlled vs uncontrolled (per Phase 77): `Binding.Static` → uncontrolled
//  (`defaultValue` / `defaultChecked`) so the field stays locally editable with
//  no host update loop; every other binding → controlled (`value` / `checked`)
//  with the resolved value. `Binding.Local` (Phase 62) → a controlled local
//  buffer component that flushes through its typed `onCommit`.
// ============================================================================

import { useEffect, useRef, useState } from 'react';
import type { ChangeEvent, KeyboardEvent, ReactElement, ReactNode } from 'react';

import type {
  Action,
  Binding,
  ButtonSpec,
  FileSelection,
  FileUploadSpec,
  FilterSpec,
  FormField,
  FormSpec,
  InputKind,
  JsonValue,
  LocalBinding,
  LocalFlushTrigger,
  Orientation,
  SelectOption,
  SelectSpec,
} from '@fuaran-ui/schema';

import { asArray, renderText, tryResolve } from '../bindings.js';
import { buttonVariantClass } from '../classNames.js';
import type { RenderContext } from '../context.js';
import { containsUnwiredAction, runAction, writeBackTo } from '../context.js';
import { iconHook } from './iconHook.js';

export const renderInput = <TMsg,>(
  ctx: RenderContext<TMsg>,
  input: InputKind<TMsg>,
): ReactElement => {
  switch (input.kind) {
    case 'Button':
      return renderButton(ctx, input.spec);
    case 'Select':
      return renderSelect(ctx, input.spec);
    case 'Form':
      return renderForm(ctx, input.spec);
    case 'Filters':
      return renderFilters(ctx, input.specs);
    case 'FileUpload':
      return renderFileUpload(ctx, input.spec);
  }
};

// ─── Button ──────────────────────────────────────────────────────────────────

const renderButton = <TMsg,>(ctx: RenderContext<TMsg>, spec: ButtonSpec<TMsg>): ReactElement => {
  const unwired = containsUnwiredAction(spec.onClick);
  const variantClass = buttonVariantClass(spec.variant);
  const className = unwired
    ? `fuaran-button fuaran-button-${variantClass} fuaran-button-unwired`
    : `fuaran-button fuaran-button-${variantClass}`;
  const tooltip =
    spec.tooltip !== undefined
      ? renderText(ctx.sources, spec.tooltip)
      : unwired
        ? 'This action routes through the runtime substrate (Call/Notify/Navigate/SetState/AiTool).'
        : undefined;
  // Phase 129: optional bound disabled-state. Emit the HTML `disabled`
  // attribute when the binding resolves `true`; absent or unresolved leaves
  // the button enabled (the v1 default).
  const isDisabled =
    spec.disabled !== undefined ? tryResolve(ctx.sources, spec.disabled) === true : false;
  return (
    <button
      className={className}
      {...(tooltip !== undefined ? { title: tooltip } : {})}
      {...(isDisabled ? { disabled: true } : {})}
      onClick={() => runAction(ctx, spec.onClick)}
    >
      {spec.icon !== undefined ? iconHook('fuaran-button-icon', spec.icon) : null}
      {renderText(ctx.sources, spec.label)}
    </button>
  );
};

// ─── Select ───────────────────────────────────────────────────────────────────

const renderSelect = <TMsg,>(ctx: RenderContext<TMsg>, spec: SelectSpec<TMsg>): ReactElement => {
  const options = asArray<SelectOption>(tryResolve(ctx.sources, spec.source));
  // Phase 130: optional bound disabled-state — emit the HTML `disabled`
  // attribute on the `<select>` when the binding resolves `true`.
  const isDisabled =
    spec.disabled !== undefined ? tryResolve(ctx.sources, spec.disabled) === true : false;

  const optionEls = options.map((o: SelectOption, i) => (
    <option key={i} value={o.value}>
      {renderText(ctx.sources, o.label)}
    </option>
  ));

  const label = <span className="fuaran-select-label">{renderText(ctx.sources, spec.label)}</span>;

  if (spec.multiple) {
    // Phase 291 — `<select multiple>`. The selection is the resolved `values`
    // list; a controlled multi-select rejects a scalar `value`, so we emit the
    // array and NO placeholder option (mirrors F# `renderSelect`'s multi arm).
    // onChange reads every selected option into a string list. Phase 426: a
    // present `onChangeMulti` closure wins; omitted, the list is written back
    // to a writable `values` binding (the write-back default).
    const selectedValues =
      spec.values !== undefined ? asArray<string>(tryResolve(ctx.sources, spec.values)) : [];
    const onChangeMulti = spec.onChangeMulti;
    const values = spec.values;
    return (
      <label className="fuaran-select">
        {label}
        <select
          className="fuaran-select-control"
          multiple
          value={[...selectedValues]}
          {...(isDisabled ? { disabled: true } : {})}
          onChange={(e) => {
            const chosen = Array.from(e.target.selectedOptions, (o) => o.value);
            if (onChangeMulti !== undefined) runAction(ctx, onChangeMulti(chosen));
            else if (values !== undefined) writeBackTo(ctx, values, chosen);
          }}
        >
          {optionEls}
        </select>
      </label>
    );
  }

  const selected = tryResolve(ctx.sources, spec.value) ?? '';
  const onChange = spec.onChange;
  return (
    <label className="fuaran-select">
      {label}
      <select
        className="fuaran-select-control"
        value={selected}
        {...(isDisabled ? { disabled: true } : {})}
        onChange={(e) => {
          // Phase 426: the closure wins; an omitted handler writes the chosen
          // option back to a writable `value` binding (a cleared choice clears
          // the slot).
          const chosen = e.target.value === '' ? undefined : e.target.value;
          if (onChange !== undefined) runAction(ctx, onChange(chosen));
          else writeBackTo(ctx, spec.value, chosen);
        }}
      >
        {spec.placeholder !== undefined && (
          <option value="">{renderText(ctx.sources, spec.placeholder)}</option>
        )}
        {optionEls}
      </select>
    </label>
  );
};

// ─── Form ──────────────────────────────────────────────────────────────────────

const renderForm = <TMsg,>(ctx: RenderContext<TMsg>, spec: FormSpec<TMsg>): ReactElement => {
  const body = (
    <>
      {spec.fields.map((field, i) => (
        <FormFieldView key={i} ctx={ctx} field={field} />
      ))}
      <button className="fuaran-form-submit" type="submit">
        {renderText(ctx.sources, spec.submitLabel)}
      </button>
    </>
  );
  // Phase 130: optional bound form-level disabled-state. When the slot is
  // present, wrap the fields + submit in a `<fieldset>` so one resolved
  // `disabled` cascades to every descendant control (native HTML). When the
  // slot is absent, render the body directly — unchanged DOM. Parity-locked
  // with the F# `Render.fs` `renderForm` (`fuaran-form-fieldset` wrapper).
  const children =
    spec.disabled !== undefined ? (
      <fieldset
        className="fuaran-form-fieldset"
        {...(tryResolve(ctx.sources, spec.disabled) === true ? { disabled: true } : {})}
      >
        {body}
      </fieldset>
    ) : (
      body
    );
  return (
    <form
      className="fuaran-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (typeof window !== 'undefined')
          window.dispatchEvent(new CustomEvent('fuaran-form-commit'));
        runAction(ctx, spec.onSubmit);
      }}
    >
      {children}
    </form>
  );
};

// ─── Form field ──────────────────────────────────────────────────────────────

function FormFieldView<TMsg>({
  ctx,
  field,
}: {
  ctx: RenderContext<TMsg>;
  field: FormField<TMsg>;
}): ReactElement {
  const labelText = renderText(ctx.sources, field.label);
  const labelWithRequired = field.required ? `${labelText} *` : labelText;
  return (
    <div className="fuaran-form-field">
      <label className="fuaran-form-label" htmlFor={field.id}>
        {labelWithRequired}
      </label>
      {renderFormControl(ctx, field)}
      {field.help !== undefined && (
        <div className="fuaran-form-help">{renderText(ctx.sources, field.help)}</div>
      )}
    </div>
  );
}

const renderFormControl = <TMsg,>(ctx: RenderContext<TMsg>, field: FormField<TMsg>): ReactNode => {
  const k = field.kind;
  // Phase 426 — the control write-back default. A present handler dispatches
  // exactly as before (the closure wins); an omitted handler writes the typed
  // change back to the field's own value binding when that binding is directly
  // `State`/`Filter` (see `writeBackTo`). A cleared choice clears the slot.
  const handle = <V,>(
    onChange: ((value: V) => Action<TMsg>) | undefined,
    // Structurally-minimal binding view (see `writeBackTo` — `Binding<T>` is
    // invariant in `T`, so the typed field bindings don't assign to
    // `Binding<unknown>`).
    binding: { readonly kind: string; readonly key?: string; readonly name?: string },
    write: JsonValue | undefined,
    v: V,
  ): void => {
    if (onChange !== undefined) runAction(ctx, onChange(v));
    else writeBackTo(ctx, binding, write);
  };
  switch (k.kind) {
    case 'Text': {
      if (k.value.kind === 'Local') {
        return (
          <LocalInput
            ctx={ctx}
            fieldId={field.id}
            required={field.required}
            local={k.value.local as LocalBinding<unknown>}
            numeric={false}
          />
        );
      }
      const current = tryResolve(ctx.sources, k.value) ?? '';
      const onChange = k.onChange;
      return (
        <input
          className="fuaran-form-input"
          type="text"
          id={field.id}
          required={field.required}
          {...valueProps(k.value, current)}
          onChange={(e: ChangeEvent<HTMLInputElement>) =>
            handle(onChange, k.value, e.target.value, e.target.value)
          }
        />
      );
    }
    case 'Number': {
      if (k.value.kind === 'Local') {
        return (
          <LocalInput
            ctx={ctx}
            fieldId={field.id}
            required={field.required}
            local={k.value.local as LocalBinding<unknown>}
            numeric
          />
        );
      }
      const current = tryResolve(ctx.sources, k.value) ?? 0;
      const onChange = k.onChange;
      return (
        <input
          className="fuaran-form-input"
          type="number"
          id={field.id}
          required={field.required}
          {...valueProps(k.value, current)}
          onChange={(e: ChangeEvent<HTMLInputElement>) =>
            handle(onChange, k.value, Number(e.target.value), Number(e.target.value))
          }
        />
      );
    }
    case 'RangedNumber': {
      const constraints = k.constraints;
      const rangeAttrs: Record<string, number> = {};
      if (constraints.min !== undefined) rangeAttrs['min'] = constraints.min;
      if (constraints.max !== undefined) rangeAttrs['max'] = constraints.max;
      if (constraints.step !== undefined) rangeAttrs['step'] = constraints.step;
      if (k.value.kind === 'Local') {
        return (
          <LocalInput
            ctx={ctx}
            fieldId={field.id}
            required={field.required}
            local={k.value.local as LocalBinding<unknown>}
            numeric
            rangeAttrs={rangeAttrs}
          />
        );
      }
      const current = tryResolve(ctx.sources, k.value) ?? 0;
      const onChange = k.onChange;
      return (
        <input
          className="fuaran-form-input"
          type="number"
          id={field.id}
          required={field.required}
          {...valueProps(k.value, current)}
          {...rangeAttrs}
          onChange={(e: ChangeEvent<HTMLInputElement>) =>
            handle(onChange, k.value, Number(e.target.value), Number(e.target.value))
          }
        />
      );
    }
    case 'Range': {
      // 0.2.0 — dual-thumb numeric range (absorbed FilterKind.RangeFilter):
      // two number inputs writing the [min, max] pair as one value.
      const constraints = k.constraints;
      const rangeAttrs: Record<string, number> = {};
      if (constraints?.min !== undefined) rangeAttrs['min'] = constraints.min;
      if (constraints?.max !== undefined) rangeAttrs['max'] = constraints.max;
      if (constraints?.step !== undefined) rangeAttrs['step'] = constraints.step;
      const resolved = tryResolve(ctx.sources, k.value);
      const current: readonly [number, number] =
        Array.isArray(resolved) && resolved.length === 2 ? (resolved as [number, number]) : [0, 0];
      const [minV, maxV] = current;
      const onChange = k.onChange;
      const emit = (pair: readonly [number, number]): void =>
        handle(onChange, k.value, [pair[0], pair[1]], pair);
      return (
        <span className="fuaran-form-range" id={field.id}>
          <input
            className="fuaran-form-input fuaran-form-range-min"
            type="number"
            value={minV}
            {...rangeAttrs}
            onChange={(e: ChangeEvent<HTMLInputElement>) => emit([Number(e.target.value), maxV])}
          />
          <span className="fuaran-form-range-sep">–</span>
          <input
            className="fuaran-form-input fuaran-form-range-max"
            type="number"
            value={maxV}
            {...rangeAttrs}
            onChange={(e: ChangeEvent<HTMLInputElement>) => emit([minV, Number(e.target.value)])}
          />
        </span>
      );
    }
    case 'Checkbox': {
      const current = tryResolve(ctx.sources, k.value) ?? false;
      const onToggle = k.onToggle;
      return (
        <input
          className="fuaran-form-checkbox"
          type="checkbox"
          id={field.id}
          {...checkedProps(k.value, current)}
          onChange={(e: ChangeEvent<HTMLInputElement>) =>
            handle(onToggle, k.value, e.target.checked, e.target.checked)
          }
        />
      );
    }
    case 'Choice': {
      const opts = asArray<SelectOption>(tryResolve(ctx.sources, k.options));
      const current = tryResolve(ctx.sources, k.value) ?? '';
      const onChange = k.onChange;
      return (
        <select
          className="fuaran-form-select"
          id={field.id}
          required={field.required}
          value={current}
          onChange={(e) => {
            const chosen = e.target.value === '' ? undefined : e.target.value;
            handle(onChange, k.value, chosen, chosen);
          }}
        >
          <option value="">—</option>
          {opts.map((o: SelectOption, i) => (
            <option key={i} value={o.value}>
              {renderText(ctx.sources, o.label)}
            </option>
          ))}
        </select>
      );
    }
    case 'TextArea': {
      const current = tryResolve(ctx.sources, k.value) ?? '';
      const onChange = k.onChange;
      return (
        <textarea
          className="fuaran-form-textarea"
          id={field.id}
          required={field.required}
          rows={k.rows}
          {...valueProps(k.value, current)}
          onChange={(e: ChangeEvent<HTMLTextAreaElement>) =>
            handle(onChange, k.value, e.target.value, e.target.value)
          }
        />
      );
    }
    case 'SegmentedChoice': {
      const segOnChange = k.onChange;
      return renderSegmentedChoiceCore(
        ctx,
        field.id,
        k.options,
        k.value,
        (chosen) => handle(segOnChange, k.value, chosen, chosen),
        k.orientation,
      );
    }
    case 'Date': {
      // Phase 288 — native date / time / datetime control. The bound value is
      // an ISO-8601 string; min/max are ISO strings, step is seconds.
      const inputType =
        k.variant === 'Time' ? 'time' : k.variant === 'DateTime' ? 'datetime-local' : 'date';
      const constraintAttrs: Record<string, string | number> = {};
      if (k.constraints.min !== undefined) constraintAttrs['min'] = k.constraints.min;
      if (k.constraints.max !== undefined) constraintAttrs['max'] = k.constraints.max;
      if (k.constraints.step !== undefined) constraintAttrs['step'] = k.constraints.step;
      const current = tryResolve(ctx.sources, k.value) ?? '';
      const onChange = k.onChange;
      return (
        <input
          className="fuaran-form-input fuaran-form-date"
          type={inputType}
          id={field.id}
          required={field.required}
          {...valueProps(k.value, current)}
          {...constraintAttrs}
          onChange={(e: ChangeEvent<HTMLInputElement>) =>
            handle(onChange, k.value, e.target.value, e.target.value)
          }
        />
      );
    }
    case 'DateRange': {
      // Phase 725 — single-control date range: `Range`'s two-input shape with
      // `Date`'s native control per variant. Both ends share the min/max/step
      // attributes (they bound the whole range), and either change emits the
      // WHOLE pair through the standard write-back — one value, not two. Class
      // vocabulary is reused, not extended (the reference-CSS parity lock with
      // the F# renderer, which emits the same `fuaran-field-range*` wrapper).
      const inputType =
        k.variant === 'Time' ? 'time' : k.variant === 'DateTime' ? 'datetime-local' : 'date';
      const constraintAttrs: Record<string, string | number> = {};
      if (k.constraints.min !== undefined) constraintAttrs['min'] = k.constraints.min;
      if (k.constraints.max !== undefined) constraintAttrs['max'] = k.constraints.max;
      if (k.constraints.step !== undefined) constraintAttrs['step'] = k.constraints.step;
      const resolved = tryResolve(ctx.sources, k.value);
      const current: readonly [string, string] =
        Array.isArray(resolved) && resolved.length === 2
          ? (resolved as [string, string])
          : ['', ''];
      const [fromV, toV] = current;
      const onChange = k.onChange;
      const emit = (pair: readonly [string, string]): void =>
        handle(onChange, k.value, [pair[0], pair[1]], pair);
      return (
        <span className="fuaran-field-range">
          <input
            className="fuaran-form-input fuaran-form-date fuaran-field-range-min"
            type={inputType}
            id={field.id}
            required={field.required}
            value={fromV}
            {...constraintAttrs}
            onChange={(e: ChangeEvent<HTMLInputElement>) => emit([e.target.value, toV])}
          />
          <span className="fuaran-field-range-sep">–</span>
          <input
            className="fuaran-form-input fuaran-form-date fuaran-field-range-max"
            type={inputType}
            required={field.required}
            value={toV}
            {...constraintAttrs}
            onChange={(e: ChangeEvent<HTMLInputElement>) => emit([fromV, e.target.value])}
          />
        </span>
      );
    }
  }
};

/** Static → uncontrolled defaultValue; everything else → controlled value. */
const valueProps = <T extends string | number>(
  binding: { readonly kind: string },
  current: T,
): Record<string, T> =>
  binding.kind === 'Static' ? { defaultValue: current } : { value: current };

const checkedProps = (
  binding: { readonly kind: string },
  current: boolean,
): Record<string, boolean> =>
  binding.kind === 'Static' ? { defaultChecked: current } : { checked: current };

// ─── Local-bound input (Phase 62) ─────────────────────────────────────────────

function LocalInput<TMsg>({
  ctx,
  fieldId,
  required,
  local,
  numeric,
  rangeAttrs,
}: {
  ctx: RenderContext<TMsg>;
  fieldId: string;
  required: boolean;
  local: LocalBinding<unknown>;
  numeric: boolean;
  rangeAttrs?: Record<string, number>;
}): ReactElement {
  const external = tryResolve(ctx.sources, local.initialFrom);
  const format = local.format ?? ((v: unknown) => String(v ?? (numeric ? 0 : '')));
  const [buffer, setBuffer] = useState<string>(format(external));
  const bufferRef = useRef(buffer);
  bufferRef.current = buffer;

  const commit = (): void => {
    const parsed = local.parse(bufferRef.current);
    if (parsed.ok) runAction(ctx, local.onCommit(parsed.value) as Action<TMsg>);
  };

  // Re-sync the buffer when the external source changes (InitialFrom invariant).
  useEffect(() => {
    setBuffer(format(external));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [format(external)]);

  // OnSubmit / OnCommitAction flush via window events.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const handlers: Array<[string, () => void]> = [];
    if (flushKind(local.flushOn) === 'OnSubmit') handlers.push(['fuaran-form-commit', commit]);
    if (flushKind(local.flushOn) === 'OnCommitAction')
      handlers.push([`fuaran-commit-local-${fieldId}`, commit]);
    for (const [name, fn] of handlers) window.addEventListener(name, fn);
    return () => {
      for (const [name, fn] of handlers) window.removeEventListener(name, fn);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fieldId]);

  const debounceTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const onChange = (e: ChangeEvent<HTMLInputElement>): void => {
    setBuffer(e.target.value);
    const trigger = local.flushOn;
    if (trigger.kind === 'OnDebounce') {
      if (debounceTimer.current !== undefined) clearTimeout(debounceTimer.current);
      debounceTimer.current = setTimeout(commit, trigger.milliseconds);
    }
  };

  return (
    <input
      className="fuaran-form-input"
      type={numeric ? 'text' : 'text'}
      inputMode={numeric ? 'numeric' : undefined}
      id={fieldId}
      required={required}
      value={buffer}
      onChange={onChange}
      onBlur={() => {
        if (flushKind(local.flushOn) === 'OnBlur') commit();
      }}
      {...(rangeAttrs ?? {})}
    />
  );
}

const flushKind = (t: LocalFlushTrigger): LocalFlushTrigger['kind'] => t.kind;

// ─── Segmented choice / filter core (Phase 66) ────────────────────────────────

const renderSegmentedChoiceCore = <TMsg,>(
  ctx: RenderContext<TMsg>,
  idNamespace: string,
  options: Binding<readonly SelectOption[]>,
  value: Binding<string | undefined>,
  // A side-effecting change handler (Phase 423), not an `Action` factory — the form-field caller
  // dispatches through `runAction`, a declarative `SegmentedFilter` writes the filter seam. Keeps the
  // shared core agnostic to which channel the change drives (mirrors the F# renderer).
  handleChange: (value: string | undefined) => void,
  orientation: Orientation,
): ReactElement => {
  const opts = asArray<SelectOption>(tryResolve(ctx.sources, options));
  const current = tryResolve(ctx.sources, value);
  const optionId = (index: number): string => `${idNamespace}-opt-${index}`;

  if (orientation === 'Horizontal') {
    const activeIndex = current !== undefined ? opts.findIndex((o) => o.value === current) : -1;

    const cycle = (delta: number): void => {
      if (opts.length === 0) return;
      const count = opts.length;
      const nextIndex =
        activeIndex < 0
          ? delta > 0
            ? 0
            : count - 1
          : (((activeIndex + delta) % count) + count) % count;
      const next = opts[nextIndex];
      if (next !== undefined) handleChange(next.value);
    };

    const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
      switch (e.key) {
        case 'ArrowRight':
        case 'ArrowDown':
          e.preventDefault();
          cycle(1);
          break;
        case 'ArrowLeft':
        case 'ArrowUp':
          e.preventDefault();
          cycle(-1);
          break;
        case 'Home': {
          e.preventDefault();
          const first = opts[0];
          if (first !== undefined) handleChange(first.value);
          break;
        }
        case 'End': {
          e.preventDefault();
          const last = opts[opts.length - 1];
          if (last !== undefined) handleChange(last.value);
          break;
        }
      }
    };

    return (
      <div
        className="fuaran-segmented-horizontal"
        id={idNamespace}
        role="radiogroup"
        aria-orientation="horizontal"
        onKeyDown={onKeyDown}
      >
        {opts.map((o, index) => {
          const isActive = index === activeIndex;
          const tabIndex = isActive ? 0 : activeIndex < 0 && index === 0 ? 0 : -1;
          return (
            <button
              key={index}
              className="fuaran-segmented-option"
              type="button"
              id={optionId(index)}
              aria-checked={isActive}
              role="radio"
              tabIndex={tabIndex}
              onClick={() => handleChange(o.value)}
            >
              {renderText(ctx.sources, o.label)}
            </button>
          );
        })}
      </div>
    );
  }

  // Vertical — native radio inputs grouped by shared `name`.
  return (
    <fieldset className="fuaran-segmented-vertical" aria-orientation="vertical">
      <legend className="fuaran-segmented-legend">{idNamespace}</legend>
      {opts.map((o, index) => {
        const inputId = optionId(index);
        const isChecked = current === o.value;
        return (
          <div key={index} className="fuaran-segmented-row">
            <input
              type="radio"
              id={inputId}
              name={idNamespace}
              value={o.value}
              checked={isChecked}
              onChange={(e) => {
                if (e.target.checked) handleChange(o.value);
              }}
            />
            <label htmlFor={inputId}>{renderText(ctx.sources, o.label)}</label>
          </div>
        );
      })}
    </fieldset>
  );
};

// ─── Filters ───────────────────────────────────────────────────────────────────

const renderFilters = <TMsg,>(
  ctx: RenderContext<TMsg>,
  specs: readonly FilterSpec<TMsg>[],
): ReactElement => (
  <div className="fuaran-filters">
    {specs.map((spec, i) => (
      <FilterView key={i} ctx={ctx} spec={spec} />
    ))}
  </div>
);

function FilterView<TMsg>({
  ctx,
  spec,
}: {
  ctx: RenderContext<TMsg>;
  spec: FilterSpec<TMsg>;
}): ReactElement {
  // 0.2.0 filters-unification: the chip's control is an ordinary
  // `FormFieldKind` rendered by the shared form-control renderer. The
  // declarative (handler-free) shape auto-binds `Filter(spec.name)` at decode,
  // so the Phase-426 write-back routes each change to `$filters.<name>` via
  // `writeBackTo` — the Phase-423 chip mechanics, now with zero duplication.
  const labelText = renderText(ctx.sources, spec.label);
  const field: FormField<TMsg> = {
    id: `filter-${spec.name}`,
    label: spec.label,
    kind: spec.field,
    required: false,
  };
  return (
    <label className="fuaran-filter">
      <span className="fuaran-filter-label">{labelText}</span>
      {renderFormControl(ctx, field)}
    </label>
  );
}

// ─── FileUpload ──────────────────────────────────────────────────────────────

const renderFileUpload = <TMsg,>(
  ctx: RenderContext<TMsg>,
  spec: FileUploadSpec<TMsg>,
): ReactElement => {
  const acceptStr = spec.accept.length === 0 ? undefined : spec.accept.join(',');
  // Phase 130: optional bound disabled-state — emit the HTML `disabled`
  // attribute on the file input when the binding resolves `true`.
  const isDisabled =
    spec.disabled !== undefined ? tryResolve(ctx.sources, spec.disabled) === true : false;
  return (
    <label className="fuaran-file-upload">
      <span className="fuaran-file-upload-label">{renderText(ctx.sources, spec.label)}</span>
      <input
        className="fuaran-file-upload-input"
        type="file"
        multiple={spec.multiple}
        {...(isDisabled ? { disabled: true } : {})}
        {...(acceptStr !== undefined ? { accept: acceptStr } : {})}
        onChange={(e) => {
          const files = e.target.files;
          // Phase 136: carry an opaque FileRef per selection. `ref.id` is an
          // index-qualified stable token (the only part that serialises);
          // `ref.handle` is the actual browser File so `Action.ReadFileBody`
          // can read the blob with no consumer-side FileReader interop.
          const selections: FileSelection[] = files
            ? Array.from(files).map((f, i) => ({
                name: f.name,
                size: f.size,
                mimeType: f.type,
                ref: { id: `${i}:${f.name}`, handle: f },
              }))
            : [];
          runAction(ctx, spec.onSelect(selections));
        }}
      />
    </label>
  );
};
