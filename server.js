import { createServer } from 'node:http';
import next from 'next';
import { Server } from 'socket.io';

const dev = process.env.NODE_ENV !== 'production';
const hostname = dev ? 'localhost' : '0.0.0.0';
const port = process.env.PORT || 3000;
// when using middleware `hostname` and `port` must be provided below
const app = next({ dev, hostname, port });
const handler = app.getRequestHandler();

// Objet pour stocker les utilisateurs connectés : { socketId: username }
const connectedClients = {};

app.prepare().then(() => {
  const httpServer = createServer(handler);
  const io = new Server(httpServer);

  io.on('connection', (socket) => {
    console.log('Client connect&eacute; :', socket.id);

    // Gestion du chat
    socket.on('join', (username) => {
      connectedClients[socket.id] = username;
      console.log(`User joined: ${username} (Socket: ${socket.id})`);
      io.emit('clients', Object.values(connectedClients));
    });

    socket.on('message', (data) => {
      console.log('Message re&ccedil;u de', data.username, ':', data.message);
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
      console.log('Diffusion lanc&eacute;e par', socket.id);
      socket.broadcast.emit('broadcaster', socket.id);
    });

    socket.on('broadcasterStop', () => {
      console.log(
        'Le diffuseur',
        socket.id,
        'a arr&ecirc;t&eacute; sa diffusion'
      );
      // Informer tous les clients que ce diffuseur a arr&ecirc;t&eacute;
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

    // Transmission d'une r&eacute;ponse SDP
    socket.on('answer', (data) => {
      console.log(
        "Transfert d'une r&eacute;ponse de",
        socket.id,
        'vers',
        data.target
      );
      io.to(data.target).emit('answer', { sdp: data.sdp, caller: socket.id });
    });

    // Relai de l'&eacute;v&egrave;nement updateStatus
    socket.on('updateStatus', (data) => {
      // On ajoute l'id du socket au message
      socket.broadcast.emit('updateStatus', { id: socket.id, ...data });
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
      console.log('Client d&eacute;connect&eacute; :', socket.id);
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
      console.log(`&gt; Ready on http://${hostname}:${port}`);
    });
});
