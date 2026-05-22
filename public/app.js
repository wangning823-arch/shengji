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
  playedHistory: [],
  historyViewMode: 'all', // 'all' | 'rounds'
  rebidPhase: false,

  SEAT_LABELS: ['北', '东', '南', '西'],

  getRankFromLevel(level) {
    if (level === 2) return '2';
    return this.RANK_ORDER[level - 3] || String(level);
  },

  init() {
    this.bindEvents();
    this.connect();
    this.detectMobile();
    window.addEventListener('orientationchange', () => this.handleOrientationChange());
    window.addEventListener('resize', () => this.handleOrientationChange());
    this.setupHandDrag();
  },

  isMobile: false,

  detectMobile() {
    this.isMobile = /Android|iPhone|iPad|iPod|webOS|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent) ||
      ('ontouchstart' in window && window.innerWidth <= 1024);
  },

  requestGameFullscreen() {
    if (!this.isMobile) return;
    // 避免短时间内重复请求
    if (this._fullscreenRequested) return;
    this._fullscreenRequested = true;
    setTimeout(() => { this._fullscreenRequested = false; }, 2000);
    try {
      const el = document.documentElement;
      const req = el.requestFullscreen || el.webkitRequestFullscreen || el.mozRequestFullScreen || el.msRequestFullscreen;
      if (req) req.call(el);
    } catch (e) {}
    // 尝试锁定横屏
    if (screen.orientation && screen.orientation.lock) {
      screen.orientation.lock('landscape').catch(() => {});
    }
    document.body.classList.add('mobile-game');
    // 延迟检测方向是否成功
    setTimeout(() => this.checkOrientation(), 500);
  },

  setupOneTimeFullscreenTrigger() {
    if (!this.isMobile) return;
    const gameScreen = document.getElementById('game-screen');
    if (!gameScreen) return;
    // 如果已经在全屏，不需要
    if (document.fullscreenElement || document.webkitFullscreenElement) return;

    const handler = (e) => {
      // 排除按钮点击，避免干扰游戏操作
      if (e.target.tagName === 'BUTTON' || e.target.closest('button')) return;
      this.requestGameFullscreen();
      gameScreen.removeEventListener('click', handler);
      gameScreen.removeEventListener('touchstart', handler);
    };
    gameScreen.addEventListener('click', handler);
    gameScreen.addEventListener('touchstart', handler);
  },

  exitGameFullscreen() {
    if (document.body.classList.contains('mobile-game')) {
      if (document.fullscreenElement || document.webkitFullscreenElement) {
        try { document.exitFullscreen(); } catch (e) {}
      }
      if (screen.orientation && screen.orientation.unlock) {
        screen.orientation.unlock().catch(() => {});
      }
      document.body.classList.remove('mobile-game');
    }
    this.hideRotateHint();
  },

  handleOrientationChange() {
    const gameScreen = document.getElementById('game-screen');
    if (!gameScreen || !gameScreen.classList.contains('active')) return;
    // 延迟等待方向变化完成
    setTimeout(() => this.checkOrientation(), 200);
  },

  checkOrientation() {
    const gameScreen = document.getElementById('game-screen');
    if (!gameScreen || !gameScreen.classList.contains('active')) return;
    // 手机上始终应用 mobile-game 类
    if (this.isMobile) {
      document.body.classList.add('mobile-game');
    }
    // 游戏结束显示结果时，不提示旋转
    const resultOverlay = document.getElementById('game-result-overlay');
    if (resultOverlay && !resultOverlay.classList.contains('hidden')) return;
    const isPortrait = window.innerHeight > window.innerWidth;
    if (isPortrait && this.isMobile) {
      this.showRotateHint();
    } else {
      this.hideRotateHint();
    }
  },

  showRotateHint() {
    let el = document.getElementById('rotate-hint');
    if (!el) {
      el = document.createElement('div');
      el.id = 'rotate-hint';
      el.textContent = '横屏体验更佳';
      document.body.appendChild(el);
    }
    el.style.display = 'flex';
    // 3秒后自动隐藏
    if (this._rotateHintTimer) clearTimeout(this._rotateHintTimer);
    this._rotateHintTimer = setTimeout(() => this.hideRotateHint(), 3000);
  },

  hideRotateHint() {
    const el = document.getElementById('rotate-hint');
    if (el) el.style.display = 'none';
  },

  setupHandDrag() {
    const hand = document.getElementById('my-hand');
    if (!hand) return;
    let isDragging = false;
    let startX = 0;
    let scrollLeft = 0;
    const getPos = (e) => e.touches ? e.touches[0].pageX : e.pageX;
    const onStart = (e) => {
      isDragging = true;
      startX = getPos(e);
      scrollLeft = hand.scrollLeft;
      hand.style.cursor = 'grabbing';
    };
    const onMove = (e) => {
      if (!isDragging) return;
      const x = getPos(e);
      hand.scrollLeft = scrollLeft - (x - startX);
    };
    const onEnd = () => {
      isDragging = false;
      hand.style.cursor = 'grab';
    };
    hand.addEventListener('mousedown', onStart);
    hand.addEventListener('mousemove', onMove);
    hand.addEventListener('mouseup', onEnd);
    hand.addEventListener('mouseleave', onEnd);
    hand.addEventListener('touchstart', onStart, { passive: true });
    hand.addEventListener('touchmove', onMove, { passive: true });
    hand.addEventListener('touchend', onEnd);
    hand.style.cursor = 'grab';
  },

  // 横屏触摸展开：触摸某张牌时，附近牌临时展开
  _touchExpandActive: false,
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
        // 检查是否有未完成的游戏，自动重连
        const savedGame = localStorage.getItem('shengji_game');
        if (savedGame) {
          const { roomId, seat } = JSON.parse(savedGame);
          if (roomId) {
            this.roomId = roomId;
            this.send({ type: 'join_room', roomId, seat });
          }
        }
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
      this.exitGameFullscreen();
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
    document.getElementById('btn-pass-rebid').onclick = () => this.send({ type: 'pass_rebid' });
    document.getElementById('btn-sort').onclick = () => this.sortHand();
    document.getElementById('btn-pass').onclick = () => this.send({ type: 'pass_bid' });

    document.getElementById('btn-toggle-chat').onclick = () => this.toggleChat();
    document.getElementById('btn-send-chat').onclick = () => this.sendChat();
    document.getElementById('chat-input').onkeydown = (e) => {
      if (e.key === 'Enter') this.sendChat();
    };

    document.getElementById('btn-rules').onclick = () => this.showRules();
    document.getElementById('btn-close-rules').onclick = () => this.hideRules();

    document.getElementById('btn-set-bottom').onclick = () => this.setBottom();
    document.getElementById('btn-next-game').onclick = () => this.send({ type: 'next_game_ready' });
    document.getElementById('btn-exit-game').onclick = () => {
      if (confirm('确定要退出游戏吗？')) {
        this.send({ type: 'leave_game' });
      }
    };
    document.getElementById('btn-played-history').onclick = () => this.showPlayedHistory();
    document.getElementById('btn-close-history').onclick = () => this.hidePlayedHistory();
    document.getElementById('btn-toggle-history-view').onclick = () => this.toggleHistoryView();

    document.getElementById('btn-view-bottom').onclick = () => this.showBottomCards();
    document.getElementById('btn-close-bottom').onclick = () => this.hideBottomCards();

    document.getElementById('btn-bid-history').onclick = () => this.showBidHistory();
    document.getElementById('btn-close-bid-history').onclick = () => this.hideBidHistory();
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
        localStorage.setItem('shengji_game', JSON.stringify({ roomId: this.roomId, seat: this.seat }));
        document.getElementById('room-id-display').textContent = '房间号: ' + this.roomId;
        this.showScreen('room-screen');
        break;

      case 'player_joined':
      case 'player_left':
      case 'player_ready':
      case 'room_state':
        if (msg.state) this.updateRoomState(msg.state);
        break;

      case 'player_offline':
        this.showToast(`${msg.nickname} 掉线了，等待重连...`);
        break;

      case 'player_reconnected':
        this.showToast(`${msg.nickname} 已重连`);
        break;

      case 'game_started':
        this.rebidPhase = false;
        this.myHand = msg.hand || [];
        this.localCurrentTrick = [];
        this.playedHistory = msg.state?.tricks || [];
        this.bottomCards = [];
        this.gameState = msg.state;
        this.clearTrickArea();
        document.getElementById('trick-winner').textContent = '';
        document.getElementById('game-result-overlay').classList.add('hidden');
        // 保存游戏信息用于重连
        if (msg.seat !== undefined) {
          this.seat = msg.seat;
          localStorage.setItem('shengji_game', JSON.stringify({ roomId: this.roomId, seat: this.seat }));
        }
        this.showScreen('game-screen');
        // 手机上始终应用 mobile-game 类
        if (this.isMobile) {
          document.body.classList.add('mobile-game');
        }
        this.requestGameFullscreen();
        this.setupOneTimeFullscreenTrigger();
        this.updateGameUI();
        break;

      case 'cards_dealt':
        this.myHand = msg.hand || [];
        this.sortHand();
        break;

      case 'game_state':
        this.gameState = msg.state;
        if (this.gameState.bottomCards) {
          this.bottomCards = this.gameState.bottomCards;
        }
        // 从服务端完整 tricks 恢复已出牌记录（重连时）
        if (msg.state?.tricks) {
          this.playedHistory = msg.state.tricks;
        }
        this.updateGameUI();
        break;

      case 'turn_changed':
        if (msg.bids && this.gameState) {
          this.gameState.bids = msg.bids;
        }
        this.updateTurn(msg.seat, msg.phase, msg.rebidPhase);
        break;

      case 'rebid_phase':
        this.showToast('有人亮主，等待反主...');
        break;

      case 'rebid_timer':
        this.showRebidTimer(msg.seconds);
        break;

      case 'rebid_notification':
        this.showRebidNotification(msg);
        break;

      case 'rebid_confirmed':
        this.updateRebidConfirmation(msg);
        break;

      case 'no_bid_notification':
        this.showNoBidNotification(msg);
        break;

      case 'no_bid_confirmed':
        this.updateNoBidConfirmation(msg);
        break;

      case 'bid_made':
        this.showToast(`${this.getPlayerName(msg.seat)} 亮主 ${this.SUIT_NAMES[msg.trumpSuit] || '无主'}`);
        break;

      case 'trump_confirmed':
        this.showToast(`主牌: ${this.SUIT_NAMES[msg.trumpSuit] || '无主'}，打${msg.trumpLevel}`);
        document.getElementById('btn-bid').classList.add('hidden');
        // 更新主牌信息并重新排序手牌
        if (this.gameState) {
          this.gameState.trumpSuit = msg.trumpSuit;
          this.gameState.trumpLevel = msg.trumpLevel;
        }
        this.sortHand();
        break;

      case 'bottom_taken':
        this.showToast(`${this.getPlayerName(msg.dealer)} 拿底牌 (${msg.bottomCount}张)`);
        break;

      case 'bottom_set':
        this.showToast(`${this.getPlayerName(msg.dealer)} 已扣底`);
        document.getElementById('btn-set-bottom').classList.add('hidden');
        // 保留 bottomCards 以便庄家随时查看
        break;

      case 'cards_played':
        if (msg.seat === this.seat) {
          const playedIds = msg.cards.map(c => c.id);
          this.myHand = this.myHand.filter(c => !playedIds.includes(c.id));
          this.selectedCards.clear();
          this.renderHand();
        }
        // 新一轮首张牌：清空出牌区
        if (this.localCurrentTrick.length === 0) {
          this.clearTrickArea();
        }
        // 如果上一轮延时清空还没执行，强制清空后重新开始
        if (this._trickClearTimer) {
          clearTimeout(this._trickClearTimer);
          this._trickClearTimer = null;
          this.clearTrickArea();
          this.localCurrentTrick = [];
        }
        this.localCurrentTrick.push({ seat: msg.seat, cards: msg.cards });
        this.renderTrick();
        break;

      case 'trick_ended':
        // 只有闲家赢且有得分时才显示分数提示，庄家赢不显示
        if (msg.points > 0 && this.gameState) {
          const dealerSeat = this.gameState.dealer;
          const dealerTeam = this.gameState.players[dealerSeat]?.team;
          if (msg.winnerTeam !== dealerTeam) {
            this.showToast(`${this.getPlayerName(msg.winnerSeat)} 得 ${msg.points} 分`);
          }
        }
        // 保存本轮记录到历史
        if (this.localCurrentTrick.length > 0) {
          this.playedHistory.push({
            plays: [...this.localCurrentTrick],
            winnerSeat: msg.winnerSeat,
            winnerTeam: msg.winnerTeam,
            points: msg.points
          });
        }
        // 1.5秒后清空出牌区，如果新一轮出牌先到达则取消
        this._trickClearTimer = setTimeout(() => {
          this._trickClearTimer = null;
          this.clearTrickArea();
          this.localCurrentTrick = [];
        }, 1500);
        break;

      case 'game_ended':
        this.rebidPhase = false;
        console.log(`[GAME_ENDED] idleScore=${msg.idleScore} scores=${JSON.stringify(msg.scores)} dealerTeam=${msg.dealerTeam} winner=${msg.winner}`);
        // 取消 trick 清空定时器，让最后一轮出牌保持可见
        if (this._trickClearTimer) {
          clearTimeout(this._trickClearTimer);
          this._trickClearTimer = null;
        }
        // 延迟显示结果，让用户看到最后一墩的牌
        setTimeout(() => {
          this.showGameResult(msg);
          this.exitGameFullscreen();
        }, 1500);
        this.bottomCards = [];
        document.getElementById('btn-view-bottom').classList.add('hidden');
        break;

      case 'next_game_state':
        this.updateNextGameReady(msg.readyCount, msg.totalCount);
        break;

      case 'chat':
        this.addChatMessage(msg.nickname, msg.message);
        break;

      case 'left_game':
        this.roomId = null;
        this.seat = -1;
        this.isSitting = false;
        this.gameState = null;
        this.myHand = [];
        localStorage.removeItem('shengji_game');
        this.showScreen('lobby-screen');
        break;

      case 'error':
        this.showToast(msg.message);
        // 如果是房间相关错误，清除保存的游戏信息
        if (msg.message.includes('房间') || msg.message.includes('无法加入')) {
          localStorage.removeItem('shengji_game');
          this.roomId = null;
          this.seat = -1;
          this.isSitting = false;
          this.showScreen('lobby-screen');
        }
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

    const isHost = state.hostUserId === this.user?.id;
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
    // 只显示闲家得分（庄家不得分）
    const dealerTeam = gs.players[gs.dealer]?.team;
    const idleScore = dealerTeam === 1 ? gs.scores.team2 : gs.scores.team1;
    console.log(`[UI] dealer=${gs.dealer} dealerTeam=${dealerTeam} scores=${JSON.stringify(gs.scores)} idleScore=${idleScore}`);
    document.getElementById('score-info').textContent = `闲家得分: ${idleScore}分`;

    // 显示当前 bids 信息（亮主阶段）
    const bidInfo = document.getElementById('bid-info');
    if (gs.status === 'bidding' && gs.bids && gs.bids.length > 0) {
      const lastBid = gs.bids[gs.bids.length - 1];
      const bidderName = this.getPlayerName(lastBid.seat);
      const suitName = lastBid.suit === null ? '无主' : this.SUIT_NAMES[lastBid.suit];
      const levelCount = lastBid.levelCount || 0;
      const jokerCount = lastBid.jokers ? lastBid.jokers.length : 0;
      let bidText = `${bidderName} 亮 ${suitName}`;
      if (levelCount > 0) bidText += ` ${levelCount}张级牌`;
      if (jokerCount > 0) {
        const bigJokers = lastBid.jokers.filter(j => j.rank === 'big').length;
        const smallJokers = jokerCount - bigJokers;
        const jokerDesc = [];
        if (bigJokers > 0) jokerDesc.push(`${bigJokers}大王`);
        if (smallJokers > 0) jokerDesc.push(`${smallJokers}小王`);
        bidText += ` +${jokerDesc.join('')}`;
      }
      bidInfo.textContent = bidText;
      bidInfo.classList.remove('hidden');
    } else if (gs.status === 'bidding') {
      bidInfo.textContent = '尚未亮主';
      bidInfo.classList.remove('hidden');
    } else {
      bidInfo.classList.add('hidden');
    }

    gs.players.forEach(p => {
      const relSeat = this.getRelativeSeat(p.seat);
      const el = document.querySelector(`.player[data-seat="${relSeat}"]`);
      if (el) {
        el.querySelector('.player-name').textContent = p.userId === this.user?.id ? '我' : (p.nickname || '--');
        el.querySelector('.player-cards-count').textContent = p.handCount + '张';
        const avatarEl = el.querySelector('.player-avatar');
        if (avatarEl) {
          let avatarText = avatarEl.querySelector('.avatar-text');
          if (!avatarText) {
            avatarText = document.createElement('span');
            avatarText.className = 'avatar-text';
            avatarEl.insertBefore(avatarText, avatarEl.firstChild);
          }
          if (p.avatar) {
            avatarEl.style.backgroundImage = `url(${p.avatar})`;
            avatarText.textContent = '';
          } else {
            avatarEl.style.backgroundImage = '';
            avatarText.textContent = (p.nickname || '?').charAt(0);
          }
        }
        // 显示庄家/对家/闲家标记
        const roleEl = el.querySelector('.player-role');
        if (roleEl) {
          if (gs.dealer === p.seat) {
            roleEl.textContent = '庄';
            roleEl.className = 'player-role dealer';
          } else if (p.team === gs.players[gs.dealer]?.team) {
            roleEl.textContent = '对';
            roleEl.className = 'player-role partner';
          } else {
            roleEl.textContent = '闲';
            roleEl.className = 'player-role idle';
          }
        }
      }
      // 如果服务端传了手牌，更新本地手牌
      if (p.seat === this.seat && p.hand) {
        this.myHand = p.hand;
        this.sortHand();
      }
    });

    // 显示反主记录按钮（如果有亮主记录）
    if (gs.bidRecords && gs.bidRecords.length > 0) {
      document.getElementById('btn-bid-history').classList.remove('hidden');
    }

    // 更新亮主/反主按钮状态（手牌可能已更新）
    if (gs.status === 'dealing' || gs.status === 'bidding') {
      const isMyTurn = gs.currentSeat === this.seat;
      const existingBid = gs.bids && gs.bids.length > 0 ? gs.bids[gs.bids.length - 1] : null;
      if (this.rebidPhase || existingBid) {
        const canRebidNow = isMyTurn && this.canRebid();
        document.getElementById('btn-bid').classList.toggle('hidden', !canRebidNow);
        document.getElementById('btn-bid').textContent = '反主';
        document.getElementById('btn-pass').classList.add('hidden');
        document.getElementById('btn-pass-rebid').classList.toggle('hidden', !canRebidNow);
      } else {
        const canBidNow = isMyTurn && this.canBid();
        document.getElementById('btn-bid').classList.toggle('hidden', !canBidNow);
        document.getElementById('btn-bid').textContent = '亮主';
        document.getElementById('btn-pass').classList.toggle('hidden', !canBidNow);
        document.getElementById('btn-pass-rebid').classList.add('hidden');
      }
    }

    // 从服务端状态同步当前trick（仅在localCurrentTrick为空时，避免覆盖）
    if (this.localCurrentTrick.length === 0 && gs.currentTrick && gs.currentTrick.length > 0) {
      this.localCurrentTrick = gs.currentTrick.map(t => ({ seat: t.seat, cards: t.cards }));
      this.renderTrick();
    }

    // 渲染底牌（仅庄家在扣底阶段可见）
    const bottomInfo = document.getElementById('bottom-info');
    if (this.bottomCards && this.bottomCards.length > 0 && gs.status === 'taking_bottom' && gs.dealer === this.seat) {
      bottomInfo.innerHTML = `<div class="bottom-label">底牌 (${this.bottomCards.length}张)</div><div class="bottom-cards">${this.bottomCards.map(c => this.renderCardSmall(c)).join('')}</div>`;
    } else {
      bottomInfo.innerHTML = '';
    }

    this.renderHand();
  },

  updateTurn(seat, phase, rebidPhase) {
    this.rebidPhase = !!rebidPhase;
    document.querySelectorAll('.player').forEach(p => p.classList.remove('active'));
    const relSeat = this.getRelativeSeat(seat);
    const el = document.querySelector(`.player[data-seat="${relSeat}"]`);
    if (el) el.classList.add('active');

    const isMyTurn = seat === this.seat;

    if (phase === 'dealing' || phase === 'bidding') {
      const existingBid = this.gameState && this.gameState.bids && this.gameState.bids.length > 0 ? this.gameState.bids[this.gameState.bids.length - 1] : null;
      if (rebidPhase || existingBid) {
        // 反主阶段
        const canRebidNow = isMyTurn && this.canRebid();
        document.getElementById('btn-bid').classList.toggle('hidden', !canRebidNow);
        document.getElementById('btn-bid').textContent = '反主';
        document.getElementById('btn-pass-rebid').classList.toggle('hidden', !canRebidNow);
        document.getElementById('btn-pass').classList.add('hidden');
      } else {
        // 亮主阶段
        const canBidNow = isMyTurn && this.canBid();
        document.getElementById('btn-bid').classList.toggle('hidden', !canBidNow);
        document.getElementById('btn-bid').textContent = '亮主';
        document.getElementById('btn-pass-rebid').classList.add('hidden');
        // 只有能亮主时才显示跳过按钮，不能亮主时服务器会自动跳过
        document.getElementById('btn-pass').classList.toggle('hidden', !canBidNow);
      }
      document.getElementById('btn-set-bottom').classList.add('hidden');
      document.getElementById('btn-play').classList.add('hidden');
      document.getElementById('btn-view-bottom').classList.add('hidden');
    } else if (phase === 'taking_bottom') {
      document.getElementById('btn-bid').classList.add('hidden');
      document.getElementById('btn-pass').classList.add('hidden');
      document.getElementById('btn-pass-rebid').classList.add('hidden');
      document.getElementById('btn-set-bottom').classList.toggle('hidden', !isMyTurn);
      document.getElementById('btn-play').classList.add('hidden');
      document.getElementById('btn-view-bottom').classList.add('hidden');
      this.hideRebidTimer();
    } else if (phase === 'playing') {
      document.getElementById('btn-bid').classList.add('hidden');
      document.getElementById('btn-pass').classList.add('hidden');
      document.getElementById('btn-pass-rebid').classList.add('hidden');
      document.getElementById('btn-set-bottom').classList.add('hidden');
      document.getElementById('btn-play').classList.toggle('hidden', !isMyTurn);
      this.hideRebidTimer();
      // 庄家可以查看底牌
      const isDealer = this.gameState && this.gameState.dealer === this.seat;
      const hasBottom = this.bottomCards && this.bottomCards.length > 0;
      document.getElementById('btn-view-bottom').classList.toggle('hidden', !(isDealer && hasBottom));
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

    const isLandscape = window.innerWidth > window.innerHeight;
    const cardCount = this.myHand.length;

    // 按花色排序（主牌在前 → ♠ → ♥ → ♣ → ♦），同花色内按点数降序
    const sorted = [...this.myHand];
    const gs = this.gameState;
    const trumpSuit = gs?.trumpSuit;
    const trumpLevel = gs?.trumpLevel;

    const suitOrder = trumpSuit
      ? ['joker', trumpSuit, 'spade', 'heart', 'diamond', 'club'].filter((s, i, a) => a.indexOf(s) === i)
      : ['joker', 'spade', 'heart', 'diamond', 'club'];

    const isTrump = (c) => {
      if (c.suit === 'joker') return true;
      if (c.rank === '2') return true;
      if (trumpLevel && c.rank === this.getRankFromLevel(trumpLevel)) return true;
      if (trumpSuit && c.suit === trumpSuit) return true;
      return false;
    };

    const getTrumpRank = (c) => {
      if (c.suit === 'joker') return c.rank === 'big' ? 100 : 99;
      if (c.rank === this.getRankFromLevel(trumpLevel)) {
        if (c.suit === trumpSuit) return 98;
        return 97;
      }
      if (c.rank === '2' && this.getRankFromLevel(trumpLevel) !== '2') {
        if (c.suit === trumpSuit) return 96;
        return 95;
      }
      return this.RANK_ORDER.indexOf(c.rank);
    };

    sorted.sort((a, b) => {
      const aT = isTrump(a), bT = isTrump(b);
      if (aT && !bT) return -1;
      if (!aT && bT) return 1;
      if (aT && bT) {
        const rDiff = getTrumpRank(b) - getTrumpRank(a);
        if (rDiff !== 0) return rDiff;
        const sDiff = suitOrder.indexOf(a.suit) - suitOrder.indexOf(b.suit);
        if (sDiff !== 0) return sDiff;
        return this.RANK_ORDER.indexOf(b.rank) - this.RANK_ORDER.indexOf(a.rank);
      }
      const sDiff = suitOrder.indexOf(a.suit) - suitOrder.indexOf(b.suit);
      if (sDiff !== 0) return sDiff;
      return this.RANK_ORDER.indexOf(b.rank) - this.RANK_ORDER.indexOf(a.rank);
    });

    // 计算动态卡片尺寸
    const isMobile = document.body.classList.contains('mobile-game');
    let cardWidth, cardHeight, cardFont, overlapMargin;

    if (isMobile && isLandscape) {
      // 横屏：单行，固定露出半张牌（21px），左右滑动浏览
      cardWidth = 42;
      cardHeight = 56;
      cardFont = 10;
      overlapMargin = -21; // 露出半张牌
    } else if (isMobile && !isLandscape) {
      // 竖屏：多行，限制4行，动态缩牌
      const availWidth = window.innerWidth - 16;
      const maxRows = 4;
      const baseCardW = 36;
      const baseCardH = 48;
      const marginL = -6;

      // 计算每行能放多少张
      const cardsPerRow = Math.max(1, Math.floor((availWidth - baseCardW) / (baseCardW + marginL)) + 1);
      const neededRows = Math.ceil(cardCount / cardsPerRow);

      if (neededRows <= maxRows) {
        cardWidth = baseCardW;
        cardHeight = baseCardH;
        cardFont = 9;
      } else {
        // 缩牌以适配4行
        const targetPerRow = Math.ceil(cardCount / maxRows);
        const neededWidth = targetPerRow * baseCardW + (targetPerRow - 1) * marginL;
        const scale = Math.min(1, availWidth / neededWidth);
        cardWidth = Math.max(22, Math.floor(baseCardW * scale));
        cardHeight = Math.max(30, Math.floor(baseCardH * scale));
        cardFont = Math.max(7, Math.floor(9 * scale));
      }
    }

    // 渲染牌，按花色分组添加间距
    let prevSuit = null;
    for (let i = 0; i < sorted.length; i++) {
      const card = sorted[i];
      const el = document.createElement('div');
      el.className = 'card ' + this.getCardColorClass(card);
      el.dataset.id = card.id;
      el.dataset.index = i;

      const rankDisplay = card.rank === 'small' ? '小王' : card.rank === 'big' ? '大王' : card.rank;
      const suitDisplay = this.SUIT_SYMBOLS[card.suit] || '';

      el.innerHTML = `
        <div class="suit-top">${rankDisplay}<br>${suitDisplay}</div>
        <div class="suit-bottom">${rankDisplay}<br>${suitDisplay}</div>
      `;

      if (this.selectedCards.has(card.id)) {
        el.classList.add('selected');
      }

      // 花色分组间距
      const cardSuit = isTrump(card) ? 'trump' : card.suit;
      if (prevSuit !== null && cardSuit !== prevSuit) {
        el.classList.add('suit-gap');
      }
      prevSuit = cardSuit;

      // 动态尺寸（移动端）
      if (isMobile) {
        if (isLandscape && overlapMargin !== undefined) {
          el.style.width = cardWidth + 'px';
          el.style.height = cardHeight + 'px';
          el.style.fontSize = cardFont + 'px';
          // 第一张牌不设 marginLeft，CSS auto margin 处理居中
          if (i > 0) {
            el.style.marginLeft = overlapMargin + 'px';
          }
        } else if (!isLandscape) {
          el.style.width = cardWidth + 'px';
          el.style.height = cardHeight + 'px';
          el.style.fontSize = cardFont + 'px';
        }
      }

      el.onclick = () => this.selectCard(card.id);
      container.appendChild(el);
    }

    // 竖屏：限制最大高度
    if (isMobile && !isLandscape && cardHeight) {
      container.style.maxHeight = (cardHeight * 4 + 30) + 'px';
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
    // 只切换视觉状态，不重建 DOM，保留触摸展开状态
    const cardEl = document.querySelector(`#my-hand .card[data-id="${cardId}"]`);
    if (cardEl) {
      cardEl.classList.toggle('selected', this.selectedCards.has(cardId));
    }
  },

  sortHand() {
    const gs = this.gameState;
    const trumpSuit = gs?.trumpSuit;
    const trumpLevel = gs?.trumpLevel;

    const isTrump = (c) => {
      if (c.suit === 'joker') return true;
      if (c.rank === '2') return true;
      if (c.rank === this.getRankFromLevel(trumpLevel)) return true;
      if (trumpSuit && c.suit === trumpSuit && c.rank !== this.getRankFromLevel(trumpLevel) && c.rank !== '2') return true;
      return false;
    };

    const getTrumpRank = (c) => {
      if (c.suit === 'joker') return c.rank === 'big' ? 100 : 99;
      if (c.rank === this.getRankFromLevel(trumpLevel)) {
        if (c.suit === trumpSuit) return 98;
        return 97;
      }
      if (c.rank === '2' && this.getRankFromLevel(trumpLevel) !== '2') {
        if (c.suit === trumpSuit) return 96;
        return 95;
      }
      return this.RANK_ORDER.indexOf(c.rank);
    };

    this.myHand.sort((a, b) => {
      const aT = isTrump(a);
      const bT = isTrump(b);
      if (aT && !bT) return -1;
      if (!aT && bT) return 1;
      if (aT && bT) {
        const rDiff = getTrumpRank(b) - getTrumpRank(a);
        if (rDiff !== 0) return rDiff;
        // 主牌同 rank 时，主花色在前，再按花色、点数排
        const suitOrder = ['spade', 'heart', 'diamond', 'club'];
        const aSuit = a.suit === 'joker' ? -1 : suitOrder.indexOf(a.suit);
        const bSuit = b.suit === 'joker' ? -1 : suitOrder.indexOf(b.suit);
        const sDiff = bSuit - aSuit;
        if (sDiff !== 0) return sDiff;
        return this.RANK_ORDER.indexOf(b.rank) - this.RANK_ORDER.indexOf(a.rank);
      }

      const suitOrder = ['spade', 'heart', 'diamond', 'club'];
      const sDiff = suitOrder.indexOf(a.suit) - suitOrder.indexOf(b.suit);
      if (sDiff !== 0) return sDiff;
      return this.RANK_ORDER.indexOf(b.rank) - this.RANK_ORDER.indexOf(a.rank);
    });

    this.renderHand();
  },

  canBid() {
    if (!this.gameState || (this.gameState.status !== 'bidding' && this.gameState.status !== 'dealing')) return false;

    const existingBid = this.gameState.bids && this.gameState.bids.length > 0 ? this.gameState.bids[this.gameState.bids.length - 1] : null;

    // 已经有人亮主了，不能再亮主（只能反主）
    if (existingBid) return false;

    // 首次亮主：需要1张级牌 + 1张王
    const trumpLevelStr = this.getRankFromLevel(this.gameState.trumpLevel);
    const levelCards = this.myHand.filter(c => c.rank === trumpLevelStr && c.suit !== 'joker');
    const jokerCards = this.myHand.filter(c => c.suit === 'joker');
    return levelCards.length >= 1 && jokerCards.length >= 1;
  },

  canRebid() {
    if (!this.gameState || (this.gameState.status !== 'bidding' && this.gameState.status !== 'dealing')) return false;
    if (!this.gameState.bids || this.gameState.bids.length === 0) return false;

    const trumpLevelStr = this.getRankFromLevel(this.gameState.trumpLevel);
    const existingBid = this.gameState.bids[this.gameState.bids.length - 1];

    // 检查自己是否已经反过主（不能自己反自己的主）
    if (existingBid.seat === this.seat) {
      return false;
    }

    // 检查该玩家是否已经出过价（每人最多只能亮主/反主一次）
    if (this.gameState.bids.some(b => b.seat === this.seat)) {
      return false;
    }

    const levelCards = this.myHand.filter(c => c.rank === trumpLevelStr && c.suit !== 'joker');
    const jokerCards = this.myHand.filter(c => c.suit === 'joker');

    // 反无主：只能纯王，需要更多或更大的王
    if (existingBid.suit === null) {
      if (levelCards.length > 0) return false;
      if (jokerCards.length < 2) return false;
      const compareJokers = (a, b) => {
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
    const levelCardsBySuit = {};
    for (const c of levelCards) {
      if (!levelCardsBySuit[c.suit]) levelCardsBySuit[c.suit] = 0;
      levelCardsBySuit[c.suit]++;
    }
    const maxSameSuitLevelCount = Math.max(0, ...Object.values(levelCardsBySuit));
    return maxSameSuitLevelCount >= existingLevelCount + 1;
  },

  bid() {
    if (!this.gameState || (this.gameState.status !== 'bidding' && this.gameState.status !== 'dealing')) return;

    const selected = this.myHand.filter(c => this.selectedCards.has(c.id));
    if (selected.length === 0) {
      this.showToast('请选择要亮的牌');
      return;
    }

    // 根据阶段判断发送 bid 还是 rebid（服务端 rebid 仅在 _rebidPhase 时处理，
    // 非 _rebidPhase 时用 bid 消息走 game.bid() 逻辑）
    const messageType = this.rebidPhase ? 'rebid' : 'bid';

    this.send({ type: messageType, cards: selected.map(c => ({ id: c.id, suit: c.suit, rank: c.rank })) });
    this.selectedCards.clear();
    this.renderHand();
  },

  showRebidTimer(seconds) {
    const timerEl = document.getElementById('timer');
    timerEl.classList.remove('hidden');
    timerEl.textContent = seconds;

    if (this._rebidTimerInterval) {
      clearInterval(this._rebidTimerInterval);
    }

    this._rebidTimerInterval = setInterval(() => {
      seconds--;
      if (seconds <= 0) {
        this.hideRebidTimer();
        return;
      }
      timerEl.textContent = seconds;
    }, 1000);
  },

  hideRebidTimer() {
    const timerEl = document.getElementById('timer');
    timerEl.classList.add('hidden');
    if (this._rebidTimerInterval) {
      clearInterval(this._rebidTimerInterval);
      this._rebidTimerInterval = null;
    }
  },

  showRebidNotification(msg) {
    const { seat, nickname, cards, trumpSuit, timeout } = msg;
    const SUIT_NAMES = { spade: '黑桃', heart: '红心', diamond: '方块', club: '梅花' };
    const RANK_NAMES = { small: '小王', big: '大王', '3': '3', '4': '4', '5': '5', '6': '6', '7': '7', '8': '8', '9': '9', '10': '10', J: 'J', Q: 'Q', K: 'K', A: 'A', '2': '2' };

    // 构建牌的显示文本
    const cardNames = cards.map(c => {
      if (c.suit === 'joker') return RANK_NAMES[c.rank] || c.rank;
      return (SUIT_NAMES[c.suit] || '') + (RANK_NAMES[c.rank] || c.rank);
    }).join('');

    const suitName = trumpSuit ? SUIT_NAMES[trumpSuit] : '无主';
    const message = `${nickname} 使用 ${cardNames} 反主为 ${suitName}`;

    // 创建确认对话框
    const dialog = document.createElement('div');
    dialog.id = 'rebid-confirm-dialog';
    dialog.className = 'modal-overlay';
    dialog.innerHTML = `
      <div class="modal-content">
        <h3>反主通知</h3>
        <p>${message}</p>
        <p class="countdown">将在 <span id="rebid-countdown">${timeout}</span> 秒后自动确认</p>
        <button id="btn-confirm-rebid" class="btn btn-primary">确认</button>
      </div>
    `;
    document.body.appendChild(dialog);

    // 绑定确认按钮
    document.getElementById('btn-confirm-rebid').addEventListener('click', () => {
      this.confirmRebid();
    });

    // 倒计时
    let countdown = timeout;
    this._rebidCountdownInterval = setInterval(() => {
      countdown--;
      const countdownEl = document.getElementById('rebid-countdown');
      if (countdownEl) countdownEl.textContent = countdown;
      if (countdown <= 0) {
        this.removeRebidDialog();
      }
    }, 1000);
  },

  confirmRebid() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'confirm_rebid' }));
    }
    this.removeRebidDialog();
  },

  removeRebidDialog() {
    if (this._rebidCountdownInterval) {
      clearInterval(this._rebidCountdownInterval);
      this._rebidCountdownInterval = null;
    }
    const dialog = document.getElementById('rebid-confirm-dialog');
    if (dialog) dialog.remove();
  },

  updateRebidConfirmation(msg) {
    const { seat, confirmedCount, totalCount } = msg;
    // 可以在这里更新确认进度显示
    console.log(`Rebid confirmed: ${confirmedCount}/${totalCount}`);
  },

  showNoBidNotification(msg) {
    const { lastCard, trumpSuit, timeout } = msg;
    const SUIT_NAMES = { spade: '黑桃', heart: '红心', diamond: '方块', club: '梅花' };
    const RANK_NAMES = { small: '小王', big: '大王', '3': '3', '4': '4', '5': '5', '6': '6', '7': '7', '8': '8', '9': '9', '10': '10', J: 'J', Q: 'Q', K: 'K', A: 'A', '2': '2' };

    // 构建最后一张牌的显示文本
    let cardName;
    if (lastCard.suit === 'joker') {
      cardName = RANK_NAMES[lastCard.rank] || lastCard.rank;
    } else {
      cardName = (SUIT_NAMES[lastCard.suit] || '') + (RANK_NAMES[lastCard.rank] || lastCard.rank);
    }

    const suitName = trumpSuit ? SUIT_NAMES[trumpSuit] : '无主';
    const message = `无人亮主，最后一张牌是 ${cardName}，主牌为 ${suitName}`;

    // 创建确认对话框
    const dialog = document.createElement('div');
    dialog.id = 'no-bid-confirm-dialog';
    dialog.className = 'modal-overlay';
    dialog.innerHTML = `
      <div class="modal-content">
        <h3>无人亮主</h3>
        <p>${message}</p>
        <p class="countdown">将在 <span id="no-bid-countdown">${timeout}</span> 秒后自动确认</p>
        <button id="btn-confirm-no-bid" class="btn btn-primary">确认</button>
      </div>
    `;
    document.body.appendChild(dialog);

    // 绑定确认按钮
    document.getElementById('btn-confirm-no-bid').addEventListener('click', () => {
      this.confirmNoBid();
    });

    // 倒计时
    let countdown = timeout;
    this._noBidCountdownInterval = setInterval(() => {
      countdown--;
      const countdownEl = document.getElementById('no-bid-countdown');
      if (countdownEl) countdownEl.textContent = countdown;
      if (countdown <= 0) {
        this.removeNoBidDialog();
      }
    }, 1000);
  },

  confirmNoBid() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'confirm_no_bid' }));
    }
    this.removeNoBidDialog();
  },

  removeNoBidDialog() {
    if (this._noBidCountdownInterval) {
      clearInterval(this._noBidCountdownInterval);
      this._noBidCountdownInterval = null;
    }
    const dialog = document.getElementById('no-bid-confirm-dialog');
    if (dialog) dialog.remove();
  },

  updateNoBidConfirmation(msg) {
    const { seat, confirmedCount, totalCount } = msg;
    console.log(`No-bid confirmed: ${confirmedCount}/${totalCount}`);
  },

  setBottom() {
    if (!this.gameState || this.gameState.status !== 'taking_bottom') return;

    const bottomCount = this.gameState.bottomCount || 0;
    const selected = this.myHand.filter(c => this.selectedCards.has(c.id));
    if (selected.length !== bottomCount) {
      this.showToast(`请选择${bottomCount}张牌作为底牌`);
      return;
    }

    this.send({ type: 'set_bottom', cardIds: selected.map(c => c.id) });
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

  clearTrickArea() {
    document.querySelectorAll('.trick-seat').forEach(el => el.innerHTML = '');
  },

  renderTrick() {
    for (const play of this.localCurrentTrick) {
      const relSeat = this.getRelativeSeat(play.seat);
      const container = document.querySelector(`.trick-seat[data-rel="${relSeat}"]`);
      if (!container) continue;
      container.innerHTML = '';
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

  showGameResult(msg) {
    const overlay = document.getElementById('game-result-overlay');
    const titleEl = document.getElementById('result-title');
    const detailsEl = document.getElementById('result-details');
    const readyEl = document.getElementById('result-ready-status');
    const btnNext = document.getElementById('btn-next-game');

    // 判断输赢
    const myTeam = this.gameState?.players[this.seat]?.team;
    const dealerTeam = msg.dealerTeam;
    const myTeamIsDealer = myTeam === dealerTeam;
    let resultText, resultClass;
    if (msg.winner === 'dealer') {
      resultText = myTeamIsDealer ? '庄家胜！你赢了' : '庄家胜！你输了';
      resultClass = myTeamIsDealer ? 'win' : 'lose';
    } else if (msg.winner === 'idle') {
      resultText = myTeamIsDealer ? '闲家胜！你输了' : '闲家胜！你赢了';
      resultClass = myTeamIsDealer ? 'lose' : 'win';
    } else {
      resultText = '平局';
      resultClass = 'draw';
    }
    titleEl.textContent = resultText;
    titleEl.className = resultClass;

    // 详细信息
    let html = '';
    html += `<div class="detail-row"><span class="detail-label">闲家得分</span><span class="detail-value">${msg.idleScore} 分</span></div>`;
    if (msg.bottomPoints > 0) {
      html += `<div class="detail-row"><span class="detail-label">底牌得分</span><span class="detail-value">${msg.bottomPoints} 分${msg.bottomMultiplier > 1 ? ' (翻' + msg.bottomMultiplier + '倍)' : ''}</span></div>`;
    }
    // 升级规则说明
    if (msg.steps && msg.step) {
      const step = msg.step;
      if (msg.winner === 'idle') {
        const idleSteps = msg.steps.idle;
        html += `<div class="detail-row"><span class="detail-label">闲家升级</span><span class="detail-value">+${idleSteps} 级</span></div>`;
      } else if (msg.winner === 'dealer') {
        const dealerSteps = msg.steps.dealer;
        if (dealerSteps > 0) {
          html += `<div class="detail-row"><span class="detail-label">庄家升级</span><span class="detail-value">+${dealerSteps} 级</span></div>`;
        } else {
          html += `<div class="detail-row"><span class="detail-label">庄家</span><span class="detail-value">守住</span></div>`;
        }
      } else {
        html += `<div class="detail-row"><span class="detail-label">庄家</span><span class="detail-value">守住（闲家夺庄）</span></div>`;
      }
    }
    html += `<div class="detail-row"><span class="detail-label">当前等级</span><span class="detail-value">${msg.levels.team1} : ${msg.levels.team2}</span></div>`;
    detailsEl.innerHTML = html;

    readyEl.textContent = '等待所有玩家准备...';
    btnNext.disabled = false;
    btnNext.textContent = '下一局';
    overlay.classList.remove('hidden');
  },

  updateNextGameReady(readyCount, totalCount) {
    const readyEl = document.getElementById('result-ready-status');
    const btnNext = document.getElementById('btn-next-game');
    if (readyCount >= totalCount) {
      readyEl.textContent = '所有人已准备，即将开始...';
      btnNext.disabled = true;
      btnNext.textContent = '已准备';
    } else {
      readyEl.textContent = `已准备 ${readyCount}/${totalCount}`;
    }
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
  },

  renderCardSmall(card, extraClass = '') {
    let rankDisplay = card.rank;
    let suitDisplay = this.SUIT_SYMBOLS[card.suit] || card.rank;
    if (card.suit === 'joker') {
      rankDisplay = card.rank === 'big' ? '大王' : '小王';
      suitDisplay = '';
    }
    const colorClass = this.getCardColorClass(card);
    const cls = extraClass ? `card ${colorClass} ${extraClass}` : `card ${colorClass}`;
    return `<div class="${cls}">
      <div class="suit-top">${rankDisplay}<br>${suitDisplay}</div>
      <div class="suit-bottom">${rankDisplay}<br>${suitDisplay}</div>
    </div>`;
  },

  toggleHistoryView() {
    this.historyViewMode = this.historyViewMode === 'all' ? 'rounds' : 'all';
    this.showPlayedHistory();
  },

  showPlayedHistory() {
    const modal = document.getElementById('history-modal');
    const body = document.getElementById('history-body');
    const toggleBtn = document.getElementById('btn-toggle-history-view');
    modal.classList.remove('hidden');

    if (toggleBtn) {
      toggleBtn.textContent = this.historyViewMode === 'all' ? '切换: 轮次记录' : '切换: 全部牌';
    }

    if (this.playedHistory.length === 0) {
      body.innerHTML = '<p>暂无出牌记录</p>';
      return;
    }

    if (this.historyViewMode === 'rounds') {
      this._renderHistoryRounds(body);
      return;
    }

    const deckCount = this.gameState?.deckCount || 2;
    const suits = ['spade', 'heart', 'diamond', 'club'];
    const ranks = ['3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A', '2'];

    // 构建完整牌组
    const allCards = [];
    for (let d = 0; d < deckCount; d++) {
      for (const suit of suits) {
        for (const rank of ranks) {
          allCards.push({ suit, rank, id: `${suit}_${rank}_${d}` });
        }
      }
      allCards.push({ suit: 'joker', rank: 'small', id: `joker_small_${d}` });
      allCards.push({ suit: 'joker', rank: 'big', id: `joker_big_${d}` });
    }

    // 收集已出的牌的 id
    const playedIds = new Set();
    for (const trick of this.playedHistory) {
      for (const play of trick.plays) {
        for (const card of play.cards) {
          playedIds.add(card.id);
        }
      }
    }

    // 按花色和大小排序（复用手牌排序逻辑）
    const gs = this.gameState;
    const trumpSuit = gs?.trumpSuit;
    const trumpLevel = gs?.trumpLevel;

    const isTrump = (c) => {
      if (c.suit === 'joker') return true;
      if (c.rank === '2') return true;
      if (c.rank === this.getRankFromLevel(trumpLevel)) return true;
      if (trumpSuit && c.suit === trumpSuit && c.rank !== this.getRankFromLevel(trumpLevel) && c.rank !== '2') return true;
      return false;
    };

    const getTrumpRank = (c) => {
      if (c.suit === 'joker') return c.rank === 'big' ? 100 : 99;
      if (c.rank === this.getRankFromLevel(trumpLevel)) {
        if (c.suit === trumpSuit) return 98;
        return 97;
      }
      if (c.rank === '2' && this.getRankFromLevel(trumpLevel) !== '2') {
        if (c.suit === trumpSuit) return 96;
        return 95;
      }
      return this.RANK_ORDER.indexOf(c.rank);
    };

    allCards.sort((a, b) => {
      const aT = isTrump(a);
      const bT = isTrump(b);
      if (aT && !bT) return -1;
      if (!aT && bT) return 1;
      if (aT && bT) {
        const rDiff = getTrumpRank(b) - getTrumpRank(a);
        if (rDiff !== 0) return rDiff;
        const suitOrder = ['spade', 'heart', 'diamond', 'club'];
        const aSuit = a.suit === 'joker' ? -1 : suitOrder.indexOf(a.suit);
        const bSuit = b.suit === 'joker' ? -1 : suitOrder.indexOf(b.suit);
        const sDiff = bSuit - aSuit;
        if (sDiff !== 0) return sDiff;
        return this.RANK_ORDER.indexOf(b.rank) - this.RANK_ORDER.indexOf(a.rank);
      }

      const suitOrder = ['spade', 'heart', 'diamond', 'club'];
      const sDiff = suitOrder.indexOf(a.suit) - suitOrder.indexOf(b.suit);
      if (sDiff !== 0) return sDiff;
      return this.RANK_ORDER.indexOf(b.rank) - this.RANK_ORDER.indexOf(a.rank);
    });

    let html = `<div class="history-played-count">已出 ${playedIds.size} / ${allCards.length} 张</div>`;
    html += `<div class="history-play-cards">`;
    for (const card of allCards) {
      const isPlayed = playedIds.has(card.id);
      html += this.renderCardSmall(card, isPlayed ? '' : 'unplayed');
    }
    html += `</div>`;
    body.innerHTML = html;
  },

  _renderHistoryRounds(body) {
    let html = '';
    for (let i = 0; i < this.playedHistory.length; i++) {
      const trick = this.playedHistory[i];
      html += `<div class="history-trick">`;
      html += `<div class="history-trick-header">第 ${i + 1} 把 — ${this.getPlayerName(trick.winnerSeat)} 得 ${trick.points} 分</div>`;
      html += `<div class="history-plays">`;
      for (const play of trick.plays) {
        html += `<div class="history-play">`;
        html += `<span class="history-play-seat">${this.getPlayerName(play.seat)}</span>`;
        html += `<div class="history-play-cards">`;
        for (const card of play.cards) {
          html += this.renderCardSmall(card);
        }
        html += `</div></div>`;
      }
      html += `</div></div>`;
    }
    body.innerHTML = html;
  },

  hidePlayedHistory() {
    document.getElementById('history-modal').classList.add('hidden');
  },

  showBottomCards() {
    const modal = document.getElementById('bottom-modal');
    const body = document.getElementById('bottom-body');
    modal.classList.remove('hidden');

    if (!this.bottomCards || this.bottomCards.length === 0) {
      body.innerHTML = '<p>暂无底牌</p>';
      return;
    }

    let html = '<div class="bottom-cards">';
    for (const card of this.bottomCards) {
      html += this.renderCardSmall(card);
    }
    html += '</div>';
    body.innerHTML = html;
  },

  hideBottomCards() {
    document.getElementById('bottom-modal').classList.add('hidden');
  },

  showBidHistory() {
    const modal = document.getElementById('bid-history-modal');
    const body = document.getElementById('bid-history-body');
    modal.classList.remove('hidden');

    if (!this.gameState || !this.gameState.bidRecords || this.gameState.bidRecords.length === 0) {
      body.innerHTML = '<p>暂无亮主/反主记录</p>';
      return;
    }

    const SUIT_NAMES = { spade: '黑桃', heart: '红心', diamond: '方块', club: '梅花' };
    const RANK_NAMES = { small: '小王', big: '大王', '3': '3', '4': '4', '5': '5', '6': '6', '7': '7', '8': '8', '9': '9', '10': '10', J: 'J', Q: 'Q', K: 'K', A: 'A', '2': '2' };

    let html = '<div class="bid-history-list">';

    for (const record of this.gameState.bidRecords) {
      if (record.action === 'pass') continue; // 跳过过牌记录
      const player = this.getPlayerName(record.seat);
      const action = record.action === 'bid' ? '亮主' : '反主';
      const result = record.result === 'success' ? '成功' : '失败';

      const cardNames = (record.cards || []).map(c => {
        if (c.suit === 'joker') return RANK_NAMES[c.rank] || c.rank;
        return (SUIT_NAMES[c.suit] || '') + (RANK_NAMES[c.rank] || c.rank);
      }).join('');

      const suitName = record.trumpSuit ? SUIT_NAMES[record.trumpSuit] : '无主';

      html += '<div class="bid-history-item">';
      html += `<span class="bid-history-player">${player}</span>`;
      html += `<span class="bid-history-action">${action}</span>`;
      html += `<span class="bid-history-cards">${cardNames}</span>`;
      html += `<span class="bid-history-suit">→ ${suitName}</span>`;
      html += `<span class="bid-history-result ${record.result}">${result}</span>`;
      if (record.reason) {
        html += `<span class="bid-history-reason">(${record.reason})</span>`;
      }
      html += '</div>';
    }

    html += '</div>';
    body.innerHTML = html;
  },

  hideBidHistory() {
    document.getElementById('bid-history-modal').classList.add('hidden');
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
