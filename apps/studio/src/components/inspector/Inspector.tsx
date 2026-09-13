/**
 * The right-hand panel: the settings of whatever is selected.
 *
 * With a node selected it shows that node's parameters, basic ones first and
 * advanced ones behind a disclosure. With nothing selected it shows the map
 * itself — size, seed, symmetry, texture — because those are the settings
 * someone reaches for when they are not editing a particular node, and making
 * them hunt through a menu for the map size is a bad trade.
 */

import { useState } from 'react';
import type { NodeDefinition } from '@terrasmith/graph';
import { registry, useEditor } from '../../state/store.js';
import { categoryColor } from '../graph/TerrainNode.js';
import { ParamControl } from './ParamControl.js';
import { MapSettingsPanel } from './MapSettingsPanel.js';

export function Inspector() {
  const project = useEditor((s) => s.project);
  const selection = useEditor((s) => s.selection);
  const setNodeParam = useEditor((s) => s.setNodeParam);
  const toggleBypass = useEditor((s) => s.toggleBypass);
  const removeNodes = useEditor((s) => s.removeNodes);
  const duplicateNodes = useEditor((s) => s.duplicateNodes);
  const setPreviewNode = useEditor((s) => s.setPreviewNode);
  const previewNodeId = useEditor((s) => s.previewNodeId);

  const [showAdvanced, setShowAdvanced] = useState(false);

  if (selection.length === 0) {
    return (
      <div className="panel">
        <div className="panel-header">Map</div>
        <div className="panel-scroll">
          <MapSettingsPanel />
        </div>
      </div>
    );
  }

  if (selection.length > 1) {
    return (
      <div className="panel">
        <div className="panel-header">{selection.length} nodes</div>
        <div className="panel-scroll">
          <div className="inspector-section">
            <div className="row" style={{ gap: 6 }}>
              <button className="btn" onClick={() => duplicateNodes(selection)}>
                Duplicate
              </button>
              <button className="btn" onClick={() => toggleBypass(selection)}>
                Bypass
              </button>
              <button className="btn" onClick={() => removeNodes(selection)}>
                Delete
              </button>
            </div>
          </div>
          <div className="empty-note">Select a single node to edit its settings.</div>
        </div>
      </div>
    );
  }

  const node = project.graph.nodes.find((n) => n.id === selection[0]);
  const def = node ? registry.get(node.type) : undefined;

  if (!node || !def) {
    return (
      <div className="panel">
        <div className="panel-header">Node</div>
        <div className="empty-note">This node&rsquo;s type is not installed.</div>
      </div>
    );
  }

  const params = registry.normalizeParams(node.type, node.params);
  const visible = def.params.filter((p) => !p.visibleWhen || p.visibleWhen(params));
  const basic = visible.filter((p) => p.tier !== 'advanced');
  const advanced = visible.filter((p) => p.tier === 'advanced');
  const previewing = previewNodeId === node.id;

  return (
    <div className="panel">
      <div className="panel-header">
        <span>Node</span>
        <button
          className="btn ghost"
          style={{ height: 20, fontSize: 11 }}
          aria-pressed={previewing}
          onClick={() => setPreviewNode(previewing ? null : node.id)}
          title="Show this node's output in the viewport instead of the final terrain"
        >
          {previewing ? 'Previewing' : 'Preview this'}
        </button>
      </div>

      <div className="panel-scroll">
        <div className="inspector-section">
          <div className="inspector-title">
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: 2,
                background: categoryColor(def.category),
              }}
            />
            {node.title ?? def.label}
          </div>
          <p className="inspector-desc">{def.description}</p>

          <div className="row" style={{ gap: 6 }}>
            <button className="btn" onClick={() => duplicateNodes([node.id])}>
              Duplicate
            </button>
            <button
              className="btn"
              aria-pressed={node.bypassed}
              onClick={() => toggleBypass([node.id])}
              title="Pass the input straight through, as if this node were not here"
            >
              {node.bypassed ? 'Bypassed' : 'Bypass'}
            </button>
            <button className="btn" onClick={() => removeNodes([node.id])}>
              Delete
            </button>
          </div>
        </div>

        <div className="inspector-section">
          {basic.map((param) => (
            <ParamControl
              key={param.id}
              def={param}
              value={params[param.id]}
              params={params}
              onChange={(value) => setNodeParam(node.id, param.id, value)}
            />
          ))}
          {basic.length === 0 && <div className="field-help">This node has nothing to configure.</div>}
        </div>

        {advanced.length > 0 && (
          <div className="inspector-section">
            <button className="advanced-toggle" onClick={() => setShowAdvanced((v) => !v)}>
              {showAdvanced ? '▾' : '▸'} Advanced ({advanced.length})
            </button>
            {showAdvanced &&
              advanced.map((param) => (
                <ParamControl
                  key={param.id}
                  def={param}
                  value={params[param.id]}
                  params={params}
                  onChange={(value) => setNodeParam(node.id, param.id, value)}
                />
              ))}
          </div>
        )}

        <PortReference def={def} />
      </div>
    </div>
  );
}

/**
 * What the node's ports are for.
 *
 * Cheap to show and disproportionately useful: most confusion about a node is
 * really confusion about what its second input expects.
 */
function PortReference({ def }: { def: NodeDefinition<never> }) {
  const documented = [...def.inputs, ...def.outputs].filter((p) => p.description);
  if (documented.length === 0) return null;
  return (
    <div className="inspector-section" style={{ borderBottom: 'none' }}>
      <div className="palette-group-label" style={{ padding: '0 0 6px' }}>
        Connections
      </div>
      {documented.map((port) => (
        <div key={port.id} style={{ marginBottom: 8 }}>
          <div style={{ color: 'var(--text-1)' }}>{port.label}</div>
          <div className="field-help" style={{ marginTop: 1 }}>
            {port.description}
          </div>
        </div>
      ))}
    </div>
  );
}
