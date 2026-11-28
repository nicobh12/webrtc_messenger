'use strict';

const crypto = require('crypto');
const { WebSocket } = require('ws');
const rooms = require('./rooms');

const {
  NODE_NAME,
  SESSION_ID,
  MAX_USER_ID_LENGTH,
  localUsers,
  remoteUsers,
  peerLinks,
  outboundPeers,
  remotePresence,
  clientSockets,
  normalizeUserId,
  truncate,
  log,
  sendJson,
  broadcastPresence,
  sendToLocalUser,
  sendHello,
  registerUser,
  unregisterUser,
  presencePayload,
} = rooms;
const PORT = Number(process.env.PORT) || 3000;
const PEER_PATH = '/peer';
const MAX_CHAT_LENGTH = 2000;
const MAX_MESSAGE_ID_LENGTH = 100;
const ACK_TIMEOUT_MS = Number(process.env.ACK_TIMEOUT_MS) || 5000;
const RECONNECT_MIN_MS = Number(process.env.RECONNECT_MIN_MS) || 500;
const RECONNECT_MAX_MS = Number(process.env.RECONNECT_MAX_MS) || 8000;
const DEDUPE_TTL_MS = 60 * 1000;

const seenPeerMessages = new Map();
const pendingAcks = new Map();
let shuttingDown = false;

function broadcastPeerPresence(event, userId) {
  const seq = rooms.incrementPresenceSeq();

  const payload = {
    type: 'peer-presence',
    node: NODE_NAME,
    sessionId: SESSION_ID,
    seq,
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

    // WebRTC: el WebSocket solo transporta señalización (Bloque C).
    case 'offer':
    case 'answer':
    case 'candidate':
      handleClientSignal(socket, message, clientId);
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

// ------------------------------------------------- Señalización WebRTC

/** Tipos de señalización aceptados desde un cliente (Bloque C). */

const SIGNAL_TYPES = new Set(['offer', 'answer', 'candidate']);

function isValidSignalPayload(message) {
  if (message.type === 'offer' || message.type === 'answer') {
    return Boolean(
      message.sdp &&
        typeof message.sdp === 'object' &&
        typeof message.sdp.type === 'string' &&
        typeof message.sdp.sdp === 'string'
    );
  }

  if (message.type === 'candidate') {
    return message.candidate === null || (message.candidate && typeof message.candidate === 'object');
  }

  return false;
}

function signalError(socket, message, target, reason, detail) {
  sendJson(socket, {
    type: 'signal-error',
    signalType: message.type,
    target: target ?? null,
    reason,
    detail,
    node: NODE_NAME,
    ts: Date.now(),
  });

  log(
    `Señal ${message.type} no entregada (${reason})${target ? ` -> ${target}` : ''}: ${detail}`
  );
}

/**
 * Enruta offer/answer/candidate igual que un chat: directo si el destinatario
 * está en este nodo o por "peer-signal" si vive en otro nodo.
 * La señalización no usa acks: WebRTC reintenta/reniega por sí mismo.
 */
function handleClientSignal(socket, message, clientId) {
  const sender = socket.__userId;

  if (!sender) {
    sendJson(socket, {
      type: 'error',
      code: 'not-registered',
      detail: 'La señalización WebRTC requiere registro previo.',
      ts: Date.now(),
    });
    return;
  }

  const target = normalizeUserId(message.target);

  if (!target || target === sender) {
    signalError(socket, message, target, 'invalid-target', 'Destinatario de señalización inválido.');
    return;
  }

  if (!isValidSignalPayload(message)) {
    signalError(
      socket,
      message,
      target,
      'invalid-signal',
      'La señal no contiene un SDP o un candidato ICE válido.'
    );
    return;
  }

  const signal = {
    type: message.type,
    sender,
    target,
    ts: Date.now(),
  };

  if (message.sdp) signal.sdp = message.sdp;
  if (message.candidate !== undefined) signal.candidate = message.candidate;

  // 1) Destinatario conectado a ESTE nodo: entrega directa.
  if (localUsers.has(target)) {
    const recipients = sendToLocalUser(target, { ...signal, fromNode: NODE_NAME });

    if (recipients > 0) {
      log(`Señal ${message.type} de ${sender} (${clientId}) -> ${target} (local).`);
      return;
    }
  }

  // 2) Destinatario en otro nodo: se enruta por el enlace de nodos.
  const targetNode = remoteUsers.get(target);

  if (!targetNode) {
    signalError(
      socket,
      message,
      target,
      'offline',
      `El usuario "${target}" no está conectado en ningún nodo.`
    );
    return;
  }

  const peerSocket = getPeerSocket(targetNode);

  if (!peerSocket) {
    signalError(
      socket,
      message,
      target,
      'peer-unreachable',
      `No hay enlace activo con el nodo "${targetNode}".`
    );
    return;
  }

  const sent = sendJson(peerSocket, {
    type: 'peer-signal',
    signalType: message.type,
    originNode: NODE_NAME,
    sender,
    target,
    sdp: message.sdp,
    candidate: message.candidate,
    ts: Date.now(),
  });

  if (!sent) {
    signalError(
      socket,
      message,
      target,
      'peer-unreachable',
      `No se pudo escribir en el enlace con "${targetNode}".`
    );
    return;
  }

  log(`Señal ${message.type} de ${sender} reenviada a ${targetNode} para ${target}.`);
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
    case 'peer-signal':
      handlePeerSignal(socket, message);
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

/**
 * Reenvía offer/answer/candidate recibidos de otro nodo al usuario local.
 * Igual que peer-chat: un peer-signal NUNCA se reenvía a un tercer nodo.
 */
function handlePeerSignal(socket, message) {
  const originNode =
    typeof message.originNode === 'string' ? message.originNode : socket.__nodeId;
  const signalType = message.signalType;
  const sender = normalizeUserId(message.sender);
  const target = normalizeUserId(message.target);

  if (!SIGNAL_TYPES.has(signalType) || !sender || !target) {
    log(`peer-signal inválido de ${originNode}; se descarta.`);
    return;
  }

  if (originNode !== socket.__nodeId) {
    log(
      `peer-signal con originNode "${originNode}" no coincide con el enlace ` +
        `"${socket.__nodeId}"; se descarta.`
    );
    return;
  }

  const payload = {
    type: signalType,
    sender,
    target,
    fromNode: originNode,
    ts: Number.isFinite(message.ts) ? message.ts : Date.now(),
  };

  if (message.sdp) payload.sdp = message.sdp;
  if (message.candidate !== undefined) payload.candidate = message.candidate;

  const recipients = sendToLocalUser(target, payload);

  if (recipients === 0) {
    log(
      `peer-signal ${signalType} de ${originNode} para ${target}: ` +
        'destinatario no conectado; se descarta.'
    );
    return;
  }

  log(`peer-signal ${signalType} de ${originNode} para ${target}: entregado (${recipients}).`);

  // Importante: un peer-signal recibido de otro nodo NUNCA se reenvía.
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


rooms.setHooks({ broadcastPeerPresence });

for (const [nodeId, url] of parsePeerTargets()) {
  outboundPeers.set(nodeId, { url, socket: null, attempts: 0, timer: null });
}

function setShuttingDown(value) {
  shuttingDown = value;
}

module.exports = {
  seenPeerMessages,
  pendingAcks,
  handleClientConnection,
  handlePeerConnection,
  connectToPeer,
  setShuttingDown,
};
