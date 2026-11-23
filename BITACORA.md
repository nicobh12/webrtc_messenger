
# Bitácora de Desarrollo

---

### Entrada 1: 19 de noviembre de 2026

* **Tiempo estimado:** 3.5 horas
* **Actividades realizadas:**
  * Lectura de la guía del laboratorio (`Laboratorio_Mensajero_WebRTC_UTP.docx`) para identificar los requerimientos y entregables de la investigación.
  * Búsqueda de documentación técnica en fuentes oficiales como W3C, IETF, MDN, Docker Docs y RFCs.
  * Recopilación de aproximadamente 30 fuentes iniciales para construir la base teórica del informe.
  * Organización de las fuentes según los temas y bloques de investigación.

* **Uso de herramientas de IA:** Apoyo en la búsqueda, clasificación y organización inicial de documentación técnica.

---

### Entrada 2: 20 de noviembre de 2026

* **Tiempo estimado:** 5.0 horas
* **Actividades realizadas:**
  * Creación del borrador del informe de investigación en formato Markdown (`.md`).
  * Desarrollo de los fundamentos teóricos del **Bloque A**, relacionados con virtualización completa y contenerización, diferencias entre `EXPOSE` y `PUBLISH`, y resolución DNS en Docker Compose.
  * Redacción del **Bloque B**, abordando los fundamentos de WebRTC, SDP, el intercambio Offer/Answer y los mecanismos ICE, STUN y TURN.
  * Desarrollo del **Bloque C**, centrado en el canal de señalización mediante WebSocket, el handshake `101 Switching Protocols` y la estructura de los mensajes intercambiados en JSON.
  * Inicio del **Bloque D**, sobre captura multimedia mediante `getUserMedia`, contextos seguros (`HTTPS`/`localhost`) y códecs de audio y video.

* **Problemas y soluciones:**
  * Fue necesario profundizar en el funcionamiento de la negociación SDP, los mecanismos ICE y las diferencias entre WebSocket, HTTP Polling y Server-Sent Events (SSE).
  * Se consultaron las especificaciones RFC y la documentación técnica recopilada para aclarar estos conceptos y justificar las decisiones tecnológicas.

* **Uso de herramientas de IA:** **NotebookLM** para consultar las fuentes recopiladas, contrastar información técnica y apoyar la redacción de los Bloques A, B, C y D.

---

### Entrada 3: 21 de noviembre de 2026

* **Tiempo estimado:** 11.0 horas

* **Actividades realizadas:**

  * **Mañana:**
    * Finalización del **Bloque D**, incluyendo las restricciones de seguridad para el acceso a la cámara y al micrófono desde el navegador y el análisis de la captura multimedia en aplicaciones desplegadas con Docker.
    * Desarrollo del **Bloque E**, dedicado a `RTCDataChannel`, su arquitectura SCTP/DTLS/UDP y la transferencia de archivos mediante fragmentación en *chunks* de 16 KB.
    * Documentación del control de flujo mediante `bufferedAmount` y `onbufferedamountlow`, así como de la verificación de integridad mediante SHA-256.
    * Consolidación de los Bloques A a E como primera parte del marco teórico.

  * **Tarde:**
    * Desarrollo del **Bloque F**, correspondiente al stack tecnológico propuesto.
    * Elaboración del **Bloque G**, incluyendo el modelado UML, la matriz de decisiones tecnológicas y el análisis de riesgos.
    * Desarrollo del **Bloque H**, sobre arquitecturas Mesh, SFU y MCU, el patrón *Perfect Negotiation* y la API `getDisplayMedia`.

  * **Noche:**
    * Revisión general y síntesis del borrador Markdown para ajustarlo a los límites y requisitos de la guía del laboratorio.
    * Inicio del prototipado de la interfaz de usuario (UI/UX) mediante Figma, definiendo las zonas de videollamada, chat y transferencia de archivos.
    * Organización de la estructura del proyecto y creación de las carpetas `docs/` y `docs/uml`.
    * Conversión del documento Markdown a LaTeX y compilación del informe final en PDF (`Informe_Investigacion_WebRTC.pdf`).
    * Publicación de los entregables mediante *commit* y *push* a la rama principal del repositorio Git.

* **Problemas y soluciones:**
  * Durante la conversión a LaTeX surgieron algunos ajustes de formato, especialmente en tablas y diagramas.
  * Se realizaron correcciones directamente en el código fuente y ajustes de presentación hasta obtener una versión compilada y legible del documento.

* **Uso de herramientas de IA:**
  * **NotebookLM:** apoyo en la investigación, consulta de fuentes y organización de los fundamentos teóricos de los Bloques A a H.
  * **Agente Vibe:** apoyo en la síntesis y edición del borrador Markdown.
  * **Figma AI:** asistencia en la generación inicial del prototipo de interfaz.

---

### Entrada 4: 22 de noviembre de 2026

* **Tiempo estimado:** 4.0 horas

* **Actividades realizadas:**
  * **Configuración del entorno:**
    * Instalación y configuración de WSL2 como entorno para ejecutar Docker Desktop, habilitando su integración con Ubuntu.
    * Instalación de Docker Desktop y verificación de su funcionamiento mediante `docker run hello-world`.
    * Configuración de Node.js en Ubuntu (WSL) mediante NVM, instalando la versión 24.22.3.
    * Configuración de Git con autenticación SSH para trabajar con GitHub.
    * Creación del archivo `.gitattributes` para normalizar los finales de línea (LF/CRLF) entre Windows y Linux.

  * **Desarrollo de la Fase 2 (Infraestructura inicial):**
    * Revisión del informe de investigación para aplicar la arquitectura definida: dos nodos independientes (`nodo-a` y `nodo-b`) comunicados mediante WebSockets.
    * Creación de `package.json` e instalación de la dependencia `ws`.
    * Implementación de `server.js` con un servidor WebSocket en el puerto 3000, encargado de recibir mensajes y mostrarlos en los logs.
    * Configuración del `Dockerfile` utilizando `node:18-alpine`.
    * Elaboración de `docker-compose.yml` con los servicios `nodo-a` y `nodo-b`, utilizando la red predeterminada de Docker Compose y sus respectivos mapeos de puertos (`3000:3000` y `3001:3000`).
    * Configuración de variables de entorno para identificar cada nodo en los registros.
    * Creación del `README.md` con instrucciones para ejecutar y probar los servicios.
    * Construcción y ejecución de ambos contenedores mediante `docker compose up --build`, verificando que los dos servidores WebSocket iniciaran correctamente.

* **Problemas y soluciones:**
  * **Finales de línea (LF/CRLF):** Se solucionó mediante la creación de `.gitattributes`, estableciendo LF como formato normalizado.
  * **Autenticación de Git:** Se reemplazó la conexión HTTPS por SSH y se configuraron las claves correspondientes desde WSL.
  * **Ejecución de Node.js en WSL:** Se utilizó NVM para instalar y gestionar Node.js directamente desde Ubuntu.
  * **Pruebas de WebSocket:** Al intentar utilizar `wscat`, se identificó que no estaba instalado en el entorno. Se dejó pendiente su instalación para realizar las pruebas de conexión y recepción de mensajes.

* **Uso de herramientas de IA:**
  * **OpenCode:** Apoyo en la revisión de la arquitectura y en la implementación de los archivos iniciales de la Fase 2, incluyendo el servidor WebSocket y la configuración de Docker.