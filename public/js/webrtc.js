'use strict';

export const DATA_CHANNEL_LABEL = 'chat';
export const P2P_OPEN_TIMEOUT_MS = 10000;

export const P2P_STATE_LABELS = {
  idle: 'P2P: sin destinatario',
  new: 'P2P: sin conectar',
  connecting: 'P2P: conectando…',
  connected: 'P2P: conectado',
  failed: 'P2P: fallido',
  disconnected: 'P2P: desconectado',
};

let elements;
let senderId;
let iceServers;
let getSocket;
let isRegistered;
let getDirectory;
let sendSignal;
let onChat;

export function configureWebRTC(options) {
  elements = options.elements;
  senderId = options.senderId;
  iceServers = options.iceServers;
  getSocket = options.getSocket;
  isRegistered = options.isRegistered;
  getDirectory = options.getDirectory;
  sendSignal = options.sendSignal;
  onChat = options.onChat;
}

export function logP2P(...args) {
  console.log('[p2p]', ...args);
}

export const peerConnections = new Map();
/** userId -> RTCDataChannel activo (propio o recibido; el canal es bidireccional). */
export const dataChannels = new Map();
/** userId -> candidatos ICE recibidos antes de tener remoteDescription. */
export const pendingCandidates = new Map();
/** userId -> estado P2P para la interfaz (new/connecting/connected/failed/disconnected). */
export const p2pStates = new Map();
/** userId -> { polite, makingOffer, ignoreOffer, isSettingRemoteAnswerPending, waiters }. */
export const peerMeta = new Map();
/** Último par cuya conexión P2P se perdió (para mostrarlo en el indicador). */
export let lastDisconnectedPeer = '';

export function clearLastDisconnectedPeer() {
  lastDisconnectedPeer = '';
}

export function getOpenDataChannel(target) {
  const channel = dataChannels.get(target);
  return channel && channel.readyState === 'open' ? channel : null;
}

export function setP2PState(target, state) {
  p2pStates.set(target, state);
  renderP2PIndicators(target);
}

/** Actualiza el punto del chip del directorio y el indicador del destinatario activo. */
export function renderP2PIndicators(target) {
  const state = p2pStates.get(target) ?? 'new';
  const label = P2P_STATE_LABELS[state] ?? state;

  for (const chip of elements.peerList.querySelectorAll('.peer-chip')) {
    if (chip.dataset.userId !== target) continue;

    const dot = chip.querySelector('.p2p-dot');
    if (!dot) continue;

    dot.dataset.state = state;
    dot.title = label;
  }

  if (elements.targetInput.value.trim() === target) {
    elements.p2pState.dataset.state = state;
    elements.p2pStateLabel.textContent = label;
  }
}

export function renderActiveP2PState() {
  const target = elements.targetInput.value.trim();

  if (!target) {
    if (lastDisconnectedPeer) {
      elements.p2pState.dataset.state = 'disconnected';
      elements.p2pStateLabel.textContent =
        `${P2P_STATE_LABELS.disconnected} (${lastDisconnectedPeer})`;
      return;
    }

    elements.p2pState.dataset.state = 'idle';
    elements.p2pStateLabel.textContent = P2P_STATE_LABELS.idle;
    return;
  }

  if (target !== lastDisconnectedPeer) lastDisconnectedPeer = '';

  const state = p2pStates.get(target) ?? 'new';
  elements.p2pState.dataset.state = state;
  elements.p2pStateLabel.textContent = P2P_STATE_LABELS[state] ?? state;
}

export function applyConnectionState(target, state) {
  if (state === 'connected') {
    setP2PState(target, 'connected');
    return;
  }

  if (state === 'failed') {
    setP2PState(target, 'failed');
    return;
  }

  if (state === 'disconnected' || state === 'closed') {
    setP2PState(target, 'disconnected');
    return;
  }

  setP2PState(target, 'connecting');
}

function resolveChannelWaiters(target, channel) {
  const meta = peerMeta.get(target);
  if (!meta) return;

  for (const waiter of meta.waiters.splice(0)) {
    window.clearTimeout(waiter.timer);
    waiter.resolve(channel);
  }
}

/** Enlaza un DataChannel (propio o recibido) al render y al estado P2P. */
export function bindDataChannel(target, channel, { incoming = false } = {}) {
  channel.binaryType = 'arraybuffer';

  channel.onopen = () => {
    logP2P(`DataChannel ${incoming ? 'entrante' : 'propio'} abierto con ${target}.`);

    if (!incoming || !dataChannels.has(target)) {
      dataChannels.set(target, channel);
    }

    setP2PState(target, 'connected');
    resolveChannelWaiters(target, channel);
  };

  channel.onclose = () => {
    logP2P(`DataChannel con ${target} cerrado.`);

    if (dataChannels.get(target) === channel) {
      dataChannels.delete(target);
    }

    const pc = peerConnections.get(target);
    setP2PState(target, pc && pc.connectionState === 'connected' ? 'connecting' : 'disconnected');
  };

  channel.onerror = () => {
    logP2P(`Error en el DataChannel con ${target}.`);
  };

  channel.onmessage = (event) => {
    handleDataChannelMessage(target, event.data);
  };

  if (channel.readyState === 'open') {
    if (!incoming || !dataChannels.has(target)) {
      dataChannels.set(target, channel);
    }

    setP2PState(target, 'connected');
    resolveChannelWaiters(target, channel);
  }
}

/**
 * Crea la RTCPeerConnection de un interlocutor e instala Perfect Negotiation
 * (Bloque H): el userId menor es "polite" y cede ante una colisión de ofertas.
 */
export function createPeerConnection(target) {
  const existing = peerConnections.get(target);

  if (existing) {
    if (existing.connectionState !== 'closed' && existing.connectionState !== 'failed') {
      return existing;
    }

    closePeerConnection(target);
  }

  const meta = {
    polite: senderId.localeCompare(target) < 0,
    makingOffer: false,
    ignoreOffer: false,
    isSettingRemoteAnswerPending: false,
    waiters: [],
  };
  peerMeta.set(target, meta);

  const pc = new RTCPeerConnection({ iceServers });

  pc.ontrack = () => {
    // Sin medios en esta fase: audio/video llegan en la Fase 5.
  };

  pc.onicecandidate = ({ candidate }) => {
    if (!candidate) return;
    sendSignal(target, { type: 'candidate', candidate: candidate.toJSON() });
  };

  pc.onconnectionstatechange = () => {
    logP2P(`connectionState(${target}) = ${pc.connectionState}`);
    applyConnectionState(target, pc.connectionState);
  };

  pc.onnegotiationneeded = async () => {
    try {
      meta.makingOffer = true;
      await pc.setLocalDescription();
      sendSignal(target, { type: pc.localDescription.type, sdp: pc.localDescription.toJSON() });
      logP2P(`Oferta local generada para ${target}.`);
    } catch (error) {
      logP2P(`No se pudo negociar con ${target}: ${error.message}`);
    } finally {
      meta.makingOffer = false;
    }
  };

  pc.ondatachannel = (event) => {
    logP2P(`DataChannel entrante de ${target} ("${event.channel.label}").`);
    bindDataChannel(target, event.channel, { incoming: true });
  };

  peerConnections.set(target, pc);
  setP2PState(target, 'new');

  return pc;
}

export function createLocalDataChannel(target, pc) {
  const channel = pc.createDataChannel(DATA_CHANNEL_LABEL, { ordered: true });
  // Se registra de inmediato para no crear un segundo canal mientras abre.
  dataChannels.set(target, channel);
  bindDataChannel(target, channel);
  return channel;
}

/**
 * Devuelve la pc del interlocutor y, si este extremo es el "impolite",
 * crea el DataChannel que dispara la negociación inicial.
 */
export function ensurePeerConnection(target) {
  if (!target || target === senderId) return null;

  const pc = createPeerConnection(target);
  const meta = peerMeta.get(target);

  if (pc && meta && !meta.polite && !dataChannels.has(target)) {
    createLocalDataChannel(target, pc);
  }

  return pc;
}

/** Conecta de forma proactiva al destinatario activo (mejora el indicador P2P). */
export function preparePeerForTarget(target) {
  const socket = getSocket();
  if (!isRegistered() || !socket || socket.readyState !== WebSocket.OPEN) return;
  if (!target || target === senderId) return;
  if (!getDirectory().some((user) => user.userId === target)) return;

  try {
    ensurePeerConnection(target);
  } catch (error) {
    logP2P(`No se pudo preparar la conexión P2P con ${target}: ${error.message}`);
  }
}

/**
 * Espera a que el DataChannel esté abierto. Si no existe ninguno, crea uno
 * local para forzar la negociación y resuelve null al vencer el timeout.
 */
export function waitForDataChannel(target, timeoutMs) {
  const open = getOpenDataChannel(target);
  if (open) return Promise.resolve(open);

  let pc;
  try {
    pc = ensurePeerConnection(target);
  } catch (error) {
    logP2P(`No se pudo crear la RTCPeerConnection con ${target}: ${error.message}`);
    return Promise.resolve(null);
  }

  if (!pc) return Promise.resolve(null);

  const meta = peerMeta.get(target);
  if (!meta) return Promise.resolve(null);

  if (!dataChannels.has(target)) {
    try {
      createLocalDataChannel(target, pc);
    } catch (error) {
      logP2P(`No se pudo crear el DataChannel con ${target}: ${error.message}`);
    }
  }

  return new Promise((resolve) => {
    const waiter = {
      resolve,
      timer: window.setTimeout(() => {
        const index = meta.waiters.indexOf(waiter);
        if (index !== -1) meta.waiters.splice(index, 1);

        logP2P(`Timeout (${timeoutMs} ms) esperando el DataChannel con ${target}.`);
        resolve(null);
      }, timeoutMs),
    };

    meta.waiters.push(waiter);
  });
}

export function closePeerConnection(target) {
  const channel = dataChannels.get(target);
  const pc = peerConnections.get(target);
  const meta = peerMeta.get(target);

  if (meta) {
    for (const waiter of meta.waiters.splice(0)) {
      window.clearTimeout(waiter.timer);
      waiter.resolve(null);
    }
  }

  dataChannels.delete(target);
  pendingCandidates.delete(target);
  peerConnections.delete(target);
  peerMeta.delete(target);

  if (channel) {
    try {
      channel.close();
    } catch {
      // El canal ya estaba cerrado.
    }
  }

  if (pc) {
    try {
      pc.close();
    } catch {
      // La pc ya estaba cerrada.
    }
  }

  setP2PState(target, 'disconnected');
}

/** Al cerrar el WebSocket se descartan todas las conexiones P2P (sin señalización no hay sesión). */
export function closeAllPeerConnections() {
  for (const target of [...peerConnections.keys()]) {
    closePeerConnection(target);
  }

  pendingCandidates.clear();
  dataChannels.clear();
  peerMeta.clear();
  p2pStates.clear();
}

/** Cierra las pc de usuarios que ya no aparecen en el directorio. */
export function reconcilePeerConnections() {
  const connectedIds = new Set(
    getDirectory().filter((user) => user.userId !== senderId).map((user) => user.userId)
  );

  for (const target of [...peerConnections.keys()]) {
    if (connectedIds.has(target)) continue;

    const wasActive =
      p2pStates.get(target) === 'connected' || p2pStates.get(target) === 'connecting';
    closePeerConnection(target);

    if (wasActive) lastDisconnectedPeer = target;
  }

  for (const target of [...p2pStates.keys()]) {
    if (!connectedIds.has(target)) p2pStates.delete(target);
  }
}

export function handleDataChannelMessage(target, raw) {
  if (typeof raw !== 'string') return;

  let message;
  try {
    message = JSON.parse(raw);
  } catch {
    return;
  }

  if (!message || typeof message !== 'object') return;
  if (typeof message.text !== 'string' || !message.text.trim()) return;

  logP2P(`chat recibido por RTCDataChannel de ${target}.`);

  // Se reutiliza el render existente: el remitente fiable es el par del canal.
  onChat({
    type: 'chat',
    messageId: message.messageId,
    sender: target,
    target: senderId,
    text: message.text,
    ts: typeof message.timestamp === 'number' ? message.timestamp : Date.now(),
  });
}
