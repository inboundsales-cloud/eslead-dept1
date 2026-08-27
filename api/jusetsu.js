// =====================================================
// 重要事項説明スケジュール取得API
//
// 営業事務課が管理するGoogleスプレッドシートを読み取り、
// サイネージが表示しやすい形に整えて返します。
// 入力はスプレッドシート側で行い、アプリは表示するだけです。
//
// 【スプレッドシートの様式】
// 1行目に見出しを置いた、ふつうの一覧表です。列の並び順は自由で、
// 見出しの文字で列を探すので、列を増やしても問題ありません。
//
// ■ 予定のシート（タブ1枚目）
//   日付       | 時間  | 重説担当 | 営業担当 | 備考
//   2026/8/26 | 20:00 | 坂上     | 宮下     |
//   2026/8/26 | 17:00 | 寺田     | 上田     |
//   2026/8/27 | 15:30 | 田伏     | 北森     |
//
// ■ 当番のシート（別タブ。1日1行）
//   日付       | 22時以降当番
//   2026/8/26 | 寺田
//   2026/8/27 | 深田
//
//  ・日付は「2026/8/26」「8/26」「8月26日」いずれでも読めます
//  ・当番を予定のシート内の「当番」列に書く形でも読めます（従来どおり）
//  ・先の予定を何ヶ月分入れておいても構いません（画面には当日分だけ出ます）
//
// 【スプレッドシート側の準備】
//  共有 →「リンクを知っている全員」→「閲覧者」にしてください。
//  環境変数
//    JUSETSU_SHEET_ID  … スプレッドシートのID（必須）
//    JUSETSU_SHEET_GID … 予定シートのgid（省略時は先頭のタブ）
//    JUSETSU_DUTY_GID  … 当番シートのgid（別タブにする場合に設定）
// =====================================================

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=300');

  const sheetId = process.env.JUSETSU_SHEET_ID;
  const gid     = process.env.JUSETSU_SHEET_GID || '0';

  if (!sheetId && !process.env.JUSETSU_CSV_URL) {
    return res.status(500).json({
      error: 'スプレッドシートが設定されていません',
      hint : 'Vercelの環境変数 JUSETSU_SHEET_ID にスプレッドシートのIDを設定してください。',
    });
  }

  const candidates = [
    process.env.JUSETSU_CSV_URL,
    sheetId && `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv&gid=${gid}`,
    sheetId && `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:csv&gid=${gid}`,
  ].filter(Boolean);

  const problems = [];
  for (const url of candidates) {
    try {
      const r = await fetch(url, { redirect: 'follow' });
      const text = await r.text();
      if (!r.ok) { problems.push(`HTTP ${r.status}`); continue; }
      if (/^\s*</.test(text)) { problems.push('閲覧権限がありません'); continue; }

      const data = parseJusetsu(parseCsv(text));
      if (!data.rows.length && !data.duties.length) { problems.push('見出し（日付・重説担当）が見つかりません'); continue; }

      // 当番を別タブで管理している場合は、そちらも読んで差し替えます
      const dutyGid = process.env.JUSETSU_DUTY_GID;
      if (dutyGid && sheetId) {
        const duties = await fetchDuties(sheetId, dutyGid);
        if (duties) {
          data.duties = duties;
          duties.forEach(d => { if (d.name && !data.staff.includes(d.name)) data.staff.push(d.name); });
        } else {
          console.error('[jusetsu] 当番シートを読み込めませんでした');
        }
      }

      return res.status(200).json({ success: true, ...data, fetchedAt: new Date().toISOString() });
    } catch (e) {
      problems.push(e.message);
    }
  }

  console.error('[jusetsu] 取得失敗:', problems.join(' / '));
  return res.status(502).json({
    error : 'スプレッドシートを読み込めませんでした',
    hint  : 'スプレッドシートの共有設定を「リンクを知っている全員（閲覧者）」にしてください。',
    detail: problems,
  });
}

/**
 * 当番のシートを読む（日付と当番名だけの簡単な表）
 * 読めなかった場合は null を返し、予定シート側の当番列を使います。
 */
async function fetchDuties(sheetId, gid) {
  const urls = [
    `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv&gid=${gid}`,
    `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:csv&gid=${gid}`,
  ];
  for (const url of urls) {
    try {
      const r = await fetch(url, { redirect: 'follow' });
      const text = await r.text();
      if (!r.ok || /^\s*</.test(text)) continue;

      const rows = parseCsv(text);
      const clean = v => String(v ?? '').replace(/\s+/g, ' ').trim();
      // 見出し行（「日付」を含む行）を探す。無ければ1行目から素直に読む
      let head = rows.findIndex(x => x.some(c => clean(c).includes('日付')));
      let dateCol = 0, nameCol = 1;
      if (head >= 0) {
        const h = rows[head].map(clean);
        dateCol = h.findIndex(c => c.includes('日付'));
        // 「当番」を含む列。無ければ日付の隣を使う
        const n = h.findIndex(c => c && c.includes('当番'));
        nameCol = n >= 0 ? n : dateCol + 1;
      } else { head = -1; }

      const out = [], seen = {};
      for (let i = head + 1; i < rows.length; i++) {
        const date = toIsoDate(clean(rows[i][dateCol]));
        const name = clean(rows[i][nameCol]);
        if (!date || !name || seen[date]) continue;
        seen[date] = true;
        out.push({ date, name });
      }
      if (out.length) return out;
    } catch (e) { /* 次のURLを試す */ }
  }
  return null;
}

/** CSVを二次元配列にする（引用符の中の改行やカンマにも対応） */
function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false; }
      else cell += ch;
    } else if (ch === '"') { quoted = true; }
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (ch !== '\r') { cell += ch; }
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

/**
 * 一覧表を読み取る
 * 見出しの文字で列を探すので、列の順番が変わっても読めます。
 */
function parseJusetsu(rows) {
  const clean = v => String(v ?? '').replace(/\s+/g, ' ').trim();

  // 見出しの行を探す（「日付」と「重説担当」の両方を含む行）
  const headIdx = rows.findIndex(r => {
    const t = r.map(clean).join('|');
    return t.includes('日付') && (t.includes('重説担当') || t.includes('担当'));
  });
  if (headIdx < 0) return { rows: [], duties: [], staff: [] };

  const head = rows[headIdx].map(clean);
  // 見出しに含まれる文字で列の位置を決める（完全一致でなくてよい）
  const find = (...keys) => head.findIndex(h => h && keys.some(k => h.includes(k)));
  const col = {
    date : find('日付'),
    time : find('時間', '時刻'),
    staff: find('重説担当'),
    sales: find('営業担当'),
    note : find('備考'),
    duty : find('当番'),
  };
  if (col.staff < 0) col.staff = find('担当');

  const out = [], duties = {};
  for (let r = headIdx + 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row) continue;
    const date = toIsoDate(clean(row[col.date]));
    if (!date) continue;

    // 22時以降の当番。その日のどこか1行に書いてあれば拾います
    if (col.duty >= 0) {
      const d = clean(row[col.duty]);
      if (d && !duties[date]) duties[date] = d;
    }

    const staff = col.staff >= 0 ? clean(row[col.staff]) : '';
    const sales = col.sales >= 0 ? clean(row[col.sales]) : '';
    if (!staff && !sales) continue;   // 当番だけの行はここで終わり

    out.push({
      date,
      time : normalizeTime(col.time >= 0 ? clean(row[col.time]) : ''),
      staff,
      sales,
      note : col.note  >= 0 ? clean(row[col.note]) : '',
    });
  }

  // 重説担当として登場する人の一覧（画面の列の並びに使います）
  const staff = [];
  out.forEach(x => { if (x.staff && !staff.includes(x.staff)) staff.push(x.staff); });
  Object.values(duties).forEach(d => { if (d && !staff.includes(d)) staff.push(d); });

  return { rows: out, duties: Object.entries(duties).map(([date, name]) => ({ date, name })), staff };
}

/**
 * 時間を「HH:MM」にそろえる
 * スプレッドシートの時刻書式では「21:00:00」と秒まで入ることがあるため、
 * 秒を落として表示用に整えます。全角コロンや「21時00分」にも対応します。
 */
function normalizeTime(v) {
  const s = String(v).replace(/[：]/g, ':').trim();
  if (!s) return '';
  let m = s.match(/(\d{1,2}):(\d{2})/);
  if (!m) m = s.match(/(\d{1,2})\s*時\s*(\d{1,2})?\s*分?/);
  if (!m) return s;
  const h = String(Number(m[1])).padStart(2, '0');
  const mi = String(Number(m[2] || 0)).padStart(2, '0');
  return `${h}:${mi}`;
}

/**
 * 日付をYYYY-MM-DDにそろえる
 * 「2026/8/26」「8/26」「8月26日」「2026-08-26」に対応します。
 * 年が書かれていない場合は今年として扱います。
 */
function toIsoDate(v) {
  const s = String(v).trim();
  if (!s) return '';
  let y, m, d;
  let x = s.match(/^(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})/);
  if (x) { y = +x[1]; m = +x[2]; d = +x[3]; }
  else {
    x = s.match(/^(\d{1,2})[-/月](\d{1,2})/);
    if (!x) return '';
    m = +x[1]; d = +x[2];
    const now = new Date();
    y = now.getFullYear();
    // 年末年始に年がずれないようにする
    if (now.getMonth() + 1 === 12 && m === 1) y += 1;
    if (now.getMonth() + 1 === 1 && m === 12) y -= 1;
  }
  if (!(m >= 1 && m <= 12 && d >= 1 && d <= 31)) return '';
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}
