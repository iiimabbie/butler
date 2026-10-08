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

第一個命令看最近 80 行；第二個持續追蹤新訊息。看完按 `Ctrl+C` 只會停止觀看 log，不會停止 Butler。設定 reload 訊息也記在 `.data/service/butler.log`：`Config reload applied` 表示已套用；`Config reload rejected` 表示仍使用前一版；`restart required` 表示候選整份未套用，需重啟。每次部署 log 位於 `.data/deploy/<UUID>.log`，最近一次結果位於 `.data/deploy/last-result.json`；worker 啟動錯誤資訊位於 `.data/service/deploy-start-error.json`。

```sh
jq . .data/deploy/last-result.json
jq . .data/service/deploy-start-error.json
DEPLOY_LOG="$(ls -t .data/deploy/*.log | head -n 1)" && tail -n 80 "$DEPLOY_LOG"
```

## 簡單故障處理

1. 先看 `npm run status`，確認服務狀態與 PID 資訊。
2. 用 `tail -n 80 .data/service/butler.log` 看服務錯誤；部署問題再查看 `.data/deploy/last-result.json`、最近的 `.data/deploy/<UUID>.log`，或 `.data/service/deploy-start-error.json`。
3. 確認沒有工作要保留後，才考慮 `npm restart`；要切換新版時使用 `npm run deploy`。若 `package.json` 或 `package-lock.json` 與 ready baseline 不同，部署會拒絕自動進行。

不要用 `killall` 或不分辨程序的強制終止命令，也不要 reset/清空資料庫。服務不會開機自啟，也不會自動 crash-replay；一般異常不會自動重啟或重播未完成請求。


## 錯誤通知

可在 `discord.errorWebhookUrl` 設定 Discord webhook（`https://discord.com/api/webhooks/<id>/<token>`），錯誤才會送到指定目的地；不設定則只寫本機日誌。`discord.errorWebhookMentionUserId` 可設定通知自動標記的數字使用者 ID，`discord.errorWebhookThreadId` 可設定論壇內既有貼文（thread）ID，並以 `thread_id` 發送，不會建立新貼文。這三個欄位可熱更新或移除，後續錯誤即生效。每則錯誤會送出一張 Embed 卡片，外送內容僅含診斷資訊，不含工具參數／結果、聊天內容或 HTTP 回應本文；卡片描述最多 4,096 字元，過長時截斷並附本機完整 log 位置，本機 stdout/stderr 保留完整遮罩後錯誤。配置的告警 webhook 卡片文字會由 Butler 讀入。通知失敗只記錄本機分類或 HTTP 狀態，不阻塞聊天。程序致命錯誤、主機中斷時不保證 webhook 送達。

Session UI 預設列出目前仍由頻道使用的 Session，可切換至封存列表；兩者都能查閱原始對話與工具紀錄。需要依日期查看純對話時，可在 Discord 請 Butler 使用 `journal_transcript_by_date`，提供完整 `YYYY-MM-DD`；日期依 `schedule.timezone`（預設 `Asia/Taipei`），跨目前與封存 Session，包含 Butler 實際送達 Discord 的文字，不含排程內部輸入或工具結果，長結果以 `next_offset` 續讀。此功能只涵蓋 Butler 已收錄的內容，不包含日記生成或日期 UI。

Bot Reply 開啟時，明確提及 Butler 的 bot 或 webhook 訊息可在允許頻道觸發 ask.error-log webhook 自己的訊息也遵守此規則；為避免通知循環，處理該 webhook 訊息的 async context 只抑制後續錯誤通知的自動 mention，錯誤仍會送出。

## 對話上下文與 token 用量

每個附件原檔單檔上限為 20 MiB；下載批次與歷史附件不再共用累積總量限制。每次 ask 會在發送 Responses 前以 CPA `/messages/count_tokens` 計算文字、developer/system 指令和工具 schema；這是本地預估，圖片與檔案原生輸入不在文字計數覆蓋內。若計數路由不可用，會退回 Unicode 字元估算並標示來源，不影響一般聊天。

上下文達已知模型上限或 fallback 工作預算的 80% 時會嘗試自動 compact，保留最近 10 則訊息及正在處理的使用者／steer 原文；persistent 摘要只寫 checkpoint，不刪 SQLite 原始訊息、附件或工具紀錄。工具迴圈中的較早完整互動群組也會在記憶體中摘要，工具呼叫與結果保持成組，不會重跑工具。達 100% 預算仍無法壓縮到安全範圍時，ask 會停止而不靜默裁切內容。

成功 Responses 回傳的 `usage.input_tokens`／`output_tokens` 是唯一實測用量，`/status` 會顯示最近一次實測及採樣模型、時間和當時使用的限制；尚無實測時會明示。當前請求的預檢是預估，不等同該次回應的 usage。`llm.modelContextTokens` 以精確模型 ID 設定已知上限（目前 `gpt-6.1-sol: 272000`）；其他模型不按名稱推測，使用 `llm.maxContextTokens`（預設 150000）的 configured budget。
