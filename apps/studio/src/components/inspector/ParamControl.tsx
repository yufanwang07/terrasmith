/**
 * One parameter, rendered.
 *
 * The rules that make these controls beginner-safe:
 *
 *  - A slider can never produce a value the node cannot handle, because it is
 *    bounded by the parameter's own declared range.
 *  - The number box beside it accepts anything in the *hard* range, so an
 *    expert is not limited by the slider's comfortable range.
 *  - Frequencies and radii use a logarithmic slider, because on a linear one
 *    the useful half of the range is the first two pixels.
 *  - Every control shows its unit, and elmos are labelled as elmos rather than
 *    left as bare numbers nobody can scale.
 */

import { useEffect, useRef, useState } from 'react';
import type { ParamDef } from '@terrasmith/graph';

interface Props {
  def: ParamDef;
  value: unknown;
  onChange(value: unknown): void;
  /** All the node's parameters, for `visibleWhen` predicates. */
  params: Record<string, unknown>;
}

export function ParamControl({ def, value, onChange, params }: Props) {
  if (def.visibleWhen && !def.visibleWhen(params)) return null;

  switch (def.type) {
    case 'boolean':
      return <BooleanControl def={def} value={Boolean(value)} onChange={onChange} />;
    case 'enum':
      return <EnumControl def={def} value={String(value ?? '')} onChange={onChange} />;
    case 'string':
      return <StringControl def={def} value={String(value ?? '')} onChange={onChange} />;
    case 'seed':
      return <SeedControl def={def} value={Number(value ?? 0)} onChange={onChange} />;
    case 'curve':
      return <CurveNote def={def} />;
    case 'number':
    case 'int':
      return <NumberControl def={def} value={Number(value ?? 0)} onChange={onChange} />;
    default:
      return null;
  }
}

function Label({ def, right }: { def: ParamDef; right?: React.ReactNode }) {
  return (
    <div className="field-label">
      <span>{def.label}</span>
      {right}
    </div>
  );
}

function Help({ def }: { def: ParamDef }) {
  if (!def.description) return null;
  return <div className="field-help">{def.description}</div>;
}

function NumberControl({
  def,
  value,
  onChange,
}: {
  def: ParamDef;
  value: number;
  onChange(v: number): void;
}) {
  const hardMin = def.min ?? -Infinity;
  const hardMax = def.max ?? Infinity;
  const sliderMin = def.softMin ?? (Number.isFinite(hardMin) ? hardMin : 0);
  const sliderMax = def.softMax ?? (Number.isFinite(hardMax) ? hardMax : 1);
  const isInt = def.type === 'int';
  const step = def.step ?? (isInt ? 1 : niceStep(sliderMin, sliderMax));

  // The slider works in its own space so a logarithmic parameter still feels
  // linear under the thumb.
  const toSlider = (v: number) =>
    def.logarithmic ? Math.log(Math.max(v, 1e-6)) : v;
  const fromSlider = (s: number) => (def.logarithmic ? Math.exp(s) : s);

  const [text, setText] = useState(() => formatValue(value, isInt));
  const editing = useRef(false);
  useEffect(() => {
    if (!editing.current) setText(formatValue(value, isInt));
  }, [value, isInt]);

  const commit = (raw: string) => {
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) {
      setText(formatValue(value, isInt));
      return;
    }
    const clamped = Math.min(hardMax, Math.max(hardMin, isInt ? Math.round(parsed) : parsed));
    onChange(clamped);
    setText(formatValue(clamped, isInt));
  };

  const showSlider = Number.isFinite(sliderMin) && Number.isFinite(sliderMax) && sliderMax > sliderMin;

  return (
    <div className="field">
      <Label def={def} right={def.unit ? <span className="field-value">{def.unit}</span> : undefined} />
      <div className="row">
        {showSlider && (
          <input
            type="range"
            min={toSlider(sliderMin)}
            max={toSlider(sliderMax)}
            step={def.logarithmic ? (toSlider(sliderMax) - toSlider(sliderMin)) / 200 : step}
            value={toSlider(Math.min(sliderMax, Math.max(sliderMin, value)))}
            onChange={(e) => {
              const next = fromSlider(Number(e.target.value));
              onChange(isInt ? Math.round(next) : roundToStep(next, step));
            }}
          />
        )}
        <input
          className="num-narrow"
          type="number"
          value={text}
          step={step}
          onFocus={() => {
            editing.current = true;
          }}
          onChange={(e) => setText(e.target.value)}
          onBlur={(e) => {
            editing.current = false;
            commit(e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          }}
        />
      </div>
      <Help def={def} />
    </div>
  );
}

function BooleanControl({
  def,
  value,
  onChange,
}: {
  def: ParamDef;
  value: boolean;
  onChange(v: boolean): void;
}) {
  return (
    <div className="field">
      <label className="row" style={{ cursor: 'pointer' }}>
        <input type="checkbox" checked={value} onChange={(e) => onChange(e.target.checked)} />
        <span>{def.label}</span>
      </label>
      <Help def={def} />
    </div>
  );
}

function EnumControl({
  def,
  value,
  onChange,
}: {
  def: ParamDef;
  value: string;
  onChange(v: string): void;
}) {
  const selected = def.options?.find((o) => o.value === value);
  return (
    <div className="field">
      <Label def={def} />
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        {def.options?.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      {/* The selected option's own description is more useful than the
          parameter's once a choice is made, so it wins. */}
      {selected?.description ? (
        <div className="field-help">{selected.description}</div>
      ) : (
        <Help def={def} />
      )}
    </div>
  );
}

function StringControl({
  def,
  value,
  onChange,
}: {
  def: ParamDef;
  value: string;
  onChange(v: string): void;
}) {
  return (
    <div className="field">
      <Label def={def} />
      <input type="text" value={value} onChange={(e) => onChange(e.target.value)} />
      <Help def={def} />
    </div>
  );
}

function SeedControl({
  def,
  value,
  onChange,
}: {
  def: ParamDef;
  value: number;
  onChange(v: number): void;
}) {
  return (
    <div className="field">
      <Label def={def} />
      <div className="row">
        <input
          className="num-narrow"
          type="number"
          value={value}
          onChange={(e) => onChange(Math.round(Number(e.target.value) || 0))}
        />
        <button
          className="btn"
          onClick={() => onChange(Math.floor(Math.random() * 1_000_000))}
          title="Try a different pattern"
        >
          Reroll
        </button>
      </div>
      <Help def={def} />
    </div>
  );
}

function CurveNote({ def }: { def: ParamDef }) {
  return (
    <div className="field">
      <Label def={def} />
      <div className="field-help">Curve editing is available on the node itself.</div>
    </div>
  );
}

function formatValue(value: number, isInt: boolean): string {
  if (isInt) return String(Math.round(value));
  if (Number.isInteger(value)) return String(value);
  if (Math.abs(value) >= 100) return value.toFixed(1);
  if (Math.abs(value) >= 1) return value.toFixed(2);
  return value.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
}

/** A step that gives a slider about 200 usable positions over its range. */
function niceStep(min: number, max: number): number {
  const span = Math.abs(max - min);
  if (span === 0) return 0.01;
  const raw = span / 200;
  const magnitude = Math.pow(10, Math.floor(Math.log10(raw)));
  const normalized = raw / magnitude;
  const snapped = normalized < 1.5 ? 1 : normalized < 3.5 ? 2 : normalized < 7.5 ? 5 : 10;
  return snapped * magnitude;
}

function roundToStep(value: number, step: number): number {
  if (!Number.isFinite(step) || step <= 0) return value;
  return Math.round(value / step) * step;
}
