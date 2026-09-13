/**
 * Guided mode.
 *
 * This is the same graph the node editor shows — not a separate simple engine.
 * The panel finds the nodes a template put in place and exposes their most
 * useful parameters as a plain form, grouped by what someone is actually trying
 * to decide: how big, how mountainous, how eroded, what colour.
 *
 * Doing it this way means guided mode is never a dead end. Switching to the
 * graph shows exactly which node each control was driving, which turns the
 * simple mode into the first lesson rather than a walled garden.
 */

import { useMemo } from 'react';
import type { GraphNode, ParamDef } from '@terrasmith/graph';
import { PALETTE_PRESETS } from '@terrasmith/core';
import { registry, useEditor } from '../../state/store.js';
import { ParamControl } from '../inspector/ParamControl.js';

/**
 * Which node types guided mode surfaces, and which of their parameters, in the
 * order someone would work through them.
 *
 * Deliberately a small, opinionated list. Exposing everything would just be the
 * inspector with extra steps.
 */
const GUIDED_STEPS: {
  title: string;
  hint: string;
  nodeTypes: string[];
  params: string[];
}[] = [
  {
    title: 'Landform',
    hint: 'The overall shape of the map — how big the hills are and how tall.',
    nodeTypes: ['generator.noise', 'generator.gradient', 'generator.plateaus'],
    params: ['fractal', 'featureSize', 'amplitude', 'octaves', 'seed', 'direction', 'low', 'high', 'count', 'radius', 'height'],
  },
  {
    title: 'Weathering',
    hint: 'How much water and gravity have worked on the terrain.',
    nodeTypes: ['natural.hydraulic', 'natural.thermal', 'natural.snow'],
    params: ['method', 'amount', 'scale', 'deposition', 'angle', 'line', 'thickness'],
  },
  {
    title: 'Shaping',
    hint: 'Smoothing, terracing and flattening — what makes the map buildable.',
    nodeTypes: ['filter.smooth', 'filter.terrace', 'filter.flatten', 'filter.remap', 'filter.clamp'],
    params: ['radius', 'strength', 'steps', 'sharpness', 'mode', 'outLow', 'outHigh', 'min', 'max', 'target'],
  },
  {
    title: 'Height and water',
    hint: 'Where the sea sits and how tall the map is allowed to be.',
    nodeTypes: ['output.height'],
    params: ['waterLevel', 'autoRange', 'minHeight', 'maxHeight'],
  },
];

export function GuidedPanel() {
  const project = useEditor((s) => s.project);
  const setNodeParam = useEditor((s) => s.setNodeParam);
  const updateSettings = useEditor((s) => s.updateSettings);
  const updateTexture = useEditor((s) => s.updateTexture);
  const setGuided = useEditor((s) => s.setGuided);

  const steps = useMemo(() => {
    return GUIDED_STEPS.map((step) => {
      const nodes = project.graph.nodes.filter(
        (n) => step.nodeTypes.includes(n.type) && !n.bypassed,
      );
      return { ...step, nodes };
    }).filter((step) => step.nodes.length > 0);
  }, [project.graph.nodes]);

  return (
    <div className="panel">
      <div className="panel-header">
        <span>Build your map</span>
        <button
          className="btn ghost"
          style={{ height: 20, fontSize: 11 }}
          onClick={() => setGuided(false)}
          title="Every control here is a node. Open the graph to see them all."
        >
          Show the graph
        </button>
      </div>

      <div className="panel-scroll">
        {steps.length === 0 && (
          <div className="empty-note">
            This map has no nodes guided mode recognises.
            <br />
            <br />
            Open the graph to edit it, or start again from a template.
          </div>
        )}

        {steps.map((step) => (
          <div className="inspector-section" key={step.title}>
            <div className="inspector-title">{step.title}</div>
            <p className="inspector-desc">{step.hint}</p>

            {step.nodes.map((node) => (
              <GuidedNode
                key={node.id}
                node={node}
                paramIds={step.params}
                showName={step.nodes.length > 1}
                onChange={(paramId, value) => setNodeParam(node.id, paramId, value)}
              />
            ))}
          </div>
        ))}

        <div className="inspector-section">
          <div className="inspector-title">Look</div>
          <p className="inspector-desc">The colours painted onto the terrain.</p>

          <div className="field">
            <div className="field-label">
              <span>Palette</span>
            </div>
            <select
              value={project.texture.palette}
              onChange={(e) => updateTexture({ palette: e.target.value })}
            >
              {PALETTE_PRESETS.map((preset) => (
                <option key={preset.id} value={preset.id}>
                  {preset.label}
                </option>
              ))}
            </select>
            <div className="field-help">
              {PALETTE_PRESETS.find((p) => p.id === project.texture.palette)?.description}
            </div>
          </div>
        </div>

        <div className="inspector-section">
          <div className="inspector-title">Variation</div>
          <p className="inspector-desc">
            One number changes every random pattern in the map at once, without touching any of the
            settings you have chosen. It is the fastest way to find a version you like.
          </p>
          <div className="row">
            <input
              className="num-narrow"
              type="number"
              value={project.settings.seed}
              onChange={(e) => updateSettings({ seed: Math.round(Number(e.target.value) || 0) })}
            />
            <button
              className="btn primary"
              onClick={() => updateSettings({ seed: Math.floor(Math.random() * 1_000_000) })}
            >
              Try another
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function GuidedNode({
  node,
  paramIds,
  showName,
  onChange,
}: {
  node: GraphNode;
  paramIds: string[];
  showName: boolean;
  onChange(paramId: string, value: unknown): void;
}) {
  const def = registry.get(node.type);
  if (!def) return null;
  const params = registry.normalizeParams(node.type, node.params);

  // Show the listed parameters in the order the guided step named them, not in
  // the node's own order: the step's order is the one that matches how someone
  // thinks about the problem.
  const visible = paramIds
    .map((id) => def.params.find((p) => p.id === id))
    .filter((p): p is ParamDef => Boolean(p))
    .filter((p) => !p.visibleWhen || p.visibleWhen(params));

  if (visible.length === 0) return null;

  return (
    <div style={{ marginBottom: showName ? 14 : 0 }}>
      {showName && (
        <div style={{ color: 'var(--text-3)', fontSize: 11, marginBottom: 6 }}>
          {node.title ?? def.label}
        </div>
      )}
      {visible.map((param) => (
        <ParamControl
          key={param.id}
          def={param}
          value={params[param.id]}
          params={params}
          onChange={(value) => onChange(param.id, value)}
        />
      ))}
    </div>
  );
}
