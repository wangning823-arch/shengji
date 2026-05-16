const WebSocket = require('ws');

const BASE_URL = 'ws://localhost:3003';
const clients = [];
let roomId = null;
let gameEnded = false;
let gameStarted = false;

function log(msg) {
  console.log(`[TEST] ${msg}`);
}

function createClient(name, seatIdx) {
  const ws = new WebSocket(BASE_URL);
  const client = { ws, name, seat: seatIdx, hand: [], ready: false, gameState: null };

  ws.on('open', () => {
    ws.send(JSON.stringify({ type: 'auth', userId: `test_${seatIdx}_${Date.now()}`, nickname: name, avatar: '' }));
  });

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      handleMessage(client, msg);
    } catch (e) {}
  });

  ws.on('error', (err) => {
    log(`${name} error: ${err.message}`);
  });

  return client;
}

function handleMessage(client, msg) {
  switch (msg.type) {
    case 'auth_ok':
      if (client.seat === 0) {
        client.ws.send(JSON.stringify({ type: 'create_room', deckCount: 2 }));
      }
      break;

    case 'room_created':
      roomId = msg.roomId;
      log(`Room created: ${roomId}`);
      clients.forEach(c => {
        c.ws.send(JSON.stringify({ type: 'join_room', roomId }));
      });
      break;

    case 'joined':
      client.seat = msg.seat;
      log(`${client.name} joined as seat ${msg.seat}`);
      setTimeout(() => {
        client.ready = true;
        client.ws.send(JSON.stringify({ type: 'ready', ready: true }));
      }, 300 + client.seat * 100);
      break;

    case 'player_ready':
      if (msg.seat >= 0 && msg.seat < 4) {
        clients[msg.seat].ready = msg.ready;
      }
      const allReady = clients.every(c => c.ready);
      if (allReady && client.seat === 0 && !gameStarted) {
        gameStarted = true;
        setTimeout(() => {
          client.ws.send(JSON.stringify({ type: 'start_game' }));
        }, 500);
      }
      break;

    case 'game_started':
      client.hand = msg.hand || [];
      log(`${client.name} got ${client.hand.length} cards, seat=${msg.seat}`);
      break;

    case 'game_state':
      if (msg.state) client.gameState = msg.state;
      break;

    case 'turn_changed':
      if (msg.seat === client.seat && msg.phase === 'bidding') {
        setTimeout(() => {
          const levelCards = client.hand.filter(c => c.rank === String(client.gameState?.trumpLevel || '2'));
          const bySuit = {};
          for (const c of levelCards) {
            if (!bySuit[c.suit]) bySuit[c.suit] = [];
            bySuit[c.suit].push(c);
          }
          let trumpCards = null;
          for (const s in bySuit) {
            if (bySuit[s].length >= 2) {
              trumpCards = bySuit[s].slice(0, 2);
              break;
            }
          }
          if (trumpCards) {
            client.ws.send(JSON.stringify({
              type: 'bid',
              cards: trumpCards.map(c => ({ id: c.id, suit: c.suit, rank: c.rank }))
            }));
          }
          if (client.seat === 0) {
            setTimeout(() => {
              client.ws.send(JSON.stringify({ type: 'confirm_trump' }));
            }, 400);
          }
        }, 200);
      }
      if (msg.seat === client.seat && msg.phase === 'playing') {
        client.currentLeadSuit = msg.leadSuit || null;
        client.retryIndex = 0;
        setTimeout(() => autoPlay(client), 200);
      }
      break;

    case 'cards_played':
      if (msg.seat === client.seat) {
        const playedIds = msg.cards.map(c => c.id);
        client.hand = client.hand.filter(c => !playedIds.includes(c.id));
        client.retryIndex = 0;
      }
      break;

    case 'trick_ended':
      log(`Trick ended: seat ${msg.winnerSeat} wins ${msg.points} pts`);
      break;

    case 'game_ended':
      log(`GAME ENDED! Idle score: ${msg.idleScore}, Scores: ${JSON.stringify(msg.scores)}, Levels: ${JSON.stringify(msg.levels)}`);
      gameEnded = true;
      setTimeout(() => process.exit(0), 500);
      break;

    case 'error':
      if (msg.message === '有同花色必须跟同花色' || msg.message === '有对子必须跟对子' || msg.message === '有拖拉机必须跟拖拉机') {
        client.retryIndex = (client.retryIndex || 0) + 1;
        if (client.retryIndex < client.hand.length) {
          setTimeout(() => autoPlay(client), 100);
        }
      }
      break;
  }
}

function autoPlay(client) {
  if (client.hand.length === 0) return;

  const idx = client.retryIndex || 0;

  const card = client.hand[idx % client.hand.length];
  client.ws.send(JSON.stringify({ type: 'play', cardIds: [card.id] }));
}

log('Starting game test with 4 players...');
for (let i = 0; i < 4; i++) {
  clients.push(createClient(`Player${i}`, i));
}

setTimeout(() => {
  if (!gameEnded) {
    log('TIMEOUT: Game did not end within 60s');
    process.exit(1);
  }
}, 60000);
