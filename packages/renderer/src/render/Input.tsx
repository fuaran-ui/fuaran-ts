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
import type {
  ChangeEvent,
  ClipboardEvent,
  DragEvent,
  KeyboardEvent,
  ReactElement,
  ReactNode,
} from 'react';

import type {
  Action,
  Binding,
  ButtonSpec,
  FileSelection,
  FileUploadSpec,
  FilterSpec,
  FormField,
  FieldRule,
  TextFormat,
  CompareOp,
  FormSpec,
  InputKind,
  JsonValue,
  LocalBinding,
  LocalFlushTrigger,
  Orientation,
  SelectOption,
  SelectSpec,
} from '@fuaran-ui/schema';

import {
  asArray,
  isHexColor,
  isWriteBackTarget,
  ratingClamp,
  ratingFillClass,
  ratingFills,
  ratingSnap,
  ratingStep,
  ratingValueText,
  renderText,
  tryResolve,
} from '../bindings.js';
import { buttonVariantClass } from '../classNames.js';
import type { RenderContext } from '../context.js';
import { containsUnwiredAction, runAction, writeBackTo } from '../context.js';
import { iconHook } from './iconHook.js';

export const renderInput = <TMsg,>(
  ctx: RenderContext<TMsg>,
  input: InputKind<TMsg>,
  // Phase 951 — the node's a11y projection, for the kinds whose body IS the
  // node's semantic element (here: Button alone — a field's control sits inside
  // its <label>, which already names it). `{}` everywhere else.
  semanticAttrs: Record<string, string> = {},
): ReactElement => {
  switch (input.kind) {
    case 'Button':
      return renderButton(ctx, input.spec, semanticAttrs);
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

const renderButton = <TMsg,>(
  ctx: RenderContext<TMsg>,
  spec: ButtonSpec<TMsg>,
  // Phase 951 — the node's a11y projection, emitted on the <button> itself.
  semanticAttrs: Record<string, string> = {},
): ReactElement => {
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
      {...semanticAttrs}
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

// Phase 864 — the SUBMIT GATE, and it is deliberately small because the browser
// already owns most of it. This form is a native `<form>` with a
// `<button type="submit">`, so constraint validation runs BEFORE `onSubmit`
// fires: `required`, `type=email|url|tel`, `pattern`, `minlength` and `maxlength`
// are enforced by the platform and the offending field is named by the platform,
// which is exactly what WIRE_FORMAT asks a rendering host for. The one slot with
// no HTML equivalent is `compare`, so that is the only thing this gate adds.
//
// It reports through `setCustomValidity` rather than a bespoke error surface for
// the same reason: the platform's own mechanism blocks the submit, shows the
// message, and clears itself, and it composes with the native failures above
// instead of racing them. No new class vocabulary is minted (the reference
// stylesheet is parity-locked with the F# tier).

/** One comparison, per WIRE_FORMAT's ordering rules. */
const compareMet = (op: CompareOp, left: unknown, right: unknown): boolean => {
  // "A comparison between values of different shapes is UNMET, not an error" —
  // a half-filled form is a normal state, so an absent operand simply does not
  // satisfy the predicate rather than throwing or passing.
  let cmp: number;
  if (typeof left === 'number' && typeof right === 'number')
    cmp = left < right ? -1 : left > right ? 1 : 0;
  else if (typeof left === 'string' && typeof right === 'string')
    // Same-variant ISO-8601 strings sort lexicographically in chronological
    // order, so a date comparison is an ordinal string compare — no parsing, no
    // locale, total for every variant.
    cmp = left < right ? -1 : left > right ? 1 : 0;
  else return false;
  switch (op) {
    case 'eq':
      return cmp === 0;
    case 'neq':
      return cmp !== 0;
    case 'lt':
      return cmp < 0;
    case 'lte':
      return cmp <= 0;
    case 'gt':
      return cmp > 0;
    case 'gte':
      return cmp >= 0;
  }
};

/**
 * Apply every declared `compare` over the form's live values. Returns true when
 * the form may submit. The field's own value is read from the DOM (that is the
 * live value the user sees); the operand is read through the declared binding,
 * which is the whole point of the operand being a Binding.
 */
const compareGate = <TMsg,>(
  ctx: RenderContext<TMsg>,
  spec: FormSpec<TMsg>,
  form: HTMLFormElement,
): boolean => {
  let allMet = true;
  for (const field of spec.fields) {
    const cmp = field.rule?.compare;
    const el = form.querySelector<HTMLInputElement | HTMLTextAreaElement>(
      `#${CSS.escape(field.id)}`,
    );
    if (el === null || typeof el.setCustomValidity !== 'function') continue;
    if (cmp === undefined) {
      el.setCustomValidity('');
      continue;
    }
    const raw = el.value;
    // A numeric control's DOM value is a string; compare numerically when both
    // ends genuinely are numbers, and leave everything else as text.
    const against = tryResolve(ctx.sources, cmp.against);
    const left: unknown =
      typeof against === 'number' && raw !== '' && !Number.isNaN(Number(raw)) ? Number(raw) : raw;
    const met = compareMet(cmp.op, left, against);
    if (met) el.setCustomValidity('');
    else {
      allMet = false;
      // `message` is the author's own sentence, and this is the moment it was
      // written for: shown when the rule is unmet rather than permanently, which
      // is the whole argument for declaring the rule instead of putting it in
      // help text.
      el.setCustomValidity(
        field.rule?.message !== undefined
          ? renderText(ctx.sources, field.rule.message)
          : 'This value does not satisfy the declared rule.',
      );
    }
  }
  return allMet;
};

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
        // Phase 864 — the compare gate runs BEFORE the commit event and before
        // the action. A form whose declared rule is unmet must not submit, and
        // "must not submit" means the action does not run and the local commit
        // does not fire, not merely that a message appears beside it.
        if (!compareGate(ctx, spec, e.currentTarget)) {
          e.currentTarget.reportValidity();
          return;
        }
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

// Phase 864 — the declared rule, projected into the platform's own constraint
// attributes so the BROWSER enforces it. That is the static/SSR obligation in
// WIRE_FORMAT's rule table and it is the right shape here too: an attribute the
// browser already understands beats a hand-rolled check on every axis that
// matters, including the ones we would get wrong.
//
// `compare` has NO HTML equivalent, and the specification requires a host to
// record that as a known limit rather than imply coverage — so it is deliberately
// absent from both helpers below and is carried by the submit gate instead.
const textFormatType = (f: TextFormat | undefined): 'text' | 'email' | 'url' | 'tel' =>
  f === undefined ? 'text' : f;

/**
 * The length + pattern attributes a text-shaped control can carry. Emitted ONLY
 * when the slot is present, so a field with no rule produces byte-identical
 * markup to the pre-864 renderer — which is what makes the server tier's
 * deterministic-render hash unchanged for every existing tree.
 */
const ruleAttrs = (
  rule: FieldRule | undefined,
  includePattern: boolean,
): Record<string, string | number> =>
  rule === undefined
    ? {}
    : {
        ...(includePattern && rule.pattern !== undefined ? { pattern: rule.pattern } : {}),
        ...(rule.minLength !== undefined ? { minLength: rule.minLength } : {}),
        ...(rule.maxLength !== undefined ? { maxLength: rule.maxLength } : {}),
        // The `compare` DECLARATION, spelled exactly as the F# reference host
        // spells it. Nothing in the platform reads it; the submit gate below is
        // what enforces the predicate. It is emitted so a reader — and a
        // devtools inspector — can see the constraint was not silently dropped.
        ...(rule.compare !== undefined
          ? {
              'data-fuaran-field-compare': `${rule.compare.op}:${
                rule.compare.against.kind === 'State' ? rule.compare.against.key : ''
              }`,
            }
          : {}),
      };

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
          // Phase 864 — `rule.format` chooses the input TYPE, because the type
          // IS the accepted set's HTML projection rather than a second place
          // the wire says the same thing.
          type={textFormatType(field.rule?.format)}
          id={field.id}
          required={field.required}
          {...ruleAttrs(field.rule, true)}
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
    // Phase 766 — the switch affordance: same boolean data and write-back as
    // Checkbox on a native checkbox input (keyboard + focus for free), with the
    // switch a11y contract a screen reader announces as on/off.
    case 'Toggle': {
      const current = tryResolve(ctx.sources, k.value) ?? false;
      const onToggle = k.onToggle;
      return (
        <input
          className="fuaran-form-toggle"
          type="checkbox"
          role="switch"
          aria-checked={current === true}
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
          // Phase 864 — a textarea has a LENGTH and no input type, so it takes
          // the length pair and not `format`; `pattern` is likewise not an
          // attribute HTML gives a textarea. FUARAN100 warns an author who
          // declares either on this control.
          {...ruleAttrs(field.rule, false)}
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
    // Phase 1113 - the full WAI-ARIA combobox. The pattern is stateful (popup
    // open, ACTIVE option, in-progress query) in a way the tree is not, so it is
    // a function component; the renderer resolves the bindings here and the
    // component holds only the interaction. Nothing on the wire named a
    // keystroke - the keyboard walk is entirely the renderer's.
    case 'Combobox': {
      const comboOnChange = k.onChange;
      const currentRaw = tryResolve(ctx.sources, k.value);
      const current = typeof currentRaw === 'string' && currentRaw !== '' ? currentRaw : undefined;
      return (
        <ComboboxControl
          fieldId={field.id}
          className="fuaran-form-field-control fuaran-combobox-input"
          required={field.required}
          allowFreeText={k.allowFreeText}
          placeholder=""
          options={asArray<SelectOption>(tryResolve(ctx.sources, k.options))}
          labelOf={(o) => renderText(ctx.sources, o.label)}
          committed={current}
          commit={(chosen) => {
            handle(comboOnChange, k.value, chosen, chosen);
          }}
        />
      );
    }
    // Phase 1121 — the chip row plus the entry input. Stateful in a way the tree
    // is not (the in-progress entry, the suggestion popup, the refusal
    // announcement), so it is a function component; the renderer resolves the
    // bindings here and the component holds only the interaction.
    case 'Tokens': {
      const tokensOnChange = k.onChange;
      const suggestions =
        k.suggestions !== undefined
          ? asArray<SelectOption>(tryResolve(ctx.sources, k.suggestions))
          : undefined;
      return (
        <TokensControl
          fieldId={field.id}
          required={field.required}
          allowFreeText={k.allowFreeText}
          suggestions={suggestions}
          labelOf={(o) => renderText(ctx.sources, o.label)}
          tokens={asArray<string>(tryResolve(ctx.sources, k.value) ?? [])}
          commit={(next) => {
            handle(tokensOnChange, k.value, next as unknown as JsonValue, next);
          }}
        />
      );
    }
    // Phase 1130 — two markups, chosen by what the document can honour, and the
    // choice is normative rather than cosmetic.
    //
    // An ADJUSTABLE rating is `role="slider"`: it is a MAGNITUDE, not a set of
    // named options, `aria-valuetext` is the only ARIA member that can announce
    // a fraction at all, and with `allowHalf` a radiogroup would need 2·max
    // radios for one continuous quantity. ONE tab stop; the arrows move by the
    // granularity and STOP at both ends — a slider's ends are ends, and wrapping
    // turns "one more star" into "none".
    //
    // A rating NOTHING CAN WRITE is `role="img"` carrying the whole reading as
    // its accessible name, and takes no focus: a slider a reader can focus and
    // can never move is a fake affordance, and the honest markup for a picture
    // of a score is a picture.
    case 'Rating': {
      const ratingOnChange = k.onChange;
      const shown = ratingClamp(k.max, Number(tryResolve(ctx.sources, k.value) ?? 0));
      const writable = ratingOnChange !== undefined || isWriteBackTarget(k.value);
      return (
        <RatingControl
          fieldId={field.id}
          max={k.max}
          allowHalf={k.allowHalf}
          value={shown}
          writable={writable}
          commit={(next) => {
            handle(ratingOnChange, k.value, next, next);
          }}
        />
      );
    }
    // Phase 1130 — the platform's native colour input IS the control: there is
    // no ARIA to hand-write and no keyboard model to invent. A value the element
    // could not hold falls back to the unset default rather than being passed
    // through, because a native colour input substitutes its own default
    // silently — so handing it a bad literal would show a colour the document
    // did not choose while the tree still said otherwise.
    case 'Color': {
      const colorOnChange = k.onChange;
      const raw = tryResolve(ctx.sources, k.value);
      const current = typeof raw === 'string' && isHexColor(raw) ? raw : '#000000';
      return (
        <input
          className="fuaran-form-input"
          type="color"
          id={field.id}
          required={field.required}
          value={current}
          onChange={(e: ChangeEvent<HTMLInputElement>) =>
            handle(colorOnChange, k.value, e.target.value, e.target.value)
          }
        />
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
          // Phase 864 — a date control takes NO constraint attribute from the
          // rule slot: `min`/`max` above are the control's own bounds, and the
          // reuse rule forbids the rule duplicating them. What it can carry is
          // the `compare` DECLARATION, and a date field is where cross-field
          // comparison actually arrives ("end date after start date"), so the
          // marker is emitted here to match the reference host. It claims
          // nothing — the submit gate is what enforces the predicate.
          {...ruleAttrs(
            field.rule?.compare === undefined ? undefined : { compare: field.rule.compare },
            false,
          )}
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

// ─── The WAI-ARIA combobox (Phase 1113) ────────────────────────
//
//  The APG "combobox with listbox popup" pattern, mirroring the F# tier's
//  `ComboboxControl`. Focus never leaves the input: the listbox and its options
//  are not focus stops, and the active option is named by
//  `aria-activedescendant` - which is what lets a screen reader announce the
//  highlighted option while the reader keeps typing.
//
//  A pointer commits by `mousedown`, NOT `click`: the input's `blur` would
//  otherwise fire first, close the popup and unmount the option before the
//  click landed on it.
//
//  With `allowFreeText: false` the reader may type anything (typing IS how the
//  list is searched) but only an option commits; blurring with an unmatched
//  entry restores the committed value. That restore is an AFFORDANCE and never
//  a gate - the trust boundary is the host's server-side re-check on submit.

/** The id an option element takes. Derived from the field id and the option's
 *  INDEX rather than its value: `aria-activedescendant` must name an element
 *  that exists, and an option value can carry characters invalid in an id. */
const comboboxOptionId = (fieldId: string, index: number): string =>
  `${fieldId}-option-${String(index)}`;

function ComboboxControl({
  fieldId,
  className,
  required,
  allowFreeText,
  placeholder,
  options,
  labelOf,
  committed,
  commit,
}: {
  fieldId: string;
  className: string;
  required: boolean;
  allowFreeText: boolean;
  placeholder: string;
  options: readonly SelectOption[];
  labelOf: (o: SelectOption) => string;
  committed: string | undefined;
  commit: (chosen: string | undefined) => void;
}): ReactElement {
  const matched = options.find((o) => o.value === committed);
  // Free text that matches no option is its own label; a constrained control
  // cannot reach this branch with a value it did not commit.
  const committedLabel = matched !== undefined ? labelOf(matched) : (committed ?? '');

  const [query, setQuery] = useState<string>(committedLabel);
  const [isOpen, setOpen] = useState<boolean>(false);
  const [activeIndex, setActiveIndex] = useState<number>(-1);
  const openRef = useRef(isOpen);
  openRef.current = isOpen;

  // Re-seed the entry text when the committed value moves underneath us. Only
  // while the popup is CLOSED, so an unrelated model update cannot rewrite what
  // the reader is halfway through typing.
  useEffect(() => {
    if (!openRef.current) setQuery(committedLabel);
  }, [committedLabel]);

  // An empty query shows everything - opening the popup with no text typed is
  // how a reader browses the set.
  const visible =
    query === ''
      ? options
      : options.filter((o) => {
          const needle = query.toLowerCase();
          return (
            labelOf(o).toLowerCase().includes(needle) || o.value.toLowerCase().includes(needle)
          );
        });

  const listId = `${fieldId}-listbox`;

  const close = (): void => {
    setOpen(false);
    setActiveIndex(-1);
  };

  const commitOption = (o: SelectOption): void => {
    setQuery(labelOf(o));
    close();
    commit(o.value);
  };

  // Leaving the control. A matched entry commits; an unmatched one commits only
  // where free text is admitted. Clearing the box clears the selection in both
  // modes - an empty entry is "no value", the one reading both modes share.
  const settle = (): void => {
    close();
    if (query.trim() === '') {
      setQuery('');
      commit(undefined);
      return;
    }
    const hit = options.find((o) => labelOf(o) === query || o.value === query);
    if (hit !== undefined) {
      setQuery(labelOf(hit));
      commit(hit.value);
    } else if (allowFreeText) {
      commit(query);
    } else {
      setQuery(committedLabel);
    }
  };

  const move = (delta: number): void => {
    setOpen(true);
    if (visible.length === 0) return;
    const next = activeIndex + delta;
    setActiveIndex(next < 0 ? visible.length - 1 : next >= visible.length ? 0 : next);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      move(1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      move(-1);
    } else if (e.key === 'Home' && isOpen) {
      e.preventDefault();
      if (visible.length > 0) setActiveIndex(0);
    } else if (e.key === 'End' && isOpen) {
      e.preventDefault();
      if (visible.length > 0) setActiveIndex(visible.length - 1);
    } else if (e.key === 'Enter') {
      if (isOpen && activeIndex >= 0 && activeIndex < visible.length) {
        // The popup owns Enter while an option is highlighted; without this the
        // keystroke submits the enclosing form and loses the selection.
        e.preventDefault();
        const picked = visible[activeIndex];
        if (picked !== undefined) commitOption(picked);
      } else if (isOpen) {
        e.preventDefault();
        settle();
      }
    } else if (e.key === 'Escape') {
      if (isOpen) {
        e.preventDefault();
        close();
        setQuery(committedLabel);
      }
    } else if (e.key === 'Tab') {
      // Tab moves on and settles; it must NOT be swallowed, or the control
      // becomes a keyboard trap.
      settle();
    }
  };

  const activeDescendant =
    isOpen && activeIndex >= 0 && activeIndex < visible.length
      ? comboboxOptionId(fieldId, activeIndex)
      : undefined;

  return (
    <span className="fuaran-combobox">
      <input
        className={className}
        type="text"
        id={fieldId}
        required={required}
        placeholder={placeholder}
        role="combobox"
        aria-expanded={isOpen}
        aria-controls={listId}
        aria-autocomplete="list"
        autoComplete="off"
        {...(activeDescendant !== undefined ? { 'aria-activedescendant': activeDescendant } : {})}
        value={query}
        onChange={(e: ChangeEvent<HTMLInputElement>) => {
          setQuery(e.target.value);
          setOpen(true);
          setActiveIndex(-1);
        }}
        onKeyDown={onKeyDown}
        onBlur={() => {
          settle();
        }}
      />
      <ul className="fuaran-combobox-list" id={listId} role="listbox" hidden={!isOpen}>
        {visible.map((o, i) => (
          <li
            key={`${String(i)}:${o.value}`}
            id={comboboxOptionId(fieldId, i)}
            role="option"
            aria-selected={i === activeIndex}
            className={
              i === activeIndex
                ? 'fuaran-combobox-option fuaran-combobox-option-active'
                : 'fuaran-combobox-option'
            }
            onMouseDown={(e) => {
              e.preventDefault();
              commitOption(o);
            }}
          >
            {labelOf(o)}
          </li>
        ))}
      </ul>
    </span>
  );
}

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

/**
 * Phase 1115 — does `accept` admit this file? The list is the wire's `accept`,
 * the same value the `<input accept>` attribute carries, so this reproduces the
 * user agent's own picker filter for the two routes the picker is not on.
 *
 * An EMPTY list admits everything, exactly as an absent `accept` attribute does.
 * Three entry shapes are recognised and they are the three HTML defines: an
 * extension (`.csv`), a wildcard MIME (`image/*`) and an exact MIME
 * (`text/csv`). Anything else matches NOTHING rather than everything — a
 * spelling the picker would not honour must not open a route the picker does
 * not.
 */
export const uploadAdmits = (accept: readonly string[], name: string, mime: string): boolean => {
  if (accept.length === 0) return true;
  const n = name.toLowerCase();
  const m = mime.toLowerCase();
  return accept.some((raw) => {
    const entry = raw.trim().toLowerCase();
    if (entry === '') return false;
    if (entry.startsWith('.')) return n.endsWith(entry);
    if (entry.endsWith('/*')) return m !== '' && m.startsWith(entry.slice(0, -1));
    return m !== '' && m === entry;
  });
};

/**
 * Phase 1115 — the drop / paste affordance around an otherwise unchanged file
 * control.
 *
 * **The one design decision everything else follows from:** an ingested file is
 * written into the control's OWN `<input type="file">` (via a `DataTransfer`)
 * and a bubbling `change` is dispatched from it, rather than being handed to
 * `onSelect` directly. That gives one selection path, the user agent's own
 * filename chrome as the control's feedback, and — decisively — an
 * `input.files` any host mechanism that reads the selection off the element
 * can see. A renderer that dispatched around the input would leave a dropped
 * file reachable here and invisible there, silently.
 *
 * A function component because the drag depth and the refusal count live for
 * one interaction and are never part of the document. The children are built by
 * the caller, so there is exactly one definition of the control's markup.
 */
const UploadDropZone = (props: {
  readonly className: string;
  readonly dropTarget: boolean;
  readonly acceptPaste: boolean;
  readonly accept: readonly string[];
  readonly multiple: boolean;
  readonly children: ReactNode;
}): ReactElement => {
  // A COUNTER, not a flag: dragenter / dragleave fire for every descendant the
  // pointer crosses, so a boolean flickers off the moment the drag passes over
  // the label's own <span>.
  const [depth, setDepth] = useState(0);
  const [refused, setRefused] = useState(0);

  const ingest = (container: Element, all: readonly File[]): void => {
    if (all.length === 0) return;
    const accepted = all.filter((f) => uploadAdmits(props.accept, f.name, f.type));
    // A single-file control takes the FIRST accepted file, matching the picker.
    const kept = props.multiple || accepted.length <= 1 ? accepted : accepted.slice(0, 1);
    setRefused(all.length - kept.length);
    if (kept.length === 0) return;
    try {
      const input = container.querySelector('input[type=file]') as HTMLInputElement | null;
      if (!input || typeof DataTransfer === 'undefined') return;
      const dt = new DataTransfer();
      for (const f of kept) dt.items.add(f);
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    } catch (e) {
      console.warn(`[Fuaran] FileUpload drop/paste ingest failed: ${String(e)}`);
    }
  };

  const classes = [
    props.className,
    'fuaran-upload-drop',
    ...(depth > 0 ? ['fuaran-upload-drop-active'] : []),
    ...(refused > 0 ? ['fuaran-upload-drop-refused'] : []),
  ].join(' ');

  return (
    <label
      className={classes}
      {...(props.dropTarget
        ? {
            // preventDefault on BOTH enter and over is what makes the element a
            // drop target at all; omitting it on dragover is the classic silent
            // failure — the zone highlights and then refuses the drop.
            onDragEnter: (e: DragEvent) => {
              e.preventDefault();
              setDepth((d) => d + 1);
            },
            onDragOver: (e: DragEvent) => e.preventDefault(),
            onDragLeave: (e: DragEvent) => {
              e.preventDefault();
              setDepth((d) => Math.max(0, d - 1));
            },
            onDrop: (e: DragEvent) => {
              // Consumed even when every file is refused, so the browser's own
              // default action (navigating to the dropped file) never fires.
              e.preventDefault();
              setDepth(0);
              ingest(e.currentTarget, Array.from(e.dataTransfer?.files ?? []));
            },
          }
        : {})}
      {...(props.acceptPaste
        ? {
            // Only a paste CARRYING FILES is consumed; a text paste keeps its
            // default action, so an editable descendant is unaffected.
            onPaste: (e: ClipboardEvent) => {
              const files = Array.from(e.clipboardData?.files ?? []);
              if (files.length === 0) return;
              e.preventDefault();
              ingest(e.currentTarget, files);
            },
          }
        : {})}
    >
      {props.children}
      {refused > 0 ? (
        <span className="fuaran-upload-drop-hint" role="status">
          {refused === 1
            ? '1 file was not accepted by this upload.'
            : `${refused} files were not accepted by this upload.`}
        </span>
      ) : null}
    </label>
  );
};

const renderFileUpload = <TMsg,>(
  ctx: RenderContext<TMsg>,
  spec: FileUploadSpec<TMsg>,
): ReactElement => {
  const acceptStr = spec.accept.length === 0 ? undefined : spec.accept.join(',');
  // Phase 130: optional bound disabled-state — emit the HTML `disabled`
  // attribute on the file input when the binding resolves `true`.
  const isDisabled =
    spec.disabled !== undefined ? tryResolve(ctx.sources, spec.disabled) === true : false;
  const children = (
    <>
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
    </>
  );

  // Phase 1115 — neither gesture declared is the shape every document written
  // before this revision has, and it renders EXACTLY what it rendered then: the
  // omit-at-`false` polarity is visible here as well as on the wire.
  return spec.dropTarget || spec.acceptPaste ? (
    <UploadDropZone
      className="fuaran-file-upload"
      dropTarget={spec.dropTarget}
      acceptPaste={spec.acceptPaste}
      accept={spec.accept}
      multiple={spec.multiple}
    >
      {children}
    </UploadDropZone>
  ) : (
    <label className="fuaran-file-upload">{children}</label>
  );
};

// ─── `Tokens` (Phase 1121) ───────────────────────────────────────────────────
//
//  The chips are a `role="list"` of `role="listitem"`, each carrying a REAL
//  `<button>` that removes it — NOT a `role="listbox"` of `role="option"`, and
//  the three reasons are worth stating because the listbox reading is the one a
//  writer reaches for first. A listbox is for CHOOSING from candidates, and
//  these are not candidates: they are the value, already chosen, and the
//  candidates live in the suggestion popup, which IS a listbox. `aria-selected`
//  has no honest value on a chip — every chip is selected and none can be
//  deselected. And the gesture a chip offers is REMOVAL, which is a button: a
//  real one carries the platform's own name, role, focus ring and activation.
//
//  Each remove control's accessible name NAMES THE TOKEN IT REMOVES; a row of
//  buttons all reading "Remove" is a row a screen-reader user cannot tell apart.
//
//  The entry input carries `role="combobox"` ONLY where a suggestion source was
//  declared. With none it is a plain text input and no combobox ARIA is emitted:
//  a `role="combobox"` with nothing to expand is the overclaim §3.6.9 forbids a
//  static host to make, and it is no better here.
//
//  A refused entry (`allowFreeText: false`, no match) is ANNOUNCED and never
//  swallowed — a control that ignores a keystroke without saying why reads as
//  broken. The refusal is an AFFORDANCE and never a gate: client validation is
//  not a trust boundary, so a host that accepts submissions re-checks membership
//  and uniqueness server-side.

function TokensControl({
  fieldId,
  required,
  allowFreeText,
  suggestions,
  labelOf,
  tokens,
  commit,
}: {
  fieldId: string;
  required: boolean;
  allowFreeText: boolean;
  suggestions: readonly SelectOption[] | undefined;
  labelOf: (o: SelectOption) => string;
  tokens: readonly string[];
  commit: (next: readonly string[]) => void;
}): ReactElement {
  const [entry, setEntry] = useState<string>('');
  const [status, setStatus] = useState<string>('');
  const [open, setOpen] = useState<boolean>(false);
  const [active, setActive] = useState<number>(-1);
  const listId = `${fieldId}-suggestions`;

  const labelFor = (value: string): string => {
    const match = suggestions?.find((o) => o.value === value);
    return match !== undefined ? labelOf(match) : value;
  };

  const filtered =
    suggestions === undefined
      ? []
      : suggestions.filter(
          (o) =>
            !tokens.includes(o.value) &&
            (entry === '' || labelOf(o).toLowerCase().includes(entry.toLowerCase())),
        );

  const add = (raw: string): void => {
    const token = raw.trim();
    if (token === '') return;
    // A suggestion is matched on either half — a reader types what they SEE,
    // and what the list carries is the value.
    const matched = suggestions?.find((o) => o.value === token || labelOf(o) === token);
    const resolved = matched?.value ?? token;
    if (tokens.includes(resolved)) {
      // Refused rather than appended: two identical chips are one fact drawn
      // twice, with two remove buttons that do different things.
      setStatus(`${labelFor(resolved)} is already in the list.`);
      return;
    }
    if (!allowFreeText && matched === undefined) {
      setStatus(`${token} is not one of the available options.`);
      return;
    }
    setStatus('');
    setEntry('');
    setActive(-1);
    setOpen(false);
    commit([...tokens, resolved]);
  };

  const removeAt = (index: number): void => {
    setStatus('');
    commit(tokens.filter((_, i) => i !== index));
  };

  return (
    <span className="fuaran-tokens">
      <span className="fuaran-tokens-list" role="list">
        {tokens.map((t, i) => (
          <span key={t} className="fuaran-tokens-chip" role="listitem">
            <span className="fuaran-tokens-chip-label">{labelFor(t)}</span>
            <button
              type="button"
              className="fuaran-tokens-chip-remove"
              aria-label={`Remove ${labelFor(t)}`}
              onClick={() => removeAt(i)}
            >
              {'×'}
            </button>
          </span>
        ))}
      </span>
      <input
        className="fuaran-form-field-control fuaran-tokens-input"
        data-fuaran-field={fieldId}
        type="text"
        required={required && tokens.length === 0}
        value={entry}
        autoComplete="off"
        {...(suggestions !== undefined
          ? {
              role: 'combobox',
              'aria-expanded': open,
              'aria-controls': listId,
              'aria-autocomplete': 'list' as const,
              ...(open && active >= 0 && active < filtered.length
                ? { 'aria-activedescendant': `${listId}-option-${String(active)}` }
                : {}),
            }
          : {})}
        onChange={(e: ChangeEvent<HTMLInputElement>) => {
          setEntry(e.target.value);
          setStatus('');
          if (suggestions !== undefined) setOpen(true);
        }}
        onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            if (open && active >= 0 && active < filtered.length) add(filtered[active]!.value);
            else add(entry);
            return;
          }
          if (e.key === 'Backspace' && entry === '' && tokens.length > 0) {
            e.preventDefault();
            removeAt(tokens.length - 1);
            return;
          }
          if (suggestions === undefined) return;
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setOpen(true);
            setActive((a) => Math.min(a + 1, filtered.length - 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setActive((a) => Math.max(a - 1, 0));
          } else if (e.key === 'Escape') {
            setOpen(false);
            setActive(-1);
          }
        }}
        onBlur={() => {
          setOpen(false);
          setActive(-1);
        }}
      />
      {suggestions !== undefined ? (
        <ul className="fuaran-tokens-suggestions" id={listId} role="listbox" hidden={!open}>
          {filtered.map((o, i) => (
            <li
              key={o.value}
              id={`${listId}-option-${String(i)}`}
              role="option"
              aria-selected={i === active}
              className={
                i === active
                  ? 'fuaran-tokens-option fuaran-tokens-option-active'
                  : 'fuaran-tokens-option'
              }
              // A pointer commits by `mousedown`, NOT `click`: the input's
              // `blur` would otherwise fire first, close the popup and unmount
              // the option before the click landed on it.
              onMouseDown={(e) => {
                e.preventDefault();
                add(o.value);
              }}
            >
              {labelOf(o)}
            </li>
          ))}
        </ul>
      ) : null}
      <span className="fuaran-tokens-status" role="status">
        {status}
      </span>
    </span>
  );
}

// ─── `Rating` (Phase 1130) ───────────────────────────────────────────────────

function RatingControl({
  fieldId,
  max,
  allowHalf,
  value,
  writable,
  commit,
}: {
  fieldId: string;
  max: number;
  allowHalf: boolean;
  value: number;
  writable: boolean;
  commit: (next: number) => void;
}): ReactElement {
  const stars = ratingFills(max, value).map((fill, i) => (
    <span key={i} className={`fuaran-rating-star ${ratingFillClass(fill)}`} aria-hidden="true" />
  ));
  if (!writable) {
    return (
      <span
        className="fuaran-form-field-control fuaran-rating fuaran-rating-static"
        role="img"
        aria-label={ratingValueText(max, value)}
        data-fuaran-field={fieldId}
      >
        {stars}
      </span>
    );
  }
  const stepSize = ratingStep(allowHalf);
  const positions = Math.round(max / stepSize);
  return (
    <span
      className="fuaran-form-field-control fuaran-rating fuaran-rating-choices"
      data-fuaran-field={fieldId}
      role="slider"
      tabIndex={0}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={value}
      // The only ARIA member that can announce a FRACTION at all, which is why
      // it is stated rather than left to `aria-valuenow` alone.
      aria-valuetext={ratingValueText(max, value)}
      onKeyDown={(e: KeyboardEvent<HTMLSpanElement>) => {
        // The ends are ENDS: Arrow past either stops there rather than wrapping,
        // because wrapping turns "one more star" into "none".
        const next =
          e.key === 'ArrowRight' || e.key === 'ArrowUp'
            ? ratingClamp(max, value + stepSize)
            : e.key === 'ArrowLeft' || e.key === 'ArrowDown'
              ? ratingClamp(max, value - stepSize)
              : e.key === 'Home'
                ? 0
                : e.key === 'End'
                  ? max
                  : undefined;
        if (next === undefined) return;
        e.preventDefault();
        commit(next);
      }}
    >
      {stars}
      {/* The pointer targets. They are `aria-hidden` because the slider above
          already carries the whole widget's semantics — exposing them would
          announce one quantity as `max / step` separate controls. */}
      <span className="fuaran-rating-hits" aria-hidden="true">
        {Array.from({ length: positions }, (_, i) => {
          const target = ratingSnap(allowHalf, max, (i + 1) * stepSize);
          return (
            <span
              key={i}
              className="fuaran-rating-hit"
              onMouseDown={(e) => {
                e.preventDefault();
                commit(target);
              }}
            />
          );
        })}
      </span>
    </span>
  );
}
