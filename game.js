const { v4: uuidv4 } = require('uuid');

const SUITS = ['spade', 'heart', 'diamond', 'club'];
const RANKS = ['3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A', '2'];
const RANK_ORDER = { '3': 0, '4': 1, '5': 2, '6': 3, '7': 4, '8': 5, '9': 6, '10': 7, 'J': 8, 'Q': 9, 'K': 10, 'A': 11, '2': 12 };
const POINT_CARDS = { '5': 5, '10': 10, 'K': 10 };

function createCard(suit, rank, deckIndex) {
  return { suit, rank, id: `${suit}_${rank}_${deckIndex}`, deckIndex };
}

function createDeck(deckCount) {
  const cards = [];
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

function shuffle(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

function getBottomCardCount(deckCount) {
  if (deckCount === 2) return 8;
  if (deckCount === 3) return 6;
  if (deckCount === 4) return 8;
  return 8;
}

function isTrump(card, trumpSuit, trumpLevel) {
  if (card.suit === 'joker') return true;
  if (card.rank === String(trumpLevel)) return true;
  if (trumpSuit && card.suit === trumpSuit && card.rank !== String(trumpLevel)) return true;
  return false;
}

function getTrumpRank(card, trumpSuit, trumpLevel) {
  if (card.suit === 'joker') {
    return card.rank === 'big' ? 100 : 99;
  }
  if (card.rank === String(trumpLevel)) {
    if (card.suit === trumpSuit) return 98;
    return 97;
  }
  if (trumpSuit && card.suit === trumpSuit) {
    return RANK_ORDER[card.rank];
  }
  return -1;
}

function compareCards(a, b, trumpSuit, trumpLevel, leadSuit) {
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

function groupByRank(cards) {
  const map = {};
  for (const c of cards) {
    const key = `${c.suit}_${c.rank}`;
    if (!map[key]) map[key] = [];
    map[key].push(c);
  }
  return map;
}

function isTractor(cards, trumpSuit, trumpLevel) {
  if (cards.length < 4 || cards.length % 2 !== 0) return false;
  const pairs = [];
  const grouped = groupByRank(cards);
  for (const key in grouped) {
    if (grouped[key].length >= 2) {
      const [suit, rank] = key.split('_');
      pairs.push({ suit, rank, count: grouped[key].length });
    }
  }
  if (pairs.length < 2) return false;

  pairs.sort((a, b) => RANK_ORDER[a.rank] - RANK_ORDER[b.rank]);

  const isTrumpPair = (p) => isTrump({ suit: p.suit, rank: p.rank }, trumpSuit, trumpLevel);

  for (let i = 1; i < pairs.length; i++) {
    const prev = pairs[i - 1];
    const curr = pairs[i];
    const sameSuit = prev.suit === curr.suit || (isTrumpPair(prev) && isTrumpPair(curr));
    if (!sameSuit) return false;

    if (isTrumpPair(prev) && isTrumpPair(curr)) {
      const trumpRanks = [getTrumpRank({ suit: prev.suit, rank: prev.rank }, trumpSuit, trumpLevel),
                          getTrumpRank({ suit: curr.suit, rank: curr.rank }, trumpSuit, trumpLevel)];
      if (Math.abs(trumpRanks[0] - trumpRanks[1]) !== 1) return false;
    } else {
      if (prev.suit !== curr.suit) return false;
      if (Math.abs(RANK_ORDER[prev.rank] - RANK_ORDER[curr.rank]) !== 1) return false;
      if (prev.rank === String(trumpLevel) || curr.rank === String(trumpLevel)) return false;
    }
  }

  return true;
}

function getCardPattern(cards, trumpSuit, trumpLevel) {
  if (cards.length === 1) return { type: 'single', length: 1 };

  const grouped = groupByRank(cards);
  const pairs = Object.values(grouped).filter(g => g.length >= 2);

  if (cards.length === 2 && pairs.length === 1) return { type: 'pair', length: 2 };

  if (isTractor(cards, trumpSuit, trumpLevel)) {
    return { type: 'tractor', length: cards.length };
  }

  return { type: 'mix', length: cards.length };
}

function hasSuit(hand, suit, trumpSuit, trumpLevel) {
  return hand.some(c => {
    if (suit === 'trump') return isTrump(c, trumpSuit, trumpLevel);
    return !isTrump(c, trumpSuit, trumpLevel) && c.suit === suit;
  });
}

function canFollow(hand, leadCards, trumpSuit, trumpLevel) {
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

  return true;
}

function validatePlay(hand, playedCards, leadCards, trumpSuit, trumpLevel) {
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

  if (leadPattern.type === 'tractor' && playedInSuit.length >= leadCards.length) {
    const isTractorPlay = isTractor(playedInSuit.slice(0, leadCards.length), trumpSuit, trumpLevel);
    const handCanTractor = isTractor(handInSuit.slice(0, leadCards.length), trumpSuit, trumpLevel);
    if (handCanTractor && !isTractorPlay) {
      return { valid: false, reason: '有拖拉机必须跟拖拉机' };
    }
  }

  return { valid: true };
}

function findWinningCard(trickPlays, trumpSuit, trumpLevel, leadSuit) {
  const leadCards = trickPlays[0].cards;
  const leadPattern = getCardPattern(leadCards, trumpSuit, trumpLevel);

  let winner = 0;

  for (let i = 1; i < trickPlays.length; i++) {
    const curr = trickPlays[i];
    const prev = trickPlays[winner];

    if (isPlayBeating(curr.cards, prev.cards, leadPattern, leadSuit, trumpSuit, trumpLevel)) {
      winner = i;
    }
  }
  return winner;
}

function isPlayBeating(playCards, winnerCards, leadPattern, leadSuit, trumpSuit, trumpLevel) {
  const playIsTrump = playCards.some(c => isTrump(c, trumpSuit, trumpLevel));
  const winnerIsTrump = winnerCards.some(c => isTrump(c, trumpSuit, trumpLevel));

  // 主牌 vs 非主牌
  if (playIsTrump && !winnerIsTrump) return true;
  if (!playIsTrump && winnerIsTrump) return false;

  // 都是主牌或都不是主牌时，检查是否跟了首家的花色
  const playInSuit = playCards.filter(c => {
    if (isTrump(c, trumpSuit, trumpLevel)) return playIsTrump;
    return c.suit === leadSuit;
  });
  const winnerInSuit = winnerCards.filter(c => {
    if (isTrump(c, trumpSuit, trumpLevel)) return winnerIsTrump;
    return c.suit === leadSuit;
  });

  // 都没跟花色，先出的赢
  if (playInSuit.length === 0 && winnerInSuit.length === 0) return false;
  // 有一方没跟花色
  if (playInSuit.length === 0) return false;
  if (winnerInSuit.length === 0) return true;

  // 对于对子/拖拉机：只有跟了同类型才能赢
  if (leadPattern.type === 'pair' || leadPattern.type === 'tractor') {
    const playPattern = getCardPattern(playInSuit, trumpSuit, trumpLevel);
    const winnerPattern = getCardPattern(winnerInSuit, trumpSuit, trumpLevel);

    const playMatchesType = playPattern.type === leadPattern.type;
    const winnerMatchesType = winnerPattern.type === leadPattern.type;

    // 都跟了同类型，比最大的牌
    if (playMatchesType && winnerMatchesType) {
      const playMax = getMaxCard(playInSuit, trumpSuit, trumpLevel, leadSuit);
      const winnerMax = getMaxCard(winnerInSuit, trumpSuit, trumpLevel, leadSuit);
      return compareCards(playMax, winnerMax, trumpSuit, trumpLevel, leadSuit) > 0;
    }
    // 只有一方跟了同类型
    if (playMatchesType && !winnerMatchesType) return true;
    if (!playMatchesType && winnerMatchesType) return false;
    // 都没跟同类型，比最大牌
    const playMax2 = getMaxCard(playInSuit, trumpSuit, trumpLevel, leadSuit);
    const winnerMax2 = getMaxCard(winnerInSuit, trumpSuit, trumpLevel, leadSuit);
    return compareCards(playMax2, winnerMax2, trumpSuit, trumpLevel, leadSuit) > 0;
  }

  // 单张或mix，比最大牌
  const playMax = getMaxCard(playInSuit, trumpSuit, trumpLevel, leadSuit);
  const winnerMax = getMaxCard(winnerInSuit, trumpSuit, trumpLevel, leadSuit);
  return compareCards(playMax, winnerMax, trumpSuit, trumpLevel, leadSuit) > 0;
}

function getMaxCard(cards, trumpSuit, trumpLevel, leadSuit) {
  if (!cards || cards.length === 0) return { suit: 'joker', rank: 'small' };
  return cards.reduce((max, c) => compareCards(c, max, trumpSuit, trumpLevel, leadSuit) > 0 ? c : max);
}

function getRoundPoints(cards) {
  let points = 0;
  for (const c of cards) {
    if (POINT_CARDS[c.rank]) points += POINT_CARDS[c.rank];
  }
  return points;
}

function getUpgradeSteps(score, totalScore, deckCount) {
  const ratio = score / totalScore;
  if (deckCount === 2) {
    if (score === 0) return { dealer: 3, idle: 0 };
    if (score <= 35) return { dealer: 2, idle: 0 };
    if (score <= 75) return { dealer: 1, idle: 0 };
    if (score <= 115) return { dealer: 0, idle: 0 };
    if (score <= 155) return { dealer: 0, idle: 1 };
    if (score <= 195) return { dealer: 0, idle: 2 };
    return { dealer: 0, idle: 3 };
  }
  if (deckCount === 3) {
    if (score === 0) return { dealer: 3, idle: 0 };
    if (score <= 55) return { dealer: 2, idle: 0 };
    if (score <= 115) return { dealer: 1, idle: 0 };
    if (score <= 175) return { dealer: 0, idle: 0 };
    if (score <= 235) return { dealer: 0, idle: 1 };
    if (score <= 295) return { dealer: 0, idle: 2 };
    return { dealer: 0, idle: 3 };
  }
  if (deckCount === 4) {
    if (score === 0) return { dealer: 3, idle: 0 };
    if (score <= 75) return { dealer: 2, idle: 0 };
    if (score <= 155) return { dealer: 1, idle: 0 };
    if (score <= 235) return { dealer: 0, idle: 0 };
    if (score <= 315) return { dealer: 0, idle: 1 };
    if (score <= 395) return { dealer: 0, idle: 2 };
    return { dealer: 0, idle: 3 };
  }
  return { dealer: 0, idle: 0 };
}

class GameEngine {
  constructor(roomId, deckCount = 2, players = []) {
    this.id = uuidv4();
    this.roomId = roomId;
    this.deckCount = deckCount;
    this.players = players.map((p, i) => ({ ...p, seat: i, hand: [], team: i % 2 === 0 ? 1 : 2 }));
    this.dealer = 0;
    this.trumpSuit = null;
    this.trumpLevel = 2;
    this.status = 'dealing';
    this.bottomCards = [];
    this.currentTrick = [];
    this.leadSeat = 0;
    this.currentSeat = 0;
    this.tricks = []; // 完整的牌局记录
    this.scores = { team1: 0, team2: 0 };
    this.levels = { team1: 2, team2: 2 };
    this.bids = [];
    this.totalScore = deckCount * 100;
  }

  deal() {
    const deck = shuffle(createDeck(this.deckCount));
    const bottomCount = getBottomCardCount(this.deckCount);
    const handSize = (deck.length - bottomCount) / 4;

    for (let i = 0; i < 4; i++) {
      this.players[i].hand = deck.slice(i * handSize, (i + 1) * handSize);
    }
    this.bottomCards = deck.slice(-bottomCount);
    this.status = 'bidding';
    this.currentSeat = this.dealer;
    return { hands: this.players.map(p => p.hand.length), bottom: this.bottomCards.length };
  }

  bid(seat, cards) {
    if (this.status !== 'bidding') return { success: false, reason: '不在亮主阶段' };

    const player = this.players[seat];
    const bidCards = cards.map(c => player.hand.find(h => h.id === c.id)).filter(Boolean);
    if (bidCards.length === 0) return { success: false, reason: '无效的牌' };

    const trumpLevelStr = String(this.trumpLevel);

    // 分类：级牌、王、其他牌
    const levelCards = bidCards.filter(c => c.rank === trumpLevelStr && c.suit !== 'joker');
    const jokerCards = bidCards.filter(c => c.suit === 'joker');
    const otherCards = bidCards.filter(c => c.rank !== trumpLevelStr && c.suit !== 'joker');

    if (otherCards.length > 0) {
      return { success: false, reason: '只能使用级牌和王' };
    }

    // 级牌必须同花色
    if (levelCards.length > 0) {
      const firstSuit = levelCards[0].suit;
      if (levelCards.some(c => c.suit !== firstSuit)) {
        return { success: false, reason: '级牌必须同花色' };
      }
    }

    const existingBid = this.bids[this.bids.length - 1];

    // 王比较：数量优先，同数量比大王数量
    const compareJokers = (a, b) => {
      if (a.length !== b.length) return a.length - b.length;
      return a.filter(j => j.rank === 'big').length - b.filter(j => j.rank === 'big').length;
    };

    // 无主：纯王（≥2张），无级牌
    if (levelCards.length === 0 && jokerCards.length >= 2) {
      if (existingBid) {
        if (existingBid.suit === null) {
          if (compareJokers(jokerCards, existingBid.jokers || []) <= 0) {
            return { success: false, reason: '需要更多或更大的王' };
          }
        } else {
          return { success: false, reason: '反有主必须带级牌' };
        }
      }
      this.trumpSuit = null;
      this.bids.push({ seat, suit: null, levelCount: 0, jokers: jokerCards, cards: bidCards });
      return { success: true, trumpSuit: null };
    }

    if (!existingBid) {
      // 首次亮主：无王，至少2张级牌
      if (jokerCards.length > 0) {
        return { success: false, reason: '首次亮主不能使用王' };
      }
      if (levelCards.length < 2) {
        return { success: false, reason: '亮主至少需要2张级牌' };
      }
      this.trumpSuit = levelCards[0].suit;
      this.bids.push({ seat, suit: levelCards[0].suit, levelCount: levelCards.length, jokers: [], cards: bidCards });
      return { success: true, trumpSuit: levelCards[0].suit };
    }

    // 反无主：只能纯王
    if (existingBid.suit === null) {
      if (levelCards.length > 0) {
        return { success: false, reason: '反无主只能使用王' };
      }
      if (compareJokers(jokerCards, existingBid.jokers || []) <= 0) {
        return { success: false, reason: '需要更多或更大的王' };
      }
      this.trumpSuit = null;
      this.bids.push({ seat, suit: null, levelCount: 0, jokers: jokerCards, cards: bidCards });
      return { success: true, trumpSuit: null };
    }

    // 反有主：必须有王
    if (jokerCards.length === 0) {
      return { success: false, reason: '反主必须包含王' };
    }

    const existingLevelCount = existingBid.levelCount || 0;
    if (levelCards.length < existingLevelCount) {
      return { success: false, reason: `反主需要至少${existingLevelCount}张级牌` };
    }

    if (levelCards.length === existingLevelCount) {
      if (compareJokers(jokerCards, existingBid.jokers || []) <= 0) {
        return { success: false, reason: '需要更大的王才能反主' };
      }
    }

    this.trumpSuit = levelCards[0].suit;
    this.bids.push({ seat, suit: levelCards[0].suit, levelCount: levelCards.length, jokers: jokerCards, cards: bidCards });
    return { success: true, trumpSuit: levelCards[0].suit };
  }

  confirmTrump() {
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

  setBottom(seat, cardIds) {
    if (this.status !== 'taking_bottom') return { success: false, reason: '不在扣底阶段' };
    if (seat !== this.dealer) return { success: false, reason: '只有庄家可以扣底' };

    const dealer = this.players[seat];
    const cards = cardIds.map(id => dealer.hand.find(c => c.id === id)).filter(Boolean);
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

  play(seat, cardIds) {
    if (this.status !== 'playing') return { success: false, reason: '不在出牌阶段' };
    if (seat !== this.currentSeat) return { success: false, reason: '还没轮到你' };

    const player = this.players[seat];
    let cards = cardIds.map(id => player.hand.find(c => c.id === id)).filter(Boolean);
    if (cards.length === 0) return { success: false, reason: '无效的牌' };

    const leadCards = this.currentTrick.length > 0 ? this.currentTrick[0].cards : null;

    // 甩牌违规自动拆最小牌
    if (!leadCards || leadCards.length === 0) {
      const pattern = getCardPattern(cards, this.trumpSuit, this.trumpLevel);
      if (pattern.type === 'mix') {
        cards.sort((a, b) => compareCards(a, b, this.trumpSuit, this.trumpLevel, a.suit));
        const minCard = cards[0];
        cardIds = [minCard.id];
        cards = [minCard];
      }
    }

    const validation = validatePlay(player.hand, cards, leadCards, this.trumpSuit, this.trumpLevel);
    if (!validation.valid) {
      return { success: false, reason: validation.reason };
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

  endRound() {
    this.status = 'finished';
    const dealerTeam = this.players[this.dealer].team;
    const idleTeam = dealerTeam === 1 ? 2 : 1;

    // 底牌得分：最后一轮赢家获得底牌中的分数
    const lastTrick = this.tricks[this.tricks.length - 1];
    const lastWinnerTeam = lastTrick ? lastTrick.winnerTeam : dealerTeam;
    let bottomPoints = getRoundPoints(this.bottomCards);
    let bottomMultiplier = 1;

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
    }

    const idleScore = dealerTeam === 1 ? this.scores.team2 : this.scores.team1;

    const steps = getUpgradeSteps(idleScore, this.totalScore, this.deckCount);

    let dealerLevelChange = steps.dealer;
    let idleLevelChange = steps.idle;

    if (idleLevelChange > 0) {
      this.levels[`team${idleTeam}`] += idleLevelChange;
      this.dealer = this.players.find(p => p.team === idleTeam).seat;
    } else if (dealerLevelChange > 0) {
      this.levels[`team${dealerTeam}`] += dealerLevelChange;
    } else {
      this.dealer = this.players.find(p => p.team === idleTeam).seat;
    }

    this.trumpLevel = this.levels[`team${this.players[this.dealer].team}`];

    return {
      success: true,
      gameEnded: true,
      idleScore,
      dealerTeam,
      scores: this.scores,
      levels: this.levels,
      nextDealer: this.dealer,
      nextTrumpLevel: this.trumpLevel,
      bottomPoints,
      bottomMultiplier
    };
  }

  toJSON(seat = -1) {
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
      bottomCards: seat === this.dealer && this.status === 'taking_bottom' ? this.bottomCards : undefined,
      players: this.players.map(p => ({
        seat: p.seat,
        team: p.team,
        handCount: p.hand.length,
        hand: seat === p.seat ? p.hand : undefined
      })),
      bids: this.bids,
      tricks: this.tricks
    };
  }
}

module.exports = {
  GameEngine,
  SUITS,
  RANKS,
  isTrump,
  compareCards,
  getCardPattern,
  validatePlay,
  findWinningCard,
  getRoundPoints,
  getUpgradeSteps
};
