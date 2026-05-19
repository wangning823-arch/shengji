const { LLMClient } = require('./llm-client');
const {
  validatePlay, getCardPattern, isTrump, compareCards,
  isPlayBeating, findWinningCard, getMaxCard, isTractor,
  groupByRank, getTrumpRank, RANK_ORDER, POINT_CARDS, getRoundPoints,
  getRankFromLevel
} = require('./game');
const {
  AdvancedAI, evaluateCardValue, evaluateHandStrength,
  findPairs, findTractors, analyzeGameState,
  selectLeadPlay, selectFollowPlay, selectBottomCards, decideBid
} = require('./advanced-ai');

const SUIT_SYMBOLS = { spade: '♠', heart: '♥', diamond: '♦', club: '♣', joker: '🃏' };
const SUIT_NAMES = { spade: '黑桃', heart: '红桃', diamond: '方块', club: '梅花' };

class CardTracker {
  constructor(deckCount = 2) {
    this.deckCount = deckCount;
    this.playedCards = new Set();
    this.playedBySuit = { spade: [], heart: [], diamond: [], club: [], joker: [] };
    this.totalPoints = deckCount * 100;
    this.playedPoints = 0;
    this.voidMap = { 0: {}, 1: {}, 2: {}, 3: {} };
    this.trumpCardsPlayed = 0;
    this.trumpSuit = null;
    this.trumpLevel = 2;
    this.recordedTrickIds = new Set();
  }

  setTrump(trumpSuit, trumpLevel) {
    this.trumpSuit = trumpSuit;
    this.trumpLevel = trumpLevel;
  }

  recordPlayedCards(cards) {
    for (const card of cards) {
      if (!this.playedCards.has(card.id)) {
        this.playedCards.add(card.id);
        this.playedBySuit[card.suit].push(card);
        if (card.rank === '5') this.playedPoints += 5;
        else if (card.rank === '10' || card.rank === 'K') this.playedPoints += 10;
        if (this.trumpSuit && isTrump(card, this.trumpSuit, this.trumpLevel)) {
          this.trumpCardsPlayed++;
        }
      }
    }
  }

  recordTrick(trick) {
    const trickId = trick.plays ? trick.plays.map(p => `${p.seat}:${p.cards.map(c => c.id).join(',')}`).join('|') : null;
    if (trickId && this.recordedTrickIds.has(trickId)) return;
    if (trickId) this.recordedTrickIds.add(trickId);

    if (!trick.plays || trick.plays.length === 0) {
      this.recordPlayedCards(trick.cards || []);
      return;
    }

    const leadSuit = trick.plays[0].cards[0].suit;
    const leadIsTrump = this.trumpSuit && isTrump(trick.plays[0].cards[0], this.trumpSuit, this.trumpLevel);

    for (const play of trick.plays) {
      this.recordPlayedCards(play.cards);
      if (play.seat !== trick.plays[0].seat && !leadIsTrump) {
        const followedSuit = play.cards.some(c => !isTrump(c, this.trumpSuit, this.trumpLevel) && c.suit === leadSuit);
        if (!followedSuit) {
          this.voidMap[play.seat][leadSuit] = true;
        }
      }
    }
  }

  isPlayerVoidInSuit(seat, suit) {
    return !!this.voidMap[seat]?.[suit];
  }

  getTrumpCardsRemaining() {
    // Total trump in deck: jokers (2*deckCount) + level cards (4*deckCount) + trump suit cards (13*deckCount - deckCount for level)
    const totalTrump = 2 * this.deckCount + 4 * this.deckCount + 12 * this.deckCount;
    return totalTrump - this.trumpCardsPlayed;
  }

  getRemainingPoints() {
    return this.totalPoints - this.playedPoints;
  }

  reset() {
    this.playedCards = new Set();
    this.playedBySuit = { spade: [], heart: [], diamond: [], club: [], joker: [] };
    this.playedPoints = 0;
    this.voidMap = { 0: {}, 1: {}, 2: {}, 3: {} };
    this.trumpCardsPlayed = 0;
    this.recordedTrickIds = new Set();
  }

  getPlayedSummary() {
    let summary = '';
    for (const suit of ['spade', 'heart', 'diamond', 'club']) {
      const cards = this.playedBySuit[suit];
      if (cards.length > 0) {
        const ranks = cards.map(c => c.rank).filter((v, i, a) => a.indexOf(v) === i);
        summary += `- ${SUIT_NAMES[suit]}：${ranks.join(', ')}\n`;
      }
    }
    if (this.playedBySuit.joker.length > 0) {
      summary += `- 王牌：${this.playedBySuit.joker.map(c => c.rank === 'big' ? '大王' : '小王').join(', ')}\n`;
    }
    summary += `\n- 已得分：${this.playedPoints}分，剩余约：${this.getRemainingPoints()}分`;
    return summary || '- 暂无已出牌记录';
  }
}

class CandidateGenerator {
  static generateCandidates(hand, leadCards, trumpSuit, trumpLevel) {
    const candidates = [];

    if (!leadCards || leadCards.length === 0) {
      // 首家出牌：生成单张、对子、拖拉机等选项
      return this.generateLeadCandidates(hand, trumpSuit, trumpLevel);
    } else {
      // 跟牌：生成合法的跟牌选项
      return this.generateFollowCandidates(hand, leadCards, trumpSuit, trumpLevel);
    }
  }

  static generateLeadCandidates(hand, trumpSuit, trumpLevel) {
    const candidates = [];
    const sortedHand = [...hand].sort((a, b) =>
      this.cardStrengthValue(a, trumpSuit, trumpLevel) - this.cardStrengthValue(b, trumpSuit, trumpLevel)
    );

    // 1. Tractors (longest first)
    const tractors = this.findTractorsInSuit(hand, 0, trumpSuit, trumpLevel);
    for (const t of tractors) {
      const isTrumpTractor = t.every(c => isTrump(c, trumpSuit, trumpLevel));
      candidates.push({ cards: t, description: isTrumpTractor ? '出主牌拖拉机' : '出拖拉机', tag: 'tractor' });
    }

    // 2. Pairs (strongest first)
    const allPairs = this.findPairsInSuit(hand, trumpSuit, trumpLevel);
    const strongPairs = [...allPairs].sort((a, b) =>
      this.cardStrengthValue(b[0], trumpSuit, trumpLevel) - this.cardStrengthValue(a[0], trumpSuit, trumpLevel)
    );
    for (const p of strongPairs) {
      const isTrumpPair = p.every(c => isTrump(c, trumpSuit, trumpLevel));
      candidates.push({ cards: p, description: isTrumpPair ? '出主牌对子' : `出${p[0].rank}对子`, tag: 'pair' });
    }

    // 3. Off-suit Aces (strong control)
    const aces = hand.filter(c => c.rank === 'A' && !isTrump(c, trumpSuit, trumpLevel));
    for (const a of aces) {
      candidates.push({ cards: [a], description: '出A控牌', tag: 'strong_single' });
    }

    // 4. Small non-trump singles (draw out opponent trumps)
    const smallNonTrump = sortedHand.filter(c => !isTrump(c, trumpSuit, trumpLevel));
    if (smallNonTrump.length > 0) {
      candidates.push({ cards: [smallNonTrump[0]], description: '出小牌引主', tag: 'small_single' });
    }

    // 5. Small trump singles
    const trumpCards = sortedHand.filter(c => isTrump(c, trumpSuit, trumpLevel));
    if (trumpCards.length > 0) {
      candidates.push({ cards: [trumpCards[0]], description: '出小主牌清主', tag: 'small_trump' });
    }

    // 6. Fallback: smallest card
    if (sortedHand.length > 0) {
      candidates.push({ cards: [sortedHand[0]], description: '出最小牌', tag: 'fallback' });
    }

    return this.deduplicateCandidates(candidates);
  }

  static generateFollowCandidates(hand, leadCards, trumpSuit, trumpLevel) {
    const validPlays = this.findAllValidPlays(hand, leadCards, trumpSuit, trumpLevel);
    if (validPlays.length === 0) {
      return [{ cards: [hand[0]], description: '随便出', tag: 'fallback' }];
    }

    const candidates = [];
    const leadIsTrump = isTrump(leadCards[0], trumpSuit, trumpLevel);
    const leadSuit = leadIsTrump ? 'trump' : leadCards[0].suit;

    // Classify plays: follow suit / trump chop / dump
    const followPlays = [];
    const chopPlays = [];
    const dumpPlays = [];

    for (const play of validPlays) {
      const inSuit = play.filter(c => {
        if (leadIsTrump) return isTrump(c, trumpSuit, trumpLevel);
        return !isTrump(c, trumpSuit, trumpLevel) && c.suit === leadSuit;
      });
      const trumps = play.filter(c => isTrump(c, trumpSuit, trumpLevel) && !inSuit.includes(c));

      if (inSuit.length > 0) followPlays.push(play);
      else if (trumps.length > 0) chopPlays.push(play);
      else dumpPlays.push(play);
    }

    const sortByMax = (plays) => [...plays].sort((a, b) => {
      const aMax = Math.max(...a.map(c => this.cardStrengthValue(c, trumpSuit, trumpLevel)));
      const bMax = Math.max(...b.map(c => this.cardStrengthValue(c, trumpSuit, trumpLevel)));
      return aMax - bMax;
    });

    const sortedFollow = sortByMax(followPlays);
    const sortedChops = sortByMax(chopPlays);
    const sortedDump = sortByMax(dumpPlays);

    // Minimum follow
    if (sortedFollow.length > 0) {
      candidates.push({ cards: sortedFollow[0], description: '跟最小的牌', tag: 'min_follow' });
    }

    // Minimum winning follow
    const winningFollows = sortedFollow.filter(p => this.canWin(p, leadCards, trumpSuit, trumpLevel));
    if (winningFollows.length > 0) {
      candidates.push({ cards: winningFollows[0], description: '最小能赢的牌', tag: 'min_win_follow' });
    }

    // Maximum follow
    if (sortedFollow.length > 1) {
      candidates.push({ cards: sortedFollow[sortedFollow.length - 1], description: '跟最大的牌', tag: 'max_follow' });
    }

    // Point card follows (dump points to winning teammate)
    const pointFollows = sortedFollow.filter(p => p.some(c => ['5', '10', 'K'].includes(c.rank)));
    for (const pf of pointFollows.slice(0, 2)) {
      candidates.push({ cards: pf, description: '出分牌', tag: 'point_follow' });
    }

    // Chop options
    if (sortedChops.length > 0) {
      candidates.push({ cards: sortedChops[0], description: '将吃(小主)', tag: 'min_chop' });
      if (sortedChops.length > 1) {
        candidates.push({ cards: sortedChops[sortedChops.length - 1], description: '将吃(大主)', tag: 'max_chop' });
      }
    }

    // Dump options
    if (sortedDump.length > 0) {
      candidates.push({ cards: sortedDump[0], description: '垫最小的牌', tag: 'min_dump' });
      const pointDumps = sortedDump.filter(p => p.some(c => ['5', '10', 'K'].includes(c.rank)));
      if (pointDumps.length > 0) {
        candidates.push({ cards: pointDumps[0], description: '垫分牌', tag: 'point_dump' });
      }
    }

    return this.deduplicateCandidates(candidates);
  }

  static findAllValidPlays(hand, leadCards, trumpSuit, trumpLevel) {
    const leadPattern = getCardPattern(leadCards, trumpSuit, trumpLevel);
    const leadIsTrump = isTrump(leadCards[0], trumpSuit, trumpLevel);
    const leadSuit = leadIsTrump ? 'trump' : leadCards[0].suit;
    const leadCount = leadCards.length;

    // 找出同花色/主牌的手牌
    const sameSuitCards = hand.filter(c => {
      if (leadIsTrump) return isTrump(c, trumpSuit, trumpLevel);
      return !isTrump(c, trumpSuit, trumpLevel) && c.suit === leadSuit;
    });

    // 非同花色牌，按牌力排序（弱的优先垫）
    const otherCards = hand.filter(c => !sameSuitCards.includes(c))
      .sort((a, b) => this.cardStrengthValue(a, trumpSuit, trumpLevel) - this.cardStrengthValue(b, trumpSuit, trumpLevel));

    const validPlays = [];

    if (leadCount === 1) {
      // 跟单张
      if (sameSuitCards.length > 0) {
        for (const card of sameSuitCards) {
          validPlays.push([card]);
        }
      } else {
        for (const card of hand) {
          validPlays.push([card]);
        }
      }
    } else {
      // 跟多张（对子/拖拉机/等）
      // 核心规则：有同花色必须出同花色，不够的补其他牌

      if (sameSuitCards.length >= leadCount) {
        // 同花色够数：优先出对子/拖拉机，再出普通组合
        if (leadPattern.type === 'pair') {
          const pairs = this.findPairsInSuit(sameSuitCards, trumpSuit, trumpLevel);
          if (pairs.length > 0) {
            validPlays.push(...pairs);
          }
        }
        // 无论什么类型，都添加同花色前leadCount张作为保底
        validPlays.push(sameSuitCards.slice(0, leadCount));
      } else if (sameSuitCards.length > 0) {
        // 同花色不够：出所有同花色 + 补其他牌
        const play = [...sameSuitCards];
        for (const c of otherCards) {
          if (play.length >= leadCount) break;
          play.push(c);
        }
        validPlays.push(play);
      } else {
        // 没有同花色：垫任意牌
        validPlays.push(hand.slice(0, Math.min(leadCount, hand.length)));
      }
    }

    // 用validatePlay过滤
    const filtered = validPlays.filter(play => {
      const v = validatePlay(hand, play, leadCards, trumpSuit, trumpLevel);
      return v.valid;
    });

    if (filtered.length > 0) return filtered;

    // 如果所有候选都被过滤了，暴力搜索：出同花色 + 补牌的所有组合
    if (leadCount > 1 && sameSuitCards.length > 0 && sameSuitCards.length < leadCount) {
      const fill = otherCards.slice(0, leadCount - sameSuitCards.length);
      validPlays.push([...sameSuitCards, ...fill]);
    }

    // 最后保底
    return [hand.slice(0, Math.min(leadCount, hand.length))];
  }

  static findPairsInSuit(suitCards, trumpSuit, trumpLevel) {
    const pairs = [];
    const map = {};
    for (const card of suitCards) {
      const key = `${card.suit}_${card.rank}`;
      if (!map[key]) map[key] = [];
      map[key].push(card);
    }
    for (const key of Object.keys(map)) {
      if (map[key].length >= 2) {
        pairs.push(map[key].slice(0, 2));
      }
    }
    return pairs;
  }

  static findTractorsInSuit(suitCards, length, trumpSuit, trumpLevel) {
    const tractors = [];
    const pairs = this.findPairsInSuit(suitCards, trumpSuit, trumpLevel);
    if (pairs.length < 2) return tractors;

    // Sort pairs by rank
    pairs.sort((a, b) => {
      return this.cardStrengthValue(a[0], trumpSuit, trumpLevel) -
             this.cardStrengthValue(b[0], trumpSuit, trumpLevel);
    });

    // Try all consecutive pair combinations
    for (let len = pairs.length; len >= 2; len--) {
      for (let start = 0; start <= pairs.length - len; start++) {
        const candidate = [];
        for (let i = start; i < start + len; i++) {
          candidate.push(pairs[i][0], pairs[i][1]);
        }
        if (isTractor(candidate, trumpSuit, trumpLevel)) {
          tractors.push(candidate);
        }
      }
    }

    return tractors;
  }

  static deduplicateCandidates(candidates) {
    const seen = new Set();
    const result = [];
    for (const c of candidates) {
      const key = c.cards.map(card => card.id).sort().join(',');
      if (!seen.has(key)) {
        seen.add(key);
        result.push(c);
      }
    }
    return result;
  }

  static findPairs(hand) {
    const pairs = [];
    const map = {};
    for (const card of hand) {
      const key = `${card.suit}_${card.rank}`;
      if (!map[key]) map[key] = [];
      map[key].push(card);
    }
    for (const key of Object.keys(map)) {
      if (map[key].length >= 2) {
        pairs.push(map[key].slice(0, 2));
      }
    }
    return pairs;
  }

  static cardStrength(a, b, trumpSuit, trumpLevel) {
    return compareCards(a, b, trumpSuit, trumpLevel, a.suit);
  }

  static cardStrengthValue(card, trumpSuit, trumpLevel) {
    if (card.suit === 'joker') return card.rank === 'big' ? 100 : 99;
    if (card.rank === getRankFromLevel(trumpLevel)) {
      if (card.suit === trumpSuit) return 98;
      return 97;
    }
    if (card.suit === trumpSuit) {
      const order = ['3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A', '2'];
      return 50 + order.indexOf(card.rank);
    }
    const order = ['3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A', '2'];
    return order.indexOf(card.rank);
  }

  static canWin(play, leadCards, trumpSuit, trumpLevel) {
    const leadPattern = getCardPattern(leadCards, trumpSuit, trumpLevel);
    const leadSuit = isTrump(leadCards[0], trumpSuit, trumpLevel) ? 'trump' : leadCards[0].suit;
    return isPlayBeating(play, leadCards, leadCards, leadPattern, leadSuit, trumpSuit, trumpLevel);
  }

  static canBeatCurrentWinner(play, currentTrick, trumpSuit, trumpLevel) {
    if (!currentTrick || currentTrick.length === 0) return true;
    const leadCards = currentTrick[0].cards;
    const leadPattern = getCardPattern(leadCards, trumpSuit, trumpLevel);
    const leadSuit = isTrump(leadCards[0], trumpSuit, trumpLevel) ? 'trump' : leadCards[0].suit;
    const winnerIdx = findWinningCard(currentTrick, trumpSuit, trumpLevel, leadSuit);
    const winnerCards = currentTrick[winnerIdx].cards;
    return isPlayBeating(play, winnerCards, leadCards, leadPattern, leadSuit, trumpSuit, trumpLevel);
  }
}

class StrategyEvaluator {
  constructor(seat, team, cardTracker, gameState) {
    this.seat = seat;
    this.team = team;
    this.tracker = cardTracker;
    this.gs = gameState;
    this.trumpSuit = gameState.trumpSuit;
    this.trumpLevel = gameState.trumpLevel;
  }

  evaluate(candidate, leadCards) {
    if (!leadCards || leadCards.length === 0) {
      return this.evaluateLead(candidate);
    }
    return this.evaluateFollow(candidate, leadCards);
  }

  // ---- LEADING STRATEGY ----
  evaluateLead(candidate) {
    const { cards, tag } = candidate;
    let score = 0;

    if (tag === 'tractor') {
      score += 40;
      if (cards.every(c => isTrump(c, this.trumpSuit, this.trumpLevel))) score += 20;
      score += cards.length * 2;
    }

    if (tag === 'pair') {
      const isTrumpPair = cards.every(c => isTrump(c, this.trumpSuit, this.trumpLevel));
      if (isTrumpPair) {
        score += 30;
      } else {
        score += 15;
        if (cards[0].rank === 'A') score += 15;
        else if (cards[0].rank === 'K') score += 10;
      }
    }

    if (tag === 'strong_single') {
      score += 20;
      // Opponent void bonus
      score += this.oppVoidBonus(cards[0].suit);
    }

    if (tag === 'small_single') {
      score += 5;
      const tricksRemaining = this.tricksRemaining();
      if (tricksRemaining <= 3) score -= 10;
    }

    if (tag === 'small_trump') {
      score += 10;
      if (this.countMyTrumps() <= 2) score -= 15;
    }

    if (tag === 'fallback') {
      score -= 5;
    }

    // Suit length bonus: prefer leading your longest suit
    if (cards[0] && cards[0].suit !== 'joker') {
      const suitLen = this.countMyCardsInSuit(cards[0].suit);
      score += suitLen * 2;
    }

    // Score-aware aggression
    score += this.scoreAggressionBonus();

    return score;
  }

  // ---- FOLLOWING STRATEGY ----
  evaluateFollow(candidate, leadCards) {
    const { cards, tag } = candidate;
    let score = 0;

    const currentTrick = this.gs.currentTrick || [];
    const winnerInfo = this.getCurrentTrickWinner(currentTrick);
    const teammateIsWinning = winnerInfo && winnerInfo.team === this.team;
    const iAmWinning = winnerInfo && winnerInfo.seat === this.seat;

    const trickPoints = this.getTrickPoints(currentTrick, cards);
    const wouldWin = currentTrick.length > 0
      ? CandidateGenerator.canBeatCurrentWinner(cards, currentTrick, this.trumpSuit, this.trumpLevel)
      : true;

    if (teammateIsWinning && !iAmWinning) {
      score += this.scoreTeammateWinning(candidate, trickPoints, wouldWin);
    } else if (!teammateIsWinning && !iAmWinning) {
      score += this.scoreOpponentWinning(candidate, trickPoints, wouldWin, leadCards);
    } else {
      // Self winning
      score += this.scoreSelfWinning(candidate, trickPoints, wouldWin);
    }

    // Last trick: kou di prevention
    const tricksRemaining = this.tricksRemaining();
    if (tricksRemaining <= 1) {
      const isDealerTeam = this.team === (this.gs.players[this.gs.dealer]?.team);
      if (!isDealerTeam) {
        // Want to win last trick for bottom points
        if (wouldWin) score += 50;
        if (wouldWin && getCardPattern(cards, this.trumpSuit, this.trumpLevel).type === 'tractor') {
          score += 100;
        }
      } else {
        // Must prevent kou di
        if (!teammateIsWinning && wouldWin) score += 50;
      }
    }

    // Score-aware aggression
    score += this.scoreAggressionBonus();

    return score;
  }

  scoreTeammateWinning(candidate, trickPoints, wouldWin) {
    const { cards, tag } = candidate;
    let score = 0;

    // NEVER overtake teammate
    if (wouldWin) score -= 50;

    // Best: dump point cards to winning teammate
    const hasPoints = cards.some(c => ['5', '10', 'K'].includes(c.rank));
    if (hasPoints && !wouldWin) {
      score += 30;
      const pointValue = cards.reduce((sum, c) => {
        if (c.rank === '10' || c.rank === 'K') return sum + 10;
        if (c.rank === '5') return sum + 5;
        return sum;
      }, 0);
      score += pointValue;
    }

    // Good: play smallest
    if (tag === 'min_follow' || tag === 'min_dump') score += 15;

    // Bad: play big cards
    if (tag === 'max_follow') score -= 30;

    // Very bad: chop when teammate is winning
    if (tag === 'min_chop' || tag === 'max_chop') score -= 40;

    return score;
  }

  scoreOpponentWinning(candidate, trickPoints, wouldWin, leadCards) {
    const { cards, tag } = candidate;
    let score = 0;

    if (wouldWin) {
      score += 25;
      score += trickPoints;

      // Prefer minimum winning play
      if (tag === 'min_win_follow') score += 20;
      else if (tag === 'max_follow' || tag === 'max_chop') score -= 10;

      // Trump chop evaluation
      if (tag === 'min_chop' || tag === 'max_chop') {
        if (trickPoints >= 10) score += 15;
        else if (trickPoints === 0) score -= 20;
        if (tag === 'max_chop') score -= 10;
        if (this.countMyTrumps() <= 2) score -= 15;
      }
    } else {
      // Cannot win: play smallest, save big cards
      if (tag === 'min_follow' || tag === 'min_dump') score += 15;

      // Don't feed points to opponent
      const hasPoints = cards.some(c => ['5', '10', 'K'].includes(c.rank));
      if (hasPoints) score -= 20;

      // Don't waste big cards
      if (tag === 'max_follow') score -= 20;

      // Never waste trump if can't win
      if (tag === 'min_chop' || tag === 'max_chop') score -= 40;
    }

    return score;
  }

  scoreSelfWinning(candidate, trickPoints, wouldWin) {
    const { tag } = candidate;
    let score = 0;

    if (wouldWin) score += 10;
    if (tag === 'min_follow' || tag === 'min_dump') score += 15;
    if (tag === 'max_follow') score -= 15;

    return score;
  }

  // ---- HELPERS ----

  getCurrentTrickWinner(currentTrick) {
    if (!currentTrick || currentTrick.length === 0) return null;
    const leadCards = currentTrick[0].cards;
    const leadSuit = isTrump(leadCards[0], this.trumpSuit, this.trumpLevel) ? 'trump' : leadCards[0].suit;
    const winnerIdx = findWinningCard(currentTrick, this.trumpSuit, this.trumpLevel, leadSuit);
    const winner = currentTrick[winnerIdx];
    const team = this.gs.players[winner.seat]?.team;
    return { seat: winner.seat, team };
  }

  getTrickPoints(currentTrick, myCards) {
    let points = 0;
    for (const play of currentTrick) {
      points += getRoundPoints(play.cards);
    }
    points += getRoundPoints(myCards);
    return points;
  }

  countMyTrumps() {
    return this.hand ? this.hand.filter(c => isTrump(c, this.trumpSuit, this.trumpLevel)).length : 0;
  }

  countMyCardsInSuit(suit) {
    return this.hand ? this.hand.filter(c => c.suit === suit).length : 0;
  }

  tricksRemaining() {
    return Math.min(...this.gs.players.map(p => p.handCount || 0));
  }

  oppVoidBonus(suit) {
    if (!suit || suit === 'joker') return 0;
    const opp1 = (this.seat + 1) % 4;
    const opp2 = (this.seat + 3) % 4;
    const opp1Void = this.tracker.isPlayerVoidInSuit(opp1, suit);
    const opp2Void = this.tracker.isPlayerVoidInSuit(opp2, suit);
    if (opp1Void && opp2Void) return 20;
    if (opp1Void || opp2Void) return 10;
    return 0;
  }

  scoreAggressionBonus() {
    const myTeamScore = this.team === 1 ? (this.gs.scores?.team1 || 0) : (this.gs.scores?.team2 || 0);
    const oppTeamScore = this.team === 1 ? (this.gs.scores?.team2 || 0) : (this.gs.scores?.team1 || 0);
    const isDealerTeam = this.team === (this.gs.players[this.gs.dealer]?.team);

    if (!isDealerTeam) {
      // Idle team needs points
      if (myTeamScore < 40) return 5;
    } else {
      if (oppTeamScore >= 60) return 10;
    }
    return 0;
  }
}

class FallbackAI {
  static selectBestValid(hand, leadCards, gameState) {
    const candidates = CandidateGenerator.generateCandidates(
      hand, leadCards, gameState.trumpSuit, gameState.trumpLevel
    );
    return candidates[0].cards;
  }

  static decideBid(hand, trumpLevel) {
    const levelCards = hand.filter(c => c.rank === getRankFromLevel(trumpLevel));
    if (levelCards.length >= 2) {
      const suitCounts = {};
      for (const c of levelCards) {
        if (!suitCounts[c.suit]) suitCounts[c.suit] = [];
        suitCounts[c.suit].push(c);
      }
      for (const suit of Object.keys(suitCounts)) {
        if (suitCounts[suit].length >= 2) {
          return suitCounts[suit].slice(0, 2);
        }
      }
    }
    return null;
  }

  static decideBottom(hand, bottomCount, trumpSuit, trumpLevel) {
    const sorted = [...hand].sort((a, b) => {
      return CandidateGenerator.cardStrengthValue(a, trumpSuit, trumpLevel) -
             CandidateGenerator.cardStrengthValue(b, trumpSuit, trumpLevel);
    });
    return sorted.slice(0, bottomCount);
  }
}

class SmartAI {
  static selectBestPlay(hand, leadCards, gameState, cardTracker, seat, team) {
    // 使用新的高级AI系统
    const advancedAI = new AdvancedAI(seat, team, cardTracker);
    advancedAI.hand = hand;

    // 尝试高级AI
    try {
      const play = advancedAI.selectBestPlay(hand, leadCards, gameState);
      const validation = validatePlay(hand, play, leadCards, gameState.trumpSuit, gameState.trumpLevel);
      if (validation.valid) {
        return play;
      }
    } catch (e) {
      console.error('AdvancedAI error:', e);
    }

    // 回退到原来的候选生成逻辑
    const candidates = CandidateGenerator.generateCandidates(
      hand, leadCards, gameState.trumpSuit, gameState.trumpLevel
    );

    const evaluator = new StrategyEvaluator(seat, team, cardTracker, gameState);
    evaluator.hand = hand;

    let bestScore = -Infinity;
    let bestPlay = candidates[0].cards;

    for (const candidate of candidates) {
      const score = evaluator.evaluate(candidate, leadCards);
      if (score > bestScore) {
        bestScore = score;
        bestPlay = candidate.cards;
      }
    }

    // Validate
    const validation = validatePlay(hand, bestPlay, leadCards, gameState.trumpSuit, gameState.trumpLevel);
    if (validation.valid) return bestPlay;

    // Try candidates in score order
    const scored = candidates.map(c => ({
      cards: c.cards,
      score: evaluator.evaluate(c, leadCards)
    })).sort((a, b) => b.score - a.score);

    for (const s of scored) {
      const v = validatePlay(hand, s.cards, leadCards, gameState.trumpSuit, gameState.trumpLevel);
      if (v.valid) return s.cards;
    }

    return FallbackAI.selectBestValid(hand, leadCards, gameState);
  }

  static decideBid(hand, trumpLevel) {
    // 使用新的亮主策略
    return decideBid(hand, trumpLevel);
  }

  static decideBottom(hand, bottomCount, trumpSuit, trumpLevel) {
    // 使用新的扣底策略
    return selectBottomCards(hand, bottomCount, trumpSuit, trumpLevel, true);
  }
}

class LLMAIPlayer {
  constructor(seat, playerInfo, llmConfig) {
    this.seat = seat;
    this.userId = playerInfo?.userId || `ai_${seat}`;
    this.nickname = playerInfo?.nickname || `AI玩家${seat + 1}`;
    this.avatar = playerInfo?.avatar || '🤖';
    this.team = seat % 2 === 0 ? 1 : 2;
    this.hand = [];
    this.cardTracker = new CardTracker();
    this.llmClient = llmConfig?.apiKey ? new LLMClient(llmConfig) : null;
    this.useLLM = !!this.llmClient;
  }

  setHand(cards) {
    this.hand = cards;
    this.cardTracker.reset();
  }

  async decideBid(gameState) {
    return SmartAI.decideBid(this.hand, gameState.trumpLevel);
  }

  async decideBottom(gameState) {
    return SmartAI.decideBottom(
      this.hand,
      gameState.bottomCount || 8,
      gameState.trumpSuit,
      gameState.trumpLevel
    );
  }

  async decidePlay(gameState, leadCards) {
    // Update card tracker with trump info
    if (gameState.trumpSuit) {
      this.cardTracker.setTrump(gameState.trumpSuit, gameState.trumpLevel);
    }

    // Record completed tricks
    for (const trick of gameState.tricks || []) {
      this.cardTracker.recordTrick(trick);
    }

    if (!this.useLLM) {
      return SmartAI.selectBestPlay(
        this.hand, leadCards, gameState, this.cardTracker, this.seat, this.team
      );
    }

    try {
      return await this.decideWithLLM(gameState, leadCards);
    } catch (err) {
      console.error('LLM error, using SmartAI:', err);
      return SmartAI.selectBestPlay(
        this.hand, leadCards, gameState, this.cardTracker, this.seat, this.team
      );
    }
  }

  async decideWithLLM(gameState, leadCards) {
    const candidates = CandidateGenerator.generateCandidates(
      this.hand, leadCards, gameState.trumpSuit, gameState.trumpLevel
    );

    const prompt = this.buildPrompt(gameState, candidates, leadCards);

    let attempt = 0;
    let lastError = null;

    while (attempt < 2) {
      try {
        const response = await this.llmClient.complete(prompt);
        const selected = this.parseResponse(response, candidates);

        if (selected) {
          const validation = validatePlay(
            this.hand, selected, leadCards,
            gameState.trumpSuit, gameState.trumpLevel
          );

          if (validation.valid) {
            return selected;
          }
          lastError = validation.reason;
        }
      } catch (e) {
        console.error('LLM attempt error:', e);
      }
      attempt++;
    }

    return candidates[0].cards;
  }

  buildPrompt(gameState, candidates, leadCards) {
    const teamScore = this.team === 1 ? gameState.scores?.team1 : gameState.scores?.team2;
    const oppScore = this.team === 1 ? gameState.scores?.team2 : gameState.scores?.team1;

    return `
你是一个打升级（拖拉机/80分）的高手。请分析当前牌局并选择最佳出牌策略。

【基本信息】
- 牌副数：${gameState.deckCount || 2}副
- 主花色：${gameState.trumpSuit ? SUIT_NAMES[gameState.trumpSuit] : '无主'}
- 主级牌：${gameState.trumpLevel || 2}
- 当前比分：
  - 你的队伍（队${this.team}）：${teamScore || 0}分
  - 对方队伍：${oppScore || 0}分

【已打出的牌记录】
${this.cardTracker.getPlayedSummary()}

【你的手牌】
${this.formatCardsList(this.hand)}

【当前局势】
- 轮次：第${(gameState.tricksCount || 0) + 1}轮
${leadCards ? `- 首家已出：${this.formatCardsList(leadCards)}` : '- 你是首家出牌'}

【候选出牌选项】
${candidates.map((c, i) => `选项${i + 1}：${this.formatCardsList(c.cards)} - ${c.description}`).join('\n')}

请选择一个最佳选项，只返回选项编号（如"选项3"或"3"），不要解释。
`;
  }

  formatCardsList(cards) {
    return cards.map(c => {
      if (c.suit === 'joker') {
        return c.rank === 'big' ? '大王' : '小王';
      }
      return `${SUIT_NAMES[c.suit]}${c.rank}`;
    }).join(', ');
  }

  parseResponse(response, candidates) {
    const match = response.match(/选项\s*(\d+)|(\d+)/);
    if (match) {
      const idx = parseInt(match[1] || match[2]) - 1;
      if (idx >= 0 && idx < candidates.length) {
        return candidates[idx].cards;
      }
    }
    return candidates[0].cards;
  }
}

module.exports = { LLMAIPlayer, FallbackAI, SmartAI, CandidateGenerator, CardTracker, StrategyEvaluator };
