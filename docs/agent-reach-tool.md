# Agent Reach 唯讀工具

Butler 的 `agent_reach` 會出現在工具索引；完整定義透過 `tools_catalog` 載入。需要主機工具 runtime 及 PATH 中的官方 Agent Reach CLI。平台依賴與登入另行管理，不由本工具安裝或變更。

## 呼叫

先查平台能力：

```json
{"action":"capabilities","platform":"xiaohongshu"}
```

再使用回傳的 action 與 params：

```json
{"action":"search","platform":"xiaohongshu","params":{"query":"AI","limit":5}}
```

讀取筆記使用 `action=read`、`params.target`；讀取留言使用 `action=comments`。保留搜尋回傳的完整 URL 與必要的 xsec_token，不從網域推斷帳號地區。留言僅涵蓋上游已載入的部分。

一般網頁優先使用 `web_search`／`web_fetch`；平台文章、影片與字幕使用此工具。也可在 `code_execute` 中呼叫以縮減結果。

## 邊界

- Butler 明列可執行的唯讀 action，上游新增功能不會自動獲准。能力查詢只表示介面宣告，不表示登入、依賴或連線已驗證。
- 不包含發文、留言寫入、按讚、登入、設定變更或會消耗轉錄額度的 transcribe。
- 使用 execFile，不經 shell；參數依安裝版本的能力描述驗證，禁止額外旗標；選填參數以 `--name=value` 傳遞，必填參數置於 `--` 之後，以 `-` 開頭的查詢字串不會被當成旗標。整數參數限制 1～50。
- 預設總時限 60 秒，最多 120 秒，含能力查詢；接受上層取消訊號。程序輸出上限 2 MiB，超量明確失敗。
- 以上游 JSON 的 `ok` 判定成敗：成功時原樣回傳結果與完整性資訊；失敗時只以上游錯誤代碼與訊息作為工具錯誤，不論程序結束碼。
- 能力宣告於每個 Butler 程序首次成功查詢後快取；升級 Agent Reach CLI 後需重啟 Butler。

## 手動驗證（2026-10-29）

型別檢查與獨立目錄編譯通過；未新增測試檔或執行自動化測試。以編譯後工具確認：工具目錄顯示與按名載入、唯讀清單、能力查詢、GitHub 搜尋、小紅書 AI 搜尋、正文與已載入留言均通過。發文、付費轉錄、未知參數與旗標式查詢均被拒絕，預先取消訊號會中止。沒有發布、留言或按讚。
