# LLM AI玩家使用说明

## 功能介绍

- 添加AI玩家进行游戏
- 支持规则AI（不需要API Key）和LLM AI（需要配置）
- 混合架构：专用算法负责规则验证，LLM负责策略决策

## 快速开始

### 1. 只使用规则AI（不需要配置）

直接启动游戏，添加的AI会使用规则AI进行游戏：

```bash
npm start
```

规则AI会：
- 亮主：有2张同级牌就亮
- 跟牌：遵循跟牌规则，出合理的牌
- 首家：出大牌或对子

### 2. 使用LLM AI（可选）

1. 复制配置文件：
```bash
cp config.example.js config.js
```

2. 编辑 `config.js`，填入你的API Key：
```javascript
module.exports = {
  llm: {
    provider: 'anthropic', // 或 'openai'
    apiKey: 'sk-...',      // 你的API Key
    model: 'claude-3-haiku-20240307'
  }
};
```

3. 启动游戏：
```bash
npm start
```

## 如何游戏

1. 游客登录
2. 创建房间
3. 点击"添加AI玩家"按钮，添加3个AI
4. 点击"准备"
5. 开始游戏！

## 架构说明

- `llm-client.js`: LLM API调用封装（支持Anthropic和OpenAI）
- `llm-ai.js`: AI玩家实现，包括记牌器、候选生成器、LLM决策
- `game.js`: 游戏引擎（已添加tricks记录）
- `server.js`: 服务器，已集成AI玩家管理
