/**
 * The curve editor.
 *
 * A transfer curve is the most direct control a terrain tool has: drag the
 * bottom down and valleys deepen, flatten the middle and a plain appears, lift
 * the top and peaks sharpen. It only works if you can see what you are doing,
 * which means drawing the actual interpolated curve rather than a polyline
 * through the handles — the engine uses monotone cubic interpolation, and a
 * straight-line preview would be a different curve from the one being applied.
 */

import { useCallback, useMemo, useRef, useState } from 'react';
import { evaluateCurve, type CurvePoint } from '@terrasmith/core';

interface Props {
  points: CurvePoint[];
  onChange(points: CurvePoint[]): void;
  /** Shown under the axes so the numbers mean something. */
  unit?: string;
  /** Real-world values the 0..1 axes correspond to. */
  range?: { min: number; max: number };
}

const SIZE = 220;
const PAD = 10;

/** Handles closer together than this in x would make the curve un-editable. */
const MIN_SPACING = 0.02;

export function CurveEditor({ points, onChange, unit, range }: Props) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [dragging, setDragging] = useState<number | null>(null);

  const sorted = useMemo(() => [...points].sort((a, b) => a.x - b.x), [points]);

  const toScreen = useCallback(
    (p: CurvePoint) => ({
      x: PAD + p.x * (SIZE - PAD * 2),
      // SVG y grows downward; a curve editor's y grows upward.
      y: SIZE - PAD - p.y * (SIZE - PAD * 2),
    }),
    [],
  );

  const fromEvent = useCallback((event: React.PointerEvent): CurvePoint => {
    const rect = svgRef.current!.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / rect.width) * SIZE;
    const y = ((event.clientY - rect.top) / rect.height) * SIZE;
    return {
      x: clamp01((x - PAD) / (SIZE - PAD * 2)),
      y: clamp01((SIZE - PAD - y) / (SIZE - PAD * 2)),
    };
  }, []);

  /** The curve itself, sampled densely enough that it reads as a curve. */
  const path = useMemo(() => {
    const steps = 96;
    const parts: string[] = [];
    for (let i = 0; i <= steps; i++) {
      const x = i / steps;
      const screen = toScreen({ x, y: clamp01(evaluateCurve(sorted, x)) });
      parts.push(`${i === 0 ? 'M' : 'L'}${screen.x.toFixed(2)},${screen.y.toFixed(2)}`);
    }
    return parts.join(' ');
  }, [sorted, toScreen]);

  const move = (index: number, next: CurvePoint) => {
    const updated = sorted.map((p, i) => (i === index ? next : p));
    // The first and last handles anchor the ends of the range; letting them
    // slide inward leaves the curve undefined outside them.
    if (index === 0) updated[0] = { ...updated[0], x: 0 };
    if (index === sorted.length - 1) updated[index] = { ...updated[index], x: 1 };
    // Keep handles in order and apart: a monotone spline through two handles at
    // the same x is a vertical jump nobody can then grab.
    for (let i = 1; i < updated.length; i++) {
      if (updated[i].x <= updated[i - 1].x + MIN_SPACING) {
        updated[i] = { ...updated[i], x: Math.min(1, updated[i - 1].x + MIN_SPACING) };
      }
    }
    onChange(updated);
  };

  const addPoint = (event: React.PointerEvent) => {
    const p = fromEvent(event);
    const next = [...sorted, p].sort((a, b) => a.x - b.x);
    onChange(next);
    setDragging(next.findIndex((q) => q === p));
  };

  const removePoint = (index: number) => {
    // Two handles is the minimum a curve can be defined by.
    if (sorted.length <= 2) return;
    onChange(sorted.filter((_, i) => i !== index));
  };

  const label = (t: number) =>
    range ? Math.round(range.min + t * (range.max - range.min)).toString() : t.toFixed(1);

  return (
    <div>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${SIZE} ${SIZE}`}
        style={{
          width: '100%',
          aspectRatio: '1',
          background: 'var(--bg-0)',
          border: '1px solid var(--line)',
          borderRadius: 'var(--radius-sm)',
          touchAction: 'none',
          cursor: dragging === null ? 'crosshair' : 'grabbing',
        }}
        onPointerDown={(e) => {
          if (e.target === svgRef.current) addPoint(e);
        }}
        onPointerMove={(e) => {
          if (dragging === null) return;
          e.preventDefault();
          move(dragging, fromEvent(e));
        }}
        onPointerUp={() => setDragging(null)}
        onPointerLeave={() => setDragging(null)}
      >
        {[0.25, 0.5, 0.75].map((t) => (
          <g key={t}>
            <line
              x1={PAD + t * (SIZE - PAD * 2)}
              y1={PAD}
              x2={PAD + t * (SIZE - PAD * 2)}
              y2={SIZE - PAD}
              stroke="var(--line)"
              strokeWidth={0.5}
            />
            <line
              x1={PAD}
              y1={PAD + t * (SIZE - PAD * 2)}
              x2={SIZE - PAD}
              y2={PAD + t * (SIZE - PAD * 2)}
              stroke="var(--line)"
              strokeWidth={0.5}
            />
          </g>
        ))}

        {/* The identity line: anything on it is unchanged, which is the
            reference every edit is judged against. */}
        <line
          x1={PAD}
          y1={SIZE - PAD}
          x2={SIZE - PAD}
          y2={PAD}
          stroke="var(--line-strong)"
          strokeWidth={0.75}
          strokeDasharray="3 3"
        />

        <path d={path} fill="none" stroke="var(--accent)" strokeWidth={1.75} />

        {sorted.map((point, index) => {
          const screen = toScreen(point);
          return (
            <circle
              key={index}
              cx={screen.x}
              cy={screen.y}
              r={dragging === index ? 5.5 : 4}
              fill={dragging === index ? 'var(--accent)' : 'var(--bg-2)'}
              stroke="var(--accent)"
              strokeWidth={1.5}
              style={{ cursor: 'grab' }}
              onPointerDown={(e) => {
                e.stopPropagation();
                (e.target as Element).setPointerCapture(e.pointerId);
                setDragging(index);
              }}
              onDoubleClick={(e) => {
                e.stopPropagation();
                removePoint(index);
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                removePoint(index);
              }}
            />
          );
        })}
      </svg>

      <div
        className="row"
        style={{ justifyContent: 'space-between', marginTop: 4, fontSize: 11, color: 'var(--text-3)' }}
      >
        <span>
          {label(0)}
          {unit ? ` ${unit}` : ''}
        </span>
        <span>
          {label(1)}
          {unit ? ` ${unit}` : ''}
        </span>
      </div>

      <div className="row" style={{ marginTop: 6, gap: 6, flexWrap: 'wrap' }}>
        {CURVE_PRESETS.map((preset) => (
          <button
            key={preset.label}
            className="btn"
            style={{ height: 22, fontSize: 11 }}
            title={preset.hint}
            onClick={() => onChange(preset.points.map((p) => ({ ...p })))}
          >
            {preset.label}
          </button>
        ))}
      </div>

      <div className="field-help" style={{ marginTop: 5 }}>
        Click to add a point, drag to move it, double-click to remove it. The dashed line is no
        change.
      </div>
    </div>
  );
}

/**
 * Starting shapes, named for what they do to terrain rather than for their
 * mathematics. "Ease out" tells you nothing; "deepen valleys" tells you why you
 * would press it.
 */
const CURVE_PRESETS: { label: string; hint: string; points: CurvePoint[] }[] = [
  {
    label: 'Linear',
    hint: 'No change.',
    points: [
      { x: 0, y: 0 },
      { x: 1, y: 1 },
    ],
  },
  {
    label: 'Deepen valleys',
    hint: 'Pushes low ground lower and leaves the high ground where it is.',
    points: [
      { x: 0, y: 0 },
      { x: 0.45, y: 0.22 },
      { x: 1, y: 1 },
    ],
  },
  {
    label: 'Raise plains',
    hint: 'Lifts the low and middle ground into a broad plain below the peaks.',
    points: [
      { x: 0, y: 0 },
      { x: 0.4, y: 0.62 },
      { x: 1, y: 1 },
    ],
  },
  {
    label: 'Flatten middle',
    hint: 'A wide shelf between low and high ground — buildable, and a natural place to fight over.',
    points: [
      { x: 0, y: 0 },
      { x: 0.32, y: 0.42 },
      { x: 0.68, y: 0.5 },
      { x: 1, y: 1 },
    ],
  },
  {
    label: 'Sharpen peaks',
    hint: 'Compresses everything below the top and stretches the summits.',
    points: [
      { x: 0, y: 0 },
      { x: 0.7, y: 0.4 },
      { x: 1, y: 1 },
    ],
  },
];

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
