'use strict';

import { ICE_SERVERS, configureSignaling, onSignal, onSignalError, sendSignal } from './signaling.js';
import {
  P2P_STATE_LABELS,
  clearLastDisconnectedPeer,
  closeAllPeerConnections,
  configureWebRTC,
  lastDisconnectedPeer,
  logP2P,
  p2pStates,
  preparePeerForTarget,
  reconcilePeerConnections,
  renderActiveP2PState,
} from './webrtc.js';
import {
  TARGET_STORAGE_KEY,
  addSystemMessage,
  configureChat,
  onChat,
  onChatAck,
  onChatError,
  randomToken,
  renderConversation,
  sendMessage,
  setTarget,
} from './chat.js';

const WS_PROTOCOL = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
const WS_URL = `${WS_PROTOCOL}//${window.location.host}`;
const RECONNECT_DELAY_MS = 2000;
const MAX_USER_ID_LENGTH = 64;
const USER_ID_PATTERN = new RegExp(`^[A-Za-z0-9._-]{1,${MAX_USER_ID_LENGTH}}$`);
const USER_STORAGE_KEY = 'webrtc-messenger.userId';

const STATUS_LABELS = {
  connecting: 'Conectando…',
  online: 'Conectado',
  offline: 'Desconectado',
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
  p2pState: document.getElementById('p2p-state'),
  p2pStateLabel: document.getElementById('p2p-state-label'),
};

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


const senderId = resolveUserId();
let socket = null;
let reconnectTimer = null;
let hasConnected = false;
let offlineNotified = false;
let isUnloading = false;
let registered = false;
let directory = [];

function setConnectionState(state) {
  elements.status.dataset.state = state;
  elements.statusLabel.textContent = STATUS_LABELS[state] ?? state;

  const isOnline = state === 'online';
  elements.input.disabled = !isOnline;
  elements.targetInput.disabled = !isOnline;
  elements.sendButton.disabled = !isOnline;
}

function renderDirectory() {
  const others = directory.filter((user) => user.userId !== senderId);

  // Si el par desconectado vuelve a estar presente, se limpia el aviso.
  if (lastDisconnectedPeer && others.some((user) => user.userId === lastDisconnectedPeer)) {
    clearLastDisconnectedPeer();
  }

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

    const p2pDot = document.createElement('span');
    const dotState = p2pStates.get(user.userId) ?? 'new';
    p2pDot.className = 'p2p-dot';
    p2pDot.dataset.state = dotState;
    p2pDot.title = P2P_STATE_LABELS[dotState] ?? dotState;

    chip.append(name, node, p2pDot);
    chip.addEventListener('click', () => setTarget(user.userId));

    elements.peerList.append(chip);
  }

  if (elements.targetInput.value !== activeTarget) {
    elements.targetInput.value = activeTarget;
  }

  renderActiveP2PState();

  if (previousTarget !== activeTarget) {
    renderConversation();
  }

  preparePeerForTarget(activeTarget);
}

function renderPeerStatus(peers) {
  const connected = Array.isArray(peers) ? peers : [];

  elements.peerStatus.dataset.state = connected.length > 0 ? 'connected' : 'local';
  elements.peerLabel.textContent =
    connected.length > 0 ? `Enlaces: ${connected.join(', ')}` : 'Sin enlaces';
}

// ------------------------------------------------------------- WebRTC P2P

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
  reconcilePeerConnections();
  renderDirectory();
  renderPeerStatus(message.peers);
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
    case 'offer':
    case 'answer':
    case 'candidate':
      onSignal(message).catch((error) => {
        logP2P(`Señal ${message.type} fallida: ${error.message}`);
      });
      break;
    case 'signal-error':
      onSignalError(message);
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

    // Sin WebSocket no hay señalización: se cierran y limpian todas las pc.
    closeAllPeerConnections();

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


configureSignaling({ senderId, getSocket: () => socket, normalizeUserId });
configureWebRTC({
  elements,
  senderId,
  iceServers: ICE_SERVERS,
  getSocket: () => socket,
  isRegistered: () => registered,
  getDirectory: () => directory,
  sendSignal,
  onChat,
});
configureChat({
  elements,
  senderId,
  getSocket: () => socket,
  isRegistered: () => registered,
  normalizeUserId,
});

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
  renderActiveP2PState();
  preparePeerForTarget(currentTarget);
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

elements.form.addEventListener('submit', sendMessage);

window.addEventListener('beforeunload', () => {
  isUnloading = true;
  window.clearTimeout(reconnectTimer);
  closeAllPeerConnections();
  socket?.close();
});

renderDirectory();
connect();
