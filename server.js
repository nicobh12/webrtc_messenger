'use strict';

const http = require('http');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { WebSocketServer, WebSocket } = require('ws');

const PORT = Number(process.env.PORT) || 3000;
const NODE_NAME = process.env.NODE_NAME || 'nodo-local';
const SESSION_ID = crypto.randomBytes(6).toString('hex');
const PUBLIC_DIR = path.join(__dirname, 'public');
const PEER_PATH = '/peer';

const MAX_CHAT_LENGTH = 2000;
const MAX_USER_ID_LENGTH = 64;
const MAX_MESSAGE_ID_LENGTH = 100;
const ACK_TIMEOUT_MS = Number(process.env.ACK_TIMEOUT_MS) || 5000;
const HEARTBEAT_INTERVAL_MS = Number(process.env.HEARTBEAT_INTERVAL_MS) || 15000;
const RECONNECT_MIN_MS = Number(process.env.RECONNECT_MIN_MS) || 500;
const RECONNECT_MAX_MS = Number(process.env.RECONNECT_MAX_MS) || 8000;
const DEDUPE_TTL_MS = 60 * 1000;
const USER_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

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

// ---------------------------------------------------------------- Estado

/** userId -> Set<WebSocket> de clientes conectados a ESTE nodo. */
const localUsers = new Map();
/** userId -> nodeId donde está conectado el usuario (registro distribuido). */
const remoteUsers = new Map();
/** nodeId -> Set<WebSocket> con todos los enlaces (entrantes y salientes). */
const peerLinks = new Map();
/** nodeId -> { url, socket, attempts, timer } para los enlaces salientes. */
const outboundPeers = new Map();
/** nodeId -> { sessionId, seq } última presencia aceptada de ese nodo. */
const remotePresence = new Map();
/** "originNode:messageId" -> expiración, para descartar reenvíos duplicados. */
const seenPeerMessages = new Map();
/** "sender:messageId" -> { socket, timer, ... } esperando peer-ack. */
const pendingAcks = new Map();
/** Sockets de navegador (no incluye enlaces entre nodos). */
const clientSockets = new Set();

let presenceSeq = 0;
let shuttingDown = false;

// ------------------------------------------------------- Servidor HTTP/WS

const app = express();
app.disable('x-powered-by');
app.use(express.static(PUBLIC_DIR));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, maxPayload: 64 * 1024 });

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

function broadcastPeerPresence(event, userId) {
  presenceSeq += 1;

  const payload = {
    type: 'peer-presence',
    node: NODE_NAME,
    sessionId: SESSION_ID,
    seq: presenceSeq,
    event,
    userId,
    ts: Date.now(),
  };

  for (const sockets of peerLinks.values()) {
    for (const socket of sockets) {
      sendJson(socket, payload);
    }
  }
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

function buildPeerUrl(nodeId) {
  return `ws://${nodeId}:${PORT}${PEER_PATH}`;
}

function addNodeQuery(rawUrl) {
  const url = new URL(rawUrl);
  url.searchParams.set('node', NODE_NAME);
  return url.toString();
}

function parsePeerTargets() {
  const targets = new Map();

  for (const nodeId of (process.env.PEER_NODES || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)) {
    if (normalizeUserId(nodeId) && nodeId !== NODE_NAME) {
      targets.set(nodeId, buildPeerUrl(nodeId));
    }
  }

  // PEER_URLS permite pruebas locales con "nodo-b=ws://127.0.0.1:4200/peer".
  for (const entry of (process.env.PEER_URLS || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)) {
    const separator = entry.indexOf('=');

    if (separator === -1) {
      if (normalizeUserId(entry) && entry !== NODE_NAME) {
        targets.set(entry, buildPeerUrl(entry));
      }
      continue;
    }

    const nodeId = entry.slice(0, separator).trim();
    const url = entry.slice(separator + 1).trim();

    if (!normalizeUserId(nodeId) || nodeId === NODE_NAME) continue;
    if (!/^wss?:\/\//i.test(url)) {
      log(`PEER_URLS ignorado: URL inválida para ${nodeId}.`);
      continue;
    }

    targets.set(nodeId, url);
  }

  return targets;
}

// --------------------------------------------------------------- Clientes

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
    broadcastPeerPresence('join', userId);
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

  broadcastPeerPresence('leave', userId);
  broadcastPresence();
}

function handleClientConnection(socket, request) {
  socket.__kind = 'client';
  socket.__isAlive = true;
  socket.__userId = null;
  clientSockets.add(socket);

  const clientId = `${request.socket.remoteAddress}:${request.socket.remotePort}`;
  log(`Cliente conectado (${clientId}) en ${request.url}. Clientes: ${clientSockets.size}`);

  socket.on('message', (data, isBinary) => {
    if (isBinary) {
      log(`Mensaje binario ignorado de ${clientId} (${data.length} bytes).`);
      return;
    }

    const raw = data.toString();
    log(`Mensaje de ${clientId}: ${truncate(raw, 500)}`);

    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      sendJson(socket, {
        type: 'error',
        code: 'invalid-json',
        detail: 'El mensaje no es JSON válido.',
        ts: Date.now(),
      });
      return;
    }

    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      sendJson(socket, {
        type: 'error',
        code: 'invalid-message',
        detail: 'El mensaje debe ser un objeto JSON.',
        ts: Date.now(),
      });
      return;
    }

    handleClientMessage(socket, message, clientId);
  });

  socket.on('pong', () => {
    socket.__isAlive = true;
  });

  socket.on('close', (code, reason) => {
    clientSockets.delete(socket);
    unregisterUser(socket);

    const detail = reason.length > 0 ? reason.toString() : 'sin motivo';
    log(
      `Cliente desconectado (${clientId}). Código: ${code}. Motivo: ${detail}. ` +
        `Clientes: ${clientSockets.size}.`
    );
  });

  socket.on('error', (error) => {
    log(`Error en el socket de ${clientId}: ${error.message}`);
  });
}

function handleClientMessage(socket, message, clientId) {
  switch (message.type) {
    case 'register': {
      const userId = normalizeUserId(message.userId);

      if (!userId) {
        sendJson(socket, {
          type: 'error',
          code: 'invalid-user-id',
          detail:
            'Identificador inválido. Usa letras, números, punto, guion o guion bajo ' +
            `(máximo ${MAX_USER_ID_LENGTH} caracteres).`,
          ts: Date.now(),
        });
        return;
      }

      registerUser(socket, userId);
      return;
    }

    case 'chat':
      handleClientChat(socket, message, clientId);
      return;

    case 'who':
      sendJson(socket, presencePayload());
      return;

    default:
      sendJson(socket, {
        type: 'error',
        code: 'unknown-type',
        detail: `Tipo de mensaje no soportado: ${message.type ?? 'sin type'}.`,
        ts: Date.now(),
      });
  }
}

function chatError(socket, messageId, target, reason, detail) {
  sendJson(socket, {
    type: 'chat-error',
    messageId,
    target: target ?? null,
    reason,
    detail,
    node: NODE_NAME,
    ts: Date.now(),
  });

  log(
    `Chat ${messageId} no entregado (${reason})${target ? ` -> ${target}` : ''}: ${detail}`
  );
}

function handleClientChat(socket, message, clientId) {
  // Compatibilidad con la Fase 3: si el cliente no se registró, se usa "sender".
  if (!socket.__userId) {
    const fallback =
      normalizeUserId(message.sender) || `anon-${crypto.randomBytes(3).toString('hex')}`;
    registerUser(socket, fallback);
  }

  const sender = socket.__userId;
  const target = normalizeUserId(message.target);
  const text =
    typeof message.text === 'string'
      ? truncate(message.text.trim(), MAX_CHAT_LENGTH)
      : '';
  const messageId =
    typeof message.messageId === 'string' && message.messageId.trim()
      ? truncate(message.messageId.trim(), MAX_MESSAGE_ID_LENGTH)
      : crypto.randomUUID();

  if (!target) {
    chatError(
      socket,
      messageId,
      null,
      'missing-target',
      'Falta el campo "target" o no es un identificador válido.'
    );
    return;
  }

  if (!text) {
    chatError(socket, messageId, target, 'empty-text', 'El campo "text" está vacío.');
    return;
  }

  log(`Chat ${messageId} de ${sender} (${clientId}) -> ${target}: ${truncate(text, 120)}`);

  // 1) Destinatario conectado a ESTE nodo: entrega directa.
  if (localUsers.has(target)) {
    const recipients = sendToLocalUser(target, {
      type: 'chat',
      messageId,
      sender,
      target,
      text,
      fromNode: NODE_NAME,
      ts: Date.now(),
    });

    if (recipients > 0) {
      sendJson(socket, {
        type: 'chat-ack',
        messageId,
        sender,
        target,
        targetNode: NODE_NAME,
        status: 'delivered',
        recipients,
        ts: Date.now(),
      });
      log(`Chat ${messageId} entregado localmente a ${target} (${recipients} conexión/es).`);
      return;
    }
  }

  // 2) Destinatario en otro nodo: se consulta el registro distribuido.
  const targetNode = remoteUsers.get(target);

  if (!targetNode) {
    chatError(
      socket,
      messageId,
      target,
      'offline',
      `El usuario "${target}" no está conectado en ningún nodo.`
    );
    return;
  }

  const peerSocket = getPeerSocket(targetNode);

  if (!peerSocket) {
    chatError(
      socket,
      messageId,
      target,
      'peer-unreachable',
      `No hay enlace activo con el nodo "${targetNode}".`
    );
    return;
  }

  const key = `${sender}:${messageId}`;

  if (pendingAcks.has(key)) {
    log(`Chat ${messageId} ya está pendiente; se ignora el duplicado.`);
    return;
  }

  const timer = setTimeout(() => {
    pendingAcks.delete(key);
    chatError(
      socket,
      messageId,
      target,
      'timeout',
      `El nodo "${targetNode}" no confirmó la entrega en ${ACK_TIMEOUT_MS} ms.`
    );
  }, ACK_TIMEOUT_MS);
  timer.unref?.();

  pendingAcks.set(key, { socket, messageId, sender, target, targetNode, timer });

  const sent = sendJson(peerSocket, {
    type: 'peer-chat',
    messageId,
    originNode: NODE_NAME,
    sender,
    target,
    text,
    hops: [NODE_NAME],
    ts: Date.now(),
  });

  if (!sent) {
    clearTimeout(timer);
    pendingAcks.delete(key);
    chatError(
      socket,
      messageId,
      target,
      'peer-unreachable',
      `No se pudo escribir en el enlace con "${targetNode}".`
    );
    return;
  }

  log(`Chat ${messageId} reenviado a ${targetNode} para ${target}.`);
}

// -------------------------------------------------------- Mensajes de nodos

function isDuplicatePeerMessage(key) {
  const expiresAt = seenPeerMessages.get(key);
  return typeof expiresAt === 'number' && expiresAt > Date.now();
}

function markPeerMessageSeen(key) {
  seenPeerMessages.set(key, Date.now() + DEDUPE_TTL_MS);
}

function handlePeerMessage(socket, raw) {
  let message;

  try {
    message = JSON.parse(raw);
  } catch {
    log(`Mensaje no JSON del enlace ${socket.__nodeId}; se descarta.`);
    return;
  }

  if (!message || typeof message !== 'object' || Array.isArray(message)) return;

  switch (message.type) {
    case 'peer-hello':
      handlePeerHello(socket, message);
      break;
    case 'peer-presence':
      handlePeerPresence(socket, message);
      break;
    case 'peer-chat':
      handlePeerChat(socket, message);
      break;
    case 'peer-ack':
      handlePeerAck(socket, message);
      break;
    default:
      log(`Mensaje peer desconocido de ${socket.__nodeId}: ${message.type}`);
  }
}

function handlePeerHello(socket, message) {
  const nodeId = socket.__nodeId;

  if (message.node !== nodeId) {
    log(
      `peer-hello inesperado: se esperaba "${nodeId}" y llegó "${message.node}". ` +
        'Se cierra el enlace.'
    );
    socket.close(1008, 'Nodo inesperado');
    return;
  }

  const users = Array.isArray(message.users)
    ? [...new Set(message.users.map(normalizeUserId).filter(Boolean))]
    : [];
  const sessionId = typeof message.sessionId === 'string' ? message.sessionId : 'desconocida';
  const seq = Number.isInteger(message.seq) ? message.seq : 0;
  const known = remotePresence.get(nodeId);

  if (known && known.sessionId === sessionId && seq < known.seq) {
    log(`peer-hello obsoleto de ${nodeId} (seq ${seq} < ${known.seq}); ignorado.`);
    return;
  }

  remotePresence.set(nodeId, { sessionId, seq });

  let changed = false;

  for (const [userId, node] of [...remoteUsers]) {
    if (node === nodeId && !users.includes(userId)) {
      remoteUsers.delete(userId);
      changed = true;
    }
  }

  for (const userId of users) {
    if (localUsers.has(userId)) {
      log(`Conflicto: "${userId}" está local y también en ${nodeId}; se mantiene el registro local.`);
      continue;
    }

    if (remoteUsers.get(userId) !== nodeId) {
      remoteUsers.set(userId, nodeId);
      changed = true;
    }
  }

  log(
    `peer-hello de ${nodeId} (sesión ${sessionId}, seq ${seq}): ` +
      `${users.length} usuario(s)${changed ? ' [directorio actualizado]' : ''}.`
  );

  broadcastPresence();
}

function handlePeerPresence(socket, message) {
  const nodeId = socket.__nodeId;

  if (message.node !== nodeId) return;

  const userId = normalizeUserId(message.userId);
  if (!userId) return;

  const sessionId = typeof message.sessionId === 'string' ? message.sessionId : 'desconocida';
  const seq = Number.isInteger(message.seq) ? message.seq : 0;
  const known = remotePresence.get(nodeId);

  if (!known || known.sessionId !== sessionId) {
    remotePresence.set(nodeId, { sessionId, seq });
  } else {
    if (seq <= known.seq) {
      log(`Presencia obsoleta de ${nodeId} (seq ${seq} <= ${known.seq}); ignorada.`);
      return;
    }
    known.seq = seq;
  }

  if (message.event === 'join') {
    if (localUsers.has(userId)) {
      log(`Conflicto: "${userId}" ya está local; no se registra como remoto en ${nodeId}.`);
      return;
    }

    remoteUsers.set(userId, nodeId);
    log(`Usuario "${userId}" conectado en ${nodeId}.`);
  } else if (message.event === 'leave') {
    if (remoteUsers.get(userId) === nodeId) {
      remoteUsers.delete(userId);
      log(`Usuario "${userId}" desconectado de ${nodeId}.`);
    }
  } else {
    log(`Evento de presencia desconocido de ${nodeId}: ${message.event}`);
    return;
  }

  broadcastPresence();
}

function handlePeerChat(socket, message) {
  const originNode =
    typeof message.originNode === 'string' ? message.originNode : socket.__nodeId;
  const messageId =
    typeof message.messageId === 'string'
      ? truncate(message.messageId.trim(), MAX_MESSAGE_ID_LENGTH)
      : '';
  const sender = normalizeUserId(message.sender);
  const target = normalizeUserId(message.target);
  const text =
    typeof message.text === 'string'
      ? truncate(message.text.trim(), MAX_CHAT_LENGTH)
      : '';

  if (!messageId || !sender || !target || !text) {
    log(`peer-chat inválido de ${originNode}; se descarta.`);
    return;
  }

  if (originNode !== socket.__nodeId) {
    log(
      `peer-chat con originNode "${originNode}" no coincide con el enlace ` +
        `"${socket.__nodeId}"; se descarta.`
    );
    return;
  }

  const key = `${originNode}:${messageId}`;

  if (isDuplicatePeerMessage(key)) {
    log(`peer-chat duplicado ${key}; se reenvía el ack sin volver a entregar.`);
    sendJson(socket, {
      type: 'peer-ack',
      messageId,
      sender,
      target,
      status: localUsers.has(target) ? 'delivered' : 'offline',
      targetNode: NODE_NAME,
      duplicate: true,
      ts: Date.now(),
    });
    return;
  }

  markPeerMessageSeen(key);

  const recipients = sendToLocalUser(target, {
    type: 'chat',
    messageId,
    sender,
    target,
    text,
    fromNode: originNode,
    ts: Number.isFinite(message.ts) ? message.ts : Date.now(),
  });

  const status = recipients > 0 ? 'delivered' : 'offline';

  sendJson(socket, {
    type: 'peer-ack',
    messageId,
    sender,
    target,
    status,
    targetNode: NODE_NAME,
    recipients,
    ts: Date.now(),
  });

  log(
    `peer-chat ${messageId} de ${originNode} para ${target}: ` +
      `${status} (${recipients} conexión/es).`
  );

  // Importante: un chat recibido de otro nodo NUNCA se reenvía.
  // Se entrega solo a sockets locales y se confirma; así no hay bucles.
}

function handlePeerAck(socket, message) {
  const messageId =
    typeof message.messageId === 'string' ? message.messageId.trim() : '';
  const sender = normalizeUserId(message.sender);

  if (!messageId || !sender) return;

  const key = `${sender}:${messageId}`;
  const pending = pendingAcks.get(key);

  if (!pending) {
    log(`peer-ack sin solicitud pendiente (${key}) desde ${socket.__nodeId}; ignorado.`);
    return;
  }

  clearTimeout(pending.timer);
  pendingAcks.delete(key);

  if (message.status === 'delivered') {
    sendJson(pending.socket, {
      type: 'chat-ack',
      messageId,
      sender,
      target: pending.target,
      targetNode: message.targetNode || pending.targetNode,
      status: 'delivered',
      ts: Date.now(),
    });
    log(
      `Chat ${messageId} confirmado por ${message.targetNode || pending.targetNode} ` +
        `para ${pending.target}.`
    );
    return;
  }

  chatError(
    pending.socket,
    messageId,
    pending.target,
    message.status === 'offline' ? 'offline' : 'remote-error',
    `El nodo "${message.targetNode || pending.targetNode}" no encontró conectado a ` +
      `"${pending.target}".`
  );
}

// ------------------------------------------------------ Enlaces entre nodos

function registerPeerSocket(socket) {
  const nodeId = socket.__nodeId;

  let sockets = peerLinks.get(nodeId);
  if (!sockets) {
    sockets = new Set();
    peerLinks.set(nodeId, sockets);
  }
  sockets.add(socket);

  log(
    `Enlace ${socket.__direction} con ${nodeId} establecido. ` +
      `Enlaces con ${nodeId}: ${sockets.size}.`
  );

  sendHello(socket);
  broadcastPresence();
}

function unregisterPeerSocket(socket) {
  const nodeId = socket.__nodeId;
  const sockets = peerLinks.get(nodeId);

  if (!sockets) return;

  sockets.delete(socket);

  if (sockets.size > 0) {
    log(
      `Enlace ${socket.__direction} con ${nodeId} cerrado; quedan ${sockets.size}.`
    );
    return;
  }

  peerLinks.delete(nodeId);
  remotePresence.delete(nodeId);

  let removed = 0;
  for (const [userId, node] of [...remoteUsers]) {
    if (node === nodeId) {
      remoteUsers.delete(userId);
      removed += 1;
    }
  }

  failPendingAcksForNode(nodeId);

  log(`Sin enlaces con ${nodeId}. Usuarios remotos eliminados: ${removed}.`);
  broadcastPresence();
}

function getPeerSocket(nodeId) {
  const sockets = peerLinks.get(nodeId);
  if (!sockets || sockets.size === 0) return null;

  for (const socket of sockets) {
    if (socket.__direction === 'outbound' && socket.readyState === WebSocket.OPEN) {
      return socket;
    }
  }

  for (const socket of sockets) {
    if (socket.readyState === WebSocket.OPEN) return socket;
  }

  return null;
}

function failPendingAcksForNode(nodeId) {
  for (const [key, pending] of [...pendingAcks]) {
    if (pending.targetNode !== nodeId) continue;

    clearTimeout(pending.timer);
    pendingAcks.delete(key);

    chatError(
      pending.socket,
      pending.messageId,
      pending.target,
      'peer-unreachable',
      `Se perdió el enlace con el nodo "${nodeId}".`
    );
  }
}

function handlePeerConnection(socket, request, url) {
  const nodeId = normalizeUserId(url.searchParams.get('node'));

  if (!nodeId) {
    log(`Conexión peer rechazada: falta el parámetro "node" (${request.url}).`);
    socket.close(1008, 'Falta el parámetro node');
    return;
  }

  if (nodeId === NODE_NAME) {
    log('Conexión peer rechazada: un nodo no puede enlazarse consigo mismo.');
    socket.close(1008, 'No se permite un enlace consigo mismo');
    return;
  }

  socket.__kind = 'peer';
  socket.__direction = 'inbound';
  socket.__nodeId = nodeId;
  socket.__isAlive = true;

  log(`Conexión peer entrante de ${nodeId} (${request.socket.remoteAddress}).`);

  socket.on('message', (data, isBinary) => {
    if (!isBinary) handlePeerMessage(socket, data.toString());
  });

  socket.on('pong', () => {
    socket.__isAlive = true;
  });

  socket.on('close', (code) => {
    unregisterPeerSocket(socket);
    log(`Enlace entrante con ${nodeId} cerrado (código ${code}).`);
  });

  socket.on('error', (error) => {
    log(`Error en el enlace entrante con ${nodeId}: ${error.message}`);
  });

  registerPeerSocket(socket);
}

function scheduleReconnect(nodeId) {
  if (shuttingDown) return;

  const state = outboundPeers.get(nodeId);
  if (!state || state.timer) return;

  state.attempts += 1;
  const exponent = Math.min(state.attempts - 1, 5);
  const delay =
    Math.min(RECONNECT_MAX_MS, RECONNECT_MIN_MS * 2 ** exponent) +
    Math.floor(Math.random() * 250);

  log(`Reintentando enlace con ${nodeId} en ${delay} ms (intento ${state.attempts}).`);

  state.timer = setTimeout(() => {
    state.timer = null;
    connectToPeer(nodeId);
  }, delay);
  state.timer.unref?.();
}

function connectToPeer(nodeId) {
  if (shuttingDown) return;

  const state = outboundPeers.get(nodeId);
  if (!state) return;

  if (
    state.socket &&
    (state.socket.readyState === WebSocket.OPEN ||
      state.socket.readyState === WebSocket.CONNECTING)
  ) {
    return;
  }

  let url;
  try {
    url = addNodeQuery(state.url);
  } catch (error) {
    log(`URL peer inválida para ${nodeId}: ${error.message}`);
    scheduleReconnect(nodeId);
    return;
  }

  log(`Conectando con ${nodeId} en ${url}...`);

  let socket;
  try {
    socket = new WebSocket(url, {
      handshakeTimeout: 5000,
      maxPayload: 64 * 1024,
    });
  } catch (error) {
    log(`No se pudo crear el enlace con ${nodeId}: ${error.message}`);
    scheduleReconnect(nodeId);
    return;
  }

  state.socket = socket;
  socket.__kind = 'peer';
  socket.__direction = 'outbound';
  socket.__nodeId = nodeId;
  socket.__isAlive = true;

  socket.on('open', () => {
    state.attempts = 0;
    log(`Conexión saliente con ${nodeId} abierta.`);
    registerPeerSocket(socket);
  });

  socket.on('message', (data, isBinary) => {
    if (!isBinary) handlePeerMessage(socket, data.toString());
  });

  socket.on('pong', () => {
    socket.__isAlive = true;
  });

  socket.on('error', (error) => {
    log(`Error de enlace con ${nodeId}: ${error.message}`);
  });

  socket.on('close', (code) => {
    if (state.socket === socket) state.socket = null;
    unregisterPeerSocket(socket);
    log(`Enlace saliente con ${nodeId} cerrado (código ${code}).`);
    scheduleReconnect(nodeId);
  });
}

// --------------------------------------------------------- HTTP de control

app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    node: NODE_NAME,
    sessionId: SESSION_ID,
    clients: clientSockets.size,
    users: localUsers.size,
    peers: peerNames(),
  });
});

app.get('/api/state', (_req, res) => {
  res.json({
    node: NODE_NAME,
    sessionId: SESSION_ID,
    presenceSeq,
    clients: [...clientSockets].map((socket) => ({
      userId: socket.__userId ?? null,
      readyState: socket.readyState,
    })),
    localUsers: [...localUsers.keys()].sort(),
    remoteUsers: Object.fromEntries(remoteUsers),
    peers: peerNames(),
    outbound: [...outboundPeers].map(([node, state]) => ({
      node,
      url: state.url,
      readyState: state.socket ? state.socket.readyState : null,
      attempts: state.attempts,
      reconnectScheduled: Boolean(state.timer),
    })),
    pendingAcks: [...pendingAcks.keys()],
  });
});

// ------------------------------------------------------------ Ciclo de vida

wss.on('connection', (socket, request) => {
  socket.__isAlive = true;

  let url;
  try {
    url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
  } catch {
    socket.close(1008, 'URL inválida');
    return;
  }

  if (url.pathname === PEER_PATH) {
    handlePeerConnection(socket, request, url);
    return;
  }

  handleClientConnection(socket, request);
});

wss.on('error', (error) => {
  log(`Error del servidor WebSocket: ${error.message}`);
});

server.on('error', (error) => {
  log(`Error del servidor HTTP: ${error.message}`);
});

// Heartbeat: detecta enlaces y clientes muertos (ping/pong de WebSocket).
const heartbeat = setInterval(() => {
  for (const socket of wss.clients) {
    if (socket.readyState !== WebSocket.OPEN) continue;

    if (socket.__isAlive === false) {
      log(`Sin respuesta de heartbeat (${socket.__kind ?? 'desconocido'}); se cierra el socket.`);
      socket.terminate();
      continue;
    }

    socket.__isAlive = false;
    try {
      socket.ping();
    } catch {
      // El evento "close" se encarga de limpiar el estado.
    }
  }
}, HEARTBEAT_INTERVAL_MS);
heartbeat.unref?.();

// Limpieza periódica de la caché de deduplicación.
const dedupeCleanup = setInterval(() => {
  const now = Date.now();
  for (const [key, expiresAt] of seenPeerMessages) {
    if (expiresAt <= now) seenPeerMessages.delete(key);
  }
}, 30 * 1000);
dedupeCleanup.unref?.();

for (const [nodeId, url] of parsePeerTargets()) {
  outboundPeers.set(nodeId, { url, socket: null, attempts: 0, timer: null });
}

server.listen(PORT, () => {
  log(`Servidor HTTP/WebSocket escuchando en el puerto ${PORT} (sesión ${SESSION_ID}).`);
  log(`Interfaz web: http://localhost:${PORT}`);
  log(`Rutas: / (clientes) y ${PEER_PATH} (comunicación entre nodos).`);

  if (outboundPeers.size === 0) {
    log(
      'Sin nodos peer configurados. Define PEER_NODES o PEER_URLS para habilitar ' +
        'el chat entre nodos.'
    );
    return;
  }

  for (const nodeId of outboundPeers.keys()) {
    connectToPeer(nodeId);
  }
});

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;

  log(`Señal ${signal} recibida. Cerrando servidor...`);

  clearInterval(heartbeat);
  clearInterval(dedupeCleanup);

  for (const state of outboundPeers.values()) {
    if (state.timer) clearTimeout(state.timer);
    state.socket?.terminate();
  }

  for (const pending of pendingAcks.values()) {
    clearTimeout(pending.timer);
  }
  pendingAcks.clear();

  for (const socket of wss.clients) {
    try {
      socket.close(1001, 'Servidor apagándose');
    } catch {
      // Ignorar sockets ya cerrados.
    }
  }

  wss.close(() => {
    server.close(() => {
      log('Servidor cerrado correctamente.');
      process.exit(0);
    });
  });

  // Cierre forzado si alguna conexión impide terminar el proceso.
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
