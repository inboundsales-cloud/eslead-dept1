// =====================================================
// notion-create.js と check-roleplay-conflicts.js（ロープレ予定の重複を毎朝チェックする
// 定期実行API）の両方から使う共通部品をまとめたファイルです。
// ロープレの重複チェック・LINE WORKS通知のロジックを1か所にまとめることで、
// 2つのAPIで判定がずれてしまわないようにしています。
// =====================================================

export const cut = (v, n) => String(v ?? '').slice(0, n);

/** CSVを二次元配列にする（roleplay.js・panhu.jsと同じ簡易パーサーです） */
export function parseCsvSimple(text) {
  const rows = [];
  let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) { if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false; } else cell += ch; }
    else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (ch !== '\r') cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

const ROLEPLAY_SHEET_ID_DEFAULT  = '1_32zvFvVAUFDgjHC-qJAAyU0yAsNkabsloT7IGdUrPI';
const ROLEPLAY_SHEET_GID_DEFAULT = '1552706157';

/**
 * 指定した日付(YYYY-MM-DD)にロープレを予約している人（時間帯の枠に名前が入っている人）の
 * 一覧を返す（読めなければ空配列）。
 *
 * シートの実際の構造は、日付ごとに「太田」「佐藤」という2列（固定の講師名。この2人は
 * 常にどの日にも同じ列見出しとして出てくるだけで、日付によって変わりません）があり、
 * その下に30分刻みの時間帯の行が続き、各セルに実際にその枠へ予約した人（スタッフ）の
 * 名前が入る、という表になっています。
 * 「日付の見出しのすぐ下の行＝その日の講師」として固定の列見出し（太田・佐藤）を
 * そのまま返すのではなく、時間帯の各行に予約されている実際の人名を集めて、
 * その日その人がロープレを予約しているかどうかで判定します。
 */
export async function roleplayTrainersOn(dateIso) {
  const sheetId = process.env.ROLEPLAY_SHEET_ID || ROLEPLAY_SHEET_ID_DEFAULT;
  const gid     = process.env.ROLEPLAY_SHEET_GID || ROLEPLAY_SHEET_GID_DEFAULT;
  const candidates = [
    process.env.ROLEPLAY_CSV_URL,
    `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv&gid=${gid}`,
    `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:csv&gid=${gid}`,
  ].filter(Boolean);
  const clean = v => String(v ?? '').replace(/\s+/g, ' ').trim();
  // 列見出し（固定の講師名）や、時間帯・休憩などのラベルは「予約者名」から除外します
  const NOT_A_NAME = new Set(['太田', '佐藤', 'ー', '－', '-', '−', '']);
  const looksLikeLabel = v => !v
    || NOT_A_NAME.has(v)
    || /^\d+時\d*分?[～\-~]/.test(v)   // 「11時00分～11時30分」等の時間帯ラベル
    || v.includes('休憩')
    || v.includes('日付');
  for (const url of candidates) {
    try {
      const r = await fetch(url, { redirect: 'follow', cache: 'no-store' });
      const text = await r.text();
      if (!r.ok || /^\s*</.test(text)) continue;
      const rows = parseCsvSimple(text);
      const dateRowIdx = rows.findIndex(row => row.some(c => clean(c).includes('日付')));
      if (dateRowIdx < 0) continue;
      const dateRow = rows[dateRowIdx];
      const dateCols = [];
      dateRow.forEach((c, i) => { if (clean(c).includes('日付')) dateCols.push(i); });
      for (let n = 0; n < dateCols.length; n++) {
        const start = dateCols[n];
        const end = (n + 1 < dateCols.length) ? dateCols[n + 1] : dateRow.length;
        const raw = clean(dateRow[start]).replace(/^日付[:：]\s*/, '');
        const m = raw.match(/^(\d+)月(\d+)日/);
        if (!m) continue;
        const now = new Date();
        let year = now.getFullYear();
        const month = Number(m[1]), day = Number(m[2]);
        if (now.getMonth() + 1 === 12 && month === 1) year += 1;
        if (now.getMonth() + 1 === 1 && month === 12) year -= 1;
        const iso = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        if (iso !== dateIso) continue;
        // 見出し行(dateRowIdx)・講師名の列見出し行(dateRowIdx+1)より下、
        // 次の日付ブロックが始まる行の手前までの、この日付の列範囲にある
        // 実際の予約者名だけを集めます。
        const names = new Set();
        for (let ri = dateRowIdx + 1; ri < rows.length; ri++) {
          const row = rows[ri];
          if (!row) continue;
          if (ri > dateRowIdx + 1 && row.some(c => clean(c).includes('日付'))) break; // 次の週などの日付ブロックに到達したら終了
          for (let c = start; c < end; c++) {
            const name = clean(row[c]);
            if (!looksLikeLabel(name)) names.add(name);
          }
        }
        return [...names];
      }
      return [];
    } catch (e) { /* 次の候補を試す */ }
  }
  return [];
}

/** LINE WORKSのトークルームにテキストメッセージを送る（Incoming Webhook方式。未設定なら何もしません） */
export async function notifyLineWorks(text) {
  try {
    const webhookUrl = process.env.LW_WEBHOOK_URL;
    if (!webhookUrl) return; // 通知の設定がまだの場合は何もしない
    const r = await fetch(webhookUrl, {
      method : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: { text } }),
    });
    if (!r.ok) console.error('[lineworks] send failed:', r.status, await r.text());
  } catch (e) {
    console.error('[lineworks] notify error:', e.message);
  }
}

/** 書類回収とロープレ予定が重なっているときの通知文面（1件ずつの通知でも、まとめチェックでも同じ文面にします） */
export function buildConflictMessage({ dept, who, plan, bukken, customer }) {
  const label = cut(bukken, 60).trim() || cut(customer, 60).trim();
  const md = plan.slice(5).replace('-', '/');
  return `⚠ 書類回収とロープレ予定が重なっています\n`
    + `${md} ${who}さん${dept ? '（' + dept + '）' : ''}\n`
    + (label ? `対象: ${label}\n` : '')
    + `${who}さんはこの日ロープレの予約が入っていますが、書類回収も入っています。ドタキャンにならないようご確認ください。`;
}

/**
 * 書類回収の回収担当者が、その日のロープレ予約と重なっていないか確認し、
 * 重なっていればLINE WORKSに通知します。何が起きても書類回収の登録自体には影響しません。
 * （書類回収の新規登録の瞬間だけに行われる、1回きりのチェックです）
 */
export async function checkRoleplayConflict({ dept, who, plan, bukken, customer }) {
  if (!plan || !who) return;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(plan)) return;
  try {
    const trainers = await roleplayTrainersOn(plan);
    if (trainers.includes(who)) {
      await notifyLineWorks(buildConflictMessage({ dept, who, plan, bukken, customer }));
    }
  } catch (e) {
    console.error('[notion-create] ロープレ重複チェックに失敗:', e.message);
  }
}

// ---- Notionのプロパティ値を読み取るための共通ヘルパー（サイネージ側 index.html の gp/gpm と同じ仕様） ----
export function gp(page, name) {
  const p = page.properties?.[name]; if (!p) return '';
  if (p.type === 'title') return p.title.map(t => t.plain_text).join('');
  if (p.type === 'rich_text') return p.rich_text.map(t => t.plain_text).join('');
  if (p.type === 'select') return p.select?.name || '';
  if (p.type === 'date') return p.date?.start || '';
  if (p.type === 'number') return p.number ?? '';
  if (p.type === 'multi_select') return (p.multi_select || []).map(o => o.name).join('・');
  if (p.type === 'created_time') return p.created_time || '';
  return '';
}
export function gpm(page, name) {
  const p = page.properties?.[name];
  return p && p.type === 'multi_select' ? (p.multi_select || []).map(o => o.name) : [];
}

/** Notionのデータベースを全件取得します（ページングに対応。1回のチェックで数百件程度を想定） */
export async function queryAllNotion(apiKey, dbId, filter) {
  const results = [];
  let cursor;
  for (let guard = 0; guard < 20; guard++) { // 念のため上限（20ページ ≒ 2000件）を設けています
    const body = { page_size: 100 };
    if (filter) body.filter = filter;
    if (cursor) body.start_cursor = cursor;
    const r = await fetch(`https://api.notion.com/v1/databases/${dbId}/query`, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + apiKey,
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data?.message || ('Notion API error ' + r.status));
    results.push(...(data.results || []));
    if (!data.has_more) break;
    cursor = data.next_cursor;
  }
  return results;
}

/** 今日の日付を YYYY-MM-DD で返す（タイムゾーンを指定できます。既定は日本時間） */
export function isoToday(timeZone = 'Asia/Tokyo') {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const get = t => parts.find(p => p.type === t).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** isoDateから日数を加算したYYYY-MM-DDを返します（日本時間の暦日で計算） */
export function addDaysIso(isoDate, days) {
  const d = new Date(isoDate + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
