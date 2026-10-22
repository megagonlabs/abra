import { getBezierPath } from '@xyflow/react';

import { getConnectionLineParams } from './floatingEdgeParams.js';

export function FloatingConnectionLine({ fromNode, toX, toY, connectionLineStyle }) {
  const params = getConnectionLineParams(fromNode, { x: toX, y: toY }, 'connection source');
  if (!params) return null;
  const { sx, sy, tx, ty, sourcePos, targetPos } = params;

  const [edgePath] = getBezierPath({
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
        fill="none"
        stroke="#3a4a6a"
        strokeWidth={1.5}
        className="animated"
        d={edgePath}
        style={connectionLineStyle}
      />
      <circle cx={tx} cy={ty} fill="#f8fafc" r={3} stroke="#3a4a6a" strokeWidth={1.5} />
    </g>
  );
}
