/**
 * 高级AI系统 - 拖拉机游戏
 * 基于专业的拖拉机打牌技巧设计
 */

import {
  Card, Player, Trick, Scores, Levels, CardPattern, ValidationResult,
  validatePlay, getCardPattern, isTrump, compareCards,
  isPlayBeating, findWinningCard, getMaxCard, isTractor,
  groupByRank, getTrumpRank, RANK_ORDER, POINT_CARDS, getRoundPoints,
  getRankFromLevel, TrickPlay
} from './game';

interface Candidate {
  cards: Card[];
  score: number;
  reason: string;
}

interface Analysis {
  myTeam: number;
  myStrength: number;
  myTrumps: number;
  myPairs: number;
  myTractors: number;
  tricksPlayed: number;
  tricksRemaining: number;
  myTeamScore: number;
  oppTeamScore: number;
  isDealer: boolean;
  dealerTeam: number;
  bottomPoints: number;
  trumpSuit: string | null;
  trumpLevel: number;
  bottomCardPoints: number;
  bottomProtection: number;
  trumpCount: number;        // 手牌中主牌数量
  trumpReserve: number;      // 需要保留的主牌数（保底用）
  bottomCapture: boolean;    // 闲家扣底意图
  currentTrick: TrickPlay[];
  leadIsTeammate?: boolean;
  isLastPlayer?: boolean;
  currentChopper?: number | null;
  currentChopperTeam?: number;
  currentChopperTrumps?: Card[];
  winnerIsTeammate?: boolean;
  winnerIsMe?: boolean;
  currentWinnerCards?: Card[];
  trickPoints: number;
  trickPointCards: { seat: number; team: number; card: Card; points: number }[];
  opponentTrickPoints: number;
}

interface CardTracker {
  setTrump(trumpSuit: string | null, trumpLevel: number): void;
  recordTrick(trick: Trick): void;
  isPlayerVoidInSuit(seat: number, suit: string): boolean;
  getRemainingPoints(): number;
  totalPoints: number;
  playedBySuit?: Record<string, Card[]>;
}

const SUIT_NAMES: Record<string, string> = { spade: '黑桃', heart: '红桃', diamond: '方块', club: '梅花', joker: '王牌' };
const SUIT_ORDER: Record<string, number> = { spade: 3, heart: 2, diamond: 1, club: 0 };

// ==================== 牌力评估系统 ====================

/**
 * 评估单张牌的价值
 */
export function evaluateCardValue(card: Card, trumpSuit: string | null, trumpLevel: number): number {
  if (card.suit === 'joker') {
    return card.rank === 'big' ? 100 : 99;
  }

  if (card.rank === getRankFromLevel(trumpLevel)) {
    if (card.suit === trumpSuit) return 98;  // 主级牌
    return 97;  // 副级牌
  }

  if (card.suit === trumpSuit) {
    // 主牌花色
    const base = 50;
    const rankValue = RANK_ORDER[card.rank] || 0;
    return base + rankValue;
  }

  // 副牌
  const rankValue = RANK_ORDER[card.rank] || 0;
  const pointBonus = POINT_CARDS[card.rank] || 0;
  return rankValue + (pointBonus > 0 ? 15 : 0);
}

/**
 * 评估一组牌的价值
 */
export function evaluateCardsValue(cards: Card[], trumpSuit: string | null, trumpLevel: number): number {
  if (!cards || cards.length === 0) return 0;
  return cards.reduce((sum, c) => sum + evaluateCardValue(c, trumpSuit, trumpLevel), 0);
}

/**
 * 评估手牌整体强度
 */
export function evaluateHandStrength(hand: Card[], trumpSuit: string | null, trumpLevel: number): number {
  let strength = 0;

  // 主牌数量
  const trumps = hand.filter(c => isTrump(c, trumpSuit, trumpLevel));
  strength += trumps.length * 8;

  // 大小王
  const bigJokers = hand.filter(c => c.suit === 'joker' && c.rank === 'big');
  const smallJokers = hand.filter(c => c.suit === 'joker' && c.rank === 'small');
  strength += bigJokers.length * 20;
  strength += smallJokers.length * 15;

  // 主级牌
  const trumpLevelCards = hand.filter(c => c.rank === getRankFromLevel(trumpLevel));
  strength += trumpLevelCards.length * 12;

  // 对子
  const pairs = findPairs(hand, trumpSuit, trumpLevel);
  strength += pairs.length * 10;

  // 拖拉机
  const tractors = findTractors(hand, trumpSuit, trumpLevel);
  strength += tractors.length * 25;

  // 大牌（A、K）
  const bigCards = hand.filter(c => c.rank === 'A' || c.rank === 'K');
  strength += bigCards.length * 5;

  return strength;
}

/**
 * 找出手牌中的所有对子
 */
export function findPairs(hand: Card[], trumpSuit?: string | null, trumpLevel?: number): Card[][] {
  const pairs: Card[][] = [];
  const grouped = groupByRank(hand);

  for (const key in grouped) {
    if (grouped[key].length >= 2) {
      pairs.push(grouped[key].slice(0, 2));
    }
  }

  return pairs;
}

/**
 * 找出手牌中的所有三同张/四同张
 */
export function findTriples(hand: Card[], trumpSuit?: string | null, trumpLevel?: number): Card[][] {
  const triples: Card[][] = [];
  const grouped = groupByRank(hand);

  for (const key in grouped) {
    if (grouped[key].length >= 3) {
      triples.push(grouped[key].slice(0, grouped[key].length >= 4 ? 4 : 3));
    }
  }

  return triples;
}

/**
 * 找出手牌中的所有拖拉机
 */
export function findTractors(hand: Card[], trumpSuit: string | null, trumpLevel: number): Card[][] {
  const tractors: Card[][] = [];

  // 对子拖拉机
  const pairs = findPairs(hand, trumpSuit, trumpLevel);
  if (pairs.length >= 2) {
    pairs.sort((a, b) => evaluateCardValue(a[0], trumpSuit, trumpLevel) - evaluateCardValue(b[0], trumpSuit, trumpLevel));
    for (let len = pairs.length; len >= 2; len--) {
      for (let start = 0; start <= pairs.length - len; start++) {
        const candidate: Card[] = [];
        for (let i = start; i < start + len; i++) {
          candidate.push(pairs[i][0], pairs[i][1]);
        }
        if (isTractor(candidate, trumpSuit, trumpLevel)) {
          tractors.push(candidate);
        }
      }
    }
  }

  // 三同张/四同张拖拉机
  const triples = findTriples(hand, trumpSuit, trumpLevel);
  if (triples.length >= 2) {
    triples.sort((a, b) => evaluateCardValue(a[0], trumpSuit, trumpLevel) - evaluateCardValue(b[0], trumpSuit, trumpLevel));
    for (let len = triples.length; len >= 2; len--) {
      for (let start = 0; start <= triples.length - len; start++) {
        const candidate: Card[] = [];
        for (let i = start; i < start + len; i++) {
          candidate.push(...triples[i]);
        }
        if (isTractor(candidate, trumpSuit, trumpLevel)) {
          tractors.push(candidate);
        }
      }
    }
  }

  return tractors;
}

// ==================== 局势分析系统 ====================

/**
 * 分析当前局势
 */
export function analyzeGameState(hand: Card[], gameState: any, seat: number, team: number, cardTracker?: CardTracker): Analysis {
  const analysis: Analysis = {
    myTeam: team,
    myStrength: evaluateHandStrength(hand, gameState.trumpSuit, gameState.trumpLevel),
    myTrumps: hand.filter(c => isTrump(c, gameState.trumpSuit, gameState.trumpLevel)).length,
    myPairs: findPairs(hand, gameState.trumpSuit, gameState.trumpLevel).length,
    myTractors: findTractors(hand, gameState.trumpSuit, gameState.trumpLevel).length,
    tricksPlayed: gameState.tricksCount || 0,
    tricksRemaining: Math.min(...gameState.players.map((p: any) => p.handCount || 0)),
    myTeamScore: team === 1 ? (gameState.scores?.team1 || 0) : (gameState.scores?.team2 || 0),
    oppTeamScore: team === 1 ? (gameState.scores?.team2 || 0) : (gameState.scores?.team1 || 0),
    isDealer: gameState.dealer === seat,
    dealerTeam: gameState.players[gameState.dealer]?.team,
    bottomPoints: cardTracker ? cardTracker.getRemainingPoints() : 0,
    trumpSuit: gameState.trumpSuit,
    trumpLevel: gameState.trumpLevel,
    // 保底相关
    bottomCardPoints: 0,
    bottomProtection: 0,  // 0=无需保护, 1=中等保护, 2=强保护
    trumpCount: 0,
    trumpReserve: 0,
    bottomCapture: false,
    currentTrick: [],
    trickPoints: 0,
    trickPointCards: [],
    opponentTrickPoints: 0
  };

  // 统计手牌中主牌数量
  const ts = gameState.trumpSuit;
  const tl = gameState.trumpLevel;
  analysis.trumpCount = hand.filter(c => isTrump(c, ts, tl)).length;

  // 计算保底保护等级
  const isMyTeamDealer = analysis.myTeam === analysis.dealerTeam;
  const tricksRemaining = analysis.tricksRemaining;
  const isEndgame = tricksRemaining <= 4;

  if (isMyTeamDealer) {
    // 庄家方：可见底牌，计算实际分值
    if (gameState.bottomCards) {
      analysis.bottomCardPoints = gameState.bottomCards.reduce((sum: number, c: Card) => sum + (POINT_CARDS[c.rank] || 0), 0);
    }
    const bp = analysis.bottomCardPoints;
    // 庄家保底：底牌有分时更早触发保护
    if (bp >= 40 && tricksRemaining <= 6) analysis.bottomProtection = 2;
    else if (bp >= 25 && tricksRemaining <= 4) analysis.bottomProtection = 2;
    else if (isEndgame && bp >= 15) analysis.bottomProtection = 1;
    else if (bp >= 40) analysis.bottomProtection = 1;
    // 庄家需要保留的主牌数：底牌分越多，需要保留越多
    analysis.trumpReserve = bp >= 40 ? 3 : (bp >= 25 ? 2 : (bp >= 15 ? 1 : 0));
  } else {
    // 闲家方：根据已出牌估算底牌分值
    const remainingPoints = analysis.bottomPoints;
    const tricksPlayed = analysis.tricksPlayed;
    const totalPoints = (cardTracker ? cardTracker.totalPoints : 200);
    const avgPointsPerTrick = tricksPlayed > 0 ? (totalPoints - remainingPoints) / tricksPlayed : 0;
    const estimatedHandPoints = avgPointsPerTrick * tricksRemaining;
    const estimatedBottomPoints = remainingPoints - estimatedHandPoints;
    if (isEndgame && estimatedBottomPoints >= 25) analysis.bottomProtection = 2;
    else if (isEndgame && estimatedBottomPoints >= 10) analysis.bottomProtection = 1;
    // 闲家扣底意图：最后几墩，有大主牌可以抢底
    if (tricksRemaining <= 3 && analysis.trumpCount >= 2) {
      analysis.bottomCapture = true;
    }
  }

  // 判断是否是队友的回合
  const currentTrick = gameState.currentTrick || [];
  analysis.currentTrick = currentTrick;

  if (currentTrick.length > 0) {
    const leadSeat = currentTrick[0].seat;
    const leadTeam = gameState.players[leadSeat]?.team;
    analysis.leadIsTeammate = leadTeam === team;

    // 判断AI是否最后一个出牌
    const totalPlayers = gameState.players.length;
    analysis.isLastPlayer = currentTrick.length === totalPlayers - 1;

    // 检测场上是否有人将吃
    const leadSuit0 = currentTrick[0].cards[0].suit;
    const leadIsTrump0 = isTrump(currentTrick[0].cards[0], gameState.trumpSuit, gameState.trumpLevel);
    analysis.currentChopper = null; // 将吃者的seat
    for (let i = 1; i < currentTrick.length; i++) {
      const play = currentTrick[i];
      const hasSameSuit = play.cards.some((c: Card) => {
        if (leadIsTrump0) return isTrump(c, gameState.trumpSuit, gameState.trumpLevel);
        return !isTrump(c, gameState.trumpSuit, gameState.trumpLevel) && c.suit === leadSuit0;
      });
      const hasTrump = play.cards.some((c: Card) => isTrump(c, gameState.trumpSuit, gameState.trumpLevel));
      if (!hasSameSuit && hasTrump) {
        analysis.currentChopper = play.seat;
        analysis.currentChopperTeam = gameState.players[play.seat]?.team;
        // 记录将吃者出的主牌（用于比较大小）
        analysis.currentChopperTrumps = play.cards.filter((c: Card) => isTrump(c, gameState.trumpSuit, gameState.trumpLevel));
        break;
      }
    }

    // 判断当前赢家
    const leadSuit = currentTrick[0].cards[0].suit;
    const winnerIdx = findWinningCard(currentTrick, gameState.trumpSuit, gameState.trumpLevel, leadSuit);
    const winnerSeat = currentTrick[winnerIdx].seat;
    const winnerTeam = gameState.players[winnerSeat]?.team;
    analysis.winnerIsTeammate = winnerTeam === team;
    analysis.winnerIsMe = winnerSeat === seat;
    analysis.currentWinnerCards = currentTrick[winnerIdx].cards;

    // 计算场上分牌统计
    let trickPoints = 0;
    const trickPointCards: { seat: number; team: number; card: Card; points: number }[] = [];
    for (const play of currentTrick) {
      for (const card of play.cards) {
        const pts = POINT_CARDS[card.rank] || 0;
        if (pts > 0) {
          trickPoints += pts;
          trickPointCards.push({ seat: play.seat, team: gameState.players[play.seat]?.team, card, points: pts });
        }
      }
    }
    analysis.trickPoints = trickPoints;
    analysis.trickPointCards = trickPointCards;

    // 对手贴的分牌
    analysis.opponentTrickPoints = trickPointCards
      .filter(p => p.team !== team)
      .reduce((sum, p) => sum + p.points, 0);
  } else {
    analysis.trickPoints = 0;
    analysis.trickPointCards = [];
    analysis.opponentTrickPoints = 0;
  }

  return analysis;
}

// ==================== 将吃候选生成系统 ====================

/**
 * 生成将吃候选牌
 */
export function generateChopCandidates(otherCards: Card[], leadCards: Card[], gameState: any, baseScore: number, trickPoints: number, isLastPlayer: boolean, analysis: Analysis): Candidate[] {
  const candidates: Candidate[] = [];
  const trumpSuit = gameState.trumpSuit;
  const trumpLevel = gameState.trumpLevel;

  // 筛选主牌
  const trumpCards = otherCards.filter(c => isTrump(c, trumpSuit, trumpLevel));
  if (trumpCards.length === 0) return candidates;

  const leadPattern = getCardPattern(leadCards, trumpSuit, trumpLevel);
  const chopScore = baseScore + trickPoints * 3;

  // 非末家：有分牌时出最大主牌保护，无分牌时出最小主牌节省
  if (!isLastPlayer) {
    return _generateChopCandidatesMax(trumpCards, leadCards, leadPattern, chopScore, trumpSuit, trumpLevel, candidates, trickPoints);
  }

  // === 末家将吃逻辑 ===

  // 场上有人将吃（上家将吃了）
  if (analysis && analysis.currentChopper !== null) {
    const chopperIsTeammate = analysis.currentChopperTeam === analysis.myTeam;

    if (chopperIsTeammate) {
      // 队友将吃了 → 不需要再管，垫牌即可（不生成将吃候选）
      return candidates;
    }

    // 对手将吃了 → 尝试出更大的主牌将吃
    const biggerChopCandidates = _generateChopCandidatesBiggerThan(
      trumpCards, leadCards, leadPattern, chopScore + 20,
      trumpSuit, trumpLevel, analysis.currentChopperTrumps!
    );
    if (biggerChopCandidates.length > 0) {
      candidates.push(...biggerChopCandidates);
      return candidates;
    }

    // 没有更大的主牌 → 垫最小非分副牌
    const nonTrumpNonPoint = otherCards.filter(c =>
      !isTrump(c, trumpSuit, trumpLevel) && !POINT_CARDS[c.rank]
    );
    if (nonTrumpNonPoint.length > 0) {
      nonTrumpNonPoint.sort((a, b) =>
        evaluateCardValue(a, trumpSuit, trumpLevel) - evaluateCardValue(b, trumpSuit, trumpLevel)
      );
      candidates.push({ cards: [nonTrumpNonPoint[0]], score: 60, reason: '垫最小非分副牌' });
      return candidates;
    }

    // 副牌都是分 → 出最小主牌
    const nonPointTrumps = trumpCards.filter(c => !POINT_CARDS[c.rank]);
    if (nonPointTrumps.length > 0) {
      nonPointTrumps.sort((a, b) =>
        evaluateCardValue(a, trumpSuit, trumpLevel) - evaluateCardValue(b, trumpSuit, trumpLevel)
      );
      candidates.push({ cards: [nonPointTrumps[0]], score: 55, reason: '垫最小非分主牌' });
      return candidates;
    }

    // 主牌都是分 → 出最小主牌
    trumpCards.sort((a, b) =>
      evaluateCardValue(a, trumpSuit, trumpLevel) - evaluateCardValue(b, trumpSuit, trumpLevel)
    );
    candidates.push({ cards: [trumpCards[0]], score: 50, reason: '垫最小主牌' });
    return candidates;
  }

  // 场上无人将吃 → 优先用主分牌将吃，没有主分才用最小主牌
  return _generateChopCandidatesLastPlayer(
    trumpCards, leadCards, leadPattern, chopScore,
    trumpSuit, trumpLevel, candidates
  );
}

/**
 * 非末家将吃：有分牌时出最大主牌保护分数，无分牌时出最小主牌节省实力
 */
function _generateChopCandidatesMax(trumpCards: Card[], leadCards: Card[], leadPattern: CardPattern, chopScore: number, trumpSuit: string | null, trumpLevel: number, candidates: Candidate[], trickPoints: number): Candidate[] {
  const hasPoints = (trickPoints || 0) > 0;
  // 有分牌时出最大（保护分数），无分牌时出最小（节省实力）
  const sortOrder = hasPoints
    ? (a: Card, b: Card) => evaluateCardValue(b, trumpSuit, trumpLevel) - evaluateCardValue(a, trumpSuit, trumpLevel)
    : (a: Card, b: Card) => evaluateCardValue(a, trumpSuit, trumpLevel) - evaluateCardValue(b, trumpSuit, trumpLevel);
  const label = hasPoints ? '(大牌)' : '(小牌)';
  trumpCards.sort(sortOrder);

  if (leadPattern.type === 'single') {
    candidates.push({ cards: [trumpCards[0]], score: chopScore, reason: `单主将吃${label}` });
  } else if (leadPattern.type === 'pair') {
    const trumpPairs = findPairs(trumpCards);
    if (trumpPairs.length > 0) {
      trumpPairs.sort((a, b) =>
        sortOrder(a[0], b[0])
      );
      candidates.push({ cards: trumpPairs[0], score: chopScore, reason: `对主将吃${label}` });
    }
  } else if (leadPattern.type === 'triple') {
    const trumpTriples = findTriples(trumpCards);
    if (trumpTriples.length > 0) {
      trumpTriples.sort((a, b) => sortOrder(a[0], b[0]));
      candidates.push({ cards: trumpTriples[0].slice(0, leadCards.length), score: chopScore, reason: `三同张主将吃${label}` });
    }
    const trumpPairs = findPairs(trumpCards);
    if (trumpPairs.length > 0 && leadCards.length >= 2) {
      trumpPairs.sort((a, b) => sortOrder(a[0], b[0]));
      candidates.push({ cards: trumpPairs[0], score: chopScore - 20, reason: `对主部分将吃${label}` });
    }
  } else if (leadPattern.type === 'tractor') {
    const trumpTractors = findTractors(trumpCards, trumpSuit, trumpLevel);
    const matched = trumpTractors.filter(t => t.length >= leadCards.length);
    if (matched.length > 0) {
      matched.sort((a, b) =>
        sortOrder(a[0], b[0])
      );
      candidates.push({ cards: matched[0].slice(0, leadCards.length), score: chopScore, reason: `拖拉机主将吃${label}` });
    }
    const trumpPairs = findPairs(trumpCards);
    if (trumpPairs.length > 0 && leadCards.length >= 2) {
      trumpPairs.sort((a, b) =>
        sortOrder(a[0], b[0])
      );
      candidates.push({ cards: trumpPairs[0], score: chopScore - 20, reason: `对主部分将吃${label}` });
    }
  } else {
    const playCards = trumpCards.slice(0, leadCards.length);
    if (playCards.length > 0) {
      candidates.push({ cards: playCards, score: chopScore, reason: `主牌将吃${label}` });
    }
  }
  return candidates;
}

/**
 * 末家将吃（无人将吃）：优先主分牌，否则最小主牌
 */
function _generateChopCandidatesLastPlayer(trumpCards: Card[], leadCards: Card[], leadPattern: CardPattern, chopScore: number, trumpSuit: string | null, trumpLevel: number, candidates: Candidate[]): Candidate[] {
  if (leadPattern.type === 'single') {
    // 优先出主分牌将吃
    const trumpPointCards = trumpCards.filter(c => POINT_CARDS[c.rank]);
    if (trumpPointCards.length > 0) {
      trumpPointCards.sort((a, b) =>
        (POINT_CARDS[b.rank] || 0) - (POINT_CARDS[a.rank] || 0)
      );
      candidates.push({ cards: [trumpPointCards[0]], score: chopScore + 5, reason: '主分将吃(末家)' });
    }
    // 没有主分 → 最小主牌
    trumpCards.sort((a, b) =>
      evaluateCardValue(a, trumpSuit, trumpLevel) - evaluateCardValue(b, trumpSuit, trumpLevel)
    );
    candidates.push({ cards: [trumpCards[0]], score: chopScore, reason: '单主将吃(末家)' });
  } else if (leadPattern.type === 'pair') {
    const trumpPairs = findPairs(trumpCards);
    if (trumpPairs.length > 0) {
      // 优先出主分对
      const pointPairs = trumpPairs.filter(p => POINT_CARDS[p[0].rank]);
      if (pointPairs.length > 0) {
        pointPairs.sort((a, b) =>
          (POINT_CARDS[b[0].rank] || 0) - (POINT_CARDS[a[0].rank] || 0)
        );
        candidates.push({ cards: pointPairs[0], score: chopScore + 5, reason: '主分对将吃(末家)' });
      }
      // 没有主分对 → 最小主对
      trumpPairs.sort((a, b) =>
        evaluateCardValue(a[0], trumpSuit, trumpLevel) - evaluateCardValue(b[0], trumpSuit, trumpLevel)
      );
      candidates.push({ cards: trumpPairs[0], score: chopScore, reason: '对主将吃(末家)' });
    }
  } else if (leadPattern.type === 'triple') {
    const trumpTriples = findTriples(trumpCards);
    if (trumpTriples.length > 0) {
      const pointTriples = trumpTriples.filter(t => POINT_CARDS[t[0].rank]);
      if (pointTriples.length > 0) {
        pointTriples.sort((a, b) =>
          (POINT_CARDS[b[0].rank] || 0) - (POINT_CARDS[a[0].rank] || 0)
        );
        candidates.push({ cards: pointTriples[0].slice(0, leadCards.length), score: chopScore + 5, reason: '主分三同张将吃(末家)' });
      }
      trumpTriples.sort((a, b) =>
        evaluateCardValue(a[0], trumpSuit, trumpLevel) - evaluateCardValue(b[0], trumpSuit, trumpLevel)
      );
      candidates.push({ cards: trumpTriples[0].slice(0, leadCards.length), score: chopScore, reason: '三同张主将吃(末家)' });
    }
    const trumpPairs = findPairs(trumpCards);
    if (trumpPairs.length > 0 && leadCards.length >= 2) {
      trumpPairs.sort((a, b) =>
        evaluateCardValue(a[0], trumpSuit, trumpLevel) - evaluateCardValue(b[0], trumpSuit, trumpLevel)
      );
      candidates.push({ cards: trumpPairs[0], score: chopScore - 20, reason: '对主部分将吃(末家)' });
    }
  } else if (leadPattern.type === 'tractor') {
    const trumpTractors = findTractors(trumpCards, trumpSuit, trumpLevel);
    const matched = trumpTractors.filter(t => t.length >= leadCards.length);
    if (matched.length > 0) {
      matched.sort((a, b) =>
        evaluateCardValue(a[0], trumpSuit, trumpLevel) - evaluateCardValue(b[0], trumpSuit, trumpLevel)
      );
      candidates.push({ cards: matched[0].slice(0, leadCards.length), score: chopScore, reason: '拖拉机主将吃(末家)' });
    }
    const trumpPairs = findPairs(trumpCards);
    if (trumpPairs.length > 0 && leadCards.length >= 2) {
      trumpPairs.sort((a, b) =>
        evaluateCardValue(a[0], trumpSuit, trumpLevel) - evaluateCardValue(b[0], trumpSuit, trumpLevel)
      );
      candidates.push({ cards: trumpPairs[0], score: chopScore - 20, reason: '对主部分将吃(末家)' });
    }
  } else {
    // mix类型 → 优先出主分牌
    const trumpPointCards = trumpCards.filter(c => POINT_CARDS[c.rank]);
    const playCards: Card[] = [];
    if (trumpPointCards.length > 0) {
      trumpPointCards.sort((a, b) =>
        (POINT_CARDS[b.rank] || 0) - (POINT_CARDS[a.rank] || 0)
      );
      playCards.push(...trumpPointCards);
    }
    trumpCards.sort((a, b) =>
      evaluateCardValue(a, trumpSuit, trumpLevel) - evaluateCardValue(b, trumpSuit, trumpLevel)
    );
    for (const c of trumpCards) {
      if (!playCards.some(p => p.id === c.id) && playCards.length < leadCards.length) {
        playCards.push(c);
      }
    }
    if (playCards.length > 0) {
      candidates.push({ cards: playCards.slice(0, leadCards.length), score: chopScore, reason: '主牌将吃(末家)' });
    }
  }
  return candidates;
}

/**
 * 生成比上家将吃更大的将吃候选
 */
function _generateChopCandidatesBiggerThan(trumpCards: Card[], leadCards: Card[], leadPattern: CardPattern, chopScore: number, trumpSuit: string | null, trumpLevel: number, chopperTrumps: Card[]): Candidate[] {
  const candidates: Candidate[] = [];

  if (leadPattern.type === 'single') {
    // 找比将吃者最大主牌更大的单主
    const chopperMax = getMaxCard(chopperTrumps, trumpSuit, trumpLevel, 'trump');
    trumpCards.sort((a, b) =>
      evaluateCardValue(a, trumpSuit, trumpLevel) - evaluateCardValue(b, trumpSuit, trumpLevel)
    );
    for (const card of trumpCards) {
      if (compareCards(card, chopperMax, trumpSuit, trumpLevel, 'trump') > 0) {
        candidates.push({ cards: [card], score: chopScore, reason: '超将吃' });
        break; // 出最小的能赢的主牌
      }
    }
  } else if (leadPattern.type === 'pair') {
    const trumpPairs = findPairs(trumpCards);
    const chopperMax = getMaxCard(chopperTrumps, trumpSuit, trumpLevel, 'trump');
    trumpPairs.sort((a, b) =>
      evaluateCardValue(a[0], trumpSuit, trumpLevel) - evaluateCardValue(b[0], trumpSuit, trumpLevel)
    );
    for (const pair of trumpPairs) {
      const pairMax = getMaxCard(pair, trumpSuit, trumpLevel, 'trump');
      if (compareCards(pairMax, chopperMax, trumpSuit, trumpLevel, 'trump') > 0) {
        candidates.push({ cards: pair, score: chopScore, reason: '超对主将吃' });
        break;
      }
    }
  } else if (leadPattern.type === 'triple') {
    const trumpTriples = findTriples(trumpCards);
    const chopperMax = getMaxCard(chopperTrumps, trumpSuit, trumpLevel, 'trump');
    trumpTriples.sort((a, b) =>
      evaluateCardValue(a[0], trumpSuit, trumpLevel) - evaluateCardValue(b[0], trumpSuit, trumpLevel)
    );
    for (const triple of trumpTriples) {
      const tripleMax = getMaxCard(triple, trumpSuit, trumpLevel, 'trump');
      if (compareCards(tripleMax, chopperMax, trumpSuit, trumpLevel, 'trump') > 0) {
        candidates.push({ cards: triple.slice(0, leadCards.length), score: chopScore, reason: '超三同张将吃' });
        break;
      }
    }
  } else if (leadPattern.type === 'tractor') {
    const trumpTractors = findTractors(trumpCards, trumpSuit, trumpLevel);
    const matched = trumpTractors.filter(t => t.length >= leadCards.length);
    const chopperMax = getMaxCard(chopperTrumps, trumpSuit, trumpLevel, 'trump');
    matched.sort((a, b) =>
      evaluateCardValue(a[0], trumpSuit, trumpLevel) - evaluateCardValue(b[0], trumpSuit, trumpLevel)
    );
    for (const tractor of matched) {
      const tractorMax = getMaxCard(tractor, trumpSuit, trumpLevel, 'trump');
      if (compareCards(tractorMax, chopperMax, trumpSuit, trumpLevel, 'trump') > 0) {
        candidates.push({ cards: tractor.slice(0, leadCards.length), score: chopScore, reason: '超拖拉机将吃' });
        break;
      }
    }
  }

  return candidates;
}

// ==================== 策略选择系统 ====================

/**
 * 首家出牌策略
 * 核心原则：先出有把握的副牌大牌，再清主，大王保留保底
 */
export function selectLeadPlay(hand: Card[], gameState: any, seat: number, team: number, cardTracker?: CardTracker): Card[] {
  const analysis = analyzeGameState(hand, gameState, seat, team, cardTracker);
  const candidates: Candidate[] = [];
  const ts = gameState.trumpSuit;
  const tl = gameState.trumpLevel;
  const handCount = hand.length;

  // 手牌数量因子：手牌少时更激进（+5），手牌多时更保守（-5）
  const handFactor = handCount <= 4 ? 5 : (handCount >= 20 ? -5 : 0);

  // 分类手牌
  const trumps = hand.filter(c => isTrump(c, ts, tl));
  const nonTrumps = hand.filter(c => !isTrump(c, ts, tl));

  // 检测对手缺门信息
  const opponents = [0, 1, 2, 3].filter(s => gameState.players[s]?.team !== team);
  const suitVoidInfo: Record<string, number> = {};
  if (cardTracker) {
    for (const suit of ['spade', 'heart', 'diamond', 'club']) {
      const voidOpponents = opponents.filter(s => cardTracker.isPlayerVoidInSuit(s, suit));
      suitVoidInfo[suit] = voidOpponents.length;
    }
  }

  // 检测队友是否无主
  const teammates = [0, 1, 2, 3].filter(s => gameState.players[s]?.team === team && s !== seat);
  const teammateVoidInTrump = cardTracker && teammates.some(s => cardTracker.isPlayerVoidInSuit(s, 'trump'));

  // 辅助函数：评估花色安全性（对手缺门越多越不安全）
  function suitSafetyScore(suit: string): number {
    const voidCount = suitVoidInfo[suit] || 0;
    if (voidCount >= 2) return -30; // 两个对手都缺门，非常危险
    if (voidCount >= 1) return -15; // 一个对手缺门，较危险
    return 0; // 安全
  }

  // 残局清副牌检测：手牌少且有大主牌保底时，优先出副牌
  // 场景：手里有大小王+级牌对+1-2张副牌，应先清副牌，大主牌留到最后赢
  let endgameClearNonTrump = false;
  if (nonTrumps.length > 0 && handCount <= 8) {
    const levelRank = getRankFromLevel(tl);
    const bigJokerCount = trumps.filter(c => c.suit === 'joker' && c.rank === 'big').length;
    const smallJokerCount = trumps.filter(c => c.suit === 'joker' && c.rank === 'small').length;
    const levelCards = trumps.filter(c => c.rank === levelRank);
    const levelPairs = findPairs(levelCards).length;
    // 大主牌数 = 大王 + 小王 + 级牌对（这些都能保底赢最后几墩）
    const guaranteedWinners = bigJokerCount + smallJokerCount + levelPairs * 2;
    if (guaranteedWinners >= nonTrumps.length) {
      endgameClearNonTrump = true;
    }
  }

  // 残局"保大留小"检测：手牌少时，最大的牌留到最后出，先出较小的牌
  // 场景：手里有大王+级牌，应先出级牌再出大王；有大王对，应拆开先出一张再留一张
  let endgameSaveBiggest = false;
  let biggestTrump: Card | null = null;
  if (handCount <= 4 && analysis.bottomProtection >= 1) {
    // 找出手牌中最大的主牌（大王 > 小王 > 级牌对 > 大主牌对）
    const sortedTrumps = [...trumps].sort((a, b) =>
      evaluateCardValue(b, ts, tl) - evaluateCardValue(a, ts, tl)
    );
    if (sortedTrumps.length > 0) {
      biggestTrump = sortedTrumps[0];
      // 如果手牌中有比最大主牌更小的牌（副牌或较小主牌），应先出小牌
      const hasSmallerCard = hand.some(c => c.id !== biggestTrump!.id);
      if (hasSmallerCard) {
        endgameSaveBiggest = true;
      }
    }
  }

  // 1. 副牌A对子（确定大的牌先出）
  const nonTrumpPairs = findPairs(nonTrumps);
  const acePairs = nonTrumpPairs.filter(p => p[0].rank === 'A');
  for (const pair of acePairs) {
    const safety = suitSafetyScore(pair[0].suit);
    candidates.push({ cards: pair, score: 120 + safety + handFactor, reason: safety < -10 ? '出副牌A对(对手缺门)' : '出副牌A对' });
  }

  // 1.5 副牌三同张/四同张（确定大的牌先出）
  const nonTrumpTriples = findTriples(nonTrumps);
  const aceTriples = nonTrumpTriples.filter(t => t[0].rank === 'A');
  for (const triple of aceTriples) {
    const safety = suitSafetyScore(triple[0].suit);
    candidates.push({ cards: triple, score: 125 + safety + handFactor, reason: safety < -10 ? '出副牌A三同张(对手缺门)' : '出副牌A三同张' });
  }

  // 2. 副牌A单张（最大的单张牌，应优先出）
  const aces = nonTrumps.filter(c => c.rank === 'A');
  for (const card of aces) {
    const safety = suitSafetyScore(card.suit);
    candidates.push({ cards: [card], score: 110 + safety + handFactor, reason: safety < -10 ? '出副牌A(对手缺门)' : '出副牌A' });
  }

  // 检查同花色A是否全部已知（在手中或已出过），K才安全
  const suitAcesKnown: Record<string, boolean> = {};
  const deckCount = gameState.deckCount || 2;
  for (const suit of ['spade', 'heart', 'diamond', 'club']) {
    const acesInHand = nonTrumps.filter(c => c.suit === suit && c.rank === 'A').length;
    const playedSuitCards = cardTracker?.playedBySuit?.[suit] || [];
    const acesPlayed = playedSuitCards.filter(c => c.rank === 'A').length;
    // 只有当该花色所有A都已知（手中+已出 = deckCount）时，K才安全
    suitAcesKnown[suit] = (acesInHand + acesPlayed) >= deckCount;
  }

  // 3. 副牌K对子 — 有A保护或A已出过时才能出(确保最大)
  const kingPairs = nonTrumpPairs.filter(p => p[0].rank === 'K');
  for (const pair of kingPairs) {
    const hasAce = suitAcesKnown[pair[0].suit];
    const safety = suitSafetyScore(pair[0].suit);
    candidates.push({ cards: pair, score: (hasAce ? 105 : 50) + safety, reason: hasAce ? '出副牌K对(确保最大)' : '出副牌K对(无A保,不出)' });
  }

  // 4. 副牌K单张 — 有A保护或A已出过时才能出(确保最大)
  // 特殊情况：同花色有A对时，先出K跑分（对手可能只有一张该花色，K先跑10分，A对仍然最大）
  const aceSuitsWithPair = new Set(acePairs.map(p => p[0].suit));
  const kings = nonTrumps.filter(c => c.rank === 'K');
  for (const card of kings) {
    const hasAce = suitAcesKnown[card.suit];
    const safety = suitSafetyScore(card.suit);
    if (aceSuitsWithPair.has(card.suit)) {
      // 同花色有A对：K优先出，评分125（高于A对120），先跑10分
      candidates.push({ cards: [card], score: 125 + safety, reason: '出副牌K(A对保,先跑分)' });
    } else {
      const kScore = endgameClearNonTrump ? 80 : (hasAce ? 100 : 45);
      candidates.push({ cards: [card], score: kScore + safety, reason: endgameClearNonTrump ? '残局先清副牌K' : (hasAce ? '出副牌K(确保最大)' : '出副牌K(无A保,不出)') });
    }
  }

  // 5. 副牌拖拉机
  const nonTrumpTractors = findTractors(nonTrumps, ts, tl);
  if (nonTrumpTractors.length > 0) {
    nonTrumpTractors.sort((a, b) => b.length - a.length);
    const safety = suitSafetyScore(nonTrumpTractors[0][0].suit);
    candidates.push({ cards: nonTrumpTractors[0], score: 95 + safety, reason: '出副牌拖拉机' });
  }

  // 6. 其他副牌对子（非A非K）
  const otherPairs = nonTrumpPairs.filter(p => p[0].rank !== 'A' && p[0].rank !== 'K');
  otherPairs.sort((a, b) => RANK_ORDER[b[0].rank] - RANK_ORDER[a[0].rank]);

  // 6.5 检测副牌分对(10/5)在对手全部缺门的花色
  // 战术：先清主对消耗对手主对，再安全出分对
  const scoringRanks = new Set(['10', '5']);
  const hasScoringPairInVoidSuit = otherPairs.some(p =>
    scoringRanks.has(p[0].rank) && (suitVoidInfo[p[0].suit] || 0) >= opponents.length
  );

  // 检查对手是否可能还有主对：计算已出主牌中的对子数
  let opponentsLikelyHaveTrumpPairs = true;
  if (cardTracker && hasScoringPairInVoidSuit) {
    const allPlayedTrumps: Card[] = [];
    // 收集所有已出的主牌（王牌+主花色牌）
    for (const c of (cardTracker.playedBySuit?.joker || [])) {
      if (isTrump(c, ts, tl)) allPlayedTrumps.push(c);
    }
    if (ts !== 'joker') {
      for (const c of (cardTracker.playedBySuit?.[ts] || [])) {
        if (isTrump(c, ts, tl)) allPlayedTrumps.push(c);
      }
    }
    const playedTrumpPairs = findPairs(allPlayedTrumps);
    // 每副牌有约8种主牌rank可组成对（大王/小王/级牌/主2/A/K/Q/J等）
    // 对手有2人，如果已出主对数 >= 4，认为对手主对基本耗尽
    if (playedTrumpPairs.length >= 4) {
      opponentsLikelyHaveTrumpPairs = false;
    }
  }

  // 检查自己是否有主对可清
  const myTrumpPairs = findPairs(trumps).filter(p => !p.some(c => c.suit === 'joker' && c.rank === 'big'));

  for (const pair of otherPairs.slice(0, 2)) {
    const safety = suitSafetyScore(pair[0].suit);
    const isScoringInVoid = scoringRanks.has(pair[0].rank) && (suitVoidInfo[pair[0].suit] || 0) >= opponents.length;
    if (isScoringInVoid) {
      // 分对在对手全部缺门的花色：对手无法跟牌，但可能将吃
      // 如果对手可能还有主对，且自己有主对可清 → 先清主对（评分低，等主对清完再出）
      // 如果自己没有主对可清 → 直接出分对（无法主动清主）
      const shouldWait = opponentsLikelyHaveTrumpPairs && myTrumpPairs.length > 0;
      const score = shouldWait ? 60 : 115;
      candidates.push({ cards: pair, score: score, reason: shouldWait ? '分对等主对清完再出' : '出分对(对手缺门,安全)' });
    } else {
      candidates.push({ cards: pair, score: 75 + safety, reason: '出副牌对子' });
    }
  }

  // 6.6 其他副牌三同张（非A非K）
  const otherTriples = nonTrumpTriples.filter(t => t[0].rank !== 'A' && t[0].rank !== 'K');
  otherTriples.sort((a, b) => RANK_ORDER[b[0].rank] - RANK_ORDER[a[0].rank]);
  for (const triple of otherTriples.slice(0, 2)) {
    const safety = suitSafetyScore(triple[0].suit);
    candidates.push({ cards: triple, score: 80 + safety, reason: '出副牌三同张' });
  }

  // 7. 长套副牌甩牌
  const suitCounts: Record<string, number> = {};
  for (const c of nonTrumps) {
    suitCounts[c.suit] = (suitCounts[c.suit] || 0) + 1;
  }
  for (const suit in suitCounts) {
    if (suitCounts[suit] >= 4) {
      const suitCards = nonTrumps.filter(c => c.suit === suit);
      const maxCard = getMaxCard(suitCards, ts, tl, suit);
      if (maxCard.rank === 'A' || maxCard.rank === 'K') {
        candidates.push({ cards: suitCards.slice(0, 4), score: 80, reason: '甩长套副牌' });
      }
    }
  }

  // 8. 副牌非分牌（Q,J,9,8,7,6,4,3）— 没有战略意义的裸牌，优先级低于清主
  const safeNonTrumps = nonTrumps.filter(c => !POINT_CARDS[c.rank] && c.rank !== 'A');
  safeNonTrumps.sort((a, b) => RANK_ORDER[b.rank] - RANK_ORDER[a.rank]);
  if (safeNonTrumps.length > 0) {
    const safeScore = endgameClearNonTrump ? 80 : 55;
    candidates.push({ cards: [safeNonTrumps[0]], score: safeScore, reason: endgameClearNonTrump ? '残局先清副牌' : '出副牌(非分)' });
  }

  // 9. 副牌分牌（10,5）— 没有A保护时不安全，评分低
  const pointNonTrumps = nonTrumps.filter(c => POINT_CARDS[c.rank] && c.rank !== 'K');
  for (const card of pointNonTrumps) {
    const hasAce = suitAcesKnown[card.suit];
    const safety = suitSafetyScore(card.suit);
    const baseScore = hasAce ? 55 : 35;
    const pointScore = endgameClearNonTrump ? 80 : baseScore;
    candidates.push({ cards: [card], score: pointScore + safety, reason: endgameClearNonTrump ? '残局先清副牌' : (hasAce ? `出副牌${card.rank}(有A保)` : `出副牌${card.rank}(无A保,不出)`) });
  }

  // 9. 小主牌清主（排除大王和小王）— 清主比出无意义的裸副牌更重要
  const isMyTeamDealer2 = analysis.myTeam === analysis.dealerTeam;
  const smallTrumps = trumps.filter(c => !(c.suit === 'joker' && c.rank === 'big') && !(c.suit === 'joker' && c.rank === 'small'));
  if (smallTrumps.length > 0) {
    smallTrumps.sort((a, b) => evaluateCardValue(a, ts, tl) - evaluateCardValue(b, ts, tl));
    // 队友无主时，出小主牌等于1v2，对手可以用K/10跑分
    // 只出A/大牌，不出小于K的主牌
    if (teammateVoidInTrump) {
      // K/A/2/级牌可以出，小于K的普通主牌不出
      const levelRank = getRankFromLevel(tl);
      const bigTrumps = smallTrumps.filter(c =>
        c.rank === 'A' ||
        RANK_ORDER[c.rank] >= RANK_ORDER['K'] ||
        c.rank === levelRank // 级牌（如打10时，10是级牌，非常大）
      );
      if (bigTrumps.length > 0) {
        // 出最小的大主牌（K优先，不浪费A/级牌）
        bigTrumps.sort((a, b) => evaluateCardValue(a, ts, tl) - evaluateCardValue(b, ts, tl));
        candidates.push({ cards: [bigTrumps[0]], score: 70, reason: '队友无主,出大主清主' });
      }
      // 不出小主牌
    } else {
      let trumpClearScore = 70;
      if (isMyTeamDealer2) {
        // 庄家保底：主牌数量接近保留线时，大幅降低出主意愿
        if (analysis.bottomProtection >= 2 && analysis.trumpCount <= analysis.trumpReserve + 2) {
          trumpClearScore = 10; // 几乎不出主，保留主牌保底
        } else if (analysis.bottomProtection >= 2) {
          trumpClearScore = 20; // 强保护但主牌多：降低出单主意愿，优先出副牌
        } else if (analysis.bottomProtection >= 1 && analysis.trumpCount <= analysis.trumpReserve + 1) {
          trumpClearScore = 25;
        }
      } else {
        // 闲家方有强保底需求时，降低小主牌出牌意愿（保留大牌抢底）
        if (analysis.bottomProtection >= 2) {
          trumpClearScore = 35;
        }
      }
      candidates.push({ cards: [smallTrumps[0]], score: trumpClearScore, reason: '出小主牌清主' });
    }
  }

  // 9.5 小王
  const bigJokers = hand.filter(c => c.suit === 'joker' && c.rank === 'big');
  const smallJokers = trumps.filter(c => c.suit === 'joker' && c.rank === 'small');
  if (smallJokers.length > 0) {
    let smallJokerScore = 70;
    if (analysis.bottomProtection >= 2) {
      // 残局保大留小：有大王时，小王应该先出（大王留最后）
      if (endgameSaveBiggest && bigJokers.length > 0 && handCount <= 4) {
        smallJokerScore = 55; // 有大王时，小王优先出
      } else {
        smallJokerScore = isMyTeamDealer2 ? 20 : 35;
      }
    } else if (analysis.bottomProtection >= 1) {
      smallJokerScore = isMyTeamDealer2 ? 40 : 45;
    }
    // 闲家扣底：最后几墩提升小王出牌意愿
    if (!isMyTeamDealer2 && analysis.bottomCapture) {
      smallJokerScore = Math.max(smallJokerScore, 65);
    }
    candidates.push({ cards: [smallJokers[0]], score: smallJokerScore, reason: analysis.bottomProtection > 0 ? '小王保底' : '出小王清主' });
  }

  // 9.6 主牌拖拉机（排除包含大王的）— 拖拉机比对子清主更高效
  const trumpTractors = findTractors(trumps, ts, tl).filter(t => !t.some(c => c.suit === 'joker' && c.rank === 'big'));
  if (trumpTractors.length > 0) {
    trumpTractors.sort((a, b) => b.length - a.length);
    let trumpTractorScore: number;
    if (isMyTeamDealer2) {
      // 庄家：适度出拖拉机清主，但保留部分主牌
      if (analysis.bottomProtection >= 2 && analysis.trumpCount <= analysis.trumpReserve + 3) {
        trumpTractorScore = 10; // 强保护且主牌少：不出拖拉机
      } else if (analysis.bottomProtection >= 2) {
        trumpTractorScore = 15; // 强保护但主牌多：也尽量不出
      } else if (analysis.bottomProtection >= 1) {
        trumpTractorScore = 45;
      } else {
        trumpTractorScore = 75; // 无保护：拖拉机清主高效
      }
    } else {
      // 闲家：保留拖拉机到最后扣底
      if (analysis.bottomCapture) {
        trumpTractorScore = 95; // 扣底：拖拉机优先级最高
      } else {
        trumpTractorScore = 15; // 非残局：保留拖拉机
      }
    }
    candidates.push({ cards: trumpTractors[0], score: trumpTractorScore, reason: analysis.bottomCapture && !isMyTeamDealer2 ? '扣底：出主牌拖拉机' : '出主牌拖拉机' });
  }

  // 10. 主牌对子（排除包含大王的，排除已组成拖拉机的）— 对子比单张清主更高效
  const trumpPairs = findPairs(trumps).filter(p => !p.some(c => c.suit === 'joker' && c.rank === 'big'));
  for (const pair of trumpPairs) {
    const val = evaluateCardValue(pair[0], ts, tl);
    let trumpPairScore: number;
    let trumpPairReason = '出主牌对子';

    if (isMyTeamDealer2) {
      // 庄家：适度出对清主，但保留至少1-2对防副牌对
      if (analysis.bottomProtection >= 2 && analysis.trumpCount <= analysis.trumpReserve + 3) {
        trumpPairScore = 10; // 强保护且主牌少：不出对
      } else if (analysis.bottomProtection >= 2) {
        trumpPairScore = 15; // 强保护但主牌多：也尽量不出
      } else if (analysis.bottomProtection >= 1) {
        trumpPairScore = 40; // 中等保护：降低出对意愿
      } else {
        trumpPairScore = 55; // 无保护：适度清主对，保留部分防副对
      }
    } else {
      // 闲家：保留对牌到最后用于扣底
      if (analysis.bottomCapture) {
        // 最后几墩：对牌积极出，抢赢扣底
        trumpPairScore = val >= 90 ? 90 : 85;
        trumpPairReason = '扣底：出主对抢赢';
      } else {
        // 非残局：保留对牌，不出
        trumpPairScore = 15;
      }
    }

    // 有分对在对手缺门花色时，提升主对优先级（先清主对，保护分对）
    if (hasScoringPairInVoidSuit && opponentsLikelyHaveTrumpPairs) {
      trumpPairScore = Math.max(trumpPairScore, 100);
    }
    candidates.push({ cards: pair, score: trumpPairScore, reason: trumpPairReason });
  }

  // 11. 大王对 — 庄家保留保底，闲家扣底时出
  if (bigJokers.length >= 2) {
    let bigJokerPairScore: number;
    if (isMyTeamDealer2) {
      // 庄家：大王对是保底核心
      // 残局需要保底时，大王对应该出（双倍底分），但不要太早出
      if (endgameSaveBiggest && handCount <= 4) {
        // 残局手牌少：大王对出牌抢赢（双倍底分），但只在最后几墩出
        bigJokerPairScore = analysis.bottomProtection >= 2 ? 85 : 60;
      } else if (analysis.bottomProtection >= 2 && handCount <= 6) {
        // 残局但手牌稍多：大王对出牌抢赢
        bigJokerPairScore = 75;
      } else if (analysis.bottomProtection >= 2) {
        bigJokerPairScore = 10; // 早期：保留大王对
      } else {
        bigJokerPairScore = 15;
      }
    } else {
      // 闲家：保留大王对到最后扣底
      bigJokerPairScore = analysis.bottomCapture ? 95 : 10;
    }
    candidates.push({ cards: bigJokers.slice(0, 2), score: bigJokerPairScore, reason: isMyTeamDealer2 && analysis.bottomProtection > 0 ? '大王对保底保留' : '出大王对' });
  }

  // 12. 大王单张 — 庄家保留保底，闲家出牌抢底
  if (bigJokers.length > 0) {
    let bigJokerScore = 20;
    if (isMyTeamDealer2) {
      // 庄家：大王是保底核心，底牌有分时坚决保留
      if (analysis.bottomProtection >= 2) {
        // 残局保大留小：如果手牌有更小的牌，先出小牌，大王留最后
        if (endgameSaveBiggest && handCount <= 3) {
          bigJokerScore = 2; // 极低分：绝不先出大王，留到最后
        } else if (handCount <= 4) {
          bigJokerScore = 10; // 残局但还有其他牌：尽量保留
        } else {
          bigJokerScore = 5; // 早期：绝不出大王
        }
      } else if (analysis.bottomProtection >= 1) {
        bigJokerScore = 15; // 中等保护：尽量保留
      }
    } else {
      // 闲家：大王出牌抢赢，为扣底做准备
      if (analysis.bottomProtection >= 2) {
        bigJokerScore = 85; // 强扣底：大王出牌抢赢
      } else if (analysis.bottomProtection >= 1) {
        bigJokerScore = 55;
      }
      if (analysis.bottomCapture) {
        bigJokerScore = Math.max(bigJokerScore, 80);
      }
    }
    candidates.push({ cards: [bigJokers[0]], score: bigJokerScore, reason: isMyTeamDealer2 && analysis.bottomProtection > 0 ? '大王保底保留' : '大王出牌' });
  }

  // 选择最佳候选
  candidates.sort((a, b) => b.score - a.score);

  for (const candidate of candidates) {
    const validation = validatePlay(hand, candidate.cards, null, ts, tl);
    if (validation.valid) {
      return candidate.cards;
    }
  }

  const sortedHand = [...hand].sort((a, b) =>
    evaluateCardValue(a, ts, tl) - evaluateCardValue(b, ts, tl)
  );
  return [sortedHand[0]];
}

/**
 * 从手牌中找出所有对子（同rank同花色的两张牌）
 */
function findPairsSimple(cards: Card[]): Card[][] {
  const groups: Record<string, Card[]> = {};
  for (const c of cards) {
    const key = `${c.suit}_${c.rank}`;
    if (!groups[key]) groups[key] = [];
    groups[key].push(c);
  }
  const pairs: Card[][] = [];
  for (const key in groups) {
    if (groups[key].length >= 2) {
      pairs.push([groups[key][0], groups[key][1]]);
    }
  }
  return pairs;
}

/**
 * 从手牌中找出所有三同张/四同张
 */
function findTriplesSimple(cards: Card[]): Card[][] {
  const groups: Record<string, Card[]> = {};
  for (const c of cards) {
    const key = `${c.suit}_${c.rank}`;
    if (!groups[key]) groups[key] = [];
    groups[key].push(c);
  }
  const triples: Card[][] = [];
  for (const key in groups) {
    if (groups[key].length >= 3) {
      triples.push(groups[key].slice(0, groups[key].length >= 4 ? 4 : 3));
    }
  }
  return triples;
}

/**
 * 从手牌中找出拖拉机（同花色连续等量组）
 */
function findTractorsSimple(cards: Card[], trumpSuit: string | null, trumpLevel: number): Card[][] {
  const tractors: Card[][] = [];

  // 对子拖拉机
  const pairs = findPairsSimple(cards);
  if (pairs.length >= 2) {
    const suitGroups: Record<string, Card[][]> = {};
    for (const pair of pairs) {
      const suit = pair[0].suit;
      if (!suitGroups[suit]) suitGroups[suit] = [];
      suitGroups[suit].push(pair);
    }
    for (const suit in suitGroups) {
      const suitPairs = suitGroups[suit];
      if (suitPairs.length < 2) continue;
      suitPairs.sort((a, b) => RANK_ORDER[a[0].rank] - RANK_ORDER[b[0].rank]);
      let current: Card[][] = [suitPairs[0]];
      for (let i = 1; i < suitPairs.length; i++) {
        const prevRank = RANK_ORDER[current[current.length - 1][0].rank];
        const currRank = RANK_ORDER[suitPairs[i][0].rank];
        if (currRank - prevRank === 1) {
          current.push(suitPairs[i]);
        } else {
          if (current.length >= 2) tractors.push(current.flat());
          current = [suitPairs[i]];
        }
      }
      if (current.length >= 2) tractors.push(current.flat());
    }
  }

  // 三同张/四同张拖拉机
  const triples = findTriplesSimple(cards);
  if (triples.length >= 2) {
    const suitGroups: Record<string, Card[][]> = {};
    for (const triple of triples) {
      const suit = triple[0].suit;
      if (!suitGroups[suit]) suitGroups[suit] = [];
      suitGroups[suit].push(triple);
    }
    for (const suit in suitGroups) {
      const suitTriples = suitGroups[suit];
      if (suitTriples.length < 2) continue;
      suitTriples.sort((a, b) => RANK_ORDER[a[0].rank] - RANK_ORDER[b[0].rank]);
      let current: Card[][] = [suitTriples[0]];
      for (let i = 1; i < suitTriples.length; i++) {
        const prevRank = RANK_ORDER[current[current.length - 1][0].rank];
        const currRank = RANK_ORDER[suitTriples[i][0].rank];
        if (currRank - prevRank === 1) {
          current.push(suitTriples[i]);
        } else {
          if (current.length >= 2) tractors.push(current.flat());
          current = [suitTriples[i]];
        }
      }
      if (current.length >= 2) tractors.push(current.flat());
    }
  }

  return tractors;
}

/**
 * 确保跟牌数量与首家出牌数量一致
 */
function ensureCorrectPlayCount(cards: Card[], hand: Card[], leadCards: Card[], trumpSuit: string | null, trumpLevel: number): Card[] {
  if (!leadCards || leadCards.length <= 1 || cards.length === leadCards.length) {
    return cards;
  }

  const leadCount = leadCards.length;
  const leadIsTrump = isTrump(leadCards[0], trumpSuit, trumpLevel);
  const leadSuit = leadCards[0].suit;
  const leadPattern = getCardPattern(leadCards, trumpSuit, trumpLevel);
  const playedIds = new Set(cards.map(c => c.id));

  // 剩余手牌
  const remaining = hand.filter(c => !playedIds.has(c.id));

  // 同花色剩余牌（优先跟同花色）
  const sameSuitRemaining = remaining.filter(c => {
    if (leadIsTrump) return isTrump(c, trumpSuit, trumpLevel);
    return !isTrump(c, trumpSuit, trumpLevel) && c.suit === leadSuit;
  });

  // 其他牌：分非主牌和主牌，优先用非主牌
  const otherNonTrump = remaining.filter(c =>
    !sameSuitRemaining.some(s => s.id === c.id) && !isTrump(c, trumpSuit, trumpLevel)
  );
  const otherTrump = remaining.filter(c =>
    !sameSuitRemaining.some(s => s.id === c.id) && isTrump(c, trumpSuit, trumpLevel)
  );

  // 按牌力排序（弱的优先）
  sameSuitRemaining.sort((a, b) =>
    evaluateCardValue(a, trumpSuit, trumpLevel) -
    evaluateCardValue(b, trumpSuit, trumpLevel)
  );
  otherNonTrump.sort((a, b) =>
    evaluateCardValue(a, trumpSuit, trumpLevel) -
    evaluateCardValue(b, trumpSuit, trumpLevel)
  );
  otherTrump.sort((a, b) =>
    evaluateCardValue(a, trumpSuit, trumpLevel) -
    evaluateCardValue(b, trumpSuit, trumpLevel)
  );

  // 如果首家出对牌/三同张/拖拉机，优先用同花色同类型牌补齐
  if ((leadPattern.type === 'pair' || leadPattern.type === 'triple' || leadPattern.type === 'tractor') && cards.length < leadCount) {
    const result = [...cards];
    // 按rank分组找对子
    const groups: Record<string, Card[]> = {};
    for (const c of sameSuitRemaining) {
      if (!groups[c.rank]) groups[c.rank] = [];
      groups[c.rank].push(c);
    }
    // 优先找和已出牌同rank的对子（保持同rank对牌）
    const playedRanks: Record<string, number> = {};
    for (const c of cards) {
      if (!playedRanks[c.rank]) playedRanks[c.rank] = 0;
      playedRanks[c.rank]++;
    }
    for (const rank in playedRanks) {
      if (playedRanks[rank] === 1 && groups[rank] && groups[rank].length >= 1) {
        result.push(groups[rank][0]);
        if (result.length >= leadCount) return result;
      }
    }
    // 找任意对子补齐
    for (const rank in groups) {
      if (groups[rank].length >= 2) {
        for (let i = 0; i < groups[rank].length && result.length < leadCount; i++) {
          result.push(groups[rank][i]);
        }
        if (result.length >= leadCount) return result;
      }
    }
    // 找不到对子，用同花色牌补齐（降级为mix，但至少跟了花色）
    for (const c of sameSuitRemaining) {
      if (result.length >= leadCount) break;
      result.push(c);
    }
    if (result.length >= leadCount) return result;
  }

  const result = [...cards];
  // 先补同花色，再补非主牌，最后补主牌
  for (const c of [...sameSuitRemaining, ...otherNonTrump, ...otherTrump]) {
    if (result.length >= leadCount) break;
    result.push(c);
  }

  return result;
}

/**
 * 跟牌策略 - 核心改进
 */
export function selectFollowPlay(hand: Card[], leadCards: Card[], gameState: any, seat: number, team: number, cardTracker?: CardTracker): Card[] {
  const analysis = analyzeGameState(hand, gameState, seat, team, cardTracker);
  const leadPattern = getCardPattern(leadCards, gameState.trumpSuit, gameState.trumpLevel);
  const leadIsTrump = isTrump(leadCards[0], gameState.trumpSuit, gameState.trumpLevel);
  const leadSuit = leadIsTrump ? 'trump' : leadCards[0].suit;
  const leadCount = leadCards.length;

  // 找出可以跟的牌
  const sameSuitCards = hand.filter(c => {
    if (leadIsTrump) return isTrump(c, gameState.trumpSuit, gameState.trumpLevel);
    return !isTrump(c, gameState.trumpSuit, gameState.trumpLevel) && c.suit === leadSuit;
  });

  // 找出其他牌
  const otherCards = hand.filter(c => !sameSuitCards.includes(c));

  let play: Card[];

  // ============= 核心策略：根据对手/队友出牌调整 =============

  if (analysis.leadIsTeammate && analysis.winnerIsTeammate) {
    // 情况1：队友出牌且队友正在赢
    // 策略：跟最小的牌，带上分牌（让队友得分）
    play = selectTeammateWinningPlay(hand, leadCards, sameSuitCards, otherCards, gameState, analysis, seat, cardTracker);
  } else if (analysis.leadIsTeammate && !analysis.winnerIsTeammate) {
    // 情况2：队友出牌但对手在赢
    // 策略：如果能管住对手就出大牌，否则跟最小的
    play = selectTeammateLosingPlay(hand, leadCards, sameSuitCards, otherCards, gameState, analysis, cardTracker);
  } else if (!analysis.leadIsTeammate && analysis.winnerIsTeammate) {
    // 情况3：对手出牌但队友在赢
    // 策略：跟最小的牌，不要破坏队友的优势
    play = selectOpponentLeadingButTeammateWinningPlay(hand, leadCards, sameSuitCards, otherCards, gameState, analysis);
  } else if (!analysis.leadIsTeammate && !analysis.winnerIsTeammate) {
    // 情况4：对手出牌且对手在赢
    // 策略：如果能管住就出大牌，否则跟最小的
    play = selectOpponentWinningPlay(hand, leadCards, sameSuitCards, otherCards, gameState, analysis, cardTracker);
  } else {
    // 默认策略
    play = selectDefaultFollowPlay(hand, leadCards, sameSuitCards, otherCards, gameState, analysis);
  }

  // 确保出牌数量与首家一致
  return ensureCorrectPlayCount(play, hand, leadCards, gameState.trumpSuit, gameState.trumpLevel);
}

/**
 * 计算末家对手在某花色可能持有的最高分牌（K/10/5）
 * 按K→10→5优先级检查，返回需要覆盖的最小目标牌
 * 如果末家不可能有任何分牌，返回null
 */
function findMinCardToCoverPoints(
  leadSuit: string,
  hand: Card[],
  currentTrick: TrickPlay[],
  cardTracker: CardTracker | undefined,
  gameState: any
): Card | null {
  if (!cardTracker || !cardTracker.playedBySuit) return null;

  const deckCount = gameState.deckCount || 2;
  const trumpSuit = gameState.trumpSuit;
  const trumpLevel = gameState.trumpLevel;
  const levelRank = getRankFromLevel(trumpLevel);

  // 收集该花色所有可能的牌
  const allPossibleCards: { suit: string; rank: string }[] = [];
  if (leadSuit === 'trump') {
    for (let d = 0; d < deckCount; d++) {
      allPossibleCards.push({ suit: 'joker', rank: 'small' });
      allPossibleCards.push({ suit: 'joker', rank: 'big' });
      allPossibleCards.push({ suit: 'spade', rank: '2' });
      allPossibleCards.push({ suit: 'heart', rank: '2' });
      allPossibleCards.push({ suit: 'diamond', rank: '2' });
      allPossibleCards.push({ suit: 'club', rank: '2' });
      allPossibleCards.push({ suit: 'spade', rank: levelRank });
      allPossibleCards.push({ suit: 'heart', rank: levelRank });
      allPossibleCards.push({ suit: 'diamond', rank: levelRank });
      allPossibleCards.push({ suit: 'club', rank: levelRank });
      if (trumpSuit) {
        for (const rank of ['3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A']) {
          if (rank === levelRank) continue;
          allPossibleCards.push({ suit: trumpSuit, rank });
        }
      }
    }
  } else {
    for (let d = 0; d < deckCount; d++) {
      for (const rank of ['3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A', '2']) {
        allPossibleCards.push({ suit: leadSuit, rank });
      }
    }
  }

  // 排除已出牌、手中牌、当前墩已出牌
  const playedCards = cardTracker.playedBySuit?.[leadSuit] || [];
  const playedJokers = cardTracker.playedBySuit?.joker || [];
  const played = leadSuit === 'trump' ? [...playedCards, ...playedJokers] : playedCards;
  const currentTrickCards = currentTrick.flatMap(p => p.cards);

  const remaining = allPossibleCards.filter(c => {
    if (hand.some(h => h.suit === c.suit && h.rank === c.rank)) return false;
    if (currentTrickCards.some(t => t.suit === c.suit && t.rank === c.rank)) return false;
    if (played.some(p => p.suit === c.suit && p.rank === c.rank)) return false;
    return true;
  });

  // 按K→10→5优先级检查末家是否有分牌，返回需要覆盖的目标
  const pointRanks = ['K', '10', '5'];
  for (const rank of pointRanks) {
    if (remaining.some(c => c.rank === rank)) {
      return { suit: leadSuit === 'trump' ? (trumpSuit || 'spade') : leadSuit, rank } as Card;
    }
  }
  return null;
}

/**
 * 从手牌中找到能盖过指定牌的最小牌
 */
function findSmallestCardToBeat(target: Card, hand: Card[], trumpSuit: string | null, trumpLevel: number, leadSuit: string): Card | null {
  const beating = hand.filter(c =>
    compareCards(c, target, trumpSuit, trumpLevel, leadSuit) > 0
  );
  if (beating.length === 0) return null;
  beating.sort((a, b) =>
    compareCards(a, b, trumpSuit, trumpLevel, leadSuit)
  );
  return beating[0];
}

/**
 * 情况1：队友出牌且队友正在赢
 * 策略：跟最小的牌，带上分牌
 */
function selectTeammateWinningPlay(hand: Card[], leadCards: Card[], sameSuitCards: Card[], otherCards: Card[], gameState: any, analysis: Analysis, seat: number, cardTracker?: CardTracker): Card[] {
  const candidates: Candidate[] = [];
  const leadPattern = getCardPattern(leadCards, gameState.trumpSuit, gameState.trumpLevel);

  // 最后一个出牌且队友确定最大
  if (analysis.isLastPlayer && analysis.winnerIsTeammate) {
    const hasSameSuit = sameSuitCards.length > 0;

    // 1. 贴同花色分牌
    const sameSuitPoints = sameSuitCards.filter(c => POINT_CARDS[c.rank]);
    if (sameSuitPoints.length > 0) {
      sameSuitPoints.sort((a, b) =>
        (POINT_CARDS[b.rank] || 0) - (POINT_CARDS[a.rank] || 0)
      );
      candidates.push({ cards: [sameSuitPoints[0]], score: 95, reason: '末家贴副分给队友' });
    }

    if (!hasSameSuit) {
      // 没有同花色，可以自由出牌
      // 2. 贴非主分牌（副分）
      const nonTrumpPoints = otherCards.filter(c => POINT_CARDS[c.rank] && !isTrump(c, gameState.trumpSuit, gameState.trumpLevel));
      if (nonTrumpPoints.length > 0) {
        nonTrumpPoints.sort((a, b) =>
          (POINT_CARDS[b.rank] || 0) - (POINT_CARDS[a.rank] || 0)
        );
        candidates.push({ cards: [nonTrumpPoints[0]], score: 90, reason: '末家垫副分给队友' });
      }
      // 3. 贴最小副牌（队友已确定最大，不浪费主牌将吃）
      const allNonTrumps = hand.filter(c => !isTrump(c, gameState.trumpSuit, gameState.trumpLevel));
      if (allNonTrumps.length > 0) {
        allNonTrumps.sort((a, b) =>
          evaluateCardValue(a, gameState.trumpSuit, gameState.trumpLevel) -
          evaluateCardValue(b, gameState.trumpSuit, gameState.trumpLevel)
        );
        candidates.push({ cards: [allNonTrumps[0]], score: 70, reason: '末家贴最小副牌' });
      }
    } else {
      // 有同花色，必须跟同花色
      // 2. 跟最小同花色
      sameSuitCards.sort((a, b) =>
        evaluateCardValue(a, gameState.trumpSuit, gameState.trumpLevel) -
        evaluateCardValue(b, gameState.trumpSuit, gameState.trumpLevel)
      );
      candidates.push({ cards: [sameSuitCards[0]], score: 65, reason: '末家跟最小同花色' });
    }

    candidates.sort((a, b) => b.score - a.score);
    if (candidates.length > 0) return candidates[0].cards;
    return [hand[0]];
  }

  // 如果有同花色，跟最小的
  if (sameSuitCards.length > 0) {
    sameSuitCards.sort((a, b) =>
      evaluateCardValue(a, gameState.trumpSuit, gameState.trumpLevel) -
      evaluateCardValue(b, gameState.trumpSuit, gameState.trumpLevel)
    );

    // 如果首家出对牌，优先跟对牌（拖拉机需单独处理，不要拆成对子）
    if ((leadPattern.type === 'pair' || leadPattern.type === 'triple') && sameSuitCards.length >= 2) {
      const pairs = findPairsSimple(sameSuitCards);
      if (pairs.length > 0) {
        pairs.sort((a, b) =>
          evaluateCardValue(a[0], gameState.trumpSuit, gameState.trumpLevel) -
          evaluateCardValue(b[0], gameState.trumpSuit, gameState.trumpLevel)
        );
        candidates.push({
          cards: pairs[0],
          score: 88,
          reason: '跟最小对牌给队友'
        });
      }
    }

    // 跟主牌且非末家：出最大主牌，防止对手出更大的得分
    // 注意：这里只在"队友出牌且对手在赢"时才需要出最大
    // 队友在赢时，出最小非分主牌即可
    const leadIsTrump = isTrump(leadCards[0], gameState.trumpSuit, gameState.trumpLevel);
    if (leadIsTrump && !analysis.isLastPlayer) {
      // 队友在赢，但出主牌时选最小非分主牌（防对手管住得分时才出最大，这里队友在赢）
      const nonPointTrumps = sameSuitCards.filter(c => !POINT_CARDS[c.rank]);
      if (nonPointTrumps.length > 0) {
        nonPointTrumps.sort((a, b) =>
          evaluateCardValue(a, gameState.trumpSuit, gameState.trumpLevel) -
          evaluateCardValue(b, gameState.trumpSuit, gameState.trumpLevel)
        );
        candidates.push({
          cards: [nonPointTrumps[0]],
          score: 82,
          reason: '跟最小非分主牌(防对手捡分)'
        });
      }
      // 只有分牌时，出最小分牌（评分降低，确保有非分牌时不会选到）
      const pointTrumps = sameSuitCards.filter(c => POINT_CARDS[c.rank]);
      if (pointTrumps.length > 0) {
        pointTrumps.sort((a, b) =>
          evaluateCardValue(a, gameState.trumpSuit, gameState.trumpLevel) -
          evaluateCardValue(b, gameState.trumpSuit, gameState.trumpLevel)
        );
        candidates.push({
          cards: [pointTrumps[0]],
          score: 65,
          reason: '跟最小分主牌(无奈)'
        });
      }
    } else if (analysis.isLastPlayer) {
      // 末家：队友确定最大，可以安全出分牌
      const sameSuitPoints = sameSuitCards.filter(c => POINT_CARDS[c.rank]);
      if (sameSuitPoints.length > 0) {
        sameSuitPoints.sort((a, b) =>
          (POINT_CARDS[b.rank] || 0) - (POINT_CARDS[a.rank] || 0)
        );
        candidates.push({
          cards: [sameSuitPoints[0]],
          score: 85,
          reason: '末家跟分牌给队友'
        });
      }
      // 跟最小牌
      sameSuitCards.sort((a, b) =>
        evaluateCardValue(a, gameState.trumpSuit, gameState.trumpLevel) -
        evaluateCardValue(b, gameState.trumpSuit, gameState.trumpLevel)
      );
      candidates.push({
        cards: [sameSuitCards[0]],
        score: 80,
        reason: '跟最小牌'
      });
    } else {
      // 非末家且跟副牌

      // 保护队友：用记牌器判断末家是否有分牌需要覆盖
      const currentTrick = analysis.currentTrick;
      const leadSeat = currentTrick[0].seat;
      const lastPlayerSeat = (leadSeat + 3) % 4;
      const lastPlayerTeam = gameState.players[lastPlayerSeat]?.team;
      if (lastPlayerTeam !== analysis.myTeam && cardTracker) {
        const coverTarget = findMinCardToCoverPoints(leadCards[0].suit, hand, currentTrick, cardTracker, gameState);
        if (coverTarget) {
          const coverCard = findSmallestCardToBeat(coverTarget, sameSuitCards, gameState.trumpSuit, gameState.trumpLevel, leadCards[0].suit);
          if (coverCard) {
            candidates.push({
              cards: [coverCard],
              score: 90,
              reason: '覆盖末家可能的分牌(' + coverTarget.rank + ')'
            });
          }
        }
      }

      // 默认：出最小非分牌（防对手捡分）
      const nonPointCards = sameSuitCards.filter(c => !POINT_CARDS[c.rank]);
      if (nonPointCards.length > 0) {
        nonPointCards.sort((a, b) =>
          evaluateCardValue(a, gameState.trumpSuit, gameState.trumpLevel) -
          evaluateCardValue(b, gameState.trumpSuit, gameState.trumpLevel)
        );
        candidates.push({
          cards: [nonPointCards[0]],
          score: 82,
          reason: '跟最小非分牌(防对手捡分)'
        });
      }
      // 只有分牌时，出最小分牌（评分降低，确保有非分牌时不会选到）
      const pointCards = sameSuitCards.filter(c => POINT_CARDS[c.rank]);
      if (pointCards.length > 0) {
        pointCards.sort((a, b) =>
          evaluateCardValue(a, gameState.trumpSuit, gameState.trumpLevel) -
          evaluateCardValue(b, gameState.trumpSuit, gameState.trumpLevel)
        );
        candidates.push({
          cards: [pointCards[0]],
          score: 65,
          reason: '跟最小分牌(无奈)'
        });
      }
    }
  } else {
    // 没有同花色
    const trickPoints = analysis.opponentTrickPoints || 0;

    // 对手贴了分牌时，必须将吃接管，不能让对手得分
    if (trickPoints >= 5) {
      const chopCandidates = generateChopCandidates(otherCards, leadCards, gameState, 85, trickPoints, analysis.isLastPlayer!, analysis);
      candidates.push(...chopCandidates);
    }

    // 垫分牌（给队友得分）
    const pointCards = otherCards.filter(c => POINT_CARDS[c.rank] && !isTrump(c, gameState.trumpSuit, gameState.trumpLevel));
    if (pointCards.length > 0) {
      pointCards.sort((a, b) =>
        evaluateCardValue(a, gameState.trumpSuit, gameState.trumpLevel) -
        evaluateCardValue(b, gameState.trumpSuit, gameState.trumpLevel)
      );
      candidates.push({
        cards: [pointCards[0]],
        score: 80,
        reason: '垫分牌给队友'
      });
    }

    // 垫最小的牌
    const nonTrumps = otherCards.filter(c => !isTrump(c, gameState.trumpSuit, gameState.trumpLevel));
    if (nonTrumps.length > 0) {
      nonTrumps.sort((a, b) =>
        evaluateCardValue(a, gameState.trumpSuit, gameState.trumpLevel) -
        evaluateCardValue(b, gameState.trumpSuit, gameState.trumpLevel)
      );
      candidates.push({
        cards: [nonTrumps[0]],
        score: 75,
        reason: '垫最小牌'
      });
    }
  }

  // 选择最佳候选
  candidates.sort((a, b) => b.score - a.score);
  if (candidates.length > 0) {
    return candidates[0].cards;
  }

  // 保底
  return [hand[0]];
}

/**
 * 情况2：队友出牌但对手在赢
 * 策略：如果能管住对手就出大牌，否则跟最小的
 */
function selectTeammateLosingPlay(hand: Card[], leadCards: Card[], sameSuitCards: Card[], otherCards: Card[], gameState: any, analysis: Analysis, cardTracker?: CardTracker): Card[] {
  const candidates: Candidate[] = [];
  const leadPattern = getCardPattern(leadCards, gameState.trumpSuit, gameState.trumpLevel);

  // 如果首家出拖拉机，优先考虑拖拉机
  if (leadPattern.type === 'tractor' && sameSuitCards.length >= 4) {
    const tractors = findTractorsSimple(sameSuitCards, gameState.trumpSuit, gameState.trumpLevel);
    const leadSuit = isTrump(leadCards[0], gameState.trumpSuit, gameState.trumpLevel) ? 'trump' : leadCards[0].suit;

    const winnerCards = analysis.currentWinnerCards || leadCards;
    for (const tractor of tractors) {
      if (tractor.length < leadCards.length) continue;
      const canWin = isPlayBeating(
        tractor.slice(0, leadCards.length),
        winnerCards,
        leadCards,
        leadPattern,
        leadSuit,
        gameState.trumpSuit,
        gameState.trumpLevel
      );

      const tractorValue = evaluateCardValue(tractor[0], gameState.trumpSuit, gameState.trumpLevel);
      if (canWin) {
        candidates.push({
          cards: tractor.slice(0, leadCards.length),
          score: 75 + tractorValue,
          reason: '拖拉机管住对手'
        });
      } else {
        candidates.push({
          cards: tractor.slice(0, leadCards.length),
          score: 45 + tractorValue,
          reason: '拖拉机跟牌'
        });
      }
    }
  }

  // 如果首家出对牌，考虑对牌（拖拉机已在上方处理，不要拆成对子）
  if ((leadPattern.type === 'pair' || leadPattern.type === 'triple') && sameSuitCards.length >= 2) {
    const pairs = findPairsSimple(sameSuitCards);
    const leadSuit = isTrump(leadCards[0], gameState.trumpSuit, gameState.trumpLevel) ? 'trump' : leadCards[0].suit;
    const winnerCards = analysis.currentWinnerCards || leadCards;

    for (const pair of pairs) {
      const canWin = isPlayBeating(
        pair,
        winnerCards,
        leadCards,
        leadPattern,
        leadSuit,
        gameState.trumpSuit,
        gameState.trumpLevel
      );

      const pairValue = evaluateCardValue(pair[0], gameState.trumpSuit, gameState.trumpLevel);
      if (canWin) {
        candidates.push({
          cards: pair,
          score: 70 + pairValue,
          reason: '对牌管住对手'
        });
      } else {
        candidates.push({
          cards: pair,
          score: 40 + pairValue,
          reason: '对牌跟牌'
        });
      }
    }
  }

  if (sameSuitCards.length > 0) {
    // 找出能管住当前赢家的牌
    const leadSuit = isTrump(leadCards[0], gameState.trumpSuit, gameState.trumpLevel) ? 'trump' : leadCards[0].suit;
    const winnerCards = analysis.currentWinnerCards || leadCards;
    const leadIsTrump = isTrump(leadCards[0], gameState.trumpSuit, gameState.trumpLevel);

    const winningPlays: Candidate[] = [];
    const losingPlays: Candidate[] = [];

    for (const card of sameSuitCards) {
      const testPlay = [card];
      const canWin = isPlayBeating(
        testPlay,
        winnerCards,
        leadCards,
        getCardPattern(leadCards, gameState.trumpSuit, gameState.trumpLevel),
        leadSuit,
        gameState.trumpSuit,
        gameState.trumpLevel
      );

      if (canWin) {
        winningPlays.push({
          cards: testPlay,
          score: 70 + evaluateCardValue(card, gameState.trumpSuit, gameState.trumpLevel),
          reason: '管住对手'
        });
      } else {
        losingPlays.push({
          cards: testPlay,
          score: 40 + evaluateCardValue(card, gameState.trumpSuit, gameState.trumpLevel),
          reason: '跟牌'
        });
      }
    }

    if (winningPlays.length > 0) {
      // 闲家扣底：最后几墩有扣底意图时，更积极地赢牌
      if (analysis.bottomCapture && !analysis.isDealer) {
        const bigTrumpWins = winningPlays.filter(p => {
          const c = p.cards[0];
          return c.suit === 'joker' || c.rank === getRankFromLevel(gameState.trumpLevel) || c.rank === 'A' || c.rank === '2';
        });
        if (bigTrumpWins.length > 0 && analysis.tricksRemaining <= 2) {
          bigTrumpWins.sort((a, b) => b.score - a.score);
          candidates.push({ ...bigTrumpWins[0], score: 90, reason: '扣底：大主牌抢赢' });
        }
      }

      // 核心原则：非末家时，必须出比K大的牌防止末家对手得分
      // 例：玩家2出J，玩家3出Q只能阻止玩家4出10，但玩家4可以出K得分
      //     所以玩家3必须出比K大的牌才能真正阻止对手得分
      if (!analysis.isLastPlayer && leadIsTrump) {
        // 非末家跟主牌：必须出比K大的牌防止末家对手得分
        // 主牌K的evaluateCardValue=60，比K大的牌：A(61) < 2(62) < 级牌(97/98) < 小王(99) < 大王(100)
        const bigTrumps = winningPlays.filter(p => {
          const val = evaluateCardValue(p.cards[0], gameState.trumpSuit, gameState.trumpLevel);
          return val > 60; // 比K大（A=61, 2=62, 级牌=97/98, 小王=99, 大王=100）
        });
        if (bigTrumps.length > 0) {
          // 有足够大的牌：出最小的（节省实力，但确保阻止对手得分）
          bigTrumps.sort((a, b) => a.score - b.score);
          candidates.push(bigTrumps[0]);
        } else {
          // 没有足够大的牌：出最小能赢的牌（至少阻止当前对手得分）
          winningPlays.sort((a, b) => a.score - b.score);
          candidates.push(winningPlays[0]);
        }
      } else if (!analysis.isLastPlayer) {
        // 非末家跟副牌：优先出非分赢牌，但只有分牌能赢时也要出（绝不能放弃）
        const nonPointWinning = winningPlays.filter(p => !POINT_CARDS[p.cards[0].rank]);
        if (nonPointWinning.length > 0) {
          // 有非分赢牌：优先出最小的非分赢牌（节省实力）
          nonPointWinning.sort((a, b) => a.score - b.score);
          candidates.push(nonPointWinning[0]);
        } else {
          // 只有分牌能赢：也要出（绝不能让对手白赢）
          winningPlays.sort((a, b) => a.score - b.score);
          candidates.push(winningPlays[0]);
        }
      } else {
        // 末家：出最小能赢的牌（节省实力）
        winningPlays.sort((a, b) => a.score - b.score);
        candidates.push(winningPlays[0]);
      }
    }

    if (losingPlays.length > 0) {
      // 无法赢时：排除分牌和高价值牌（大王/小王/级牌），出最小的普通牌
      const cheapLosing = losingPlays.filter(p => {
        const c = p.cards[0];
        if (POINT_CARDS[c.rank]) return false; // 排除分牌
        if (c.suit === 'joker') return false; // 排除大小王
        if (c.rank === getRankFromLevel(gameState.trumpLevel)) return false; // 排除级牌
        return true;
      });
      if (cheapLosing.length > 0) {
        cheapLosing.sort((a, b) => a.score - b.score);
        candidates.push(cheapLosing[0]);
      } else {
        // 只剩分牌/大牌可出，出最小的
        losingPlays.sort((a, b) => a.score - b.score);
        candidates.push(losingPlays[0]);
      }
    }
  } else {
    // 没有同花色，优先将吃管住对手
    const trickPoints = analysis.trickPoints || 0;
    const chopCandidates = generateChopCandidates(otherCards, leadCards, gameState, 80, trickPoints, analysis.isLastPlayer!, analysis);
    candidates.push(...chopCandidates);

    // 垫牌
    const nonTrumps = otherCards.filter(c => !isTrump(c, gameState.trumpSuit, gameState.trumpLevel));
    if (nonTrumps.length > 0) {
      nonTrumps.sort((a, b) =>
        evaluateCardValue(a, gameState.trumpSuit, gameState.trumpLevel) -
        evaluateCardValue(b, gameState.trumpSuit, gameState.trumpLevel)
      );
      candidates.push({
        cards: [nonTrumps[0]],
        score: 50,
        reason: '垫牌'
      });
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  if (candidates.length > 0) {
    return candidates[0].cards;
  }

  return [hand[0]];
}

/**
 * 情况3：对手出牌但队友在赢
 * 策略：跟最小的牌，不要破坏队友的优势
 */
function selectOpponentLeadingButTeammateWinningPlay(hand: Card[], leadCards: Card[], sameSuitCards: Card[], otherCards: Card[], gameState: any, analysis: Analysis): Card[] {
  const candidates: Candidate[] = [];
  const leadPattern = getCardPattern(leadCards, gameState.trumpSuit, gameState.trumpLevel);

  // 最后一个出牌且队友确定最大
  if (analysis.isLastPlayer && analysis.winnerIsTeammate) {
    const hasSameSuit = sameSuitCards.length > 0;

    // 1. 贴同花色分牌
    const sameSuitPoints = sameSuitCards.filter(c => POINT_CARDS[c.rank]);
    if (sameSuitPoints.length > 0) {
      sameSuitPoints.sort((a, b) =>
        (POINT_CARDS[b.rank] || 0) - (POINT_CARDS[a.rank] || 0)
      );
      candidates.push({ cards: [sameSuitPoints[0]], score: 95, reason: '末家贴副分' });
    }

    if (!hasSameSuit) {
      // 没有同花色，可以自由出牌
      // 2. 贴非主分牌
      const nonTrumpPoints = otherCards.filter(c => POINT_CARDS[c.rank] && !isTrump(c, gameState.trumpSuit, gameState.trumpLevel));
      if (nonTrumpPoints.length > 0) {
        nonTrumpPoints.sort((a, b) =>
          (POINT_CARDS[b.rank] || 0) - (POINT_CARDS[a.rank] || 0)
        );
        candidates.push({ cards: [nonTrumpPoints[0]], score: 90, reason: '末家垫副分' });
      }
      // 3. 贴最小副牌（队友已确定最大，不浪费主牌将吃）
      const allNonTrumps = hand.filter(c => !isTrump(c, gameState.trumpSuit, gameState.trumpLevel));
      if (allNonTrumps.length > 0) {
        allNonTrumps.sort((a, b) =>
          evaluateCardValue(a, gameState.trumpSuit, gameState.trumpLevel) -
          evaluateCardValue(b, gameState.trumpSuit, gameState.trumpLevel)
        );
        candidates.push({ cards: [allNonTrumps[0]], score: 70, reason: '末家贴最小副牌' });
      }
    } else {
      // 有同花色，必须跟同花色
      // 2. 跟最小同花色
      sameSuitCards.sort((a, b) =>
        evaluateCardValue(a, gameState.trumpSuit, gameState.trumpLevel) -
        evaluateCardValue(b, gameState.trumpSuit, gameState.trumpLevel)
      );
      candidates.push({ cards: [sameSuitCards[0]], score: 65, reason: '末家跟最小同花色' });
    }

    candidates.sort((a, b) => b.score - a.score);
    if (candidates.length > 0) return candidates[0].cards;
    return [hand[0]];
  }

  if (sameSuitCards.length > 0) {
    const leadIsTrump = isTrump(leadCards[0], gameState.trumpSuit, gameState.trumpLevel);

    // 如果首家出对牌，跟最小的对牌（拖拉机已在上方处理，不要拆成对子）
    if ((leadPattern.type === 'pair' || leadPattern.type === 'triple') && sameSuitCards.length >= 2) {
      const pairs = findPairsSimple(sameSuitCards);
      if (pairs.length > 0) {
        pairs.sort((a, b) =>
          evaluateCardValue(a[0], gameState.trumpSuit, gameState.trumpLevel) -
          evaluateCardValue(b[0], gameState.trumpSuit, gameState.trumpLevel)
        );
        candidates.push({
          cards: pairs[0],
          score: 80,
          reason: '跟最小对牌保护队友'
        });
      }
    }

    // 跟主牌且非末家：队友在赢时出最小非分主牌，不出分牌（防对手管住得分）
    if (leadIsTrump && !analysis.isLastPlayer) {
      const nonPointTrumps = sameSuitCards.filter(c => !POINT_CARDS[c.rank]);
      if (nonPointTrumps.length > 0) {
        nonPointTrumps.sort((a, b) =>
          evaluateCardValue(a, gameState.trumpSuit, gameState.trumpLevel) -
          evaluateCardValue(b, gameState.trumpSuit, gameState.trumpLevel)
        );
        candidates.push({
          cards: [nonPointTrumps[0]],
          score: 82,
          reason: '跟最小非分主牌(队友在赢)'
        });
      }
      const pointTrumps = sameSuitCards.filter(c => POINT_CARDS[c.rank]);
      if (pointTrumps.length > 0) {
        pointTrumps.sort((a, b) =>
          evaluateCardValue(a, gameState.trumpSuit, gameState.trumpLevel) -
          evaluateCardValue(b, gameState.trumpSuit, gameState.trumpLevel)
        );
        candidates.push({
          cards: [pointTrumps[0]],
          score: 65,
          reason: '跟最小分主牌(无奈)'
        });
      }
    } else {
      // 跟最小的牌，不要出分牌（防对手管住得分）
      sameSuitCards.sort((a, b) =>
        evaluateCardValue(a, gameState.trumpSuit, gameState.trumpLevel) -
        evaluateCardValue(b, gameState.trumpSuit, gameState.trumpLevel)
      );
      const nonPointCards = sameSuitCards.filter(c => !POINT_CARDS[c.rank]);
      if (nonPointCards.length > 0) {
        candidates.push({
          cards: [nonPointCards[0]],
          score: 75,
          reason: '跟最小非分牌(防对手捡分)'
        });
      }
      // 只有分牌时（评分降低，确保有非分牌时不会选到）
      const pointCards = sameSuitCards.filter(c => POINT_CARDS[c.rank]);
      if (pointCards.length > 0) {
        pointCards.sort((a, b) =>
          evaluateCardValue(a, gameState.trumpSuit, gameState.trumpLevel) -
          evaluateCardValue(b, gameState.trumpSuit, gameState.trumpLevel)
        );
        candidates.push({
          cards: [pointCards[0]],
          score: 60,
          reason: '跟最小分牌(无奈)'
        });
      }
    }
  } else {
    // 没有同花色
    const trickPoints = analysis.opponentTrickPoints || 0;

    // 对手贴了分牌时，需要将吃确保得分不被对手捡走
    if (trickPoints >= 5) {
      const chopCandidates = generateChopCandidates(otherCards, leadCards, gameState, 80, trickPoints, analysis.isLastPlayer!, analysis);
      candidates.push(...chopCandidates);
    }

    // 垫副分牌（给队友得分）
    const nonTrumpPoints = otherCards.filter(c => POINT_CARDS[c.rank] && !isTrump(c, gameState.trumpSuit, gameState.trumpLevel));
    if (nonTrumpPoints.length > 0) {
      nonTrumpPoints.sort((a, b) =>
        (POINT_CARDS[b.rank] || 0) - (POINT_CARDS[a.rank] || 0)
      );
      candidates.push({
        cards: [nonTrumpPoints[0]],
        score: 78,
        reason: '垫副分给队友'
      });
    }

    // 垫最小副牌
    const nonTrumps = otherCards.filter(c => !isTrump(c, gameState.trumpSuit, gameState.trumpLevel));
    if (nonTrumps.length > 0) {
      nonTrumps.sort((a, b) =>
        evaluateCardValue(a, gameState.trumpSuit, gameState.trumpLevel) -
        evaluateCardValue(b, gameState.trumpSuit, gameState.trumpLevel)
      );
      candidates.push({
        cards: [nonTrumps[0]],
        score: 70,
        reason: '垫最小副牌'
      });
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  if (candidates.length > 0) {
    return candidates[0].cards;
  }

  return [hand[0]];
}

/**
 * 情况4：对手出牌且对手在赢
 * 策略：如果能管住就出大牌，否则跟最小的
 */
function selectOpponentWinningPlay(hand: Card[], leadCards: Card[], sameSuitCards: Card[], otherCards: Card[], gameState: any, analysis: Analysis, cardTracker?: CardTracker): Card[] {
  const candidates: Candidate[] = [];
  const leadPattern = getCardPattern(leadCards, gameState.trumpSuit, gameState.trumpLevel);
  const winnerCards = analysis.currentWinnerCards || leadCards;

  // 如果首家出拖拉机，优先考虑拖拉机
  if (leadPattern.type === 'tractor' && sameSuitCards.length >= 4) {
    const tractors = findTractorsSimple(sameSuitCards, gameState.trumpSuit, gameState.trumpLevel);
    const leadSuit = isTrump(leadCards[0], gameState.trumpSuit, gameState.trumpLevel) ? 'trump' : leadCards[0].suit;

    for (const tractor of tractors) {
      if (tractor.length < leadCards.length) continue;
      const canWin = isPlayBeating(
        tractor.slice(0, leadCards.length),
        winnerCards,
        leadCards,
        leadPattern,
        leadSuit,
        gameState.trumpSuit,
        gameState.trumpLevel
      );

      const tractorValue = evaluateCardValue(tractor[0], gameState.trumpSuit, gameState.trumpLevel);
      if (canWin) {
        candidates.push({
          cards: tractor.slice(0, leadCards.length),
          score: 95 + tractorValue,
          reason: '拖拉机管住对手'
        });
      } else {
        candidates.push({
          cards: tractor.slice(0, leadCards.length),
          score: 35 + tractorValue,
          reason: '拖拉机跟牌'
        });
      }
    }
  }

  // 如果首家出对牌，考虑对牌（拖拉机已在上方处理，不要拆成对子）
  if ((leadPattern.type === 'pair' || leadPattern.type === 'triple') && sameSuitCards.length >= 2) {
    const pairs = findPairsSimple(sameSuitCards);
    const leadSuit = isTrump(leadCards[0], gameState.trumpSuit, gameState.trumpLevel) ? 'trump' : leadCards[0].suit;

    for (const pair of pairs) {
      const canWin = isPlayBeating(
        pair,
        winnerCards,
        leadCards,
        leadPattern,
        leadSuit,
        gameState.trumpSuit,
        gameState.trumpLevel
      );

      const pairValue = evaluateCardValue(pair[0], gameState.trumpSuit, gameState.trumpLevel);
      if (canWin) {
        candidates.push({
          cards: pair,
          score: 90 + pairValue,
          reason: '对牌管住对手'
        });
      } else {
        candidates.push({
          cards: pair,
          score: 30 + pairValue,
          reason: '对牌跟牌'
        });
      }
    }
  }

  if (sameSuitCards.length > 0) {
    // 找出能管住当前赢家的牌
    const leadSuit = isTrump(leadCards[0], gameState.trumpSuit, gameState.trumpLevel) ? 'trump' : leadCards[0].suit;
    const leadIsTrump = isTrump(leadCards[0], gameState.trumpSuit, gameState.trumpLevel);

    const winningPlays: Candidate[] = [];
    const losingPlays: Candidate[] = [];

    for (const card of sameSuitCards) {
      const testPlay = [card];
      const canWin = isPlayBeating(
        testPlay,
        winnerCards,
        leadCards,
        getCardPattern(leadCards, gameState.trumpSuit, gameState.trumpLevel),
        leadSuit,
        gameState.trumpSuit,
        gameState.trumpLevel
      );

      if (canWin) {
        winningPlays.push({
          cards: testPlay,
          score: 90 + evaluateCardValue(card, gameState.trumpSuit, gameState.trumpLevel),
          reason: '管住对手'
        });
      } else {
        losingPlays.push({
          cards: testPlay,
          score: 30 + evaluateCardValue(card, gameState.trumpSuit, gameState.trumpLevel),
          reason: '跟牌'
        });
      }
    }

    if (winningPlays.length > 0) {
      // 闲家扣底：最后几墩有扣底意图时，更积极地赢牌（用大主牌抢底）
      if (analysis.bottomCapture && !analysis.isDealer) {
        const bigTrumpWins = winningPlays.filter(p => {
          const c = p.cards[0];
          return c.suit === 'joker' || c.rank === getRankFromLevel(gameState.trumpLevel) || c.rank === 'A' || c.rank === '2';
        });
        if (bigTrumpWins.length > 0 && analysis.tricksRemaining <= 2) {
          bigTrumpWins.sort((a, b) => b.score - a.score);
          candidates.push({ ...bigTrumpWins[0], score: 90, reason: '扣底：大主牌抢赢' });
        }
      }

      // 核心原则：非末家时，必须出比K大的牌防止末家对手得分
      // 例：玩家2出J，玩家3出Q只能阻止玩家4出10，但玩家4可以出K得分
      //     所以玩家3必须出比K大的牌才能真正阻止对手得分
      if (!analysis.isLastPlayer && leadIsTrump) {
        // 非末家跟主牌：必须出比K大的牌防止末家对手得分
        // 主牌K的evaluateCardValue=60，比K大的牌：A(61) < 2(62) < 级牌(97/98) < 小王(99) < 大王(100)
        const bigTrumps = winningPlays.filter(p => {
          const val = evaluateCardValue(p.cards[0], gameState.trumpSuit, gameState.trumpLevel);
          return val > 60; // 比K大（A=61, 2=62, 级牌=97/98, 小王=99, 大王=100）
        });
        if (bigTrumps.length > 0) {
          // 有足够大的牌：出最小的（节省实力，但确保阻止对手得分）
          bigTrumps.sort((a, b) => a.score - b.score);
          candidates.push(bigTrumps[0]);
        } else {
          // 没有足够大的牌：出最小能赢的牌（至少阻止当前对手得分）
          winningPlays.sort((a, b) => a.score - b.score);
          candidates.push(winningPlays[0]);
        }
      } else if (!analysis.isLastPlayer) {
        // 非末家跟副牌：优先出非分赢牌，但只有分牌能赢时也要出（绝不能放弃）
        const nonPointWinning = winningPlays.filter(p => !POINT_CARDS[p.cards[0].rank]);
        if (nonPointWinning.length > 0) {
          // 有非分赢牌：优先出最小的非分赢牌（节省实力）
          nonPointWinning.sort((a, b) => a.score - b.score);
          candidates.push(nonPointWinning[0]);
        } else {
          // 只有分牌能赢：也要出（绝不能让对手白赢）
          winningPlays.sort((a, b) => a.score - b.score);
          candidates.push(winningPlays[0]);
        }
      } else {
        // 末家：出最小能赢的牌（节省实力）
        winningPlays.sort((a, b) => a.score - b.score);
        candidates.push(winningPlays[0]);
      }
    }

    if (losingPlays.length > 0) {
      // 无法赢时：排除分牌和高价值牌（大王/小王/级牌），出最小的普通牌
      const cheapLosing = losingPlays.filter(p => {
        const c = p.cards[0];
        if (POINT_CARDS[c.rank]) return false; // 排除分牌
        if (c.suit === 'joker') return false; // 排除大小王
        if (c.rank === getRankFromLevel(gameState.trumpLevel)) return false; // 排除级牌
        return true;
      });
      if (cheapLosing.length > 0) {
        cheapLosing.sort((a, b) => a.score - b.score);
        candidates.push(cheapLosing[0]);
      } else {
        // 只剩分牌/大牌可出，出最小的
        losingPlays.sort((a, b) => a.score - b.score);
        candidates.push(losingPlays[0]);
      }
    }
  } else {
    // 没有同花色，优先考虑主牌将吃
    const trickPoints = analysis.trickPoints || 0;
    const chopCandidates = generateChopCandidates(otherCards, leadCards, gameState, 80, trickPoints, analysis.isLastPlayer!, analysis);
    candidates.push(...chopCandidates);

    // 垫牌
    const nonTrumps = otherCards.filter(c => !isTrump(c, gameState.trumpSuit, gameState.trumpLevel));
    if (nonTrumps.length > 0) {
      nonTrumps.sort((a, b) =>
        evaluateCardValue(a, gameState.trumpSuit, gameState.trumpLevel) -
        evaluateCardValue(b, gameState.trumpSuit, gameState.trumpLevel)
      );
      candidates.push({
        cards: [nonTrumps[0]],
        score: 40,
        reason: '垫牌'
      });
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  if (candidates.length > 0) {
    return candidates[0].cards;
  }

  return [hand[0]];
}

/**
 * 默认跟牌策略
 */
function selectDefaultFollowPlay(hand: Card[], leadCards: Card[], sameSuitCards: Card[], otherCards: Card[], gameState: any, analysis: Analysis): Card[] {
  const leadPattern = getCardPattern(leadCards, gameState.trumpSuit, gameState.trumpLevel);

  if (sameSuitCards.length > 0) {
    sameSuitCards.sort((a, b) =>
      evaluateCardValue(a, gameState.trumpSuit, gameState.trumpLevel) -
      evaluateCardValue(b, gameState.trumpSuit, gameState.trumpLevel)
    );

    // 如果首家出对牌，优先跟对牌（拖拉机需单独处理，不要拆成对子）
    if ((leadPattern.type === 'pair' || leadPattern.type === 'triple') && sameSuitCards.length >= 2) {
      const pairs = findPairsSimple(sameSuitCards);
      if (pairs.length > 0) {
        pairs.sort((a, b) =>
          evaluateCardValue(a[0], gameState.trumpSuit, gameState.trumpLevel) -
          evaluateCardValue(b[0], gameState.trumpSuit, gameState.trumpLevel)
        );
        return pairs[0];
      }
    }

    return [sameSuitCards[0]];
  }

  // 没有同花色，优先将吃
  const trickPoints = analysis.trickPoints || 0;
  const chopCandidates = generateChopCandidates(otherCards, leadCards, gameState, 70, trickPoints, analysis.isLastPlayer!, analysis);
  if (chopCandidates.length > 0) {
    chopCandidates.sort((a, b) => b.score - a.score);
    return chopCandidates[0].cards;
  }

  // 垫牌
  if (otherCards.length > 0) {
    const nonTrumps = otherCards.filter(c => !isTrump(c, gameState.trumpSuit, gameState.trumpLevel));
    if (nonTrumps.length > 0) {
      nonTrumps.sort((a, b) =>
        evaluateCardValue(a, gameState.trumpSuit, gameState.trumpLevel) -
        evaluateCardValue(b, gameState.trumpSuit, gameState.trumpLevel)
      );
      return [nonTrumps[0]];
    }
    otherCards.sort((a, b) =>
      evaluateCardValue(a, gameState.trumpSuit, gameState.trumpLevel) -
      evaluateCardValue(b, gameState.trumpSuit, gameState.trumpLevel)
    );
    return [otherCards[0]];
  }

  return [hand[0]];
}

/**
 * 扣底策略
 */
export function selectBottomCards(hand: Card[], bottomCount: number, trumpSuit: string | null, trumpLevel: number, isDealer: boolean): Card[] {
  // 庄家扣底策略：保留大牌，扣掉危险牌
  const sorted = [...hand].sort((a, b) => {
    const aValue = _bottomRemovalPriority(a, trumpSuit, trumpLevel, hand);
    const bValue = _bottomRemovalPriority(b, trumpSuit, trumpLevel, hand);
    return bValue - aValue;
  });

  return sorted.slice(0, bottomCount);
}

function _bottomRemovalPriority(card: Card, trumpSuit: string | null, trumpLevel: number, hand: Card[]): number {
  let priority = 0;

  // 分牌很危险，优先扣掉
  if (card.rank === '10' || card.rank === 'K') priority += 30;
  if (card.rank === '5') priority += 25;

  // 非主牌优先扣
  if (!isTrump(card, trumpSuit, trumpLevel)) {
    priority += 10;
    const rankOrder = ['3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
    const rankIdx = rankOrder.indexOf(card.rank);
    priority += (10 - rankIdx);
  } else {
    // 主牌分牌：被抠底时翻倍扣分，比非分主牌更危险
    if (POINT_CARDS[card.rank]) {
      priority -= 20;
    } else {
      priority -= 50;
    }
  }

  // 不要拆对子
  const sameKey = `${card.suit}_${card.rank}`;
  const count = hand.filter(c => `${c.suit}_${c.rank}` === sameKey).length;
  if (count >= 2) priority -= 20;

  return priority;
}

/**
 * 亮主策略
 */
export function decideBid(hand: Card[], trumpLevel: number): Card[] | null {
  const levelStr = getRankFromLevel(trumpLevel);
  const levelCards = hand.filter(c => c.rank === levelStr && c.suit !== 'joker');
  const jokers = hand.filter(c => c.suit === 'joker');
  const bigJokers = jokers.filter(c => c.rank === 'big');

  // 按花色分组级牌
  const bySuit: Record<string, Card[]> = {};
  for (const c of levelCards) {
    if (!bySuit[c.suit]) bySuit[c.suit] = [];
    bySuit[c.suit].push(c);
  }

  // 找到最好的花色
  let bestSuit: string | null = null;
  let bestCount = 0;
  for (const suit in bySuit) {
    if (bySuit[suit].length > bestCount) {
      bestCount = bySuit[suit].length;
      bestSuit = suit;
    }
  }

  // 评估手牌强度
  let strength = 0;
  strength += bestCount * 15;
  strength += jokers.length * 20;
  strength += bigJokers.length * 10;

  if (bestSuit) {
    const suitCards = hand.filter(c => c.suit === bestSuit);
    const suitAces = suitCards.filter(c => c.rank === 'A');
    const suitPairs = findPairs(hand, bestSuit, trumpLevel);
    strength += suitAces.length * 8;
    strength += suitPairs.length * 10;
  }

  // 首次亮主：需要2+同花色级牌
  if (bestCount >= 2 && strength >= 30) {
    return bySuit[bestSuit!].slice(0, 2);
  }

  // 用王反主
  if (bestCount >= 1 && jokers.length >= 1 && strength >= 30) {
    return [...bySuit[bestSuit!].slice(0, 1), jokers[0]];
  }

  // 无主：2+王
  if (jokers.length >= 2 && strength >= 25) {
    return jokers.slice(0, 2);
  }

  return null;
}

// ==================== 主AI类 ====================

export class AdvancedAI {
  seat: number;
  team: number;
  cardTracker: CardTracker;
  hand!: Card[];

  constructor(seat: number, team: number, cardTracker: CardTracker) {
    this.seat = seat;
    this.team = team;
    this.cardTracker = cardTracker;
  }

  /**
   * 选择最佳出牌
   */
  selectBestPlay(hand: Card[], leadCards: Card[] | null, gameState: any): Card[] {
    // 更新牌追踪器
    if (gameState.trumpSuit) {
      this.cardTracker.setTrump(gameState.trumpSuit, gameState.trumpLevel);
    }

    // 记录已出的牌
    for (const trick of gameState.tricks || []) {
      this.cardTracker.recordTrick(trick);
    }

    let selectedCards: Card[];

    if (!leadCards || leadCards.length === 0) {
      // 首家出牌
      selectedCards = selectLeadPlay(hand, gameState, this.seat, this.team, this.cardTracker);
    } else {
      // 跟牌
      selectedCards = selectFollowPlay(hand, leadCards, gameState, this.seat, this.team, this.cardTracker);
    }

    // 验证出牌
    const validation = validatePlay(hand, selectedCards, leadCards, gameState.trumpSuit, gameState.trumpLevel);
    if (validation.valid) {
      return selectedCards;
    }

    // 如果验证失败，尝试其他候选
    const candidates = this.generateFallbackCandidates(hand, leadCards, gameState);
    for (const candidate of candidates) {
      const v = validatePlay(hand, candidate, leadCards, gameState.trumpSuit, gameState.trumpLevel);
      if (v.valid) {
        return candidate;
      }
    }

    // 最后保底
    return [hand[0]];
  }

  /**
   * 生成备选候选
   */
  generateFallbackCandidates(hand: Card[], leadCards: Card[] | null, gameState: any): Card[][] {
    const candidates: Card[][] = [];
    const leadPattern = leadCards ? getCardPattern(leadCards, gameState.trumpSuit, gameState.trumpLevel) : null;
    const leadIsTrump = leadCards ? isTrump(leadCards[0], gameState.trumpSuit, gameState.trumpLevel) : false;
    const leadSuit = leadIsTrump ? 'trump' : (leadCards ? leadCards[0].suit : null);
    const leadCount = leadCards ? leadCards.length : 1;

    // 找出同花色的牌
    const sameSuitCards = hand.filter(c => {
      if (leadIsTrump) return isTrump(c, gameState.trumpSuit, gameState.trumpLevel);
      return !isTrump(c, gameState.trumpSuit, gameState.trumpLevel) && c.suit === leadSuit;
    });

    // 按牌力排序
    sameSuitCards.sort((a, b) =>
      evaluateCardValue(a, gameState.trumpSuit, gameState.trumpLevel) -
      evaluateCardValue(b, gameState.trumpSuit, gameState.trumpLevel)
    );

    if (leadCount > 1) {
      // 多牌出牌（对牌/拖拉机）：生成同花色组合
      if (sameSuitCards.length >= leadCount) {
        // 尝试同花色前N张
        candidates.push(sameSuitCards.slice(0, leadCount));
        // 尝试同花色后N张（最大的）
        candidates.push(sameSuitCards.slice(-leadCount));
        // 尝试对子组合
        const groups: Record<string, Card[]> = {};
        for (const c of sameSuitCards) {
          if (!groups[c.rank]) groups[c.rank] = [];
          groups[c.rank].push(c);
        }
        for (const rank in groups) {
          if (groups[rank].length >= 2) {
            const pair = groups[rank].slice(0, 2);
            // 用其他同花色牌补齐
            const rest = sameSuitCards.filter(c => !pair.some(p => p.id === c.id));
            const fill = rest.slice(0, leadCount - 2);
            if (fill.length >= leadCount - 2) {
              candidates.push([...pair, ...fill]);
            }
          }
        }
      }
      // 同花色不够，用其他牌补齐
      if (sameSuitCards.length > 0 && sameSuitCards.length < leadCount) {
        const otherCards = hand.filter(c => !sameSuitCards.includes(c));
        otherCards.sort((a, b) =>
          evaluateCardValue(a, gameState.trumpSuit, gameState.trumpLevel) -
          evaluateCardValue(b, gameState.trumpSuit, gameState.trumpLevel)
        );
        candidates.push([...sameSuitCards, ...otherCards.slice(0, leadCount - sameSuitCards.length)]);
      }
    }

    // 单牌尝试（从大到小）
    for (let i = sameSuitCards.length - 1; i >= 0; i--) {
      candidates.push([sameSuitCards[i]]);
    }

    // 单牌尝试（从小到大）
    for (const card of sameSuitCards) {
      candidates.push([card]);
    }

    // 其他花色的牌
    const otherCards = hand.filter(c => !sameSuitCards.includes(c));
    otherCards.sort((a, b) =>
      evaluateCardValue(a, gameState.trumpSuit, gameState.trumpLevel) -
      evaluateCardValue(b, gameState.trumpSuit, gameState.trumpLevel)
    );
    for (const card of otherCards.slice(0, 5)) {
      candidates.push([card]);
    }

    return candidates;
  }

  /**
   * 亮主决策
   */
  decideBid(gameState: any): Card[] | null {
    return decideBid(this.hand, gameState.trumpLevel);
  }

  /**
   * 扣底决策
   */
  decideBottom(gameState: any): Card[] {
    return selectBottomCards(
      this.hand,
      gameState.bottomCount || 8,
      gameState.trumpSuit,
      gameState.trumpLevel,
      this.team === gameState.players[gameState.dealer]?.team
    );
  }
}
