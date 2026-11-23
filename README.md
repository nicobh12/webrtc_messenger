# Mensajero WebRTC — Fase 2

Infraestructura inicial del mensajero distribuido mediante dos nodos Docker (`nodo-a` y `nodo-b`), cada uno con un servidor WebSocket desarrollado en Node.js.

## Requisitos

- Docker Desktop o Docker Engine.
- Docker Compose v2.
- Node.js y npm (para instalar `wscat`).

## Estructura del proyecto

| Archivo | Descripción |
|---|---|
| `package.json` | Dependencias del proyecto (`ws`). |
| `server.js` | Servidor WebSocket de cada nodo. |
| `Dockerfile` | Configuración de la imagen Docker. |
| `docker-compose.yml` | Configuración de los dos contenedores. |

## Ejecución

Desde la raíz del proyecto, ejecutar:

```bash
docker compose up --build
````

Para comprobar que ambos contenedores están activos:

bash

```bash
docker compose ps
```

## Puertos utilizados

| Nodo | Puerto interno | Puerto del host |
| --- | --- | --- |
| `nodo-a` | 3000 | 3000 |
| `nodo-b` | 3000 | 3001 |

## Pruebas de conexión

Instalar `wscat`:

bash

```bash
npm install -g wscat
```

Probar nodo-a:

bash

```bash
wscat -c ws://localhost:3000
```

Probar nodo-b:

bash

```bash
wscat -c ws://localhost:3001
```

Una vez establecida la conexión, enviar cualquier mensaje de texto. Los servidores deben mostrar los mensajes recibidos en sus respectivos logs.

Para consultar los registros:

bash

```bash
docker compose logs -f
```

## Problemas conocidos

- `wscat: command not found`: instalar la herramienta con `npm install -g wscat`.
- `port is already allocated`: alguno de los puertos 3000 o 3001 está ocupado.
- Los mensajes no aparecen: comprobar que se está conectado al puerto correcto y revisar los logs del nodo correspondiente.

## Detener los servicios

bash

```bash
docker compose down
```

## Alcance de esta fase

Esta versión implementa únicamente la recepción y visualización de mensajes mediante WebSockets. No incluye interfaz gráfica, negociación WebRTC ni reenvío de mensajes entre nodos. Estas funcionalidades se desarrollarán en las siguientes fases.

