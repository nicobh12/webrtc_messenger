'use strict';

import { P2P_OPEN_TIMEOUT_MS, logP2P, waitForDataChannel } from './webrtc.js';

export const CONVERSATIONS_STORAGE_KEY = 'webrtc-messenger.conversations';
const MAX_MESSAGE_LENGTH = 2000;

const REASON_LABELS = {
  'missing-target': 'falta el destinatario',
  'empty-text': 'mensaje vacío',
  offline: 'destinatario desconectado',
  'peer-unreachable': 'nodo inalcanzable',
  timeout: 'sin confirmación del nodo',
  'remote-error': 'error en el nodo remoto',
  'invalid-targets': 'destinatarios inválidos',
};
const timeFormatter = new Intl.DateTimeFormat('es', {
  hour: '2-digit',
  minute: '2-digit',
});

let elements;
let senderId;
let getSocket;
let isRegistered;
let normalizeUserId;

export function configureChat(options) {
  elements = options.elements;
  senderId = options.senderId;
  getSocket = options.getSocket;
  isRegistered = options.isRegistered;
  normalizeUserId = options.normalizeUserId;
}

export function randomToken() {
  if (window.crypto?.getRandomValues) {
    const bytes = new Uint8Array(4);
    window.crypto.getRandomValues(bytes);
    return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  }

  return Math.random().toString(36).slice(2, 10);
}
export function createMessageId() {
  if (window.crypto?.randomUUID) return window.crypto.randomUUID();
  return `m-${Date.now()}-${randomToken()}`;
}

export const pendingMessages = new Map();
export const conversations = new Map();

export function readStorage(key) {
  try {
    return localStorage.getItem(key);
  } catch (error) {
    console.warn(`No se pudo leer localStorage (${key}):`, error);
    return null;
  }
}

export function writeStorage(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch (error) {
    console.warn(`No se pudo escribir localStorage (${key}):`, error);
  }
}

function removeStorage(key) {
  try {
    localStorage.removeItem(key);
  } catch (error) {
    console.warn(`No se pudo borrar localStorage (${key}):`, error);
  }
}

function persistConversations() {
  try {
    const serialized = JSON.stringify(
      [...conversations].map(([userId, history]) => [userId, history.slice(-500)])
    );
    writeStorage(CONVERSATIONS_STORAGE_KEY, serialized);
  } catch (error) {
    console.warn('No se pudo serializar el historial de conversaciones:', error);
  }
}

export function loadConversations() {
  const serialized = readStorage(CONVERSATIONS_STORAGE_KEY);
  if (!serialized) return;

  try {
    const savedConversations = JSON.parse(serialized);
    if (!Array.isArray(savedConversations)) {
      throw new TypeError('El historial guardado no tiene el formato esperado.');
    }

    const loadedConversations = new Map();
    let needsPersist = false;

    for (const entry of savedConversations) {
      if (
        !Array.isArray(entry) ||
        typeof entry[0] !== 'string' ||
        !Array.isArray(entry[1])
      ) {
        throw new TypeError('Una conversación guardada no tiene el formato esperado.');
      }

      const history = entry[1].slice(-500);
      if (history.length !== entry[1].length) needsPersist = true;

      for (const record of history) {
        if (!record || typeof record !== 'object' || Array.isArray(record)) {
          throw new TypeError('Un mensaje guardado no tiene el formato esperado.');
        }

        if (record.transport === 'pending') {
          record.transport = 'failed';
          record.status = 'no entregado · recarga';
          record.tone = 'error';
          needsPersist = true;
        }
      }

      loadedConversations.set(entry[0], history);
    }

    conversations.clear();
    for (const [userId, history] of loadedConversations) {
      conversations.set(userId, history);
    }

    if (needsPersist) persistConversations();
  } catch (error) {
    conversations.clear();
    console.warn('No se pudo cargar el historial de conversaciones:', error);
  }
}

export function clearHistory() {
  removeStorage(CONVERSATIONS_STORAGE_KEY);
  conversations.clear();
  renderConversation();
}

export function removeEmptyState() {
  if (elements.emptyState?.isConnected) {
    elements.emptyState.remove();
  }
}

export function scrollToBottom() {
  elements.messages.scrollTop = elements.messages.scrollHeight;
}

export function addSystemMessage(text) {
  removeEmptyState();

  const message = document.createElement('p');
  message.className = 'message message--system';

  const bubble = document.createElement('span');
  bubble.className = 'message__text';
  bubble.textContent = text;

  message.append(bubble);
  elements.messages.append(message);
  scrollToBottom();
}

export function appendChatMessage({
  sender,
  text,
  own,
  fromNode,
  status,
  messageId,
  timestamp,
  targets,
}) {
  removeEmptyState();

  const message = document.createElement('article');
  message.className = `message ${own ? 'message--own' : 'message--remote'}`;
  if (messageId) message.dataset.messageId = messageId;

  const meta = document.createElement('div');
  meta.className = 'message__meta';

  const author = document.createElement('span');
  author.className = 'message__author';
  author.textContent = own ? 'Tú' : sender;

  meta.append(author);

  if (fromNode) {
    const via = document.createElement('span');
    via.className = 'message__via';
    via.textContent = `· ${fromNode}`;
    meta.append(via);
  }

  if (own && Array.isArray(targets) && targets.length > 1) {
    const recipients = document.createElement('span');
    recipients.className = 'message__recipients';
    recipients.textContent = `para: ${targets.join(', ')}`;
    meta.append(recipients);
  }

  const time = document.createElement('time');
  const now = typeof timestamp === 'number' ? new Date(timestamp) : new Date();
  time.dateTime = now.toISOString();
  time.textContent = timeFormatter.format(now);

  meta.append(time);

  const bubble = document.createElement('p');
  bubble.className = 'message__text';
  bubble.textContent = text;

  message.append(meta, bubble);

  let statusEl = null;

  if (own) {
    statusEl = document.createElement('span');
    statusEl.className = 'message__status';
    statusEl.textContent = status || 'enviando…';
    message.append(statusEl);
  }

  elements.messages.append(message);
  scrollToBottom();

  return { element: message, statusEl };
}

export function updateMessageStatus(entry, text, tone) {
  if (!entry?.statusEl) return;

  entry.statusEl.textContent = text;
  entry.statusEl.classList.toggle('message__status--ok', tone === 'ok');
  entry.statusEl.classList.toggle('message__status--error', tone === 'error');
  entry.statusEl.classList.toggle('message__status--warn', tone === 'warn');
}

/** Guarda un mensaje en el historial aislado del usuario indicado. */
export function storeMessage(userId, record) {
  const history = conversations.get(userId) ?? [];
  history.push(record);
  conversations.set(userId, history);
  persistConversations();
  return record;
}

/** Muestra solo el estado vacío (sin mensajes o sin destinatario). */
export function showEmptyState() {
  if (elements.emptyState && !elements.emptyState.isConnected) {
    elements.messages.append(elements.emptyState);
  }
}

/** Limpia el contenedor y renderiza únicamente el historial del destinatario activo. */
export function renderConversation() {
  const target = elements.targetInput.value.trim();
  const history = target ? conversations.get(target) : null;

  elements.messages.replaceChildren();

  if (!history || history.length === 0) {
    showEmptyState();
    return;
  }

  for (const record of history) {
    const entry = appendChatMessage({
      sender: record.sender,
      text: record.text,
      own: record.direction === 'outgoing',
      fromNode: record.fromNode,
      status: record.status,
      messageId: record.messageId,
      timestamp: record.timestamp,
      targets: record.targets,
    });

    if (record.tone) updateMessageStatus(entry, record.status, record.tone);

    // Reapunta los mensajes propios aún pendientes de ack a los nuevos nodos del DOM.
    if (record.messageId) {
      const pending = pendingMessages.get(record.messageId);
      if (pending) {
        if (pending.kind === 'multicast') {
          pending.entries.set(target, entry);
        } else {
          pending.element = entry.element;
          pending.statusEl = entry.statusEl;
        }
      }
    }
  }
}

export function markMessageSent(entry, record, text, tone) {
  if (entry) updateMessageStatus(entry, text, tone);
  if (record) {
    record.status = text;
    record.tone = tone;
    persistConversations();
  }
}

/** Fallback: el chat sale por WebSocket como en la Fase 4. */
export function fallbackToWebSocket(target, text, messageId, entry, record) {
  const socket = getSocket();
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    pendingMessages.delete(messageId);
    record.transport = 'failed';
    markMessageSent(entry, record, 'no entregado · sin conexión WebSocket', 'error');
    addSystemMessage('Sin conexión con el servidor. Espera a que se restablezca.');
    return;
  }

  record.transport = 'fallback';
  markMessageSent(entry, record, 'enviado por WebSocket (fallback)', 'warn');

  try {
    socket.send(
      JSON.stringify({
        type: 'chat',
        messageId,
        sender: senderId,
        target,
        text,
      })
    );
  } catch (error) {
    pendingMessages.delete(messageId);
    record.transport = 'failed';
    markMessageSent(entry, record, 'no entregado · error de WebSocket', 'error');
    logP2P(`Fallo al enviar el chat ${messageId} por WebSocket: ${error.message}`);
    return;
  }

  logP2P(`chat ${messageId} enviado por WebSocket (fallback) a ${target}.`);
}

// ------------------------------------------------------- Mensajes del servidor

export function onChat(message) {
  const text = typeof message.text === 'string' ? message.text.trim() : '';
  if (!text) return;

  const sender =
    typeof message.sender === 'string' && message.sender.trim()
      ? message.sender.trim()
      : 'anónimo';

  // Eco del propio mensaje (mismo usuario en otra pestaña): no duplicar.
  if (message.messageId && pendingMessages.has(message.messageId)) return;

  const currentNode = elements.nodeName.textContent;
  const fromNode =
    typeof message.fromNode === 'string' && message.fromNode !== currentNode
      ? message.fromNode
      : null;

  const safeText = text.slice(0, MAX_MESSAGE_LENGTH);

  // Se guarda SIEMPRE en el historial aislado del remitente (aunque no sea el chat activo).
  const record = storeMessage(sender, {
    sender,
    text: safeText,
    timestamp: typeof message.ts === 'number' ? message.ts : Date.now(),
    direction: 'incoming',
    fromNode,
    messageId: typeof message.messageId === 'string' ? message.messageId : null,
    targets: Array.isArray(message.targets) ? message.targets : undefined,
  });

  // Solo se pinta en el DOM si el remitente coincide con el destinatario seleccionado.
  if (elements.targetInput.value.trim() === sender) {
    appendChatMessage({
      sender,
      text: record.text,
      own: false,
      fromNode,
      messageId: record.messageId,
      timestamp: record.timestamp,
    });
  }
}

export function onChatAck(message) {
  const entry = pendingMessages.get(message.messageId);
  if (!entry || entry.kind === 'multicast') return;

  pendingMessages.delete(message.messageId);
  const fallbackSuffix = entry.record?.transport === 'fallback' ? ' (fallback)' : '';
  const statusText = `entregado · ${message.targetNode}${fallbackSuffix}`;
  updateMessageStatus(entry, statusText, 'ok');

  if (entry.record) {
    entry.record.status = statusText;
    entry.record.tone = 'ok';
    persistConversations();
  }
}

export function onChatError(message) {
  const reason = REASON_LABELS[message.reason] || message.reason || 'error';
  const entry = pendingMessages.get(message.messageId);

  if (entry) {
    pendingMessages.delete(message.messageId);
    const fallbackSuffix = entry.record?.transport === 'fallback' ? ' (fallback)' : '';
    const statusText = `no entregado · ${reason}${fallbackSuffix}`;
    updateMessageStatus(entry, statusText, 'error');

    if (entry.record) {
      entry.record.status = statusText;
      entry.record.tone = 'error';
      persistConversations();
    }
  }

  addSystemMessage(
    message.detail
      ? `No se pudo entregar: ${message.detail}`
      : `No se pudo entregar a ${message.target ?? 'el destinatario'} (${reason}).`
  );
}

export async function sendMessage({ text, targets }) {
  const socket = getSocket();
  const messageText = typeof text === 'string' ? text.trim() : '';

  if (!messageText) return;

  if (!isRegistered() || !socket || socket.readyState !== WebSocket.OPEN) {
    addSystemMessage('Sin conexión con el servidor. Espera a que se restablezca.');
    return;
  }

  const normalizedTargets = Array.isArray(targets)
    ? targets.map((target) => normalizeUserId(target))
    : [];
  if (normalizedTargets.length === 0) {
    addSystemMessage('Selecciona un destinatario.');
    return;
  }

  if (
    normalizedTargets.some((target) => !target || target === senderId) ||
    new Set(normalizedTargets).size !== normalizedTargets.length
  ) {
    addSystemMessage('Selecciona destinatarios válidos y distintos a tu usuario.');
    return;
  }

  const safeText = messageText.slice(0, MAX_MESSAGE_LENGTH);
  const messageId = createMessageId();
  const timestamp = Date.now();

  if (normalizedTargets.length > 1) {
    await sendMulticastMessage(
      socket,
      safeText,
      normalizedTargets,
      messageId,
      timestamp
    );
    return;
  }

  const target = normalizedTargets[0];
  const record = storeMessage(target, {
    sender: senderId,
    text: safeText,
    timestamp,
    direction: 'outgoing',
    messageId,
    transport: 'pending',
  });

  const entry = appendChatMessage({
    sender: senderId,
    text: safeText,
    own: true,
    status: 'enviando…',
    messageId,
    timestamp,
  });

  pendingMessages.set(messageId, { ...entry, record });

  elements.input.value = '';
  elements.input.focus();

  // 1) Se intenta el RTCDataChannel (P2P). 2) Si no abre en 10 s, fallback WebSocket.
  let channel = null;

  try {
    channel = await waitForDataChannel(target, P2P_OPEN_TIMEOUT_MS);
  } catch (error) {
    logP2P(`No se pudo preparar el DataChannel con ${target}: ${error.message}`);
  }

  if (channel && channel.readyState === 'open') {
    try {
      channel.send(JSON.stringify({ messageId, sender: senderId, text: safeText, timestamp }));

      pendingMessages.delete(messageId);
      record.transport = 'datachannel';
      markMessageSent(entry, record, 'enviado por RTCDataChannel', 'ok');
      logP2P(`chat ${messageId} enviado por RTCDataChannel a ${target}.`);
      return;
    } catch (error) {
      logP2P(`Fallo al enviar por RTCDataChannel (${error.message}); se usa WebSocket.`);
    }
  } else {
    logP2P(`Sin DataChannel abierto con ${target}; se usa WebSocket (fallback).`);
  }

  fallbackToWebSocket(target, safeText, messageId, entry, record);
}

function updateMulticastStatus(pending) {
  const complete = pending.targets.every((target) => pending.results.has(target));
  const deliveredTargets = pending.targets.filter(
    (target) => pending.results.get(target)?.status === 'delivered'
  );
  const failedTargets = complete
    ? pending.targets.filter((target) => pending.results.get(target)?.status !== 'delivered')
    : [];
  const websocketCount = deliveredTargets.filter((target) =>
    pending.fallbackTargets.has(target)
  ).length;

  let status;
  let tone;

  if (complete && failedTargets.length === 0 && websocketCount === 0) {
    status = `enviado por RTCDataChannel a ${pending.targets.length}/${pending.targets.length}`;
    tone = 'ok';
  } else if (complete) {
    status = `entregado a ${deliveredTargets.length}/${pending.targets.length}`;
    if (websocketCount > 0) status += ` (${websocketCount} por WebSocket)`;
    if (failedTargets.length > 0) {
      status += ` · fallo con ${failedTargets.join(', ')}`;
    }
    tone = failedTargets.length > 0 ? 'error' : 'ok';
  } else {
    const rtcCount = pending.targets.filter(
      (target) => pending.results.get(target)?.transport === 'rtcdatachannel'
    ).length;
    status = `enviando · RTCDataChannel ${rtcCount}/${pending.targets.length}`;
    tone = 'warn';
  }

  for (const record of pending.records.values()) {
    record.status = status;
    record.tone = tone;
  }
  for (const entry of pending.entries.values()) {
    updateMessageStatus(entry, status, tone);
  }
  persistConversations();

  if (complete) pendingMessages.delete(pending.messageId);
}

async function sendMulticastMessage(socket, text, targets, messageId, timestamp) {
  const records = new Map();
  for (const target of targets) {
    records.set(
      target,
      storeMessage(target, {
        sender: senderId,
        text,
        timestamp,
        direction: 'outgoing',
        messageId,
        transport: 'pending',
        targets: [...targets],
      })
    );
  }

  const activeTarget = elements.targetInput.value.trim();
  const displayTarget = targets.includes(activeTarget) ? activeTarget : targets[0];
  const entry = appendChatMessage({
    sender: senderId,
    text,
    own: true,
    status: 'enviando…',
    messageId,
    timestamp,
    targets,
  });
  const pending = {
    kind: 'multicast',
    messageId,
    targets,
    records,
    entries: new Map([[displayTarget, entry]]),
    results: new Map(),
    fallbackTargets: new Set(),
  };
  pendingMessages.set(messageId, pending);

  elements.input.value = '';
  elements.input.focus();

  const failedTargets = [];
  for (const target of targets) {
    const record = records.get(target);
    let channel = null;

    try {
      channel = await waitForDataChannel(target, P2P_OPEN_TIMEOUT_MS);
    } catch (error) {
      logP2P(`No se pudo preparar el DataChannel con ${target}: ${error.message}`);
    }

    if (channel && channel.readyState === 'open') {
      try {
        channel.send(
          JSON.stringify({
            messageId,
            sender: senderId,
            text,
            timestamp,
            targets,
          })
        );
        record.transport = 'datachannel';
        pending.results.set(target, {
          target,
          status: 'delivered',
          transport: 'rtcdatachannel',
        });
        updateMulticastStatus(pending);
        logP2P(`chat ${messageId} enviado por RTCDataChannel a ${target}.`);
        continue;
      } catch (error) {
        logP2P(`Fallo al enviar por RTCDataChannel a ${target} (${error.message}); se usa WebSocket.`);
      }
    } else {
      logP2P(`Sin DataChannel abierto con ${target}; se usa WebSocket (fallback).`);
    }

    record.transport = 'fallback';
    failedTargets.push(target);
    pending.fallbackTargets.add(target);
  }

  persistConversations();

  if (failedTargets.length === 0) {
    updateMulticastStatus(pending);
    return;
  }

  if (socket.readyState !== WebSocket.OPEN) {
    for (const target of failedTargets) {
      records.get(target).transport = 'failed';
      pending.results.set(target, { target, status: 'failed', reason: 'websocket-offline' });
    }
    updateMulticastStatus(pending);
    addSystemMessage('Sin conexión con el servidor. Espera a que se restablezca.');
    return;
  }

  try {
    socket.send(
      JSON.stringify({
        type: 'chat-multicast',
        messageId,
        sender: senderId,
        targets: failedTargets,
        text,
      })
    );
  } catch (error) {
    for (const target of failedTargets) {
      records.get(target).transport = 'failed';
      pending.results.set(target, { target, status: 'failed', reason: 'websocket-error' });
    }
    updateMulticastStatus(pending);
    logP2P(`Fallo al enviar el chat ${messageId} por WebSocket: ${error.message}`);
  }
}

export function onChatMulticastAck(message) {
  const pending = pendingMessages.get(message.messageId);
  if (!pending || pending.kind !== 'multicast') return;

  const results = Array.isArray(message.results) ? message.results : [];
  const unresolvedFallbackTargets = pending.targets.filter(
    (target) => pending.fallbackTargets.has(target) && !pending.results.has(target)
  );
  let matchedResult = false;

  for (const result of results) {
    const target = normalizeUserId(result?.target);
    if (!target || !pending.fallbackTargets.has(target)) continue;

    const delivered = result.status === 'delivered';
    pending.results.set(target, {
      target,
      status: delivered ? 'delivered' : 'failed',
      reason: result.reason,
      transport: 'websocket',
    });
    if (!delivered) pending.records.get(target).transport = 'failed';
    matchedResult = true;
  }

  if (!matchedResult && results.some((result) => result?.status === 'invalid')) {
    for (const target of unresolvedFallbackTargets) {
      pending.results.set(target, {
        target,
        status: 'failed',
        reason: 'invalid-targets',
        transport: 'websocket',
      });
      pending.records.get(target).transport = 'failed';
    }
  } else {
    for (const target of unresolvedFallbackTargets) {
      if (pending.results.has(target)) continue;
      pending.results.set(target, {
        target,
        status: 'failed',
        reason: 'remote-error',
        transport: 'websocket',
      });
      pending.records.get(target).transport = 'failed';
    }
  }

  updateMulticastStatus(pending);
}
