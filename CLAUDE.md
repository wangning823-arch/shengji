# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

联网"升级"（拖拉机/80分）扑克牌游戏。4人固定，2v2对家合作，支持2/3/4副牌模式。

## Commands

```bash
npm run dev          # 开发运行 (tsx 直接运行 TypeScript, 默认端口 3003)
npm run build        # 编译 TypeScript → dist/
npm run typecheck    # 仅类型检查, 不输出文件
npm start            # 生产运行 (node dist/server.js)
```

无 test runner 配置。`test-game.js` 是 WebSocket 集成测试脚本 (需先启动服务器):

```bash
npm run dev &
node test-game.js
```

## Architecture

```
浏览器 (public/)  ←WebSocket→  server.ts  ←→  game.ts (游戏引擎)
                                  ↕              ↓
                               db.ts         advanced-ai.ts (规则AI)
                           (data.json)          ↓
                                            llm-ai.ts (LLM AI, 可选)
                                                 ↓
                                            llm-client.ts (Anthropic/OpenAI API)
```

### 核心文件

| 文件 | 职责 |
|------|------|
| `game.ts` (1185行) | 无状态游戏引擎: 牌组生成、发牌、叫主/反主、出牌校验、牌型识别(单张/对子/拖拉机/甩牌)、墩结算、升级判定。纯逻辑, 不依赖网络或UI |
| `server.ts` (1699行) | HTTP 静态文件服务 + WebSocket 游戏服务器。管理房间、玩家、AI代理、向客户端广播游戏事件 |
| `advanced-ai.ts` (2074行) | 基于规则的AI: 牌力评估、记牌器、候选牌生成、出牌策略(首家/跟牌/毙牌/垫牌/抠底) |
| `llm-ai.ts` (948行) | LLM AI 封装: 调用 advanced-ai 生成候选, 通过 LLM 做策略选择。纯规则AI无需 API Key 即可使用 |
| `llm-client.ts` (183行) | LLM API 客户端: 支持 Anthropic / OpenAI / 自定义兼容接口 |
| `db.ts` (106行) | JSON 文件持久化 (data.json): 用户、房间、游戏记录 |
| `public/app.js` (1500行) | 前端 SPA (Vanilla JS): 登录、大厅、房间、游戏牌桌、聊天 |
| `public/index.html` | 单页 HTML, 游戏 UI 结构 |
| `public/style.css` | 全部样式 |

### 游戏状态机

```
waiting → dealing → bidding → taking_bottom → playing → ended
```

- **dealing**: 逐轮发牌, 每轮发4张(从庄家开始)。最后一张前询问是否亮主(荒庄处理)
- **bidding**: 亮主/反主回合, 按座位顺序进行。支持加固(3张+同色级牌)
- **taking_bottom**: 庄家从手牌中扣底牌
- **playing**: 4人轮流出牌, 每墩结算

### 座位与队伍

座位 0=北, 1=东, 2=南, 3=西。同队: 0&2 (team1) vs 1&3 (team2), `seat % 2 === 0` 为 team1。

### WebSocket 协议

客户端与服务端通过 JSON 消息通信, 所有消息含 `type` 字段。关键消息类型:
- 客户端→服务端: `auth`, `create_room`, `join_room`, `sit`, `ready`, `bid` (亮主/反主), `set_bottom`, `play_cards`
- 服务端→客户端: `room_state`, `game_started`, `cards_dealt`, `bid_made`, `trump_confirmed`, `bottom_taken`, `turn_changed`, `cards_played`, `trick_ended`, `game_ended`, `game_state`

### 亮主/反主规则

`bid` 消息携带 `cards`(级牌) + 可选 `jokers`(王)。反主需 ≥ 当前亮主的级牌数, 且王必须更大。无主可用纯王对亮(≥2张王)。

### AI 系统

- **FallbackAI** (advanced-ai.ts): 规则AI, 无需配置。亮主策略: 有2张同级牌就亮; 出牌: 遵循跟牌规则
- **LLMAIPlayer** (llm-ai.ts): 需要 `config.js` 配置 API Key。先用 advanced-ai 生成候选(记牌、评估), 再通过 LLM 进行策略选择
- AI 通过 `add_ai` WebSocket 消息加入房间, 服务端自动托管其出牌和叫主

### 配置

`config.js` (gitignored, 从 `config.example.js` 复制) 配置 LLM 接入: provider (anthropic/openai/custom), apiKey, model, baseURL, timeout。