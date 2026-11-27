# Mensajero WebRTC — Fase 4

Chat de texto distribuido entre dos nodos Docker (`nodo-a` y `nodo-b`). Cada nodo mantiene su propio servidor HTTP/WebSocket y su propia interfaz, pero los usuarios pueden enviarse mensajes dirigidos aunque estén conectados a nodos diferentes.

La comunicación entre servidores usa WebSocket sobre los nombres DNS internos de Docker Compose (`ws://nodo-a:3000/peer` y `ws://nodo-b:3000/peer`). No se usa `localhost` para el enlace entre nodos.

## Arquitectura

```text
┌──────────────┐        ws://localhost:3000        ┌────────────────────┐
│ Navegador    │ ─────────────────────────────────> │ nodo-a             │
│ Alice        │ <───────────────────────────────── │ HTTP + WS :3000    │
└──────────────┘                                    │                    │
                                                    │  /peer  ◄──────────┼──┐
                                                    └────────────────────┘  │
                                                                            │
                                        ws://nodo-b:3000/peer               │
                                        (DNS interno de Compose)            │
                                                                            │
┌──────────────┐        ws://localhost:3001        ┌────────────────────┐  │
│ Navegador    │ ─────────────────────────────────> │ nodo-b             │  │
│ Bob          │ <───────────────────────────────── │ HTTP + WS :3000    │ ◄┘
└──────────────┘                                    │                    │
                                                    │  /peer  ◄──────────┼──┐
                                                    └────────────────────┘  │
                                                                            │
                                        ws://nodo-a:3000/peer               │
                                                                            │
```

Cada nodo mantiene dos tipos de conexión claramente separados:

| Tipo | Ruta | Propósito |
|---|---|---|
| Socket de cliente | `/` | Navegadores: registro, presencia y chat. |
| Socket de nodo | `/peer?node=<nombre>` | Comunicación interna entre servidores. |

Los sockets de nodo no se mezclan con los clientes: no aparecen en `localUsers`, no reciben chats por broadcast y no se cuentan como clientes en `/health`.

### Registro distribuido

Cada nodo conserva dos mapas:

- `localUsers`: usuarios conectados a este nodo (`userId → conexiones`).
- `remoteUsers`: usuarios conectados a otros nodos (`userId → nodo`).

Ejemplo con Alice y Carol en `nodo-a`, y Bob en `nodo-b`:

| Nodo | Usuarios locales | Usuarios remotos |
|---|---|---|
| `nodo-a` | `alice`, `carol` | `bob → nodo-b` |
| `nodo-b` | `bob` | `alice → nodo-a`, `carol → nodo-a` |

La presencia se sincroniza con `peer-hello` (snapshot completo al abrir un enlace) y `peer-presence` (eventos `join`/`leave`). Cada mensaje lleva `sessionId` y `seq` para descartar snapshots o eventos obsoletos cuando hay reconexiones o enlaces duplicados.

### Enrutamiento de un mensaje

1. Alice envía `chat` con `target: "bob"` a `nodo-a`.
2. `nodo-a` busca `bob` en `localUsers`; no está.
3. Lo busca en `remoteUsers` y obtiene `nodo-b`.
4. `nodo-a` envía `peer-chat` a `nodo-b` por el enlace `/peer`.
5. `nodo-b` busca `bob` en sus `localUsers`, entrega el `chat` por el socket de Bob y responde `peer-ack`.
6. `nodo-a` recibe el ack y confirma a Alice con `chat-ack` (`targetNode: "nodo-b"`).
7. Si Bob no está conectado, `nodo-a` responde `chat-error` con `reason: "offline"`.

El chat **nunca** se difunde a todos los clientes ni a todos los nodos. La presencia sí se difunde, porque es información de directorio.

### Anti-bucles y duplicados

- Un `peer-chat` recibido de otro nodo se entrega solo a sockets locales y **nunca se reenvía**.
- Cada nodo guarda `originNode:messageId` durante 60 segundos; un `peer-chat` repetido se confirma con `peer-ack` marcado como `duplicate` sin volver a entregarlo.
- Los enlaces entre nodos son bidireccionales: ambos nodos intentan conectarse. Para enviar se prefiere el enlace saliente y el ack vuelve por el mismo socket.
- Cada mensaje cross-node tiene un timeout de confirmación (`ACK_TIMEOUT_MS`, 5 s por defecto); si vence, el cliente recibe `chat-error` con `reason: "timeout"`.

### Reconexión y heartbeat

- Cada nodo intenta reconectarse con backoff exponencial (500 ms → 8 s, con jitter).
- Cada 15 segundos se envía un ping WebSocket; si no hay pong, el socket se cierra y se dispara la reconexión.
- Al perder todos los enlaces con un nodo, se eliminan sus usuarios remotos y se fallan los mensajes pendientes hacia ese nodo.
- Al reconectar, `peer-hello` reenvía el snapshot de usuarios y el directorio se resincroniza automáticamente.

## Protocolo JSON

### Cliente → nodo

| `type` | Campos | Descripción |
|---|---|---|
| `register` | `userId` | Registra el socket con un identificador estable. |
| `chat` | `messageId`, `sender`, `target`, `text` | Mensaje dirigido a un usuario. |
| `who` | — | Solicita el directorio actual. |

### Nodo → cliente

| `type` | Campos | Descripción |
|---|---|---|
| `welcome` | `userId`, `node`, `users[]`, `peers[]` | Confirma el registro y entrega el directorio. |
| `presence` | `users[{ userId, node, local }]`, `peers[]` | Directorio actualizado. |
| `chat` | `messageId`, `sender`, `target`, `text`, `fromNode` | Mensaje entregado. |
| `chat-ack` | `messageId`, `target`, `targetNode`, `status` | Entrega confirmada. |
| `chat-error` | `messageId`, `target`, `reason`, `detail` | Mensaje no entregado. |
| `error` | `code`, `detail` | Error de protocolo. |

Motivos de `chat-error`: `missing-target`, `empty-text`, `offline`, `peer-unreachable`, `timeout`, `remote-error`.

### Nodo ↔ nodo (`/peer`)

| `type` | Campos | Descripción |
|---|---|---|
| `peer-hello` | `node`, `sessionId`, `seq`, `users[]` | Saludo y snapshot de usuarios locales. |
| `peer-presence` | `node`, `sessionId`, `seq`, `event`, `userId` | Alta o baja de un usuario (`join`/`leave`). |
| `peer-chat` | `messageId`, `originNode`, `sender`, `target`, `text`, `hops[]` | Mensaje a entregar en el nodo receptor. |
| `peer-ack` | `messageId`, `sender`, `target`, `status`, `targetNode`, `duplicate?` | Resultado de la entrega. |

Además se usan los frames `ping`/`pong` de WebSocket para detectar enlaces muertos.

### Ejemplo de chat

```json
{
  "type": "chat",
  "messageId": "8f14e45f-ceea-467a-9f0b-2b1d1c9a7f00",
  "sender": "alice",
  "target": "bob",
  "text": "hola Bob"
}
```

## Estructura del proyecto

| Archivo | Descripción |
|---|---|
| `package.json` | Dependencias (`express` y `ws`). |
| `server.js` | Servidor HTTP/WebSocket, registro distribuido, enrutamiento, enlaces `/peer`, heartbeat y reconexión. |
| `Dockerfile` | Imagen `node:18-alpine`; copia `server.js` y `public/`. |
| `docker-compose.yml` | Contenedores `nodo-a` y `nodo-b`, puertos, `PEER_NODES` y healthchecks. |
| `public/index.html` | Interfaz: videos, controles, directorio, destinatario y chat. |
| `public/styles.css` | Estilos responsive con Flexbox/Grid. |
| `public/app.js` | Registro, presencia, envío dirigido, acks, errores y reconexión del cliente. |

## Requisitos

- Docker Desktop o Docker Engine.
- Docker Compose v2.
- Node.js y npm (opcional, para `wscat`).

## Ejecución

Desde la raíz del proyecto:

```bash
docker compose up --build
```

En segundo plano:

```bash
docker compose up --build -d
```

Comprobar el estado:

```bash
docker compose ps
```

## Puertos y URLs

| Nodo | Puerto interno | Puerto del host | Interfaz |
|---|---|---|---|
| `nodo-a` | 3000 | 3000 | `http://localhost:3000` |
| `nodo-b` | 3000 | 3001 | `http://localhost:3001` |

Para pruebas reproducibles se puede fijar el usuario y el destinatario por query string:

- Alice: `http://localhost:3000/?user=alice&target=bob`
- Bob: `http://localhost:3001/?user=bob&target=alice`

El identificador también se guarda en `localStorage` y puede cambiarse con el botón ✎ de la barra superior.

## Uso de la interfaz

1. Abrir Alice en `http://localhost:3000/?user=alice&target=bob`.
2. Abrir Bob en `http://localhost:3001/?user=bob&target=alice`.
3. La barra superior muestra el ID, el nodo, el estado de los enlaces (`Enlaces: nodo-b`) y el estado de la conexión.
4. El panel **Directorio** lista los usuarios conectados y el nodo donde están; al hacer clic en uno se completa el destinatario.
5. Escribir el mensaje y presionar **Enviar** o Enter.
6. El mensaje propio muestra `enviando…`, luego `entregado · nodo-b` o `no entregado · <motivo>`.
7. Los mensajes recibidos de otro nodo indican su origen (`· nodo-a`).

Los botones de llamada, colgar, mutear y cámara siguen deshabilitados: corresponden a la Fase 5 (WebRTC).

## Pruebas

### 1. Dos clientes en el mismo nodo

Abrir dos pestañas en `http://localhost:3000`:

- `http://localhost:3000/?user=alice&target=carol`
- `http://localhost:3000/?user=carol&target=alice`

Enviar un mensaje de Alice a Carol. Debe aparecer en ambas pestañas y Alice debe ver `entregado · nodo-a`.

También se puede comprobar el registro:

```bash
curl http://localhost:3000/api/state
```

Debe incluir `alice` y `carol` en `localUsers`.

### 2. Clientes en nodos diferentes

Abrir:

- Alice: `http://localhost:3000/?user=alice&target=bob`
- Bob: `http://localhost:3001/?user=bob&target=alice`

Enviar de Alice a Bob. Resultado esperado:

- Bob recibe el mensaje con `· nodo-a`.
- Alice ve `entregado · nodo-b`.
- En los logs de `nodo-a` aparece `reenviado a nodo-b`.
- En los logs de `nodo-b` aparece `peer-chat ... delivered`.

Comprobar los enlaces:

```bash
curl http://localhost:3000/api/state
curl http://localhost:3001/api/state
```

Cada respuesta debe mostrar el otro nodo en `peers` y el usuario remoto en `remoteUsers`.

### 3. Desconexión y reconexión de un nodo

Detener `nodo-b`:

```bash
docker compose stop nodo-b
```

Esperar unos segundos y comprobar que `nodo-a` ya no tiene enlaces:

```bash
curl http://localhost:3000/api/state
```

`peers` debe quedar vacío y `remoteUsers` no debe contener a `bob`. Si Alice intenta escribir a Bob, recibirá `chat-error` con `reason: "offline"` o `"peer-unreachable"`.

Volver a iniciar `nodo-b`:

```bash
docker compose start nodo-b
```

En pocos segundos los enlaces se restablecen, `peer-hello` resincroniza el directorio y el chat vuelve a funcionar sin reiniciar `nodo-a`.

### 4. Destinatario desconectado

Con ambos nodos activos, escribir desde Alice a un usuario inexistente (`nadie`). El servidor responde:

```json
{
  "type": "chat-error",
  "target": "nadie",
  "reason": "offline",
  "detail": "El usuario \"nadie\" no está conectado en ningún nodo."
}
```

La interfaz muestra `no entregado · destinatario desconectado`.

### 5. Prueba con `wscat` (opcional)

Instalar:

```bash
npm install -g wscat
```

Registrar a Alice en `nodo-a`:

```bash
wscat -c ws://localhost:3000
```

```json
{"type":"register","userId":"alice"}
```

Registrar a Bob en `nodo-b` en otra terminal:

```bash
wscat -c ws://localhost:3001
```

```json
{"type":"register","userId":"bob"}
```

Alice envía:

```json
{"type":"chat","messageId":"m-1","sender":"alice","target":"bob","text":"hola desde wscat"}
```

Bob debe recibir el `chat` y Alice debe recibir el `chat-ack` con `targetNode: "nodo-b"`.

## Logs

```bash
docker compose logs -f
```

O por nodo:

```bash
docker compose logs -f nodo-a
docker compose logs -f nodo-b
```

Líneas esperadas en un chat cross-node:

```text
[nodo-a] Chat 8f14e45f... de alice (...) -> bob: hola Bob
[nodo-a] Chat 8f14e45f... reenviado a nodo-b para bob.
[nodo-b] peer-chat 8f14e45f... de nodo-a para bob: delivered (1 conexión/es).
[nodo-a] Chat 8f14e45f... confirmado por nodo-b para bob.
```

## Endpoints de control

| Endpoint | Descripción |
|---|---|
| `GET /health` | Estado, sesión, número de clientes, usuarios locales y peers conectados. |
| `GET /api/state` | Vista completa: clientes, `localUsers`, `remoteUsers`, enlaces, reintentos y acks pendientes. |

Ejemplo:

```bash
curl http://localhost:3000/health
```

```json
{
  "status": "ok",
  "node": "nodo-a",
  "sessionId": "4ce0191d36dd",
  "clients": 1,
  "users": 1,
  "peers": ["nodo-b"]
}
```

## Configuración

| Variable | Valor por defecto | Descripción |
|---|---|---|
| `PORT` | `3000` | Puerto interno HTTP/WebSocket. |
| `NODE_NAME` | `nodo-local` | Nombre del nodo. |
| `PEER_NODES` | vacío | Nodos con los que abrir enlace, separados por coma. Compose usa `nodo-b`/`nodo-a`. |
| `PEER_URLS` | vacío | URLs explícitas para pruebas locales, p. ej. `nodo-b=ws://127.0.0.1:4200/peer`. |
| `ACK_TIMEOUT_MS` | `5000` | Espera máxima del `peer-ack`. |
| `HEARTBEAT_INTERVAL_MS` | `15000` | Intervalo de ping/pong. |
| `RECONNECT_MIN_MS` | `500` | Backoff mínimo de reconexión. |
| `RECONNECT_MAX_MS` | `8000` | Backoff máximo de reconexión. |

`PEER_NODES` usa los nombres DNS internos de Compose. En Docker, `nodo-a` resuelve `nodo-b` y viceversa; no se usa `localhost`, porque dentro de cada contenedor `localhost` es el propio contenedor.

### Ejecución local sin Docker (opcional)

Para pruebas en una sola máquina con puertos distintos:

```bash
# Terminal 1
PORT=4100 NODE_NAME=nodo-a PEER_URLS='nodo-b=ws://127.0.0.1:4200/peer' npm start

# Terminal 2
PORT=4200 NODE_NAME=nodo-b PEER_URLS='nodo-a=ws://127.0.0.1:4100/peer' npm start
```

En PowerShell, definir las variables con `$env:PORT='4100'`, etc.

## Problemas conocidos

- `port is already allocated`: los puertos 3000 o 3001 están ocupados en el host.
- `Enlaces: sin enlaces`: revisar que ambos contenedores estén activos y que `PEER_NODES` apunte al nombre correcto. Verificar con `docker compose logs`.
- Un mensaje cross-node queda en `timeout`: el nodo destino no respondió en 5 s; revisar los logs de ambos nodos.
- El destinatario aparece en el directorio pero el envío falla: puede haber cambiado de nodo o desconectado entre la actualización de presencia y el envío; el servidor responde con `chat-error`.
- Los identificadores distinguen mayúsculas y minúsculas y solo admiten letras, números, punto, guion y guion bajo.

## Detener los servicios

```bash
docker compose down
```

Para eliminar también la imagen local:

```bash
docker compose down --rmi local
```

## Alcance de esta fase

**Incluido:** dos nodos independientes, enlaces WebSocket entre servidores, registro distribuido de usuarios, presencia sincronizada, enrutamiento dirigido por `target`, confirmaciones y errores de entrega, deduplicación, heartbeat y reconexión automática.

**No incluido todavía:** WebRTC (SDP, ICE, STUN, TURN), audio, video, `RTCDataChannel`, captura de cámara/micrófono, autenticación con contraseñas y transferencia de archivos.
