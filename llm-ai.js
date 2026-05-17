const { LLMClient } = require('./llm-client');
const { validatePlay, getCardPattern, isTrump, compareCards } = require('./game');

const SUIT_SYMBOLS = { spade: '♠', heart: '♥', diamond: '♦', club: '♣', joker: '🃏' };
const SUIT_NAMES = { spade: '黑桃', heart: '红桃', diamond: '方块', club: '梅花' };

class CardTracker {
  constructor(deckCount = 2) {
    this.deckCount = deckCount;
    this.playedCards = new Set();
    this.playedBySuit = { spade: [], heart: [], diamond: [], club: [], joker: [] };
    this.totalPoints = deckCount * 100;
    this.playedPoints = 0;
  }

  recordPlayedCards(cards) {
    for (const card of cards) {
      if (!this.playedCards.has(card.id)) {
        this.playedCards.add(card.id);
        this.playedBySuit[card.suit].push(card);
        if (card.rank === '5') this.playedPoints += 5;
        else if (card.rank === '10' || card.rank === 'K') this.playedPoints += 10;
      }
    }
  }

  getRemainingPoints() {
    return this.totalPoints - this.playedPoints;
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

    // 选项1：出单张大牌
    const sortedHand = [...hand].sort((a, b) => this.cardStrength(b, a, trumpSuit, trumpLevel));
    if (sortedHand.length > 0) {
      candidates.push({
        cards: [sortedHand[0]],
        description: '出单张大牌'
      });
    }

    // 选项2：出单张小牌
    if (sortedHand.length > 1) {
      candidates.push({
        cards: [sortedHand[sortedHand.length - 1]],
        description: '出单张小牌'
      });
    }

    // 选项3：出对子（如果有）
    const pairs = this.findPairs(hand);
    if (pairs.length > 0) {
      candidates.push({
        cards: pairs[0],
        description: '出对子'
      });
    }

    // 选项4：出分牌（如果有）
    const pointCards = hand.filter(c => ['5', '10', 'K'].includes(c.rank));
    if (pointCards.length > 0) {
      candidates.push({
        cards: [pointCards[0]],
        description: '出分牌'
      });
    }

    return candidates.length > 0 ? candidates : [{ cards: [hand[0]], description: '随便出一张' }];
  }

  static generateFollowCandidates(hand, leadCards, trumpSuit, trumpLevel) {
    const candidates = [];
    const leadPattern = getCardPattern(leadCards, trumpSuit, trumpLevel);

    // 找出所有合法的出牌组合
    const validPlays = this.findAllValidPlays(hand, leadCards, trumpSuit, trumpLevel);

    if (validPlays.length === 0) {
      return [{ cards: [hand[0]], description: '随便出一张' }];
    }

    // 选项1：出最小的合法牌
    const minPlay = validPlays.sort((a, b) => {
      const aMax = Math.max(...a.map(c => this.cardStrengthValue(c, trumpSuit, trumpLevel)));
      const bMax = Math.max(...b.map(c => this.cardStrengthValue(c, trumpSuit, trumpLevel)));
      return aMax - bMax;
    })[0];
    candidates.push({ cards: minPlay, description: leadPattern.type === 'pair' ? '跟最小的对子' : '跟最小的牌' });

    // 选项2：出能赢的最大牌（如果有）
    const winningPlays = validPlays.filter(play => {
      return this.canWin(play, leadCards, trumpSuit, trumpLevel);
    });
    if (winningPlays.length > 0) {
      const maxWinPlay = winningPlays.sort((a, b) => {
        const aMax = Math.max(...a.map(c => this.cardStrengthValue(c, trumpSuit, trumpLevel)));
        const bMax = Math.max(...b.map(c => this.cardStrengthValue(c, trumpSuit, trumpLevel)));
        return bMax - aMax;
      })[0];
      candidates.push({ cards: maxWinPlay, description: leadPattern.type === 'pair' ? '出能赢的最大对子' : '出能赢的最大牌' });
    }

    // 选项3：出分牌（如果有）
    const pointPlays = validPlays.filter(play => play.some(c => ['5', '10', 'K'].includes(c.rank)));
    if (pointPlays.length > 0) {
      candidates.push({ cards: pointPlays[0], description: '出分牌' });
    }

    return candidates.length > 0 ? candidates : [{ cards: validPlays[0], description: '跟牌' }];
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
    // 简化：返回空数组，由上层处理
    return [];
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
    if (card.rank === String(trumpLevel)) {
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
    // 简化判断：比较最大的牌
    const leadMax = Math.max(...leadCards.map(c => this.cardStrengthValue(c, trumpSuit, trumpLevel)));
    const playMax = Math.max(...play.map(c => this.cardStrengthValue(c, trumpSuit, trumpLevel)));
    return playMax > leadMax;
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
    const levelCards = hand.filter(c => c.rank === String(trumpLevel));
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
    // 选最弱的牌扣底：先按牌力排序，取最弱的
    const sorted = [...hand].sort((a, b) => {
      return CandidateGenerator.cardStrengthValue(a, trumpSuit, trumpLevel) -
             CandidateGenerator.cardStrengthValue(b, trumpSuit, trumpLevel);
    });
    return sorted.slice(0, bottomCount);
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
  }

  async decideBid(gameState) {
    // 亮主决策：先用规则AI，有LLM可以优化
    const bid = FallbackAI.decideBid(this.hand, gameState.trumpLevel);
    return bid;
  }

  async decideBottom(gameState) {
    return FallbackAI.decideBottom(
      this.hand,
      gameState.bottomCount || 8,
      gameState.trumpSuit,
      gameState.trumpLevel
    );
  }

  async decidePlay(gameState, leadCards) {
    // 记录已出牌
    for (const trick of gameState.tricks || []) {
      this.cardTracker.recordPlayedCards(trick.cards || []);
    }

    if (!this.useLLM) {
      return FallbackAI.selectBestValid(this.hand, leadCards, gameState);
    }

    try {
      return await this.decideWithLLM(gameState, leadCards);
    } catch (err) {
      console.error('LLM error, using fallback:', err);
      return FallbackAI.selectBestValid(this.hand, leadCards, gameState);
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

module.exports = { LLMAIPlayer, FallbackAI, CandidateGenerator, CardTracker };
