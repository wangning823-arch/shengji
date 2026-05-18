const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const { GameEngine, isTrump } = require('./game');
const { LLMAIPlayer, FallbackAI } = require('./llm-ai');
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
const dealTimeouts = new Map(); // roomId -> timeoutId

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
    players: room.players.map(p => p ? {
      seat: p.seat,
      userId: p.userId,
      nickname: p.nickname,
      avatar: p.avatar,
      ready: p.ready,
      isAI: p.isAI || false,
      team: p.seat % 2 === 0 ? 1 : 2
    } : null),
    gameId: room.gameId
  };
}

function getRoomList() {
  const roomList = [];
  for (const [id, room] of rooms) {
    if (room.status === 'waiting') {
      const humanPlayers = room.players.filter(p => p && !p.isAI);
      const aiPlayers = room.players.filter(p => p && p.isAI);
      roomList.push({
        id: room.id,
        deckCount: room.deckCount,
        playerCount: humanPlayers.length,
        aiCount: aiPlayers.length,
        totalPlayers: room.players.filter(p => p !== null).length,
        host: room.players.find(p => p !== null)?.nickname || '--'
      });
    }
  }
  return roomList;
}

// 逐轮发牌启动游戏
function startGameWithDealing(room, game, roomId) {
  const dealResult = game.startDeal();
  games.set(game.id, game);
  room.gameId = game.id;
  room.status = 'playing';

  const roomAIs = roomAIPlayers.get(roomId) || {};

  // 发送 game_started（只包含第一轮的手牌）
  const activePlayers = room.players.filter(p => p !== null);
  for (const player of activePlayers) {
    const gameState = game.toJSON(player.seat);
    if (player.ws) {
      send(player.ws, {
        type: 'game_started',
        gameId: game.id,
        hand: game.players[player.seat].hand,
        dealer: game.dealer,
        trumpLevel: game.trumpLevel,
        seat: player.seat,
        state: gameState
      });
    }
  }

  // 启动发牌/亮主循环
  processDealingRound(roomId, game);
}

// 处理逐轮发牌和亮主
function processDealingRound(roomId, game) {
  if (game.status !== 'dealing' && game.status !== 'bidding') return;

  const room = rooms.get(roomId);
  if (!room) return;
  const roomAIs = roomAIPlayers.get(roomId) || {};

  // dealing 阶段：currentSeat 回到 dealer，开始新一轮发牌
  // bidding 阶段：currentSeat 回到 bidRoundStartSeat，开始新一轮发牌
  const shouldDeal = (game.status === 'dealing' && game.currentSeat === game.dealer) ||
                     (game.status === 'bidding' && game.currentSeat === game.bidRoundStartSeat);
  if (shouldDeal && game._dealRound < game._handSize) {
    const result = game.dealNextRound();
    // 广播本轮发牌
    for (const player of room.players.filter(p => p !== null)) {
      if (player.ws) {
        send(player.ws, {
          type: 'cards_dealt',
          hand: game.players[player.seat].hand,
          round: result.round || game._handSize,
          totalRounds: game._handSize
        });
      }
    }
    // 给 AI 设置手牌
    for (let seat = 0; seat < 4; seat++) {
      if (roomAIs[seat]) {
        roomAIs[seat].setHand(game.players[seat].hand);
      }
    }
    if (result.done) {
      broadcast(roomId, {
        type: 'trump_confirmed',
        trumpSuit: game.trumpSuit,
        trumpLevel: game.trumpLevel,
        dealer: game.dealer
      });
      broadcast(roomId, {
        type: 'bottom_taken',
        dealer: game.dealer,
        bottomCount: game.bottomCards.length
      });
      broadcast(roomId, {
        type: 'turn_changed',
        seat: game.currentSeat,
        phase: 'taking_bottom'
      });
      broadcast(roomId, {
        type: 'game_state',
        state: game.toJSON()
      });
      const dealerPlayer = room.players[game.dealer];
      if (dealerPlayer && dealerPlayer.ws) {
        send(dealerPlayer.ws, {
          type: 'game_state',
          state: game.toJSON(game.dealer)
        });
      }
      if (roomAIs[game.dealer]) {
        setTimeout(() => handleAITurn(roomId, game, game.dealer), 500);
      }
      return;
    }
  }

  // 广播当前轮到谁决策
  broadcast(roomId, {
    type: 'turn_changed',
    seat: game.currentSeat,
    phase: game.status,
    bids: game.bids
  });
  broadcast(roomId, {
    type: 'game_state',
    state: game.toJSON()
  });

  // 如果是 AI 的回合
  if (roomAIs[game.currentSeat]) {
    clearDealTimeout(roomId);
    setTimeout(() => handleAIDealBid(roomId, game, game.currentSeat), 600);
  } else {
    // 人类玩家：检查是否有亮主能力
    const canBidNow = game.canBid(game.currentSeat);
    if (!canBidNow) {
      // 没有亮主能力，直接跳过，不等待
      clearDealTimeout(roomId);
      setTimeout(() => {
        if (game.status !== 'dealing' && game.status !== 'bidding') return;
        const passResult = game.passBid(game.currentSeat);
        handleBidPassResult(roomId, game, passResult);
      }, 100);
    } else {
      // 有亮主能力：设置超时自动 pass
      clearDealTimeout(roomId);
      const timeoutId = setTimeout(() => {
        if (game.status !== 'dealing' && game.status !== 'bidding') return;
        const passResult = game.passBid(game.currentSeat);
        handleBidPassResult(roomId, game, passResult);
      }, 10000);
      dealTimeouts.set(roomId, timeoutId);
    }
  }
}

function clearDealTimeout(roomId) {
  const tid = dealTimeouts.get(roomId);
  if (tid) {
    clearTimeout(tid);
    dealTimeouts.delete(roomId);
  }
}

async function handleAIDealBid(roomId, game, seat) {
  if (game.currentSeat !== seat) return;
  if (game.status !== 'dealing' && game.status !== 'bidding') return;

  const roomAIs = roomAIPlayers.get(roomId) || {};
  const aiPlayer = roomAIs[seat];
  if (!aiPlayer) return;

  await new Promise(r => setTimeout(r, 400));
  if (game.currentSeat !== seat) return;
  if (game.status !== 'dealing' && game.status !== 'bidding') return;

  const gameState = game.toJSON(seat);
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
      // 亮主成功后继续流程（推进到下一个玩家）
      handleBidPassResult(roomId, game, { success: true });
      return;
    }
  }

  // AI 没亮主或亮主失败，自动 pass
  if (game.currentSeat === seat && (game.status === 'dealing' || game.status === 'bidding')) {
    const passResult = game.passBid(seat);
    handleBidPassResult(roomId, game, passResult);
  }
}

function handleBidPassResult(roomId, game, passResult) {
  if (!passResult || !passResult.success) return;

  if (passResult.action === 'continue_dealing') {
    setTimeout(() => processDealingRound(roomId, game), 300);
  } else if (passResult.action === 'confirm_trump') {
    // 如果有bids，进入反主等待阶段
    if (game.bids.length > 0) {
      processRebidPhase(roomId, game);
      return;
    }
    // 没有bids，直接确认主牌进入扣底
    const confirmResult = game.confirmTrump();
    broadcast(roomId, {
      type: 'trump_confirmed',
      trumpSuit: confirmResult.trumpSuit,
      trumpLevel: game.trumpLevel,
      dealer: game.dealer
    });
    broadcast(roomId, {
      type: 'bottom_taken',
      dealer: game.dealer,
      bottomCount: confirmResult.bottomCount
    });
    broadcast(roomId, {
      type: 'turn_changed',
      seat: game.currentSeat,
      phase: 'taking_bottom'
    });
    broadcast(roomId, {
      type: 'game_state',
      state: game.toJSON()
    });
    const currentRoom = rooms.get(roomId);
    const dealerPlayer = currentRoom ? currentRoom.players[game.dealer] : null;
    if (dealerPlayer && dealerPlayer.ws) {
      send(dealerPlayer.ws, {
        type: 'game_state',
        state: game.toJSON(game.dealer)
      });
    }
    // AI 庄家扣底
    const roomAIs = roomAIPlayers.get(roomId) || {};
    if (roomAIs[game.dealer]) {
      setTimeout(() => handleAITurn(roomId, game, game.dealer), 500);
    }
  } else {
    // 继续下一个座位
    broadcast(roomId, {
      type: 'turn_changed',
      seat: game.currentSeat,
      phase: game.status
    });
    broadcast(roomId, {
      type: 'game_state',
      state: game.toJSON()
    });
    const roomAIs = roomAIPlayers.get(roomId) || {};
    if (roomAIs[game.currentSeat]) {
      setTimeout(() => handleAIDealBid(roomId, game, game.currentSeat), 200);
    } else {
      // 人类玩家：检查是否有亮主能力
      const canBidNow = game.canBid(game.currentSeat);
      if (!canBidNow) {
        // 没有亮主能力，直接跳过
        clearDealTimeout(roomId);
        setTimeout(() => {
          if (game.status !== 'dealing' && game.status !== 'bidding') return;
          const nextPass = game.passBid(game.currentSeat);
          handleBidPassResult(roomId, game, nextPass);
        }, 100);
      } else {
        // 有亮主能力：设置超时自动 pass
        clearDealTimeout(roomId);
        const timeoutId = setTimeout(() => {
          if (game.status !== 'dealing' && game.status !== 'bidding') return;
          const nextPass = game.passBid(game.currentSeat);
          handleBidPassResult(roomId, game, nextPass);
        }, 10000);
        dealTimeouts.set(roomId, timeoutId);
      }
    }
  }
}

// 反主等待阶段
function processRebidPhase(roomId, game) {
  const room = rooms.get(roomId);
  if (!room) return;

  // 从庄家下家开始检查谁能反主
  const dealer = game.dealer;
  let startSeat = (dealer + 1) % 4;

  // 找到第一个有反主能力的玩家
  let firstRebidSeat = -1;
  for (let i = 0; i < 4; i++) {
    const seat = (startSeat + i) % 4;
    if (game.canRebid(seat)) {
      firstRebidSeat = seat;
      break;
    }
  }

  // 如果没有人能反主，直接确认主牌
  if (firstRebidSeat === -1) {
    confirmAndEnterBottom(roomId, game);
    return;
  }

  // 广播进入反主阶段
  broadcast(roomId, {
    type: 'rebid_phase',
    startSeat: firstRebidSeat
  });

  // 设置反主阶段的 currentSeat
  game.currentSeat = firstRebidSeat;
  game._rebidPhase = true;

  broadcast(roomId, {
    type: 'game_state',
    state: game.toJSON()
  });

  // 开始第一个玩家的反主计时
  handleRebidTurn(roomId, game, firstRebidSeat);
}

// 处理反主阶段的玩家回合
function handleRebidTurn(roomId, game, seat) {
  const room = rooms.get(roomId);
  if (!room || !game._rebidPhase) return;

  broadcast(roomId, {
    type: 'turn_changed',
    seat: seat,
    phase: 'bidding',
    rebidPhase: true,
    bids: game.bids
  });

  const roomAIs = roomAIPlayers.get(roomId) || {};
  if (roomAIs[seat]) {
    // AI 处理反主
    setTimeout(() => handleAIRebid(roomId, game, seat), 600);
  } else {
    // 人类玩家：设置30秒超时
    clearDealTimeout(roomId);
    const timeoutId = setTimeout(() => {
      if (!game._rebidPhase) return;
      handleRebidTimeout(roomId, game, seat);
    }, 30000);
    dealTimeouts.set(roomId, timeoutId);

    // 发送倒计时开始
    sendRebidTimer(roomId, 30);
  }
}

// 处理反主超时
function handleRebidTimeout(roomId, game, seat) {
  if (!game._rebidPhase) return;

  // 超时，自动放弃反主
  handleRebidResult(roomId, game, seat, null);
}

// 处理反主结果（成功或放弃）
function handleRebidResult(roomId, game, seat, bidCards) {
  const room = rooms.get(roomId);
  if (!room || !game._rebidPhase) return;

  clearDealTimeout(roomId);

  if (bidCards) {
    // 有反主，执行反主
    const result = game.bid(seat, bidCards);
    if (result.success) {
      broadcast(roomId, {
        type: 'bid_made',
        seat: seat,
        trumpSuit: result.trumpSuit,
        cards: bidCards
      });

      // 反主成功后，重新检查下一个玩家是否有反主能力
      const nextSeat = (seat + 1) % 4;
      let nextRebidSeat = -1;
      for (let i = 0; i < 3; i++) {
        const s = (nextSeat + i) % 4;
        if (game.canRebid(s)) {
          nextRebidSeat = s;
          break;
        }
      }

      if (nextRebidSeat === -1) {
        // 没有人能反主了，确认主牌
        confirmAndEnterBottom(roomId, game);
      } else {
        // 继续反主阶段
        game.currentSeat = nextRebidSeat;
        broadcast(roomId, {
          type: 'game_state',
          state: game.toJSON()
        });
        handleRebidTurn(roomId, game, nextRebidSeat);
      }
      return;
    }
  }

  // 放弃反主，检查下一个玩家
  const nextSeat = (seat + 1) % 4;
  let nextRebidSeat = -1;
  for (let i = 0; i < 3; i++) {
    const s = (nextSeat + i) % 4;
    if (game.canRebid(s)) {
      nextRebidSeat = s;
      break;
    }
  }

  if (nextRebidSeat === -1) {
    // 没有人能反主了，确认主牌
    confirmAndEnterBottom(roomId, game);
  } else {
    // 继续反主阶段
    game.currentSeat = nextRebidSeat;
    broadcast(roomId, {
      type: 'game_state',
      state: game.toJSON()
    });
    handleRebidTurn(roomId, game, nextRebidSeat);
  }
}

// 确认主牌并进入扣底阶段
function confirmAndEnterBottom(roomId, game) {
  game._rebidPhase = false;

  const confirmResult = game.confirmTrump();
  broadcast(roomId, {
    type: 'trump_confirmed',
    trumpSuit: confirmResult.trumpSuit,
    trumpLevel: game.trumpLevel,
    dealer: game.dealer
  });
  broadcast(roomId, {
    type: 'bottom_taken',
    dealer: game.dealer,
    bottomCount: confirmResult.bottomCount
  });
  broadcast(roomId, {
    type: 'turn_changed',
    seat: game.currentSeat,
    phase: 'taking_bottom'
  });
  broadcast(roomId, {
    type: 'game_state',
    state: game.toJSON()
  });

  const currentRoom = rooms.get(roomId);
  const dealerPlayer = currentRoom ? currentRoom.players[game.dealer] : null;
  if (dealerPlayer && dealerPlayer.ws) {
    send(dealerPlayer.ws, {
      type: 'game_state',
      state: game.toJSON(game.dealer)
    });
  }

  const roomAIs = roomAIPlayers.get(roomId) || {};
  if (roomAIs[game.dealer]) {
    setTimeout(() => handleAITurn(roomId, game, game.dealer), 500);
  }
}

// 发送反主倒计时
function sendRebidTimer(roomId, seconds) {
  broadcast(roomId, {
    type: 'rebid_timer',
    seconds: seconds
  });
}

// AI 反主处理
async function handleAIRebid(roomId, game, seat) {
  if (!game._rebidPhase) return;

  const room = rooms.get(roomId);
  if (!room) return;

  const roomAIs = roomAIPlayers.get(roomId) || {};
  const aiPlayer = roomAIs[seat];
  if (!aiPlayer) return;

  // 检查是否有反主能力
  if (!game.canRebid(seat)) {
    handleRebidResult(roomId, game, seat, null);
    return;
  }

  // AI 决定反主的牌
  const player = game.players[seat];
  const trumpLevelStr = String(game.trumpLevel);
  const existingBid = game.bids[game.bids.length - 1];

  const levelCards = player.hand.filter(c => c.rank === trumpLevelStr && c.suit !== 'joker');
  const jokerCards = player.hand.filter(c => c.suit === 'joker');

  let bidCards = null;

  if (existingBid.suit === null) {
    // 无主情况：需要更多或更大的王
    if (jokerCards.length >= 2) {
      bidCards = jokerCards.slice(0, 2);
    }
  } else {
    // 有主情况：需要比当前多1张级牌 + 1张王
    if (jokerCards.length > 0 && levelCards.length >= (existingBid.levelCount || 0) + 1) {
      bidCards = [...levelCards.slice(0, (existingBid.levelCount || 0) + 1), jokerCards[0]];
    }
  }

  handleRebidResult(roomId, game, seat, bidCards);
}

// 自动开始下一局
function autoStartNextGame(roomId) {
  // 不再自动开始，等待所有玩家点击"下一局"
  // AI玩家自动准备
  const room = rooms.get(roomId);
  if (!room) return;
  const roomAIs = roomAIPlayers.get(roomId) || {};
  room.nextGameReady = room.nextGameReady || new Set();
  room.players.forEach((p, seat) => {
    if (p && roomAIs[seat]) {
      room.nextGameReady.add(p.userId);
    }
  });
  // 广播准备状态
  broadcast(roomId, {
    type: 'next_game_state',
    readyCount: room.nextGameReady.size,
    totalCount: room.players.filter(p => p !== null).length
  });
  // 如果所有人都准备好了（全是AI），直接开始
  checkAndStartNextGame(roomId);
}

function checkAndStartNextGame(roomId) {
  const room = rooms.get(roomId);
  if (!room || room.status !== 'waiting') return;
  const ready = room.nextGameReady || new Set();
  const activePlayers = room.players.filter(p => p !== null);
  if (ready.size < activePlayers.length) return;

  activePlayers.sort((a, b) => a.seat - b.seat);

  const game = new GameEngine(
    room.id, room.deckCount, activePlayers.map(p => ({
      userId: p.userId,
      nickname: p.nickname,
      avatar: p.avatar
    })),
    room.nextDealer ?? 0,
    room.nextTrumpLevel ?? 2,
    room.nextDealer === undefined
  );

  room.nextGameReady = new Set();
  startGameWithDealing(room, game, roomId);
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

  if (req.url === '/api/login/guest' && req.method === 'GET') {
    const guestId = Date.now().toString(36) + Math.random().toString(36).substring(2, 6);
    const user = db.getOrCreateUser('guest_' + guestId, null, '游客' + guestId.slice(-4), null);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ token: guestId, user: { id: user.id, nickname: user.nickname, avatar: user.avatar } }));
    return;
  }

  if (req.url === '/api/login/guest' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { nickname } = JSON.parse(body);
        const guestId = Date.now().toString(36) + Math.random().toString(36).substring(2, 6);
        const displayName = (nickname && nickname.trim()) ? nickname.trim().slice(0, 12) : '游客' + guestId.slice(-4);
        const user = db.getOrCreateUser('guest_' + guestId, null, displayName, null);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ token: guestId, user: { id: user.id, nickname: user.nickname, avatar: user.avatar } }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid request' }));
      }
    });
    return;
  }

  if (req.url === '/api/rooms') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ rooms: getRoomList() }));
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
      const idx = room.players.findIndex(p => p && p.ws === ws);
      if (idx >= 0) {
        const player = room.players[idx];
        room.players[idx] = null;
        // 清理该座位的AI
        const roomAIs = roomAIPlayers.get(ws.roomId) || {};
        delete roomAIs[idx];
        broadcast(ws.roomId, { type: 'player_left', seat: player.seat, nickname: player.nickname });
        broadcast(ws.roomId, { type: 'room_state', state: getRoomState(ws.roomId) });
      }
    }
    clients.delete(ws);
  });
});

// AI自动出牌处理
async function handleAITurn(roomId, game, seat) {
  console.log(`[AI] handleAITurn called: roomId=${roomId}, seat=${seat}, gameStatus=${game.status}, currentSeat=${game.currentSeat}`);

  // 发牌和亮主阶段由 processDealingRound / handleAIDealBid 处理
  if (game.status === 'dealing' || game.status === 'bidding') {
    handleAIDealBid(roomId, game, seat);
    return;
  }

  const roomAIs = roomAIPlayers.get(roomId) || {};
  const aiPlayer = roomAIs[seat];
  if (!aiPlayer) {
    console.log(`[AI] No AI player at seat ${seat}, available seats: ${Object.keys(roomAIs).join(',')}`);
    return;
  }

  // 检查是否还是这个AI的回合
  if (game.currentSeat !== seat) {
    console.log(`[AI] Not seat ${seat}'s turn, currentSeat=${game.currentSeat}`);
    return;
  }

  await new Promise(r => setTimeout(r, 800 + Math.random() * 700));

  // 重新检查（延迟后可能已变化）
  if (game.currentSeat !== seat) {
    console.log(`[AI] After delay, not seat ${seat}'s turn anymore, currentSeat=${game.currentSeat}`);
    return;
  }

  try {
    const gameState = game.toJSON(seat);

    if (game.status === 'bidding' && game.currentSeat === seat) {
      let bidSuccess = false;
      const bidCards = await aiPlayer.decideBid(gameState);
      if (bidCards) {
        const result = game.bid(seat, bidCards);
        if (result.success) {
          bidSuccess = true;
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
      // AI 没有亮主成功，执行 pass
      if (!bidSuccess) {
        const passResult = game.passBid(seat);
        if (passResult.success) {
          broadcast(roomId, {
            type: 'turn_changed',
            seat: game.currentSeat,
            phase: 'bidding',
            bids: game.bids
          });
          broadcast(roomId, {
            type: 'game_state',
            state: game.toJSON()
          });
        }
      }
      // 检查叫主轮次是否结束（转完一圈）
      if (game.status === 'bidding' && game.currentSeat === game.bidRoundStartSeat) {
        await new Promise(r => setTimeout(r, 500));
        const confirmResult = game.confirmTrump();
        broadcast(roomId, {
          type: 'trump_confirmed',
          trumpSuit: confirmResult.trumpSuit,
          trumpLevel: game.trumpLevel,
          dealer: game.dealer
        });
        broadcast(roomId, {
          type: 'bottom_taken',
          dealer: game.dealer,
          bottomCount: confirmResult.bottomCount
        });
        broadcast(roomId, {
          type: 'turn_changed',
          seat: game.currentSeat,
          phase: 'taking_bottom'
        });
        broadcast(roomId, {
          type: 'game_state',
          state: game.toJSON()
        });
        // 给庄家单独发送包含手牌和底牌的 state
        const currentRoom = rooms.get(roomId);
        const dealerPlayer = currentRoom ? currentRoom.players[game.dealer] : null;
        if (dealerPlayer && dealerPlayer.ws) {
          send(dealerPlayer.ws, {
            type: 'game_state',
            state: game.toJSON(game.dealer)
          });
        }
      }
      // 叫主阶段后检查下一个玩家（扣底）
      if (game.currentSeat !== seat) {
        setTimeout(() => {
          const roomAIs = roomAIPlayers.get(roomId) || {};
          if (roomAIs[game.currentSeat]) {
            const currentGame = games.get(game.id);
            if (currentGame) {
              handleAITurn(roomId, currentGame, game.currentSeat);
            }
          }
        }, 200);
      }
    } else if (game.status === 'taking_bottom' && game.currentSeat === seat) {
      const bottomCards = await aiPlayer.decideBottom(gameState);
      if (bottomCards) {
        const cardIds = bottomCards.map(c => c.id);
        const result = game.setBottom(seat, cardIds);
        if (result.success) {
          broadcast(roomId, {
            type: 'bottom_set',
            dealer: seat
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
          setTimeout(() => {
            const roomAIs = roomAIPlayers.get(roomId) || {};
            if (roomAIs[game.currentSeat]) {
              const currentGame = games.get(game.id);
              if (currentGame) {
                handleAITurn(roomId, currentGame, game.currentSeat);
              }
            }
          }, 500);
        }
      }
    } else if (game.status === 'playing' && game.currentSeat === seat) {
      // 先同步AI手牌，确保decidePlay用的是最新手牌
      aiPlayer.hand = game.players[seat].hand;
      // 重新获取gameState以包含最新手牌
      const freshGameState = game.toJSON(seat);

      const leadCards = game.currentTrick.length > 0 ? game.currentTrick[0].cards : null;
      const handIds = aiPlayer.hand.map(c => c.id);
      console.log(`[AI] Seat ${seat} playing, leadCards=${leadCards ? leadCards.length : 'null'}, trickLen=${game.currentTrick.length}, handSize=${aiPlayer.hand.length}, handIds=${handIds.join(',')}`);
      let playCards = await aiPlayer.decidePlay(freshGameState, leadCards);
      let cardIds = playCards.map(c => c.id);
      // 检查选出的牌是否在手牌中
      const inHand = cardIds.every(id => handIds.includes(id));
      console.log(`[AI] Seat ${seat} decided: ${cardIds.join(',')}, inHand=${inHand}`);
      if (!inHand) {
        // 重新从game获取手牌
        aiPlayer.hand = game.players[seat].hand;
        const fbCards = FallbackAI.selectBestValid(aiPlayer.hand, leadCards, freshGameState);
        playCards = fbCards;
        cardIds = playCards.map(c => c.id);
        console.log(`[AI] Seat ${seat} fallback (not in hand): ${cardIds.join(',')}`);
      }
      let result = game.play(seat, cardIds);
      console.log(`[AI] Play result: success=${result.success}, reason=${result.reason || ''}, nextSeat=${result.nextSeat}`);

      // 如果出牌失败，用fallback重试
      if (!result.success) {
        console.log(`[AI] Seat ${seat} play failed, using fallback`);
        aiPlayer.hand = game.players[seat].hand;
        const fallbackCards = FallbackAI.selectBestValid(aiPlayer.hand, leadCards, freshGameState);
        const fallbackIds = fallbackCards.map(c => c.id);
        result = game.play(seat, fallbackIds);
        console.log(`[AI] Seat ${seat} fallback result: success=${result.success}, reason=${result.reason || ''}`);
      }

      // 如果fallback也失败，暴力尝试
      if (!result.success) {
        console.log(`[AI] Seat ${seat} fallback also failed, brute force`);
        aiPlayer.hand = game.players[seat].hand;
        const needCount = leadCards ? leadCards.length : 1;
        // 按同花色优先，补其他花色
        const leadSuit = leadCards ? leadCards[0].suit : null;
        const leadIsTrump = leadCards ? isTrump(leadCards[0], game.trumpSuit, game.trumpLevel) : false;
        const sameSuit = aiPlayer.hand.filter(c => {
          if (leadIsTrump) return isTrump(c, game.trumpSuit, game.trumpLevel);
          return c.suit === leadSuit;
        });
        const other = aiPlayer.hand.filter(c => !sameSuit.includes(c));
        const tryCards = [...sameSuit.slice(0, needCount), ...other.slice(0, Math.max(0, needCount - sameSuit.length))];
        const tryIds = tryCards.map(c => c.id);
        result = game.play(seat, tryIds);
        console.log(`[AI] Seat ${seat} brute force: ${tryIds.join(',')}, success=${result.success}, reason=${result.reason || ''}`);
      }

      if (result.success) {
        // 出牌成功后同步AI手牌
        aiPlayer.hand = game.players[seat].hand;

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
            winner: result.winner,
            scores: result.scores,
            levels: result.levels,
            nextDealer: result.nextDealer,
            nextTrumpLevel: result.nextTrumpLevel,
            bottomPoints: result.bottomPoints,
            bottomMultiplier: result.bottomMultiplier,
            steps: result.steps,
            step: result.step
          });
          const room = rooms.get(roomId);
          if (room) {
            room.status = 'waiting';
            room.gameId = null;
            room.nextDealer = result.nextDealer;
            room.nextTrumpLevel = result.nextTrumpLevel;
          }
          autoStartNextGame(roomId);
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

        // 总是获取最新的游戏状态来检查下一个玩家
        setTimeout(() => {
          const currentGame = games.get(game.id);
          if (!currentGame || currentGame.status !== 'playing') return;
          const roomAIs = roomAIPlayers.get(roomId) || {};
          if (roomAIs[currentGame.currentSeat]) {
            handleAITurn(roomId, currentGame, currentGame.currentSeat);
          }
        }, 200);
      } else {
        // 出牌完全失败，跳过当前AI，让下一个玩家继续
        console.log(`[AI] Seat ${seat} all attempts failed, skipping turn`);
        game.currentSeat = (game.currentSeat + 1) % 4;
        broadcast(roomId, {
          type: 'turn_changed',
          seat: game.currentSeat,
          phase: 'playing'
        });
        setTimeout(() => {
          const currentGame = games.get(game.id);
          if (!currentGame || currentGame.status !== 'playing') return;
          const roomAIs = roomAIPlayers.get(roomId) || {};
          if (roomAIs[currentGame.currentSeat]) {
            handleAITurn(roomId, currentGame, currentGame.currentSeat);
          }
        }, 200);
      }
    }
  } catch (err) {
    console.error('AI error:', err);
  }
}

function findFirstEmptySeat(room) {
  for (let i = 0; i < 4; i++) {
    if (!room.players[i]) return i;
  }
  return -1;
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

  get_rooms(ws, msg) {
    send(ws, { type: 'room_list', rooms: getRoomList() });
  },

  create_room(ws, msg) {
    const roomId = generateRoomId();
    const room = {
      id: roomId,
      deckCount: msg.deckCount || 2,
      status: 'waiting',
      players: [null, null, null, null],
      clients: new Set(),
      gameId: null
    };
    rooms.set(roomId, room);
    send(ws, { type: 'room_created', roomId });
  },

  join_room(ws, msg) {
    const { roomId, seat: requestedSeat } = msg;
    const room = rooms.get(roomId);
    if (!room) {
      send(ws, { type: 'error', message: '房间不存在' });
      return;
    }
    if (room.status !== 'waiting') {
      send(ws, { type: 'error', message: '游戏已开始，无法加入' });
      return;
    }

    // 已在房间中的玩家重连
    let player = room.players.find(p => p && p.userId === ws.userId);
    if (player) {
      player.ws = ws;
      player.online = true;
      player.nickname = ws.nickname;
      player.avatar = ws.avatar;
      ws.roomId = roomId;
      ws.seat = player.seat;
      room.clients.add(ws);
      send(ws, { type: 'joined', seat: player.seat });
      broadcast(roomId, { type: 'room_state', state: getRoomState(roomId) });
      if (room.gameId && games.has(room.gameId)) {
        const game = games.get(room.gameId);
        send(ws, { type: 'game_state', state: game.toJSON(player.seat) });
      }
      return;
    }

    // 选择座位
    let seat;
    if (requestedSeat !== undefined && requestedSeat >= 0 && requestedSeat < 4) {
      if (room.players[requestedSeat]) {
        send(ws, { type: 'error', message: '该座位已被占用' });
        return;
      }
      seat = requestedSeat;
    } else {
      seat = findFirstEmptySeat(room);
      if (seat === -1) {
        send(ws, { type: 'error', message: '房间已满' });
        return;
      }
    }

    player = {
      seat,
      userId: ws.userId,
      nickname: ws.nickname,
      avatar: ws.avatar,
      ready: false,
      ws,
      online: true
    };
    room.players[seat] = player;

    ws.roomId = roomId;
    ws.seat = seat;
    room.clients.add(ws);

    send(ws, { type: 'joined', seat });
    broadcast(roomId, { type: 'player_joined', seat, nickname: player.nickname, avatar: player.avatar });
    broadcast(roomId, { type: 'room_state', state: getRoomState(roomId) });

    if (room.gameId && games.has(room.gameId)) {
      const game = games.get(room.gameId);
      send(ws, { type: 'game_state', state: game.toJSON(seat) });
    }
  },

  sit_seat(ws, msg) {
    if (!ws.roomId) return;
    const room = rooms.get(ws.roomId);
    if (!room || room.status !== 'waiting') return;

    const targetSeat = msg.seat;
    if (targetSeat < 0 || targetSeat > 3) return;

    // 检查目标座位是否为空
    if (room.players[targetSeat]) {
      send(ws, { type: 'error', message: '该座位已被占用' });
      return;
    }

    // 找到自己当前座位
    const currentSeat = room.players.findIndex(p => p && p.ws === ws);
    if (currentSeat === -1) return;

    // 移动到新座位
    const player = room.players[currentSeat];
    room.players[currentSeat] = null;
    player.seat = targetSeat;
    room.players[targetSeat] = player;
    ws.seat = targetSeat;

    broadcast(ws.roomId, { type: 'room_state', state: getRoomState(ws.roomId) });
  },

  leave_room(ws, msg) {
    if (!ws.roomId) return;
    const room = rooms.get(ws.roomId);
    if (!room) return;

    room.clients.delete(ws);
    const idx = room.players.findIndex(p => p && p.ws === ws);
    if (idx >= 0) {
      const player = room.players[idx];
      broadcast(ws.roomId, { type: 'player_left', seat: player.seat, nickname: player.nickname });
      room.players[idx] = null;
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

    const seat = msg.seat !== undefined ? msg.seat : findFirstEmptySeat(room);
    if (seat === -1 || room.players[seat]) {
      send(ws, { type: 'error', message: '没有空座位' });
      return;
    }

    const aiCount = room.players.filter(p => p && p.isAI).length;
    const aiPlayerInfo = {
      seat,
      userId: `ai_${Date.now()}`,
      nickname: `AI玩家${aiCount + 1}`,
      avatar: '🤖',
      ready: true,
      isAI: true,
      ws: null,
      online: true
    };

    room.players[seat] = aiPlayerInfo;

    console.log('Adding AI player to seat', seat);

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

    const player = room.players.find(p => p && p.ws === ws);
    if (player) {
      player.ready = msg.ready;
      broadcast(ws.roomId, { type: 'player_ready', seat: player.seat, ready: msg.ready });
      broadcast(ws.roomId, { type: 'room_state', state: getRoomState(ws.roomId) });
    }
  },

  start_game(ws, msg) {
    if (!ws.roomId) return;
    const room = rooms.get(ws.roomId);
    if (!room) return;

    const activePlayers = room.players.filter(p => p !== null);
    if (activePlayers.length !== 4) {
      send(ws, { type: 'error', message: '需要4人才能开始' });
      return;
    }
    if (room.status === 'playing') {
      send(ws, { type: 'error', message: '游戏已开始' });
      return;
    }
    if (!activePlayers.every(p => p.ready)) {
      send(ws, { type: 'error', message: '有人未准备' });
      return;
    }

    // 按座位号排序，确保 GameEngine 内部索引与房间座位一致
    activePlayers.sort((a, b) => a.seat - b.seat);

    const game = new GameEngine(
      room.id, room.deckCount, activePlayers.map(p => ({
        userId: p.userId,
        nickname: p.nickname,
        avatar: p.avatar
      })),
      room.nextDealer ?? 0,
      room.nextTrumpLevel ?? 2,
      room.nextDealer === undefined
    );

    startGameWithDealing(room, game, ws.roomId);
  },

  bid(ws, msg) {
    if (!ws.roomId) return;
    const room = rooms.get(ws.roomId);
    if (!room || !room.gameId) return;
    const game = games.get(room.gameId);
    if (!game) return;

    const result = game.bid(ws.seat, msg.cards);
    if (result.success) {
      clearDealTimeout(ws.roomId);
      broadcast(ws.roomId, {
        type: 'bid_made',
        seat: ws.seat,
        trumpSuit: result.trumpSuit,
        cards: msg.cards
      });
      broadcast(ws.roomId, {
        type: 'turn_changed',
        seat: game.currentSeat,
        phase: game.status,
        bids: game.bids
      });
      broadcast(ws.roomId, {
        type: 'game_state',
        state: game.toJSON()
      });
      handleBidPassResult(ws.roomId, game, { success: true });
    } else {
      send(ws, { type: 'error', message: result.reason });
    }
  },

  pass_bid(ws, msg) {
    if (!ws.roomId) return;
    const room = rooms.get(ws.roomId);
    if (!room || !room.gameId) return;
    const game = games.get(room.gameId);
    if (!game) return;

    const result = game.passBid(ws.seat);
    if (result.success) {
      clearDealTimeout(ws.roomId);
      handleBidPassResult(ws.roomId, game, result);
    } else {
      send(ws, { type: 'error', message: result.reason });
    }
  },

  rebid(ws, msg) {
    if (!ws.roomId) return;
    const room = rooms.get(ws.roomId);
    if (!room || !room.gameId) return;
    const game = games.get(room.gameId);
    if (!game || !game._rebidPhase) return;

    if (ws.seat !== game.currentSeat) {
      send(ws, { type: 'error', message: '不是你的回合' });
      return;
    }

    if (!msg.cards || msg.cards.length === 0) {
      send(ws, { type: 'error', message: '请选择要反主的牌' });
      return;
    }

    handleRebidResult(ws.roomId, game, ws.seat, msg.cards);
  },

  pass_rebid(ws, msg) {
    if (!ws.roomId) return;
    const room = rooms.get(ws.roomId);
    if (!room || !room.gameId) return;
    const game = games.get(room.gameId);
    if (!game || !game._rebidPhase) return;

    if (ws.seat !== game.currentSeat) {
      send(ws, { type: 'error', message: '不是你的回合' });
      return;
    }

    handleRebidResult(ws.roomId, game, ws.seat, null);
  },

  set_bottom(ws, msg) {
    if (!ws.roomId) return;
    const room = rooms.get(ws.roomId);
    if (!room || !room.gameId) return;
    const game = games.get(room.gameId);
    if (!game) return;

    const result = game.setBottom(ws.seat, msg.cardIds);
    if (result.success) {
      broadcast(ws.roomId, {
        type: 'bottom_set',
        dealer: ws.seat
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
      // 给庄家单独发送包含更新后手牌的 state
      const dealerPlayer = room.players[game.dealer];
      if (dealerPlayer && dealerPlayer.ws) {
        send(dealerPlayer.ws, {
          type: 'game_state',
          state: game.toJSON(game.dealer)
        });
      }

      const roomAIs = roomAIPlayers.get(ws.roomId) || {};
      if (roomAIs[game.currentSeat]) {
        setTimeout(() => {
          handleAITurn(ws.roomId, game, game.currentSeat);
        }, 500);
      }
    } else {
      send(ws, { type: 'error', message: result.reason });
    }
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
          winner: result.winner,
          scores: result.scores,
          levels: result.levels,
          nextDealer: result.nextDealer,
          nextTrumpLevel: result.nextTrumpLevel,
          bottomPoints: result.bottomPoints,
          bottomMultiplier: result.bottomMultiplier,
          steps: result.steps,
          step: result.step
        });
        room.status = 'waiting';
        room.gameId = null;
        room.nextDealer = result.nextDealer;
        room.nextTrumpLevel = result.nextTrumpLevel;
        autoStartNextGame(ws.roomId);
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

      const roomAIs = roomAIPlayers.get(ws.roomId) || {};
      if (!result.gameEnded && roomAIs[result.nextSeat]) {
        setTimeout(() => {
          const currentGame = games.get(room.gameId);
          if (currentGame) {
            handleAITurn(ws.roomId, currentGame, result.nextSeat);
          }
        }, 200);
      }
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
  },

  next_game_ready(ws, msg) {
    if (!ws.roomId) return;
    const room = rooms.get(ws.roomId);
    if (!room || room.status !== 'waiting') return;
    if (!ws.userId) return;

    room.nextGameReady = room.nextGameReady || new Set();
    room.nextGameReady.add(ws.userId);

    broadcast(ws.roomId, {
      type: 'next_game_state',
      readyCount: room.nextGameReady.size,
      totalCount: room.players.filter(p => p !== null).length
    });

    checkAndStartNextGame(ws.roomId);
  }
};

server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
