'use strict';

const WS_PROTOCOL = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
const WS_URL = `${WS_PROTOCOL}//${window.location.host}`;
const RECONNECT_DELAY_MS = 2000;
const MAX_MESSAGE_LENGTH = 2000;
const MAX_USER_ID_LENGTH = 64;
const USER_ID_PATTERN = new RegExp(`^[A-Za-z0-9._-]{1,${MAX_USER_ID_LENGTH}}$`);
const USER_STORAGE_KEY = 'webrtc-messenger.userId';
const TARGET_STORAGE_KEY = 'webrtc-messenger.target';

const STATUS_LABELS = {
  connecting: 'Conectando…',
  online: 'Conectado',
  offline: 'Desconectado',
};

const REASON_LABELS = {
  'missing-target': 'falta el destinatario',
  'empty-text': 'mensaje vacío',
  offline: 'destinatario desconectado',
  'peer-unreachable': 'nodo inalcanzable',
  timeout: 'sin confirmación del nodo',
  'remote-error': 'error en el nodo remoto',
};

const elements = {
  userId: document.getElementById('user-id'),
  nodeName: document.getElementById('node-name'),
  changeUser: document.getElementById('change-user'),
  status: document.getElementById('connection-status'),
  statusLabel: document.getElementById('connection-label'),
  peerStatus: document.getElementById('peer-status'),
  peerLabel: document.getElementById('peer-label'),
  messages: document.getElementById('chat-messages'),
  emptyState: document.getElementById('chat-empty'),
  peerList: document.getElementById('peer-list'),
  form: document.getElementById('chat-form'),
  targetInput: document.getElementById('chat-target'),
  input: document.getElementById('chat-input'),
  sendButton: document.getElementById('chat-send'),
};

const timeFormatter = new Intl.DateTimeFormat('es', {
  hour: '2-digit',
  minute: '2-digit',
});

const senderId = resolveUserId();

let socket = null;
let reconnectTimer = null;
let hasConnected = false;
let offlineNotified = false;
let isUnloading = false;
let registered = false;
let directory = [];
/** messageId -> { element, statusEl, record } de los mensajes propios pendientes de ack. */
const pendingMessages = new Map();
/**
 * Conversaciones independientes por usuario.
 * clave: identificador del otro usuario
 * valor: array de { sender, text, timestamp, direction, fromNode?, messageId?, status?, tone? }
 */
const conversations = new Map();

// ------------------------------------------------------------- Utilidades

function randomToken() {
  if (window.crypto?.getRandomValues) {
    const bytes = new Uint8Array(4);
    window.crypto.getRandomValues(bytes);
    return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  }

  return Math.random().toString(36).slice(2, 10);
}

function normalizeUserId(value) {
  if (typeof value !== 'string') return null;
  const id = value.trim();
  return USER_ID_PATTERN.test(id) ? id : null;
}

function resolveUserId() {
  const params = new URLSearchParams(window.location.search);
  const fromQuery = normalizeUserId(params.get('user'));

  if (fromQuery) {
    localStorage.setItem(USER_STORAGE_KEY, fromQuery);
    return fromQuery;
  }

  const stored = normalizeUserId(localStorage.getItem(USER_STORAGE_KEY));
  if (stored) return stored;

  const generated = `cliente-${randomToken()}`;
  localStorage.setItem(USER_STORAGE_KEY, generated);
  return generated;
}

function resolveInitialTarget() {
  const params = new URLSearchParams(window.location.search);
  return (
    normalizeUserId(params.get('target')) ||
    normalizeUserId(localStorage.getItem(TARGET_STORAGE_KEY)) ||
    ''
  );
}

function createMessageId() {
  if (window.crypto?.randomUUID) return window.crypto.randomUUID();
  return `m-${Date.now()}-${randomToken()}`;
}

// ---------------------------------------------------------------- Interfaz

function setConnectionState(state) {
  elements.status.dataset.state = state;
  elements.statusLabel.textContent = STATUS_LABELS[state] ?? state;

  const isOnline = state === 'online';
  elements.input.disabled = !isOnline;
  elements.targetInput.disabled = !isOnline;
  elements.sendButton.disabled = !isOnline;
}

function removeEmptyState() {
  if (elements.emptyState?.isConnected) {
    elements.emptyState.remove();
  }
}

function scrollToBottom() {
  elements.messages.scrollTop = elements.messages.scrollHeight;
}

function addSystemMessage(text) {
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

function appendChatMessage({ sender, text, own, fromNode, status, messageId, timestamp }) {
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

function updateMessageStatus(entry, text, tone) {
  if (!entry?.statusEl) return;

  entry.statusEl.textContent = text;
  entry.statusEl.classList.toggle('message__status--ok', tone === 'ok');
  entry.statusEl.classList.toggle('message__status--error', tone === 'error');
}

function setTarget(userId) {
  elements.targetInput.value = userId;
  localStorage.setItem(TARGET_STORAGE_KEY, userId);
  elements.targetInput.dispatchEvent(new Event('change'));
  elements.input.focus();
}

/** Guarda un mensaje en el historial aislado del usuario indicado. */
function storeMessage(userId, record) {
  const history = conversations.get(userId) ?? [];
  history.push(record);
  conversations.set(userId, history);
  return record;
}

/** Muestra solo el estado vacío (sin mensajes o sin destinatario). */
function showEmptyState() {
  if (elements.emptyState && !elements.emptyState.isConnected) {
    elements.messages.append(elements.emptyState);
  }
}

/** Limpia el contenedor y renderiza únicamente el historial del destinatario activo. */
function renderConversation() {
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
    });

    if (record.tone) updateMessageStatus(entry, record.status, record.tone);

    // Reapunta los mensajes propios aún pendientes de ack a los nuevos nodos del DOM.
    if (record.messageId) {
      const pending = pendingMessages.get(record.messageId);
      if (pending) {
        pending.element = entry.element;
        pending.statusEl = entry.statusEl;
      }
    }
  }
}

function renderDirectory() {
  const others = directory.filter((user) => user.userId !== senderId);
  const previousTarget = elements.targetInput.value.trim();
  const desiredTarget =
    normalizeUserId(previousTarget) ||
    normalizeUserId(localStorage.getItem(TARGET_STORAGE_KEY)) ||
    '';

  // Solo se conserva la selección si el usuario sigue conectado.
  const activeTarget = others.some((user) => user.userId === desiredTarget)
    ? desiredTarget
    : '';

  elements.peerList.replaceChildren();
  elements.targetInput.replaceChildren();

  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = 'Selecciona un destinatario';
  elements.targetInput.append(placeholder);

  if (others.length === 0) {
    const empty = document.createElement('span');
    empty.className = 'peer-list__empty';
    empty.textContent = 'No hay otros usuarios conectados.';
    elements.peerList.append(empty);
  }

  for (const user of others) {
    const option = document.createElement('option');
    option.value = user.userId;
    option.textContent = `${user.userId} (${user.node})`;
    elements.targetInput.append(option);

    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'peer-chip';
    chip.dataset.userId = user.userId;
    chip.setAttribute('aria-pressed', String(user.userId === activeTarget));
    chip.title = `Enviar a ${user.userId} (nodo ${user.node})`;

    const name = document.createElement('span');
    name.textContent = user.userId;

    const node = document.createElement('span');
    node.className = 'peer-chip__node';
    node.textContent = user.node;

    chip.append(name, node);
    chip.addEventListener('click', () => setTarget(user.userId));

    elements.peerList.append(chip);
  }

  if (elements.targetInput.value !== activeTarget) {
    elements.targetInput.value = activeTarget;
  }

  if (previousTarget !== activeTarget) {
    renderConversation();
  }
}

function renderPeerStatus(peers) {
  const connected = Array.isArray(peers) ? peers : [];

  elements.peerStatus.dataset.state = connected.length > 0 ? 'connected' : 'local';
  elements.peerLabel.textContent =
    connected.length > 0 ? `Enlaces: ${connected.join(', ')}` : 'Sin enlaces';
}

// ------------------------------------------------------- Mensajes del servidor

function onWelcome(message) {
  registered = true;
  elements.nodeName.textContent = message.node || '…';
  setConnectionState('online');
  onPresence(message);

  addSystemMessage(
    hasConnected
      ? `Sesión restablecida como ${message.userId} en ${message.node}.`
      : `Conectado como ${message.userId} en ${message.node}.`
  );

  hasConnected = true;
  offlineNotified = false;
  elements.input.focus();
}

function onPresence(message) {
  directory = Array.isArray(message.users) ? message.users : [];
  renderDirectory();
  renderPeerStatus(message.peers);
}

function onChat(message) {
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

function onChatAck(message) {
  const entry = pendingMessages.get(message.messageId);
  if (!entry) return;

  pendingMessages.delete(message.messageId);
  const statusText = `entregado · ${message.targetNode}`;
  updateMessageStatus(entry, statusText, 'ok');

  if (entry.record) {
    entry.record.status = statusText;
    entry.record.tone = 'ok';
  }
}

function onChatError(message) {
  const reason = REASON_LABELS[message.reason] || message.reason || 'error';
  const entry = pendingMessages.get(message.messageId);

  if (entry) {
    pendingMessages.delete(message.messageId);
    const statusText = `no entregado · ${reason}`;
    updateMessageStatus(entry, statusText, 'error');

    if (entry.record) {
      entry.record.status = statusText;
      entry.record.tone = 'error';
    }
  }

  addSystemMessage(
    message.detail
      ? `No se pudo entregar: ${message.detail}`
      : `No se pudo entregar a ${message.target ?? 'el destinatario'} (${reason}).`
  );
}

function handleIncomingMessage(raw) {
  if (typeof raw !== 'string') return;

  let message;
  try {
    message = JSON.parse(raw);
  } catch {
    return;
  }

  if (!message || typeof message !== 'object') return;

  switch (message.type) {
    case 'welcome':
      onWelcome(message);
      break;
    case 'presence':
      onPresence(message);
      break;
    case 'chat':
      onChat(message);
      break;
    case 'chat-ack':
      onChatAck(message);
      break;
    case 'chat-error':
      onChatError(message);
      break;
    case 'error':
      addSystemMessage(`Error del servidor: ${message.detail || message.code}`);
      break;
    default:
      break;
  }
}

// ------------------------------------------------------------- Conexión WS

function connect() {
  window.clearTimeout(reconnectTimer);
  reconnectTimer = null;
  setConnectionState('connecting');

  socket = new WebSocket(WS_URL);

  socket.addEventListener('open', () => {
    registered = false;
    socket.send(JSON.stringify({ type: 'register', userId: senderId }));
  });

  socket.addEventListener('message', (event) => {
    handleIncomingMessage(event.data);
  });

  socket.addEventListener('close', () => {
    registered = false;

    if (isUnloading) return;

    setConnectionState('offline');

    directory = [];
    renderDirectory();
    renderPeerStatus([]);

    if (!offlineNotified) {
      addSystemMessage('Sin conexión con el servidor. Reintentando…');
      offlineNotified = true;
    }

    reconnectTimer = window.setTimeout(connect, RECONNECT_DELAY_MS);
  });

  socket.addEventListener('error', () => {
    if (!isUnloading) {
      setConnectionState('offline');
    }
  });
}

// ----------------------------------------------------------------- Eventos

elements.userId.textContent = senderId;

const initialTarget = resolveInitialTarget();
elements.targetInput.value = initialTarget;
if (initialTarget) {
  localStorage.setItem(TARGET_STORAGE_KEY, initialTarget);
}

elements.targetInput.addEventListener('change', () => {
  const currentTarget = elements.targetInput.value.trim();
  localStorage.setItem(TARGET_STORAGE_KEY, currentTarget);

  for (const chip of elements.peerList.querySelectorAll('.peer-chip')) {
    chip.setAttribute('aria-pressed', String(chip.dataset.userId === currentTarget));
  }

  renderConversation();
});

elements.changeUser.addEventListener('click', () => {
  const next = window.prompt('Nuevo identificador de usuario', senderId);
  if (next === null) return;

  const normalized = normalizeUserId(next);

  if (!normalized) {
    window.alert(
      'Usa solo letras, números, punto, guion o guion bajo (máximo ' +
        `${MAX_USER_ID_LENGTH} caracteres).`
    );
    return;
  }

  localStorage.setItem(USER_STORAGE_KEY, normalized);
  window.location.reload();
});

elements.form.addEventListener('submit', (event) => {
  event.preventDefault();

  const text = elements.input.value.trim();
  const target = normalizeUserId(elements.targetInput.value);

  if (!text) return;

  if (!registered || !socket || socket.readyState !== WebSocket.OPEN) {
    addSystemMessage('Sin conexión con el servidor. Espera a que se restablezca.');
    return;
  }

  if (!target) {
    addSystemMessage('Indica un destinatario válido (letras, números, ".", "_" o "-").');
    elements.targetInput.focus();
    return;
  }

  if (target === senderId) {
    addSystemMessage('Escribe el identificador de otro usuario, no el tuyo.');
    elements.targetInput.focus();
    return;
  }

  const safeText = text.slice(0, MAX_MESSAGE_LENGTH);
  const messageId = createMessageId();
  const timestamp = Date.now();

  socket.send(
    JSON.stringify({
      type: 'chat',
      messageId,
      sender: senderId,
      target,
      text: safeText,
    })
  );

  const record = storeMessage(target, {
    sender: senderId,
    text: safeText,
    timestamp,
    direction: 'outgoing',
    messageId,
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
  localStorage.setItem(TARGET_STORAGE_KEY, target);

  elements.input.value = '';
  elements.input.focus();
});

window.addEventListener('beforeunload', () => {
  isUnloading = true;
  window.clearTimeout(reconnectTimer);
  socket?.close();
});

renderDirectory();
connect();
