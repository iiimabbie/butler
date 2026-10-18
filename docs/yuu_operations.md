# Butler 維運小抄

```sh
cd /home/iiimabbie/workspace/butler
nvm use 24.21.0
```

先切到專案目錄並選用 Butler 目前要求的 Node 版本，再執行以下命令。

## 常用情境

| 想做什麼 | 命令 | 說明 |
|---|---|---|
| 啟動常駐 Butler | `npm start` | 啟動目前 `dist`；等 Discord ready 才回報成功。 |
| 查看服務狀態 | `npm run status` | 查看服務是否執行及程序／log 資訊。 |
| 停止 Butler | `npm stop` | 要求正常停止並等待結束。 |
| 重啟目前版本 | `npm restart` | 停止後重啟現有 `dist`；不 build、不 slash-register。 |
| 建置並部署程式 | `npm run deploy` | 暫存 build；最多等 10 分鐘讓 queue 與 local jobs 收尾，備份並切換 `dist`，正常停止舊版後啟動新版並等待 ready；candidate 失敗時確認程序退出後回復一次。`package.json` 或 `package-lock.json` 與 ready baseline 不同時拒絕部署。 |
| Discord slash command 有變更 | `npm run discord:register` | 明確同步 commands；會清除本 application 的 global commands 與 joined guild commands，再註冊完整 guild commands。 |

日常編輯根目錄 `config.yaml` 後，服務會自動熱更新可熱更新欄位；改到冷欄位（Discord token/owner、paths、UI、Google、memory 啟停或目標）或同次候選混有冷熱變更時，整份候選會拒絕，請修正為純熱變更或安排重啟。無效 YAML／缺檔／設定錯誤保留最後有效版本，修正後存檔重試。

日常不需要執行 slash registration。`npm run deploy` 不應自動註冊 commands；只有 slash command 變更並要同步時才執行既有的 `npm run discord:register`。舊 `npm run discord:deploy` 是 build 加註冊 commands，不是日常程式部署入口。

## 直接編輯排程與頻道設定

服務首次啟動時會把既有 cron、reminder 與頻道行為設定搬到 `.data/config/`；搬移前會在 `.data/` 建立含已提交 WAL 的一致 SQLite 備份，服務 log 會記錄實際備份路徑。搬移完成後，設定檔是唯一編輯來源，舊設定資料表會移除；SQLite 保留執行時點、執行紀錄與政策 revision。

- `.data/config/crons.yaml` 與 `reminders.yaml` 是兩格縮排 YAML 清單，`content: |` 底下可以直接換行；`|-` 同樣保留段落換行，但不在文字末尾多加換行。Discord ID 與時間請用引號包住。每筆需有唯一的 `id`、建立者 Discord ID `creatorId`、目的頻道 ID `outputChannelId`、任務內容 `content`、建立時間 `createdAt`；cron 項目另需 `cron` 表達式，reminder 項目另需帶時區的 ISO `runAt`。`timezone` 可省略（沿用根設定的時區，預設 `Asia/Taipei`），`enabled` 可省略（預設 `true`），`notify` 可省略（預設 `always`）或設為 `on_event`。`nextRun` 等執行狀態不放在檔案裡。
- `.data/config/channels.yaml` 使用 `channels:` map；每個 entry 的存在就代表追蹤，空設定 `{}` 也有效。只支援 `botReply`、`hindsightWrite`、`replyMode`、`mode`、`model`、`effort`、`imageModel`；省略或 `null` 使用全域預設，不繼承父頻道。一般頻道預設 `hindsightWrite: false`、`mode: steer`；明確填寫的設定優先。固定錯誤通知頻道由 `config.yaml` 的 `discord.errorWebhookThreadId`（且設定 `errorWebhookUrl`）推導，不可列入或覆寫。
- 手動存檔會在短暫去抖後整份驗證再套用。無效內容會保留前一個有效設定並在 log 指出檔案／錯誤；請修正後再存檔。若刪除 entry 的頻道仍有工作進行，這次套用會拒絕並繼續使用上一份設定；請等工作結束後重新存檔。有效設定若無法寫入 runtime DB，服務會停止而不是繼續使用舊政策。
- 修改任務內容、目的頻道或通知模式不會重排既有 `nextRun`；修改 cron、`runAt`、timezone 或 enabled 才會依原有語意重算。reminder 的同一 `id` 與同一排程時點不會重播；改 `runAt` 可建立新的排程時點。已完成 reminder 定義會保留，需手動移除。
- UI 與 bot 頻道管理會更新同一份檔案；只有明確新增追蹤才會建立 entry，讀取頻道清單不會加入追蹤。手動編輯不要用舊副本覆蓋最新內容。UI 顯示的頻道名稱與 parent 關係只作 Discord 展示資料；生效值來源為「此頻道設定」、「全域預設」或固定 Alert 政策。

例如 reminder 可以這樣寫；請將示範 ID 換成實際 ID，並選擇未來的提醒時間：

```yaml
- id: water-plants
  creatorId: "100000000000000001"
  outputChannelId: "100000000000000002"
  content: |-
    提醒我澆花。

    陽台和書桌上的都要。
  runAt: "2099-01-01T09:00:00+08:00"
  createdAt: "2026-10-18T00:00:00+08:00"
```

頻道設定範例（請換成實際頻道 ID）：

```yaml
channels:
  "100000000000000002":
    botReply: false
    replyMode: mention
    model: null # 使用全域預設
```

## Discord 的 `/restart` 與 `npm restart`

Discord `/restart` 是聊天中的受控重啟請求：只有全頻道沒有進行中或排隊工作時才受理，並由 managed service 按既有流程重啟。終端機 `npm restart` 則由人直接停止並重新啟動常駐服務，使用目前已建置的 `dist`，不會重新 build。要更新程式時使用部署流程，不要把 restart 當成 deploy。

## 部署與回復

部署流程先在暫存目錄 build；build 成功後最多等待 10 分鐘讓 queue 與 local jobs 收尾，quiesce 會保持到舊版停止。接著備份目前 `dist`、切換 candidate，正常停止舊 worker，再啟動新版並等待 Discord ready。candidate 未 ready 時先確認 candidate 程序已退出，再回復備份 `dist` 並嘗試啟動舊版一次；不會無限重試。`package.json` 或 `package-lock.json` 與最近一次 ready baseline 不同時，拒絕自動部署。

回復範圍僅是 `dist`。不會回復來源碼、UI 檔案、資料庫、workspace、設定、附件或 OAuth token。`package.json`／lockfile／依賴變更不由 dist 回復處理；`package.json` 或 `package-lock.json` 與最近一次 ready baseline 不同時，部署會拒絕自動進行，依賴更新需人工另行處理。UI 或 schema 變更也需另外人工確認。部署不自動改 Discord slash commands。

若要在 Discord 請 Butler 修改完成後部署，可直接告訴它「修改完成後部署」。這會透過 `butler_deploy` 排定本輪結束後執行部署，先回報已受理，不會讓聊天等待同步 shell 重啟；受理不代表部署已完成。結果可請 Butler 用 `local_read` 讀取 `.data/deploy/last-result.json`。

## 看 log

服務 log 目前位置為 `.data/service/butler.log`：

```sh
tail -n 80 .data/service/butler.log
tail -f .data/service/butler.log
```

第一個命令看最近 80 行；第二個持續追蹤新訊息。看完按 `Ctrl+C` 只會停止觀看 log，不會停止 Butler。設定 reload 訊息也記在 `.data/service/butler.log`：`Config reload applied` 表示已套用；`Config reload rejected` 表示仍使用前一版；`restart required` 表示候選整份未套用，需重啟。每次部署 log 位於 `.data/deploy/runs/<UUID>/deploy.log`，最近一次結果仍位於 `.data/deploy/last-result.json`；worker 啟動錯誤資訊位於 `.data/service/deploy-start-error.json`。部署紀錄會自動保留最近 3 次已結束（completed 或 failed）的部署；執行中、待核對及無法確認狀態的紀錄不會刪除。

```sh
jq . .data/deploy/last-result.json
jq . .data/service/deploy-start-error.json
DEPLOY_LOG="$(jq -r '.log' .data/deploy/last-result.json)" && tail -n 80 "$DEPLOY_LOG"
```

## 簡單故障處理

1. 先看 `npm run status`，確認服務狀態與 PID 資訊。
2. 用 `tail -n 80 .data/service/butler.log` 看服務錯誤；部署問題再查看 `.data/deploy/last-result.json`、最近的 `.data/deploy/runs/<UUID>/deploy.log`，或 `.data/service/deploy-start-error.json`。
3. 確認沒有工作要保留後，才考慮 `npm restart`；要切換新版時使用 `npm run deploy`。若 `package.json` 或 `package-lock.json` 與 ready baseline 不同，部署會拒絕自動進行。

不要用 `killall` 或不分辨程序的強制終止命令，也不要 reset/清空資料庫。服務不會開機自啟，也不會自動 crash-replay；一般異常不會自動重啟或重播未完成請求。


## 錯誤通知

可在 `discord.errorWebhookUrl` 設定 Discord webhook（`https://discord.com/api/webhooks/<id>/<token>`），錯誤才會送到指定目的地；不設定則只寫本機日誌。`discord.errorWebhookMentionUserId` 可設定通知自動標記的數字使用者 ID，`discord.errorWebhookThreadId` 可設定論壇內既有貼文（thread）ID，並以 `thread_id` 發送，不會建立新貼文。這三個欄位可熱更新或移除，後續錯誤即生效。每則錯誤會送出一張 Embed 卡片；HTTP 429 錯誤也會送出 webhook，但不會自動標記設定的使用者。外送內容僅含診斷資訊，不含工具參數／結果、聊天內容或 HTTP 回應本文；卡片描述最多 4,096 字元，過長時截斷並附本機完整 log 位置，本機 stdout/stderr 保留完整遮罩後錯誤。配置的告警 webhook 卡片文字會由 Butler 讀入。通知失敗只記錄本機分類或 HTTP 狀態，不阻塞聊天。程序致命錯誤、主機中斷時不保證 webhook 送達。

Session UI 預設列出目前仍由頻道使用的 Session，可切換至封存列表；兩者都能查閱原始對話與工具紀錄。需要依日期查看純對話時，可在 Discord 請 Butler 使用 `journal_transcript_by_date`，提供完整 `YYYY-MM-DD`；日期依 `schedule.timezone`（預設 `Asia/Taipei`），跨目前與封存 Session，包含 Butler 實際送達 Discord 的文字，不含排程內部輸入或工具結果，長結果以 `next_offset` 續讀。此功能只涵蓋 Butler 已收錄的內容，不包含日記生成或日期 UI。

Bot Reply 開啟時，明確提及 Butler 的 bot 或 webhook 訊息可在允許頻道觸發 ask.error-log webhook 自己的訊息也遵守此規則；為避免通知循環，處理該 webhook 訊息的 async context 只抑制後續錯誤通知的自動 mention，錯誤仍會送出。

## 對話上下文與 token 用量

每個附件原檔單檔上限為 20 MiB；下載批次與歷史附件不再共用累積總量限制。每次 ask 會在發送 Responses 前以 CPA `/messages/count_tokens` 計算文字、developer/system 指令和工具 schema；這是本地預估，圖片與檔案原生輸入不在文字計數覆蓋內。若計數路由不可用，會退回 Unicode 字元估算並標示來源，不影響一般聊天。

上下文達已知模型上限或 fallback 工作預算的 80% 時會嘗試自動 compact，保留最近 10 則訊息及正在處理的使用者／steer 原文；persistent 摘要只寫 checkpoint，不刪 SQLite 原始訊息、附件或工具紀錄。工具迴圈中的較早完整互動群組也會在記憶體中摘要，工具呼叫與結果保持成組，不會重跑工具。達 100% 預算仍無法壓縮到安全範圍時，ask 會停止而不靜默裁切內容。

成功 Responses 回傳的 `usage.input_tokens`／`output_tokens` 是唯一實測用量，`/status` 會顯示最近一次實測及採樣模型、時間和當時使用的限制；尚無實測時會明示。當前請求的預檢是預估，不等同該次回應的 usage。`llm.modelContextTokens` 以精確模型 ID 設定已知上限（目前 `gpt-6.1-sol: 272000`）；其他模型不按名稱推測，使用 `llm.maxContextTokens`（預設 150000）的 configured budget。
