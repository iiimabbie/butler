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
