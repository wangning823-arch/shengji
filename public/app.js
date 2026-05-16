const App = {
  ws: null,
  user: null,
  roomId: null,
  seat: -1,
  gameState: null,
  selectedCards: new Set(),
  myHand: [],
  isReady: false,
  chatOpen: false,
  reconnectTimer: null,

  SUIT_SYMBOLS: { spade: '♠', heart: '♥', diamond: '♦', club: '♣', joker: '🃏' },
  SUIT_NAMES: { spade: '黑桃', heart: '红桃', diamond: '方块', club: '梅花' },
  RANK_ORDER: ['3','4','5','6','7','8','9','10','J','Q','K','A','2'],
  localCurrentTrick: [],

  init() {
    this.bindEvents();
    this.connect();
  },

  connect() {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    this.ws = new WebSocket(`${protocol}//${location.host}`);

    this.ws.onopen = () => {
      console.log('WS connected');
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
      if (this.user) {
        this.send({ type: 'auth', userId: this.user.id, nickname: this.user.nickname, avatar: this.user.avatar });
      }
    };

    this.ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        this.handleMessage(msg);
      } catch (err) {
        console.error('Invalid message', e.data);
      }
    };

    this.ws.onclose = () => {
      this.reconnectTimer = setTimeout(() => this.connect(), 3000);
    };

    this.ws.onerror = (err) => {
      console.error('WS error', err);
    };
  },

  send(msg) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  },

  bindEvents() {
    document.getElementById('btn-guest').onclick = () => this.loginGuest();
    document.getElementById('btn-wechat').onclick = () => alert('微信登录需要配置AppID');

    document.getElementById('btn-create-room').onclick = () => {
      document.getElementById('room-config-panel').classList.remove('hidden');
    };
    document.getElementById('btn-cancel-create').onclick = () => {
      document.getElementById('room-config-panel').classList.add('hidden');
    };
    document.getElementById('btn-confirm-create').onclick = () => {
      const deckCount = parseInt(document.getElementById('deck-count').value);
      this.send({ type: 'create_room', deckCount });
      document.getElementById('room-config-panel').classList.add('hidden');
    };

    document.getElementById('btn-join-room').onclick = () => {
      const code = document.getElementById('room-code-input').value.trim().toUpperCase();
      if (code) this.joinRoom(code);
    };

    document.getElementById('btn-leave-room').onclick = () => this.send({ type: 'leave_room' });
    document.getElementById('btn-ready').onclick = () => {
      this.isReady = !this.isReady;
      this.send({ type: 'ready', ready: this.isReady });
      document.getElementById('btn-ready').textContent = this.isReady ? '取消准备' : '准备';
    };
    document.getElementById('btn-add-ai').onclick = () => {
      console.log('Add AI button clicked');
      this.send({ type: 'add_ai' });
    };
    document.getElementById('btn-start').onclick = () => this.send({ type: 'start_game' });

    document.getElementById('btn-play').onclick = () => this.playCards();
    document.getElementById('btn-bid').onclick = () => this.bid();
    document.getElementById('btn-confirm-trump').onclick = () => this.send({ type: 'confirm_trump' });
    document.getElementById('btn-sort').onclick = () => this.sortHand();
    document.getElementById('btn-pass').onclick = () => {};

    document.getElementById('btn-toggle-chat').onclick = () => this.toggleChat();
    document.getElementById('btn-send-chat').onclick = () => this.sendChat();
    document.getElementById('chat-input').onkeydown = (e) => {
      if (e.key === 'Enter') this.sendChat();
    };

    document.getElementById('btn-rules').onclick = () => this.showRules();
    document.getElementById('btn-close-rules').onclick = () => this.hideRules();
    document.querySelector('.modal-overlay').onclick = () => this.hideRules();
  },

  async loginGuest() {
    try {
      const res = await fetch('/api/login/guest');
      const data = await res.json();
      this.user = data.user;
      localStorage.setItem('shengji_user', JSON.stringify(this.user));
      this.send({ type: 'auth', userId: this.user.id, nickname: this.user.nickname, avatar: this.user.avatar });
      this.showScreen('lobby-screen');
    } catch (err) {
      alert('登录失败');
    }
  },

  showScreen(id) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    document.getElementById(id).classList.add('active');
  },

  joinRoom(roomId) {
    this.roomId = roomId;
    this.send({ type: 'join_room', roomId });
  },

  handleMessage(msg) {
    switch (msg.type) {
      case 'auth_ok':
        break;

      case 'room_created':
        this.joinRoom(msg.roomId);
        break;

      case 'joined':
        this.seat = msg.seat;
        document.getElementById('room-id-display').textContent = '房间号: ' + this.roomId;
        this.showScreen('room-screen');
        break;

      case 'player_joined':
      case 'player_left':
      case 'player_ready':
      case 'room_state':
        if (msg.state) this.updateRoomState(msg.state);
        break;

      case 'game_started':
        this.myHand = msg.hand || [];
        this.localCurrentTrick = [];
        this.sortHand();
        this.gameState = msg.state;
        this.showScreen('game-screen');
        this.updateGameUI();
        document.getElementById('btn-bid').classList.remove('hidden');
        document.getElementById('btn-play').classList.add('hidden');
        document.getElementById('btn-confirm-trump').classList.add('hidden');
        break;

      case 'game_state':
        this.gameState = msg.state;
        this.updateGameUI();
        break;

      case 'turn_changed':
        this.updateTurn(msg.seat, msg.phase);
        break;

      case 'bid_made':
        this.showToast(`${this.getPlayerName(msg.seat)} 亮主 ${this.SUIT_NAMES[msg.trumpSuit] || '无主'}`);
        break;

      case 'trump_confirmed':
        this.showToast(`主牌: ${this.SUIT_NAMES[msg.trumpSuit] || '无主'}，打${msg.trumpLevel}`);
        document.getElementById('btn-bid').classList.add('hidden');
        document.getElementById('btn-confirm-trump').classList.add('hidden');
        break;

      case 'cards_played':
        if (msg.seat === this.seat) {
          const playedIds = msg.cards.map(c => c.id);
          this.myHand = this.myHand.filter(c => !playedIds.includes(c.id));
          this.selectedCards.clear();
          this.renderHand();
        }
        // 新轮开始（自己是首家），先清空
        if (this.localCurrentTrick.length === 0) {
          document.getElementById('trick-cards').innerHTML = '';
        }
        this.localCurrentTrick.push({ seat: msg.seat, cards: msg.cards });
        this.renderTrick();
        break;

      case 'trick_ended':
        this.showToast(`${this.getPlayerName(msg.winnerSeat)} 得 ${msg.points} 分`);
        setTimeout(() => {
          document.getElementById('trick-cards').innerHTML = '';
          this.localCurrentTrick = [];
        }, 1500);
        break;

      case 'game_ended':
        const dealerWon = msg.idleScore <= 75;
        this.showToast(`本局结束！${dealerWon ? '庄家胜' : '闲家胜'}，${msg.levels.team1} : ${msg.levels.team2}`);
        break;

      case 'chat':
        this.addChatMessage(msg.nickname, msg.message);
        break;

      case 'error':
        this.showToast(msg.message);
        break;
    }
  },

  updateRoomState(state) {
    document.querySelectorAll('.seat').forEach(el => {
      el.classList.remove('occupied', 'ready');
      el.querySelector('.seat-name').textContent = '等待中';
      el.querySelector('.seat-avatar').style.backgroundImage = '';
      el.querySelector('.seat-status').textContent = '';
    });

    let allReady = true;
    state.players.forEach(p => {
      const el = document.querySelector(`.seat[data-seat="${p.seat}"]`);
      if (el) {
        el.classList.add('occupied');
        if (p.ready) el.classList.add('ready');
        el.querySelector('.seat-name').textContent = p.nickname;
        el.querySelector('.seat-avatar').style.backgroundImage = p.avatar ? `url(${p.avatar})` : '';
        el.querySelector('.seat-status').textContent = p.ready ? '已准备' : '未准备';
      }
      if (!p.ready) allReady = false;
    });

    const isHost = state.players[0]?.userId === this.user?.id;
    const btnStart = document.getElementById('btn-start');
    if (isHost && state.players.length === 4 && allReady) {
      btnStart.classList.remove('hidden');
    } else {
      btnStart.classList.add('hidden');
    }
  },

  updateGameUI() {
    if (!this.gameState) return;

    const gs = this.gameState;
    document.getElementById('trump-info').textContent = '主牌: ' + (gs.trumpSuit ? this.SUIT_NAMES[gs.trumpSuit] : '无主');
    document.getElementById('level-info').textContent = '打: ' + gs.trumpLevel;
    document.getElementById('score-info').textContent = `得分: ${gs.scores.team1} - ${gs.scores.team2}`;

    gs.players.forEach(p => {
      const relSeat = this.getRelativeSeat(p.seat);
      const el = document.querySelector(`.player[data-seat="${relSeat}"]`);
      if (el) {
        el.querySelector('.player-name').textContent = p.userId === this.user?.id ? '我' : p.nickname;
        el.querySelector('.player-cards-count').textContent = p.handCount + '张';
      }
    });

    this.renderHand();
  },

  updateTurn(seat, phase) {
    document.querySelectorAll('.player').forEach(p => p.classList.remove('active'));
    const relSeat = this.getRelativeSeat(seat);
    const el = document.querySelector(`.player[data-seat="${relSeat}"]`);
    if (el) el.classList.add('active');

    const isMyTurn = seat === this.seat;

    if (phase === 'bidding') {
      document.getElementById('btn-bid').classList.toggle('hidden', !isMyTurn);
      document.getElementById('btn-confirm-trump').classList.toggle('hidden', !isMyTurn);
      document.getElementById('btn-play').classList.add('hidden');
    } else if (phase === 'playing') {
      document.getElementById('btn-bid').classList.add('hidden');
      document.getElementById('btn-confirm-trump').classList.add('hidden');
      document.getElementById('btn-play').classList.toggle('hidden', !isMyTurn);
    }
  },

  getRelativeSeat(seat) {
    return (seat - this.seat + 4) % 4;
  },

  getPlayerName(seat) {
    const rel = this.getRelativeSeat(seat);
    if (rel === 0) return '我';
    const names = ['', '下家', '对家', '上家'];
    return names[rel];
  },

  renderHand() {
    const container = document.getElementById('my-hand');
    container.innerHTML = '';

    for (const card of this.myHand) {
      const el = document.createElement('div');
      el.className = 'card ' + this.getCardColorClass(card);
      el.dataset.id = card.id;

      const rankDisplay = card.rank === 'small' ? '小王' : card.rank === 'big' ? '大王' : card.rank;
      const suitDisplay = this.SUIT_SYMBOLS[card.suit] || '';

      el.innerHTML = `
        <div class="suit-top">${rankDisplay}<br>${suitDisplay}</div>
        <div class="suit-bottom">${rankDisplay}<br>${suitDisplay}</div>
      `;

      if (this.selectedCards.has(card.id)) {
        el.classList.add('selected');
      }

      el.onclick = () => this.selectCard(card.id);
      container.appendChild(el);
    }
  },

  getCardColorClass(card) {
    if (card.suit === 'joker') return 'joker';
    if (card.suit === 'heart' || card.suit === 'diamond') return 'red';
    return 'black';
  },

  selectCard(cardId) {
    if (this.selectedCards.has(cardId)) {
      this.selectedCards.delete(cardId);
    } else {
      this.selectedCards.add(cardId);
    }
    this.renderHand();
  },

  sortHand() {
    const gs = this.gameState;
    const trumpSuit = gs?.trumpSuit;
    const trumpLevel = gs?.trumpLevel;

    const isTrump = (c) => {
      if (c.suit === 'joker') return true;
      if (c.rank === String(trumpLevel)) return true;
      if (trumpSuit && c.suit === trumpSuit && c.rank !== String(trumpLevel)) return true;
      return false;
    };

    const getTrumpRank = (c) => {
      if (c.suit === 'joker') return c.rank === 'big' ? 100 : 99;
      if (c.rank === String(trumpLevel)) {
        if (c.suit === trumpSuit) return 98;
        return 97;
      }
      return this.RANK_ORDER.indexOf(c.rank);
    };

    this.myHand.sort((a, b) => {
      const aT = isTrump(a);
      const bT = isTrump(b);
      if (aT && !bT) return -1;
      if (!aT && bT) return 1;
      if (aT && bT) return getTrumpRank(b) - getTrumpRank(a);

      const suitOrder = ['spade', 'heart', 'diamond', 'club'];
      const sDiff = suitOrder.indexOf(a.suit) - suitOrder.indexOf(b.suit);
      if (sDiff !== 0) return sDiff;
      return this.RANK_ORDER.indexOf(b.rank) - this.RANK_ORDER.indexOf(a.rank);
    });

    this.renderHand();
  },

  bid() {
    if (!this.gameState || this.gameState.status !== 'bidding') return;

    const selected = this.myHand.filter(c => this.selectedCards.has(c.id));
    if (selected.length === 0) {
      this.showToast('请选择要亮的牌');
      return;
    }

    this.send({ type: 'bid', cards: selected.map(c => ({ id: c.id, suit: c.suit, rank: c.rank })) });
    this.selectedCards.clear();
    this.renderHand();
  },

  playCards() {
    if (this.selectedCards.size === 0) {
      this.showToast('请选择要出的牌');
      return;
    }

    const cardIds = Array.from(this.selectedCards);
    this.send({ type: 'play', cardIds });
    this.selectedCards.clear();
  },

  renderTrick() {
    const container = document.getElementById('trick-cards');
    container.innerHTML = '';

    // 按座位顺序排列：自己(0)、下家(1)、对家(2)、上家(3)
    const ordered = [];
    for (let rel = 0; rel < 4; rel++) {
      const absSeat = (this.seat + rel) % 4;
      const play = this.localCurrentTrick.find(p => p.seat === absSeat);
      if (play) ordered.push(play);
    }

    for (const play of ordered) {
      for (const card of play.cards) {
        const el = document.createElement('div');
        el.className = 'card ' + this.getCardColorClass(card);
        const rankDisplay = card.rank === 'small' ? '小王' : card.rank === 'big' ? '大王' : card.rank;
        const suitDisplay = this.SUIT_SYMBOLS[card.suit] || '';
        el.innerHTML = `
          <div class="suit-top">${rankDisplay}<br>${suitDisplay}</div>
          <div class="suit-bottom">${rankDisplay}<br>${suitDisplay}</div>
        `;
        container.appendChild(el);
      }
    }
  },

  toggleChat() {
    this.chatOpen = !this.chatOpen;
    document.getElementById('chat-panel').classList.toggle('hidden', !this.chatOpen);
  },

  sendChat() {
    const input = document.getElementById('chat-input');
    const text = input.value.trim();
    if (!text) return;
    this.send({ type: 'chat', message: text });
    input.value = '';
  },

  addChatMessage(nickname, message) {
    const container = document.getElementById('chat-messages');
    const el = document.createElement('div');
    el.className = 'chat-msg';
    el.innerHTML = `<span class="sender">${nickname}</span>${message}`;
    container.appendChild(el);
    container.scrollTop = container.scrollHeight;
  },

  showToast(message) {
    const toast = document.createElement('div');
    toast.style.cssText = `
      position: fixed; top: 20%; left: 50%; transform: translateX(-50%);
      background: rgba(0,0,0,0.8); color: #fff; padding: 12px 24px;
      border-radius: 8px; font-size: 14px; z-index: 100; pointer-events: none;
    `;
    toast.textContent = message;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 2500);
  },

  markdownToHtml(md) {
    let html = md;
    // code blocks
    html = html.replace(/```[\s\S]*?```/g, m => `<pre>${m.slice(3, -3).trim()}</pre>`);
    // headers
    html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
    html = html.replace(/^## (.+)$/gm, '<h3>$1</h3>');
    html = html.replace(/^# (.+)$/gm, '<h3>$1</h3>');
    // bold
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    // tables
    const lines = html.split('\n');
    let inTable = false;
    let tableHtml = '';
    const outLines = [];
    for (const line of lines) {
      if (line.startsWith('|')) {
        const cells = line.split('|').slice(1, -1).map(c => c.trim());
        if (!inTable) {
          inTable = true;
          tableHtml = '<table><thead><tr>' + cells.map(c => `<th>${c}</th>`).join('') + '</tr></thead><tbody>';
        } else if (cells.every(c => c.replace(/-/g, '').trim() === '')) {
          // separator line, skip
        } else {
          tableHtml += '<tr>' + cells.map(c => `<td>${c}</td>`).join('') + '</tr>';
        }
      } else {
        if (inTable) {
          tableHtml += '</tbody></table>';
          outLines.push(tableHtml);
          inTable = false;
          tableHtml = '';
        }
        outLines.push(line);
      }
    }
    if (inTable) {
      tableHtml += '</tbody></table>';
      outLines.push(tableHtml);
    }
    html = outLines.join('\n');
    // lists
    html = html.replace(/^(\s*)- (.+)$/gm, '<li>$2</li>');
    html = html.replace(/(<li>.+<\/li>\n?)+/g, m => `<ul>${m}</ul>`);
    // paragraphs
    html = html.replace(/\n\n+/g, '\n\n');
    html = html.split('\n\n').map(p => {
      p = p.trim();
      if (!p) return '';
      if (p.startsWith('<')) return p;
      return `<p>${p}</p>`;
    }).join('\n');
    return html;
  },

  async showRules() {
    const modal = document.getElementById('rules-modal');
    const body = document.getElementById('rules-body');
    modal.classList.remove('hidden');
    if (!this._rulesLoaded) {
      try {
        const res = await fetch('RULES.md');
        const md = await res.text();
        body.innerHTML = this.markdownToHtml(md);
        this._rulesLoaded = true;
      } catch (e) {
        body.innerHTML = '<p>规则加载失败，请刷新重试</p>';
      }
    }
  },

  hideRules() {
    document.getElementById('rules-modal').classList.add('hidden');
  }
};

// 启动
const saved = localStorage.getItem('shengji_user');
if (saved) {
  App.user = JSON.parse(saved);
  App.showScreen('lobby-screen');
}
App.init();
