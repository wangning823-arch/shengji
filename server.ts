import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import WebSocket from 'ws';
import { GameEngine, isTrump, getRankFromLevel, Card, Trick, TrickPlay } from './game';
import { LLMAIPlayer, FallbackAI, GameState } from './llm-ai';
import * as db from './db';

interface LLMConfig {
  apiKey?: string;
  provider?: string;
  model?: string;
  baseURL?: string;
  timeout?: number;
  headers?: Record<string, string>;
}

interface RoomPlayer {
  seat: number;
  userId: string;
  nickname: string;
  avatar: string;
  ready: boolean;
  ws: WebSocket | null;
  online: boolean;
  isAI?: boolean;
}

interface Room {
  id: string;
  deckCount: number;
  status: string;
  players: (RoomPlayer | null)[];
  clients: Set<WebSocket>;
  gameId: string | null;
  levels: { team1: number; team2: number };
  hostUserId: string;
  nextDealer?: number;
  nextGameReady?: Set<string>;
}

interface ExtendedWebSocket extends WebSocket {
  userId: string | null;
  roomId: string | null;
  seat: number;
  nickname?: string;
  avatar?: string;
}

interface MessageHandler {
  (ws: ExtendedWebSocket, msg: any): void;
}

interface MessageHandlers {
  [key: string]: MessageHandler;
}

// 加载配置
let llmConfig: LLMConfig = {};
try {
  const configPath = path.join(__dirname, 'config.js');
  if (fs.existsSync(configPath)) {
    llmConfig = require(configPath).llm || {};
  }
} catch (e) {
  console.log('No config.js found, using fallback AI only');
}

// 房间中的AI玩家
const roomAIPlayers = new Map<string, Record<number, LLMAIPlayer>>();

const PORT = process.env.PORT || 3003;
const rooms = new Map<string, Room>();
const games = new Map<string, GameEngine>();
const clients = new Map<ExtendedWebSocket, { userId: string; nickname: string; avatar: string }>();
const dealTimeouts = new Map<string, NodeJS.Timeout>();

const MIME_TYPES: Record<string, string> = {
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

function serveStatic(req: http.IncomingMessage, res: http.ServerResponse): void {
  let filePath = path.join(__dirname, 'public', req.url === '/' ? 'index.html' : req.url!);
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

function generateRoomId(): string {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

function broadcast(roomId: string, message: any, excludeWs: WebSocket | null = null): void {
  const room = rooms.get(roomId);
  if (!room) return;
  for (const ws of room.clients) {
    if (ws !== excludeWs && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    }
  }
}

function send(ws: WebSocket, message: any): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
  }
}

function getRoomState(roomId: string) {
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
    gameId: room.gameId,
    hostUserId: room.hostUserId
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

function startGameWithDealing(room: Room, game: GameEngine, roomId: string): void {
  const dealResult = game.startDeal();
  games.set(game.id, game);
  room.gameId = game.id;
  room.status = 'playing';

  const roomAIs = roomAIPlayers.get(roomId) || {};

  const activePlayers = room.players.filter(p => p !== null) as RoomPlayer[];
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

  processDealingRound(roomId, game);
}

function processDealingRound(roomId: string, game: GameEngine): void {
  if (game.status !== 'dealing' && game.status !== 'bidding') return;

  const room = rooms.get(roomId);
  if (!room) return;
  const roomAIs = roomAIPlayers.get(roomId) || {};

  const shouldDeal = (game.status === 'dealing' && game.currentSeat === game.dealer) ||
                     (game.status === 'bidding' && game.currentSeat === game.bidRoundStartSeat);
  if (shouldDeal && (game as any)._dealRound < (game as any)._handSize) {
    const result = game.dealNextRound();
    for (const player of room.players.filter(p => p !== null) as RoomPlayer[]) {
      if (player.ws) {
        send(player.ws, {
          type: 'cards_dealt',
          hand: game.players[player.seat].hand,
          round: result.round || (game as any)._handSize,
          totalRounds: (game as any)._handSize
        });
      }
    }
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

  if (isAutoPlay(roomId, game.currentSeat)) {
    clearDealTimeout(roomId);
    if (roomAIs[game.currentSeat]) {
      setTimeout(() => handleAIDealBid(roomId, game, game.currentSeat), 600);
    } else {
      setTimeout(() => {
        if (game.status !== 'dealing' && game.status !== 'bidding') return;
        const passResult = game.passBid(game.currentSeat);
        handleBidPassResult(roomId, game, passResult);
      }, 300);
    }
  } else {
    const canBidNow = game.canBid(game.currentSeat);
    if (!canBidNow) {
      clearDealTimeout(roomId);
      setTimeout(() => {
        if (game.status !== 'dealing' && game.status !== 'bidding') return;
        const passResult = game.passBid(game.currentSeat);
        handleBidPassResult(roomId, game, passResult);
      }, 100);
    } else {
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

function clearDealTimeout(roomId: string): void {
  const tid = dealTimeouts.get(roomId);
  if (tid) {
    clearTimeout(tid);
    dealTimeouts.delete(roomId);
  }
}

function isAutoPlay(roomId: string, seat: number): boolean {
  const roomAIs = roomAIPlayers.get(roomId) || {};
  if (roomAIs[seat]) return true;
  const room = rooms.get(roomId);
  if (!room) return false;
  const player = room.players[seat];
  return player !== null && !player.online;
}

function handleOfflinePlay(roomId: string, game: GameEngine, seat: number): void {
  if (game.currentSeat !== seat) return;
  const room = rooms.get(roomId);
  if (!room) return;

  const hand = game.players[seat].hand;
  if (hand.length === 0) return;

  if (game.status === 'taking_bottom') {
    const cardIds = hand.slice(0, game.bottomCards.length).map(c => c.id);
    const result = game.setBottom(seat, cardIds);
    if (result.success) {
      broadcast(roomId, { type: 'bottom_set', dealer: seat });
      broadcast(roomId, { type: 'turn_changed', seat: game.currentSeat, phase: 'playing' });
      broadcast(roomId, { type: 'game_state', state: game.toJSON() });
      if (isAutoPlay(roomId, game.currentSeat)) {
        setTimeout(() => handleOfflinePlay(roomId, game, game.currentSeat), 300);
      }
    }
  } else if (game.status === 'playing') {
    const cardIds = [hand[0].id];
    const result = game.play(seat, cardIds);
    if (result.success) {
      broadcast(roomId, { type: 'cards_played', seat, cards: result.playedCards, nextSeat: result.nextSeat });
      if (result.trickEnded) {
        broadcast(roomId, { type: 'trick_ended', winnerSeat: result.winnerSeat, winnerTeam: result.winnerTeam, points: result.points, scores: result.scores, nextSeat: result.nextSeat });
      }
      if (result.gameEnded) {
        broadcast(roomId, { type: 'game_ended', idleScore: result.idleScore, dealerTeam: result.dealerTeam, winner: result.winner, scores: result.scores, levels: result.levels, nextDealer: result.nextDealer, nextTrumpLevel: result.nextTrumpLevel, bottomPoints: result.bottomPoints, bottomMultiplier: result.bottomMultiplier, steps: result.steps, step: result.step });
        room.status = 'waiting';
        room.gameId = null;
        room.nextDealer = result.nextDealer;
        if (result.levels) room.levels = result.levels;
        autoStartNextGame(roomId);
      } else {
        broadcast(roomId, { type: 'turn_changed', seat: result.nextSeat, phase: 'playing' });
      }
      broadcast(roomId, { type: 'game_state', state: game.toJSON() });
      if (!result.gameEnded && result.nextSeat !== undefined && isAutoPlay(roomId, result.nextSeat)) {
        setTimeout(() => {
          const currentGame = games.get(game.id);
          if (currentGame && result.nextSeat !== undefined) {
            if (roomAIPlayers.get(roomId)?.[result.nextSeat]) {
              handleAITurn(roomId, currentGame, result.nextSeat);
            } else {
              handleOfflinePlay(roomId, currentGame, result.nextSeat);
            }
          }
        }, 300);
      }
    }
  }
}

async function handleAIDealBid(roomId: string, game: GameEngine, seat: number): Promise<void> {
  if (game.currentSeat !== seat) return;
  if (game.status !== 'dealing' && game.status !== 'bidding') return;

  const roomAIs = roomAIPlayers.get(roomId) || {};
  const aiPlayer = roomAIs[seat];
  if (!aiPlayer) return;

  await new Promise(r => setTimeout(r, 400));
  if (game.currentSeat !== seat) return;
  if (game.status !== 'dealing' && game.status !== 'bidding') return;

  const gameState = game.toJSON(seat) as GameState;
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
      handleBidPassResult(roomId, game, { success: true });
      return;
    }
  }

  if (game.currentSeat === seat && (game.status === 'dealing' || game.status === 'bidding')) {
    const passResult = game.passBid(seat);
    handleBidPassResult(roomId, game, passResult);
  }
}

function handleBidPassResult(roomId: string, game: GameEngine, passResult: any): void {
  if (!passResult || !passResult.success) return;

  if (passResult.action === 'continue_dealing') {
    setTimeout(() => processDealingRound(roomId, game), 300);
  } else if (passResult.action === 'confirm_trump') {
    if (game.bids.length > 0) {
      processRebidPhase(roomId, game);
      return;
    }
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
  } else {
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
      const canBidNow = game.canBid(game.currentSeat);
      if (!canBidNow) {
        clearDealTimeout(roomId);
        setTimeout(() => {
          if (game.status !== 'dealing' && game.status !== 'bidding') return;
          const nextPass = game.passBid(game.currentSeat);
          handleBidPassResult(roomId, game, nextPass);
        }, 100);
      } else {
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

function processRebidPhase(roomId: string, game: GameEngine): void {
  const room = rooms.get(roomId);
  if (!room) return;

  const dealer = game.dealer;
  let startSeat = (dealer + 1) % 4;

  let firstRebidSeat = -1;
  for (let i = 0; i < 4; i++) {
    const seat = (startSeat + i) % 4;
    if (game.canRebid(seat)) {
      firstRebidSeat = seat;
      break;
    }
  }

  if (firstRebidSeat === -1) {
    confirmAndEnterBottom(roomId, game);
    return;
  }

  broadcast(roomId, {
    type: 'rebid_phase',
    startSeat: firstRebidSeat
  });

  game.currentSeat = firstRebidSeat;
  (game as any)._rebidPhase = true;

  broadcast(roomId, {
    type: 'game_state',
    state: game.toJSON()
  });

  handleRebidTurn(roomId, game, firstRebidSeat);
}

function handleRebidTurn(roomId: string, game: GameEngine, seat: number): void {
  const room = rooms.get(roomId);
  if (!room || !(game as any)._rebidPhase) return;

  broadcast(roomId, {
    type: 'turn_changed',
    seat: seat,
    phase: 'bidding',
    rebidPhase: true,
    bids: game.bids
  });

  const roomAIs = roomAIPlayers.get(roomId) || {};
  if (roomAIs[seat]) {
    setTimeout(() => handleAIRebid(roomId, game, seat), 600);
  } else if (isAutoPlay(roomId, seat)) {
    setTimeout(() => handleRebidResult(roomId, game, seat, null), 300);
  } else {
    clearDealTimeout(roomId);
    const timeoutId = setTimeout(() => {
      if (!(game as any)._rebidPhase) return;
      handleRebidTimeout(roomId, game, seat);
    }, 30000);
    dealTimeouts.set(roomId, timeoutId);

    sendRebidTimer(roomId, 30);
  }
}

function handleRebidTimeout(roomId: string, game: GameEngine, seat: number): void {
  if (!(game as any)._rebidPhase) return;
  handleRebidResult(roomId, game, seat, null);
}

function handleRebidResult(roomId: string, game: GameEngine, seat: number, bidCards: Card[] | null): void {
  const room = rooms.get(roomId);
  if (!room || !(game as any)._rebidPhase) return;

  clearDealTimeout(roomId);

  if (bidCards) {
    const result = game.bid(seat, bidCards);
    if (result.success) {
      broadcast(roomId, {
        type: 'bid_made',
        seat: seat,
        trumpSuit: result.trumpSuit,
        cards: bidCards
      });

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
        confirmAndEnterBottom(roomId, game);
      } else {
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
    confirmAndEnterBottom(roomId, game);
  } else {
    game.currentSeat = nextRebidSeat;
    broadcast(roomId, {
      type: 'game_state',
      state: game.toJSON()
    });
    handleRebidTurn(roomId, game, nextRebidSeat);
  }
}

function confirmAndEnterBottom(roomId: string, game: GameEngine): void {
  (game as any)._rebidPhase = false;

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

function sendRebidTimer(roomId: string, seconds: number): void {
  broadcast(roomId, {
    type: 'rebid_timer',
    seconds: seconds
  });
}

async function handleAIRebid(roomId: string, game: GameEngine, seat: number): Promise<void> {
  if (!(game as any)._rebidPhase) return;

  const room = rooms.get(roomId);
  if (!room) return;

  const roomAIs = roomAIPlayers.get(roomId) || {};
  const aiPlayer = roomAIs[seat];
  if (!aiPlayer) return;

  if (!game.canRebid(seat)) {
    handleRebidResult(roomId, game, seat, null);
    return;
  }

  const player = game.players[seat];
  const trumpLevelStr = getRankFromLevel(game.trumpLevel);
  const existingBid = game.bids[game.bids.length - 1];

  const levelCards = player.hand.filter(c => c.rank === trumpLevelStr && c.suit !== 'joker');
  const jokerCards = player.hand.filter(c => c.suit === 'joker');

  let bidCards: Card[] | null = null;

  if (existingBid.suit === null) {
    if (jokerCards.length >= 2) {
      bidCards = jokerCards.slice(0, 2);
    }
  } else {
    if (jokerCards.length > 0) {
      const needed = (existingBid.levelCount || 0) + 1;
      const bySuit: Record<string, Card[]> = {};
      for (const c of levelCards) {
        if (!bySuit[c.suit]) bySuit[c.suit] = [];
        bySuit[c.suit].push(c);
      }
      let bestSuitCards: Card[] | null = null;
      for (const suitCards of Object.values(bySuit)) {
        if (suitCards.length >= needed && (!bestSuitCards || suitCards.length > bestSuitCards.length)) {
          bestSuitCards = suitCards;
        }
      }
      if (bestSuitCards) {
        bidCards = [...bestSuitCards.slice(0, needed), jokerCards[0]];
      }
    }
  }

  handleRebidResult(roomId, game, seat, bidCards);
}

function autoStartNextGame(roomId: string): void {
  const room = rooms.get(roomId);
  if (!room) return;
  const roomAIs = roomAIPlayers.get(roomId) || {};
  room.nextGameReady = room.nextGameReady || new Set();
  room.players.forEach((p, seat) => {
    if (p && roomAIs[seat]) {
      room.nextGameReady!.add(p.userId);
    }
  });
  broadcast(roomId, {
    type: 'next_game_state',
    readyCount: room.nextGameReady!.size,
    totalCount: room.players.filter(p => p !== null).length
  });
  checkAndStartNextGame(roomId);
}

function checkAndStartNextGame(roomId: string): void {
  const room = rooms.get(roomId);
  if (!room || room.status !== 'waiting') return;
  const ready = room.nextGameReady || new Set();
  const activePlayers = room.players.filter(p => p !== null) as RoomPlayer[];
  if (ready.size < activePlayers.length) return;

  activePlayers.sort((a, b) => a.seat - b.seat);

  const game = new GameEngine(
    room.id, room.deckCount, activePlayers.map(p => ({
      userId: p.userId,
      nickname: p.nickname,
      avatar: p.avatar
    })),
    room.nextDealer ?? 0,
    room.levels || { team1: 2, team2: 2 },
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

wss.on('connection', (ws: WebSocket) => {
  const extWs = ws as ExtendedWebSocket;
  extWs.userId = null;
  extWs.roomId = null;
  extWs.seat = -1;

  extWs.on('message', (raw) => {
    let msg: any;
    try {
      msg = JSON.parse(raw.toString());
      console.log('Received message:', msg.type);
    } catch {
      return;
    }

    const handler = messageHandlers[msg.type];
    if (handler) {
      handler(extWs, msg);
    } else {
      console.log('No handler for message type:', msg.type);
    }
  });

  extWs.on('close', () => {
    if (extWs.roomId && rooms.has(extWs.roomId)) {
      const room = rooms.get(extWs.roomId)!;
      room.clients.delete(extWs);
      const idx = room.players.findIndex(p => p && p.ws === extWs);
      if (idx >= 0) {
        const player = room.players[idx]!;
        if (room.status === 'playing' && room.gameId) {
          player.ws = null;
          player.online = false;
          broadcast(extWs.roomId, { type: 'player_offline', seat: player.seat, nickname: player.nickname });
          broadcast(extWs.roomId, { type: 'room_state', state: getRoomState(extWs.roomId) });
          const roomAIs = roomAIPlayers.get(extWs.roomId) || {};
          delete roomAIs[idx];
        } else {
          room.players[idx] = null;
          const roomAIs = roomAIPlayers.get(extWs.roomId) || {};
          delete roomAIs[idx];
          broadcast(extWs.roomId, { type: 'player_left', seat: player.seat, nickname: player.nickname });
          broadcast(extWs.roomId, { type: 'room_state', state: getRoomState(extWs.roomId) });
        }
      }
    }
    clients.delete(extWs);
  });
});

async function handleAITurn(roomId: string, game: GameEngine, seat: number): Promise<void> {
  console.log(`[AI] handleAITurn called: roomId=${roomId}, seat=${seat}, gameStatus=${game.status}, currentSeat=${game.currentSeat}`);

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

  if (game.currentSeat !== seat) {
    console.log(`[AI] Not seat ${seat}'s turn, currentSeat=${game.currentSeat}`);
    return;
  }

  await new Promise(r => setTimeout(r, 800 + Math.random() * 700));

  if (game.currentSeat !== seat) {
    console.log(`[AI] After delay, not seat ${seat}'s turn anymore, currentSeat=${game.currentSeat}`);
    return;
  }

  try {
    const gameState = game.toJSON(seat) as GameState;

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
        const currentRoom = rooms.get(roomId);
        const dealerPlayer = currentRoom ? currentRoom.players[game.dealer] : null;
        if (dealerPlayer && dealerPlayer.ws) {
          send(dealerPlayer.ws, {
            type: 'game_state',
            state: game.toJSON(game.dealer)
          });
        }
      }
      if (game.currentSeat !== seat) {
        setTimeout(() => {
          const currentGame = games.get(game.id);
          if (currentGame && isAutoPlay(roomId, game.currentSeat)) {
            if (roomAIPlayers.get(roomId)?.[game.currentSeat]) {
              handleAITurn(roomId, currentGame, game.currentSeat);
            } else {
              handleOfflinePlay(roomId, currentGame, game.currentSeat);
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
            const currentGame = games.get(game.id);
            if (currentGame && isAutoPlay(roomId, game.currentSeat)) {
              if (roomAIPlayers.get(roomId)?.[game.currentSeat]) {
                handleAITurn(roomId, currentGame, game.currentSeat);
              } else {
                handleOfflinePlay(roomId, currentGame, game.currentSeat);
              }
            }
          }, 500);
        }
      }
    } else if (game.status === 'playing' && game.currentSeat === seat) {
      aiPlayer.hand = game.players[seat].hand;
      const freshGameState = game.toJSON(seat) as GameState;

      const leadCards = game.currentTrick.length > 0 ? game.currentTrick[0].cards : null;
      const handIds = aiPlayer.hand.map(c => c.id);
      console.log(`[AI] Seat ${seat} playing, leadCards=${leadCards ? leadCards.length : 'null'}, trickLen=${game.currentTrick.length}, handSize=${aiPlayer.hand.length}, handIds=${handIds.join(',')}`);
      let playCards = await aiPlayer.decidePlay(freshGameState, leadCards);
      let cardIds = playCards.map(c => c.id);
      const inHand = cardIds.every(id => handIds.includes(id));
      console.log(`[AI] Seat ${seat} decided: ${cardIds.join(',')}, inHand=${inHand}`);
      if (!inHand) {
        aiPlayer.hand = game.players[seat].hand;
        const fbCards = FallbackAI.selectBestValid(aiPlayer.hand, leadCards, freshGameState);
        playCards = fbCards;
        cardIds = playCards.map(c => c.id);
        console.log(`[AI] Seat ${seat} fallback (not in hand): ${cardIds.join(',')}`);
      }
      let result = game.play(seat, cardIds);
      console.log(`[AI] Play result: success=${result.success}, reason=${result.reason || ''}, nextSeat=${result.nextSeat}`);

      if (!result.success) {
        console.log(`[AI] Seat ${seat} play failed, using fallback`);
        aiPlayer.hand = game.players[seat].hand;
        const fallbackCards = FallbackAI.selectBestValid(aiPlayer.hand, leadCards, freshGameState);
        const fallbackIds = fallbackCards.map(c => c.id);
        result = game.play(seat, fallbackIds);
        console.log(`[AI] Seat ${seat} fallback result: success=${result.success}, reason=${result.reason || ''}`);
      }

      if (!result.success) {
        console.log(`[AI] Seat ${seat} fallback also failed, brute force`);
        aiPlayer.hand = game.players[seat].hand;
        const needCount = leadCards ? leadCards.length : 1;
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
            if (result.levels) room.levels = result.levels;
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

        setTimeout(() => {
          const currentGame = games.get(game.id);
          if (!currentGame || currentGame.status !== 'playing') return;
          if (isAutoPlay(roomId, currentGame.currentSeat)) {
            if (roomAIPlayers.get(roomId)?.[currentGame.currentSeat]) {
              handleAITurn(roomId, currentGame, currentGame.currentSeat);
            } else {
              handleOfflinePlay(roomId, currentGame, currentGame.currentSeat);
            }
          }
        }, 200);
      } else {
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

function findFirstEmptySeat(room: Room): number {
  for (let i = 0; i < 4; i++) {
    if (!room.players[i]) return i;
  }
  return -1;
}

const messageHandlers: MessageHandlers = {
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
    const room: Room = {
      id: roomId,
      deckCount: msg.deckCount || 2,
      status: 'waiting',
      players: [null, null, null, null],
      clients: new Set(),
      gameId: null,
      levels: { team1: 2, team2: 2 },
      hostUserId: ws.userId!
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

    let player = room.players.find(p => p && p.userId === ws.userId);
    if (player) {
      const wasOffline = !player.online;
      player.ws = ws;
      player.online = true;
      player.nickname = ws.nickname!;
      player.avatar = ws.avatar!;
      ws.roomId = roomId;
      ws.seat = player.seat;
      room.clients.add(ws);
      send(ws, { type: 'joined', seat: player.seat });
      if (wasOffline) {
        broadcast(roomId, { type: 'player_reconnected', seat: player.seat, nickname: player.nickname });
      }
      broadcast(roomId, { type: 'room_state', state: getRoomState(roomId) });
      if (room.gameId && games.has(room.gameId)) {
        const game = games.get(room.gameId)!;
        send(ws, { type: 'game_started', hand: game.players[player.seat].hand, dealer: game.dealer, trumpLevel: game.trumpLevel, seat: player.seat, state: game.toJSON(player.seat) });
        send(ws, { type: 'game_state', state: game.toJSON(player.seat) });
        if (game.currentSeat === player.seat) {
          send(ws, { type: 'turn_changed', seat: game.currentSeat, phase: game.status === 'playing' ? 'playing' : 'dealing', rebidPhase: (game as any)._rebidPhase });
        }
      }
      return;
    }

    if (room.status !== 'waiting') {
      send(ws, { type: 'error', message: '游戏已开始，无法加入' });
      return;
    }

    let seat: number;
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

    const newPlayer: RoomPlayer = {
      seat,
      userId: ws.userId!,
      nickname: ws.nickname!,
      avatar: ws.avatar!,
      ready: false,
      ws,
      online: true
    };
    room.players[seat] = newPlayer;

    ws.roomId = roomId;
    ws.seat = seat;
    room.clients.add(ws);

    send(ws, { type: 'joined', seat });
    broadcast(roomId, { type: 'player_joined', seat, nickname: newPlayer.nickname, avatar: newPlayer.avatar });
    broadcast(roomId, { type: 'room_state', state: getRoomState(roomId) });

    if (room.gameId && games.has(room.gameId)) {
      const game = games.get(room.gameId)!;
      send(ws, { type: 'game_state', state: game.toJSON(seat) });
    }
  },

  sit_seat(ws, msg) {
    if (!ws.roomId) return;
    const room = rooms.get(ws.roomId);
    if (!room || room.status !== 'waiting') return;

    const targetSeat = msg.seat;
    if (targetSeat < 0 || targetSeat > 3) return;

    if (room.players[targetSeat]) {
      send(ws, { type: 'error', message: '该座位已被占用' });
      return;
    }

    const currentSeat = room.players.findIndex(p => p && p.ws === ws);
    if (currentSeat === -1) return;

    const player = room.players[currentSeat]!;
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
      const player = room.players[idx]!;
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
    const aiPlayerInfo: RoomPlayer = {
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
    const roomAIs = roomAIPlayers.get(ws.roomId)!;
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

    const activePlayers = room.players.filter(p => p !== null) as RoomPlayer[];
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

    activePlayers.sort((a, b) => a.seat - b.seat);

    const game = new GameEngine(
      room.id, room.deckCount, activePlayers.map(p => ({
        userId: p.userId,
        nickname: p.nickname,
        avatar: p.avatar
      })),
      room.nextDealer ?? 0,
      room.levels || { team1: 2, team2: 2 },
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
    if (!game || game.bids.length === 0) return;

    if (ws.seat !== game.currentSeat) {
      send(ws, { type: 'error', message: '不是你的回合' });
      return;
    }

    if (!msg.cards || msg.cards.length === 0) {
      send(ws, { type: 'error', message: '请选择要反主的牌' });
      return;
    }

    if (!(game as any)._rebidPhase) {
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
      return;
    }

    handleRebidResult(ws.roomId, game, ws.seat, msg.cards);
  },

  pass_rebid(ws, msg) {
    if (!ws.roomId) return;
    const room = rooms.get(ws.roomId);
    if (!room || !room.gameId) return;
    const game = games.get(room.gameId);
    if (!game || game.bids.length === 0) return;

    if (ws.seat !== game.currentSeat) {
      send(ws, { type: 'error', message: '不是你的回合' });
      return;
    }

    if (!(game as any)._rebidPhase) {
      const result = game.passBid(ws.seat);
      if (result.success) {
        clearDealTimeout(ws.roomId);
        handleBidPassResult(ws.roomId, game, result);
      }
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
      const dealerPlayer = room.players[game.dealer];
      if (dealerPlayer && dealerPlayer.ws) {
        send(dealerPlayer.ws, {
          type: 'game_state',
          state: game.toJSON(game.dealer)
        });
      }

      const roomAIs = roomAIPlayers.get(ws.roomId!) || {};
      if (isAutoPlay(ws.roomId!, game.currentSeat)) {
        setTimeout(() => {
          if (roomAIs[game.currentSeat]) {
            handleAITurn(ws.roomId!, game, game.currentSeat);
          } else {
            handleOfflinePlay(ws.roomId!, game, game.currentSeat);
          }
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
        if (result.levels) room.levels = result.levels;
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

      const roomAIs = roomAIPlayers.get(ws.roomId!) || {};
      if (!result.gameEnded && result.nextSeat !== undefined && isAutoPlay(ws.roomId!, result.nextSeat)) {
        setTimeout(() => {
          const currentGame = games.get(room.gameId!);
          if (currentGame && result.nextSeat !== undefined) {
            if (roomAIs[result.nextSeat]) {
              handleAITurn(ws.roomId!, currentGame, result.nextSeat);
            } else {
              handleOfflinePlay(ws.roomId!, currentGame, result.nextSeat);
            }
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

  leave_game(ws, msg) {
    if (!ws.roomId) return;
    const room = rooms.get(ws.roomId);
    if (!room) return;

    const idx = room.players.findIndex(p => p && p.userId === ws.userId);
    if (idx >= 0) {
      const player = room.players[idx]!;
      room.players[idx] = null;
      const roomAIs = roomAIPlayers.get(ws.roomId) || {};
      delete roomAIs[idx];
      room.clients.delete(ws);
      ws.roomId = null;
      ws.seat = -1;
      broadcast(room.id, { type: 'player_left', seat: player.seat, nickname: player.nickname });
      broadcast(room.id, { type: 'room_state', state: getRoomState(room.id) });
      send(ws, { type: 'left_game' });
    }
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
