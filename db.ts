import * as fs from 'fs';
import * as path from 'path';

interface User {
  id: number;
  union_id: string;
  open_id: string | null;
  nickname: string;
  avatar: string;
  created_at: number;
}

interface Room {
  id: string;
  creator_id: number;
  deck_count: number;
  status: string;
  current_game_id: string | null;
  created_at: number;
}

interface Game {
  id: string;
  room_id: string;
  deck_count: number;
  status: string;
  created_at: number;
}

interface DBData {
  users: User[];
  rooms: Room[];
  games: Game[];
}

const DB_FILE = path.join(__dirname, 'data.json');

let data: DBData = { users: [], rooms: [], games: [] };

function load(): void {
  try {
    if (fs.existsSync(DB_FILE)) {
      data = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    }
  } catch (e) {
    data = { users: [], rooms: [], games: [] };
  }
}

function save(): void {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

load();

export function getOrCreateUser(unionId: string, openId: string | null, nickname: string, avatar: string | null): User {
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

export function getUserById(id: number): User | undefined {
  return data.users.find(u => u.id === id);
}

export function createRoom(roomId: string, creatorId: number, deckCount: number = 2): Room {
  const room: Room = {
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

export function getRoom(roomId: string): Room | undefined {
  return data.rooms.find(r => r.id === roomId);
}

export function createGame(gameId: string, roomId: string, deckCount: number): Game {
  const game: Game = {
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
