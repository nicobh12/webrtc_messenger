'use strict';

const crypto = require('crypto');
const { WebSocket } = require('ws');

const NODE_NAME = process.env.NODE_NAME || 'nodo-local';
const SESSION_ID = crypto.randomBytes(6).toString('hex');
const MAX_USER_ID_LENGTH = 64;
const USER_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

const localUsers = new Map();
const remoteUsers = new Map();
const peerLinks = new Map();
const outboundPeers = new Map();
const remotePresence = new Map();
const clientSockets = new Set();
let presenceSeq = 0;

const hooks = {};

function setHooks(nextHooks) {
  Object.assign(hooks, nextHooks);
}

function incrementPresenceSeq() {
  presenceSeq += 1;
  return presenceSeq;
}

function log(...args) {
  console.log(`[${new Date().toISOString()}] [${NODE_NAME}]`, ...args);
}

function normalizeUserId(value) {
  if (typeof value !== 'string') return null;
  const id = value.trim();
  return USER_ID_PATTERN.test(id) ? id : null;
}

function truncate(value, max) {
  return value.length > max ? value.slice(0, max) : value;
}

function directory() {
  const users = [];

  for (const userId of localUsers.keys()) {
    users.push({ userId, node: NODE_NAME, local: true });
  }

  for (const [userId, node] of remoteUsers) {
    if (!localUsers.has(userId)) {
      users.push({ userId, node, local: false });
    }
  }

  return users.sort((a, b) => a.userId.localeCompare(b.userId));
}

function peerNames() {
  return [...peerLinks.keys()].sort();
}

function presencePayload() {
  return {
    type: 'presence',
    node: NODE_NAME,
    users: directory(),
    peers: peerNames(),
    ts: Date.now(),
  };
}

function sendJson(socket, payload) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return false;

  try {
    socket.send(JSON.stringify(payload));
    return true;
  } catch (error) {
    log(`No se pudo enviar "${payload.type}": ${error.message}`);
    return false;
  }
}

function broadcastPresence() {
  const payload = presencePayload();

  for (const socket of clientSockets) {
    sendJson(socket, payload);
  }
}

function sendToLocalUser(userId, payload) {
  const sockets = localUsers.get(userId);
  if (!sockets) return 0;

  let sent = 0;
  for (const socket of sockets) {
    if (sendJson(socket, payload)) sent += 1;
  }

  return sent;
}

function sendHello(socket) {
  sendJson(socket, {
    type: 'peer-hello',
    node: NODE_NAME,
    sessionId: SESSION_ID,
    seq: presenceSeq,
    users: [...localUsers.keys()],
    ts: Date.now(),
  });
}

// ------------------------------------------------------ Destinos entre nodos

function welcomePayload(userId) {
  return {
    type: 'welcome',
    userId,
    node: NODE_NAME,
    sessionId: SESSION_ID,
    users: directory(),
    peers: peerNames(),
    ts: Date.now(),
  };
}

function registerUser(socket, userId) {
  if (socket.__userId === userId) {
    sendJson(socket, welcomePayload(userId));
    return;
  }

  if (socket.__userId) {
    unregisterUser(socket);
  }

  socket.__userId = userId;

  let sockets = localUsers.get(userId);
  if (!sockets) {
    sockets = new Set();
    localUsers.set(userId, sockets);
  }
  sockets.add(socket);

  const isNewUser = sockets.size === 1;

  log(
    `Usuario "${userId}" registrado (${isNewUser ? 'nuevo' : 'otra conexión'}). ` +
      `Usuarios locales: ${localUsers.size}.`
  );

  sendJson(socket, welcomePayload(userId));

  if (isNewUser) {
    if (hooks.broadcastPeerPresence) hooks.broadcastPeerPresence('join', userId);
    broadcastPresence();
  }
}

function unregisterUser(socket) {
  const userId = socket.__userId;
  if (!userId) return;

  socket.__userId = null;

  const sockets = localUsers.get(userId);
  if (!sockets) return;

  sockets.delete(socket);
  if (sockets.size > 0) return;

  localUsers.delete(userId);
  log(`Usuario "${userId}" sin conexiones locales. Usuarios locales: ${localUsers.size}.`);

  if (hooks.broadcastPeerPresence) hooks.broadcastPeerPresence('leave', userId);
  broadcastPresence();
}


module.exports = {
  NODE_NAME,
  SESSION_ID,
  MAX_USER_ID_LENGTH,
  localUsers,
  remoteUsers,
  peerLinks,
  outboundPeers,
  remotePresence,
  clientSockets,
  hooks,
  setHooks,
  incrementPresenceSeq,
  log,
  normalizeUserId,
  truncate,
  directory,
  peerNames,
  presencePayload,
  welcomePayload,
  sendJson,
  broadcastPresence,
  sendToLocalUser,
  sendHello,
  registerUser,
  unregisterUser,
  get presenceSeq() {
    return presenceSeq;
  },
};
