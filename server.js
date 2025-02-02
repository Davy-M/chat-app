import { createServer } from 'node:http';
import next from 'next';
import { Server } from 'socket.io';

const dev = process.env.NODE_ENV !== 'production';
const hostname = 'localhost';
const port = 3000;
// when using middleware `hostname` and `port` must be provided below
const app = next({ dev, hostname, port });
const handler = app.getRequestHandler();

// Objet pour stocker les utilisateurs connectés : { socketId: username }
const connectedClients = {};

app.prepare().then(() => {
  const httpServer = createServer(handler);
  const io = new Server(httpServer);

  io.on('connection', (socket) => {
    console.log('Client connecté :', socket.id);

    // Gestion du chat
    socket.on('join', (username) => {
      connectedClients[socket.id] = username;
      console.log(`User joined: ${username} (Socket: ${socket.id})`);
      io.emit('clients', Object.values(connectedClients));
    });

    socket.on('message', (data) => {
      console.log('Message reçu de', data.username, ':', data.message);
      io.emit('message', data);
    });

    socket.on('typing', (username) => {
      socket.broadcast.emit('typing', username);
    });

    socket.on('stopTyping', (username) => {
      socket.broadcast.emit('stopTyping', username);
    });

    // --- Signalisation WebRTC ---

    // Le diffuseur informe les watchers qu'il est actif
    socket.on('broadcaster', () => {
      console.log('Diffusion lancée par', socket.id);
      socket.broadcast.emit('broadcaster', socket.id);
    });

    // Dans server.js (ajoutez ceci dans io.on("connection", ...)
    socket.on('broadcasterStop', () => {
      console.log('Le diffuseur', socket.id, 'a arrêté sa diffusion');
      // Informer tous les clients que ce diffuseur a arrêté
      socket.broadcast.emit('broadcasterStop', socket.id);
    });

    // Lorsqu'un watcher veut voir la diffusion, il informe le diffuseur
    socket.on('watcher', (broadcasterId) => {
      console.log('Watcher', socket.id, 'veut voir le flux de', broadcasterId);
      io.to(broadcasterId).emit('watcher', socket.id);
    });

    // Transmission d'une offre SDP
    socket.on('offer', (data) => {
      console.log("Transfert d'une offre de", socket.id, 'vers', data.target);
      io.to(data.target).emit('offer', { sdp: data.sdp, caller: socket.id });
    });

    // Transmission d'une réponse SDP
    socket.on('answer', (data) => {
      console.log("Transfert d'une réponse de", socket.id, 'vers', data.target);
      io.to(data.target).emit('answer', { sdp: data.sdp, caller: socket.id });
    });

    // Transmission d'un ICE candidate
    socket.on('candidate', (data) => {
      console.log(
        "Transfert d'un ICE candidate de",
        socket.id,
        'vers',
        data.target
      );
      io.to(data.target).emit('candidate', {
        candidate: data.candidate,
        caller: socket.id,
      });
    });

    socket.on('disconnect', () => {
      console.log('Client déconnecté :', socket.id);
      delete connectedClients[socket.id];
      io.emit('clients', Object.values(connectedClients));
      socket.broadcast.emit('disconnectPeer', socket.id);
    });
  });

  httpServer
    .once('error', (err) => {
      console.error(err);
      process.exit(1);
    })
    .listen(port, () => {
      console.log(`> Ready on http://${hostname}:${port}`);
    });
});
