const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');

const app = express();
const server = http.createServer(app);

// Настройка CORS для Socket.IO
const io = socketIo(server, {
  cors: {
    origin: "*", // В продакшене укажите конкретный домен
    methods: ["GET", "POST"],
    credentials: true
  }
});

app.use(cors());
app.use(express.json());

// Хранилище игроков и комнат
const players = new Map();
const rooms = new Map();
const games = new Map();

// Базовые маршруты
app.get('/', (req, res) => {
  res.json({ 
    message: 'GameBox Server is running! 🎮',
    version: '1.0.0',
    players: players.size,
    rooms: rooms.size,
    games: games.size,
    endpoints: {
      health: '/health',
      stats: '/stats',
      rooms: '/rooms'
    }
  });
});

app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy',
    uptime: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
    memory: process.memoryUsage()
  });
});

app.get('/stats', (req, res) => {
  res.json({
    players: players.size,
    rooms: rooms.size,
    games: games.size,
    activeRooms: Array.from(rooms.entries()).map(([roomId, playerIds]) => ({
      roomId,
      playerCount: playerIds.size
    }))
  });
});

app.get('/rooms', (req, res) => {
  const roomList = Array.from(rooms.entries()).map(([roomId, playerIds]) => {
    const roomPlayers = Array.from(playerIds)
      .map(id => players.get(id))
      .filter(p => p)
      .map(p => ({ username: p.username, id: p.id }));
    
    return {
      roomId,
      playerCount: playerIds.size,
      players: roomPlayers
    };
  });
  
  res.json(roomList);
});

// Socket.IO обработчики
io.on('connection', (socket) => {
  console.log(`🔌 Player connected: ${socket.id}`);

  // Регистрация игрока
  socket.on('register-player', (playerData) => {
    players.set(socket.id, {
      id: socket.id,
      username: playerData.username || `Player_${socket.id.slice(0, 6)}`,
      avatar: playerData.avatar || { body: '#3b82f6', head: '#fbbf24', accessory: 'none' },
      x: 50,
      y: 300,
      room: null,
      lastUpdate: Date.now()
    });
    
    console.log(`👤 Player registered: ${playerData.username || 'Anonymous'}`);
    
    // Отправить подтверждение регистрации
    socket.emit('registration-confirmed', {
      id: socket.id,
      message: 'Successfully registered!'
    });
  });

  // Присоединение к комнате (игре)
  socket.on('join-room', (roomId) => {
    const player = players.get(socket.id);
    if (!player) {
      socket.emit('error', { message: 'Player not registered' });
      return;
    }

    // Покинуть предыдущую комнату
    if (player.room) {
      socket.leave(player.room);
      const oldRoom = rooms.get(player.room);
      if (oldRoom) {
        oldRoom.delete(socket.id);
        if (oldRoom.size === 0) {
          rooms.delete(player.room);
        } else {
          socket.to(player.room).emit('player-left', socket.id);
        }
      }
    }

    // Присоединиться к новой комнате
    socket.join(roomId);
    player.room = roomId;
    player.lastUpdate = Date.now();

    if (!rooms.has(roomId)) {
      rooms.set(roomId, new Set());
    }
    rooms.get(roomId).add(socket.id);

    // Отправить информацию о других игроках в комнате
    const roomPlayers = Array.from(rooms.get(roomId))
      .filter(id => id !== socket.id)
      .map(id => players.get(id))
      .filter(p => p);

    socket.emit('players-update', roomPlayers);
    socket.to(roomId).emit('player-joined', {
      id: player.id,
      username: player.username,
      avatar: player.avatar,
      x: player.x,
      y: player.y
    });

    console.log(`🏠 Player ${player.username} joined room ${roomId} (${rooms.get(roomId).size} players)`);
  });

  // Покинуть комнату
  socket.on('leave-room', () => {
    const player = players.get(socket.id);
    if (!player || !player.room) return;

    socket.leave(player.room);
    const room = rooms.get(player.room);
    if (room) {
      room.delete(socket.id);
      if (room.size === 0) {
        rooms.delete(player.room);
      } else {
        socket.to(player.room).emit('player-left', socket.id);
      }
    }

    console.log(`🚪 Player ${player.username} left room ${player.room}`);
    player.room = null;
  });

  // Движение игрока
  socket.on('player-move', (data) => {
    const player = players.get(socket.id);
    if (!player || !player.room) return;

    // Валидация координат
    const x = Math.max(0, Math.min(750, data.x || 0));
    const y = Math.max(0, Math.min(350, data.y || 0));

    player.x = x;
    player.y = y;
    player.lastUpdate = Date.now();

    // Отправить обновление позиции другим игрокам в комнате
    socket.to(player.room).emit('player-moved', {
      id: socket.id,
      x: x,
      y: y,
      timestamp: player.lastUpdate
    });
  });

  // Чат сообщения
  socket.on('chat-message', (data) => {
    const player = players.get(socket.id);
    if (!player || !player.room) return;

    const message = {
      id: Date.now(),
      playerId: socket.id,
      username: player.username,
      message: data.message.slice(0, 200), // Ограничение длины сообщения
      timestamp: Date.now()
    };

    // Отправить сообщение всем игрокам в комнате
    io.to(player.room).emit('chat-message', message);
    console.log(`💬 ${player.username}: ${message.message}`);
  });

  // Сохранение игры
  socket.on('save-game', (gameData) => {
    const player = players.get(socket.id);
    if (!player) return;

    const gameId = `game_${Date.now()}_${socket.id.slice(0, 6)}`;
    games.set(gameId, {
      id: gameId,
      title: gameData.title,
      description: gameData.description,
      creator: player.username,
      createdAt: new Date().toISOString(),
      gameData: gameData.gameData,
      plays: 0,
      likes: 0
    });

    socket.emit('game-saved', { gameId, message: 'Game saved successfully!' });
    console.log(`💾 Game saved: ${gameData.title} by ${player.username}`);
  });

  // Получить список игр
  socket.on('get-games', () => {
    const gameList = Array.from(games.values());
    socket.emit('games-list', gameList);
  });

  // Отключение игрока
  socket.on('disconnect', () => {
    const player = players.get(socket.id);
    if (player) {
      // Покинуть комнату при отключении
      if (player.room) {
        const room = rooms.get(player.room);
        if (room) {
          room.delete(socket.id);
          if (room.size === 0) {
            rooms.delete(player.room);
          } else {
            socket.to(player.room).emit('player-left', socket.id);
          }
        }
      }
      
      players.delete(socket.id);
      console.log(`❌ Player disconnected: ${player.username} (${socket.id})`);
    }
  });

  // Обработка ошибок
  socket.on('error', (error) => {
    console.error(`🚨 Socket error for ${socket.id}:`, error);
  });
});

// Очистка неактивных игроков каждые 5 минут
setInterval(() => {
  const now = Date.now();
  const timeout = 5 * 60 * 1000; // 5 минут

  for (const [socketId, player] of players.entries()) {
    if (now - player.lastUpdate > timeout) {
      console.log(`🧹 Cleaning up inactive player: ${player.username}`);
      
      if (player.room) {
        const room = rooms.get(player.room);
        if (room) {
          room.delete(socketId);
          if (room.size === 0) {
            rooms.delete(player.room);
          }
        }
      }
      
      players.delete(socketId);
    }
  }
}, 5 * 60 * 1000);

// Запуск сервера
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`🚀 GameBox Server running on port ${PORT}`);
  console.log(`📊 Dashboard: http://localhost:${PORT}`);
  console.log(`🏥 Health check: http://localhost:${PORT}/health`);
  console.log(`📈 Stats: http://localhost:${PORT}/stats`);
});

// Обработка ошибок
process.on('uncaughtException', (error) => {
  console.error('🚨 Uncaught Exception:', error);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('🚨 Unhandled Rejection at:', promise, 'reason:', reason);
});