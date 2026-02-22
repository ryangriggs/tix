'use strict';

// In-memory map of connected SSE clients.
// Map<userId (number), Set<res>>
const clients = new Map();

function addClient(userId, res) {
  if (!clients.has(userId)) clients.set(userId, new Set());
  clients.get(userId).add(res);
}

function removeClient(userId, res) {
  const set = clients.get(userId);
  if (!set) return;
  set.delete(res);
  if (set.size === 0) clients.delete(userId);
}

function sendToUser(userId, event) {
  const set = clients.get(userId);
  if (!set) return;
  const data = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of set) {
    try { res.write(data); } catch (_) { /* client disconnected */ }
  }
}

// Send an event to a specific list of user IDs
function broadcast(userIds, event) {
  for (const userId of userIds) sendToUser(userId, event);
}

// Send an event to every connected client (used for admin-visible new tickets)
function broadcastToAll(event) {
  const data = `data: ${JSON.stringify(event)}\n\n`;
  for (const set of clients.values()) {
    for (const res of set) {
      try { res.write(data); } catch (_) { /* ignore */ }
    }
  }
}

module.exports = { addClient, removeClient, broadcast, broadcastToAll };
