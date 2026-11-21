# INFORME DE INVESTIGACIÓN: FUNDAMENTOS TEÓRICOS PARA EL DESARROLLO DE UN MENSAJERO WEBRTC EN UNA ARQUITECTURA DISTRIBUIDA

## PARTE I. MARCO TEÓRICO Y FUNDAMENTACIÓN TÉCNICA

### CAPÍTULO 1. Virtualización y arquitectura de contenedores (BLOQUE A)

#### 1.1. Concepto y evolución de la virtualización
La virtualización es una tecnología fundamental en la arquitectura de sistemas distribuidos moderna que permite abstraer y desacoplar los recursos informáticos físicos (CPU, memoria RAM, almacenamiento y dispositivos de red) de los entornos de ejecución de software. Históricamente, la computación se ejecutaba directamente sobre hardware "bare-metal", lo que generaba problemas severos de subutilización de recursos, rigidez operativa y dificultades de aislamiento entre diferentes procesos del sistema operativo [1]. La introducción de capas de abstracción permitió subdividir un servidor físico en múltiples entornos independientes, transformando la administración de infraestructura de una gestión puramente física a una gestión declarativa y definida por software [2].

En el ámbito de la ingeniería de sistemas distribuidos, la virtualización proporciona la base técnica para la replicación de nodos, el despliegue reproducible de servicios y el aislamiento de fallos. Existen dos paradigmas dominantes para lograr esta abstracción: la virtualización completa basada en hipervisores (Máquinas Virtuales) y la virtualización a nivel de sistema operativo (Contenedores) [3].

#### 1.2. Virtualización completa e Hipervisores (Tipo 1 y Tipo 2)
La virtualización tradicional o completa se fundamenta en un componente denominado hipervisor o Monitor de Máquinas Virtuales (VMM). El hipervisor emula una arquitectura de hardware completa, permitiendo que cada máquina virtual (MV) ejecute su propio sistema operativo huésped (Guest OS) completamente independiente del sistema operativo anfitrión (Host OS) [2].

Los hipervisores se clasifican formalmente en dos categorías:
*   **Hipervisores Tipo 1 (Bare-Metal o Nativos):** Se ejecutan directamente sobre el hardware físico subyacente sin necesidad de un sistema operativo anfitrión intermedio. Ejemplos representativos incluyen VMware ESXi, KVM (Kernel-based Virtual Machine) y Microsoft Hyper-V [2]. Ofrecen el máximo rendimiento, menor latencia de emulación y eficiencia a nivel empresarial, siendo el estándar en centros de datos.
*   **Hipervisores Tipo 2 (Hosted o Alojados):** Se ejecutan como una capa de aplicación sobre un sistema operativo anfitrión existente (como Windows, Linux o macOS). Ejemplos comunes incluyen Oracle VirtualBox y VMware Workstation [4]. En esta arquitectura, las peticiones de recursos del Guest OS deben pasar primero por el hipervisor, luego por el Host OS y finalmente al hardware, lo que introduce un overhead computacional significativamente mayor.

Cada máquina virtual instanciada encapsula no solo la aplicación y sus dependencias, sino también la imagen completa de un sistema operativo huésped, con su kernel, controladores de dispositivos, tablas de páginas de memoria y servicios de sistema [5]. Esto garantiza un aislamiento de nivel de hardware extremadamente fuerte: un fallo catastrófico (como un kernel panic) en una MV no impacta a las demás MVs ni al anfitrión. Sin embargo, esta rigidez implica un consumo elevado de almacenamiento (imágenes de varios Gigabytes), alto consumo de memoria RAM reservada y tiempos de arranque lentos que oscilan entre decenas de segundos y varios minutos [1].

#### 1.3. Virtualización a nivel de Sistema Operativo: Contenedores Docker
A diferencia de la virtualización completa, la contenerización no emula hardware ni ejecuta múltiples kernels de sistemas operativos. En su lugar, utiliza virtualización a nivel de sistema operativo, compartiendo el kernel del sistema operativo anfitrión entre todos los contenedores aislados [3]. Un contenedor es un proceso liviano y aislado que encapsula exclusivamente el código de la aplicación, sus bibliotecas, binarios y archivos de configuración necesarios para su ejecución [5].

La tecnología subyacente en el kernel de Linux que posibilita este aislamiento se apoya en dos características principales:
1.  **Namespaces (Espacios de Nombres):** Proporcionan el aislamiento de visibilidad de recursos. Docker utiliza namespaces para IPC (comunicación entre procesos), PID (árbol de procesos), NET (interfaces y tablas de enrutamiento de red), MNT (puntos de montaje de archivos) y UTS (nombres de host y dominio).
2.  **Control Groups (cgroups):** Asignan y limitan el consumo de recursos físicos (CPU, memoria RAM, I/O de disco) entre los contenedores, evitando que un único contenedor sature el nodo anfitrión.

La arquitectura de Docker se compone de varios elementos esenciales:
*   **Docker Engine:** Es el software cliente-servidor responsable de crear, ejecutar y administrar contenedores. Consiste en un demonio en segundo plano (`dockerd`), una API REST de administración y la interfaz de línea de comandos (CLI) [5].
*   **Imágenes Docker:** Son plantillas de solo lectura compuestas por capas superpuestas e inmutables (utilizando sistemas de archivos como Overlay2). Cada instrucción en un `Dockerfile` crea una nueva capa en la imagen [4].
*   **Contenedores Docker:** Son las instancias ejecutables de una imagen. Al arrancar un contenedor, Docker añade una capa de lectura/escritura (container layer) sobre las capas estáticas de la imagen.
*   **Dockerfile:** Es un archivo de texto estructurado que contiene las instrucciones secuenciales para construir una imagen de manera reproducible. Entre sus directivas principales destacan: `FROM` (define la imagen base), `WORKDIR` (establece el directorio de trabajo), `COPY`/`ADD` (transfiere archivos al contenedor), `RUN` (ejecuta comandos en tiempo de construcción), `EXPOSE` (informa los puertos de red de escucha) y `CMD`/`ENTRYPOINT` (establece el proceso principal que se ejecutará al iniciar el contenedor) [4].

#### 1.4. Análisis Comparativo: Máquinas Virtuales vs. Contenedores
Para seleccionar la infraestructura óptima en un entorno de comunicación en tiempo real distribuido, es imprescindible evaluar analíticamente las diferencias estructurales entre Máquinas Virtuales y Contenedores Docker [1]:

| Criterio de Comparación | Máquinas Virtuales (Virtualización Completa) | Contenedores Docker (Nivel de SO) |
| :--- | :--- | :--- |
| **Nivel de Abstracción** | Hardware y BIOS emulados mediante Hipervisor [2] | Sistema Operativo y Kernel compartido [3] |
| **Encapsulación** | Kernel completo + OS Huésped + Bibliotecas + App [5] | Solo Código de App + Bibliotecas + Dependencias [3] |
| **Aislamiento** | Fuerte a nivel de hardware/kernel independiente [1] | Aislamiento a nivel de procesos y namespaces de Linux [3] |
| **Consumo de Recursos** | Alto (requiere Gigabytes de RAM y almacenamiento asignado) [5] | Mínimo (medido en Megabytes, comparte RAM del Host) [5] |
| **Tiempo de Arranque** | Lento (minutos u orden de decenas de segundos) [1] | Casi instantáneo (milisegundos a segundos) [1] |
| **Portabilidad** | Limitada por formatos de hipervisor y tamaño de disco (GB) [5] | Granular y universal (imágenes ligeras portables) [3] |

#### 1.5. Arquitectura de Redes en Docker y Docker Compose
La conectividad en contenedores Docker está gestionada por controladores de red (network drivers) abstractos que definen cómo se enrutan los paquetes entre los contenedores y el mundo exterior [6]:

1.  **Bridge Network (Default):** Es el controlador predeterminado para contenedores independientes. Docker crea un puente de red virtual (normalmente `docker0`) dentro del kernel anfitrión. Cada contenedor conectado a la red bridge recibe una IP privada en una subred aislada (ej. `172.17.0.0/16`). Los contenedores en la misma red bridge pueden comunicarse entre sí, pero están aislados del host a menos que se mapeen sus puertos [6].
2.  **Host Network:** El contenedor elimina la separación de red y comparte directamente el stack de red y las interfaces del anfitrión. Esto elimina el overhead de traducción de direcciones de red (NAT), logrando el máximo rendimiento de red, aunque sacrifica el aislamiento de puertos [4].
3.  **Overlay Network:** Permite la comunicación transparente enrutada entre contenedores ejecutados en múltiples hosts Docker independientes o clústeres Swarm/Kubernetes, creando una red superpuesta distribuida [6].
4.  **None:** Deshabilita completamente la interfaz de red dentro del contenedor, dejando solo la interfaz loopback.

##### Diferencia entre Exponer (`EXPOSE`) y Publicar (`PUBLISH`) Puertos
Un concepto crítico en la configuración de seguridad y networking en Docker es la distinción entre `EXPOSE` y `PUBLISH`:
*   **Exponer (`EXPOSE` en Dockerfile):** Es un mecanismo puramente documental y declarativo. Indica qué puertos escucha la aplicación internamente dentro del contenedor. No abre ni reenvía ningún puerto en el host anfitrión ni lo hace accesible externamente [7].
*   **Publicar (`PUBLISH` / `-p` o directiva `ports`):** Es una acción de tiempo de ejecución que crea una regla de iptables en el host anfitrión, mapeando un puerto del host a un puerto expuesto del contenedor (ejemplo: `8080:80`). Esto hace que el servicio dentro del contenedor sea accesible para clientes externos en la red física del host [7].

##### Resolución de Nombres y Servicio DNS Interno de Docker
En las redes personalizadas creadas por los usuarios (o generadas automáticamente por Docker Compose), Docker integra un servidor DNS embebido en el daemon (IP `127.0.0.11`). Este DNS interno permite que los contenedores se descubran e interconecten utilizando únicamente sus nombres de servicio o nombres de contenedor como nombres de host FQDN (Fully Qualified Domain Name), eliminando la necesidad de hardcodear direcciones IP dinámicas en el código fuente de la aplicación [6].

##### Función de Docker Compose
Docker Compose es una herramienta de orquestación declarativa diseñada para definir y ejecutar aplicaciones compuestas por múltiples contenedores mediante un archivo estructurado `docker-compose.yml` [4]. En este archivo se declaran:
*   `services`: Los contenedores que componen la aplicación, sus imágenes, variables de entorno y comandos de inicio.
*   `networks`: Las redes virtuales personalizadas que interconectan los servicios aisladamente.
*   `volumes`: Los volúmenes de almacenamiento persistente montados desde el host a los contenedores.

#### 1.6. Justificación Técnica del Despliegue del Mensajero WebRTC en Contenedores
Para el desarrollo del mensajero WebRTC distribuido del laboratorio, la utilización de contenedores Docker frente a Máquinas Virtuales se justifica técnicamente por las siguientes razones:
1.  **Reproducibilidad Estricta y Despliegue Declarativo:** Mediante `docker-compose up`, es posible instanciar dos nodos distribuidos independientes en cuestión de segundos en cualquier sistema operativo, garantizando que el entorno de ejecución del servidor de señalización y las dependencias web sean idénticas sin intervención manual [4].
2.  **Eficiencia en el Uso de Recursos:** Ejecutar dos nodos completos en Máquinas Virtuales independientes sobre una sola máquina de desarrollo consumiría varios Gigabytes de memoria RAM y núcleos de CPU dedicados. Los contenedores Docker comparten el kernel anfitrión, reduciendo drásticamente la huella de memoria y permitiendo la ejecución fluida de múltiples nodos distribuidos en un mismo equipo anfitrión [5].
3.  **Aislamiento y Enrutamiento por Nombre:** Las redes de Docker Compose permiten simular dos nodos físicamente independientes con sus propios servidores de señalización en contenedores distintos, interconectados mediante una red privada virtual de Docker donde el descubrimiento mutuo se realiza de forma limpia por nombre de servicio mediante el DNS embebido [6].


### CAPÍTULO 2. Fundamentos de WebRTC y establecimiento de conexiones (BLOQUE B)

#### 2.1. Concepto y Arquitectura de WebRTC
WebRTC (Web Real-Time Communication) es un marco tecnológico de código abierto y un conjunto de estándares mantenidos conjuntamente por el W3C (World Wide Web Consortium) a nivel de APIs de navegador y por el IETF (Internet Engineering Task Force) a nivel de protocolos de red (grupo RTCWEB) [8]. Su objetivo primordial es posibilitar la comunicación enriquecida en tiempo real —que incluye audio, video streaming y transferencia de datos arbitrarios— directamente entre navegadores web o dispositivos móviles sin requerir la instalación de plugins o software de terceros [8].

A diferencia de las arquitecturas cliente-servidor tradicionales orientadas a la web (donde todo el tráfico fluye obligatoriamente a través de un servidor centralizado), WebRTC adopta una arquitectura Peer-to-Peer (P2P) para la transmisión del flujo de medios y datos una vez establecida la sesión [9]. Esta arquitectura de par a par minimiza la latencia de transporte, optimiza el consumo de ancho de banda en los servidores de la infraestructura y mejora la confidencialidad extremo a extremo mediante el cifrado obligatorio de todas las sesiones de comunicación mediante DTLS (Datagram Transport Layer Security) y SRTP (Secure Real-time Transport Protocol) [8].

#### 2.2. Necesidad de la Señalización en Arquitecturas P2P
Aunque la comunicación final de medios en WebRTC se realiza directamente entre los pares, dos navegadores no pueden conectarse de manera espontánea por sí mismos. Antes de iniciar la conexión directa, ambos nodos desconocen la dirección IP pública del otro, las características de red en las que están inmersos (presencia de firewalls, NATs) y las capacidades multimedia que soportan (códecs de audio/video disponibles, resoluciones) [9].

Por lo tanto, WebRTC requiere una fase previa denominada **Señalización** [9]. La señalización se realiza a través de un servidor intermediario de acceso público (Servidor de Señalización). Es crucial destacar que la especificación de WebRTC intencionalmente **no define un protocolo de señalización obligatorio** [10]. Esta decisión de diseño permite a los desarrolladores utilizar cualquier protocolo de aplicación existente (como WebSockets, SIP, XMPP, MQTT o REST HTTP) según los requerimientos de la aplicación [4].

La información que debe intercambiarse a través del canal de señalización incluye:
1.  **Parámetros de Sesión Multimedia (SDP):** Ofertas y Respuestas que describen los canales de audio, video, datos, direcciones de transporte y códecs soportados.
2.  **Candidatos ICE (Connectivity Candidates):** Las posibles rutas de red (direcciones IP y puertos local, server-reflexive y relay) descubiertas por cada cliente.
3.  **Mensajes de Control de Sesión:** Notificaciones de inicio, aceptación, rechazo o finalización de llamadas.

#### 2.3. El Rol de RTCPeerConnection y la Negociación SDP (Offer/Answer)
El componente central de la API JavaScript de WebRTC en el cliente es la interfaz `RTCPeerConnection` [11]. Este objeto gestiona todo el ciclo de vida de la conexión entre pares: la captura y asociación de pistas multimedia (`MediaStreamTrack`), el cifrado de datos, el descubrimiento de rutas de red y la supervisión del estado del canal.

##### Proceso de Negociación SDP (Session Description Protocol)
El intercambio de capacidades multimedia y de transporte en WebRTC se formaliza mediante el estándar SDP (RFC 4566 / JSEP - RFC 9429) utilizando el modelo de Oferta/Respuesta (Offer/Answer model) [8]:

1.  **Inicio de la Oferta:** El Cliente A invoca `peerConnection.createOffer()`, lo que genera una cadena de texto estructurada en formato SDP que contiene los metadatos de su sesión local (códecs aceptados, resolución, parámetros de audio/video y canales de datos) [11].
2.  **Establecimiento de Descripción Local A:** El Cliente A establece dicha oferta como su descripción local mediante `peerConnection.setLocalDescription(offer)`. Esto cambia el estado interno del objeto a `have-local-offer` [8].
3.  **Transmisión de la Oferta:** El Cliente A transmite la estructura SDP Offer al Cliente B a través del canal de señalización (WebSocket).
4.  **Recepción en el Par Remoto B:** El Cliente B recibe la Oferta y la aplica como su descripción remota mediante `peerConnection.setRemoteDescription(offer)`. El estado de su `RTCPeerConnection` pasa a `have-remote-offer` [8].
5.  **Generación de la Respuesta:** El Cliente B invoca `peerConnection.createAnswer()`, generando un SDP Answer ajustado que refleja la intersección de las capacidades compatibles entre ambos extremos [8].
6.  **Establecimiento de Descripción Local B:** El Cliente B aplica la respuesta localmente con `peerConnection.setLocalDescription(answer)`, volviendo su estado de señalización a `stable` [8].
7.  **Transmisión de la Respuesta:** El Cliente B envía el SDP Answer de vuelta al Cliente A a través de la señalización.
8.  **Finalización de Negociación en A:** El Cliente A recibe la respuesta y ejecuta `peerConnection.setRemoteDescription(answer)`. Al completarse, ambas partes alcanzan el estado `stable`, consolidando la negociación de parámetros de la sesión multimedia [8].

#### 2.4. Travesía de NAT e Infraestructura ICE: STUN y TURN
El mayor desafío para establecer una conexión P2P directa en la Internet real es la existencia de dispositivos NAT (Network Address Translation) y Firewalls [9]. La mayoría de los dispositivos de usuario residen en redes privadas (con direccionamiento IPv4 privado como `192.168.x.x` o `10.x.x.x`), los cuales no son directamente enrutables desde la Internet pública. Además, los routers NAT cambian dinámicamente los números de puerto durante la traducción, impidiendo que un nodo remoto inicie una conexión directa sin un mapeo previo.

Para resolver este problema, WebRTC utiliza el framework **ICE (Interactive Connectivity Establishment - RFC 8445)** en combinación con servidores de asistencia **STUN** y **TURN** [9].

##### 1. Servidores STUN (Session Traversal Utilities for NAT)
Un servidor STUN es un recurso liviano ubicado en la red pública cuyo único propósito es responder a las consultas de los clientes informándoles cuál es su dirección IP pública externa y qué puerto ha asignado su router NAT para esa sesión (Server Reflexive Candidate) [9]. STUN no interviene en la transmisión de datos multimedia; solo ayuda al descubrimiento del mapeo externo de puertos. Funciona con éxito en la mayoría de los escenarios NAT simples (Full Cone, Restricted Cone).

##### 2. Servidores TURN (Traversal Using Relays around NAT)
Cuando ambos nodos están detrás de firewalls corporativos restrictivos o redes con NAT de tipo simétrico (Symmetric NAT) —donde el puerto mapeado por el NAT cambia para cada destino remoto diferente— la conexión P2P directa es matemáticamente imposible [9]. En estos escenarios de falla de conectividad P2P, ICE recurre a un servidor **TURN**. Un servidor TURN actúa como un punto de retransmisión (relay) intermedio de tráfico de medios con ancho de banda asignado en la nube. Aunque la conexión deja de ser técnicamente P2P directa (el tráfico fluye Cliente A -> TURN -> Cliente B), la sesión sigue estando totalmente cifrada extremo a extremo a nivel de capa de aplicación mediante DTLS/SRTP [9].

##### Tipos de Candidatos ICE y el Proceso Trickle ICE
Durante el proceso de descubrimiento, la infraestructura ICE recopila tres tipos de candidatos de conectividad para cada nodo [9]:
*   **Host Candidate (Candidato Anfitrión):** Direcciones IP físicas o virtuales asociadas directamente a las tarjetas de red locales del dispositivo (ej. IP `192.168.1.50`).
*   **Server Reflexive Candidate (srflx):** La combinación de IP pública y puerto asignada por el router NAT, obtenida mediante consulta al servidor STUN [8].
*   **Relay Candidate (relay):** La dirección IP y puerto asignados dinámicamente en el servidor TURN para conmutar el tráfico si las rutas directas fallan [8].

##### Trickle ICE
En las primeras implementaciones de WebRTC, los clientes esperaban a recopilar todos los candidatos ICE posibles antes de enviar el SDP, lo que introducía demoras de varios segundos. Las especificaciones modernas utilizan **Trickle ICE** [9]. Bajo Trickle ICE, tan pronto como la `RTCPeerConnection` descubre un candidato individual, dispara el evento `icecandidate`. El script del cliente envía inmediatamente ese candidato al nodo remoto a través del canal de señalización. El par remoto invoca `peerConnection.addIceCandidate(candidate)` en tiempo real, permitiendo que las pruebas de conectividad de red se ejecuten en paralelo mientras continúa la recolección, logrando un establecimiento de llamada casi instantáneo [9].

#### 2.5. Diferencias Estructurales entre Pistas Multimedia y Canales de Datos
Dentro de una sesión WebRTC establecida a través de `RTCPeerConnection`, coexisten dos tipos fundamentales de flujos de transporte:

1.  **Pistas de Medios (Media Streams / Tracks):** Diseñadas para flujos continuos en tiempo real de audio y video. Utilizan el protocolo **SRTP (Secure Real-time Transport Protocol)** sobre UDP. Favorecen la baja latencia por encima de la entrega confiable perfecta; si un paquete de video se pierde en la red, se descarta para no retrasar los fotogramas posteriores [12].
2.  **Canales de Datos (RTCDataChannel):** Diseñados para el intercambio bidireccional de datos binarios o texto (mensajes de chat, transferencias de archivos, señalización in-band). Utilizan el protocolo **SCTP (Stream Control Transport Protocol)** encapsulado sobre **DTLS** y UDP [13]. Permiten configurar modos de entrega estrictamente fiables y ordenados (estilo TCP) o no fiables y desordenados (estilo UDP) según las necesidades de la aplicación.

### CAPÍTULO 3. Señalización y comunicación mediante WebSocket (BLOQUE C)

#### 3.1. Arquitectura del Servidor de Señalización en WebRTC
La señalización es la arteria de control que coordina el descubrimiento y la negociación de parámetros de sesión entre los nodos distribuidos de WebRTC [9]. Dado que WebRTC no impone una arquitectura de señalización rígida, la topología del servidor de señalización se diseña en función de la escala y requerimientos del sistema.

En el contexto del mensajero distribuido del laboratorio, la arquitectura de señalización opera mediante una topología distribuida o centralizada de intermediación de mensajes [4]. El servidor de señalización actúa como un conmutador de mensajes: mantiene un registro activo de los clientes conectados (normalmente mediante identificadores de sesión o salas), recibe los objetos JSON que contienen las ofertas (`offer`), respuestas (`answer`) y candidatos de red (`icecandidate`), y los enruta al destinatario objetivo [10].

#### 3.2. El Protocolo WebSocket (RFC 6455): Funcionamiento y Handshake HTTP Upgrade
Para implementar la capa de señalización, el protocolo estándar de facto en la web moderna es **WebSocket (RFC 6455)** [14]. WebSocket es un protocolo de capa de aplicación que proporciona canales de comunicación **full-duplex, bidireccionales y de larga duración (persistentes)** sobre una única conexión TCP subyacente [14].

##### El Proceso de Handshake HTTP Upgrade
WebSocket está diseñado para funcionar sobre los puertos estándar de la web (80 para `ws://` y 443 para `wss://` cifrado con TLS), lo que garantiza una excelente compatibilidad con proxies e infraestructura de red existente [14]. Para establecer una conexión WebSocket, el cliente realiza primero un proceso de negociación o **Handshake HTTP Upgrade** [15]:

1.  **Petición del Cliente (HTTP GET):** El navegador envía una solicitud HTTP convencional especificando los encabezados de actualización:
    *   `GET /signaling HTTP/1.1`
    *   `Host: signaling.server.com`
    *   `Upgrade: websocket`
    *   `Connection: Upgrade`
    *   `Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==`
    *   `Sec-WebSocket-Version: 13`
2.  **Validación y Respuesta del Servidor (HTTP 101):** El servidor de señalización recibe la solicitud, valida la clave `Sec-WebSocket-Key` concatenándola con un GUID estándar (`258EAFA5-E914-47DA-95CA-C5AB0DC85B11`) y calculando su hash SHA-1 codificado en Base64 (`Sec-WebSocket-Accept`). Si es válido, responde con el código de estado `101 Switching Protocols`:
    *   `HTTP/1.1 101 Switching Protocols`
    *   `Upgrade: websocket`
    *   `Connection: Upgrade`
    *   `Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=`
3.  **Transición de Protocolo:** Inmediatamente después de enviar el código 101, la conexión TCP subyacente abandona las reglas del protocolo HTTP y pasa al encuadre binario ligero del protocolo WebSocket [14]. A partir de este instante, tanto el cliente como el servidor pueden transmitir tramas de texto o binarias de forma asíncrona sin el overhead de los encabezados HTTP [14].

#### 3.3. Comparativa Técnica de Alternativas de Comunicación en Tiempo Real
Para justificar la elección de WebSocket sobre otras tecnologías de comunicación en tiempo real, se presenta una matriz comparativa detallada basada en las fuentes documentales [16], [17], [15]:

| Protocolo / Técnica | Modelo de Dirección | Transporte Subyacente | Persistencia de Conexión | Overhead por Mensaje | Complejidad de Implementación | Casos de Uso Ideales |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **HTTP Tradicional** | Unidireccional (Request-Response) | TCP | Transitoria / Reutilizable | Muy Alto (Encabezados HTTP completos) | Muy Baja | Carga de páginas, REST APIs, formularios [15] |
| **HTTP Long Polling** | Simula Bidireccional | TCP | Múltiples Peticiones HTTP continuas | Alto (Re-envío de encabezados HTTP) | Media | Sistemas legados sin soporte WebSocket [17] |
| **Server-Sent Events (SSE)** | Unidireccional (Server -> Client) | HTTP / TCP | Conexión Única de larga duración | Bajo (Formato `text/event-stream`) | Baja | Dashboards, feeds de noticias, alertas [17] |
| **WebSocket (RFC 6455)** | Full-Duplex (Bidireccional) | TCP (puertos 80/443) | Conexión Persistente Única | Mínimo (2-10 bytes de framing) | Media | Chat en tiempo real, Señalización WebRTC, Juegos [15] |
| **MQTT** | Full-Duplex (Pub/Sub) | TCP | Persistente | Extremadamente Bajo | Alta en Web (requiere proxy WS) | Telemetría IoT, redes con restricciones [16] |
| **WebTransport** | Full-Duplex Multiplexado | HTTP/3 (UDP / QUIC) | Persistente Multiplexada | Muy Bajo | Alta (Experimental) | Aplicaciones web de ultra baja latencia [16] |

##### Justificación de WebSocket frente a Alternativas
*   **Frente a HTTP Polling / Long Polling:** El polling periódico introduce una latencia inaceptable y consume recursos de forma masiva en el servidor al enviar constantemente encabezados HTTP repetitivos. WebSocket elimina este overhead al mantener un solo socket TCP abierto con una trama de encuadre de apenas un par de bytes [14].
*   **Frente a Server-Sent Events (SSE):** SSE es un protocolo estrictamente unidireccional (servidor a cliente). Dado que la señalización WebRTC requiere que el cliente también envíe información al servidor (Ofertas SDP, Candidatos ICE localmente generados), SSE exigiría abrir conexiones HTTP POST adicionales para el tráfico ascendente, complicando la arquitectura frente al canal bidireccional nativo de WebSocket [16].

#### 3.4. Diseño del Formato de Mensajes de Señalización para el Mensajero
Para la arquitectura del laboratorio, el intercambio de datos a través del WebSocket de señalización se estructura mediante mensajes JSON fuertemente tipados. A continuación se proponen los esquemas representativos para las operaciones principales:

##### 1. Registro de Nodo / Cliente
```json
{
  "type": "register",
  "sender": "nodo_alfa",
  "roomId": "sala_utp_01"
}
```

##### 2. Transmisión de Oferta SDP (SDP Offer)
```json
{
  "type": "offer",
  "sender": "nodo_alfa",
  "target": "nodo_beta",
  "sdp": {
    "type": "offer",
    "sdp": "v=0\r\no=- 4239847239 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\na=group:BUNDLE 0 1\r\n..."
  }
}
```

##### 3. Transmisión de Candidato ICE (Trickle ICE)
```json
{
  "type": "candidate",
  "sender": "nodo_alfa",
  "target": "nodo_beta",
  "candidate": {
    "candidate": "candidate:84216235 1 udp 2122260223 192.168.1.50 54321 typ host generation 0",
    "sdpMid": "0",
    "sdpMLineIndex": 0
  }
}
```


#### 4.1. APIs Multimedia en el Navegador: `MediaDevices` y `getUserMedia()`
La captura de audio y video local en aplicaciones web modernas está estandarizada por la especificación W3C **Media Capture and Streams API** [18]. La puerta de entrada para interactuar con el hardware de medios del usuario es la interfaz `navigator.mediaDevices` [18].


#### 4.2. Modelo de Permisos y Restricciones de Seguridad: Contexto Seguro (Secure Contexts)
Dado que el acceso a la cámara y al micrófono involucra serios riesgos de privacidad y seguridad para el usuario, los navegadores imponen políticas de seguridad estrictas antes de otorgar acceso a `getUserMedia()` [18]:

1.  **Requisito de Contexto Seguro (Secure Context):** El API `navigator.mediaDevices` **solo está definido y accesible cuando la página web se carga en un contexto seguro** [18]. Un contexto seguro se limita estrictamente a:
    *   Páginas servidas a través del protocolo HTTPS cifrado con un certificado TLS válido.
    *   Páginas cargadas localmente mediante el origen `localhost` o la dirección IP de bucle invertido `127.0.0.1`.
    *   Archivos locales cargados bajo el esquema `file://`.
    *   *Implicación Crítica:* Si una aplicación web se despliega en una IP privada de red local sin HTTPS, el navegador establecerá `navigator.mediaDevices` como `undefined`, bloqueando por completo la captura de video y audio [18].
2.  **Consentimiento Explícito del Usuario:** La ejecución de `getUserMedia()` despliega una ventana emergente nativa del navegador requiriendo la autorización explícita del usuario [18]. Si el usuario deniega el permiso, la promesa devuelta por el API es denegada inmediatamente con la excepción `NotAllowedError` [18].
3.  **Permissions Policy (Encabezados HTTP):** Las aplicaciones alojadas en iFrames o dominios específicos deben estar habilitadas mediante políticas de permisos HTTP como `Permissions-Policy: camera=(self), microphone=(self)` [18].


#### 4.3. Captura Multimedia en Entornos Virtualizados y Contenedores Docker
Un punto técnico vital para la arquitectura del laboratorio es entender la diferencia entre dónde se ejecuta el servidor y dónde ocurre la captura multimedia:

##### Contenedores Docker y Acceso a Hardware
Un contenedor Docker se ejecuta sobre un entorno aislado sin acceso directo a los dispositivos de hardware del host anfitrión (como cámaras USB o tarjetas de sonido) a menos que se mapeen explícitamente mediante flags de privilegios como `--device /dev/video0` [4]. Sin embargo, en una arquitectura WebRTC web estándar, **el contenedor Docker solo ejecuta el servidor web y el servidor de señalización** (Node.js, Python, etc.) [10].

##### Ubicación de la Captura Multimedia
La captura multimedia (`getUserMedia()`) **siempre ocurre en el cliente, dentro del navegador web del usuario anfitrión** [19]. El código JavaScript cliente descargado desde el contenedor se ejecuta localmente en el motor del navegador (Chrome, Firefox, Edge). Por ende, el navegador cliente accede a los controladores de cámara locales del equipo físico sin importar que el servidor de la aplicación esté corriendo dentro de un contenedor Docker aislado.

Si el sistema se desplegara en Máquinas Virtuales donde el navegador web se ejecutara *dentro* de la propia máquina virtual, sería necesario configurar el passthrough de dispositivos USB en el hipervisor (VirtualBox/VMware) para redirigir la cámara web física hacia el sistema operativo huésped de la MV [4].

#### 4.4. Integración de Pistas Multimedia en `RTCPeerConnection`
Una vez obtenido el `MediaStream` local mediante `getUserMedia()`, las pistas individuales (`MediaStreamTrack`) deben adjuntarse al objeto `RTCPeerConnection` para ser codificadas y transmitidas al nodo remoto [11]. Al invocar `addTrack()`, la `RTCPeerConnection` crea un objeto `RTCRtpTransceiver` responsable de gestionar el envío y la recepción del flujo RTP para esa pista específica [8]. En el extremo receptor, la `RTCPeerConnection` remota dispara el evento `ontrack`, entregando la `MediaStreamTrack` recibida para asignarla al elemento HTML `<video>` o `<audio>` mediante `videoElement.srcObject = event.streams[0]` [19].


#### 4.5. Códecs de Audio y Video en WebRTC: VP8, VP9, H.264 y Opus
Un códec (codificador-decodificador) es el algoritmo encargado de comprimir el flujo de datos brutos de audio o video en el emisor para su transmisión eficiente a través de la red y descomprimirlo en el receptor en tiempo real [4].

Las especificaciones IETF para WebRTC (RFC 7742 para video y RFC 7874 para audio) imponen que **todos los navegadores compatibles con WebRTC deben soportar obligatoriamente** los siguientes códecs base [12]:

##### 1. Códecs de Video
*   **VP8 (RFC 7742 - Mandatorio):** Desarrollado originalmente por On2 Technologies y liberado por Google como royalty-free. Ofrece una excelente calidad de compresión con un consumo computacional balanceado de CPU. Es el códec universal garantizado en todas las plataformas WebRTC [12].
*   **H.264 / AVC (RFC 7742 - Constrained Baseline Profile - Mandatorio):** Estándar industrial ampliamente extendido. Su ventaja competitiva principal es que cuenta con aceleración por hardware en la inmensa mayoría de procesadores de dispositivos móviles y tarjetas gráficas, reduciendo significativamente la carga de CPU y el consumo de batería. Sin embargo, está sujeto a licencias de patentes del consorcio MPEG-LA [12].
*   **VP9 (Opcional / Ampliamente Soportado):** Evolución de VP8 creada por Google. Proporciona una eficiencia de compresión aproximadamente 50% superior a VP8 para la misma calidad de video, haciendo posible transmisiones HD (720p/1080p) en conexiones con ancho de banda limitado, a costa de un incremento sustancial en el uso de CPU para la codificación [12].

##### 2. Códecs de Audio
*   **Opus (RFC 7874 - Mandatorio):** Es el estándar de oro indiscutible para audio interactivo en tiempo real en la web. Opus es un códec completamente abierto y libre de royalties que combina las tecnologías de SILK (para voz humana) y CELT (para música). Destaca por su versatilidad extrema: adapta su tasa de bits dinámicamente desde 6 kbps hasta 510 kbps, soporta frecuencias de muestreo desde 8 kHz hasta 48 kHz (banda ancha completa) y opera con latencias ultra bajas de entre 5 ms y 20 ms [12].
*   **G.711 (PCMA / PCMU - Mandatorio):** Códec legado de telefonía tradicional (PCM sin compresión a 64 kbps). Se mantiene exclusivamente para garantizar la interoperabilidad con sistemas de telefonía PSTN y VoIP antiguos [12].

##### Matriz Comparativa de Códecs
| Códec | Tipo | Eficiencia de Compresión | Consumo de CPU | Compatibilidad en Navegadores | Estado de Licencia |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Opus** | Audio | Alta (Adaptable 6-510 kbps) | Bajo a Medio | Universal (Mandatorio RFC 7874) | Libre de Royalties / Código Abierto [12] |
| **VP8** | Video | Media-Alta | Medio (Balanceado) | Universal (Mandatorio RFC 7742) | Libre de Royalties (Google) [12] |
| **H.264** | Video | Media-Alta | Muy Bajo (Aceleración por HW) | Universal (Constrained Baseline) | Sujeto a Patentes (MPEG-LA) [12] |
| **VP9** | Video | Muy Alta (~50% superior a VP8) | Alto | Muy Amplia (Chrome, Firefox, Edge) | Libre de Royalties (Google) [12] |

#### 4.6. Consideraciones de Ancho de Banda y Calidad
El consumo de ancho de banda en una videollamada WebRTC varía en función de la resolución seleccionada, la tasa de fotogramas (FPS) y la complejidad del movimiento en la escena:

*   **Videollamada 480p (VGA - 640x480 a 30 FPS):** Requiere un ancho de banda sostenido de entre **500 kbps y 1 Mbps** para el flujo de video (utilizando VP8/H.264), más aproximadamente **30-50 kbps** para la pista de audio comprimida con Opus [4].
*   **Videollamada 720p (HD - 1280x720 a 30 FPS):** Requiere un ancho de banda sostenido de entre **1.5 Mbps y 2.5 Mbps** para el video en VP8/H.264 (o aproximadamente **1.0 - 1.5 Mbps** si se utiliza VP9), más **50-64 kbps** para el audio en alta fidelidad [4].


### CAPÍTULO 5. Transferencia de datos mediante RTCDataChannel (BLOQUE E)

#### 5.1. Qué es `RTCDataChannel` y su Arquitectura de Protocolos (SCTP sobre DTLS/UDP)
`RTCDataChannel` es la interfaz de la API WebRTC que permite el intercambio bidireccional y de baja latencia de datos arbitrarios de aplicación (texto UTF-8 y binarios `ArrayBuffer`, `ArrayBufferView` o `Blob`) directamente entre pares [13]. A diferencia de las pistas multimedia que transportan medios sobre SRTP, el `RTCDataChannel` abstrae un transporte de datos genérico de altísimo rendimiento [13].

##### El Stack de Protocolos de `RTCDataChannel`
La arquitectura de red que sustenta a `RTCDataChannel` está estructurada en una pila de protocolos de capas superpuestas [13]:

1.  **UDP (User Datagram Protocol):** Proporciona el transporte sin conexión y atraviesa dispositivos NAT tras el proceso de punching de agujeros de ICE [19].
2.  **DTLS (Datagram Transport Layer Security):** Proporciona confidencialidad, autenticidad e integridad mediante cifrado TLS sobre datagramas UDP, derivando las claves de sesión mediante certificados autofirmados [13].
3.  **SCTP (Stream Control Transport Protocol - RFC 8831 / RFC 8832):** Opera sobre DTLS. SCTP es el protocolo responsable de la multiplexación de múltiples canales virtuales (hasta 65,534 sub-canales) dentro de la misma asociación, garantizando el control de congestión, el control de flujo y la configurabilidad de modos de retransmisión [13].

#### 5.2. Modos de Transmisión: Fiable (Reliable) vs. No Fiable (Unreliable)
Una de las características más potentes de `RTCDataChannel` es que permite al desarrollador personalizar las garantías de transporte al momento de crear el canal mediante el objeto `RTCDataChannelInit` [8]:

1.  **Modo Fiable y Ordenado (Reliable & Ordered - Por Defecto):**
    *   Configuración: `{ ordered: true }` (sin definir `maxRetransmits` ni `maxPacketLifeTime`) [8].
    *   Comportamiento: Se comporta exactamente igual que una conexión TCP. Garantiza que todos los paquetes lleguen a su destino sin pérdidas y en el orden exacto en que fueron enviados, ejecutando retransmisiones automáticas en caso de pérdida de paquetes [13].
    *   Caso de uso: Transferencia de archivos, mensajes de chat de texto, comandos de control [13].
2.  **Modo No Fiable / Parcialmente Fiable (Unreliable / Partial Reliability):**
    *   Configuración mediante límite de retransmisiones: `{ ordered: false, maxRetransmits: 0 }` (intenta enviar el paquete solo una vez; si se pierde, no se retransmite) [13].
    *   Configuración mediante ventana de tiempo: `{ maxPacketLifeTime: 500 }` (retransmite el paquete solo dentro de una ventana de 500 milisegundos; transcurrido ese tiempo, el paquete expirado se descarta) [13].
    *   *Regla de Validación:* Es un error de sintaxis (`TypeError`) especificar simultáneamente `maxRetransmits` y `maxPacketLifeTime` en la misma configuración [8].
    *   Caso de uso: Telemetría de juegos en tiempo real, posiciones de cursor, datos sensoriales donde la frescura del dato supera a la confiabilidad histórica [16].

#### 5.3. Creación y Negociación de Canales de Datos
Existen dos modalidades para crear un `RTCDataChannel`:

*   **Negociación In-Band (Interna - Por Defecto):** El par A llama a `const channel = peerConnection.createDataChannel("chatChannel", options)`. WebRTC utiliza el protocolo DCCP/SCTP (RFC 8832) para anunciar el canal internamente al par remoto. El par B escucha el evento `peerConnection.ondatachannel`, recibiendo la referencia al canal transparente y automáticamente enlazado [13].
*   **Negociación Pre-acordada (Out-of-Band):** Se establece la propiedad `{ negotiated: true, id: 5 }` explícitamente en ambos pares. En este caso, no viaja ningún mensaje de anuncio in-band; la aplicación asume la responsabilidad de instanciar el canal con la misma ID numérica en ambos extremos [8].

#### 5.4. Transferencia de Archivos: Fragmentación (Chunking), Reensamblaje y Control de Flujo
La transferencia de archivos grandes (ejemplo: archivos de 20 MB o más) a través de `RTCDataChannel` introduce desafíos de ingeniería relacionados con la memoria y la gestión de búferes [4].

##### 1. Necesidad de la Fragmentación (Chunking)
Aunque la especificación `RTCSctpTransport` define un tamaño máximo de mensaje (`maxMessageSize`, típicamente 64 KB a 256 KB según el navegador), intentar pasar un objeto `File` o `Blob` completo de 20 MB directamente al método `channel.send(file)` provocará una falla de memoria o el rechazo de la operación con una excepción `TypeError` o `OperationError` [8]. Por ello, los archivos deben dividirse en **fragmentos o chunks pequeños** (típicamente de **16 KB (16384 bytes)**, que es el tamaño de chunk universalmente seguro para WebRTC) [4].

##### 2. Control de Flujo mediante `bufferedAmount` y `bufferedamountlow`
Si un script ejecuta un bucle enviando chunks de 16 KB de forma ininterrumpida, los fragmentos se acumulan en la cola de memoria RAM del navegador a una velocidad mucho mayor de la que la red física puede transmitir. Esto provoca un consumo descontrolado de memoria (Memory Leak) y la eventual caída de la pestaña del navegador.

Para prevenir la saturación de memoria, WebRTC proporciona un mecanismo de control de flujo basado en tres elementos clave [13]:
1.  **`dataChannel.bufferedAmount` (Solo Lectura):** Devuelve la cantidad exacta de bytes de datos de aplicación que han sido encolados con `send()` pero que aún no han sido transmitidos a la red por el stack SCTP [13].
2.  **`dataChannel.bufferedAmountLowThreshold`:** Propiedad configurable donde el desarrollador define un límite de bytes considerado como "búfer bajo" (por ejemplo, 64 KB) [13].
3.  **Evento `bufferedamountlow`:** Cuando la pila de red transmite los datos acumulados y el nivel de `bufferedAmount` desciende por debajo del umbral `bufferedAmountLowThreshold`, el navegador dispara automáticamente el evento `onbufferedamountlow` [13]. El emisor escucha este evento para reanudar el envío del siguiente bloque de chunks, logrando un control de flujo perfecto y una tasa de transferencia óptima sin saturación de memoria [13].

##### 3. Reensamblaje e Verificación de Integridad en el Receptor
En el nodo receptor, cada fragmento de 16 KB llega a través del evento `dataChannel.onmessage` como un `ArrayBuffer` [13]. El receptor acumula los fragmentos en un arreglo ordenado en memoria.

##### Verificación de Integridad del Archivo (Checksum Hashing)
Para garantizar formalmente que el archivo reensamblado no sufrió corrupción durante la transferencia, la aplicación debe calcular un hash criptográfico (como **SHA-256**) sobre la totalidad del archivo en el emisor antes de iniciar la transmisión y enviarlo en los metadatos iniciales del archivo. Al finalizar el reensamblaje, el receptor calcula independientemente el hash SHA-256 sobre el `Blob` final generado mediante la API `crypto.subtle.digest(SHA-256, fileBuffer)` y compara ambos hashes. Si coinciden exactamente, el archivo se declara completo e íntegro [4].


---

## PARTE II. SÍNTESIS DE RESPUESTAS POR BLOQUE

### Bloque A. Contenedores, máquinas virtuales y redes

*   **¿Qué diferencia hay entre virtualización completa (máquinas virtuales) y contenedores? Comparen aislamiento, consumo de recursos, tiempo de arranque y portabilidad.**
    *   La virtualización completa virtualiza hardware mediante un hipervisor ejecutando un sistema operativo huésped completo por MV, ofreciendo aislamiento fuerte pero con alto consumo de RAM/disco (GB) y arranque lento [1]. Los contenedores virtualizan a nivel de sistema operativo compartiendo el kernel anfitrión, logrando un arranque instantáneo, consumo mínimo de recursos (MB) y alta portabilidad [3].
*   **¿Qué plataforma eligieron y por qué? ¿Qué ganan y qué pierden frente a la otra?**
    *   Se eligió la plataforma de contenedores **Docker**. Se gana rapidez extrema de despliegue, eficiencia de memoria RAM y reproducibilidad declarativa mediante Docker Compose [4]. Se pierde el aislamiento estricto de nivel de kernel independiente que ofrecen las Máquinas Virtuales [5].
*   **¿Cómo se comunican dos nodos en una red virtual y cómo se encuentran por nombre en lugar de por IP?**
    *   Se comunican a través de una red virtual privada (driver bridge) aislada. Se encuentran por nombre gracias al servidor DNS embebido en Docker, el cual resuelve automáticamente los nombres de servicio declarados en Docker Compose a sus IP internas dinámicas [6].
*   **¿Qué diferencia hay entre una imagen y un contenedor? ¿Qué hace cada instrucción de un Dockerfile?**
    *   Una imagen es una plantilla estática de solo lectura compuesta por capas inmutables; un contenedor es su instancia ejecutable con una capa superior de lectura/escritura [5]. En el Dockerfile: `FROM` define la imagen base, `WORKDIR` fija el directorio, `COPY` añade archivos, `RUN` ejecuta comandos de build, `EXPOSE` documenta puertos y `CMD` define el proceso principal [4].
*   **¿Qué tipos de red ofrece Docker (bridge, host, overlay, none)? ¿Cuál conviene aquí y por qué?**
    *   Docker ofrece `bridge` (red virtual privada aislada en un host), `host` (comparte la interfaz de red del anfitrión), `overlay` (red distribuida multi-host) y `none` (sin red) [6]. Conviene la red `bridge` porque aísla la comunicación entre los dos nodos en un entorno controlado dentro del mismo host [6].
*   **¿Cómo se encuentran dos contenedores por nombre? ¿Qué papel cumple el DNS interno de Docker?**
    *   Los contenedores se encuentran haciendo peticiones al nombre del servicio (ej. `http://nodo_beta:3000`). El DNS interno de Docker (IP `127.0.0.11`) intercepta la consulta y devuelve dinámicamente la IP de la red virtual asignada a dicho contenedor [6].
*   **¿Qué diferencia hay entre exponer y publicar un puerto?**
    *   `EXPOSE` es una declaración documental en el Dockerfile que indica qué puerto escucha la app internamente sin abrir acceso externo [7]. `PUBLISH` (`-p` / `ports`) crea reglas de redirección de puertos en el host, haciendo el puerto accesible desde la red exterior [7].
*   **¿Qué resuelve Docker Compose y cómo se declaran servicios, redes, variables de entorno y volúmenes?**
    *   Docker Compose resuelve la orquestación declarativa de aplicaciones multicontenedor con un único comando [4]. Se declaran en `docker-compose.yml` bajo las secciones `services` (imágenes y comandos), `networks` (redes virtuales aisladas), `environment` (variables) y `volumes` (almacenamiento persistente) [4].


### Bloque B. Comunicación en tiempo real

*   **¿Qué es WebRTC y qué problema resuelve? ¿Qué organismos lo especifican?**
    *   WebRTC es un framework de comunicación en tiempo real de par a par (P2P) para audio, video y datos directamente entre navegadores sin plugins [8]. Resuelve la necesidad de comunicación de baja latencia en la web. Lo especifican el W3C (APIs JavaScript) y el IETF (protocolos de red) [8].
*   **¿Por qué WebRTC necesita un servidor de señalización si la comunicación es entre pares? ¿Qué información viaja por él?**
    *   Lo necesita porque los pares desconocen la dirección IP, firewalls y códecs del otro antes de conectarse [9]. Por él viajan las descripciones de sesión SDP (ofertas y respuestas), los candidatos de red ICE y los mensajes de control de llamada [9].
*   **¿Qué son SDP, oferta y respuesta? Describan paso a paso cómo se establece una sesión.**
    *   SDP (Session Description Protocol) es el formato de texto que describe los códecs y capacidades del par [8]. Paso a paso: A crea oferta (`createOffer`), la fija localmente (`setLocalDescription`) y la envía; B la fija como remota (`setRemoteDescription`), crea respuesta (`createAnswer`), la fija localmente y la envía; A fija la respuesta como remota [11].
*   **¿Qué son ICE, STUN y TURN? ¿En qué escenarios de red se necesita cada uno?**
    *   ICE es el framework que coordina el descubrimiento de rutas de red [9]. STUN se necesita en NATs sencillos para descubrir la IP pública y puerto público del cliente [9]. TURN se necesita cuando hay NATs simétricos o firewalls restrictivos para retransmitir el tráfico a través de un servidor intermedio [9].
*   **¿Qué es NAT y por qué complica la conexión directa entre dos equipos?**
    *   NAT (Network Address Translation) es el mecanismo de los routers para mapear múltiples IP privadas locales a una única IP pública [9]. Complica la conexión directa porque oculta las IP reales de los equipos y bloquea las conexiones entrantes no solicitadas desde el exterior [9].


### Bloque C. Canal de señalización

*   **¿Qué es WebSocket y en qué se diferencia de HTTP con peticiones periódicas?**
    *   WebSocket (RFC 6455) es un protocolo de capa de aplicación que ofrece un canal full-duplex y bidireccional persistente sobre una única conexión TCP [14]. Se diferencia de HTTP en que elimina el overhead de peticiones/respuestas continuas y permite al servidor empujar datos al cliente instantáneamente [15].
*   **¿Qué alternativas existen para la señalización (Socket.IO, SSE, MQTT, otras)? Comparen al menos dos.**
    *   Server-Sent Events (SSE) ofrece flujo unidireccional servidor-cliente sobre HTTP (fácil de usar pero requiere HTTP POST separado para cliente-servidor) [17]. MQTT es un protocolo pub/sub ultra liviano ideal para IoT pero requiere brokers adicionales y proxies en el navegador [17].
*   **¿Qué formato tendrán sus mensajes de señalización? Propónganlo.**
    *   Tendrán un formato JSON estructurado con atributos obligatorios `type` (ej. "offer", "answer", "candidate"), `sender` (identificador del nodo emisor), `target` (identificador del nodo destino) y `payload` (objeto SDP o candidato ICE) [10].


### Bloque D. Medios: audio y video

*   **¿Cómo accede un navegador a la cámara y al micrófono? ¿Qué permisos y restricciones de seguridad aplican (contexto seguro, HTTPS, localhost)?**
    *   Accede mediante la API `navigator.mediaDevices.getUserMedia(constraints)` [18]. Aplica la restricción de Contexto Seguro (solo funciona en HTTPS, localhost o file://) y requiere la autorización explícita del usuario mediante la ventana de permisos del navegador [18].
*   **¿Por qué un contenedor Docker normalmente no accede a la cámara del equipo anfitrión? ¿Qué cambia en una máquina virtual (paso de dispositivos USB, navegador dentro o fuera de la máquina)? ¿Dónde debe ocurrir la captura en su arquitectura?**
    *   Un contenedor no accede directamente porque está aislado del hardware del host [4]. En una MV requeriría passthrough de dispositivos USB si el navegador estuviera dentro de la MV [4]. En nuestra arquitectura, la captura ocurre en el navegador web del usuario ejecutado en el host físico anfitrión [19].
*   **¿Qué es un códec? ¿Qué códecs de audio y video negocian los navegadores en WebRTC? Comparen al menos tres en compresión, consumo de CPU, compatibilidad y licencias.**
    *   Un códec es el algoritmo de compresión/descompresión de medios en tiempo real [4]. VP8 (video mandatorio RFC 7742) es balanceado y libre de royalties [12]; H.264 (video mandatorio) posee aceleración por hardware en dispositivos pero tiene patentes [12]; Opus (audio mandatorio RFC 7874) es de calidad y tasa de bits adaptable ultra eficiente y abierto [12].
*   **¿Qué ancho de banda aproximado requiere una videollamada a 480p y a 720p?**
    *   Una llamada a 480p (VGA a 30 FPS) requiere entre 500 kbps y 1 Mbps para video más 30-50 kbps para audio [4]. Una llamada a 720p (HD a 30 FPS) requiere entre 1.5 Mbps y 2.5 Mbps para video más 50-64 kbps para audio Opus [4].


### Bloque E. Transferencia de archivos y texto

*   **¿Qué es un RTCDataChannel? ¿Qué diferencia hay entre un canal confiable y uno no confiable?**
    *   Es la interfaz WebRTC para transferir datos binarios o texto entre pares mediante SCTP sobre DTLS/UDP [13]. Un canal confiable (`ordered: true`) garantiza entrega ordenada y sin pérdidas mediante retransmisiones (estilo TCP) [13]; uno no confiable limita retransmisiones o tiempo de vida favoreciendo la baja latencia (estilo UDP) [13].
*   **¿Por qué un archivo grande se debe enviar en fragmentos? ¿Cómo se controla el búfer para no saturar el canal?**
    *   Se fragmenta porque los envíos de archivos grandes superan el `maxMessageSize` permitido por SCTP y agotan la memoria del navegador [8]. Se controla el búfer monitoreando `bufferedAmount` y pausando el envío hasta recibir el evento `bufferedamountlow` cuando cae por debajo de `bufferedAmountLowThreshold` [13].
*   **¿Qué alternativa existe enviando el archivo por HTTP a través del servidor? ¿Qué ventajas y desventajas tiene frente al DataChannel?**
    *   La alternativa es subir el archivo por HTTP POST al servidor y que el otro cliente lo descargue [4]. Ventaja: el servidor almacena el archivo y no requiere que ambos estén conectados simultáneamente [4]. Desventaja: añade latencia, sobrecarga de ancho de banda y costo de almacenamiento en el servidor frente a la transferencia P2P directa cifrada [13].
*   **¿Cómo verifica el receptor que el archivo llegó completo e íntegro?**
    *   El receptor calcula la cantidad total de bytes recibidos frente al tamaño esperado y ejecuta un hash criptográfico (SHA-256) sobre el `Blob` reensamblado, comparándolo con el hash checksum enviado por el emisor en los metadatos iniciales [4].


---
---

## REFERENCIAS BIBLIOGRÁFICAS

[1] GeeksforGeeks, «Virtualization vs. Containerization in System Design», 2025.
[2] OVHcloud, «Virtualización de servidores: Definición y ventajas», OVHcloud Global, 2026.
[3] IBM, «What Is Containerization?», IBM Cloud Learn Hub, 2026.
[4] Universidad Tecnológica de Pereira (UTP), «Laboratorio: Mensajero WebRTC en contenedores Docker o máquinas virtuales», Asignatura Sistemas Distribuidos, 2026.
[5] AWS, «Contenedores o máquinas virtuales: diferencia entre tecnologías de implementación», AWS Documentation, 2026.
[6] DEV Community, «Docker Compose Networking: A Guide to Efficient Container Communication», DEV Community, 2025.
[7] DEV Community, «What is the difference between "expose" and "publish" in Docker?», DEV Community, 2025.
[8] W3C WebRTC Working Group, «WebRTC: Real-Time Communication in Browsers», W3C Recommendation Candidate, 2026.
[9] WebRTC Project, «Getting started with peer connections & Peer connections», WebRTC.org, 2026.
[10] IETF RTCWEB Group, «WebRTC Tutorial: Real-Time Communication for the Web», IETF Proceedings, 2017.
[11] MDN Web Docs, «WebSocket API (WebSockets) - Web APIs», Mozilla Developer Network, 2026.
[12] MDN Web Docs, «Codecs used by WebRTC - Media», Mozilla Developer Network, 2026.
[13] MDN Web Docs, «RTCDataChannel - Web APIs», Mozilla Developer Network, 2026.
[14] RFC Editor, «RFC 6455: The WebSocket Protocol», Internet Engineering Task Force (IETF), 2011.
[15] Postman Blog, «WebSockets vs HTTP: Key Differences Explained», Postman, 2025.
[16] PubNub, «Comparing WebSocket Alternatives for Realtime Comms», PubNub Guides, 2025.
[17] Ably, «WebSocket alternatives: Comparing realtime protocols», 2025.
[18] MDN Web Docs, «MediaDevices: getUserMedia() method - Web APIs», Mozilla Developer Network, 2025.
[19] IETF RTCWEB Group, «WebRTC Tutorial: Real-Time Communication for the Web», IETF Proceedings, 2017.