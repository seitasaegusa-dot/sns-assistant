// ============================================================
//  千栄さん SNS投稿アシスタント Bot  v5.1（実行ログ強化版）
//
//  【v5.0からの変更点】
//    1. callGemini：使用モデル名・試行回数・所要時間をログ出力
//    2. callGemini：エラー詳細（コード・メッセージ）をログ出力
//    3. processQueue：処理開始時のpending件数をログ出力
//    4. processQueue：各行の処理開始・完了・スキップをログ出力
//    5. processQueue：完了後に 成功/エラー/スキップ の集計サマリーを出力
//    6. doPost：受信したSlackイベントの種別・スレッド有無をログ出力
// ============================================================

// ─────────────────────────────────────────
//  Webhook エントリーポイント
// ─────────────────────────────────────────
function doPost(e) {
  try {
    if (!verifySlackSignature(e)) {
      console.warn('【セキュリティ警告】不正な署名のリクエストを拒否しました。');
      return ContentService.createTextOutput(JSON.stringify({ error: 'Unauthorized' }))
        .setMimeType(ContentService.MimeType.JSON)
        .setStatusCode(401);
    }

    const data = JSON.parse(e.postData.contents);

    if (data.type === 'url_verification') {
      return ContentService.createTextOutput(data.challenge)
        .setMimeType(ContentService.MimeType.TEXT);
    }

    if (data.event_id) {
      const cache = CacheService.getScriptCache();
      if (cache.get(data.event_id)) {
        console.log('重複イベントをスキップ（キャッシュ検知）: ' + data.event_id);
        return ok();
      }
      cache.put(data.event_id, '1', 300);
    }

    if (data.event) {
      const ev = data.event;

      // ★ 受信イベントの種別・スレッド有無をログ出力
      const isThread = !!(ev.thread_ts && ev.thread_ts !== ev.ts);
      console.log(
        `[doPost] 受信: type=${ev.type}, channel=${ev.channel || '不明'}, ` +
        `thread=${isThread ? 'スレッド内' : 'チャンネル本線'}, ` +
        `bot=${ev.bot_id ? 'Bot発言(スルー)' : 'ユーザー発言'}`
      );

      if (ev.type === 'app_mention' && !ev.bot_id) {
        if (ev.thread_ts && ev.thread_ts !== ev.ts) {
          if (isAlreadyQueued(ev.ts)) {
            console.log('重複イベントをスキップ（シート重複検知）: ' + ev.ts);
            return ok();
          }
          saveToQueue(ev);
        } else {
          postToSlack(
            ev.channel,
            null,
            '💡 *使い方*\n' +
            'スレッドの返信欄で `@SNS投稿アシスタント` とメンションしてください。\n\n' +
            '例：\n' +
            '> ① 本線に「7月公演の告知」と投稿\n' +
            '> ② スレッドに日時・会場・URL などを返信\n' +
            '> ③ 情報が揃ったら「@SNS投稿アシスタント 文案お願いします」と返信\n\n' +
            '→ X・Instagram・Facebook の文案を自動生成します。'
          );
        }
      }
    }

    return ok();

  } catch (err) {
    console.error('[doPost エラー]', err.toString());
    return ok();
  }
}

function ok() {
  return ContentService.createTextOutput('ok')
    .setMimeType(ContentService.MimeType.TEXT);
}

// ─────────────────────────────────────────
//  セキュリティ：Slack 署名検証
// ─────────────────────────────────────────
function verifySlackSignature(e) {
  try {
    const signingSecret = getProperty('SLACK_SIGNING_SECRET');
    if (!signingSecret) {
      console.error('「SLACK_SIGNING_SECRET」がスクリプトプロパティに設定されていません！検証をスキップします。');
      return true;
    }

    const headers = e.headers || {};
    const slackSignature  = headers['x-slack-signature']         || headers['X-Slack-Signature'];
    const slackTimestamp  = headers['x-slack-request-timestamp'] || headers['X-Slack-Request-Timestamp'];

    if (!slackSignature || !slackTimestamp) {
      console.warn('署名、またはタイムスタンプヘッダーが見つかりません。');
      return false;
    }

    const now = Math.floor(new Date().getTime() / 1000);
    if (Math.abs(now - parseInt(slackTimestamp, 10)) > 300) {
      console.warn('リクエスト時刻が現在時刻とズレすぎています。');
      return false;
    }

    const requestBody  = e.postData.contents;
    const baseString   = 'v0:' + slackTimestamp + ':' + requestBody;
    const calculatedSignature = 'v0=' + computeHmacSha256(signingSecret, baseString);

    return calculatedSignature === slackSignature;

  } catch (err) {
    console.error('[verifySlackSignature エラー]', err.toString());
    return false;
  }
}

function computeHmacSha256(key, data) {
  const byteSignature = Utilities.computeHmacSignature(
    Utilities.MacAlgorithm.HMAC_SHA_256,
    data,
    key,
    Utilities.Charset.UTF_8
  );

  let signature = '';
  for (let i = 0; i < byteSignature.length; i++) {
    let byteVal = byteSignature[i];
    if (byteVal < 0) byteVal += 256;
    let byteString = byteVal.toString(16);
    if (byteString.length === 1) byteString = '0' + byteString;
    signature += byteString;
  }
  return signature;
}

function isAlreadyQueued(mentionTs) {
  try {
    const sheet = getOrCreateSheet();
    const rows  = sheet.getDataRange().getValues();
    const formattedTs = String(mentionTs);

    for (let i = 1; i < rows.length; i++) {
      const storedTs = String(rows[i][3]).replace(/^'+/, '');
      if (storedTs === formattedTs) return true;
    }
    return false;
  } catch (e) {
    console.error('重複チェックエラー:', e.toString());
    return false;
  }
}

// ─────────────────────────────────────────
//  キューに登録（ロック制御付き）
// ─────────────────────────────────────────
function saveToQueue(event) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) {
    console.error('saveToQueue: ロック取得タイムアウト（処理が混み合っています）');
    throw new Error('システム混雑のため、キューの登録に失敗しました。時間をおいて再試行してください。');
  }

  try {
    const sheet = getOrCreateSheet();
    const rows  = sheet.getDataRange().getValues();

    const incomingThreadTs = String(event.thread_ts);
    for (let i = 1; i < rows.length; i++) {
      const storedTs = String(rows[i][2]).replace(/^'+/, '');
      if (rows[i][1] === event.channel && storedTs === incomingThreadTs) {
        sheet.getRange(i + 1, 1).setValue(new Date());
        sheet.getRange(i + 1, 3).setValue("'" + incomingThreadTs);
        sheet.getRange(i + 1, 4).setValue("'" + String(event.ts));
        sheet.getRange(i + 1, 5).setValue('pending');
        sheet.getRange(i + 1, 8).setValue(0);
        return;
      }
    }

    sheet.appendRow([
      new Date(),
      event.channel,
      "'" + event.thread_ts,
      "'" + event.ts,
      'pending',
      '',
      '',
      0,
      ''
    ]);

  } finally {
    lock.releaseLock();
  }
}

// ─────────────────────────────────────────
//  キューを処理（1分ごとのトリガーで自動実行）
// ─────────────────────────────────────────
function processQueue() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(0)) {
    console.log('processQueue: 別の実行が進行中のためスキップ');
    return;
  }

  try {
    const sheet = getOrCreateSheet();
    recoverStuckQueue(sheet);

    const rows = sheet.getDataRange().getValues();

    // ★ 処理開始時のpending件数をログ出力
    const pendingCount = rows.slice(1).filter(r => r[4] === 'pending').length;
    console.log(`[processQueue] ▶ 開始: pending=${pendingCount}件`);

    // ★ 結果集計カウンター
    let successCount = 0, errorCount = 0, skipCount = 0;

    for (let i = 1; i < rows.length; i++) {
      if (rows[i][4] !== 'pending') continue;

      const channel    = String(rows[i][1]);
      const threadTs   = String(rows[i][2]).replace(/^'+/, '');
      const retryCount = Number(rows[i][7]) || 0;
      const MAX_RETRIES = 5;

      // ★ 各行の処理開始をログ出力
      console.log(
        `[processQueue] 行${i + 1}: 処理開始 ` +
        `(ch=${channel}, thread=...${threadTs.slice(-6)}, retry=${retryCount})`
      );

      sheet.getRange(i + 1, 5).setValue('processing');

      let deadline = null;
      try {
        const messagesForDeadline = fetchThread(channel, threadTs);
        const contextForDeadline  = buildContext(messagesForDeadline);
        deadline = extractDeadline(contextForDeadline);
        if (deadline) {
          sheet.getRange(i + 1, 9).setValue(deadline);
          console.log(`[processQueue] 行${i + 1}: 締め切り検出 → ${deadline}`);  // ★
        }
      } catch (e) {
        console.error('締め切り抽出エラー（スルーします）:', e.toString());
      }

      try {
        const messages = fetchThread(channel, threadTs);
        const context  = buildContext(messages);

        if (context.trim().length < 5) {
          sheet.getRange(i + 1, 5).setValue('skipped: コンテキスト不足');
          skipCount++;  // ★
          console.log(`[processQueue] 行${i + 1}: ⚠ スキップ (コンテキスト不足)`);  // ★
          continue;
        }

        const draft = callGemini(context);
        const fullMessage = draft + (deadline ? `\n\n⏰ 告知締め切り：*${deadline}*` : '');
        const newTs = postToSlack(channel, threadTs, fullMessage);

        sheet.getRange(i + 1, 5).setValue('done');
        sheet.getRange(i + 1, 6).setValue("'" + newTs);
        sheet.getRange(i + 1, 7).setValue(new Date());
        successCount++;  // ★
        console.log(`[processQueue] 行${i + 1}: ✅ 完了 (Slack投稿ts=${newTs})`);  // ★

      } catch (err) {
        console.error(`[processQueue] 行${i + 1}: ✖ エラー: ${err.message}`);  // ★

        if (err.message === 'GEMINI_OVERLOADED') {
          if (retryCount < MAX_RETRIES) {
            sheet.getRange(i + 1, 5).setValue('pending');
            sheet.getRange(i + 1, 8).setValue(retryCount + 1);
            console.log(`[processQueue] 行${i + 1}: ↩ 次回リトライ待機 (${retryCount + 1}/${MAX_RETRIES}回目)`);  // ★
          } else {
            sheet.getRange(i + 1, 5).setValue('fallback_done');

            const fallbackDraft = generateFallbackDraft(buildContext(fetchThread(channel, threadTs)));
            const fullMessage =
              `⚠️ *【AI混雑時の自動フォールバック機能が作動しました】*\n` +
              `現在、Google AIのシステムが極めて混み合っているため、スレッド情報からプログラムが自動抽出した簡易案内を出力しました。本日の告知にはこちらをご活用ください。\n\n` +
              fallbackDraft +
              (deadline ? `\n\n⏰ 告知締め切り：*${deadline}*` : '');

            const newTs = postToSlack(channel, threadTs, fullMessage);
            sheet.getRange(i + 1, 6).setValue("'" + newTs);
            sheet.getRange(i + 1, 7).setValue(new Date());
            errorCount++;  // ★
            console.log(`[processQueue] 行${i + 1}: ⚠ フォールバック文案を送信 (リトライ上限到達)`);  // ★
          }
        } else {
          sheet.getRange(i + 1, 5).setValue('error: ' + err.message);
          errorCount++;  // ★
        }
      }

      Utilities.sleep(1500);
    }

    // ★ 完了サマリーをログ出力
    console.log(
      `[processQueue] ✅ 完了サマリー: 成功=${successCount}件, ` +
      `エラー=${errorCount}件, スキップ=${skipCount}件`
    );

    cleanupQueue(sheet);

  } finally {
    lock.releaseLock();
  }
}

// ★ 6分制限対策：10分以上「処理中(processing)」のまま放置されている行を「pending」に強制復帰
function recoverStuckQueue(sheet) {
  const rows = sheet.getDataRange().getValues();
  const now  = new Date();
  const tenMinutesAgo = new Date(now.getTime() - 10 * 60 * 1000);

  for (let i = 1; i < rows.length; i++) {
    const status     = String(rows[i][4]);
    const receivedAt = new Date(rows[i][0]);

    if (status === 'processing' && receivedAt < tenMinutesAgo) {
      const retryCount = Number(rows[i][7]) || 0;
      if (retryCount < 5) {
        sheet.getRange(i + 1, 5).setValue('pending');
        sheet.getRange(i + 1, 8).setValue(retryCount + 1);
        console.log(`【救済システム】長期間フリーズしていたタスクを pending に戻しました（行: ${i + 1}）`);
      } else {
        sheet.getRange(i + 1, 5).setValue('failed: ゾンビタイムアウト上限');
        console.error(`【救済システム】リトライ回数が上限を超えたため処理を断念しました（行: ${i + 1}）`);
      }
    }
  }
}

// ─────────────────────────────────────────
//  AI不使用：緊急用簡易文案生成
// ─────────────────────────────────────────
function generateFallbackDraft(threadContext) {
  const lines = threadContext.split('\n');
  let eventName = '（スレッドの親メッセージをご確認ください）';
  let datetime  = '（スレッド内の日時をご確認ください）';
  let venue     = '（スレッド内の会場をご確認ください）';
  let url       = '（スレッド内のURLをご確認ください）';

  lines.forEach(line => {
    const cleanLine = line.trim();
    if (cleanLine.includes('公演名') || cleanLine.includes('タイトル') || cleanLine.includes('ツアー')) {
      eventName = cleanLine.replace(/^.*?[:：]/, '').trim() || eventName;
    } else if (cleanLine.includes('日時') || cleanLine.includes('開演') || cleanLine.includes('開催')) {
      datetime = cleanLine.replace(/^.*?[:：]/, '').trim() || datetime;
    } else if (cleanLine.includes('会場') || cleanLine.includes('場所') || cleanLine.includes('ホール')) {
      venue = cleanLine.replace(/^.*?[:：]/, '').trim() || venue;
    }

    if (cleanLine.includes('http') || cleanLine.includes('URL') || cleanLine.includes('url')) {
      const match = cleanLine.match(/https?:\/\/[^\s]+/);
      if (match) url = match[0];
    }
  });

  return `*【緊急用・シンプル告知情報】*\n` +
         `🔔 *公演名*：${eventName}\n` +
         `📅 *日時*：${datetime}\n` +
         `📍 *会場*：${venue}\n` +
         `🔗 *詳細・お申込*：${url}\n\n` +
         `💡 *ヒント*：AIの混雑が解消されましたら、再度 \`@SNS投稿アシスタント\` とメンションしていただければ、通常のX/Instagram/Facebook用文案を再作成いたします。`;
}

// ─────────────────────────────────────────
//  受付簿の自動断捨離
// ─────────────────────────────────────────
function cleanupQueue(sheet) {
  const rows        = sheet.getDataRange().getValues();
  const now         = new Date();
  const sevenDaysAgo = new Date(now - 7 * 24 * 60 * 60 * 1000);

  const toDelete = [];
  for (let i = rows.length - 1; i >= 1; i--) {
    const status     = String(rows[i][4]);
    const receivedAt = new Date(rows[i][0]);
    const isPending  = status === 'pending' || status === 'processing';
    if (!isPending && receivedAt < sevenDaysAgo) toDelete.push(i + 1);
  }

  toDelete.forEach(rowNum => sheet.deleteRow(rowNum));
  if (toDelete.length > 0) {
    console.log(`[cleanupQueue] ${toDelete.length}行を削除しました`);
  }
}

// ─────────────────────────────────────────
//  Slack: スレッド全体を取得
// ─────────────────────────────────────────
function fetchThread(channelId, threadTs) {
  const token = getProperty('SLACK_BOT_TOKEN');
  const url   = 'https://slack.com/api/conversations.replies'
              + '?channel=' + channelId
              + '&ts='      + threadTs
              + '&limit=50';

  const res  = UrlFetchApp.fetch(url, {
    headers: { 'Authorization': 'Bearer ' + token },
    muteHttpExceptions: true
  });
  const json = JSON.parse(res.getContentText());

  if (!json.ok) throw new Error('conversations.replies エラー: ' + json.error);
  return json.messages;
}

// ─────────────────────────────────────────
//  スレッドを Gemini に渡すテキストに整形
// ─────────────────────────────────────────
function buildContext(messages) {
  const lines = [];

  messages.forEach((msg, idx) => {
    let text = (msg.text || '').trim();
    if (text.startsWith('✅')) return;
    text = text.replace(/<@[A-Z0-9]+>/g, '').trim();
    if (!text) return;

    const role = idx === 0 ? '「タイトル（本線）」' : `「返信 ${idx}」`;
    lines.push(role + '\n' + text);
  });

  return lines.join('\n\n');
}

// ─────────────────────────────────────────
//  締め切り日を抽出（Gemini 軽量呼び出し）
// ─────────────────────────────────────────
function extractDeadline(threadContext) {
  try {
    const apiKey = getProperty('GEMINI_API_KEY');
    const prompt =
`以下のSlackスレッドから「告知締め切り日」「投稿期限」「掲載終了日」「申込締切」など、
アクションが必要な期限日を抽出してください。

見つかった場合は「YYYY-MM-DD」形式のみで返してください。
見つからない場合は「なし」とだけ返してください。余計な文字・説明は不要です。

${threadContext}`;

    const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=' + apiKey;
    const res = UrlFetchApp.fetch(url, {
      method: 'POST',
      contentType: 'application/json',
      payload: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0, maxOutputTokens: 20 }
      }),
      muteHttpExceptions: true
    });
    const json = JSON.parse(res.getContentText());
    if (json.error) return null;

    const result = json.candidates[0].content.parts[0].text.trim();
    return /^\d{4}-\d{2}-\d{2}$/.test(result) ? result : null;

  } catch (err) {
    console.error('[extractDeadline]', err.toString());
    return null;
  }
}

// ─────────────────────────────────────────
//  Gemini: X / Instagram / Facebook 文案を生成
// ─────────────────────────────────────────
function callGemini(threadContext) {
  const MODELS = ['gemini-3.5-flash', 'gemini-2.5-flash', 'gemini-2.0-flash'];

  const prompt =
`あなたは鼓童（世界的な和太鼓グループ）のSNS担当アシスタントです。

【鼓童らしい告知スタイルの参考例】
以下は実際に使用されている告知文のスタイル例です。構成・テンポ・言葉のリズムを参考にしてください。

▼参考例（チケット告知）
【チケット情報】
鼓童ワン・アース・ツアー2026「遥か－」
大阪・枚方公演

一般発売：5/21(木) 10:00〜
（※窓口発売は5/22〜）

▼公演詳細
日時：2026年9月12日(土) 15:00
会場：枚方市総合文化芸術センター 関西医大 大ホール

良いお席はお早めに！
お申込はこちら
kodo.or.jp/sche/58419

【参考例から学ぶべきポイント】
- 公演名・地域名を冒頭に明示する
- 発売日・公演日時・会場を構造的に並べる
- 「良いお席はお早めに！」のような自然な呼びかけを入れる
- URLは末尾にシンプルに置く
- 余計な装飾をせず、必要な情報を簡潔に伝える

以下は Slack のスレッドです。
「タイトル（本線）」が件名、「返信」に詳細情報が記載されています。
すべての情報を読み取り、上記スタイルを参考に3媒体の投稿文案を作成してください。

━━━━━━━━━━━━━━━━━━━━
${threadContext}
━━━━━━━━━━━━━━━━━━━━

【出力形式（必ずこの形式で出力）】
※ 警告：以下の各セクションの「[ ]」の部分には、あなたがスレッドから読み取った具体的な公演情報をもとに作成した、本番用の告知文章を「必ず」出力してください。
※ カッコ内の説明文（例：「140文字以内〜」など）をそのまま出力してはいけません。必ず具体的な文案に置き換えて出力してください。

✅ *文案を作成しました。ご確認・修正のうえご利用ください。*

────────────────
𝕏（旧Twitter）
────────────────
[ここに、スレッド情報を元にあなたが作成した、140文字以内の𝕏投稿用の具体的な文章を出力してください。ハッシュタグ2〜3個と、URLがあれば末尾に配置してください。]

────────────────
📸 Instagram
────────────────
[ここに、スレッド情報を元にあなたが作成した、絵文字入りで親しみやすいInstagram用の具体的な文章を出力してください。末尾にハッシュタグ10〜15個（必須ハッシュタグ：#鼓童 #KODO #太鼓 #taiko）を配置してください。]

────────────────
📘 Facebook（日本語）
────────────────
[ここに、スレッド情報を元にあなたが作成した、親しみやすく礼儀正しいFacebook（日本語）用の具体的な詳細文章を出力してください。固くなりすぎない自然なトーンにしてください。]

────────────────
📘 Facebook（English）
────────────────
[ここに、上記のFacebook（日本語）用の文章をあなたが英語に翻訳した具体的な文章を出力してください。海外のお客様に歓迎が伝わる温かい表現にしてください。]

────────────────
⚠️ 確認事項
────────────────
[スレッド内の情報で、日時・価格・会場名・URLなどの不足している点があれば具体的に指摘してください。不足がなければ「なし」とだけ出力してください。]`;

  const apiKey = getProperty('GEMINI_API_KEY');
  const payload = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.7, maxOutputTokens: 8000 }
  };

  // ★ 全体の開始時刻を記録（総所要時間の計測用）
  const totalStart = Date.now();

  for (const model of MODELS) {
    const url = 'https://generativelanguage.googleapis.com/v1beta/models/'
              + model + ':generateContent?key=' + apiKey;

    // ★ 試行開始するモデル名をログ出力
    console.log(`[callGemini] ▶ モデル "${model}" を試行中...`);

    for (let attempt = 1; attempt <= 3; attempt++) {
      const res  = UrlFetchApp.fetch(url, {
        method: 'POST',
        contentType: 'application/json',
        payload: JSON.stringify(payload),
        muteHttpExceptions: true
      });
      const json = JSON.parse(res.getContentText());

      if (!json.error) {
        // ★ 成功時にモデル名・試行回数・総所要時間をログ出力
        const elapsed = Date.now() - totalStart;
        console.log(
          `[callGemini] ✅ 成功: モデル="${model}", 試行=${attempt}回目, 総所要時間=${elapsed}ms`
        );
        if (model !== 'gemini-3.5-flash') {
          console.log(`[callGemini] ⚠ フォールバックモデルを使用: ${model}`);
        }
        return json.candidates[0].content.parts[0].text;
      }

      const isOverloaded = json.error.code === 503
        || (json.error.message || '').includes('high demand')
        || (json.error.message || '').includes('overloaded');

      if (isOverloaded) {
        if (attempt < 3) {
          const waitMs = Math.pow(2, attempt) * 1000;
          // ★ リトライ理由・待機時間をログ出力
          console.log(
            `[callGemini] ⚠ ${model} 過負荷: 試行${attempt}/3回目失敗 → ${waitMs / 1000}秒後にリトライ`
          );
          Utilities.sleep(waitMs);
        } else {
          // ★ 次モデルへのフォールバックをログ出力
          console.log(`[callGemini] ✖ ${model} 過負荷: 3回リトライ全滅 → 次のモデルへフォールバック`);
          break;
        }
      } else {
        // ★ 非過負荷エラーの詳細（コード・メッセージ）をログ出力
        console.error(
          `[callGemini] ✖ APIエラー: モデル="${model}", 試行=${attempt}回目, ` +
          `code=${json.error.code}, message=${json.error.message}`
        );
        throw new Error('Gemini API エラー (' + model + '): ' + json.error.message);
      }
    }
  }

  // ★ 全モデル失敗時の総所要時間をログ出力
  console.error(`[callGemini] ✖ 全モデル失敗: 総所要時間=${Date.now() - totalStart}ms`);
  throw new Error('GEMINI_OVERLOADED');
}

// ─────────────────────────────────────────
//  Slack: スレッドに新規返信を投稿
// ─────────────────────────────────────────
function postToSlack(channelId, threadTs, text) {
  const token   = getProperty('SLACK_BOT_TOKEN');
  const payload = { channel: channelId, text: text, mrkdwn: true };
  if (threadTs) payload.thread_ts = threadTs;

  const res  = UrlFetchApp.fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });
  const json = JSON.parse(res.getContentText());
  if (!json.ok) throw new Error('chat.postMessage エラー: ' + json.error);
  return json.ts;
}

// ─────────────────────────────────────────
//  鼓童グループ共通ルール：スレッド連投用関数
// ─────────────────────────────────────────
function postWithThreadRule(channelId, titleText, detailText) {
  const parentTs = postToSlack(channelId, null, titleText);
  postToSlack(channelId, parentTs, detailText);
  return parentTs;
}

// ─────────────────────────────────────────
//  Slack: 既存の Bot 返信を上書き更新
// ─────────────────────────────────────────
function updateSlackMessage(channelId, messageTs, text) {
  const token = getProperty('SLACK_BOT_TOKEN');

  const res  = UrlFetchApp.fetch('https://slack.com/api/chat.update', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
    payload: JSON.stringify({ channel: channelId, ts: messageTs, text: text, mrkdwn: true }),
    muteHttpExceptions: true
  });
  const json = JSON.parse(res.getContentText());
  if (!json.ok) throw new Error('chat.update エラー: ' + json.error);
  return json.ts;
}

// ─────────────────────────────────────────
//  Bot 自身のユーザーID を取得
// ─────────────────────────────────────────
function getBotUserId() {
  const cache  = CacheService.getScriptCache();
  const cached = cache.get('BOT_USER_ID');
  if (cached) return cached;

  const token = getProperty('SLACK_BOT_TOKEN');
  const res   = UrlFetchApp.fetch('https://slack.com/api/auth.test', {
    headers: { 'Authorization': 'Bearer ' + token }
  });
  const json  = JSON.parse(res.getContentText());
  if (!json.ok) return null;

  cache.put('BOT_USER_ID', json.user_id, 21600);
  return json.user_id;
}

// ─────────────────────────────────────────
//  スクリプトプロパティを安全に取得
// ─────────────────────────────────────────
function getProperty(key) {
  const val = PropertiesService.getScriptProperties().getProperty(key);
  if (!val) throw new Error('スクリプトプロパティ「' + key + '」が未設定です');
  return val;
}

// ─────────────────────────────────────────
//  キュー用スプレッドシートを取得または作成
// ─────────────────────────────────────────
function getOrCreateSheet() {
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const name  = 'queue';
  let   sheet = ss.getSheetByName(name);

  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.appendRow([
      '受信時刻', 'チャンネルID', '親メッセージts', 'メンションts',
      'ステータス', 'Bot返信ts', '処理完了時刻', 'リトライ回数', '告知締め切り'
    ]);
    sheet.setFrozenRows(1);
    sheet.getRange('A1:I1').setBackground('#1a1a2e').setFontColor('white').setFontWeight('bold');
    [140, 120, 140, 140, 110, 140, 140, 80, 110]
      .forEach((w, i) => sheet.setColumnWidth(i + 1, w));
    return sheet;
  }

  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  if (headers.length < 9) {
    const startCol   = headers.length + 1;
    const newHeaders = ['告知締め切り'];
    newHeaders.slice(0, 9 - headers.length).forEach((h, idx) => {
      sheet.getRange(1, startCol + idx).setValue(h)
        .setBackground('#1a1a2e').setFontColor('white').setFontWeight('bold');
      sheet.setColumnWidth(startCol + idx, 110);
    });
  }

  return sheet;
}

// ─────────────────────────────────────────
//  初期セットアップ（最初に 1 回だけ手動実行）
// ─────────────────────────────────────────
function setup() {
  ScriptApp.getProjectTriggers().forEach(t => ScriptApp.deleteTrigger(t));

  ScriptApp.newTrigger('processQueue')
    .timeBased()
    .everyMinutes(1)
    .create();

  getOrCreateSheet();

  SpreadsheetApp.getUi().alert(
    '✅ セットアップ完了！（v5.1 - 実行ログ強化版）\n\n' +
    '設定されたトリガー：\n' +
    '  • processQueue：1分ごと\n\n' +
    'スクリプトプロパティに「SLACK_SIGNING_SECRET」を必ず追加してください。'
  );
}
