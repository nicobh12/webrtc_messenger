'use strict';

import {
  createPeerConnection,
  logP2P,
  pendingCandidates,
  peerMeta,
  setP2PState,
} from './webrtc.js';

export const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];

let senderId;
let getSocket;
let normalizeUserId;

export function configureSignaling(options) {
  senderId = options.senderId;
  getSocket = options.getSocket;
  normalizeUserId = options.normalizeUserId;
}

export function sendSignal(target, payload) {
  const socket = getSocket();
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    logP2P(`Sin WebSocket: no se puede señalizar "${payload.type}" hacia ${target}.`);
    return false;
  }

  socket.send(
    JSON.stringify({
      type: payload.type,
      sender: senderId,
      target,
      ...(payload.sdp ? { sdp: payload.sdp } : {}),
      ...(payload.candidate !== undefined ? { candidate: payload.candidate } : {}),
    })
  );

  logP2P(`→ ${payload.type} a ${target}.`);
  return true;
}

/** Recibe offer/answer/candidate del servidor y aplica Perfect Negotiation. */
export async function onSignal(message) {
  const target = normalizeUserId(message.sender);

  if (!target || target === senderId) return;

  const pc = createPeerConnection(target);
  const meta = peerMeta.get(target);
  if (!meta) return;

  if (message.type === 'offer' || message.type === 'answer') {
    const description = message.sdp;

    if (
      !description ||
      typeof description !== 'object' ||
      typeof description.type !== 'string' ||
      typeof description.sdp !== 'string'
    ) {
      return;
    }

    // Perfect Negotiation: colisión = oferta entrante mientras negociamos.
    const readyForOffer =
      !meta.makingOffer &&
      (pc.signalingState === 'stable' || meta.isSettingRemoteAnswerPending);
    const offerCollision = description.type === 'offer' && !readyForOffer;

    // Una respuesta solo es válida si tenemos una oferta local pendiente.
    if (description.type === 'answer' && pc.signalingState !== 'have-local-offer') {
      logP2P(`Answer de ${target} ignorada (estado ${pc.signalingState}).`);
      return;
    }

    meta.ignoreOffer = !meta.polite && offerCollision;
    if (meta.ignoreOffer) {
      logP2P(`Oferta de ${target} ignorada (impolite ante colisión).`);
      return;
    }

    if (offerCollision && meta.polite) {
      // Rollback explícito: have-local-offer -> stable antes de aceptar la oferta.
      try {
        await pc.setLocalDescription({ type: 'rollback' });
        logP2P(`Rollback local por colisión con ${target}.`);
      } catch (error) {
        logP2P(`Rollback no necesario con ${target}: ${error.message}`);
      }
    }

    meta.isSettingRemoteAnswerPending = description.type === 'answer';

    try {
      await pc.setRemoteDescription(description);
    } catch (error) {
      logP2P(`setRemoteDescription(${description.type}) con ${target} falló: ${error.message}`);
      return;
    } finally {
      meta.isSettingRemoteAnswerPending = false;
    }

    // Aplicar los candidatos que llegaron antes de la descripción remota.
    const queued = pendingCandidates.get(target) ?? [];
    pendingCandidates.delete(target);

    for (const candidate of queued) {
      try {
        await pc.addIceCandidate(candidate);
      } catch (error) {
        logP2P(`Candidato en cola rechazado por ${target}: ${error.message}`);
      }
    }

    if (description.type === 'offer') {
      try {
        await pc.setLocalDescription();
        sendSignal(target, {
          type: pc.localDescription.type,
          sdp: pc.localDescription.toJSON(),
        });
        logP2P(`Respuesta local enviada a ${target}.`);
      } catch (error) {
        logP2P(`No se pudo responder a ${target}: ${error.message}`);
      }
    }

    return;
  }

  if (message.type === 'candidate') {
    if (meta.ignoreOffer) return;

    const candidate = message.candidate;
    if (!candidate) return;

    if (!pc.remoteDescription) {
      const queued = pendingCandidates.get(target) ?? [];
      queued.push(candidate);
      pendingCandidates.set(target, queued);
      return;
    }

    try {
      await pc.addIceCandidate(candidate);
    } catch (error) {
      if (!meta.ignoreOffer) {
        logP2P(`addIceCandidate de ${target} falló: ${error.message}`);
      }
    }
  }
}

export function onSignalError(message) {
  const target = normalizeUserId(message.target);
  if (!target) return;

  logP2P(
    `Señal ${message.signalType ?? ''} no entregada a ${target}: ` +
      `${message.reason ?? message.detail ?? 'error'}.`
  );

  if (message.reason === 'offline' || message.reason === 'peer-unreachable') {
    setP2PState(target, 'failed');
  }
}

/** Mensajes de chat que llegan por el DataChannel (P2P). */
