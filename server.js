const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

let dados = [];

const publicPath = __dirname;

app.use(express.static(publicPath));

app.get('/', (req, res) => {
  res.sendFile(path.join(publicPath, 'index.html'));
});

io.on('connection', (socket) => {
  socket.emit('load-data', dados);

  socket.on('update-data', (vals) => {
    dados = vals;
    socket.broadcast.emit('load-data', dados);
  });
});

server.listen(3000, '0.0.0.0', () => {
  console.log('Servidor rodando na porta 3000');
});