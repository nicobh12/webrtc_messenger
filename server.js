'use strict';

const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT) || 3000;
const NODE_NAME = process.env.NODE_NAME || 'nodo-local';

function log(...args) {
  console.log(`[${new Date().toISOString()}] [${NODE_NAME}]`, ...args);
}

const wss = new WebSocketServer({ port: PORT });

wss.on('listening', () => {
  log(`Servidor de señalización WebSocket escuchando en el puerto ${PORT}`);
});

wss.on('connection', (socket, request) => {
  const clientId = `${request.socket.remoteAddress}:${request.socket.remotePort}`;
  const path = request.url || '/';

  log(`Cliente conectado (${clientId}) en ${path}. Clientes activos: ${wss.clients.size}`);

  socket.on('message', (data, isBinary) => {
    if (isBinary) {
      log(`Mensaje binario recibido de ${clientId} (${data.length} bytes)`);
      return;
    }

    const raw = data.toString();
    log(`Mensaje recibido de ${clientId}: ${raw}`);

    // Si el mensaje es JSON (formato de señalización del informe), se resume en el log.
    try {
      const message = JSON.parse(raw);
      log(
        `Mensaje JSON de ${clientId}: type=${message.type ?? 'sin type'}, ` +
          `sender=${message.sender ?? 'sin sender'}, target=${message.target ?? 'sin target'}`
      );
    } catch {
      log(`El mensaje de ${clientId} no es JSON válido; se registró como texto plano.`);
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

function shutdown(signal) {
  log(`Señal ${signal} recibida. Cerrando servidor...`);

  wss.close(() => {
    log('Servidor cerrado correctamente.');
    process.exit(0);
  });

  // Cierre forzado si alguna conexión impide terminar el proceso.
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
