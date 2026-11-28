'use strict';

const http = require('http');
const path = require('path');
const express = require('express');
const { WebSocketServer, WebSocket } = require('ws');
const rooms = require('./rooms');
const signaling = require('./signaling');

const PORT = Number(process.env.PORT) || 3000;
const NODE_NAME = rooms.NODE_NAME;
const SESSION_ID = rooms.SESSION_ID;
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const PEER_PATH = '/peer';
const HEARTBEAT_INTERVAL_MS = Number(process.env.HEARTBEAT_INTERVAL_MS) || 15000;
let shuttingDown = false;

const app = express();
app.disable('x-powered-by');
app.use(express.static(PUBLIC_DIR));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, maxPayload: 64 * 1024 });

app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    node: NODE_NAME,
    sessionId: SESSION_ID,
    clients: rooms.clientSockets.size,
    users: rooms.localUsers.size,
    peers: rooms.peerNames(),
  });
});

app.get('/api/state', (_req, res) => {
  res.json({
    node: NODE_NAME,
    sessionId: SESSION_ID,
    presenceSeq: rooms.presenceSeq,
    clients: [...rooms.clientSockets].map((socket) => ({
      userId: socket.__userId ?? null,
      readyState: socket.readyState,
    })),
    localUsers: [...rooms.localUsers.keys()].sort(),
    remoteUsers: Object.fromEntries(rooms.remoteUsers),
    peers: rooms.peerNames(),
    outbound: [...rooms.outboundPeers].map(([node, state]) => ({
      node,
      url: state.url,
      readyState: state.socket ? state.socket.readyState : null,
      attempts: state.attempts,
      reconnectScheduled: Boolean(state.timer),
    })),
    pendingAcks: [...signaling.pendingAcks.keys()],
  });
});

// ------------------------------------------------------------ Ciclo de vida

wss.on('connection', (socket, request) => {
  socket.__isAlive = true;

  let url;
  try {
    url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
  } catch {
    socket.close(1008, 'URL inv?lida');
    return;
  }

  if (url.pathname === PEER_PATH) {
    signaling.handlePeerConnection(socket, request, url);
    return;
  }

  signaling.handleClientConnection(socket, request);
});

wss.on('error', (error) => {
  rooms.log(`Error del servidor WebSocket: ${error.message}`);
});

server.on('error', (error) => {
  rooms.log(`Error del servidor HTTP: ${error.message}`);
});

// Heartbeat: detecta enlaces y clientes muertos (ping/pong de WebSocket).

const heartbeat = setInterval(() => {
  for (const socket of wss.clients) {
    if (socket.readyState !== WebSocket.OPEN) continue;

    if (socket.__isAlive === false) {
      rooms.log(`Sin respuesta de heartbeat (${socket.__kind ?? 'desconocido'}); se cierra el socket.`);
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
  for (const [key, expiresAt] of signaling.seenPeerMessages) {
    if (expiresAt <= now) signaling.seenPeerMessages.delete(key);
  }
}, 30 * 1000);
dedupeCleanup.unref?.();

server.listen(PORT, () => {
  rooms.log(`Servidor HTTP/WebSocket escuchando en el puerto ${PORT} (sesión ${SESSION_ID}).`);
  rooms.log(`Interfaz web: http://localhost:${PORT}`);
  rooms.log(`Rutas: / (clientes) y ${PEER_PATH} (comunicación entre nodos).`);

  if (rooms.outboundPeers.size === 0) {
    rooms.log(
      'Sin nodos peer configurados. Define PEER_NODES o PEER_URLS para habilitar ' +
        'el chat entre nodos.'
    );
    return;
  }

  for (const nodeId of rooms.outboundPeers.keys()) {
    signaling.connectToPeer(nodeId);
  }
});

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  signaling.setShuttingDown(true);

  rooms.log(`Señal ${signal} recibida. Cerrando servidor...`);

  clearInterval(heartbeat);
  clearInterval(dedupeCleanup);

  for (const state of rooms.outboundPeers.values()) {
    if (state.timer) clearTimeout(state.timer);
    state.socket?.terminate();
  }

  for (const pending of signaling.pendingAcks.values()) {
    clearTimeout(pending.timer);
  }
  signaling.pendingAcks.clear();

  for (const socket of wss.clients) {
    try {
      socket.close(1001, 'Servidor apagándose');
    } catch {
      // Ignorar sockets ya cerrados.
    }
  }

  wss.close(() => {
    server.close(() => {
      rooms.log('Servidor cerrado correctamente.');
      process.exit(0);
    });
  });

  // Cierre forzado si alguna conexión impide terminar el proceso.
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
