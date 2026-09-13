/**
 * The node palette.
 *
 * Grouped by category, searchable, and every entry carries its description as a
 * tooltip — because the hardest part of a node editor for a newcomer is not
 * wiring, it is knowing that the thing they want is called "Select by
 * curvature".
 */

import { useMemo, useState } from 'react';
import type { NodeCategory, NodeDefinition } from '@terrasmith/graph';
import { registry, useEditor } from '../../state/store.js';
import { categoryColor } from './TerrainNode.js';

/** Category order, roughly the order terrain flows through a graph. */
const CATEGORY_ORDER: NodeCategory[] = [
  'generator',
  'natural',
  'filter',
  'selector',
  'combiner',
  'layout',
  'gameplay',
  'texture',
  'output',
  'utility',
];

const CATEGORY_LABELS: Record<NodeCategory, string> = {
  generator: 'Create terrain',
  natural: 'Erosion and weather',
  filter: 'Reshape',
  selector: 'Select areas',
  combiner: 'Combine',
  layout: 'Draw shapes',
  gameplay: 'Gameplay',
  texture: 'Colour',
  output: 'Outputs',
  utility: 'Utility',
};

export function NodePalette() {
  const [query, setQuery] = useState('');
  const addNode = useEditor((s) => s.addNode);

  const groups = useMemo(() => {
    const matches = query.trim() ? registry.search(query, 60) : registry.all();
    const byCategory = new Map<NodeCategory, NodeDefinition<never>[]>();
    for (const def of matches) {
      const list = byCategory.get(def.category);
      if (list) list.push(def);
      else byCategory.set(def.category, [def]);
    }
    return CATEGORY_ORDER.filter((c) => byCategory.has(c)).map((category) => ({
      category,
      // Search results are already ranked; an unfiltered list reads best
      // alphabetically.
      nodes: query.trim()
        ? byCategory.get(category)!
        : byCategory.get(category)!.slice().sort((a, b) => a.label.localeCompare(b.label)),
    }));
  }, [query]);

  return (
    <div className="panel">
      <div className="panel-header">Nodes</div>
      <input
        className="palette-search"
        placeholder="Search nodes…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        spellCheck={false}
      />
      <div className="panel-scroll">
        {groups.length === 0 && <div className="empty-note">Nothing matches “{query}”.</div>}
        {groups.map(({ category, nodes }) => (
          <div className="palette-group" key={category}>
            <div className="palette-group-label">{CATEGORY_LABELS[category]}</div>
            {nodes.map((def) => (
              <button
                key={def.type}
                className="palette-item"
                title={def.description}
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData('application/terrasmith-node', def.type);
                  e.dataTransfer.effectAllowed = 'copy';
                }}
                onDoubleClick={() => {
                  // Double-click drops the node somewhere reasonable for people
                  // who do not expect drag-and-drop to be the only way in.
                  addNode(def.type, { x: 120 + Math.random() * 240, y: 120 + Math.random() * 160 });
                }}
              >
                <span className="dot" style={{ background: categoryColor(def.category) }} />
                <span>{def.label}</span>
              </button>
            ))}
          </div>
        ))}
      </div>
      <div className="empty-note" style={{ padding: '10px 12px', borderTop: '1px solid var(--line)' }}>
        Drag onto the canvas, or double-click to add.
      </div>
    </div>
  );
}
