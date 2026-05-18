/**
 * 高级AI系统 - 拖拉机游戏
 * 基于专业的拖拉机打牌技巧设计
 */

const {
  validatePlay, getCardPattern, isTrump, compareCards,
  isPlayBeating, findWinningCard, getMaxCard, isTractor,
  groupByRank, getTrumpRank, RANK_ORDER, POINT_CARDS, getRoundPoints
} = require('./game');

const SUIT_NAMES = { spade: '黑桃', heart: '红桃', diamond: '方块', club: '梅花', joker: '王牌' };
const SUIT_ORDER = { spade: 3, heart: 2, diamond: 1, club: 0 };

// ==================== 牌力评估系统 ====================

/**
 * 评估单张牌的价值
 */
function evaluateCardValue(card, trumpSuit, trumpLevel) {
  if (card.suit === 'joker') {
    return card.rank === 'big' ? 100 : 99;
  }

  if (card.rank === String(trumpLevel)) {
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
function evaluateCardsValue(cards, trumpSuit, trumpLevel) {
  if (!cards || cards.length === 0) return 0;
  return cards.reduce((sum, c) => sum + evaluateCardValue(c, trumpSuit, trumpLevel), 0);
}

/**
 * 评估手牌整体强度
 */
function evaluateHandStrength(hand, trumpSuit, trumpLevel) {
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
  const trumpLevelCards = hand.filter(c => c.rank === String(trumpSuit));
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
function findPairs(hand, trumpSuit, trumpLevel) {
  const pairs = [];
  const grouped = groupByRank(hand);

  for (const key in grouped) {
    if (grouped[key].length >= 2) {
      pairs.push(grouped[key].slice(0, 2));
    }
  }

  return pairs;
}

/**
 * 找出手牌中的所有拖拉机
 */
function findTractors(hand, trumpSuit, trumpLevel) {
  const tractors = [];
  const pairs = findPairs(hand, trumpSuit, trumpLevel);

  if (pairs.length < 2) return tractors;

  // 按牌力排序
  pairs.sort((a, b) => evaluateCardValue(a[0], trumpSuit, trumpLevel) - evaluateCardValue(b[0], trumpSuit, trumpLevel));

  // 尝试所有连续对子组合
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

// ==================== 局势分析系统 ====================

/**
 * 分析当前局势
 */
function analyzeGameState(hand, gameState, seat, team, cardTracker) {
  const analysis = {
    myStrength: evaluateHandStrength(hand, gameState.trumpSuit, gameState.trumpLevel),
    myTrumps: hand.filter(c => isTrump(c, gameState.trumpSuit, gameState.trumpLevel)).length,
    myPairs: findPairs(hand, gameState.trumpSuit, gameState.trumpLevel).length,
    myTractors: findTractors(hand, gameState.trumpSuit, gameState.trumpLevel).length,
    tricksPlayed: gameState.tricksCount || 0,
    tricksRemaining: Math.min(...gameState.players.map(p => p.handCount || 0)),
    myTeamScore: team === 1 ? (gameState.scores?.team1 || 0) : (gameState.scores?.team2 || 0),
    oppTeamScore: team === 1 ? (gameState.scores?.team2 || 0) : (gameState.scores?.team1 || 0),
    isDealer: gameState.dealer === seat,
    dealerTeam: gameState.players[gameState.dealer]?.team,
    bottomPoints: cardTracker ? cardTracker.getRemainingPoints() : 0,
    trumpSuit: gameState.trumpSuit,
    trumpLevel: gameState.trumpLevel
  };

  // 判断是否是队友的回合
  const currentTrick = gameState.currentTrick || [];
  if (currentTrick.length > 0) {
    const leadSeat = currentTrick[0].seat;
    const leadTeam = gameState.players[leadSeat]?.team;
    analysis.leadIsTeammate = leadTeam === team;

    // 判断当前赢家
    const leadSuit = currentTrick[0].cards[0].suit;
    const winnerIdx = findWinningCard(currentTrick, gameState.trumpSuit, gameState.trumpLevel, leadSuit);
    const winnerSeat = currentTrick[winnerIdx].seat;
    const winnerTeam = gameState.players[winnerSeat]?.team;
    analysis.winnerIsTeammate = winnerTeam === team;
    analysis.winnerIsMe = winnerSeat === seat;
  }

  return analysis;
}

// ==================== 策略选择系统 ====================

/**
 * 首家出牌策略
 */
function selectLeadPlay(hand, gameState, seat, team, cardTracker) {
  const analysis = analyzeGameState(hand, gameState, seat, team, cardTracker);
  const candidates = [];

  // 1. 拖拉机（最强）
  const tractors = findTractors(hand, gameState.trumpSuit, gameState.trumpLevel);
  if (tractors.length > 0) {
    // 选择最长的拖拉机
    tractors.sort((a, b) => b.length - a.length);
    candidates.push({
      cards: tractors[0],
      score: 100 + tractors[0].length * 10,
      reason: '出拖拉机抢分'
    });
  }

  // 2. 对子
  const pairs = findPairs(hand, gameState.trumpSuit, gameState.trumpLevel);
  if (pairs.length > 0) {
    // 按牌力排序，选择最强的对子
    pairs.sort((a, b) => evaluateCardValue(b[0], gameState.trumpSuit, gameState.trumpLevel) -
                       evaluateCardValue(a[0], gameState.trumpSuit, gameState.trumpLevel));

    for (const pair of pairs.slice(0, 3)) {
      const value = evaluateCardValue(pair[0], gameState.trumpSuit, gameState.trumpLevel);
      const isTrumpPair = isTrump(pair[0], gameState.trumpSuit, gameState.trumpLevel);
      let score = 70 + value;

      if (isTrumpPair) score += 20;
      if (pair[0].rank === 'A') score += 15;
      if (pair[0].rank === 'K') score += 10;

      candidates.push({
        cards: pair,
        score,
        reason: isTrumpPair ? '出主牌对子' : '出对子'
      });
    }
  }

  // 3. 大牌（A、K）
  const bigCards = hand.filter(c =>
    !isTrump(c, gameState.trumpSuit, gameState.trumpLevel) &&
    (c.rank === 'A' || c.rank === 'K')
  );
  for (const card of bigCards) {
    candidates.push({
      cards: [card],
      score: 60 + evaluateCardValue(card, gameState.trumpSuit, gameState.trumpLevel),
      reason: '出大牌控制'
    });
  }

  // 4. 主牌
  const trumps = hand.filter(c => isTrump(c, gameState.trumpSuit, gameState.trumpLevel));
  if (trumps.length > 0) {
    // 选择小的主牌清主
    trumps.sort((a, b) => evaluateCardValue(a, gameState.trumpSuit, gameState.trumpLevel) -
                        evaluateCardValue(b, gameState.trumpSuit, gameState.trumpLevel));
    candidates.push({
      cards: [trumps[0]],
      score: 50,
      reason: '出小主牌清主'
    });
  }

  // 5. 长套牌
  const suitCounts = {};
  for (const c of hand) {
    if (!isTrump(c, gameState.trumpSuit, gameState.trumpLevel)) {
      suitCounts[c.suit] = (suitCounts[c.suit] || 0) + 1;
    }
  }
  for (const suit in suitCounts) {
    if (suitCounts[suit] >= 4) {
      const suitCards = hand.filter(c => c.suit === suit && !isTrump(c, gameState.trumpSuit, gameState.trumpLevel));
      if (suitCards.length >= 4) {
        // 检查是否可以甩牌
        const maxCard = getMaxCard(suitCards, gameState.trumpSuit, gameState.trumpLevel, suit);
        if (maxCard.rank === 'A' || maxCard.rank === 'K') {
          candidates.push({
            cards: suitCards.slice(0, 4),
            score: 55,
            reason: '甩长套牌'
          });
        }
      }
    }
  }

  // 6. 小牌（最后选择）
  const sortedHand = [...hand].sort((a, b) =>
    evaluateCardValue(a, gameState.trumpSuit, gameState.trumpLevel) -
    evaluateCardValue(b, gameState.trumpSuit, gameState.trumpLevel)
  );
  candidates.push({
    cards: [sortedHand[0]],
    score: 40,
    reason: '出小牌'
  });

  // 选择最佳候选
  candidates.sort((a, b) => b.score - a.score);

  // 验证每个候选
  for (const candidate of candidates) {
    const validation = validatePlay(hand, candidate.cards, null, gameState.trumpSuit, gameState.trumpLevel);
    if (validation.valid) {
      return candidate.cards;
    }
  }

  return [sortedHand[0]];
}

/**
 * 从手牌中找出所有对子（同rank同花色的两张牌）
 */
function findPairs(cards) {
  const groups = {};
  for (const c of cards) {
    const key = `${c.suit}_${c.rank}`;
    if (!groups[key]) groups[key] = [];
    groups[key].push(c);
  }
  const pairs = [];
  for (const key in groups) {
    if (groups[key].length >= 2) {
      pairs.push([groups[key][0], groups[key][1]]);
    }
  }
  return pairs;
}

/**
 * 从手牌中找出拖拉机（同花色连续对子）
 */
function findTractors(cards, trumpSuit, trumpLevel) {
  const pairs = findPairs(cards);
  if (pairs.length < 2) return [];

  // 按花色分组
  const suitGroups = {};
  for (const pair of pairs) {
    const suit = pair[0].suit;
    if (!suitGroups[suit]) suitGroups[suit] = [];
    suitGroups[suit].push(pair);
  }

  const tractors = [];
  for (const suit in suitGroups) {
    const suitPairs = suitGroups[suit];
    if (suitPairs.length < 2) continue;

    // 按rank排序
    suitPairs.sort((a, b) => RANK_ORDER[a[0].rank] - RANK_ORDER[b[0].rank]);

    // 找连续对子
    let current = [suitPairs[0]];
    for (let i = 1; i < suitPairs.length; i++) {
      const prevRank = RANK_ORDER[current[current.length - 1][0].rank];
      const currRank = RANK_ORDER[suitPairs[i][0].rank];
      if (currRank - prevRank === 1) {
        current.push(suitPairs[i]);
      } else {
        if (current.length >= 2) {
          tractors.push(current.flat());
        }
        current = [suitPairs[i]];
      }
    }
    if (current.length >= 2) {
      tractors.push(current.flat());
    }
  }

  return tractors;
}

/**
 * 确保跟牌数量与首家出牌数量一致
 */
function ensureCorrectPlayCount(cards, hand, leadCards, trumpSuit, trumpLevel) {
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

  // 如果首家出对牌或拖拉机，优先用同花色对牌补齐
  if ((leadPattern.type === 'pair' || leadPattern.type === 'tractor') && cards.length < leadCount) {
    const result = [...cards];
    // 按rank分组找对子
    const groups = {};
    for (const c of sameSuitRemaining) {
      if (!groups[c.rank]) groups[c.rank] = [];
      groups[c.rank].push(c);
    }
    // 优先找和已出牌同rank的对子（保持同rank对牌）
    const playedRanks = {};
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
function selectFollowPlay(hand, leadCards, gameState, seat, team, cardTracker) {
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

  let play;

  // ============= 核心策略：根据对手/队友出牌调整 =============

  if (analysis.leadIsTeammate && analysis.winnerIsTeammate) {
    // 情况1：队友出牌且队友正在赢
    // 策略：跟最小的牌，带上分牌（让队友得分）
    play = selectTeammateWinningPlay(hand, leadCards, sameSuitCards, otherCards, gameState, analysis);
  } else if (analysis.leadIsTeammate && !analysis.winnerIsTeammate) {
    // 情况2：队友出牌但对手在赢
    // 策略：如果能管住对手就出大牌，否则跟最小的
    play = selectTeammateLosingPlay(hand, leadCards, sameSuitCards, otherCards, gameState, analysis);
  } else if (!analysis.leadIsTeammate && analysis.winnerIsTeammate) {
    // 情况3：对手出牌但队友在赢
    // 策略：跟最小的牌，不要破坏队友的优势
    play = selectOpponentLeadingButTeammateWinningPlay(hand, leadCards, sameSuitCards, otherCards, gameState, analysis);
  } else if (!analysis.leadIsTeammate && !analysis.winnerIsTeammate) {
    // 情况4：对手出牌且对手在赢
    // 策略：如果能管住就出大牌，否则跟最小的
    play = selectOpponentWinningPlay(hand, leadCards, sameSuitCards, otherCards, gameState, analysis);
  } else {
    // 默认策略
    play = selectDefaultFollowPlay(hand, leadCards, sameSuitCards, otherCards, gameState, analysis);
  }

  // 确保出牌数量与首家一致
  return ensureCorrectPlayCount(play, hand, leadCards, gameState.trumpSuit, gameState.trumpLevel);
}

/**
 * 情况1：队友出牌且队友正在赢
 * 策略：跟最小的牌，带上分牌
 */
function selectTeammateWinningPlay(hand, leadCards, sameSuitCards, otherCards, gameState, analysis) {
  const candidates = [];
  const leadPattern = getCardPattern(leadCards, gameState.trumpSuit, gameState.trumpLevel);

  // 如果有同花色，跟最小的
  if (sameSuitCards.length > 0) {
    sameSuitCards.sort((a, b) =>
      evaluateCardValue(a, gameState.trumpSuit, gameState.trumpLevel) -
      evaluateCardValue(b, gameState.trumpSuit, gameState.trumpLevel)
    );

    // 如果首家出对牌，优先跟对牌
    if ((leadPattern.type === 'pair' || leadPattern.type === 'tractor') && sameSuitCards.length >= 2) {
      const pairs = findPairs(sameSuitCards);
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

    // 优先跟分牌（让队友得分）
    const pointCards = sameSuitCards.filter(c => POINT_CARDS[c.rank]);
    if (pointCards.length > 0) {
      candidates.push({
        cards: [pointCards[0]],
        score: 85,
        reason: '跟分牌给队友'
      });
    }

    // 跟最小的牌
    candidates.push({
      cards: [sameSuitCards[0]],
      score: 80,
      reason: '跟最小牌'
    });
  } else {
    // 没有同花色，垫其他牌
    // 优先垫分牌（避免被对手得分）
    const pointCards = otherCards.filter(c => POINT_CARDS[c.rank]);
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
    if (otherCards.length > 0) {
      otherCards.sort((a, b) =>
        evaluateCardValue(a, gameState.trumpSuit, gameState.trumpLevel) -
        evaluateCardValue(b, gameState.trumpSuit, gameState.trumpLevel)
      );
      candidates.push({
        cards: [otherCards[0]],
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
function selectTeammateLosingPlay(hand, leadCards, sameSuitCards, otherCards, gameState, analysis) {
  const candidates = [];
  const leadPattern = getCardPattern(leadCards, gameState.trumpSuit, gameState.trumpLevel);

  // 如果首家出拖拉机，优先考虑拖拉机
  if (leadPattern.type === 'tractor' && sameSuitCards.length >= 4) {
    const tractors = findTractors(sameSuitCards, gameState.trumpSuit, gameState.trumpLevel);
    const leadSuit = isTrump(leadCards[0], gameState.trumpSuit, gameState.trumpLevel) ? 'trump' : leadCards[0].suit;

    for (const tractor of tractors) {
      if (tractor.length < leadCards.length) continue;
      const canWin = isPlayBeating(
        tractor.slice(0, leadCards.length),
        leadCards,
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

  // 如果首家出对牌或拖拉机，考虑对牌
  if ((leadPattern.type === 'pair' || leadPattern.type === 'tractor') && sameSuitCards.length >= 2) {
    const pairs = findPairs(sameSuitCards);
    const leadSuit = isTrump(leadCards[0], gameState.trumpSuit, gameState.trumpLevel) ? 'trump' : leadCards[0].suit;

    for (const pair of pairs) {
      const canWin = isPlayBeating(
        pair,
        leadCards,
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
    const currentTrick = analysis.currentTrick || [];
    const leadSuit = isTrump(leadCards[0], gameState.trumpSuit, gameState.trumpLevel) ? 'trump' : leadCards[0].suit;

    const winningPlays = [];
    const losingPlays = [];

    for (const card of sameSuitCards) {
      const testPlay = [card];
      const canWin = isPlayBeating(
        testPlay,
        leadCards,
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
      // 选择最小的能赢的牌（节省实力）
      winningPlays.sort((a, b) => a.score - b.score);
      candidates.push(winningPlays[0]);
    }

    if (losingPlays.length > 0) {
      // 选择最小的牌
      losingPlays.sort((a, b) => a.score - b.score);
      candidates.push(losingPlays[0]);
    }
  } else {
    // 没有同花色，垫其他牌
    if (otherCards.length > 0) {
      otherCards.sort((a, b) =>
        evaluateCardValue(a, gameState.trumpSuit, gameState.trumpLevel) -
        evaluateCardValue(b, gameState.trumpSuit, gameState.trumpLevel)
      );
      candidates.push({
        cards: [otherCards[0]],
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
function selectOpponentLeadingButTeammateWinningPlay(hand, leadCards, sameSuitCards, otherCards, gameState, analysis) {
  const candidates = [];
  const leadPattern = getCardPattern(leadCards, gameState.trumpSuit, gameState.trumpLevel);

  if (sameSuitCards.length > 0) {
    // 如果首家出对牌，跟最小的对牌
    if ((leadPattern.type === 'pair' || leadPattern.type === 'tractor') && sameSuitCards.length >= 2) {
      const pairs = findPairs(sameSuitCards);
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

    // 跟最小的牌，不要出比队友大的牌
    sameSuitCards.sort((a, b) =>
      evaluateCardValue(a, gameState.trumpSuit, gameState.trumpLevel) -
      evaluateCardValue(b, gameState.trumpSuit, gameState.trumpLevel)
    );

    candidates.push({
      cards: [sameSuitCards[0]],
      score: 75,
      reason: '跟最小牌保护队友'
    });
  } else {
    // 没有同花色，垫牌
    if (otherCards.length > 0) {
      otherCards.sort((a, b) =>
        evaluateCardValue(a, gameState.trumpSuit, gameState.trumpLevel) -
        evaluateCardValue(b, gameState.trumpSuit, gameState.trumpLevel)
      );
      candidates.push({
        cards: [otherCards[0]],
        score: 70,
        reason: '垫牌保护队友'
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
function selectOpponentWinningPlay(hand, leadCards, sameSuitCards, otherCards, gameState, analysis) {
  const candidates = [];
  const leadPattern = getCardPattern(leadCards, gameState.trumpSuit, gameState.trumpLevel);

  // 如果首家出拖拉机，优先考虑拖拉机
  if (leadPattern.type === 'tractor' && sameSuitCards.length >= 4) {
    const tractors = findTractors(sameSuitCards, gameState.trumpSuit, gameState.trumpLevel);
    const leadSuit = isTrump(leadCards[0], gameState.trumpSuit, gameState.trumpLevel) ? 'trump' : leadCards[0].suit;

    for (const tractor of tractors) {
      if (tractor.length < leadCards.length) continue;
      const canWin = isPlayBeating(
        tractor.slice(0, leadCards.length),
        leadCards,
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

  // 如果首家出对牌或拖拉机，考虑对牌
  if ((leadPattern.type === 'pair' || leadPattern.type === 'tractor') && sameSuitCards.length >= 2) {
    const pairs = findPairs(sameSuitCards);
    const leadSuit = isTrump(leadCards[0], gameState.trumpSuit, gameState.trumpLevel) ? 'trump' : leadCards[0].suit;

    for (const pair of pairs) {
      const canWin = isPlayBeating(
        pair,
        leadCards,
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

    const winningPlays = [];
    const losingPlays = [];

    for (const card of sameSuitCards) {
      const testPlay = [card];
      const canWin = isPlayBeating(
        testPlay,
        leadCards,
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
      // 选择最小的能赢的牌（节省实力）
      winningPlays.sort((a, b) => a.score - b.score);
      candidates.push(winningPlays[0]);
    }

    if (losingPlays.length > 0) {
      // 选择最小的牌
      losingPlays.sort((a, b) => a.score - b.score);
      candidates.push(losingPlays[0]);
    }
  } else {
    // 没有同花色，优先考虑主牌将吃
    const trumps = otherCards.filter(c => isTrump(c, gameState.trumpSuit, gameState.trumpLevel));
    if (trumps.length > 0) {
      // 有主牌，可以将吃
      trumps.sort((a, b) =>
        evaluateCardValue(a, gameState.trumpSuit, gameState.trumpLevel) -
        evaluateCardValue(b, gameState.trumpSuit, gameState.trumpLevel)
      );
      candidates.push({
        cards: [trumps[0]],
        score: 80,
        reason: '主牌将吃'
      });
    }

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
function selectDefaultFollowPlay(hand, leadCards, sameSuitCards, otherCards, gameState, analysis) {
  const leadPattern = getCardPattern(leadCards, gameState.trumpSuit, gameState.trumpLevel);

  if (sameSuitCards.length > 0) {
    sameSuitCards.sort((a, b) =>
      evaluateCardValue(a, gameState.trumpSuit, gameState.trumpLevel) -
      evaluateCardValue(b, gameState.trumpSuit, gameState.trumpLevel)
    );

    // 如果首家出对牌，优先跟对牌
    if ((leadPattern.type === 'pair' || leadPattern.type === 'tractor') && sameSuitCards.length >= 2) {
      const pairs = findPairs(sameSuitCards);
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

  if (otherCards.length > 0) {
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
function selectBottomCards(hand, bottomCount, trumpSuit, trumpLevel, isDealer) {
  // 庄家扣底策略：保留大牌，扣掉危险牌
  const sorted = [...hand].sort((a, b) => {
    const aValue = _bottomRemovalPriority(a, trumpSuit, trumpLevel, hand);
    const bValue = _bottomRemovalPriority(b, trumpSuit, trumpLevel, hand);
    return bValue - aValue;
  });

  return sorted.slice(0, bottomCount);
}

function _bottomRemovalPriority(card, trumpSuit, trumpLevel, hand) {
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
    // 主牌尽量保留
    priority -= 50;
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
function decideBid(hand, trumpLevel) {
  const levelStr = String(trumpLevel);
  const levelCards = hand.filter(c => c.rank === levelStr && c.suit !== 'joker');
  const jokers = hand.filter(c => c.suit === 'joker');
  const bigJokers = jokers.filter(c => c.rank === 'big');

  // 按花色分组级牌
  const bySuit = {};
  for (const c of levelCards) {
    if (!bySuit[c.suit]) bySuit[c.suit] = [];
    bySuit[c.suit].push(c);
  }

  // 找到最好的花色
  let bestSuit = null;
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
    return bySuit[bestSuit].slice(0, 2);
  }

  // 用王反主
  if (bestCount >= 1 && jokers.length >= 1 && strength >= 30) {
    return [...bySuit[bestSuit].slice(0, 1), jokers[0]];
  }

  // 无主：2+王
  if (jokers.length >= 2 && strength >= 25) {
    return jokers.slice(0, 2);
  }

  return null;
}

// ==================== 主AI类 ====================

class AdvancedAI {
  constructor(seat, team, cardTracker) {
    this.seat = seat;
    this.team = team;
    this.cardTracker = cardTracker;
  }

  /**
   * 选择最佳出牌
   */
  selectBestPlay(hand, leadCards, gameState) {
    // 更新牌追踪器
    if (gameState.trumpSuit) {
      this.cardTracker.setTrump(gameState.trumpSuit, gameState.trumpLevel);
    }

    // 记录已出的牌
    for (const trick of gameState.tricks || []) {
      this.cardTracker.recordTrick(trick);
    }

    let selectedCards;

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
  generateFallbackCandidates(hand, leadCards, gameState) {
    const candidates = [];
    const leadPattern = leadCards ? getCardPattern(leadCards, gameState.trumpSuit, gameState.trumpLevel) : null;
    const leadIsTrump = leadCards ? isTrump(leadCards[0], gameState.trumpSuit, gameState.trumpLevel) : false;
    const leadSuit = leadIsTrump ? 'trump' : (leadCards ? leadCards[0].suit : null);

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

    // 从大到小尝试
    for (let i = sameSuitCards.length - 1; i >= 0; i--) {
      candidates.push([sameSuitCards[i]]);
    }

    // 从小到大尝试
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
  decideBid(gameState) {
    return decideBid(this.hand, gameState.trumpLevel);
  }

  /**
   * 扣底决策
   */
  decideBottom(gameState) {
    return selectBottomCards(
      this.hand,
      gameState.bottomCount || 8,
      gameState.trumpSuit,
      gameState.trumpLevel,
      this.team === gameState.players[gameState.dealer]?.team
    );
  }
}

module.exports = {
  AdvancedAI,
  evaluateCardValue,
  evaluateCardsValue,
  evaluateHandStrength,
  findPairs,
  findTractors,
  analyzeGameState,
  selectLeadPlay,
  selectFollowPlay,
  selectBottomCards,
  decideBid
};
