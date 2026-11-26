# Mensajero WebRTC

Interfaz web básica y chat de texto sobre WebSocket para el mensajero distribuido del laboratorio. Cada nodo Docker (`nodo-a` y `nodo-b`) sirve su propia interfaz y mantiene su propio servidor de señalización en Node.js.

## Requisitos

- Docker Desktop o Docker Engine.
- Docker Compose v2.
- Node.js y npm (opcional, para instalar `wscat`).

## Estructura del proyecto

| Archivo | Descripción |
|---|---|
| `package.json` | Dependencias del proyecto (`express` y `ws`). |
| `server.js` | Servidor HTTP/WebSocket de cada nodo; sirve `public/` y difunde el chat. |
| `Dockerfile` | Imagen Docker basada en `node:18-alpine`. |
| `docker-compose.yml` | Definición de los contenedores `nodo-a` y `nodo-b`. |
| `public/index.html` | Estructura de la interfaz: videos, controles y chat. |
| `public/styles.css` | Estilos y diseño responsive con Flexbox/Grid. |
| `public/app.js` | Conexión WebSocket, envío y recepción de mensajes de chat. |

## Ejecución

Desde la raíz del proyecto:

```bash
docker compose up --build
```

Para ejecutar en segundo plano:

```bash
docker compose up --build -d
```

Comprobar el estado de los contenedores:

```bash
docker compose ps
```

## Puertos utilizados

| Nodo | Puerto interno | Puerto del host | Interfaz |
|---|---|---|---|
| `nodo-a` | 3000 | 3000 | `http://localhost:3000` |
| `nodo-b` | 3000 | 3001 | `http://localhost:3001` |

## Uso de la interfaz

1. Abrir `http://localhost:3000` para el nodo A o `http://localhost:3001` para el nodo B.
2. La barra superior muestra el identificador de la sesión y el estado de la conexión WebSocket.
3. Escribir un mensaje en el panel derecho y presionar **Enviar** (o la tecla Enter).
4. Para observar la difusión, abrir dos pestañas en el **mismo puerto**: el mensaje enviado desde una aparece en la otra.
5. Los botones de llamada, colgar, mutear y cámara están deshabilitados.

> **Alcance del chat:** los mensajes se difunden únicamente entre los clientes conectados al mismo nodo. El reenvío entre `nodo-a` y `nodo-b` se implementará en la siguiente sesión.

## Formato del mensaje de chat

El navegador envía por WebSocket:

```json
{
  "type": "chat",
  "sender": "cliente-1a2b3c4d",
  "text": "hola"
}
```

El servidor valida el mensaje y lo retransmite a los demás clientes conectados a ese nodo.

## Prueba con `wscat`

Instalar la herramienta (si no está disponible):

```bash
npm install -g wscat
```

Conectar al nodo A:

```bash
wscat -c ws://localhost:3000
```

Enviar un mensaje de chat:

```json
{"type":"chat","sender":"wscat-1","text":"hola desde wscat"}
```

El mensaje debe aparecer en la interfaz abierta en `http://localhost:3000`. También funciona en sentido contrario: un mensaje enviado desde la interfaz aparece en la terminal de `wscat`.

Para el nodo B, usar `ws://localhost:3001`.

## Logs

Consultar los registros de ambos nodos:

```bash
docker compose logs -f
```

O los de un nodo específico:

```bash
docker compose logs -f nodo-a
```

Cada mensaje de chat produce líneas similares a:

```text
[2026-11-26T05:48:33.969Z] [nodo-a] Mensaje JSON de 172.18.0.1:53214: type=chat, sender=cliente-1a2b3c4d, target=sin target
[2026-11-26T05:48:33.971Z] [nodo-a] Chat de cliente-1a2b3c4d (172.18.0.1:53214) difundido a 1 cliente(s): hola
```

También está disponible el endpoint de salud `http://localhost:3000/health`.

## Problemas conocidos

- `port is already allocated`: alguno de los puertos 3000 o 3001 está ocupado en el host.
- `wscat: command not found`: instalar con `npm install -g wscat` o usar `npx wscat`.
- El mensaje no aparece en otra pestaña: comprobar que ambas pestañas apuntan al mismo puerto; el chat aún no cruza entre nodos.
- El mensaje no aparece en la terminal: `wscat` no recibe el mensaje que él mismo envía, solo los de otros clientes.

## Detener los servicios

```bash
docker compose down
```

Para eliminar también la imagen construida localmente:

```bash
docker compose down --rmi local
```

## Alcance de esta fase

**Incluido:** interfaz web, servido de archivos estáticos, conexión WebSocket, envío y recepción de chat de texto, y difusión del chat entre clientes del mismo nodo.

**No incluido todavía:** lógica WebRTC (SDP, ICE, STUN, TURN), captura de cámara/micrófono, transferencia de archivos y reenvío de mensajes entre nodos.
