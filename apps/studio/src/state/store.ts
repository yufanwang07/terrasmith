/**
 * The editor's single source of truth.
 *
 * One store holds the project, the selection and the undo history. Terrain
 * data is deliberately *not* in here: an 8192-square heightfield is 64 MB, and
 * putting it in a store that clones on every edit would make dragging a slider
 * allocate a gigabyte. Field data lives in the evaluation cache and is
 * addressed by node id.
 */

import { create } from 'zustand';
import { produce } from 'immer';
import {
  createDefaultRegistry,
  createProject,
  serializeProject,
  type Graph,
  type GraphEdge,
  type GraphNode,
  type MapSettings,
  type MapMetadata,
  type MetalSpot,
  type Project,
  type StartPosition,
  type TextureSettings,
} from '@terrasmith/graph';

export const registry = createDefaultRegistry();

/** How much of the editor a change invalidates. */
export type ChangeKind =
  /** Terrain changed: the preview must re-evaluate. */
  | 'terrain'
  /** Only presentation changed: node positions, titles, selection. */
  | 'cosmetic'
  /** Map settings changed: resolution and world size differ, so everything re-evaluates. */
  | 'settings';

interface HistoryEntry {
  project: Project;
  label: string;
}

export interface EditorState {
  project: Project;
  /** Node ids currently selected in the graph. */
  selection: string[];
  /** The node whose output the viewport shows. Null means the height output. */
  previewNodeId: string | null;
  /** Path or handle the project was last saved to, for the title bar. */
  documentName: string;
  dirty: boolean;

  past: HistoryEntry[];
  future: HistoryEntry[];

  /** Which panel the centre area shows. */
  centerView: 'terrain' | 'graph' | 'split';
  /** Which overlay the 3D viewport draws. */
  overlay: OverlayKind;
  /** Guided mode hides the graph and shows a curated parameter form. */
  guided: boolean;

  // --- actions ---
  apply(label: string, kind: ChangeKind, recipe: (draft: Project) => void): void;
  undo(): void;
  redo(): void;
  canUndo(): boolean;
  canRedo(): boolean;

  setProject(project: Project, documentName?: string): void;
  select(ids: string[]): void;
  setPreviewNode(id: string | null): void;
  setCenterView(view: EditorState['centerView']): void;
  setOverlay(overlay: OverlayKind): void;
  setGuided(guided: boolean): void;
  markSaved(documentName?: string): void;

  addNode(type: string, position: { x: number; y: number }): string;
  removeNodes(ids: string[]): void;
  duplicateNodes(ids: string[]): string[];
  moveNodes(moves: { id: string; position: { x: number; y: number } }[]): void;
  setNodeParam(nodeId: string, paramId: string, value: unknown): void;
  setNodeParams(nodeId: string, params: Record<string, unknown>): void;
  toggleBypass(ids: string[]): void;
  connect(edge: Omit<GraphEdge, 'id'>): void;
  disconnect(edgeId: string): void;

  updateMetadata(patch: Partial<MapMetadata>): void;
  updateSettings(patch: Partial<MapSettings>): void;
  updateTexture(patch: Partial<TextureSettings>): void;
  setStartPositions(positions: StartPosition[]): void;
  setMetalSpots(spots: MetalSpot[]): void;
}

export type OverlayKind =
  | 'none'
  | 'slope'
  | 'buildable'
  | 'passability'
  | 'metal'
  | 'symmetry'
  | 'flow'
  | 'height';

/** How many undo steps to keep. Each entry is a project, which is small. */
const HISTORY_LIMIT = 200;

let nodeCounter = 0;
/** Unique node id. Prefixed so ids never collide with a hand-edited file's. */
function nextNodeId(type: string): string {
  nodeCounter += 1;
  return `${type.split('.')[1] ?? 'node'}-${nodeCounter.toString(36)}-${Math.floor(
    performance.now() * 1000,
  ).toString(36)}`;
}

let edgeCounter = 0;
function nextEdgeId(): string {
  edgeCounter += 1;
  return `e${edgeCounter.toString(36)}-${Math.floor(performance.now() * 1000).toString(36)}`;
}

export const useEditor = create<EditorState>((set, get) => ({
  project: createProject(),
  selection: [],
  previewNodeId: null,
  documentName: 'Untitled Map',
  dirty: false,
  past: [],
  future: [],
  centerView: 'split',
  overlay: 'none',
  guided: true,

  apply(label, kind, recipe) {
    const state = get();
    const next = produce(state.project, recipe);
    if (next === state.project) return;

    // Cosmetic changes still go on the undo stack — dragging a node somewhere
    // and wanting it back is a normal thing to want — but they coalesce with
    // the previous entry when they share a label, so a drag is one step rather
    // than sixty.
    const past = [...state.past];
    const lastEntry = past[past.length - 1];
    const coalesce = kind === 'cosmetic' && lastEntry?.label === label;
    if (!coalesce) {
      past.push({ project: state.project, label });
      if (past.length > HISTORY_LIMIT) past.shift();
    }

    set({ project: next, past, future: [], dirty: true });
  },

  undo() {
    const { past, future, project } = get();
    const previous = past[past.length - 1];
    if (!previous) return;
    set({
      project: previous.project,
      past: past.slice(0, -1),
      future: [{ project, label: previous.label }, ...future],
      dirty: true,
    });
  },

  redo() {
    const { past, future, project } = get();
    const next = future[0];
    if (!next) return;
    set({
      project: next.project,
      past: [...past, { project, label: next.label }],
      future: future.slice(1),
      dirty: true,
    });
  },

  canUndo: () => get().past.length > 0,
  canRedo: () => get().future.length > 0,

  setProject(project, documentName) {
    set({
      project,
      documentName: documentName ?? project.metadata.name,
      selection: [],
      past: [],
      future: [],
      dirty: false,
    });
  },

  select(ids) {
    set({ selection: ids });
  },

  setPreviewNode(id) {
    set({ previewNodeId: id });
  },

  setCenterView(view) {
    set({ centerView: view });
  },

  setOverlay(overlay) {
    set({ overlay });
  },

  setGuided(guided) {
    set({ guided });
  },

  markSaved(documentName) {
    set({ dirty: false, ...(documentName ? { documentName } : {}) });
  },

  addNode(type, position) {
    const id = nextNodeId(type);
    const params = registry.defaultParams(type);
    get().apply(`Add ${registry.get(type)?.label ?? type}`, 'terrain', (draft) => {
      draft.graph.nodes.push({ id, type, params, position });
    });
    set({ selection: [id] });
    return id;
  },

  removeNodes(ids) {
    if (ids.length === 0) return;
    const set_ = new Set(ids);
    get().apply(ids.length === 1 ? 'Delete node' : `Delete ${ids.length} nodes`, 'terrain', (draft) => {
      draft.graph.nodes = draft.graph.nodes.filter((n) => !set_.has(n.id));
      draft.graph.edges = draft.graph.edges.filter(
        (e) => !set_.has(e.fromNode) && !set_.has(e.toNode),
      );
    });
    set({ selection: [] });
  },

  duplicateNodes(ids) {
    const source = get().project.graph;
    const idMap = new Map<string, string>();
    for (const id of ids) {
      const node = source.nodes.find((n) => n.id === id);
      if (node) idMap.set(id, nextNodeId(node.type));
    }
    const created = [...idMap.values()];

    get().apply(`Duplicate ${ids.length === 1 ? 'node' : 'nodes'}`, 'terrain', (draft) => {
      for (const [oldId, newId] of idMap) {
        const node = draft.graph.nodes.find((n) => n.id === oldId);
        if (!node) continue;
        draft.graph.nodes.push({
          ...structuredClone(node),
          id: newId,
          // Offset so the copy is visible rather than exactly on top.
          position: { x: node.position.x + 40, y: node.position.y + 40 },
        });
      }
      // Copy internal connections; connections to nodes outside the selection
      // are left behind, which matches what every other node editor does.
      for (const edge of draft.graph.edges.slice()) {
        const from = idMap.get(edge.fromNode);
        const to = idMap.get(edge.toNode);
        if (from && to) {
          draft.graph.edges.push({ ...edge, id: nextEdgeId(), fromNode: from, toNode: to });
        }
      }
    });
    set({ selection: created });
    return created;
  },

  moveNodes(moves) {
    get().apply('Move nodes', 'cosmetic', (draft) => {
      for (const move of moves) {
        const node = draft.graph.nodes.find((n) => n.id === move.id);
        if (node) node.position = move.position;
      }
    });
  },

  setNodeParam(nodeId, paramId, value) {
    const label = `Change ${paramId}`;
    const state = get();
    const next = produce(state.project, (draft) => {
      const node = draft.graph.nodes.find((n) => n.id === nodeId);
      if (node) node.params[paramId] = value;
    });
    if (next === state.project) return;

    // Dragging a slider fires continuously. Coalesce consecutive edits to the
    // same parameter into one undo step, or a single drag buries the history.
    const past = [...state.past];
    const last = past[past.length - 1];
    const sameParam = last?.label === label;
    if (!sameParam) {
      past.push({ project: state.project, label });
      if (past.length > HISTORY_LIMIT) past.shift();
    }
    set({ project: next, past, future: [], dirty: true });
  },

  setNodeParams(nodeId, params) {
    get().apply('Change settings', 'terrain', (draft) => {
      const node = draft.graph.nodes.find((n) => n.id === nodeId);
      if (node) Object.assign(node.params, params);
    });
  },

  toggleBypass(ids) {
    const set_ = new Set(ids);
    get().apply('Toggle bypass', 'terrain', (draft) => {
      for (const node of draft.graph.nodes) {
        if (set_.has(node.id)) node.bypassed = !node.bypassed;
      }
    });
  },

  connect(edge) {
    get().apply('Connect', 'terrain', (draft) => {
      // An input takes one source, so a new connection replaces whatever was
      // there. Rejecting it instead would mean the user has to find and delete
      // the old edge first, which nobody enjoys.
      draft.graph.edges = draft.graph.edges.filter(
        (e) => !(e.toNode === edge.toNode && e.toPort === edge.toPort),
      );
      draft.graph.edges.push({ ...edge, id: nextEdgeId() });
    });
  },

  disconnect(edgeId) {
    get().apply('Disconnect', 'terrain', (draft) => {
      draft.graph.edges = draft.graph.edges.filter((e) => e.id !== edgeId);
    });
  },

  updateMetadata(patch) {
    get().apply('Edit map details', 'cosmetic', (draft) => {
      Object.assign(draft.metadata, patch);
    });
  },

  updateSettings(patch) {
    get().apply('Change map settings', 'settings', (draft) => {
      Object.assign(draft.settings, patch);
    });
  },

  updateTexture(patch) {
    get().apply('Change texture settings', 'terrain', (draft) => {
      Object.assign(draft.texture, patch);
    });
  },

  setStartPositions(positions) {
    get().apply('Edit start positions', 'cosmetic', (draft) => {
      draft.startPositions = positions;
    });
  },

  setMetalSpots(spots) {
    get().apply('Edit metal spots', 'terrain', (draft) => {
      draft.metalSpots = spots;
    });
  },
}));

/** Serialise the current project for saving. */
export function currentProjectText(): string {
  return serializeProject(useEditor.getState().project);
}

/** The graph as the evaluator wants it. */
export function currentGraph(): Graph {
  return useEditor.getState().project.graph;
}

/** Find a node by id, or undefined. */
export function findNode(project: Project, id: string): GraphNode | undefined {
  return project.graph.nodes.find((n) => n.id === id);
}
