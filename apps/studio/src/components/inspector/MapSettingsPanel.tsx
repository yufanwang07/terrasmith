/**
 * Map settings — the things that are true of the whole map rather than of any
 * one node.
 *
 * Size is the important one, and it is presented the way BAR talks about it:
 * in 512-elmo units, with the player counts each size is actually used for.
 * "16 x 16, good for 2-12 players" is a decision someone can make; "1024
 * squares" is not.
 */

import { PALETTE_PRESETS } from '@terrasmith/core';
import { mapDimensionsOf } from '@terrasmith/graph';
import { useEditor } from '../../state/store.js';

/**
 * Sizes BAR actually uses, with the player counts drawn from its curated map
 * pool. Only even numbers exist because the engine draws terrain in 128-square
 * patches, which forces the size unit count to be even.
 */
const SIZE_PRESETS = [
  { size: 8, label: '8 × 8', players: '1v1, small' },
  { size: 10, label: '10 × 10', players: '1v1' },
  { size: 12, label: '12 × 12', players: '1v1 to 2v2' },
  { size: 14, label: '14 × 14', players: '2v2 to 4v4' },
  { size: 16, label: '16 × 16', players: '2 to 12 — the most common size' },
  { size: 18, label: '18 × 18', players: '4v4 to 8v8' },
  { size: 20, label: '20 × 20', players: '8v8' },
  { size: 24, label: '24 × 24', players: '8v8 and bigger' },
  { size: 28, label: '28 × 28', players: 'big team' },
  { size: 32, label: '32 × 32', players: 'the largest BAR accepts' },
] as const;

interface SymmetryOption {
  value: string;
  label: string;
  hint?: string;
}

const SYMMETRY_OPTIONS: SymmetryOption[] = [
  { value: 'rotate180', label: 'Rotational (180°)', hint: 'Seven out of ten BAR maps use this.' },
  { value: 'mirrorX', label: 'Mirror across X' },
  { value: 'mirrorZ', label: 'Mirror across Z' },
  { value: 'rotate90', label: 'Rotational (90°)', hint: 'Square maps only. Suits four-corner FFA.' },
  { value: 'diagonal', label: 'Diagonal mirror' },
  { value: 'none', label: 'None', hint: 'Fine for PvE; a fairness risk in competitive play.' },
];

export function MapSettingsPanel() {
  const project = useEditor((s) => s.project);
  const updateSettings = useEditor((s) => s.updateSettings);
  const updateMetadata = useEditor((s) => s.updateMetadata);
  const updateTexture = useEditor((s) => s.updateTexture);
  const dims = mapDimensionsOf(project.settings);

  const symmetryHint = SYMMETRY_OPTIONS.find((o) => o.value === project.settings.symmetry)?.hint;

  return (
    <>
      <div className="inspector-section">
        <div className="inspector-title">Details</div>

        <div className="field">
          <div className="field-label">
            <span>Name</span>
          </div>
          <input
            type="text"
            value={project.metadata.name}
            onChange={(e) => updateMetadata({ name: e.target.value })}
          />
        </div>

        <div className="field">
          <div className="field-label">
            <span>Author</span>
          </div>
          <input
            type="text"
            value={project.metadata.author ?? ''}
            onChange={(e) => updateMetadata({ author: e.target.value })}
          />
        </div>

        <div className="field">
          <div className="field-label">
            <span>Version</span>
          </div>
          <input
            type="text"
            value={project.metadata.version ?? ''}
            placeholder="1.0"
            onChange={(e) => updateMetadata({ version: e.target.value })}
          />
          <div className="field-help">
            BAR puts the version in the archive name, so bumping it is how players tell two builds apart.
          </div>
        </div>

        <div className="field">
          <div className="field-label">
            <span>Description</span>
          </div>
          <textarea
            value={project.metadata.description ?? ''}
            onChange={(e) => updateMetadata({ description: e.target.value })}
          />
        </div>
      </div>

      <div className="inspector-section">
        <div className="inspector-title">Size</div>

        <div className="field">
          <div className="field-label">
            <span>Width</span>
            <span className="field-value">{dims.worldWidth} elmos</span>
          </div>
          <select
            value={project.settings.sizeX}
            onChange={(e) => updateSettings({ sizeX: Number(e.target.value) })}
          >
            {SIZE_PRESETS.map((p) => (
              <option key={p.size} value={p.size}>
                {p.size} — {p.players}
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <div className="field-label">
            <span>Depth</span>
            <span className="field-value">{dims.worldHeight} elmos</span>
          </div>
          <select
            value={project.settings.sizeZ}
            onChange={(e) => updateSettings({ sizeZ: Number(e.target.value) })}
          >
            {SIZE_PRESETS.map((p) => (
              <option key={p.size} value={p.size}>
                {p.size} — {p.players}
              </option>
            ))}
          </select>
          <div className="field-help">
            Non-square maps are common and legitimate: 20 × 16 and 24 × 16 are the canonical shapes
            for lane maps where two teams face across the short axis.
          </div>
        </div>

        <div className="field">
          <div className="field-label">
            <span>Players</span>
          </div>
          <div className="row">
            <input
              className="num-narrow"
              type="number"
              min={1}
              max={64}
              value={project.metadata.minPlayers ?? 2}
              onChange={(e) => updateMetadata({ minPlayers: Number(e.target.value) })}
            />
            <span style={{ color: 'var(--text-3)' }}>to</span>
            <input
              className="num-narrow"
              type="number"
              min={1}
              max={64}
              value={project.metadata.maxPlayers ?? 8}
              onChange={(e) => updateMetadata({ maxPlayers: Number(e.target.value) })}
            />
          </div>
        </div>
      </div>

      <div className="inspector-section">
        <div className="inspector-title">World</div>

        <div className="field">
          <div className="field-label">
            <span>Seed</span>
          </div>
          <div className="row">
            <input
              className="num-narrow"
              type="number"
              value={project.settings.seed}
              onChange={(e) => updateSettings({ seed: Math.round(Number(e.target.value) || 0) })}
            />
            <button
              className="btn"
              onClick={() => updateSettings({ seed: Math.floor(Math.random() * 1_000_000) })}
            >
              Reroll
            </button>
          </div>
          <div className="field-help">
            Changes every random pattern in the graph at once, without changing any of its settings.
          </div>
        </div>

        <div className="field">
          <div className="field-label">
            <span>Symmetry</span>
          </div>
          <select
            value={project.settings.symmetry}
            onChange={(e) => updateSettings({ symmetry: e.target.value as never })}
          >
            {SYMMETRY_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          {symmetryHint && <div className="field-help">{symmetryHint}</div>}
        </div>

        <div className="field">
          <div className="field-label">
            <span>Tidal strength</span>
            <span className="field-value">{project.settings.tidalStrength ?? 20}</span>
          </div>
          <input
            type="range"
            min={0}
            max={30}
            step={1}
            value={project.settings.tidalStrength ?? 20}
            onChange={(e) => updateSettings({ tidalStrength: Number(e.target.value) })}
          />
          <div className="field-help">
            How much energy a tidal generator produces. Most BAR maps use 20; a map with no water
            should use 0 so nobody builds one.
          </div>
        </div>

        <div className="field">
          <div className="field-label">
            <span>Wind</span>
            <span className="field-value">
              {project.settings.minWind ?? 5}–{project.settings.maxWind ?? 25}
            </span>
          </div>
          <div className="row">
            <input
              className="num-narrow"
              type="number"
              min={0}
              max={30}
              value={project.settings.minWind ?? 5}
              onChange={(e) => updateSettings({ minWind: Number(e.target.value) })}
            />
            <span style={{ color: 'var(--text-3)' }}>to</span>
            <input
              className="num-narrow"
              type="number"
              min={0}
              max={40}
              value={project.settings.maxWind ?? 25}
              onChange={(e) => updateSettings({ maxWind: Number(e.target.value) })}
            />
          </div>
          <div className="field-help">Wind generator output. BAR maps stay within 0 to 30.</div>
        </div>
      </div>

      <div className="inspector-section">
        <div className="inspector-title">Look</div>

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

        <div className="field">
          <div className="field-label">
            <span>Baked shadow</span>
            <span className="field-value">{Math.round(project.texture.bakedOcclusion * 100)}%</span>
          </div>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={project.texture.bakedOcclusion}
            onChange={(e) => updateTexture({ bakedOcclusion: Number(e.target.value) })}
          />
          <div className="field-help">
            Darkens crevices and the bases of cliffs. The engine has no local shadowing of its own,
            so this is what stops terrain looking like a decal.
          </div>
        </div>

        <div className="field">
          <div className="field-label">
            <span>Grain</span>
            <span className="field-value">{Math.round(project.texture.grain * 100)}%</span>
          </div>
          <input
            type="range"
            min={0}
            max={0.5}
            step={0.01}
            value={project.texture.grain}
            onChange={(e) => updateTexture({ grain: Number(e.target.value) })}
          />
          <div className="field-help">
            Fine colour variation. Also reduces the banding the map texture&rsquo;s DXT1 compression
            produces across smooth gradients. It costs file size out of proportion to the setting:
            any grain at all makes every tile unique, so the archive shares none of them — about a
            tenth larger on a varied map, and more than twice the size on a flat one.
          </div>
        </div>

        <div className="field">
          <label className="row" style={{ cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={project.texture.markSlopeBands}
              onChange={(e) => updateTexture({ markSlopeBands: e.target.checked })}
            />
            <span>Make slope bands visible</span>
          </label>
          <div className="field-help">
            Shifts the colour at 27° and 54° so players can see where vehicles stop and where only
            bots can climb. BAR&rsquo;s map checklist asks for this.
          </div>
        </div>
      </div>
    </>
  );
}
