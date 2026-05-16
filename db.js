const fs = require('fs');
const path = require('path');

const DB_FILE = path.join(__dirname, 'data.json');

let data = { users: [], rooms: [], games: [] };

function load() {
  try {
    if (fs.existsSync(DB_FILE)) {
      data = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    }
  } catch (e) {
    data = { users: [], rooms: [], games: [] };
  }
}

function save() {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

load();

function getOrCreateUser(unionId, openId, nickname, avatar) {
  let user = data.users.find(u => u.union_id === unionId);
  if (!user) {
    user = {
      id: data.users.length + 1,
      union_id: unionId,
      open_id: openId,
      nickname: nickname || '游客',
      avatar: avatar || '',
      created_at: Date.now()
    };
    data.users.push(user);
    save();
  }
  return user;
}

function getUserById(id) {
  return data.users.find(u => u.id === id);
}

function createRoom(roomId, creatorId, deckCount = 2) {
  const room = {
    id: roomId,
    creator_id: creatorId,
    deck_count: deckCount,
    status: 'waiting',
    current_game_id: null,
    created_at: Date.now()
  };
  data.rooms.push(room);
  save();
  return room;
}

function getRoom(roomId) {
  return data.rooms.find(r => r.id === roomId);
}

function createGame(gameId, roomId, deckCount) {
  const game = {
    id: gameId,
    room_id: roomId,
    deck_count: deckCount,
    status: 'bidding',
    created_at: Date.now()
  };
  data.games.push(game);
  save();
  return game;
}

module.exports = {
  getOrCreateUser,
  getUserById,
  createRoom,
  getRoom,
  createGame,
};
