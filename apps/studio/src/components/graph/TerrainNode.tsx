/**
 * How a node looks on the canvas.
 *
 * Three things are on the node itself and nothing else is: its name, its ports,
 * and a one-line summary of what it is currently set to. Everything else lives
 * in the inspector. Nodes that show every parameter turn a graph into a wall of
 * sliders you cannot read the structure of — and structure is the only reason
 * to use a graph.
 */

import { memo, useEffect, useRef } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { NodeDefinition, PortDef } from '@terrasmith/graph';
import { registry } from '../../state/store.js';
import type { Thumbnail } from '../../state/thumbnails.js';

export interface TerrainNodeData extends Record<string, unknown> {
  type: string;
  params: Record<string, unknown>;
  title?: string;
  bypassed?: boolean;
  /** Set when the last evaluation failed inside this node. */
  error?: string;
  /** A small render of this node's output. */
  thumbnail?: Thumbnail;
}

/**
 * Whether this kind of node gets a thumbnail strip.
 *
 * Decided from the definition rather than from whether a thumbnail has arrived,
 * so the node is the same height before and after one renders. A node that
 * grew by a strip's worth a second after the graph settled would shove its
 * neighbours around every time the user changed a parameter.
 */
export function hasPreview(def: NodeDefinition<never>): boolean {
  return def.outputs.some((port) => port.type === 'field' || port.type === 'color');
}

/** Vertical pitch of ports on a node, matching the `.ts-port` height in CSS. */
const PORT_HEIGHT = 18;
/** Offset from the top of the node to the first port's centre. */
const PORT_TOP = 33;

export const TerrainNode = memo(function TerrainNode({ data, selected }: NodeProps) {
  const nodeData = data as TerrainNodeData;
  const def = registry.get(nodeData.type);

  if (!def) {
    return (
      <div className="ts-node errored">
        <div className="ts-node-head">Unknown node</div>
        <div className="ts-node-summary">{nodeData.type}</div>
      </div>
    );
  }

  const summary = summarize(def, nodeData.params);
  const classes = ['ts-node'];
  if (selected) classes.push('selected');
  if (nodeData.bypassed) classes.push('bypassed');
  if (nodeData.error) classes.push('errored');

  return (
    <div className={classes.join(' ')} title={nodeData.error ?? def.description}>
      <div className="ts-node-head">
        <span className="ts-node-cat" style={{ background: categoryColor(def.category) }} />
        <span>{nodeData.title ?? def.label}</span>
      </div>

      <div className="ts-node-body">
        {def.inputs.map((port, index) => (
          <div className="ts-port" key={port.id}>
            <Handle
              type="target"
              position={Position.Left}
              id={port.id}
              style={{ top: PORT_TOP + index * PORT_HEIGHT }}
              title={port.description ?? port.label}
            />
            <span>
              {port.label}
              {port.optional && <span style={{ color: 'var(--text-3)' }}> ·</span>}
            </span>
          </div>
        ))}

        {def.outputs.map((port, index) => (
          <div className="ts-port out" key={port.id}>
            <span>{port.label}</span>
            <Handle
              type="source"
              position={Position.Right}
              id={port.id}
              style={{ top: PORT_TOP + (def.inputs.length + index) * PORT_HEIGHT }}
              title={port.description ?? port.label}
            />
          </div>
        ))}

        <div className="ts-node-summary" title={summary}>
          {summary}
        </div>
      </div>

      {hasPreview(def) && <NodeThumbnail thumbnail={nodeData.thumbnail} />}
    </div>
  );
});

/**
 * The node's own output, drawn small.
 *
 * Painted through a scratch canvas at the bitmap's real size and scaled up by
 * the browser: `putImageData` ignores the transform, so drawing 48 pixels
 * directly into a 170-pixel canvas would put them in the corner.
 */
function NodeThumbnail({ thumbnail }: { thumbnail?: Thumbnail }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    if (!thumbnail) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      return;
    }
    const scratch = document.createElement('canvas');
    scratch.width = thumbnail.width;
    scratch.height = thumbnail.height;
    scratch
      .getContext('2d')
      ?.putImageData(new ImageData(thumbnail.data, thumbnail.width, thumbnail.height), 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    // Cover, so a non-square map fills the strip rather than leaving bars.
    const scale = Math.max(canvas.width / thumbnail.width, canvas.height / thumbnail.height);
    const w = thumbnail.width * scale;
    const h = thumbnail.height * scale;
    ctx.drawImage(scratch, (canvas.width - w) / 2, (canvas.height - h) / 2, w, h);
  }, [thumbnail]);

  return <canvas className="ts-node-preview" ref={ref} width={168} height={56} />;
}

/** Category accent, matching the CSS custom properties. */
export function categoryColor(category: string): string {
  return `var(--cat-${category}, var(--cat-utility))`;
}

/**
 * The same accent as a real colour.
 *
 * The minimap paints its nodes into an SVG `fill` attribute rather than into a
 * style rule, where a `var()` resolves to nothing and every node comes out
 * invisible — which is what the minimap did until this existed. Resolved from
 * the stylesheet rather than duplicated so the two cannot drift, and cached
 * because the minimap asks once per node per repaint.
 */
const resolvedCategoryColors = new Map<string, string>();

export function categoryColorValue(category: string): string {
  const cached = resolvedCategoryColors.get(category);
  if (cached !== undefined) return cached;
  const style = getComputedStyle(document.documentElement);
  const value =
    style.getPropertyValue(`--cat-${category}`).trim() ||
    style.getPropertyValue('--cat-utility').trim() ||
    '#7a8494';
  resolvedCategoryColors.set(category, value);
  return value;
}

/**
 * A one-line summary of the node's settings.
 *
 * Shows the two or three basic parameters that most define what the node is
 * doing, which is enough to read a graph without opening every node.
 */
function summarize(def: NodeDefinition<never>, params: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const param of def.params) {
    if (param.tier === 'advanced') continue;
    if (parts.length >= 3) break;
    const value = params[param.id];
    if (value === undefined) continue;

    if (param.type === 'enum') {
      const option = param.options?.find((o) => o.value === value);
      if (option) parts.push(option.label.toLowerCase());
      continue;
    }
    if (param.type === 'boolean') {
      if (value) parts.push(param.label.toLowerCase());
      continue;
    }
    if (typeof value === 'number') {
      parts.push(`${param.label.toLowerCase()} ${formatNumber(value)}${param.unit === '°' ? '°' : ''}`);
    }
  }
  return parts.join(' · ');
}

function formatNumber(value: number): string {
  if (Number.isInteger(value)) return String(value);
  if (Math.abs(value) >= 100) return value.toFixed(0);
  if (Math.abs(value) >= 1) return value.toFixed(1);
  return value.toFixed(2);
}

/** Port ids in the order they are drawn, for hit-testing and edge building. */
export function portOrder(def: NodeDefinition<never>): { inputs: PortDef[]; outputs: PortDef[] } {
  return { inputs: def.inputs, outputs: def.outputs };
}
