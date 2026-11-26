'use strict';

const WS_PROTOCOL = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
const WS_URL = `${WS_PROTOCOL}//${window.location.host}`;
const RECONNECT_DELAY_MS = 2000;
const MAX_MESSAGE_LENGTH = 2000;

const STATUS_LABELS = {
  connecting: 'Conectando…',
  online: 'Conectado',
  offline: 'Desconectado',
};

const elements = {
  userId: document.getElementById('user-id'),
  status: document.getElementById('connection-status'),
  statusLabel: document.getElementById('connection-label'),
  messages: document.getElementById('chat-messages'),
  emptyState: document.getElementById('chat-empty'),
  form: document.getElementById('chat-form'),
  input: document.getElementById('chat-input'),
  sendButton: document.getElementById('chat-send'),
};

const timeFormatter = new Intl.DateTimeFormat('es', {
  hour: '2-digit',
  minute: '2-digit',
});

const senderId = createSenderId();

let socket = null;
let reconnectTimer = null;
let hasConnected = false;
let offlineNotified = false;
let isUnloading = false;

function createSenderId() {
  if (window.crypto?.randomUUID) {
    return `cliente-${window.crypto.randomUUID().slice(0, 8)}`;
  }

  return `cliente-${Math.random().toString(36).slice(2, 10)}`;
}

function setConnectionState(state) {
  elements.status.dataset.state = state;
  elements.statusLabel.textContent = STATUS_LABELS[state] ?? state;

  const isOnline = state === 'online';
  elements.input.disabled = !isOnline;
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

function appendChatMessage({ sender, text, own }) {
  removeEmptyState();

  const message = document.createElement('article');
  message.className = `message ${own ? 'message--own' : 'message--remote'}`;

  const meta = document.createElement('div');
  meta.className = 'message__meta';

  const author = document.createElement('span');
  author.className = 'message__author';
  author.textContent = own ? 'Tú' : sender;

  const time = document.createElement('time');
  const now = new Date();
  time.dateTime = now.toISOString();
  time.textContent = timeFormatter.format(now);

  meta.append(author, time);

  const bubble = document.createElement('p');
  bubble.className = 'message__text';
  bubble.textContent = text;

  message.append(meta, bubble);
  elements.messages.append(message);
  scrollToBottom();
}

function handleIncomingMessage(raw) {
  if (typeof raw !== 'string') {
    return;
  }

  let message;
  try {
    message = JSON.parse(raw);
  } catch {
    return;
  }

  if (!message || message.type !== 'chat') {
    return;
  }

  const text = typeof message.text === 'string' ? message.text.trim() : '';
  if (!text) {
    return;
  }

  const sender =
    typeof message.sender === 'string' && message.sender.trim()
      ? message.sender.trim()
      : 'anónimo';

  // El servidor difunde a los demás clientes; esta comprobación evita
  // duplicar el mensaje si en el futuro también se enviara al emisor.
  if (sender === senderId) {
    return;
  }

  appendChatMessage({
    sender,
    text: text.slice(0, MAX_MESSAGE_LENGTH),
    own: false,
  });
}

function connect() {
  window.clearTimeout(reconnectTimer);
  reconnectTimer = null;
  setConnectionState('connecting');

  socket = new WebSocket(WS_URL);

  socket.addEventListener('open', () => {
    setConnectionState('online');
    addSystemMessage(
      hasConnected ? 'Conexión restablecida.' : `Conectado como ${senderId}.`
    );
    hasConnected = true;
    offlineNotified = false;
    elements.input.focus();
  });

  socket.addEventListener('message', (event) => {
    handleIncomingMessage(event.data);
  });

  socket.addEventListener('close', () => {
    if (isUnloading) {
      return;
    }

    setConnectionState('offline');

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

elements.userId.textContent = senderId;

elements.form.addEventListener('submit', (event) => {
  event.preventDefault();

  const text = elements.input.value.trim();
  if (!text) {
    return;
  }

  if (!socket || socket.readyState !== WebSocket.OPEN) {
    addSystemMessage('Sin conexión con el servidor. Espera a que se restablezca.');
    return;
  }

  const safeText = text.slice(0, MAX_MESSAGE_LENGTH);

  socket.send(
    JSON.stringify({
      type: 'chat',
      sender: senderId,
      text: safeText,
    })
  );

  appendChatMessage({ sender: senderId, text: safeText, own: true });
  elements.input.value = '';
  elements.input.focus();
});

window.addEventListener('beforeunload', () => {
  isUnloading = true;
  window.clearTimeout(reconnectTimer);
  socket?.close();
});

connect();
