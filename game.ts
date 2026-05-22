import { v4 as uuidv4 } from 'uuid';

export interface Card {
  suit: string;
  rank: string;
  id: string;
  deckIndex: number;
}

export interface Player {
  seat: number;
  team: number;
  hand: Card[];
  userId?: string;
  nickname?: string;
  avatar?: string;
}

export interface Bid {
  seat: number;
  suit: string | null;
  levelCount: number;
  jokers: Card[];
  cards: Card[];
}

export interface TrickPlay {
  seat: number;
  cards: Card[];
}

export interface Trick {
  cards: Card[];
  plays: TrickPlay[];
  winnerSeat: number;
  winnerTeam: number;
  points: number;
}

export interface Scores {
  team1: number;
  team2: number;
}

export interface Levels {
  team1: number;
  team2: number;
  [key: string]: number;
}

export interface CardPattern {
  type: 'single' | 'pair' | 'triple' | 'tractor' | 'mix';
  length: number;
}

export interface ValidationResult {
  valid: boolean;
  reason?: string;
  isDump?: boolean;
}

export interface UpgradeSteps {
  dealer: number;
  idle: number;
}

export interface BidRecord {
  seat: number;
  userId?: string;
  nickname?: string;
  action: 'bid' | 'rebid' | 'pass';
  cards?: Card[];
  trumpSuit?: string | null;
  result: 'success' | 'fail' | 'pass';
  reason?: string;
}

export const SUITS = ['spade', 'heart', 'diamond', 'club'];
export const RANKS = ['3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A', '2'];
export const RANK_ORDER: Record<string, number> = { '3': 0, '4': 1, '5': 2, '6': 3, '7': 4, '8': 5, '9': 6, '10': 7, 'J': 8, 'Q': 9, 'K': 10, 'A': 11, '2': 12 };
export const POINT_CARDS: Record<string, number> = { '5': 5, '10': 10, 'K': 10 };

export function getRankFromLevel(level: number): string {
  level = ((level - 2) % 13) + 2;
  if (level === 2) return RANKS[12];
  if (level >= 3 && level <= 14) return RANKS[level - 3];
  return String(level);
}

function normalizeLevel(level: number): number {
  return ((level - 2) % 13) + 2;
}

function createCard(suit: string, rank: string, deckIndex: number): Card {
  return { suit, rank, id: `${suit}_${rank}_${deckIndex}`, deckIndex };
}

function createDeck(deckCount: number): Card[] {
  const cards: Card[] = [];
  for (let d = 0; d < deckCount; d++) {
    for (const suit of SUITS) {
      for (const rank of RANKS) {
        cards.push(createCard(suit, rank, d));
      }
    }
    cards.push(createCard('joker', 'small', d));
    cards.push(createCard('joker', 'big', d));
  }
  return cards;
}

function shuffle<T>(array: T[]): T[] {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

function getBottomCardCount(deckCount: number): number {
  if (deckCount === 2) return 8;
  if (deckCount === 3) return 6;
  if (deckCount === 4) return 8;
  return 8;
}

export function isTrump(card: Card, trumpSuit: string | null, trumpLevel: number): boolean {
  if (card.suit === 'joker') return true;
  if (card.rank === '2') return true;
  if (card.rank === getRankFromLevel(trumpLevel)) return true;
  if (trumpSuit && card.suit === trumpSuit && card.rank !== getRankFromLevel(trumpLevel) && card.rank !== '2') return true;
  return false;
}

export function getTrumpRank(card: Card, trumpSuit: string | null, trumpLevel: number): number {
  if (card.suit === 'joker') {
    return card.rank === 'big' ? 100 : 99;
  }
  if (card.rank === getRankFromLevel(trumpLevel)) {
    if (card.suit === trumpSuit) return 98;
    return 97;
  }
  if (card.rank === '2' && getRankFromLevel(trumpLevel) !== '2') {
    if (card.suit === trumpSuit) return 96;
    return 95;
  }
  if (trumpSuit && card.suit === trumpSuit) {
    return RANK_ORDER[card.rank];
  }
  return -1;
}

export function compareCards(a: Card, b: Card, trumpSuit: string | null, trumpLevel: number, leadSuit: string): number {
  const aTrump = isTrump(a, trumpSuit, trumpLevel);
  const bTrump = isTrump(b, trumpSuit, trumpLevel);

  if (aTrump && !bTrump) return 1;
  if (!aTrump && bTrump) return -1;

  if (aTrump && bTrump) {
    return getTrumpRank(a, trumpSuit, trumpLevel) - getTrumpRank(b, trumpSuit, trumpLevel);
  }

  const aLead = a.suit === leadSuit;
  const bLead = b.suit === leadSuit;
  if (aLead && !bLead) return 1;
  if (!aLead && bLead) return -1;
  if (!aLead && !bLead) return 0;

  return RANK_ORDER[a.rank] - RANK_ORDER[b.rank];
}

export function groupByRank(cards: Card[]): Record<string, Card[]> {
  const map: Record<string, Card[]> = {};
  for (const c of cards) {
    const key = `${c.suit}_${c.rank}`;
    if (!map[key]) map[key] = [];
    map[key].push(c);
  }
  return map;
}

export function isTractor(cards: Card[], trumpSuit: string | null, trumpLevel: number): boolean {
  if (cards.length < 4) return false;
  const grouped = groupByRank(cards);
  const groups: { suit: string; rank: string; count: number }[] = [];
  for (const key in grouped) {
    const [suit, rank] = key.split('_');
    groups.push({ suit, rank, count: grouped[key].length });
  }
  if (groups.length < 2) return false;

  // 所有组的张数必须相同且 >= 2
  const groupSize = groups[0].count;
  if (groupSize < 2) return false;
  if (!groups.every(g => g.count === groupSize)) return false;
  // 总牌数必须等于 组数 × 每组张数
  if (cards.length !== groups.length * groupSize) return false;

  groups.sort((a, b) => RANK_ORDER[a.rank] - RANK_ORDER[b.rank]);

  const isTrumpGroup = (p: { suit: string; rank: string }) => isTrump({ suit: p.suit, rank: p.rank } as Card, trumpSuit, trumpLevel);

  for (let i = 1; i < groups.length; i++) {
    const prev = groups[i - 1];
    const curr = groups[i];
    const sameSuit = prev.suit === curr.suit || (isTrumpGroup(prev) && isTrumpGroup(curr));
    if (!sameSuit) return false;

    if (isTrumpGroup(prev) && isTrumpGroup(curr)) {
      const trumpRanks = [getTrumpRank({ suit: prev.suit, rank: prev.rank } as Card, trumpSuit, trumpLevel),
                          getTrumpRank({ suit: curr.suit, rank: curr.rank } as Card, trumpSuit, trumpLevel)];
      if (Math.abs(trumpRanks[0] - trumpRanks[1]) !== 1) return false;
    } else {
      if (prev.suit !== curr.suit) return false;
      const orderA = RANK_ORDER[prev.rank];
      const orderB = RANK_ORDER[curr.rank];
      const levelOrder = RANK_ORDER[getRankFromLevel(trumpLevel)];
      let diff = Math.abs(orderA - orderB);
      if ((orderA < levelOrder && orderB > levelOrder) || (orderA > levelOrder && orderB < levelOrder)) {
        diff -= 1;
      }
      if (diff !== 1) return false;
      if (prev.rank === getRankFromLevel(trumpLevel) || curr.rank === getRankFromLevel(trumpLevel)) return false;
    }
  }

  return true;
}

export function getCardPattern(cards: Card[], trumpSuit: string | null, trumpLevel: number): CardPattern {
  if (cards.length === 1) return { type: 'single', length: 1 };

  const grouped = groupByRank(cards);
  const groups = Object.values(grouped);

  // 单一组合：对子/三同张/四同张
  if (groups.length === 1) {
    const count = groups[0].length;
    if (count === 2) return { type: 'pair', length: 2 };
    if (count === 3) return { type: 'triple', length: 3 };
    if (count === 4) return { type: 'triple', length: 4 }; // 四同张归为 triple 类型
  }

  // 拖拉机：等量连续组（对子拖拉机3344、三同张拖拉机333444、四同张拖拉机等）
  if (isTractor(cards, trumpSuit, trumpLevel)) {
    return { type: 'tractor', length: cards.length };
  }

  return { type: 'mix', length: cards.length };
}

function canBeatSingle(hand: Card[], suit: string, rank: string, isTrumpCard: boolean, trumpSuit: string | null, trumpLevel: number): boolean {
  const card = { suit, rank } as Card;
  const leadSuit = isTrumpCard ? 'trump' : suit;

  const sameSuitCards = hand.filter(c => {
    if (isTrumpCard) return isTrump(c, trumpSuit, trumpLevel);
    return !isTrump(c, trumpSuit, trumpLevel) && c.suit === suit;
  });

  if (sameSuitCards.length >= 1) {
    for (const c of sameSuitCards) {
      if (compareCards(c, card, trumpSuit, trumpLevel, leadSuit) > 0) {
        return true;
      }
    }
    return false;
  } else {
    const trumpCards = hand.filter(c => isTrump(c, trumpSuit, trumpLevel));
    return trumpCards.length >= 1;
  }
}

function canBeatPair(hand: Card[], suit: string, rank: string, isTrumpCard: boolean, trumpSuit: string | null, trumpLevel: number): boolean {
  const card = { suit, rank } as Card;
  const leadSuit = isTrumpCard ? 'trump' : suit;

  const sameSuitCards = hand.filter(c => {
    if (isTrumpCard) return isTrump(c, trumpSuit, trumpLevel);
    return !isTrump(c, trumpSuit, trumpLevel) && c.suit === suit;
  });

  if (sameSuitCards.length >= 2) {
    const handGrouped = groupByRank(sameSuitCards);
    for (const key in handGrouped) {
      if (handGrouped[key].length >= 2) {
        const c = handGrouped[key][0];
        if (compareCards(c, card, trumpSuit, trumpLevel, leadSuit) > 0) {
          return true;
        }
      }
    }
    return false;
  } else {
    const trumpCards = hand.filter(c => isTrump(c, trumpSuit, trumpLevel));
    const trumpGrouped = groupByRank(trumpCards);
    for (const key in trumpGrouped) {
      if (trumpGrouped[key].length >= 2) {
        return true;
      }
    }
    return false;
  }
}

function canBeatTriple(hand: Card[], suit: string, rank: string, isTrumpCard: boolean, trumpSuit: string | null, trumpLevel: number): boolean {
  const card = { suit, rank } as Card;
  const leadSuit = isTrumpCard ? 'trump' : suit;

  const sameSuitCards = hand.filter(c => {
    if (isTrumpCard) return isTrump(c, trumpSuit, trumpLevel);
    return !isTrump(c, trumpSuit, trumpLevel) && c.suit === suit;
  });

  if (sameSuitCards.length >= 3) {
    const handGrouped = groupByRank(sameSuitCards);
    for (const key in handGrouped) {
      if (handGrouped[key].length >= 3) {
        const c = handGrouped[key][0];
        if (compareCards(c, card, trumpSuit, trumpLevel, leadSuit) > 0) {
          return true;
        }
      }
    }
    return false;
  } else {
    const trumpCards = hand.filter(c => isTrump(c, trumpSuit, trumpLevel));
    const trumpGrouped = groupByRank(trumpCards);
    for (const key in trumpGrouped) {
      if (trumpGrouped[key].length >= 3) {
        return true;
      }
    }
    return false;
  }
}

function isDumpGuaranteedMax(dumpCards: Card[], otherPlayers: Player[], trumpSuit: string | null, trumpLevel: number): boolean {
  const grouped = groupByRank(dumpCards);

  for (const key in grouped) {
    const cards = grouped[key];
    const suit = cards[0].suit;
    const rank = cards[0].rank;
    const isTrumpCard = isTrump(cards[0], trumpSuit, trumpLevel);

    for (const player of otherPlayers) {
      if (cards.length >= 3) {
        if (canBeatTriple(player.hand, suit, rank, isTrumpCard, trumpSuit, trumpLevel)) {
          return false;
        }
      } else if (cards.length >= 2) {
        if (canBeatPair(player.hand, suit, rank, isTrumpCard, trumpSuit, trumpLevel)) {
          return false;
        }
      } else {
        if (canBeatSingle(player.hand, suit, rank, isTrumpCard, trumpSuit, trumpLevel)) {
          return false;
        }
      }
    }
  }

  return true;
}

function getFallbackFromDump(dumpCards: Card[], trumpSuit: string | null, trumpLevel: number): { type: string; cards: Card[] } {
  const grouped = groupByRank(dumpCards);
  const components: { type: string; cards: Card[] }[] = [];

  for (const key in grouped) {
    const cards = grouped[key];
    if (cards.length >= 4) {
      components.push({ type: 'triple', cards: cards.slice(0, 4) });
    } else if (cards.length >= 3) {
      components.push({ type: 'triple', cards: cards.slice(0, 3) });
    } else if (cards.length >= 2) {
      components.push({ type: 'pair', cards: cards.slice(0, 2) });
    } else {
      components.push({ type: 'single', cards });
    }
  }

  components.sort((a, b) => {
    const aTrump = isTrump(a.cards[0], trumpSuit, trumpLevel);
    const bTrump = isTrump(b.cards[0], trumpSuit, trumpLevel);
    if (aTrump && !bTrump) return 1;
    if (!aTrump && bTrump) return -1;
    if (aTrump && bTrump) {
      return getTrumpRank(a.cards[0], trumpSuit, trumpLevel) - getTrumpRank(b.cards[0], trumpSuit, trumpLevel);
    }
    if (a.cards[0].suit !== b.cards[0].suit) return 0;
    return RANK_ORDER[a.cards[0].rank] - RANK_ORDER[b.cards[0].rank];
  });

  return components[0];
}

function hasSuit(hand: Card[], suit: string, trumpSuit: string | null, trumpLevel: number): boolean {
  return hand.some(c => {
    if (suit === 'trump') return isTrump(c, trumpSuit, trumpLevel);
    return !isTrump(c, trumpSuit, trumpLevel) && c.suit === suit;
  });
}

function canFollow(hand: Card[], leadCards: Card[], trumpSuit: string | null, trumpLevel: number): boolean {
  if (!leadCards || leadCards.length === 0) return true;

  const leadFirst = leadCards[0];
  const leadIsTrump = isTrump(leadFirst, trumpSuit, trumpLevel);
  const leadSuit = leadIsTrump ? 'trump' : leadFirst.suit;
  const leadPattern = getCardPattern(leadCards, trumpSuit, trumpLevel);

  const handInSuit = hand.filter(c => {
    if (leadIsTrump) return isTrump(c, trumpSuit, trumpLevel);
    return !isTrump(c, trumpSuit, trumpLevel) && c.suit === leadFirst.suit;
  });

  if (handInSuit.length === 0) {
    if (leadIsTrump) return true;
    const handTrump = hand.filter(c => isTrump(c, trumpSuit, trumpLevel));
    return handTrump.length > 0 || true;
  }

  const handGrouped = groupByRank(handInSuit);
  const handPairs = Object.values(handGrouped).filter(g => g.length >= 2);

  if (leadPattern.type === 'single') {
    return handInSuit.length >= 1;
  }

  if (leadPattern.type === 'pair') {
    return handPairs.length >= 1;
  }

  if (leadPattern.type === 'tractor') {
    return isTractor(handInSuit.slice(0, leadPattern.length), trumpSuit, trumpLevel) || handInSuit.length >= leadCards.length;
  }

  if (leadPattern.type === 'triple') {
    const handTriples = Object.values(handGrouped).filter(g => g.length >= 3);
    return handTriples.length >= 1 || handInSuit.length >= leadCards.length;
  }

  return true;
}

export function validatePlay(hand: Card[], playedCards: Card[], leadCards: Card[] | null, trumpSuit: string | null, trumpLevel: number): ValidationResult {
  if (!hand.every(c => playedCards.some(pc => pc.id === c.id) || !playedCards.some(pc => pc.id === c.id))) {
    return { valid: false, reason: '包含非手牌' };
  }

  const playedInHand = playedCards.every(pc => hand.some(hc => hc.id === pc.id));
  if (!playedInHand) return { valid: false, reason: '出的牌不在手牌中' };

  if (!leadCards || leadCards.length === 0) {
    const pattern = getCardPattern(playedCards, trumpSuit, trumpLevel);
    if (pattern.type === 'mix') {
      return { valid: false, reason: '甩牌必须保证最大', isDump: true };
    }
    return { valid: true };
  }

  const leadFirst = leadCards[0];
  const leadIsTrump = isTrump(leadFirst, trumpSuit, trumpLevel);
  const leadPattern = getCardPattern(leadCards, trumpSuit, trumpLevel);

  // 出牌数量必须与首家相同（手牌不足时出全部）
  if (hand.length >= leadCards.length && playedCards.length !== leadCards.length) {
    return { valid: false, reason: '出牌数量必须与首家相同' };
  }

  const playedInSuit = playedCards.filter(c => {
    if (leadIsTrump) return isTrump(c, trumpSuit, trumpLevel);
    return !isTrump(c, trumpSuit, trumpLevel) && c.suit === leadFirst.suit;
  });

  const handInSuit = hand.filter(c => {
    if (leadIsTrump) return isTrump(c, trumpSuit, trumpLevel);
    return !isTrump(c, trumpSuit, trumpLevel) && c.suit === leadFirst.suit;
  });

  if (playedInSuit.length < Math.min(leadCards.length, handInSuit.length)) {
    return { valid: false, reason: '有同花色必须跟同花色' };
  }

  if (leadPattern.type === 'pair' && playedInSuit.length >= 2) {
    const playedGrouped = groupByRank(playedInSuit);
    const hasPair = Object.values(playedGrouped).some(g => g.length >= 2);
    const handPairs = Object.values(groupByRank(handInSuit)).filter(g => g.length >= 2);
    if (handPairs.length > 0 && !hasPair) {
      return { valid: false, reason: '有对子必须跟对子' };
    }
  }

  if (leadPattern.type === 'triple' && playedInSuit.length >= 3) {
    const handTriples = Object.values(groupByRank(handInSuit)).filter(g => g.length >= 3);
    const playedHasTriple = Object.values(groupByRank(playedInSuit)).some(g => g.length >= 3);
    if (handTriples.length > 0 && !playedHasTriple) {
      return { valid: false, reason: '有三同张必须跟三同张' };
    }
  }

  if (leadPattern.type === 'tractor' && playedInSuit.length >= leadCards.length) {
    const isTractorPlay = isTractor(playedInSuit.slice(0, leadCards.length), trumpSuit, trumpLevel);
    const handCanTractor = isTractor(handInSuit.slice(0, leadCards.length), trumpSuit, trumpLevel);
    if (handCanTractor && !isTractorPlay) {
      return { valid: false, reason: '有拖拉机必须跟拖拉机' };
    }

    // 判断拖拉机的基础张数（2=对子拖拉机, 3=三同张拖拉机, 4=四同张拖拉机）
    const leadGrouped = groupByRank(leadCards);
    const leadGroupSize = Math.min(...Object.values(leadGrouped).map(g => g.length));

    if (!handCanTractor) {
      if (leadGroupSize >= 3) {
        // 三同张/四同张拖拉机：没有同类型拖拉机时，有三同张必须出三同张
        const handTriples = Object.values(groupByRank(handInSuit)).filter(g => g.length >= leadGroupSize);
        const playedTriples = Object.values(groupByRank(playedInSuit)).filter(g => g.length >= leadGroupSize);
        if (handTriples.length > 0 && playedTriples.length === 0) {
          return { valid: false, reason: '有三同张必须跟三同张' };
        }
        // 没有三同张但有对子，必须出对子
        if (handTriples.length === 0) {
          const handPairs = Object.values(groupByRank(handInSuit)).filter(g => g.length >= 2);
          const playedPairs = Object.values(groupByRank(playedInSuit)).filter(g => g.length >= 2);
          if (handPairs.length > 0 && playedPairs.length === 0) {
            return { valid: false, reason: '有对子必须跟对子' };
          }
        }
      } else {
        // 对子拖拉机：没有拖拉机但有对子，必须跟对子
        const handPairs = Object.values(groupByRank(handInSuit)).filter(g => g.length >= 2);
        const playedPairs = Object.values(groupByRank(playedInSuit)).filter(g => g.length >= 2);
        if (handPairs.length > 0 && playedPairs.length === 0) {
          return { valid: false, reason: '有对子必须跟对子' };
        }
      }
    }
  }

  return { valid: true };
}

export function findWinningCard(trickPlays: TrickPlay[], trumpSuit: string | null, trumpLevel: number, leadSuit: string): number {
  const leadCards = trickPlays[0].cards;
  const leadPattern = getCardPattern(leadCards, trumpSuit, trumpLevel);

  let winner = 0;

  for (let i = 1; i < trickPlays.length; i++) {
    if (isPlayBeating(trickPlays[i].cards, trickPlays[winner].cards, leadCards, leadPattern, leadSuit, trumpSuit, trumpLevel)) {
      winner = i;
    }
  }
  return winner;
}

export function isPlayBeating(playCards: Card[], winnerCards: Card[], leadCards: Card[], leadPattern: CardPattern, leadSuit: string, trumpSuit: string | null, trumpLevel: number): boolean {
  const leadIsTrump = isTrump(leadCards[0], trumpSuit, trumpLevel);

  // 判断各方出了什么类型的牌
  // playInSuit: 跟了首家花色的牌
  const playInSuit = playCards.filter(c => {
    if (leadIsTrump) return isTrump(c, trumpSuit, trumpLevel);
    return !isTrump(c, trumpSuit, trumpLevel) && c.suit === leadSuit;
  });
  const winnerInSuit = winnerCards.filter(c => {
    if (leadIsTrump) return isTrump(c, trumpSuit, trumpLevel);
    return !isTrump(c, trumpSuit, trumpLevel) && c.suit === leadSuit;
  });

  // playTrumps: 出的主牌（将吃）— 必须匹配首家牌型才算将吃
  const playTrumps = playCards.filter(c => isTrump(c, trumpSuit, trumpLevel) && playInSuit.indexOf(c) === -1);
  const winnerTrumps = winnerCards.filter(c => isTrump(c, trumpSuit, trumpLevel) && winnerInSuit.indexOf(c) === -1);

  const playFollowed = playInSuit.length > 0;
  const winnerFollowed = winnerInSuit.length > 0;

  // 将吃需要匹配首家的牌型：单张→单主将吃，对子→对主将吃，拖拉机→拖拉机主将吃
  let playChopped = false;
  let winnerChopped = false;
  if (!playFollowed && playTrumps.length > 0) {
    if (leadPattern.type === 'single') {
      playChopped = true;
    } else if (leadPattern.type === 'pair') {
      const trumpPattern = getCardPattern(playTrumps, trumpSuit, trumpLevel);
      playChopped = trumpPattern.type === 'pair';
    } else if (leadPattern.type === 'tractor') {
      const trumpPattern = getCardPattern(playTrumps, trumpSuit, trumpLevel);
      playChopped = trumpPattern.type === 'tractor';
    } else if (leadPattern.type === 'triple') {
      const trumpPattern = getCardPattern(playTrumps, trumpSuit, trumpLevel);
      playChopped = trumpPattern.type === 'triple';
    } else {
      playChopped = true; // mix类型，有主牌就算将吃
    }
  }
  if (!winnerFollowed && winnerTrumps.length > 0) {
    if (leadPattern.type === 'single') {
      winnerChopped = true;
    } else if (leadPattern.type === 'pair') {
      const trumpPattern = getCardPattern(winnerTrumps, trumpSuit, trumpLevel);
      winnerChopped = trumpPattern.type === 'pair';
    } else if (leadPattern.type === 'tractor') {
      const trumpPattern = getCardPattern(winnerTrumps, trumpSuit, trumpLevel);
      winnerChopped = trumpPattern.type === 'tractor';
    } else if (leadPattern.type === 'triple') {
      const trumpPattern = getCardPattern(winnerTrumps, trumpSuit, trumpLevel);
      winnerChopped = trumpPattern.type === 'triple';
    } else {
      winnerChopped = true;
    }
  }

  // 优先级：跟了花色 > 将吃 > 垫牌
  // 都没跟花色也没将吃（纯垫牌），先出的赢
  if (!playFollowed && !playChopped && !winnerFollowed && !winnerChopped) return false;
  // 垫牌输给跟了花色
  if (!playFollowed && !playChopped) return false;
  if (!winnerFollowed && !winnerChopped) return true;
  // 将吃 vs 跟了花色：将吃赢
  if (playChopped && winnerFollowed) return true;
  if (winnerChopped && playFollowed) return false;
  // 都将吃，比主牌大小
  if (playChopped && winnerChopped) {
    const playMax = getMaxCard(playTrumps, trumpSuit, trumpLevel, 'trump');
    const winnerMax = getMaxCard(winnerTrumps, trumpSuit, trumpLevel, 'trump');
    return compareCards(playMax, winnerMax, trumpSuit, trumpLevel, 'trump') > 0;
  }

  // 都跟了花色
  const compareSuit = leadIsTrump ? 'trump' : leadSuit;

  // 对于对子/三同张/拖拉机：只有跟了同类型才能赢
  if (leadPattern.type === 'pair' || leadPattern.type === 'triple' || leadPattern.type === 'tractor') {
    const playPattern = getCardPattern(playInSuit, trumpSuit, trumpLevel);
    const winnerPattern = getCardPattern(winnerInSuit, trumpSuit, trumpLevel);

    const playMatchesType = playPattern.type === leadPattern.type;
    const winnerMatchesType = winnerPattern.type === leadPattern.type;

    if (playMatchesType && winnerMatchesType) {
      const playMax = getMaxCard(playInSuit, trumpSuit, trumpLevel, compareSuit);
      const winnerMax = getMaxCard(winnerInSuit, trumpSuit, trumpLevel, compareSuit);
      return compareCards(playMax, winnerMax, trumpSuit, trumpLevel, compareSuit) > 0;
    }
    if (playMatchesType && !winnerMatchesType) return true;
    if (!playMatchesType && winnerMatchesType) return false;
    // 都不匹配类型时，也不能赢首家（首家的拖拉机/对子最大）
    return false;
  }

  // 甩牌（mix）：跟牌者无法赢过甩牌者，只有将吃才能赢（将吃情况已在前面处理）
  if (leadPattern.type === 'mix') {
    return false;
  }

  // 单张，比最大牌
  const playMax = getMaxCard(playInSuit, trumpSuit, trumpLevel, compareSuit);
  const winnerMax = getMaxCard(winnerInSuit, trumpSuit, trumpLevel, compareSuit);
  return compareCards(playMax, winnerMax, trumpSuit, trumpLevel, compareSuit) > 0;
}

export function getMaxCard(cards: Card[], trumpSuit: string | null, trumpLevel: number, leadSuit: string): Card {
  if (!cards || cards.length === 0) return { suit: 'joker', rank: 'small', id: 'joker_small_-1', deckIndex: -1 };
  return cards.reduce((max, c) => compareCards(c, max, trumpSuit, trumpLevel, leadSuit) > 0 ? c : max);
}

export function getRoundPoints(cards: Card[]): number {
  let points = 0;
  for (const c of cards) {
    if (POINT_CARDS[c.rank]) points += POINT_CARDS[c.rank];
  }
  return points;
}

export function getUpgradeSteps(score: number, totalScore: number, deckCount: number): UpgradeSteps {
  const step = deckCount * 20;
  if (score === 0) return { dealer: 3, idle: 0 };
  if (score < step) return { dealer: 2, idle: 0 };
  if (score < step * 2) return { dealer: 1, idle: 0 };
  if (score < step * 3) return { dealer: 0, idle: 0 };
  const idleSteps = Math.floor(score / step) - 2;
  return { dealer: 0, idle: idleSteps };
}

export class GameEngine {
  id: string;
  roomId: string;
  deckCount: number;
  players: Player[];
  dealer: number;
  isFirstGame: boolean;
  trumpSuit: string | null;
  status: string;
  bottomCards: Card[];
  currentTrick: TrickPlay[];
  leadSeat: number;
  currentSeat: number;
  tricks: Trick[];
  bidRecords: BidRecord[];
  scores: Scores;
  levels: Levels;
  trumpLevel: number;
  bids: Bid[];
  totalScore: number;
  bidRoundStartSeat: number;
  _deck: Card[];
  _bottomCount: number;
  _handSize: number;
  _dealRound: number;
  _rebidPhase: boolean;

  constructor(roomId: string, deckCount: number = 2, players: Partial<Player>[] = [], dealer: number = 0, levels: Levels | null = null, isFirstGame: boolean = true) {
    this.id = uuidv4();
    this.roomId = roomId;
    this.deckCount = deckCount;
    this.players = players.map((p, i) => ({ ...p, seat: i, hand: [], team: i % 2 === 0 ? 1 : 2 } as Player));
    this.dealer = dealer;
    this.isFirstGame = isFirstGame;
    this.trumpSuit = null;
    this.status = 'waiting';
    this.bottomCards = [];
    this.currentTrick = [];
    this.leadSeat = 0;
    this.currentSeat = 0;
    this.tricks = []; // 完整的牌局记录
    this.bidRecords = []; // 亮主/反主记录
    this.scores = { team1: 0, team2: 0 };
    this.levels = levels || { team1: 2, team2: 2 };
    this.trumpLevel = this.levels[`team${this.players[dealer].team}`] || 2;
    this.bids = [];
    this.totalScore = deckCount * 100;
    this.bidRoundStartSeat = dealer;

    // 逐轮发牌相关
    this._deck = [];
    this._bottomCount = 0;
    this._handSize = 0;
    this._dealRound = 0;
    this._rebidPhase = false;
  }

  startDeal(): { done: boolean; round?: number; hands: number[]; bottom?: number } {
    this._deck = shuffle(createDeck(this.deckCount));
    this._bottomCount = getBottomCardCount(this.deckCount);
    this._handSize = (this._deck.length - this._bottomCount) / 4;

    for (let i = 0; i < 4; i++) {
      this.players[i].hand = [];
    }

    this._dealRound = 0;
    this.bids = [];
    this.trumpSuit = null;
    this.bottomCards = [];
    this.status = 'dealing';
    this.currentSeat = this.dealer;
    this.bidRoundStartSeat = this.dealer;

    return this.dealNextRound();
  }

  dealNextRound(): { done: boolean; round?: number; hands: number[]; bottom?: number } {
    if (this._dealRound >= this._handSize) {
      // 发完所有手牌
      this.bottomCards = this._deck.slice(-this._bottomCount);
      this._deck = [];

      if (this.bids.length === 0 && this.bottomCards.length > 0) {
        const lastCard = this.bottomCards[this.bottomCards.length - 1];
        this.trumpSuit = lastCard.suit === 'joker' ? null : lastCard.suit;
      }

      const dealer = this.players[this.dealer];
      // 如果无人亮主，直接把底牌给庄家并进入扣底阶段
      // 如果有人亮过主，底牌由 confirmTrump() 分配（反主阶段可能换庄家）
      if (this.bids.length === 0) {
        dealer.hand.push(...this.bottomCards);
        this.status = 'taking_bottom';
      }
      this.currentSeat = this.dealer;
      return { done: true, hands: this.players.map(p => p.hand.length), bottom: this.bottomCards.length };
    }

    // 本轮发牌：每人一张，从庄家开始
    for (let i = 0; i < 4; i++) {
      const seat = (this.dealer + i) % 4;
      this.players[seat].hand.push(this._deck[this._dealRound * 4 + i]);
    }
    this._dealRound++;
    this.currentSeat = this.dealer;

    return { done: false, round: this._dealRound, hands: this.players.map(p => p.hand.length) };
  }

  bid(seat: number, cards: Card[]): { success: boolean; reason?: string; trumpSuit?: string | null } {
    if (this.status !== 'dealing' && this.status !== 'bidding') return { success: false, reason: '不在亮主阶段' };
    if (seat !== this.currentSeat) return { success: false, reason: '不是当前玩家的回合' };

    const player = this.players[seat];
    const bidCards = cards.map(c => player.hand.find(h => h.id === c.id)).filter(Boolean) as Card[];
    if (bidCards.length === 0) return { success: false, reason: '无效的牌' };

    const trumpLevelStr = getRankFromLevel(this.trumpLevel);

    // 记录亮主/反主尝试（无论成功与否）
    const recordBidAttempt = (success: boolean, reason?: string, action: 'bid' | 'rebid' = this.bids.length === 0 ? 'bid' : 'rebid') => {
      this.bidRecords.push({
        seat,
        userId: player.userId,
        nickname: player.nickname,
        action,
        cards: bidCards,
        trumpSuit: success ? (this.trumpSuit || null) : undefined,
        result: success ? 'success' : 'fail',
        reason
      });
    };

    // 分类：级牌、王、其他牌
    const levelCards = bidCards.filter(c => c.rank === trumpLevelStr && c.suit !== 'joker');
    const jokerCards = bidCards.filter(c => c.suit === 'joker');
    const otherCards = bidCards.filter(c => c.rank !== trumpLevelStr && c.suit !== 'joker');

    if (otherCards.length > 0) {
      recordBidAttempt(false, '只能使用级牌和王');
      return { success: false, reason: '只能使用级牌和王' };
    }

    const existingBid = this.bids[this.bids.length - 1];
    const enteringBidding = this.status === 'dealing';

    // 级牌必须同花色
    if (levelCards.length > 0) {
      const firstSuit = levelCards[0].suit;
      if (levelCards.some(c => c.suit !== firstSuit)) {
        recordBidAttempt(false, '级牌必须同花色');
        return { success: false, reason: '级牌必须同花色' };
      }
    }

    // 王比较：数量优先，同数量比大王数量
    const compareJokers = (a: Card[], b: Card[]): number => {
      if (a.length !== b.length) return a.length - b.length;
      return a.filter(j => j.rank === 'big').length - b.filter(j => j.rank === 'big').length;
    };

    // 无主：纯王2张（2小王或2大王或任意2张）
    if (levelCards.length === 0 && jokerCards.length === 2) {
      if (existingBid) {
        if (existingBid.suit === null) {
          // 反无主：需要更多或更大的王
          if (compareJokers(jokerCards, existingBid.jokers || []) <= 0) {
            recordBidAttempt(false, '需要更多或更大的王');
            return { success: false, reason: '需要更多或更大的王' };
          }
        }
        // 反有主为无主：2张王即可
      }
      if (enteringBidding) this.status = 'bidding';
      if (this.isFirstGame) {
        this.dealer = seat;
      }
      this.trumpSuit = null;
      this.bids.push({ seat, suit: null, levelCount: 0, jokers: jokerCards, cards: bidCards });
      recordBidAttempt(true);
      this.currentSeat = (this.currentSeat + 1) % 4;
      this.bidRoundStartSeat = this.currentSeat;
      return { success: true, trumpSuit: null };
    }

    if (!existingBid) {
      // 首次亮主：单张级牌 + 1张王
      if (levelCards.length < 1 || jokerCards.length < 1) {
        recordBidAttempt(false, '首次亮主需要1张级牌+1张王');
        return { success: false, reason: '首次亮主需要1张级牌+1张王' };
      }
      this.status = 'bidding';
      if (this.isFirstGame) {
        this.dealer = seat;
      }
      this.trumpSuit = levelCards[0].suit;
      this.bids.push({ seat, suit: levelCards[0].suit, levelCount: levelCards.length, jokers: jokerCards, cards: bidCards });
      recordBidAttempt(true);
      this.currentSeat = (this.currentSeat + 1) % 4;
      this.bidRoundStartSeat = this.currentSeat;
      return { success: true, trumpSuit: levelCards[0].suit };
    }

    // 反无主：只能纯王，需要更大
    if (existingBid.suit === null) {
      if (levelCards.length > 0) {
        recordBidAttempt(false, '反无主只能使用王');
        return { success: false, reason: '反无主只能使用王' };
      }
      if (jokerCards.length < 2) {
        recordBidAttempt(false, '反无主需要2张王');
        return { success: false, reason: '反无主需要2张王' };
      }
      if (compareJokers(jokerCards, existingBid.jokers || []) <= 0) {
        recordBidAttempt(false, '需要更多或更大的王');
        return { success: false, reason: '需要更多或更大的王' };
      }
      if (enteringBidding) this.status = 'bidding';
      if (this.isFirstGame) {
        this.dealer = seat;
      }
      this.trumpSuit = null;
      this.bids.push({ seat, suit: null, levelCount: 0, jokers: jokerCards, cards: bidCards });
      recordBidAttempt(true);
      this.currentSeat = (this.currentSeat + 1) % 4;
      this.bidRoundStartSeat = this.currentSeat;
      return { success: true, trumpSuit: null };
    }

    // 反有主：需要比当前多1张级牌 + 1张王
    if (jokerCards.length === 0) {
      recordBidAttempt(false, '反主必须包含王');
      return { success: false, reason: '反主必须包含王' };
    }

    const existingLevelCount = existingBid.levelCount || 0;
    if (levelCards.length < existingLevelCount + 1) {
      recordBidAttempt(false, `反主需要至少${existingLevelCount + 1}张级牌`);
      return { success: false, reason: `反主需要至少${existingLevelCount + 1}张级牌` };
    }

    if (enteringBidding) this.status = 'bidding';
    if (this.isFirstGame) {
      this.dealer = seat;
    }
    this.trumpSuit = levelCards[0].suit;
    this.bids.push({ seat, suit: levelCards[0].suit, levelCount: levelCards.length, jokers: jokerCards, cards: bidCards });
    recordBidAttempt(true);
    this.currentSeat = (this.currentSeat + 1) % 4;
    this.bidRoundStartSeat = this.currentSeat;
    return { success: true, trumpSuit: levelCards[0].suit };
  }

  passBid(seat: number): { success: boolean; reason?: string; action?: string } {
    if (this.status !== 'dealing' && this.status !== 'bidding') return { success: false, reason: '不在亮主阶段' };
    if (seat !== this.currentSeat) return { success: false, reason: '不是当前玩家的回合' };

    // 不记录过牌操作

    this.currentSeat = (this.currentSeat + 1) % 4;

    // dealing 阶段转完一圈
    if (this.status === 'dealing' && this.currentSeat === this.dealer) {
      // 还有牌要发，继续发牌；否则确认主牌
      if (this._dealRound < this._handSize) {
        return { success: true, action: 'continue_dealing' };
      }
      // 牌已发完，确保底牌已设置
      if (this.bottomCards.length === 0 && this._deck.length > 0) {
        this.bottomCards = this._deck.slice(-this._bottomCount);
        this._deck = [];
      }
      return { success: true, action: 'confirm_trump' };
    }

    // bidding 阶段转完一圈
    if (this.status === 'bidding' && this.currentSeat === this.bidRoundStartSeat) {
      // 还有牌要发，继续逐轮发牌
      if (this._dealRound < this._handSize) {
        return { success: true, action: 'continue_dealing' };
      }
      // 牌已发完，确认主牌
      if (this.bottomCards.length === 0 && this._deck.length > 0) {
        this.bottomCards = this._deck.slice(-this._bottomCount);
        this._deck = [];
      }
      return { success: true, action: 'confirm_trump' };
    }

    return { success: true };
  }

  canBid(seat: number): boolean {
    if (this.status !== 'dealing' && this.status !== 'bidding') return false;

    const player = this.players[seat];
    const trumpLevelStr = getRankFromLevel(this.trumpLevel);
    const existingBid = this.bids.length > 0 ? this.bids[this.bids.length - 1] : null;

    // 检查自己是否已经亮过主（不能自己反自己的主）
    if (existingBid && existingBid.seat === seat) {
      return false;
    }

    const levelCards = player.hand.filter(c => c.rank === trumpLevelStr && c.suit !== 'joker');
    const jokerCards = player.hand.filter(c => c.suit === 'joker');

    // 首次亮主：需要1张级牌 + 1张王
    if (!existingBid) {
      return levelCards.length >= 1 && jokerCards.length >= 1;
    }

    // 无主情况：需要2张王
    if (levelCards.length === 0 && jokerCards.length >= 2) {
      if (existingBid.suit === null) {
        const compareJokers = (a: Card[], b: Card[]): number => {
          if (a.length !== b.length) return a.length - b.length;
          return a.filter(j => j.rank === 'big').length - b.filter(j => j.rank === 'big').length;
        };
        return compareJokers(jokerCards, existingBid.jokers || []) > 0;
      }
      return true;
    }

    // 反无主：只能纯王，需要2张王
    if (existingBid.suit === null) {
      if (levelCards.length > 0) return false;
      if (jokerCards.length < 2) return false;
      const compareJokers = (a: Card[], b: Card[]): number => {
        if (a.length !== b.length) return a.length - b.length;
        return a.filter(j => j.rank === 'big').length - b.filter(j => j.rank === 'big').length;
      };
      return compareJokers(jokerCards, existingBid.jokers || []) > 0;
    }

    // 反有主：需要比当前多1张同花色级牌 + 1张王
    if (jokerCards.length === 0) return false;
    const existingLevelCount = existingBid.levelCount || 0;
    const levelCardsBySuit: Record<string, number> = {};
    for (const c of levelCards) {
      if (!levelCardsBySuit[c.suit]) levelCardsBySuit[c.suit] = 0;
      levelCardsBySuit[c.suit]++;
    }
    const maxSameSuitLevelCount = Math.max(0, ...Object.values(levelCardsBySuit));
    return maxSameSuitLevelCount >= existingLevelCount + 1;
  }

  canRebid(seat: number): boolean {
    if (this.status !== 'dealing' && this.status !== 'bidding') return false;
    if (this.bids.length === 0) return false;

    const player = this.players[seat];
    const existingBid = this.bids[this.bids.length - 1];

    // 检查自己是否已经反过主（不能自己反自己的主）
    if (existingBid.seat === seat) {
      return false;
    }

    const trumpLevelStr = getRankFromLevel(this.trumpLevel);

    const levelCards = player.hand.filter(c => c.rank === trumpLevelStr && c.suit !== 'joker');
    const jokerCards = player.hand.filter(c => c.suit === 'joker');

    // 反无主：只能纯王，需要更多或更大的王
    if (existingBid.suit === null) {
      if (levelCards.length > 0) return false;
      if (jokerCards.length < 2) return false;
      const compareJokers = (a: Card[], b: Card[]): number => {
        if (a.length !== b.length) return a.length - b.length;
        return a.filter(j => j.rank === 'big').length - b.filter(j => j.rank === 'big').length;
      };
      return compareJokers(jokerCards, existingBid.jokers || []) > 0;
    }

    // 反有主为无主：2张王即可
    if (levelCards.length === 0 && jokerCards.length >= 2) {
      return true;
    }

    // 反有主：需要比当前多1张同花色级牌 + 1张王
    if (jokerCards.length === 0) return false;
    const existingLevelCount = existingBid.levelCount || 0;
    const levelCardsBySuit: Record<string, number> = {};
    for (const c of levelCards) {
      if (!levelCardsBySuit[c.suit]) levelCardsBySuit[c.suit] = 0;
      levelCardsBySuit[c.suit]++;
    }
    const maxSameSuitLevelCount = Math.max(0, ...Object.values(levelCardsBySuit));
    return maxSameSuitLevelCount >= existingLevelCount + 1;
  }

  confirmTrump(): { trumpSuit: string | null; bottomCount: number } {
    // 发完剩余手牌
    while (this._deck.length > 0 && this._dealRound < this._handSize) {
      const result = this.dealNextRound();
      if (result.done) break;
    }
    // 确保底牌已设置
    if (this.bottomCards.length === 0 && this._deck.length > 0) {
      this.bottomCards = this._deck.slice(-this._bottomCount);
      this._deck = [];
    }

    if (this.bids.length === 0) {
      if (this.bottomCards.length > 0) {
        const lastCard = this.bottomCards[this.bottomCards.length - 1];
        this.trumpSuit = lastCard.suit === 'joker' ? null : lastCard.suit;
      }
    }
    // 庄家拿底牌
    const dealer = this.players[this.dealer];
    dealer.hand.push(...this.bottomCards);
    this.status = 'taking_bottom';
    this.currentSeat = this.dealer;
    return { trumpSuit: this.trumpSuit, bottomCount: this.bottomCards.length };
  }

  setBottom(seat: number, cardIds: string[]): { success: boolean; reason?: string } {
    if (this.status !== 'taking_bottom') return { success: false, reason: '不在扣底阶段' };
    if (seat !== this.dealer) return { success: false, reason: '只有庄家可以扣底' };

    const dealer = this.players[seat];
    const cards = cardIds.map(id => dealer.hand.find(c => c.id === id)).filter(Boolean) as Card[];
    if (cards.length !== this.bottomCards.length) {
      return { success: false, reason: `需要扣回${this.bottomCards.length}张底牌` };
    }
    if (cards.some(c => !dealer.hand.find(h => h.id === c.id))) {
      return { success: false, reason: '只能选择手牌中的牌' };
    }

    this.bottomCards = cards;
    dealer.hand = dealer.hand.filter(c => !cardIds.includes(c.id));
    this.status = 'playing';
    this.leadSeat = this.dealer;
    this.currentSeat = this.dealer;
    return { success: true };
  }

  play(seat: number, cardIds: string[]): { success: boolean; reason?: string; trickEnded?: boolean; winnerSeat?: number; winnerTeam?: number; points?: number; scores?: Scores; nextSeat?: number; playedCards?: Card[]; gameEnded?: boolean; idleScore?: number; dealerTeam?: number; winner?: string; levels?: Levels; nextDealer?: number; nextTrumpLevel?: number; bottomPoints?: number; bottomMultiplier?: number; steps?: UpgradeSteps; step?: number } {
    if (this.status !== 'playing') return { success: false, reason: '不在出牌阶段' };
    if (seat !== this.currentSeat) return { success: false, reason: '还没轮到你' };

    const player = this.players[seat];
    let cards = cardIds.map(id => player.hand.find(c => c.id === id)).filter(Boolean) as Card[];
    if (cards.length === 0) return { success: false, reason: '无效的牌' };

    const leadCards = this.currentTrick.length > 0 ? this.currentTrick[0].cards : null;

    let isDumpMax = false;
    if (!leadCards || leadCards.length === 0) {
      const pattern = getCardPattern(cards, this.trumpSuit, this.trumpLevel);
      if (pattern.type === 'mix') {
        const otherPlayers = this.players.filter(p => p.seat !== seat);
        const isMax = isDumpGuaranteedMax(cards, otherPlayers, this.trumpSuit, this.trumpLevel);
        if (isMax) {
          isDumpMax = true;
        } else {
          const fallback = getFallbackFromDump(cards, this.trumpSuit, this.trumpLevel);
          cards = fallback.cards;
          cardIds = cards.map(c => c.id);
        }
      }
    }

    if (!isDumpMax) {
      const validation = validatePlay(player.hand, cards, leadCards, this.trumpSuit, this.trumpLevel);
      if (!validation.valid) {
        return { success: false, reason: validation.reason };
      }
    }

    player.hand = player.hand.filter(c => !cardIds.includes(c.id));
    this.currentTrick.push({ seat, cards });

    if (this.currentTrick.length === 4) {
      const leadSuit = this.currentTrick[0].cards[0].suit;
      const allCards = this.currentTrick.map(t => t.cards).flat();
      const winnerIdx = findWinningCard(
        this.currentTrick,
        this.trumpSuit, this.trumpLevel, leadSuit
      );
      const winnerSeat = this.currentTrick[winnerIdx].seat;
      const points = getRoundPoints(allCards);
      const winnerTeam = this.players[winnerSeat].team;

      this.tricks.push({
        cards: allCards,
        plays: [...this.currentTrick],
        winnerSeat,
        winnerTeam,
        points
      });

      if (winnerTeam === 1) this.scores.team1 += points;
      else this.scores.team2 += points;

      this.leadSeat = winnerSeat;
      this.currentSeat = winnerSeat;
      this.currentTrick = [];

      const isEnd = this.players.every(p => p.hand.length === 0);
      console.log(`[PLAY] isEnd=${isEnd} scores=${JSON.stringify(this.scores)} lastWinnerTeam=${winnerTeam}`);
      if (isEnd) {
        return this.endRound();
      }

      return {
        success: true,
        trickEnded: true,
        winnerSeat,
        winnerTeam,
        points,
        scores: this.scores,
        nextSeat: this.currentSeat,
        playedCards: cards
      };
    }

    this.currentSeat = (this.currentSeat + 1) % 4;
    return { success: true, nextSeat: this.currentSeat, playedCards: cards };
  }

  endRound(): { success: boolean; gameEnded: true; idleScore: number; dealerTeam: number; winner: string; scores: Scores; levels: Levels; nextDealer: number; nextTrumpLevel: number; bottomPoints: number; bottomMultiplier: number; steps: UpgradeSteps; step: number } {
    this.status = 'finished';
    const dealerTeam = this.players[this.dealer].team;
    const idleTeam = dealerTeam === 1 ? 2 : 1;

    // 底牌得分：最后一轮赢家获得底牌中的分数
    const lastTrick = this.tricks[this.tricks.length - 1];
    const lastWinnerTeam = lastTrick ? lastTrick.winnerTeam : dealerTeam;
    let bottomPoints = getRoundPoints(this.bottomCards);
    let bottomMultiplier = 1;

    console.log(`[ENDROUND] dealer=${this.dealer} dealerTeam=${dealerTeam} scores=${JSON.stringify(this.scores)} bottomPoints=${bottomPoints} lastWinnerTeam=${lastWinnerTeam}`);
    // 抠底翻倍：如果最后一轮用拖拉机赢，底分翻倍数
    if (lastTrick && lastWinnerTeam !== dealerTeam) {
      const winnerPlay = lastTrick.plays.find(t => t.seat === lastTrick.winnerSeat);
      if (winnerPlay) {
        const pattern = getCardPattern(winnerPlay.cards, this.trumpSuit, this.trumpLevel);
        if (pattern.type === 'tractor') {
          bottomMultiplier = winnerPlay.cards.length;
          bottomPoints *= bottomMultiplier;
        }
      }
      if (lastWinnerTeam === 1) this.scores.team1 += bottomPoints;
      else this.scores.team2 += bottomPoints;
      console.log(`[ENDROUND] 抠底后 scores=${JSON.stringify(this.scores)}`);
    }

    // 如果庄家守住底牌，底牌得分不计入，显示为0
    if (lastWinnerTeam === dealerTeam) {
      bottomPoints = 0;
      bottomMultiplier = 1;
    }

    const idleScore = dealerTeam === 1 ? this.scores.team2 : this.scores.team1;
    console.log(`[ENDROUND] idleScore=${idleScore}`);

    const steps = getUpgradeSteps(idleScore, this.totalScore, this.deckCount);

    const step = this.deckCount * 20;

    // Determine winner: 'dealer', 'idle', or 'draw'
    let winner: string;
    if (steps.idle > 0) winner = 'idle';
    else if (steps.dealer > 0) winner = 'dealer';
    else if (idleScore >= step * 2) winner = 'idle';
    else winner = 'draw';

    let dealerLevelChange = steps.dealer;
    let idleLevelChange = steps.idle;

    if (idleLevelChange > 0) {
      // 闲家得分>=120，升级并夺庄
      this.levels[`team${idleTeam}`] = normalizeLevel(this.levels[`team${idleTeam}`] + idleLevelChange);
      this.dealer = this.players.find(p => p.team === idleTeam)!.seat;
    } else if (dealerLevelChange > 0) {
      // 庄家守住，升级
      this.levels[`team${dealerTeam}`] = normalizeLevel(this.levels[`team${dealerTeam}`] + dealerLevelChange);
    } else if (idleScore >= step * 2) {
      // 闲家得分80-119，夺庄但不额外升级
      this.dealer = this.players.find(p => p.team === idleTeam)!.seat;
    }
    // else: 庄家守住但不升级（40-79分），庄家不变

    this.trumpLevel = normalizeLevel(this.levels[`team${this.players[this.dealer].team}`]);

    return {
      success: true,
      gameEnded: true,
      idleScore,
      dealerTeam,
      winner,
      scores: this.scores,
      levels: this.levels,
      nextDealer: this.dealer,
      nextTrumpLevel: this.trumpLevel,
      bottomPoints,
      bottomMultiplier,
      steps,
      step
    };
  }

  toJSON(seat: number = -1): Record<string, any> {
    return {
      id: this.id,
      status: this.status,
      deckCount: this.deckCount,
      trumpSuit: this.trumpSuit,
      trumpLevel: this.trumpLevel,
      dealer: this.dealer,
      currentSeat: this.currentSeat,
      leadSeat: this.leadSeat,
      scores: this.scores,
      levels: this.levels,
      currentTrick: this.currentTrick,
      tricksCount: this.tricks.length,
      bottomCount: this.bottomCards.length,
      bottomCards: seat === this.dealer && (this.status === 'taking_bottom' || this.status === 'playing') ? this.bottomCards : undefined,
      players: this.players.map(p => ({
        seat: p.seat,
        team: p.team,
        handCount: p.hand.length,
        hand: seat === p.seat ? p.hand : undefined,
        userId: p.userId,
        nickname: p.nickname,
        avatar: p.avatar
      })),
      bids: this.bids,
      bidRecords: this.bidRecords,
      tricks: this.tricks
    };
  }
}
