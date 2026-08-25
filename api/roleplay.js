// =====================================================
// ロープレスケジュール取得API
//
// Googleスプレッドシート「掲示用ロープレスケジュール」を読み取り、
// サイネージが表示しやすい形に整えて返します。
// 入力は今まで通りスプレッドシート上で行い、アプリは表示するだけです。
//
// 【スプレッドシート側の準備】
// 次のどちらかを行ってください。
//  (A) スプレッドシートの「共有」→「リンクを知っている全員」→「閲覧者」にする
//      → 設定はこれだけで、環境変数は不要です
//  (B) ファイル →「共有」→「ウェブに公開」で対象シートをCSVとして公開し、
//      表示されたURLを環境変数 ROLEPLAY_CSV_URL に設定する
//      → シート1枚だけを公開できるので、こちらの方が安全です
//
// 使用する環境変数（すべて任意）
//   ROLEPLAY_CSV_URL … (B)の場合に設定するCSVのURL
//   ROLEPLAY_SHEET_ID … スプレッドシートのID（既定値は現行のシート）
//   ROLEPLAY_SHEET_GID … シートのgid（既定値は現行のシート）
// =====================================================

const DEFAULT_SHEET_ID  = '1_32zvFvVAUFDgjHC-qJAAyU0yAsNkabsloT7IGdUrPI';
const DEFAULT_SHEET_GID = '1552706157';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  // 手作業で更新されるものなので、5分キャッシュして読み込み回数を抑えます
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');

  const sheetId = process.env.ROLEPLAY_SHEET_ID  || DEFAULT_SHEET_ID;
  const gid     = process.env.ROLEPLAY_SHEET_GID || DEFAULT_SHEET_GID;

  // 取得先を順に試します。
  //  1. 環境変数で指定されたURL（ウェブに公開した場合）
  //  2. エクスポート形式。シートをそのままCSVで返すので最も確実です
  //  3. gviz形式。2が使えない環境向けの予備
  const candidates = [
    process.env.ROLEPLAY_CSV_URL,
    `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv&gid=${gid}`,
    `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:csv&gid=${gid}`,
  ].filter(Boolean);

  const problems = [];
  for (const url of candidates) {
    try {
      const r = await fetch(url, { redirect: 'follow' });
      const text = await r.text();

      if (!r.ok) { problems.push(`${shortUrl(url)}: HTTP ${r.status}`); continue; }
      // 権限が無いとCSVではなくログイン画面のHTMLが返ってきます
      if (/^\s*</.test(text)) { problems.push(`${shortUrl(url)}: 閲覧権限がありません`); continue; }

      const data = parseSchedule(parseCsv(text));
      if (!data.days.length) { problems.push(`${shortUrl(url)}: 見出し（日付）が見つかりません`); continue; }

      return res.status(200).json({ success: true, ...data, fetchedAt: new Date().toISOString() });
    } catch (e) {
      problems.push(`${shortUrl(url)}: ${e.message}`);
    }
  }

  console.error('[roleplay] 取得失敗:', problems.join(' / '));
  return res.status(502).json({
    error: 'スプレッドシートを読み込めませんでした',
    hint : 'スプレッドシートの共有設定を「リンクを知っている全員（閲覧者）」にするか、ウェブに公開したCSVのURLを環境変数 ROLEPLAY_CSV_URL に設定してください。',
    detail: problems,
  });
}

// ログに出すときにURLを短くする
function shortUrl(u) {
  return String(u).includes('/export') ? 'export' : String(u).includes('/gviz') ? 'gviz' : 'CSV_URL';
}

/**
 * CSVを二次元配列にする
 * 引用符の中の改行やカンマにも対応しています（時間欄に改行が入っているため）
 */
function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; }
        else quoted = false;
      } else cell += ch;
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      row.push(cell); cell = '';
    } else if (ch === '\n') {
      row.push(cell); rows.push(row); row = []; cell = '';
    } else if (ch !== '\r') {
      cell += ch;
    }
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

/**
 * スプレッドシートの並びを読み取る
 *
 * 実際の並びは次のようになっています。
 *   1行目: 日付の見出し（2列分が結合されているので、左端の列にだけ文字が入る）
 *   2行目: 講師名（太田 / 佐藤）
 *   3行目以降: 左から2列目が時間、そのあと日付ごとに講師2名分の予約者名
 *
 * 列の位置や日数が変わっても読めるよう、「日付」を含むセルを探して
 * そこを起点に組み立てています。
 */
function parseSchedule(rows) {
  const clean = v => String(v ?? '').replace(/\s+/g, ' ').trim();

  // 「日付」を含む行を探す
  const dateRowIdx = rows.findIndex(r => r.some(c => String(c).includes('日付')));
  if (dateRowIdx < 0) return { days: [], times: [], note: 'シートの見出し（日付）が見つかりませんでした' };

  const dateRow    = rows[dateRowIdx];
  const trainerRow = rows[dateRowIdx + 1] || [];

  // 日付の見出しがある列の位置
  const dateCols = [];
  dateRow.forEach((c, i) => { if (String(c).includes('日付')) dateCols.push(i); });
  if (!dateCols.length) return { days: [], times: [] };

  // 時間の列は、最初の日付列のひとつ左
  const timeCol = Math.max(0, dateCols[0] - 1);

  // 日付ごとに、その日が使う列（講師の人数分）をまとめる
  const days = dateCols.map((start, n) => {
    const end = (n + 1 < dateCols.length) ? dateCols[n + 1] : dateRow.length;
    const cols = [];
    for (let c = start; c < end; c++) {
      const name = clean(trainerRow[c]);
      if (name) cols.push({ col: c, trainer: name });
    }
    const raw = clean(dateRow[start]).replace(/^日付[:：]\s*/, '');
    // 「8月28日(金)　太田EXPOで不在」のように補足が付くことがあるので分ける
    const m = raw.match(/^(\d+月\d+日(?:\([^)]*\))?)\s*(.*)$/);
    return {
      label: m ? m[1] : raw,
      note : m ? clean(m[2]) : '',
      date : toIsoDate(m ? m[1] : raw),
      trainers: cols.map(c => c.trainer),
      cols,
    };
  }).filter(d => d.cols.length);

  // 時間の行を読み取る
  const times = [];
  for (let r = dateRowIdx + 2; r < rows.length; r++) {
    const label = clean(rows[r][timeCol]);
    if (!label) continue;
    const isBreak = /休憩/.test(label);
    times.push({
      label: label.replace(/[~〜]/g, '～'),
      isBreak,
      // 日付ごと・講師ごとの予約者名。'ー' や空欄は空文字にそろえる
      slots: days.map(d => d.cols.map(c => {
        const v = clean(rows[r][c.col]);
        return (v === 'ー' || v === 'ｰ' || v === '－' || v === '-') ? '' : v;
      })),
    });
  }

  return { days: days.map(({ cols, ...d }) => d), times };
}

/**
 * 「8月24日(月)」を「2026-08-24」に直す
 * 年はシートに書かれていないため、今日に最も近い年として推定します。
 */
function toIsoDate(label) {
  const m = String(label).match(/(\d+)月(\d+)日/);
  if (!m) return '';
  const month = Number(m[1]), day = Number(m[2]);
  const now = new Date();
  let year = now.getFullYear();
  // 12月のシートを1月に見るような場合に、年がずれないようにする
  if (now.getMonth() + 1 === 12 && month === 1) year += 1;
  if (now.getMonth() + 1 === 1 && month === 12) year -= 1;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}
