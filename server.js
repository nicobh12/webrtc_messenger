'use strict';

const http = require('http');
const path = require('path');
const express = require('express');
const { WebSocketServer, WebSocket } = require('ws');

const PORT = Number(process.env.PORT) || 3000;
const NODE_NAME = process.env.NODE_NAME || 'nodo-local';
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_CHAT_LENGTH = 2000;
const MAX_SENDER_LENGTH = 64;

function log(...args) {
  console.log(`[${new Date().toISOString()}] [${NODE_NAME}]`, ...args);
}

const app = express();
app.disable('x-powered-by');
app.use(express.static(PUBLIC_DIR));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    node: NODE_NAME,
    clients: wss.clients.size,
  });
});

function broadcastChat(sourceSocket, sender, text) {
  const payload = JSON.stringify({ type: 'chat', sender, text });
  let recipients = 0;

  for (const client of wss.clients) {
    if (client !== sourceSocket && client.readyState === WebSocket.OPEN) {
      try {
        client.send(payload);
        recipients += 1;
      } catch (error) {
        log(`No se pudo enviar el chat a un cliente: ${error.message}`);
      }
    }
  }

  return recipients;
}

function handleChatMessage(socket, clientId, message) {
  const text = typeof message.text === 'string' ? message.text.trim() : '';
  const sender =
    typeof message.sender === 'string' && message.sender.trim()
      ? message.sender.trim().slice(0, MAX_SENDER_LENGTH)
      : 'anónimo';

  if (!text) {
    log(`Chat ignorado de ${clientId}: el campo "text" está vacío o no es una cadena.`);
    return;
  }

  const safeText = text.slice(0, MAX_CHAT_LENGTH);
  const recipients = broadcastChat(socket, sender, safeText);

  log(`Chat de ${sender} (${clientId}) difundido a ${recipients} cliente(s): ${safeText}`);
}

wss.on('connection', (socket, request) => {
  const clientId = `${request.socket.remoteAddress}:${request.socket.remotePort}`;
  const requestPath = request.url || '/';

  log(`Cliente conectado (${clientId}) en ${requestPath}. Clientes activos: ${wss.clients.size}`);

  socket.on('message', (data, isBinary) => {
    if (isBinary) {
      log(`Mensaje binario recibido de ${clientId} (${data.length} bytes)`);
      return;
    }

    const raw = data.toString();
    log(`Mensaje recibido de ${clientId}: ${raw}`);

    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      log(`El mensaje de ${clientId} no es JSON válido; se registró como texto plano.`);
      return;
    }

    if (!message || typeof message !== 'object') {
      log(`El mensaje de ${clientId} no es un objeto JSON válido.`);
      return;
    }

    log(
      `Mensaje JSON de ${clientId}: type=${message.type ?? 'sin type'}, ` +
        `sender=${message.sender ?? 'sin sender'}, target=${message.target ?? 'sin target'}`
    );

    // Fase 3: solo se difunde el chat dentro de este nodo. El reenvío
    // inter-nodo y los mensajes de señalización WebRTC quedan para fases posteriores.
    if (message.type === 'chat') {
      handleChatMessage(socket, clientId, message);
    }
  });

  socket.on('close', (code, reason) => {
    const detail = reason.length > 0 ? reason.toString() : 'sin motivo';
    log(`Cliente desconectado (${clientId}). Código: ${code}. Motivo: ${detail}. Clientes activos: ${wss.clients.size}`);
  });

  socket.on('error', (error) => {
    log(`Error en el socket de ${clientId}: ${error.message}`);
  });
});

wss.on('error', (error) => {
  log(`Error del servidor WebSocket: ${error.message}`);
});

server.on('error', (error) => {
  log(`Error del servidor HTTP: ${error.message}`);
});

server.listen(PORT, () => {
  log(`Servidor HTTP/WebSocket escuchando en el puerto ${PORT}`);
  log(`Interfaz web disponible en http://localhost:${PORT}`);
});

function shutdown(signal) {
  log(`Señal ${signal} recibida. Cerrando servidor...`);

  for (const client of wss.clients) {
    client.close(1001, 'Servidor apagándose');
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
