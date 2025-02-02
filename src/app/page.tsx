'use client';

import { MessageData } from '@/types/socket';
import { useState, useEffect, useRef } from 'react';
import io from 'socket.io-client';

// Configuration ICE pour WebRTC (utilisation d'un STUN public)
const configuration = {
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
};

export default function Home() {
  // États pour le chat et la webcam
  const [username, setUsername] = useState('');
  const [message, setMessage] = useState('');

  const [messages, setMessages] = useState<MessageData[]>([]);
  const [clients, setClients] = useState<string[]>([]);
  const [typingUsers, setTypingUsers] = useState<string[]>([]);
  const [isCamActive, setIsCamActive] = useState(false);
  const [remoteStreams, setRemoteStreams] = useState<
    { id: string; stream: MediaStream }[]
  >([]);

  const socketRef = useRef<ReturnType<typeof io> | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const peerConnections = useRef<{ [key: string]: RTCPeerConnection }>({});
  const typingTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // 1. Effet d'initialisation (une seule exécution)
  useEffect(() => {
    const randomUsername = 'User' + Math.floor(Math.random() * 10000);
    setUsername(randomUsername);

    socketRef.current = io();

    socketRef.current.on('connect', () => {
      if (socketRef.current) {
        console.log("Connecté avec l'ID :", socketRef.current.id);
        socketRef.current.emit('join', randomUsername);
      }
    });

    // Chat
    socketRef.current.on('message', (msg: MessageData) => {
      console.log('Message reçu :', msg);
      setMessages((prev: MessageData[]) => [...prev, msg]);
    });
    socketRef.current.on('clients', (clientList: string[]) => {
      setClients(clientList);
    });
    socketRef.current.on('typing', (user: string) => {
      if (user !== randomUsername) {
        setTypingUsers((prev) => {
          if (!prev.includes(user)) return [...prev, user];
          return prev;
        });
      }
    });
    socketRef.current.on('stopTyping', (user: string) => {
      setTypingUsers((prev) => prev.filter((u) => u !== user));
    });

    // WebRTC – Signalisation

    socketRef.current.on('broadcaster', (broadcasterId: string) => {
      console.log("Événement 'broadcaster' reçu :", broadcasterId);
      if (socketRef.current && broadcasterId !== socketRef.current.id) {
        console.log('Je demande à regarder le flux de', broadcasterId);
        socketRef.current.emit('watcher', broadcasterId);
      }
    });

    socketRef.current.on('watcher', (watcherId: string) => {
      if (socketRef.current) {
        console.log(
          "Requête 'watcher' reçue par le diffuseur",
          socketRef.current.id,
          'pour',
          watcherId
        );
      }
      if (streamRef.current) {
        const pc = new RTCPeerConnection(configuration);
        peerConnections.current[watcherId] = pc;
        streamRef.current.getTracks().forEach((track) => {
          pc.addTrack(track, streamRef.current as MediaStream);
        });
        pc.onicecandidate = (event) => {
          if (event.candidate) {
            if (socketRef.current) {
              console.log(
                'Envoi ICE candidate de',
                socketRef.current.id,
                'à',
                watcherId
              );
              socketRef.current.emit('candidate', {
                target: watcherId,
                candidate: event.candidate,
              });
            }
          }
        };
        pc.createOffer()
          .then((offer: RTCSessionDescriptionInit) =>
            pc.setLocalDescription(offer)
          )
          .then(() => {
            console.log("Envoi de l'offre à", watcherId);
            if (socketRef.current) {
              socketRef.current.emit('offer', {
                target: watcherId,
                sdp: pc.localDescription,
              });
            }
          })
          .catch((error: Error) =>
            console.error("Erreur lors de la création de l'offre :", error)
          );
      }
    });

    socketRef.current.on(
      'offer',
      (data: { sdp: RTCSessionDescriptionInit; caller: string }) => {
        console.log('Offre reçue de', data.caller);
        const { sdp, caller } = data;
        const pc = new RTCPeerConnection(configuration);
        peerConnections.current[caller] = pc;
        pc.onicecandidate = (event) => {
          if (event.candidate) {
            if (socketRef.current) {
              console.log(
                'Envoi ICE candidate de',
                socketRef.current.id,
                'à',
                caller
              );
              socketRef.current.emit('candidate', {
                target: caller,
                candidate: event.candidate,
              });
            }
          }
        };
        pc.ontrack = (event) => {
          console.log('Flux distant reçu de', caller);
          setRemoteStreams((prev) => [
            ...prev,
            { id: caller, stream: event.streams[0] },
          ]);
        };
        pc.setRemoteDescription(new RTCSessionDescription(sdp))
          .then(() => pc.createAnswer())
          .then((answer: RTCSessionDescriptionInit) =>
            pc.setLocalDescription(answer)
          )
          .then(() => {
            console.log('Envoi de la réponse à', caller);
            if (socketRef.current) {
              socketRef.current.emit('answer', {
                target: caller,
                sdp: pc.localDescription,
              });
            }
          })
          .catch((error: Error) =>
            console.error("Erreur lors de la gestion de l'offre :", error)
          );
      }
    );

    socketRef.current.on(
      'answer',
      (data: { sdp: RTCSessionDescriptionInit; caller: string }) => {
        console.log('Réponse reçue de', data.caller);
        const { sdp, caller } = data;
        const pc = peerConnections.current[caller];
        if (pc) {
          pc.setRemoteDescription(new RTCSessionDescription(sdp)).catch(
            (error: Error) =>
              console.error(
                'Erreur lors de la réception de la réponse :',
                error
              )
          );
        }
      }
    );

    socketRef.current.on(
      'candidate',
      (data: { candidate: RTCIceCandidateInit; caller: string }) => {
        console.log('Candidate reçue de', data.caller);
        const { candidate, caller } = data;
        const pc = peerConnections.current[caller];
        if (pc) {
          pc.addIceCandidate(new RTCIceCandidate(candidate)).catch(
            (error: Error) =>
              console.error(
                "Erreur lors de l'ajout d'un ICE candidate :",
                error
              )
          );
        }
      }
    );

    // Gestion de la déconnexion d'un pair
    socketRef.current.on('disconnectPeer', (id: string) => {
      console.log('Déconnexion du pair', id);
      if (peerConnections.current[id]) {
        peerConnections.current[id].close();
        delete peerConnections.current[id];
        setRemoteStreams((prev) => prev.filter((item) => item.id !== id));
      }
    });

    // Nouvel événement : réception de l'arrêt de diffusion par un diffuseur
    socketRef.current.on('broadcasterStop', (broadcasterId: string) => {
      console.log('Le diffuseur', broadcasterId, 'a arrêté sa diffusion');
      // Supprime le flux distant correspondant
      setRemoteStreams((prev) =>
        prev.filter((item) => item.id !== broadcasterId)
      );
      // Vous pouvez également fermer et supprimer la connexion correspondante si besoin
      if (peerConnections.current[broadcasterId]) {
        peerConnections.current[broadcasterId].close();
        delete peerConnections.current[broadcasterId];
      }
    });

    return () => {
      if (socketRef.current) socketRef.current.disconnect();
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track) => track.stop());
      }
    };
  }, []); // Exécuté une seule fois

  // 2. Effet pour notifier la diffusion dès que la webcam s'active
  useEffect(() => {
    if (isCamActive) {
      console.log("Webcam active : émission de l'événement 'broadcaster'");
      if (socketRef.current) {
        socketRef.current.emit('broadcaster');
      }
    }
  }, [isCamActive]);

  // Fonction pour activer la webcam locale
  const startWebcam = () => {
    if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
      console.log("Demande d'accès à la webcam");
      navigator.mediaDevices
        .getUserMedia({ video: true, audio: false })
        .then((stream) => {
          console.log('Accès à la webcam autorisé');
          streamRef.current = stream;
          if (videoRef.current) {
            videoRef.current.srcObject = stream;
            videoRef.current
              .play()
              .then(() => console.log('Lecture de la webcam démarrée'))
              .catch((error) =>
                console.error('Erreur lors du démarrage de la vidéo :', error)
              );
          }
          setIsCamActive(true);
        })
        .catch((err) => console.error("Erreur d'accès à la webcam :", err));
    }
  };

  // Fonction pour désactiver la webcam locale et notifier les watchers
  const stopWebcam = () => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      setIsCamActive(false);
      // Notifier les autres clients que la diffusion s'arrête
      if (socketRef.current) {
        socketRef.current.emit('broadcasterStop');
      }
    }
  };

  // Envoi d'un message dans le chat
  const sendMessage = () => {
    if (message.trim() !== '') {
      setMessage('');
      if (socketRef.current) {
        socketRef.current.emit('message', { username, message });
        socketRef.current.emit('stopTyping', username);
      }
      clearTimeout(typingTimeoutRef.current as NodeJS.Timeout | undefined);
      typingTimeoutRef.current = null;
    }
  };

  // Gestion de l'indicateur "est en train d'écrire"
  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      sendMessage();
    } else {
      if (!typingTimeoutRef.current) {
        if (socketRef.current) {
          socketRef.current.emit('typing', username);
        }
      }
      clearTimeout(typingTimeoutRef.current as NodeJS.Timeout | undefined);
      typingTimeoutRef.current = setTimeout(() => {
        if (socketRef.current) {
          socketRef.current.emit('stopTyping', username);
        }
        typingTimeoutRef.current = null;
      }, 2000);
    }
  };

  return (
    <div className="p-8">
      <h1 className="text-3xl font-bold mb-6 text-center">
        Chat en temps réel
      </h1>

      {/* Section Webcam locale */}
      <div className="mb-4 flex flex-col items-center">
        <video
          ref={videoRef}
          autoPlay
          muted
          playsInline
          className={`w-60 h-40 border border-gray-300 rounded ${
            !isCamActive ? 'hidden' : 'block'
          }`}
        />
        {isCamActive ? (
          <button
            onClick={stopWebcam}
            className="mt-2 px-4 py-2 bg-red-500 text-white rounded hover:bg-red-600"
          >
            Désactiver la webcam
          </button>
        ) : (
          <button
            onClick={startWebcam}
            className="mt-2 px-4 py-2 bg-green-500 text-white rounded hover:bg-green-600"
          >
            Activer la webcam
          </button>
        )}
      </div>

      {/* Section des flux vidéo distants */}
      <div className="mb-4">
        <h2 className="text-xl font-bold mb-2">
          Vidéos des autres utilisateurs :
        </h2>
        <div className="flex flex-wrap">
          {remoteStreams.map((remote) => (
            <video
              key={remote.id}
              autoPlay
              playsInline
              muted
              className="w-60 h-40 border border-gray-300 rounded m-2"
              ref={(el) => {
                if (el && remote.stream) {
                  el.srcObject = remote.stream;
                }
              }}
            />
          ))}
        </div>
      </div>

      {/* Liste des clients connectés */}
      <div className="mb-4 p-4 border border-gray-300 rounded">
        <h2 className="text-xl font-bold mb-2">Utilisateurs connectés :</h2>
        <ul className="list-disc pl-5">
          {clients.map((client, index) => (
            <li key={index} className="text-gray-500">
              {client}
            </li>
          ))}
        </ul>
      </div>

      {/* Zone des messages du chat */}
      <div className="border border-gray-300 p-4 h-80 overflow-y-scroll mb-4 rounded">
        {messages.map((msg, index) => (
          <div key={index} className="mb-2">
            <span className="font-bold text-blue-600">{msg.username} :</span>{' '}
            {msg.message}
          </div>
        ))}
      </div>

      {/* Indicateur "est en train d'écrire" */}
      {typingUsers.length > 0 && (
        <div className="mb-2 italic text-gray-600">
          {typingUsers.join(', ')} {typingUsers.length === 1 ? 'est' : 'sont'}{' '}
          en train d&apos;écrire...
        </div>
      )}

      {/* Zone d'envoi du message */}
      <div className="flex">
        <input
          type="text"
          placeholder="Votre message"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={handleKeyDown}
          className="flex-1 p-2 text-black border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
        <button
          onClick={sendMessage}
          className="ml-2 px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600"
        >
          Envoyer
        </button>
      </div>
    </div>
  );
}
