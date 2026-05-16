const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const { GameEngine } = require('./game');
const { LLMAIPlayer } = require('./llm-ai');
const db = require('./db');

// 加载配置
let llmConfig = {};
try {
  const configPath = path.join(__dirname, 'config.js');
  if (fs.existsSync(configPath)) {
    llmConfig = require(configPath).llm || {};
  }
} catch (e) {
  console.log('No config.js found, using fallback AI only');
}

// 房间中的AI玩家
const roomAIPlayers = new Map();

const PORT = process.env.PORT || 3003;
const rooms = new Map();
const games = new Map();
const clients = new Map();

const MIME_TYPES = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.md': 'text/markdown; charset=utf-8',
};

function serveStatic(req, res) {
  let filePath = path.join(__dirname, 'public', req.url === '/' ? 'index.html' : req.url);
  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, content) => {
    if (err) {
      if (err.code === 'ENOENT') {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
      } else {
        res.writeHead(500);
        res.end('Server Error');
      }
      return;
    }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(content);
  });
}

function generateRoomId() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

function broadcast(roomId, message, excludeWs = null) {
  const room = rooms.get(roomId);
  if (!room) return;
  for (const ws of room.clients) {
    if (ws !== excludeWs && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    }
  }
}

function send(ws, message) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
  }
}

function getRoomState(roomId) {
  const room = rooms.get(roomId);
  if (!room) return null;
  return {
    id: room.id,
    deckCount: room.deckCount,
    status: room.status,
    players: room.players.map(p => ({
      seat: p.seat,
      userId: p.userId,
      nickname: p.nickname,
      avatar: p.avatar,
      ready: p.ready,
      team: p.seat % 2 === 0 ? 1 : 2
    })),
    gameId: room.gameId
  };
}

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.url === '/api/login/guest') {
    const guestId = Date.now().toString(36) + Math.random().toString(36).substring(2, 6);
    const user = db.getOrCreateUser('guest_' + guestId, null, '游客' + guestId.slice(-4), null);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ token: guestId, user: { id: user.id, nickname: user.nickname, avatar: user.avatar } }));
    return;
  }

  serveStatic(req, res);
});

const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
  ws.userId = null;
  ws.roomId = null;
  ws.seat = -1;

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
      console.log('Received message:', msg.type);
    } catch {
      return;
    }

    const handler = messageHandlers[msg.type];
    if (handler) {
      handler(ws, msg);
    } else {
      console.log('No handler for message type:', msg.type);
    }
  });

  ws.on('close', () => {
    if (ws.roomId && rooms.has(ws.roomId)) {
      const room = rooms.get(ws.roomId);
      room.clients.delete(ws);
      const player = room.players.find(p => p.ws === ws);
      if (player) {
        player.online = false;
        broadcast(ws.roomId, { type: 'player_left', seat: player.seat, nickname: player.nickname });
        broadcast(ws.roomId, { type: 'room_state', state: getRoomState(ws.roomId) });
      }
    }
    clients.delete(ws);
  });
});

// AI自动出牌处理
async function handleAITurn(roomId, game, seat) {
  const roomAIs = roomAIPlayers.get(roomId) || {};
  const aiPlayer = roomAIs[seat];
  if (!aiPlayer) return;

  // 延迟一点，让游戏更自然
  await new Promise(r => setTimeout(r, 800 + Math.random() * 700));

  try {
    const gameState = game.toJSON(seat);

    if (game.status === 'bidding') {
      // 亮主阶段
      const bidCards = await aiPlayer.decideBid(gameState);
      if (bidCards) {
        const result = game.bid(seat, bidCards);
        if (result.success) {
          broadcast(roomId, {
            type: 'bid_made',
            seat,
            trumpSuit: result.trumpSuit,
            cards: bidCards
          });
          broadcast(roomId, {
            type: 'game_state',
            state: game.toJSON()
          });
        }
      }
      // 自动确认主牌（简化）
      if (game.status === 'bidding' && game.currentSeat === seat) {
        await new Promise(r => setTimeout(r, 500));
        const confirmResult = game.confirmTrump();
        broadcast(roomId, {
          type: 'trump_confirmed',
          trumpSuit: confirmResult.trumpSuit,
          trumpLevel: game.trumpLevel,
          dealer: game.dealer
        });
        broadcast(roomId, {
          type: 'turn_changed',
          seat: game.currentSeat,
          phase: 'playing'
        });
        broadcast(roomId, {
          type: 'game_state',
          state: game.toJSON()
        });
      }
    } else if (game.status === 'playing' && game.currentSeat === seat) {
      // 出牌阶段
      const leadCards = game.currentTrick.length > 0 ? game.currentTrick[0].cards : null;
      const playCards = await aiPlayer.decidePlay(gameState, leadCards);
      const cardIds = playCards.map(c => c.id);
      const result = game.play(seat, cardIds);

      if (result.success) {
        broadcast(roomId, {
          type: 'cards_played',
          seat,
          cards: result.playedCards,
          nextSeat: result.nextSeat
        });

        if (result.trickEnded) {
          broadcast(roomId, {
            type: 'trick_ended',
            winnerSeat: result.winnerSeat,
            winnerTeam: result.winnerTeam,
            points: result.points,
            scores: result.scores,
            nextSeat: result.nextSeat
          });
        }

        if (result.gameEnded) {
          broadcast(roomId, {
            type: 'game_ended',
            idleScore: result.idleScore,
            dealerTeam: result.dealerTeam,
            scores: result.scores,
            levels: result.levels,
            nextDealer: result.nextDealer,
            nextTrumpLevel: result.nextTrumpLevel
          });
          const room = rooms.get(roomId);
          if (room) {
            room.status = 'waiting';
            room.gameId = null;
          }
        } else {
          broadcast(roomId, {
            type: 'turn_changed',
            seat: result.nextSeat,
            phase: 'playing'
          });
        }

        broadcast(roomId, {
          type: 'game_state',
          state: game.toJSON()
        });

        // 下一个如果是AI，继续处理
        if (result.nextSeat !== undefined && result.nextSeat !== seat) {
          setTimeout(() => {
            const roomAIs = roomAIPlayers.get(roomId) || {};
            if (roomAIs[result.nextSeat]) {
              const game = games.get(room.gameId);
              if (game) {
                handleAITurn(roomId, game, result.nextSeat);
              }
            }
          }, 200);
        }
      }
    }
  } catch (err) {
    console.error('AI error:', err);
  }
}

const messageHandlers = {
  auth(ws, msg) {
    const { userId, nickname, avatar } = msg;
    ws.userId = userId;
    ws.nickname = nickname;
    ws.avatar = avatar;
    clients.set(ws, { userId, nickname, avatar });
    send(ws, { type: 'auth_ok' });
  },

  create_room(ws, msg) {
    const roomId = generateRoomId();
    const room = {
      id: roomId,
      deckCount: msg.deckCount || 2,
      status: 'waiting',
      players: [],
      clients: new Set(),
      gameId: null
    };
    rooms.set(roomId, room);
    send(ws, { type: 'room_created', roomId });
  },

  join_room(ws, msg) {
    const { roomId } = msg;
    const room = rooms.get(roomId);
    if (!room) {
      send(ws, { type: 'error', message: '房间不存在' });
      return;
    }

    let player = room.players.find(p => p.userId === ws.userId);
    if (!player) {
      if (room.players.length >= 4) {
        send(ws, { type: 'error', message: '房间已满' });
        return;
      }
      const seat = room.players.length;
      player = {
        seat,
        userId: ws.userId,
        nickname: ws.nickname,
        avatar: ws.avatar,
        ready: false,
        ws,
        online: true
      };
      room.players.push(player);
    } else {
      player.ws = ws;
      player.online = true;
      player.nickname = ws.nickname;
      player.avatar = ws.avatar;
    }

    ws.roomId = roomId;
    ws.seat = player.seat;
    room.clients.add(ws);

    send(ws, { type: 'joined', seat: player.seat });
    broadcast(roomId, { type: 'player_joined', seat: player.seat, nickname: player.nickname, avatar: player.avatar });
    broadcast(roomId, { type: 'room_state', state: getRoomState(roomId) });

    if (room.gameId && games.has(room.gameId)) {
      const game = games.get(room.gameId);
      send(ws, { type: 'game_state', state: game.toJSON(player.seat) });
    }
  },

  leave_room(ws, msg) {
    if (!ws.roomId) return;
    const room = rooms.get(ws.roomId);
    if (!room) return;

    room.clients.delete(ws);
    const idx = room.players.findIndex(p => p.ws === ws);
    if (idx >= 0) {
      const player = room.players[idx];
      broadcast(ws.roomId, { type: 'player_left', seat: player.seat, nickname: player.nickname });
      room.players.splice(idx, 1);
      room.players.forEach((p, i) => p.seat = i);
    }

    ws.roomId = null;
    ws.seat = -1;
    broadcast(room.id, { type: 'room_state', state: getRoomState(room.id) });
  },

  add_ai(ws, msg) {
    console.log('add_ai called, roomId:', ws.roomId);
    if (!ws.roomId) {
      send(ws, { type: 'error', message: '不在房间中' });
      return;
    }
    const room = rooms.get(ws.roomId);
    if (!room) {
      send(ws, { type: 'error', message: '房间不存在' });
      return;
    }
    if (room.players.length >= 4) {
      send(ws, { type: 'error', message: '房间已满' });
      return;
    }

    const seat = room.players.length;
    const aiPlayerInfo = {
      seat,
      userId: `ai_${Date.now()}`,
      nickname: `AI玩家${seat + 1}`,
      avatar: '🤖',
      ready: true,
      isAI: true,
      ws: null,
      online: true
    };

    room.players.push(aiPlayerInfo);

    console.log('Adding AI player to seat', seat);

    // 初始化AI玩家
    if (!roomAIPlayers.has(ws.roomId)) {
      roomAIPlayers.set(ws.roomId, {});
    }
    const roomAIs = roomAIPlayers.get(ws.roomId);
    roomAIs[seat] = new LLMAIPlayer(seat, aiPlayerInfo, llmConfig);

    broadcast(ws.roomId, { type: 'player_joined', seat, nickname: aiPlayerInfo.nickname, avatar: aiPlayerInfo.avatar, isAI: true });
    broadcast(ws.roomId, { type: 'room_state', state: getRoomState(ws.roomId) });
  },

  ready(ws, msg) {
    if (!ws.roomId) return;
    const room = rooms.get(ws.roomId);
    if (!room) return;

    const player = room.players.find(p => p.seat === ws.seat);
    if (player) {
      player.ready = msg.ready;
      broadcast(ws.roomId, { type: 'player_ready', seat: ws.seat, ready: msg.ready });
      broadcast(ws.roomId, { type: 'room_state', state: getRoomState(ws.roomId) });
    }
  },

  start_game(ws, msg) {
    if (!ws.roomId) return;
    const room = rooms.get(ws.roomId);
    if (!room || room.players.length !== 4) {
      send(ws, { type: 'error', message: '需要4人才能开始' });
      return;
    }
    if (room.status === 'playing') {
      send(ws, { type: 'error', message: '游戏已开始' });
      return;
    }
    if (!room.players.every(p => p.ready)) {
      send(ws, { type: 'error', message: '有人未准备' });
      return;
    }

    const game = new GameEngine(room.id, room.deckCount, room.players.map(p => ({
      userId: p.userId,
      nickname: p.nickname,
      avatar: p.avatar
    })));

    const dealResult = game.deal();
    games.set(game.id, game);
    room.gameId = game.id;
    room.status = 'playing';

    // 设置AI玩家的手牌
    const roomAIs = roomAIPlayers.get(ws.roomId) || {};
    for (let seat = 0; seat < 4; seat++) {
      if (roomAIs[seat]) {
        roomAIs[seat].setHand(game.players[seat].hand);
      }
    }

    // 给真人玩家发消息
    for (const player of room.players) {
      const gameState = game.toJSON(player.seat);
      const hand = game.players[player.seat].hand;
      if (player.ws) {
        send(player.ws, {
          type: 'game_started',
          gameId: game.id,
          hand,
          dealer: game.dealer,
          trumpLevel: game.trumpLevel,
          seat: player.seat,
          state: gameState
        });
      }
    }

    broadcast(ws.roomId, {
      type: 'turn_changed',
      seat: game.currentSeat,
      phase: 'bidding'
    });

    // 如果是AI先手，触发AI回合
    if (roomAIs[game.currentSeat]) {
      setTimeout(() => {
        handleAITurn(ws.roomId, game, game.currentSeat);
      }, 500);
    }
  },

  bid(ws, msg) {
    if (!ws.roomId) return;
    const room = rooms.get(ws.roomId);
    if (!room || !room.gameId) return;
    const game = games.get(room.gameId);
    if (!game) return;

    const result = game.bid(ws.seat, msg.cards);
    if (result.success) {
      broadcast(ws.roomId, {
        type: 'bid_made',
        seat: ws.seat,
        trumpSuit: result.trumpSuit,
        cards: msg.cards
      });
      broadcast(ws.roomId, {
        type: 'game_state',
        state: game.toJSON()
      });
    } else {
      send(ws, { type: 'error', message: result.reason });
    }
  },

  confirm_trump(ws, msg) {
    if (!ws.roomId) return;
    const room = rooms.get(ws.roomId);
    if (!room || !room.gameId) return;
    const game = games.get(room.gameId);
    if (!game) return;

    const result = game.confirmTrump();
    broadcast(ws.roomId, {
      type: 'trump_confirmed',
      trumpSuit: result.trumpSuit,
      trumpLevel: game.trumpLevel,
      dealer: game.dealer
    });
    broadcast(ws.roomId, {
      type: 'turn_changed',
      seat: game.currentSeat,
      phase: 'playing'
    });
    broadcast(ws.roomId, {
      type: 'game_state',
      state: game.toJSON()
    });
  },

  play(ws, msg) {
    if (!ws.roomId) return;
    const room = rooms.get(ws.roomId);
    if (!room || !room.gameId) return;
    const game = games.get(room.gameId);
    if (!game) return;

    const result = game.play(ws.seat, msg.cardIds);
    if (result.success) {
      broadcast(ws.roomId, {
        type: 'cards_played',
        seat: ws.seat,
        cards: result.playedCards,
        nextSeat: result.nextSeat
      });

      if (result.trickEnded) {
        broadcast(ws.roomId, {
          type: 'trick_ended',
          winnerSeat: result.winnerSeat,
          winnerTeam: result.winnerTeam,
          points: result.points,
          scores: result.scores,
          nextSeat: result.nextSeat
        });
      }

      if (result.gameEnded) {
        broadcast(ws.roomId, {
          type: 'game_ended',
          idleScore: result.idleScore,
          dealerTeam: result.dealerTeam,
          scores: result.scores,
          levels: result.levels,
          nextDealer: result.nextDealer,
          nextTrumpLevel: result.nextTrumpLevel
        });
        room.status = 'waiting';
        room.gameId = null;
      } else {
        let leadSuit = null;
        if (game.currentTrick.length > 0 && game.currentTrick[0].cards.length > 0) {
          leadSuit = game.currentTrick[0].cards[0].suit;
        }
        broadcast(ws.roomId, {
          type: 'turn_changed',
          seat: result.nextSeat,
          phase: 'playing',
          leadSuit
        });
      }

      broadcast(ws.roomId, {
        type: 'game_state',
        state: game.toJSON()
      });
    } else {
      send(ws, { type: 'error', message: result.reason });
    }
  },

  chat(ws, msg) {
    if (!ws.roomId) return;
    broadcast(ws.roomId, {
      type: 'chat',
      seat: ws.seat,
      nickname: ws.nickname,
      message: msg.message,
      isVoice: msg.isVoice || false
    }, ws);
  },

  voice_signal(ws, msg) {
    if (!ws.roomId) return;
    broadcast(ws.roomId, {
      type: 'voice_signal',
      seat: ws.seat,
      signal: msg.signal,
      target: msg.target
    }, ws);
  }
};

server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
