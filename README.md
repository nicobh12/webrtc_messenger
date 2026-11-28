# Mensajero WebRTC

Chat de texto 1 a 1 **directo entre navegadores** mediante `RTCDataChannel` (P2P), sobre dos nodos Docker (`nodo-a` y `nodo-b`). El WebSocket ya **no transporta el chat**: se usa solo para registro, presencia, señalización WebRTC (`offer`/`answer`/`candidate`) y como **fallback** si el canal P2P no está disponible.

La comunicación entre servidores sigue usando WebSocket sobre los nombres DNS internos de Docker Compose (`ws://nodo-a:3000/peer` y `ws://nodo-b:3000/peer`). No se usa `localhost` para el enlace entre nodos.

## Arquitectura

```text
        ┌──────────────────────────── RTCDataChannel (chat P2P) ───────────────────────────┐
        │                                                                                  │
        ▼                                                                                  │
┌──────────────┐        ws://localhost:3000        ┌────────────────────┐                  │
│ Navegador    │ ─────────────────────────────────> │ nodo-a             │                  │
│ Alice        │ <───────────────────────────────── │ HTTP + WS :3000    │                  │
└──────────────┘   registro · presencia · SDP/ICE   │                    │                  │
        ▲                                           │  /peer  ◄──────────┼──┐               │
        │                                           └────────────────────┘  │               │
        │                                                                   │               │
        │                               ws://nodo-b:3000/peer               │               │
        │                               (DNS interno de Compose)            │               │
        │                                                                   │               │
┌──────────────┐        ws://localhost:3001        ┌────────────────────┐  │               │
│ Navegador    │ ─────────────────────────────────> │ nodo-b             │  │               │
│ Bob          │ <───────────────────────────────── │ HTTP + WS :3000    │ ◄┘               │
└──────────────┘   registro · presencia · SDP/ICE   │                    │                  │
        ▲                                           │  /peer  ◄──────────┼──┐               │
        │                                           └────────────────────┘  │               │
        │                                                                   │               │
        └───────────────────────────────────────────────────────────────────┴───────────────┘
```

Cada nodo mantiene tres tipos de comunicación claramente separados:

| Tipo | Ruta | Propósito |
|---|---|---|
| Socket de cliente | `/` | Navegadores: registro, presencia, señalización WebRTC y chat de fallback. |
| Socket de nodo | `/peer?node=<nombre>` | Presencia distribuida y reenvío de señalización entre nodos. |
| Canal P2P | `RTCDataChannel` (`chat`) | Mensajes 1 a 1 entre navegadores, sin pasar por el servidor. |

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

### Chat 1 a 1 por `RTCDataChannel`

El chat 1 a 1 se negocia una sola vez por interlocutor y luego viaja directo entre navegadores:

1. Alice y Bob se registran por WebSocket. El directorio (`presence`) indica quién está conectado y en qué nodo.
2. El cliente crea una `RTCPeerConnection` por interlocutor con `ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }]`.
3. Se aplica **Perfect Negotiation**: el `userId` lexicográficamente menor es `polite`; el mayor es `impolite` y es quien crea el `RTCDataChannel` (`chat`, `{ ordered: true }`) para iniciar la negociación.
4. `offer`, `answer` y `candidate` viajan por el WebSocket del cliente. El nodo los entrega al destinatario local o los reenvía al nodo remoto como `peer-signal`.
5. Cuando el `RTCDataChannel` está `open`, cada mensaje se envía como JSON:

```json
{
  "messageId": "8f14e45f-ceea-467a-9f0b-2b1d1c9a7f00",
  "sender": "alice",
  "text": "hola Bob",
  "timestamp": 1795829542468
}
```

6. El receptor valida el JSON, fuerza `sender` al `userId` del par del canal (anti-suplantación) y reutiliza el mismo render del chat (`onChat`).
7. Si el destinatario no está en el directorio, el canal no abre en **10 s** o el envío falla, el mensaje se envía por WebSocket y se marca `enviado por WebSocket (fallback)`.

Reglas de la negociación:

- `polite` aplica **rollback** si recibe una oferta mientras tiene una oferta local pendiente.
- `impolite` **ignora** la oferta en colisión (`ignoreOffer`) y reintenta con la suya.
- Los `candidate` que llegan antes de la descripción remota se guardan en `pendingCandidates` y se aplican al fijarla.
- Una `answer` solo se acepta si el estado local es `have-local-offer`.
- Al cerrar el WebSocket se cierran todas las `RTCPeerConnection` y se limpian los mapas: sin señalización no hay sesión P2P.

Indicadores P2P en la interfaz:

| Punto | Estado | Significado |
|---|---|---|
| Gris | `new` | Aún no se intentó conectar con ese usuario. |
| Amarillo | `connecting` | Negociación ICE/SDP en curso. |
| Verde | `connected` | `RTCDataChannel` abierto; el chat va P2P. |
| Rojo | `failed` | La conexión falló (usuario desconectado o nodo inalcanzable). |

El indicador aparece junto al selector de destinatario y como punto en cada usuario del directorio.

### Enrutamiento de un mensaje

**Ruta normal (P2P):** Alice escribe a Bob → el cliente de Alice usa el `RTCDataChannel` abierto con Bob → Bob recibe el mensaje directamente. En este caso el servidor **no ve ningún `chat`**: solo `offer`/`answer`/`candidate`.

**Ruta de fallback (WebSocket):** si el canal P2P no está disponible, el mensaje sigue el enrutamiento:

1. Alice envía `chat` con `target: "bob"` a `nodo-a`.
2. `nodo-a` busca `bob` en `localUsers`; no está.
3. Lo busca en `remoteUsers` y obtiene `nodo-b`.
4. `nodo-a` envía `peer-chat` a `nodo-b` por el enlace `/peer`.
5. `nodo-b` busca `bob` en sus `localUsers`, entrega el `chat` por el socket de Bob y responde `peer-ack`.
6. `nodo-a` recibe el ack y confirma a Alice con `chat-ack` (`targetNode: "nodo-b"`).
7. Si Bob no está conectado, `nodo-a` responde `chat-error` con `reason: "offline"`.

La presencia sí se difunde, porque es información de directorio; el chat **nunca** se difunde a todos los clientes ni a todos los nodos.

### Anti-bucles y duplicados

- Un `peer-chat` o un `peer-signal` recibido de otro nodo se entrega solo a sockets locales y **nunca se reenvía** a un tercer nodo.
- Cada nodo guarda `originNode:messageId` durante 60 segundos; un `peer-chat` repetido se confirma con `peer-ack` marcado como `duplicate` sin volver a entregarlo.
- Los enlaces entre nodos son bidireccionales: ambos nodos intentan conectarse. Para enviar se prefiere el enlace saliente y el ack vuelve por el mismo socket.
- Cada mensaje cross-node tiene un timeout de confirmación (`ACK_TIMEOUT_MS`, 5 s por defecto); si vence, el cliente recibe `chat-error` con `reason: "timeout"`.

### Reconexión y heartbeat

- Cada nodo intenta reconectarse con backoff exponencial (500 ms → 8 s, con jitter).
- Cada 15 segundos se envía un ping WebSocket; si no hay pong, el socket se cierra y se dispara la reconexión.
- Al perder todos los enlaces con un nodo, se eliminan sus usuarios remotos y se fallan los mensajes pendientes hacia ese nodo.
- Al reconectar, `peer-hello` reenvía el snapshot de usuarios y el directorio se resincroniza automáticamente. Las conexiones P2P se restablecen cuando el usuario vuelve a estar presente.

## Protocolo JSON

### Cliente → nodo

| `type` | Campos | Descripción |
|---|---|---|
| `register` | `userId` | Registra el socket con un identificador estable. |
| `offer` | `sender`, `target`, `sdp` | Oferta SDP para iniciar la sesión P2P. |
| `answer` | `sender`, `target`, `sdp` | Respuesta SDP a una oferta. |
| `candidate` | `sender`, `target`, `candidate` | Candidato ICE (trickle). |
| `chat` | `messageId`, `sender`, `target`, `text` | Mensaje dirigido **solo como fallback**. |
| `who` | — | Solicita el directorio actual. |

### Nodo → cliente

| `type` | Campos | Descripción |
|---|---|---|
| `welcome` | `userId`, `node`, `users[]`, `peers[]` | Confirma el registro y entrega el directorio. |
| `presence` | `users[{ userId, node, local }]`, `peers[]` | Directorio actualizado. |
| `offer` / `answer` / `candidate` | `sender`, `target`, `sdp` \| `candidate`, `fromNode` | Señalización entregada al destinatario. |
| `signal-error` | `signalType`, `target`, `reason`, `detail`, `node` | Señal no entregada (`offline`, `peer-unreachable`, `invalid-target`, `invalid-signal`). |
| `chat` | `messageId`, `sender`, `target`, `text`, `fromNode` | Mensaje entregado por la ruta de fallback. |
| `chat-ack` | `messageId`, `target`, `targetNode`, `status` | Entrega confirmada por la ruta de fallback. |
| `chat-error` | `messageId`, `target`, `reason`, `detail` | Mensaje de fallback no entregado. |
| `error` | `code`, `detail` | Error de protocolo. |

Motivos de `chat-error`: `missing-target`, `empty-text`, `offline`, `peer-unreachable`, `timeout`, `remote-error`.

### Nodo ↔ nodo (`/peer`)

| `type` | Campos | Descripción |
|---|---|---|
| `peer-hello` | `node`, `sessionId`, `seq`, `users[]` | Saludo y snapshot de usuarios locales. |
| `peer-presence` | `node`, `sessionId`, `seq`, `event`, `userId` | Alta o baja de un usuario (`join`/`leave`). |
| `peer-signal` | `signalType`, `originNode`, `sender`, `target`, `sdp` \| `candidate` | Reenvío de señalización WebRTC entre nodos. |
| `peer-chat` | `messageId`, `originNode`, `sender`, `target`, `text`, `hops[]` | Mensaje de fallback a entregar en el nodo receptor. |
| `peer-ack` | `messageId`, `sender`, `target`, `status`, `targetNode`, `duplicate?` | Resultado de la entrega de fallback. |

Además se usan los frames `ping`/`pong` de WebSocket para detectar enlaces muertos.

### Ejemplos

Señalización (cliente → nodo):

```json
{
  "type": "offer",
  "sender": "bob",
  "target": "alice",
  "sdp": { "type": "offer", "sdp": "v=0\r\n..." }
}
```

Mensaje de chat por el `RTCDataChannel`:

```json
{
  "messageId": "8f14e45f-ceea-467a-9f0b-2b1d1c9a7f00",
  "sender": "alice",
  "text": "hola Bob",
  "timestamp": 1795829542468
}
```

Mensaje de chat por WebSocket (fallback):

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
| `server/server.js` | Punto de entrada HTTP/WebSocket, rutas de control, heartbeat y ciclo de vida. |
| `server/rooms.js` | Directorio de usuarios, presencia local y helpers de estado. |
| `server/signaling.js` | Mensajería, señalización WebRTC y enlaces entre nodos. |
| `Dockerfile` | Imagen `node:18-alpine`; copia `server/` y `public/`. |
| `docker-compose.yml` | Contenedores `nodo-a` y `nodo-b`, puertos, `PEER_NODES` y healthchecks. |
| `public/index.html` | Interfaz: directorio, destinatario, indicador P2P y chat. |
| `public/styles.css` | Estilos responsive con Flexbox/Grid y puntos de estado P2P. |
| `public/app.js` | Registro, presencia, WebRTC (Perfect Negotiation, `RTCDataChannel`), fallback WebSocket y reconexión del cliente. |

## Requisitos

- Docker Desktop o Docker Engine.
- Docker Compose v2.
- Un navegador con WebRTC (Chrome, Edge o Firefox actuales).
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
4. El panel **Directorio** lista los usuarios conectados y el nodo donde están; cada usuario muestra un punto con su estado P2P.
5. Junto al selector de destinatario aparece `P2P: conectando…` y luego `P2P: conectado` cuando el `RTCDataChannel` abre.
6. Escribir el mensaje y presionar **Enviar** o Enter. El mensaje propio muestra `enviado por RTCDataChannel` (P2P) o `enviado por WebSocket (fallback)`.
7. Los mensajes recibidos de otro nodo indican su origen (`· nodo-a`).

Los botones de llamada, colgar, mutear y cámara siguen deshabilitados: corresponden a fases posteriores (audio/video).

## Pruebas

### 1. Chat 1 a 1 por `RTCDataChannel`

Con ambos nodos activos, abrir:

- Alice: `http://localhost:3000/?user=alice&target=bob`
- Bob: `http://localhost:3001/?user=bob&target=alice`

Resultado esperado:

- El indicador de Alice y el de Bob pasan a **`P2P: conectado`** (punto verde).
- En la consola del navegador aparecen `[p2p] → offer`, `[p2p] → answer`, `[p2p] → candidate` y `[p2p] connectionState(<par>) = connected`.
- Al enviar un mensaje, Alice ve `enviado por RTCDataChannel` y Bob lo recibe.
- En los logs de los nodos **no aparece** un `"type":"chat"` para ese mensaje: solo `offer`, `answer` y `candidate`.

Comprobar que el mensaje no pasó por el servidor:

```bash
docker compose logs nodo-a | grep '"type":"chat"'
docker compose logs nodo-b | grep '"type":"chat"'
```

No debe haber líneas nuevas para el mensaje enviado por P2P. En su lugar deben verse señales:

```text
[nodo-b] Señal offer de bob reenviada a nodo-a para alice.
[nodo-a] peer-signal offer de nodo-b para alice: entregado (1).
[nodo-a] Señal answer de alice reenviada a nodo-b para bob.
[nodo-a] Señal candidate de alice reenviada a nodo-b para bob.
```

En la consola del navegador de Alice se confirma el envío:

```text
[p2p] chat 8f14e45f... enviado por RTCDataChannel a bob.
```

### 2. Fallback por WebSocket

Para forzar el fallback, abrir la consola del navegador de Alice y ejecutar:

```js
closePeerConnection('bob');
window.RTCPeerConnection = function () {
  throw new Error('P2P deshabilitado para la prueba de fallback');
};
```

Luego enviar un mensaje. Resultado esperado:

- Alice ve `enviado por WebSocket (fallback)` (en ámbar).
- Bob recibe el mensaje por la ruta WebSocket normal.
- En los logs de `nodo-a` aparece `"type":"chat"` y `reenviado a nodo-b`; en `nodo-b` aparece `peer-chat ... delivered`.
- Al confirmarse el `chat-ack`, el estado pasa a `entregado · nodo-b (fallback)`.

También se puede probar cerrando el `RTCDataChannel` sin bloquear `RTCPeerConnection`: el envío espera hasta 10 s a que reabra y, si no lo hace, usa WebSocket.

### 3. Cierre de una pestaña

Con Alice y Bob conectados por P2P, cerrar la pestaña de Bob. Resultado esperado:

- El directorio de Alice se actualiza y Bob desaparece de la lista.
- El indicador de Alice pasa a `P2P: desconectado (bob)`.
- Los mapas `peerConnections`, `dataChannels` y `pendingCandidates` quedan vacíos en la consola de Alice.
- Los nodos registran `Usuario "bob" desconectado` y actualizan `remoteUsers`.

### 4. Dos clientes en el mismo nodo

Abrir dos pestañas en `http://localhost:3000`:

- `http://localhost:3000/?user=alice&target=carol`
- `http://localhost:3000/?user=carol&target=alice`

El chat también va por `RTCDataChannel`; la señalización no sale del nodo (`Señal offer de alice -> carol (local)`). Comprobar el registro:

```bash
curl http://localhost:3000/api/state
```

Debe incluir `alice` y `carol` en `localUsers`.

### 5. Presencia, reconexión y heartbeat

Detener `nodo-b`:

```bash
docker compose stop nodo-b
```

Esperar unos segundos y comprobar que `nodo-a` ya no tiene enlaces:

```bash
curl http://localhost:3000/api/state
```

`peers` debe quedar vacío y `remoteUsers` no debe contener a `bob`. Si Alice intenta escribir a Bob, el indicador pasa a `failed` y el envío usa WebSocket, que responde `chat-error` con `reason: "offline"` o `"peer-unreachable"`.

Volver a iniciar `nodo-b`:

```bash
docker compose start nodo-b
```

En pocos segundos los enlaces se restablecen (`attempts` vuelve a 0), `peer-hello` resincroniza el directorio y el chat P2P vuelve a funcionar sin reiniciar `nodo-a`.

### 6. Destinatario desconectado

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

### 7. Prueba con `wscat` (opcional)

`wscat` sirve para probar la ruta de fallback y la señalización, no el `RTCDataChannel`.

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

Alice envía un chat de fallback:

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

Líneas esperadas en un chat P2P:

```text
[nodo-b] Señal offer de bob reenviada a nodo-a para alice.
[nodo-a] peer-signal offer de nodo-b para alice: entregado (1).
[nodo-a] Señal answer de alice reenviada a nodo-b para bob.
[nodo-b] peer-signal answer de nodo-a para bob: entregado (1).
[nodo-a] Señal candidate de alice reenviada a nodo-b para bob.
```

Líneas esperadas en un chat de fallback:

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

El STUN está fijado en el cliente (`stun:stun.l.google.com:19302`). No hay servidor TURN en esta fase.

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
- El indicador queda en `P2P: conectando…`: revisar la consola del navegador. Si no aparecen candidatos ICE, la red está bloqueando STUN/UDP; el chat seguirá funcionando por WebSocket (fallback).
- Redes con NAT simétrico o cortafuegos restrictivo pueden impedir el P2P sin un servidor TURN (no incluido en esta fase).
- Un mensaje de fallback queda en `timeout`: el nodo destino no respondió en 5 s; revisar los logs de ambos nodos.
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

**Incluido:** chat 1 a 1 por `RTCDataChannel` con Perfect Negotiation, señalización WebRTC por WebSocket (`offer`/`answer`/`candidate`), reenvío de señalización entre nodos (`peer-signal`), fallback de chat por WebSocket, dos nodos independientes, registro distribuido, presencia sincronizada, enrutamiento dirigido por `target`, confirmaciones y errores de entrega, deduplicación, heartbeat y reconexión automática.

**No incluido todavía:** audio, video, captura de cámara/micrófono, `getUserMedia`, `getDisplayMedia`, transferencia de archivos, chat grupal/multicast, autenticación con contraseñas y servidor TURN.
