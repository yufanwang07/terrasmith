/**
 * The node canvas.
 *
 * React Flow handles the viewport, hit-testing and edge rendering; everything
 * about what a graph *means* stays in the store. The translation between the
 * two happens here and nowhere else, which keeps the project model free of any
 * React Flow types — worth doing, because the project model is also what the
 * CLI and the tests read.
 */

import { useCallback, useMemo, useRef } from 'react';
import {
  Background,
  BackgroundVariant,
  Controls,
  ControlButton,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Connection,
  type Edge,
  type Node,
  type NodeChange,
  type OnSelectionChangeParams,
} from '@xyflow/react';
import { useEditor } from '../../state/store.js';
import { registry } from '../../state/store.js';
import { TerrainNode, categoryColorValue, type TerrainNodeData } from './TerrainNode.js';
import { autoLayout, nodeHeight, nodeWidth } from './autoLayout.js';
import { useNodeThumbnails } from '../../state/thumbnails.js';

const nodeTypes = { terrain: TerrainNode };

interface Props {
  /** Node ids that failed in the last evaluation, keyed to their message. */
  errors?: Record<string, string>;
  /** Draw each node's output on it. Off while the main preview is busy. */
  thumbnails?: boolean;
}

export function GraphEditor(props: Props) {
  return (
    <ReactFlowProvider>
      <GraphCanvas {...props} />
    </ReactFlowProvider>
  );
}

function GraphCanvas({ errors, thumbnails = true }: Props) {
  const project = useEditor((s) => s.project);
  const selection = useEditor((s) => s.selection);
  const select = useEditor((s) => s.select);
  const moveNodes = useEditor((s) => s.moveNodes);
  const connect = useEditor((s) => s.connect);
  const disconnect = useEditor((s) => s.disconnect);
  const removeNodes = useEditor((s) => s.removeNodes);
  const addNode = useEditor((s) => s.addNode);
  const { screenToFlowPosition, fitView } = useReactFlow();
  const wrapperRef = useRef<HTMLDivElement>(null);

  // Every node is a thumbnail candidate. Culling to the viewport would save
  // work on a huge graph, but React Flow does not report visibility cheaply and
  // a terrain graph is tens of nodes, not thousands.
  const thumbnailTargets = useMemo(
    () => (thumbnails ? project.graph.nodes.map((n) => n.id) : []),
    [thumbnails, project.graph.nodes],
  );
  const { byNode } = useNodeThumbnails(project, thumbnailTargets, thumbnails);

  const nodes = useMemo<Node<TerrainNodeData>[]>(
    () =>
      project.graph.nodes.map((node) => ({
        id: node.id,
        type: 'terrain',
        position: node.position,
        selected: selection.includes(node.id),
        // Declared rather than measured: this editor drops React Flow's
        // dimension changes to keep the undo stack clean, so without these the
        // minimap has no sizes to draw with and comes out empty.
        width: nodeWidth,
        height: nodeHeight(registry.get(node.type)),
        data: {
          type: node.type,
          params: node.params,
          title: node.title,
          bypassed: node.bypassed,
          error: errors?.[node.id],
          thumbnail: byNode.get(node.id),
        },
      })),
    [project.graph.nodes, selection, errors, byNode],
  );

  const edges = useMemo<Edge[]>(
    () =>
      project.graph.edges.map((edge) => ({
        id: edge.id,
        source: edge.fromNode,
        sourceHandle: edge.fromPort,
        target: edge.toNode,
        targetHandle: edge.toPort,
      })),
    [project.graph.edges],
  );

  const onNodesChange = useCallback(
    (changes: NodeChange<Node<TerrainNodeData>>[]) => {
      // Only position changes are written back, and only once the drag has
      // finished — writing every intermediate position would put a hundred
      // entries on the undo stack per drag.
      const moves = changes
        .filter((c): c is NodeChange<Node<TerrainNodeData>> & { type: 'position' } => c.type === 'position')
        .filter((c) => c.dragging === false && c.position)
        .map((c) => ({ id: c.id, position: c.position! }));
      if (moves.length > 0) moveNodes(moves);

      const removals = changes.filter((c) => c.type === 'remove').map((c) => c.id);
      if (removals.length > 0) removeNodes(removals);
    },
    [moveNodes, removeNodes],
  );

  const onConnect = useCallback(
    (connection: Connection) => {
      if (!connection.source || !connection.target) return;
      if (!connection.sourceHandle || !connection.targetHandle) return;
      connect({
        fromNode: connection.source,
        fromPort: connection.sourceHandle,
        toNode: connection.target,
        toPort: connection.targetHandle,
      });
    },
    [connect],
  );

  const onEdgesDelete = useCallback(
    (deleted: Edge[]) => {
      for (const edge of deleted) disconnect(edge.id);
    },
    [disconnect],
  );

  const onSelectionChange = useCallback(
    (params: OnSelectionChangeParams) => {
      const ids = params.nodes.map((n) => n.id);
      // Guard against React Flow's initial empty callback clobbering a
      // selection set from elsewhere in the app.
      select(ids);
    },
    [select],
  );

  const onDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();
      const type = event.dataTransfer.getData('application/terrasmith-node');
      if (!type || !registry.has(type)) return;
      const position = screenToFlowPosition({ x: event.clientX, y: event.clientY });
      addNode(type, position);
    },
    [addNode, screenToFlowPosition],
  );

  const onDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  }, []);

  const tidy = useCallback(() => {
    const moves = autoLayout(project.graph);
    if (moves.length > 0) moveNodes(moves);
    // Let the move settle before re-framing, or fitView measures the old
    // positions and the graph ends up off-screen.
    requestAnimationFrame(() => void fitView({ duration: 250, padding: 0.12 }));
  }, [project.graph, moveNodes, fitView]);

  return (
    <div className="graph-wrap" ref={wrapperRef} onDrop={onDrop} onDragOver={onDragOver}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onConnect={onConnect}
        onEdgesDelete={onEdgesDelete}
        onSelectionChange={onSelectionChange}
        fitView
        minZoom={0.15}
        maxZoom={2.2}
        defaultEdgeOptions={{ type: 'default', animated: false }}
        deleteKeyCode={['Delete', 'Backspace']}
        multiSelectionKeyCode={['Meta', 'Shift']}
      >
        <Background variant={BackgroundVariant.Dots} gap={18} size={1} color="#242931" />
        <Controls showInteractive={false}>
          <ControlButton onClick={tidy} title="Lay the graph out left to right">
            {/* Three stacked bars: the layered layout this produces. */}
            <svg viewBox="0 0 16 16" width={12} height={12} fill="currentColor">
              <rect x="1" y="2" width="6" height="3" rx="1" />
              <rect x="9" y="6.5" width="6" height="3" rx="1" />
              <rect x="1" y="11" width="6" height="3" rx="1" />
            </svg>
          </ControlButton>
        </Controls>
        <MiniMap
          pannable
          zoomable
          maskColor="rgba(14,16,19,0.75)"
          style={{ background: '#15181d', border: '1px solid #2e343d' }}
          nodeColor={(node) => {
            const def = registry.get((node.data as TerrainNodeData).type);
            return categoryColorValue(def?.category ?? 'utility');
          }}
        />
      </ReactFlow>
    </div>
  );
}
