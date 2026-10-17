// Active transport connections are revoked independently from retained SSH shells.
const connections = new Map();
function trackConnection(sessionId, ws) {
  if (!connections.has(sessionId)) connections.set(sessionId, new Set());
  const set = connections.get(sessionId);
  set.add(ws);
  ws.once('close', () => { set.delete(ws); if (!set.size) connections.delete(sessionId); });
}
function closeConnections(sessionId) {
  for (const ws of connections.get(sessionId) || []) {
    try { ws.close(1008, 'Authentication changed; please sign in again'); } catch (_) { ws.terminate(); }
  }
}
function closeOtherConnections(sessionId) {
  for (const id of connections.keys()) if (id !== sessionId) closeConnections(id);
}
module.exports = { trackConnection, closeConnections, closeOtherConnections };
