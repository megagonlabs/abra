import { getBezierPath, useInternalNode } from '@xyflow/react';

import { getEdgeParams, isNodeReady } from './floatingEdgeParams.js';

export function FloatingEdge({ id, source, target, markerEnd, style, label, labelStyle }) {
  const sourceNode = useInternalNode(source);
  const targetNode = useInternalNode(target);
  if (!isNodeReady(sourceNode) || !isNodeReady(targetNode)) return null;

  const { sx, sy, tx, ty, sourcePos, targetPos } = getEdgeParams(
    sourceNode,
    targetNode,
    source,
    target,
  );

  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX: sx,
    sourceY: sy,
    sourcePosition: sourcePos,
    targetX: tx,
    targetY: ty,
    targetPosition: targetPos,
  });

  return (
    <g>
      <path
        id={id}
        className="react-flow__edge-path"
        d={edgePath}
        markerEnd={markerEnd}
        style={style}
      />
      {label && (
        <text
          x={labelX}
          y={labelY - 6}
          textAnchor="middle"
          dominantBaseline="central"
          pointerEvents="none"
          style={{
            fill: '#687482',
            fontSize: 10,
            fontWeight: 600,
            paintOrder: 'stroke',
            stroke: '#f8fafc',
            strokeWidth: 3,
            ...labelStyle,
          }}
        >
          {label}
        </text>
      )}
    </g>
  );
}
