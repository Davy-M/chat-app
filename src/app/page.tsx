'use client';

import VideoStream from '@/components/VideoStream';
import { MessageData } from '@/types/socket';
import { useState, useEffect, useRef } from 'react';
import io from 'socket.io-client';

// Configuration ICE pour WebRTC (utilisation d'un STUN public)
const configuration = {
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
};

interface RemoteStatus {
  video: boolean;
  mic: boolean;
  username: string;
}

export default function Home() {
  // États du chat
  const [username, setUsername] = useState('');
  const [message, setMessage] = useState('');
  const [messages, setMessages] = useState<MessageData[]>([]);
  const [clients, setClients] = useState<string[]>([]);
  const [typingUsers, setTypingUsers] = useState<string[]>([]);

  // États de l'appel
  const [isCallActive, setIsCallActive] = useState(false);
  const [isVideoActive, setIsVideoActive] = useState(false);
  // Flux distants reçus
  const [remoteStreams, setRemoteStreams] = useState<
    { id: string; stream: MediaStream }[]
  >([]);

  // États audio locaux et distant
  const [isMicMuted, setIsMicMuted] = useState(false);
  const [isRemoteAudioMuted, setIsRemoteAudioMuted] = useState(false);

  // Statuts des utilisateurs distants (clé = id du socket)
  const [remoteStatuses, setRemoteStatuses] = useState<
    Record<string, RemoteStatus>
  >({});

  const socketRef = useRef<ReturnType<typeof io> | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const peerConnections = useRef<{ [key: string]: RTCPeerConnection }>({});
  const typingTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const chatContainerRef = useRef<HTMLDivElement>(null);

  // Initialisation de la connexion socket
  useEffect(() => {
    const randomUsername = 'User' + Math.floor(Math.random() * 10000);
    setUsername(randomUsername);

    socketRef.current = io();

    socketRef.current.on('connect', () => {
      if (socketRef.current) {
        console.log("Connecté avec l'ID :", socketRef.current.id);
        socketRef.current.emit('join', randomUsername);
        // Envoyer notre statut initial (aucune vidéo, micro actif par défaut)
        socketRef.current.emit('updateStatus', {
          video: false,
          mic: false,
          username: randomUsername,
        });
      }
    });

    // Gestion du chat
    socketRef.current.on('message', (msg: MessageData) => {
      console.log('Message reçu :', msg);
      setMessages((prev) => [...prev, msg]);
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

    // Réception des mises à jour de statut des autres utilisateurs
    socketRef.current.on(
      'updateStatus',
      (data: {
        id: string;
        video: boolean;
        mic: boolean;
        username: string;
      }) => {
        setRemoteStatuses((prev) => ({
          ...prev,
          [data.id]: {
            video: data.video,
            mic: data.mic,
            username: data.username,
          },
        }));
      }
    );

    // --- Signalisation WebRTC ---
    socketRef.current.on('broadcaster', (broadcasterId: string) => {
      console.log("Événement 'broadcaster' reçu :", broadcasterId);
      if (socketRef.current && broadcasterId !== socketRef.current.id) {
        console.log('Je demande à regarder le flux de', broadcasterId);
        socketRef.current.emit('watcher', broadcasterId);
      }
    });

    socketRef.current.on('watcher', (watcherId: string) => {
      console.log("Requête 'watcher' reçue pour", watcherId);
      if (localStreamRef.current) {
        const pc = new RTCPeerConnection(configuration);
        peerConnections.current[watcherId] = pc;
        localStreamRef.current.getTracks().forEach((track) => {
          pc.addTrack(track, localStreamRef.current as MediaStream);
        });
        pc.onicecandidate = (event) => {
          if (event.candidate && socketRef.current) {
            console.log('Envoi ICE candidate à', watcherId);
            socketRef.current.emit('candidate', {
              target: watcherId,
              candidate: event.candidate,
            });
          }
        };
        pc.createOffer()
          .then((offer) => pc.setLocalDescription(offer))
          .then(() => {
            if (socketRef.current) {
              socketRef.current.emit('offer', {
                target: watcherId,
                sdp: pc.localDescription,
              });
            }
          })
          .catch((error) =>
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
          if (event.candidate && socketRef.current) {
            console.log('Envoi ICE candidate à', caller);
            socketRef.current.emit('candidate', {
              target: caller,
              candidate: event.candidate,
            });
          }
        };
        pc.ontrack = (event) => {
          console.log('Flux distant reçu de', caller);
          setRemoteStreams((prev) => {
            if (prev.find((item) => item.id === caller)) {
              return prev;
            }
            return [...prev, { id: caller, stream: event.streams[0] }];
          });
        };
        pc.setRemoteDescription(new RTCSessionDescription(sdp))
          .then(() => pc.createAnswer())
          .then((answer) => pc.setLocalDescription(answer))
          .then(() => {
            if (socketRef.current) {
              socketRef.current.emit('answer', {
                target: caller,
                sdp: pc.localDescription,
              });
            }
          })
          .catch((error) =>
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
            (error) =>
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
          pc.addIceCandidate(new RTCIceCandidate(candidate)).catch((error) =>
            console.error("Erreur lors de l'ajout d'un ICE candidate :", error)
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
        setRemoteStatuses((prev) => {
          const newStatuses = { ...prev };
          delete newStatuses[id];
          return newStatuses;
        });
      }
    });

    socketRef.current.on('broadcasterStop', (broadcasterId: string) => {
      console.log('Le diffuseur', broadcasterId, 'a arrêté sa diffusion');
      setRemoteStreams((prev) =>
        prev.filter((item) => item.id !== broadcasterId)
      );
      if (peerConnections.current[broadcasterId]) {
        peerConnections.current[broadcasterId].close();
        delete peerConnections.current[broadcasterId];
      }
      setRemoteStatuses((prev) => {
        const newStatuses = { ...prev };
        delete newStatuses[broadcasterId];
        return newStatuses;
      });
    });

    return () => {
      if (socketRef.current) socketRef.current.disconnect();
      if (localStreamRef.current) {
        localStreamRef.current.getTracks().forEach((track) => track.stop());
      }
    };
  }, []);

  // Dès que l'appel est lancé, on informe le serveur de notre statut
  useEffect(() => {
    if (isCallActive && socketRef.current) {
      socketRef.current.emit('broadcaster');
      socketRef.current.emit('updateStatus', {
        video: isVideoActive,
        mic: isMicMuted,
        username,
      });
    }
  }, [isCallActive, isVideoActive, isMicMuted, username]);

  useEffect(() => {
    if (chatContainerRef.current) {
      chatContainerRef.current.scrollTop =
        chatContainerRef.current.scrollHeight;
    }
  }, [messages]);

  // Lancement de l'appel (audio ou vidéo)
  const startCall = (useVideo: boolean) => {
    if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
      console.log(
        `Demande d'accès à ${useVideo ? 'la vidéo' : 'l’audio'} et au micro`
      );
      navigator.mediaDevices
        .getUserMedia({ video: useVideo, audio: true })
        .then((stream) => {
          console.log('Accès autorisé');
          localStreamRef.current = stream;
          // Active le micro par défaut
          stream.getAudioTracks().forEach((track) => (track.enabled = true));
          setIsCallActive(true);
          setIsVideoActive(useVideo);
          if (socketRef.current) {
            socketRef.current.emit('updateStatus', {
              video: useVideo,
              mic: false,
              username,
            });
          }
        })
        .catch((err) => console.error("Erreur d'accès :", err));
    }
  };

  // Toggle de la vidéo : bascule l'état de la piste vidéo ou tente de l'ajouter si absente
  const toggleVideo = async () => {
    if (!localStreamRef.current) return;
    const videoTracks = localStreamRef.current.getVideoTracks();
    if (videoTracks.length > 0) {
      const newState = !isVideoActive;
      videoTracks.forEach((track) => (track.enabled = newState));
      setIsVideoActive(newState);
      if (socketRef.current) {
        socketRef.current.emit('updateStatus', {
          video: newState,
          mic: isMicMuted,
          username,
        });
      }
    } else {
      try {
        const newStream = await navigator.mediaDevices.getUserMedia({
          video: true,
        });
        const newVideoTrack = newStream.getVideoTracks()[0];
        localStreamRef.current.addTrack(newVideoTrack);
        Object.values(peerConnections.current).forEach((pc) => {
          pc.addTrack(newVideoTrack, localStreamRef.current as MediaStream);
        });
        setIsVideoActive(true);
        if (socketRef.current) {
          socketRef.current.emit('updateStatus', {
            video: true,
            mic: isMicMuted,
            username,
          });
        }
      } catch (err) {
        console.error('Erreur lors de l’activation de la vidéo', err);
      }
    }
  };

  // Arrêter l'appel (ferme toutes les pistes)
  const stopCall = () => {
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((track) => track.stop());
      localStreamRef.current = null;
    }
    setIsCallActive(false);
    setIsVideoActive(false);
    if (socketRef.current) {
      socketRef.current.emit('broadcasterStop');
    }
  };

  // Toggle du micro : active/désactive la piste audio
  const toggleMicMute = () => {
    if (localStreamRef.current) {
      const newMuted = !isMicMuted;
      localStreamRef.current
        .getAudioTracks()
        .forEach((track) => (track.enabled = !newMuted));
      setIsMicMuted(newMuted);
      if (socketRef.current) {
        socketRef.current.emit('updateStatus', {
          video: isVideoActive,
          mic: newMuted,
          username,
        });
      }
    }
  };

  // Toggle du son distant : contrôle le son des vidéos reçues côté client
  const toggleRemoteAudio = () => {
    setIsRemoteAudioMuted((prev) => !prev);
  };

  // Envoi d'un message dans le chat
  const sendMessage = () => {
    if (message.trim() !== '' && socketRef.current) {
      socketRef.current.emit('message', { username, message });
      socketRef.current.emit('stopTyping', username);
      setMessage('');
      clearTimeout(typingTimeoutRef.current as NodeJS.Timeout | undefined);
      typingTimeoutRef.current = null;
    }
  };

  return (
    <div className="p-8">
      <h1 className="text-3xl font-bold mb-6 text-center">
        Chat en temps réel
      </h1>

      {/* Section de lancement de l'appel */}
      {!isCallActive && (
        <div className="mb-4 flex flex-col items-center">
          <p>Choisissez le type d&apos;appel :</p>
          <div className="flex gap-4 mt-2">
            <button
              onClick={() => startCall(true)}
              className="px-4 py-2 bg-green-500 text-white rounded hover:bg-green-600"
            >
              Appel Vidéo
            </button>
            <button
              onClick={() => startCall(false)}
              className="px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600"
            >
              Appel Audio
            </button>
          </div>
        </div>
      )}

      {/* Section de contrôle de l'appel */}
      {isCallActive && (
        <div className="mb-4 flex flex-col items-center">
          {isVideoActive ? (
            <VideoStream
              stream={localStreamRef.current as MediaStream}
              muted={true} // Pour éviter l'effet d'écho en local
              className="w-60 h-40 border border-gray-300 rounded"
            />
          ) : (
            <div className="w-60 h-40 flex items-center justify-center border border-gray-300 rounded bg-gray-200">
              <p>Vidéo désactivée</p>
            </div>
          )}
          <div className="flex flex-wrap gap-2 mt-2">
            <button
              onClick={stopCall}
              className="px-4 py-2 bg-red-500 text-white rounded hover:bg-red-600"
            >
              Arrêter l&apos;appel
            </button>
            <button
              onClick={toggleVideo}
              className="px-4 py-2 bg-gray-500 text-white rounded hover:bg-gray-600"
            >
              {isVideoActive ? 'Désactiver la vidéo' : 'Activer la vidéo'}
            </button>
            <button
              onClick={toggleMicMute}
              className="px-4 py-2 bg-gray-500 text-white rounded hover:bg-gray-600"
            >
              {isMicMuted ? 'Activer le micro' : 'Couper le micro'}
            </button>
            <button
              onClick={toggleRemoteAudio}
              className="px-4 py-2 bg-gray-500 text-white rounded hover:bg-gray-600"
            >
              {isRemoteAudioMuted
                ? 'Activer le son distant'
                : 'Couper le son distant'}
            </button>
          </div>
        </div>
      )}

      {/* Section des flux vidéo distants */}
      {remoteStreams.length > 0 && (
        <div className="mb-4">
          <h2 className="text-xl font-bold mb-2">
            Vidéos des autres utilisateurs :
          </h2>
          <div className="flex flex-wrap">
            {remoteStreams.map((remote) => (
              <div key={remote.id} className="relative m-2">
                <VideoStream
                  stream={remote.stream}
                  muted={isRemoteAudioMuted}
                  className="w-60 h-40 border border-gray-300 rounded"
                />
                {remoteStatuses[remote.id] && (
                  <div className="absolute bottom-0 left-0 right-0 bg-black bg-opacity-50 text-white text-xs p-1">
                    {remoteStatuses[remote.id].username}{' '}
                    {isRemoteAudioMuted && '🔇'}{' '}
                    {remoteStatuses[remote.id].mic && '🚫🎤'}{' '}
                    {!remoteStatuses[remote.id].video && '🚫📷'}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Liste des utilisateurs connectés */}
      <div className="mb-4 p-4 border border-gray-300 rounded">
        <h2 className="text-xl font-bold mb-2">Utilisateurs connectés :</h2>
        <ul className="list-disc pl-5">
          {clients.map((client, index) => (
            <li key={index} className="text-gray-500">
              {client === username ? `${client} (Moi)` : client}
            </li>
          ))}
        </ul>
      </div>

      {/* Chat */}
      <div
        ref={chatContainerRef}
        className="border border-gray-300 p-4 h-80 overflow-y-scroll mb-4 rounded"
      >
        {messages.map((msg, index) => (
          <div key={index} className="mb-2">
            <span className="font-bold text-blue-600">{msg.username} :</span>{' '}
            {msg.message}
          </div>
        ))}
      </div>

      <div className="flex">
        <input
          type="text"
          placeholder="Votre message"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              sendMessage();
            } else {
              if (!typingTimeoutRef.current && socketRef.current) {
                socketRef.current.emit('typing', username);
              }
              clearTimeout(
                typingTimeoutRef.current as NodeJS.Timeout | undefined
              );
              typingTimeoutRef.current = setTimeout(() => {
                if (socketRef.current) {
                  socketRef.current.emit('stopTyping', username);
                }
                typingTimeoutRef.current = null;
              }, 2000);
            }
          }}
          className="flex-1 p-2 text-black border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
        <button
          onClick={sendMessage}
          className="ml-2 px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600"
        >
          Envoyer
        </button>
      </div>

      {typingUsers.length > 0 && (
        <div className="mt-2 italic text-gray-600">
          {typingUsers.join(', ')} {typingUsers.length === 1 ? 'est' : 'sont'}{' '}
          en train d&apos;écrire...
        </div>
      )}
    </div>
  );
}
