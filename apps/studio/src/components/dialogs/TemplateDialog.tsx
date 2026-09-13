/**
 * The template gallery.
 *
 * Thumbnails are rendered by actually evaluating each template's graph at a
 * tiny resolution rather than shipping screenshots. It costs a few hundred
 * milliseconds once, and in exchange the picture is always the map you will
 * get — including after someone edits a template or changes a node's defaults.
 */

import { useEffect, useRef, useState } from 'react';
import { Evaluator, type EvalContext } from '@terrasmith/graph';
import { registry, useEditor } from '../../state/store.js';
import { TEMPLATES, projectFromTemplate, type Template } from '../../templates/index.js';

/** Thumbnail resolution. Small enough to evaluate seven of them without a wait. */
const THUMB_SIZE = 72;

export function TemplateDialog({ onClose }: { onClose(): void }) {
  const setProject = useEditor((s) => s.setProject);

  return (
    <div className="scrim" onClick={onClose}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <div className="dialog-head">
          <h2>Start a map</h2>
          <button className="btn ghost" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        <div className="dialog-body">
          <p style={{ margin: '0 0 14px', color: 'var(--text-2)' }}>
            Every template is a finished, buildable map. Pick the one closest to what you want and
            change it — that is a much easier start than an empty canvas.
          </p>

          <div className="template-grid">
            {TEMPLATES.map((template) => (
              <button
                key={template.id}
                className="template-card"
                onClick={() => {
                  setProject(projectFromTemplate(template), template.name);
                  onClose();
                }}
                title={template.description}
              >
                <TemplateThumbnail template={template} />
                <div className="meta">
                  <strong>{template.name}</strong>
                  <span>{template.tagline}</span>
                  <span style={{ display: 'block', marginTop: 4, color: 'var(--text-3)' }}>
                    {template.sizeX} × {template.sizeZ} · {template.minPlayers}–
                    {template.maxPlayers} players
                  </span>
                </div>
              </button>
            ))}
          </div>
        </div>

        <div className="dialog-foot">
          <button className="btn" onClick={onClose}>
            Keep what I have
          </button>
        </div>
      </div>
    </div>
  );
}

function TemplateThumbnail({ template }: { template: Template }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();

    void (async () => {
      try {
        const graph = template.build();
        const outputNode = graph.nodes.find((n) => n.type === 'output.height');
        if (!outputNode) return;

        const aspect = template.sizeX / template.sizeZ;
        const width = aspect >= 1 ? THUMB_SIZE : Math.round(THUMB_SIZE * aspect);
        const height = aspect >= 1 ? Math.round(THUMB_SIZE / aspect) : THUMB_SIZE;

        const context: EvalContext = {
          width,
          height,
          worldWidth: template.sizeX * 512,
          worldHeight: template.sizeZ * 512,
          seed: 1,
          quality: 'preview',
          signal: controller.signal,
        };
        // A fresh evaluator per thumbnail: they are tiny, and sharing one would
        // keep every template's intermediates alive for the life of the dialog.
        const result = await new Evaluator(registry, {
          cacheBudgetBytes: 8 * 1024 * 1024,
        }).evaluate(graph, outputNode.id, context);

        if (cancelled) return;
        const field = result.value as { width: number; height: number; data: Float32Array };
        drawThumbnail(canvasRef.current, field, template.sizeX * 512 / width);
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [template]);

  if (failed) {
    return <canvas ref={canvasRef} width={210} height={104} />;
  }
  return <canvas ref={canvasRef} width={210} height={104} />;
}

/**
 * Draw a hillshaded thumbnail.
 *
 * Hillshade rather than a height ramp: relief is what distinguishes these
 * templates from each other, and a height ramp makes a mountain range and a
 * rolling plain look nearly identical at 72 pixels.
 */
function drawThumbnail(
  canvas: HTMLCanvasElement | null,
  field: { width: number; height: number; data: Float32Array },
  cellSize: number,
): void {
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const { width, height, data } = field;
  const image = ctx.createImageData(width, height);

  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < data.length; i++) {
    if (data[i] < min) min = data[i];
    if (data[i] > max) max = data[i];
  }
  const span = Math.max(1, max - min);

  // Light from the upper left, the convention every relief map uses.
  const lx = -0.55;
  const ly = -0.55;
  const lz = 0.63;

  for (let y = 0; y < height; y++) {
    const ym = y > 0 ? y - 1 : y;
    const yp = y < height - 1 ? y + 1 : y;
    for (let x = 0; x < width; x++) {
      const xm = x > 0 ? x - 1 : x;
      const xp = x < width - 1 ? x + 1 : x;
      const i = y * width + x;
      const dx = (data[y * width + xp] - data[y * width + xm]) / ((xp - xm) * cellSize);
      const dz = (data[yp * width + x] - data[ym * width + x]) / ((yp - ym) * cellSize);
      const len = Math.sqrt(dx * dx + dz * dz + 1);
      const shade = Math.max(0.12, (-dx / len) * lx + (-dz / len) * ly + (1 / len) * lz);

      const t = (data[i] - min) / span;
      const underwater = data[i] < 0;
      const base = underwater
        ? [42, 72, 96]
        : [96 + t * 90, 104 + t * 78, 82 + t * 76];

      const o = i * 4;
      image.data[o] = clampByte(base[0] * shade * 1.25);
      image.data[o + 1] = clampByte(base[1] * shade * 1.25);
      image.data[o + 2] = clampByte(base[2] * shade * 1.25);
      image.data[o + 3] = 255;
    }
  }

  // Draw the small image and let the canvas scale it up; the card is only
  // ever 210 pixels wide, so a smooth upscale reads better than pixels.
  const scratch = document.createElement('canvas');
  scratch.width = width;
  scratch.height = height;
  scratch.getContext('2d')?.putImageData(image, 0, 0);

  ctx.imageSmoothingEnabled = true;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  // Cover rather than fit, so cards never show letterbox bars.
  const scale = Math.max(canvas.width / width, canvas.height / height);
  const dw = width * scale;
  const dh = height * scale;
  ctx.drawImage(scratch, (canvas.width - dw) / 2, (canvas.height - dh) / 2, dw, dh);
}

function clampByte(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}
