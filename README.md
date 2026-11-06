# Butler

跑在 Discord 上的個人 AI 助理。原生 Node 服務，用 OpenAI Responses 相容的 API 呼叫模型，可以在多人頻道裡跟人和其他 bot 對話；各頻道共用同一份長期記憶，session 會持久保存。

## 功能

- **對話**：只回應 `.data/config/channels.yaml` 列出的頻道，每個頻道一個 session，可以設定回覆模式（全部回、被提及才回、不回）和 queue／steer。對話接近模型上限時會自動壓縮。
- **附件**：原檔存在 `.data/attachments/`，以原生圖片或檔案輸入送給模型；音訊用 Groq Whisper 轉成文字。
- **長期記憶**：選用 [Hindsight](services/hindsight/README.md)，每輪自動 recall，也提供 `memory_recall`、`memory_reflect` 和知識頁工具。
- **工具**：Discord 訊息與論壇、Google（Gmail、日曆、Tasks、Drive）、網頁搜尋（Tavily／AnySearch／Firecrawl）、天氣（Open-Meteo）、主機檔案與 shell、hledger 記帳、排程與提醒、生圖、背景子代理（Codex CLI），以及在 QuickJS 沙箱裡串接唯讀工具的 `code_execute`。
- **外部通知**：選用的 HTTP 端點 `POST /notifications`，用來接收手機通知，存進 SQLite 後交給指定頻道處理。
- **管理 UI**：只負責 Google OAuth，只綁在 `127.0.0.1`，要放在有存取控制的反向代理後面。

主機工具不是沙箱，shell 會繼承服務的環境變數與權限。只把 bot 放在信任的伺服器和頻道。

## 需求

- Node.js 24.21.0（需要內建的 `node:sqlite`）
- 一個 OpenAI Responses 相容的 LLM 端點（同時要有 `/models`）
- 選用：Docker（Hindsight、hledger）、Google Desktop OAuth client、各網頁搜尋服務的 API key

## 安裝與設定

```sh
npm install
npm run build
cp config.example.yaml .data/config.yaml   # 填入自己的值，權限設 600
```

- 所有設定都在 `.data/config.yaml`，欄位說明見 [`config.example.yaml`](config.example.yaml)。至少要填 `discord.token`、`discord.ownerId`、`llm.baseUrl`、`llm.model`，其他區塊省略就是停用。
- 大部分設定存檔後會熱更新；`discord.token`、`ownerId`、`paths`、`ui`、`google` 和 memory 的啟停要重啟才生效。
- 要追蹤的頻道寫在 `.data/config/channels.yaml`。
- Bot 需要開啟 Guilds、GuildMessages、Message Content 三個 intent。
- `workspace/` 底下的 `SOUL.md`、`AGENT.md`、`OWNER.md`、`MEMORY.md` 是人格、規則與背景資料，每個 session 讀一次。這個資料夾不進版控。

## 執行與部署

Butler 以 systemd unit `butler` 常駐，範本在 [`scripts/butler.service`](scripts/butler.service)，裡面的路徑要改成自己的。

```sh
npm start            # sudo systemctl start butler，等 Discord ready 才返回
npm run status
npm stop             # 會先把進行中的工作做完
npm run deploy       # build 後切換；新版沒有 ready 就回到上一版 dist
npm run discord:register   # slash command 有變更時才需要
```

- 部署不會安裝依賴，依賴有變更要自己跑 `npm install`。
- 在 Discord 叫 Butler 改完程式後部署，結果會回報到原頻道。
- 服務 log 在 `.data/service/butler.log`，部署 log 在 `.data/deploy/deploy.log`。

## Slash commands

`/status`、`/new`、`/model`、`/img_model`、`/mode`（queue／steer）、`/replymode`、`/compact`、`/bot_reply`、`/restart`

## 資料位置

全部在 `.data/`，不進版控：

- `butler.sqlite`：對話、工具紀錄、排程
- `attachments/`：附件原檔
- `finance/`：hledger 帳本
- `google/`：OAuth token
- `config/`：頻道設定

## 文件

- [維運小抄：啟停、部署與看 log](docs/yuu_operations.md)
- [Hindsight 記憶清空小抄](docs/yuu_hindsight-memory-reset.md)
- [Agent Reach 唯讀工具](docs/agent-reach-tool.md)
- [Hindsight 服務](services/hindsight/README.md)
