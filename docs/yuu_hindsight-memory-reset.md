# Hindsight 設定備份與記憶清空小抄

## 目前的設定備份

- Bank：`butler-discord`
- 備份檔：[butler-discord-settings.json](../backups/hindsight/2026-10-08T01-40-48-791Z/butler-discord-settings.json)
- 這份備份包含 bank 自訂設定、完整生效設定、名稱與性格參數，以及 directives／aliases／webhooks 資訊。
- 不含記憶、文件、observations 或知識頁內容；不能用來復原被刪除的記憶。
- 此備份是 2026-10-08 的設定快照。清空腳本執行時會另外備份當下設定，並用當下設定重建，不會自動套用這份舊快照。

## 清空後會留下什麼？

腳本會先備份當下設定，再刪除整個 bank、重建同名 bank，還原 bank 名稱、自訂設定及 directives。

會清除該 bank 的記憶、observations、原始文件、人物實體及知識頁內容。其他 bank 不受影響。

不會清除 Butler 的本地聊天紀錄、SQLite 資料、人物 markdown 或本地待送記憶批次。

## 執行前

1. 先讓 Butler 待送記憶批次處理完。
2. 停止 Butler 與其他會寫入此 bank 的來源；Hindsight 服務本身保持運行。
3. 等待 Hindsight 背景工作完成。仍有 pending／processing operations 或待 consolidation 的資料時，腳本會拒絕清空。

若舊批次還沒送完，重啟 Butler 後仍可能把舊資料寫回。後續新聊天也會產生新記憶；空白狀態只代表重置完成當下。

## 指令

先進入專案目錄：

```bash
cd /home/iiimabbie/workspace/butler
```

### 預覽：不刪資料

```bash
node scripts/clear-hindsight-memory.mjs
```

預設從 config.yaml 讀取 memory.bankId 與 memory.baseUrl，只查詢目標與資料數量，不建立備份、不修改服務。

### 正式清空 butler-discord

**記憶刪除無法復原。設定備份不是記憶備份。**

```bash
node scripts/clear-hindsight-memory.mjs \
  --bank-id butler-discord \
  --execute \
  --confirm-bank butler-discord
```

`--confirm-bank` 必須與目標 bank ID 完全相同。腳本不會自行停止或重啟 Butler。

### 查看說明

```bash
node scripts/clear-hindsight-memory.mjs --help
```

## 執行結果與備份

清空前的設定會保存在：

```text
backups/hindsight/<UTC 時間>/<bank-id>-before-reset.json
```

腳本會印出實際備份位置，並在重建後核對自訂設定與 directives，確認記憶節點、文件與知識頁為空。

- 收到完成訊息後，再啟動 Butler。
- aliases 或 webhooks 非空時，腳本會拒絕執行，避免遺失額外設定。
- 刪除或重建中途失敗時，腳本會停止並印出失敗階段與備份路徑；bank 可能已刪除或設定尚未完整還原。
- 不要遇到錯誤就直接重跑，尤其是 timeout 或 HTTP 5xx。先確認 bank 當前狀態，再決定如何還原設定。
