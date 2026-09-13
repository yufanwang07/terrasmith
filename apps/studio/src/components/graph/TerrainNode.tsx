/**
 * How a node looks on the canvas.
 *
 * Three things are on the node itself and nothing else is: its name, its ports,
 * and a one-line summary of what it is currently set to. Everything else lives
 * in the inspector. Nodes that show every parameter turn a graph into a wall of
 * sliders you cannot read the structure of — and structure is the only reason
 * to use a graph.
 */

import { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { NodeDefinition, PortDef } from '@terrasmith/graph';
import { registry } from '../../state/store.js';

export interface TerrainNodeData extends Record<string, unknown> {
  type: string;
  params: Record<string, unknown>;
  title?: string;
  bypassed?: boolean;
  /** Set when the last evaluation failed inside this node. */
  error?: string;
  /** A thumbnail of this node's output, drawn by the preview layer. */
  thumbnail?: ImageBitmap | null;
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

        <div className="ts-node-summary">{summarize(def, nodeData.params)}</div>
      </div>
    </div>
  );
});

/** Category accent, matching the CSS custom properties. */
export function categoryColor(category: string): string {
  return `var(--cat-${category}, var(--cat-utility))`;
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
