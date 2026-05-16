const VoiceChat = {
  client: null,
  localTrack: null,
  muted: false,
  joined: false,

  APP_ID: '',

  async init(appId) {
    this.APP_ID = appId;
    if (!appId || !window.AgoraRTC) {
      console.log('Agora not configured');
      this.updateUI('未配置');
      return;
    }

    try {
      this.client = AgoraRTC.createClient({ mode: 'rtc', codec: 'vp8' });

      this.client.on('user-published', async (user, mediaType) => {
        await this.client.subscribe(user, mediaType);
        if (mediaType === 'audio') {
          user.audioTrack?.play();
        }
      });

      this.client.on('user-unpublished', (user) => {
        user.audioTrack?.stop();
      });

      document.getElementById('btn-mute').onclick = () => this.toggleMute();
      this.updateUI('就绪');
    } catch (err) {
      console.error('Voice init failed', err);
      this.updateUI('初始化失败');
    }
  },

  async join(roomId, userId) {
    if (!this.client || !this.APP_ID) return;
    if (this.joined) return;

    try {
      await this.client.join(this.APP_ID, `shengji_${roomId}`, null, userId);
      this.localTrack = await AgoraRTC.createMicrophoneAudioTrack();
      await this.client.publish([this.localTrack]);
      this.joined = true;
      this.updateUI('语音中');
      console.log('Voice joined');
    } catch (err) {
      console.error('Voice join failed', err);
      this.updateUI('连接失败');
    }
  },

  async leave() {
    if (!this.joined) return;
    try {
      this.localTrack?.stop();
      this.localTrack?.close();
      await this.client.leave();
      this.joined = false;
      this.updateUI('已离开');
    } catch (err) {
      console.error('Voice leave failed', err);
    }
  },

  toggleMute() {
    if (!this.localTrack) return;
    this.muted = !this.muted;
    this.localTrack.setMuted(this.muted);
    document.getElementById('btn-mute').textContent = this.muted ? '开麦' : '静音';
    document.getElementById('voice-status').textContent = this.muted ? '已静音' : '语音中';
    document.getElementById('voice-status').classList.toggle('muted', this.muted);
  },

  updateUI(text) {
    const el = document.getElementById('voice-status');
    if (el) el.textContent = text;
  }
};
