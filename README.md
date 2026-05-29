# sns-assistant

Slackのスレッドでメンションするだけで、**X・Instagram・Facebook用の告知文案をGemini AIが自動生成**するGoogle Apps Script BOTです。鼓童スタッフの千栄さんのSNS投稿業務を自動化するために開発されました。

---

## できること

| 機能 | 内容 |
|---|---|
| ✍️ 3プラットフォーム文案生成 | X（140文字制限考慮）・Instagram・Facebookの告知文を一括生成 |
| 💬 Slackスレッド連携 | スレッドに集めた情報（日時・会場・URLなど）を自動収集して文案に反映 |
| 🔐 セキュリティ検証 | Slackの署名（HMAC-SHA256）を検証し、不正リクエストを拒否 |
| 🔁 重複実行防止 | イベントIDのキャッシュ管理で同じリクエストを二重処理しない |
| 📝 実行ログ | 処理件数・成功/エラー/スキップの集計をログ出力 |

---

## 使い方

```
① Slackの任意チャンネルで告知の素材を本線投稿
   例：「7月公演の告知」

② そのスレッドの返信欄に日時・会場・URLなどを追記

③ 情報が揃ったら、スレッド内で以下のようにメンション：
   「@SNS投稿アシスタント 文案お願いします」

④ BOTがスレッド内の情報を収集し、X/Instagram/Facebook用の
   文案3本をスレッドに返信
```

---

## 仕組み

```
Slackでメンション受信
  ↓
doPost() でWebhook受信 → Slack署名検証
  ↓
スレッド内メンション → キューシート（Spreadsheet）に保存
  ↓
processQueue() でキューを処理
  ↓
Gemini AIにスレッド情報を送信 → 3プラットフォーム用文案を生成
  ↓
Slackスレッドに返信投稿
```

---

## 設定方法

### スクリプトプロパティ

| キー | 内容 |
|---|---|
| `SLACK_BOT_TOKEN` | `xoxb-` から始まるBot User OAuth Token |
| `SLACK_SIGNING_SECRET` | Slack Appのシークレットキー（署名検証用） |
| `GEMINI_API_KEY` | Gemini API キー（`AIzaSy...`） |
| `SPREADSHEET_ID` | 実行ログ・キュー管理用SpreadsheetのID |

### Slack App 設定

| 設定項目 | 値 |
|---|---|
| Event Subscriptions URL | GAS Web App のデプロイURL |
| 購読イベント | `app_mention` |
| Botスコープ | `chat:write`, `channels:history`, `app_mentions:read` |

### GAS Web App デプロイ設定

- **実行ユーザー**: 自分（スプレッドシートオーナー）
- **アクセス権**: 全員（匿名ユーザーを含む）

### トリガー設定

| 関数名 | タイミング |
|---|---|
| `processQueue` | 毎分（キューを順次処理するため） |

---

## 関連スプレッドシート

| シート名 | 用途 |
|---|---|
| SNSアシスタント実行Log | 実行ログとキュー管理 |

---

## 技術スタック

- Google Apps Script (GAS)
- Gemini AI API（文案生成）
- Slack Events API（メンション受信）
- Slack Web API（`chat.postMessage`, `conversations.replies`）
- HMAC-SHA256署名検証（セキュリティ）
- CacheService（重複防止）
- Google Spreadsheet API（キュー・ログ管理）
