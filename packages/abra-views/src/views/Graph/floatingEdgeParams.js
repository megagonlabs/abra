import { Position } from '@xyflow/react';

export function assertNodeReady(node, id) {
  if (!node) throw new Error(`Missing internal React Flow node: ${id}`);
  if (!node.internals) throw new Error(`Missing internals for node: ${id}`);
  if (!node.internals.positionAbsolute)
    throw new Error(`Missing absolute position for node: ${id}`);
  if (!node.measured) throw new Error(`Missing measured dimensions for node: ${id}`);
  if (!node.measured.width) throw new Error(`Missing measured width for node: ${id}`);
  if (!node.measured.height) throw new Error(`Missing measured height for node: ${id}`);
}

export function isNodeReady(node) {
  return Boolean(node?.internals?.positionAbsolute && node.measured?.width && node.measured.height);
}

function nodeSize(node) {
  return {
    width: node.measured.width,
    height: node.measured.height,
  };
}

function nodeOrigin(node) {
  return {
    x: node.internals.positionAbsolute.x,
    y: node.internals.positionAbsolute.y,
  };
}

function nodeCenter(node) {
  const origin = nodeOrigin(node);
  const size = nodeSize(node);
  return {
    x: origin.x + size.width / 2,
    y: origin.y + size.height / 2,
  };
}

// Where the centre→point ray exits the node box, AND which face it exits through.
// The two MUST agree: the attach point's face determines the perpendicular exit
// direction. (Deriving the side from the raw centre delta's dominant axis instead —
// as the React-Flow example does — disagrees with the actual exit face on non-square
// nodes, so the bezier leaves perpendicular to the WRONG axis and the join looks off.)
function boundaryPointToPoint(node, point) {
  const origin = nodeOrigin(node);
  const size = nodeSize(node);
  const center = nodeCenter(node);
  const dx = point.x - center.x;
  const dy = point.y - center.y;

  if (dx === 0 && dy === 0)
    throw new Error(`Cannot compute floating edge from node center: ${node.id}`);

  const halfWidth = size.width / 2;
  const halfHeight = size.height / 2;
  const scaleX = Math.abs(halfWidth / dx); // Infinity when dx === 0
  const scaleY = Math.abs(halfHeight / dy); // Infinity when dy === 0
  const scale = Math.min(scaleX, scaleY);

  if (!Number.isFinite(scale)) throw new Error(`Invalid floating edge scale from node: ${node.id}`);

  // the LIMITING axis is the face the ray hits first → the side it exits through
  const pos =
    scaleX < scaleY
      ? dx > 0
        ? Position.Right
        : Position.Left
      : dy > 0
        ? Position.Bottom
        : Position.Top;

  return {
    x: origin.x + halfWidth + dx * scale,
    y: origin.y + halfHeight + dy * scale,
    pos,
  };
}

function isNodeCenterPoint(node, point) {
  const center = nodeCenter(node);
  return point.x === center.x && point.y === center.y;
}

function oppositePosition(position) {
  if (position === Position.Left) return Position.Right;
  if (position === Position.Right) return Position.Left;
  if (position === Position.Top) return Position.Bottom;
  if (position === Position.Bottom) return Position.Top;
  throw new Error(`Unknown floating edge position: ${position}`);
}

export function getEdgeParams(sourceNode, targetNode, sourceId, targetId) {
  assertNodeReady(sourceNode, sourceId);
  assertNodeReady(targetNode, targetId);

  const sourceCenter = nodeCenter(sourceNode);
  const targetCenter = nodeCenter(targetNode);
  const sourcePoint = boundaryPointToPoint(sourceNode, targetCenter);
  const targetPoint = boundaryPointToPoint(targetNode, sourceCenter);

  return {
    sx: sourcePoint.x,
    sy: sourcePoint.y,
    tx: targetPoint.x,
    ty: targetPoint.y,
    sourcePos: sourcePoint.pos, // face the point actually sits on → correct perpendicular
    targetPos: targetPoint.pos,
  };
}

export function getConnectionLineParams(sourceNode, targetPoint, sourceId) {
  assertNodeReady(sourceNode, sourceId);
  if (!Number.isFinite(targetPoint.x))
    throw new Error('Floating connection target x must be finite');
  if (!Number.isFinite(targetPoint.y))
    throw new Error('Floating connection target y must be finite');

  if (isNodeCenterPoint(sourceNode, targetPoint)) return null;

  const sourcePoint = boundaryPointToPoint(sourceNode, targetPoint);

  return {
    sx: sourcePoint.x,
    sy: sourcePoint.y,
    tx: targetPoint.x,
    ty: targetPoint.y,
    sourcePos: sourcePoint.pos,
    targetPos: oppositePosition(sourcePoint.pos),
  };
}
