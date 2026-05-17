const App = {
  ws: null,
  user: null,
  roomId: null,
  seat: -1,
  gameState: null,
  selectedCards: new Set(),
  myHand: [],
  isReady: false,
  isSitting: false,
  chatOpen: false,
  reconnectTimer: null,
  roomListRefreshTimer: null,

  SUIT_SYMBOLS: { spade: '♠', heart: '♥', diamond: '♦', club: '♣', joker: '🃏' },
  SUIT_NAMES: { spade: '黑桃', heart: '红桃', diamond: '方块', club: '梅花' },
  RANK_ORDER: ['3','4','5','6','7','8','9','10','J','Q','K','A','2'],
  localCurrentTrick: [],

  SEAT_LABELS: ['北', '东', '南', '西'],

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

    // 昵称输入回车登录
    document.getElementById('nickname-input').onkeydown = (e) => {
      if (e.key === 'Enter') this.loginGuest();
    };

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

    document.getElementById('btn-leave-room').onclick = () => {
      this.send({ type: 'leave_room' });
      this.isSitting = false;
      this.isReady = false;
      this.seat = -1;
      this.roomId = null;
      this.showScreen('lobby-screen');
    };

    document.getElementById('btn-logout').onclick = () => this.logout();

    document.getElementById('btn-ready').onclick = () => {
      this.isReady = !this.isReady;
      this.send({ type: 'ready', ready: this.isReady });
      document.getElementById('btn-ready').textContent = this.isReady ? '取消准备' : '准备';
    };

    document.getElementById('btn-add-ai').onclick = () => {
      this.send({ type: 'add_ai' });
    };

    document.getElementById('btn-start').onclick = () => this.send({ type: 'start_game' });

    // 座位点击事件
    document.querySelectorAll('.seat').forEach(el => {
      el.onclick = () => {
        const seatNum = parseInt(el.dataset.seat);
        this.onSeatClick(seatNum);
      };
    });

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
    const nicknameInput = document.getElementById('nickname-input');
    const nickname = nicknameInput.value.trim();

    try {
      const res = await fetch('/api/login/guest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nickname: nickname || '' })
      });
      const data = await res.json();
      this.user = data.user;
      localStorage.setItem('shengji_user', JSON.stringify(this.user));
      this.send({ type: 'auth', userId: this.user.id, nickname: this.user.nickname, avatar: this.user.avatar });
      this.updateLobbyUserInfo();
      this.showScreen('lobby-screen');
      this.startRoomListRefresh();
    } catch (err) {
      alert('登录失败');
    }
  },

  updateLobbyUserInfo() {
    if (this.user) {
      document.getElementById('user-nickname').textContent = this.user.nickname;
      if (this.user.avatar) {
        document.getElementById('user-avatar').style.backgroundImage = `url(${this.user.avatar})`;
      }
    }
  },

  logout() {
    this.stopRoomListRefresh();
    if (this.roomId) {
      this.send({ type: 'leave_room' });
    }
    this.user = null;
    this.roomId = null;
    this.seat = -1;
    this.isSitting = false;
    this.isReady = false;
    this.gameState = null;
    this.myHand = [];
    this.selectedCards.clear();
    localStorage.removeItem('shengji_user');
    document.getElementById('nickname-input').value = '';
    this.showScreen('login-screen');
  },

  // 房间列表相关
  startRoomListRefresh() {
    this.stopRoomListRefresh();
    this.fetchRoomList();
    this.roomListRefreshTimer = setInterval(() => this.fetchRoomList(), 5000);
  },

  stopRoomListRefresh() {
    if (this.roomListRefreshTimer) {
      clearInterval(this.roomListRefreshTimer);
      this.roomListRefreshTimer = null;
    }
  },

  async fetchRoomList() {
    try {
      const res = await fetch('/api/rooms');
      const data = await res.json();
      this.renderRoomList(data.rooms || []);
    } catch (err) {
      console.error('Failed to fetch room list', err);
    }
  },

  renderRoomList(rooms) {
    const container = document.getElementById('room-list');
    if (rooms.length === 0) {
      container.innerHTML = '<p class="empty-hint">暂无等待中的房间</p>';
      return;
    }

    container.innerHTML = rooms.map(r => `
      <div class="room-item" data-room-id="${r.id}">
        <div class="room-item-info">
          <span class="room-item-id">${r.id}</span>
          <span class="room-item-host">${r.host}</span>
        </div>
        <div class="room-item-meta">
          <span class="room-item-deck">${r.deckCount}副牌</span>
          <span class="room-item-players">${r.totalPlayers}/4人${r.aiCount > 0 ? ` (AI${r.aiCount})` : ''}</span>
        </div>
        <button class="btn small primary room-join-btn" data-room-id="${r.id}">加入</button>
      </div>
    `).join('');

    container.querySelectorAll('.room-join-btn').forEach(btn => {
      btn.onclick = (e) => {
        e.stopPropagation();
        const roomId = btn.dataset.roomId;
        this.joinRoom(roomId);
      };
    });
  },

  showScreen(id) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    document.getElementById(id).classList.add('active');

    if (id === 'lobby-screen') {
      this.startRoomListRefresh();
    } else {
      this.stopRoomListRefresh();
    }
  },

  joinRoom(roomId) {
    this.roomId = roomId;
    this.send({ type: 'join_room', roomId });
  },

  onSeatClick(seatNum) {
    if (!this.roomId) return;

    // 如果自己还没坐下，点击空座位坐下
    if (!this.isSitting) {
      this.send({ type: 'join_room', roomId: this.roomId, seat: seatNum });
      return;
    }

    // 如果已经坐下了，点击自己的座位不做任何事
    if (this.seat === seatNum) return;

    // 点击其他空座位，换座
    this.send({ type: 'sit_seat', seat: seatNum });
  },

  handleMessage(msg) {
    switch (msg.type) {
      case 'auth_ok':
        break;

      case 'room_list':
        this.renderRoomList(msg.rooms);
        break;

      case 'room_created':
        this.joinRoom(msg.roomId);
        break;

      case 'joined':
        this.seat = msg.seat;
        this.isSitting = true;
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
    const btnReady = document.getElementById('btn-ready');
    let myPlayer = null;
    let playerCount = 0;
    let allReady = true;

    document.querySelectorAll('.seat').forEach(el => {
      const seatNum = parseInt(el.dataset.seat);
      const player = state.players[seatNum];
      const seatAction = el.querySelector('.seat-action');

      el.classList.remove('occupied', 'ready', 'my-seat');

      if (player) {
        el.classList.add('occupied');
        if (player.ready) el.classList.add('ready');
        if (player.userId === this.user?.id) {
          el.classList.add('my-seat');
          myPlayer = player;
        }
        el.querySelector('.seat-name').textContent = player.nickname + (player.isAI ? ' 🤖' : '');
        el.querySelector('.seat-avatar').style.backgroundImage = player.avatar && !player.isAI ? `url(${player.avatar})` : '';
        el.querySelector('.seat-status').textContent = player.ready ? '已准备' : '未准备';
        if (seatAction) seatAction.classList.add('hidden');
        playerCount++;
        if (!player.ready) allReady = false;
      } else {
        el.querySelector('.seat-name').textContent = '空闲';
        el.querySelector('.seat-avatar').style.backgroundImage = '';
        el.querySelector('.seat-status').textContent = this.SEAT_LABELS[seatNum] + '位';
        // 显示坐下按钮（仅空座位且自己没坐下，或者自己已坐下可以换座）
        if (seatAction) {
          if (!this.isSitting || (this.isSitting && this.seat !== seatNum)) {
            seatAction.classList.remove('hidden');
            seatAction.textContent = this.isSitting ? '换座' : '坐下';
          } else {
            seatAction.classList.add('hidden');
          }
        }
      }
    });

    // 更新准备按钮和开始按钮的状态
    if (myPlayer) {
      btnReady.classList.remove('hidden');
      btnReady.textContent = myPlayer.ready ? '取消准备' : '准备';
      this.isReady = myPlayer.ready;
    } else {
      btnReady.classList.add('hidden');
      this.isReady = false;
    }

    const isHost = state.players.find(p => p !== null)?.userId === this.user?.id;
    const btnStart = document.getElementById('btn-start');
    if (isHost && playerCount === 4 && allReady) {
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
    html = html.replace(/```[\s\S]*?```/g, m => `<pre>${m.slice(3, -3).trim()}</pre>`);
    html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
    html = html.replace(/^## (.+)$/gm, '<h3>$1</h3>');
    html = html.replace(/^# (.+)$/gm, '<h3>$1</h3>');
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
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
          // skip separator
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
    html = html.replace(/^(\s*)- (.+)$/gm, '<li>$2</li>');
    html = html.replace(/(<li>.+<\/li>\n?)+/g, m => `<ul>${m}</ul>`);
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
  App.updateLobbyUserInfo();
  App.showScreen('lobby-screen');
}
App.init();
