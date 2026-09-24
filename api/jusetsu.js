// =====================================================
// 重要事項説明スケジュール取得API（Salesforce版）
//
// Salesforceの「重説予約管理シート」ダッシュボードの元になっている
// レポートを読み取り、サイネージが表示しやすい形に整えて返します。
// 入力はSalesforce側で行い、アプリは表示するだけです。
//
// 【読み取り先の切り替え】
//   環境変数 SF_REPORT_JUSETSU（レポートID 00O… か、ダッシュボードID 01Z… ）が設定されていれば Salesforce から、
//   未設定なら従来どおり Googleスプレッドシート から読みます。
//   → Salesforce版がうまく動くのを確認してから、スプレッドシート側の設定を消してください。
//
// 【Salesforceのレポートの条件】
//   ・形式は「表形式」または「サマリー形式（詳細行を表示）」
//   ・次の項目が列に入っていること（列名に下の言葉が含まれていれば、並び順は自由です）
//       日付 … 「重説日」「日付」「予約日」「実施日」「日時」など
//       時間 … 「時間」「時刻」「開始」など（日付と時刻が1つの項目＝日時型でもOK）
//       重説担当 … 「重説担当」「説明担当」「説明者」など
//       営業担当 … 「営業担当」「担当営業」「営業」など
//       備考 … 「備考」「メモ」など（無くても動きます）
//       当番 … 「当番」（無くても動きます）
//   ・今日だけでなく、先の日付の予約も含めておくこと（画面の日付切り替えと月間件数で使います）
//   ・連携用ユーザー（成績画面と同じもの）がこのレポートのフォルダを閲覧できること
//   列名の言葉が違う場合は、下の COLUMN_KEYWORDS に1語足すだけで対応できます。
//
// 【動作確認】
//   /api/jusetsu?debug=1 を開くと、どの列を何として読んだかが確認できます。
//
// 使用する環境変数（Salesforce版）
//   SF_CLIENT_ID / SF_CLIENT_SECRET / SF_LOGIN_URL / QUOTAGUARD_URL … 成績画面と共通（既存）
//   SF_REPORT_JUSETSU … 新規。重説予約管理シートのダッシュボードID（01ZRB0000065Dyr）またはその元レポートのID
//   （任意）JUSETSU_SHEET_ID + JUSETSU_DUTY_GID … 当番だけ引き続きスプレッドシートで管理する場合
// =====================================================
import { fetch as undiciFetch, ProxyAgent } from 'undici';

// ★ 列名の対応表（上から順に探し、最初に見つかった列を使います）
// 現在のダッシュボード「重要事項説明 予定表」の列：
//   重要事項説明者 / 予約カードNo: 重説依頼日 / 予約カードNo: 重説依頼時間 /
//   担当者名 / 営業補助者 / 予約カードNo: 契約場所
const COLUMN_KEYWORDS = {
  staff : ['重要事項説明者', '重説担当', '説明担当', '重説者', '説明者'],
  sales : ['担当者名', '営業担当', '担当営業', '所有者'],
  helper: ['営業補助者', '補助者'],
  date  : ['重説依頼日', '依頼日', '重説日', '予約日', '実施日', '日付', '日時'],
  time  : ['重説依頼時間', '依頼時間', '時間', '時刻'],
  place : ['契約場所', '場所'],
  note  : ['備考', 'メモ', 'コメント'],
  duty  : ['当番'],
};
// 契約場所がこの値のときは、画面の備考欄には出しません（ほとんどが「その他」のため）
const PLACE_HIDE = ['その他', ''];

// 画面に並べる重説担当（index.html の JUSETSU_STAFF と合わせる）。
// Salesforceではフルネームで入っているため、ここに載っている苗字に寄せて表示します。
const JUSETSU_STAFF = ['深田', '坂上', '寺田', '田伏', '田端', '林'];

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  // 「更新」ボタンからは fresh=1 が付き、キャッシュを完全に迂回します。
  const fresh = req.query?.fresh === '1' || req.query?.debug === '1';
  res.setHeader('Cache-Control', fresh
    ? 'no-store'
    : 'public, max-age=0, s-maxage=30, stale-while-revalidate=60');

  const reportId = process.env.SF_REPORT_JUSETSU;
  if (!reportId) return sheetHandler(req, res); // Salesforce未設定の間は従来のスプレッドシート版

  try {
    const report = await fetchSalesforceReport(reportId);
    const { data, debug } = parseReport(report);

    // 当番がSalesforce側に無く、スプレッドシートの当番タブが設定されていればそちらを使う
    if (!data.duties.length && process.env.JUSETSU_SHEET_ID && process.env.JUSETSU_DUTY_GID) {
      const duties = await fetchDuties(process.env.JUSETSU_SHEET_ID, process.env.JUSETSU_DUTY_GID);
      if (duties) {
        data.duties = duties;
        duties.forEach(d => { if (d.name && !data.staff.includes(d.name)) data.staff.push(d.name); });
      }
    }

    if (req.query?.debug === '1') {
      return res.status(200).json({ success: true, source: 'salesforce', debug, sample: data.rows.slice(0, 10), count: data.rows.length });
    }
    if (debug.missing.length) {
      return res.status(502).json({
        error: 'Salesforceのレポートに必要な列が見つかりません',
        hint : `見つからない列：${debug.missing.join('・')}。/api/jusetsu?debug=1 で列名を確認してください。`,
        detail: debug.columns,
      });
    }
    return res.status(200).json({ success: true, source: 'salesforce', ...data, fetchedAt: new Date().toISOString() });
  } catch (e) {
    console.error('[jusetsu] Salesforce取得失敗:', e.message);
    return res.status(502).json({
      error: 'Salesforceから重説の予定を読み込めませんでした',
      hint : e.hint || '連携用ユーザーがレポートを閲覧できるか、レポートIDが正しいかをご確認ください。',
      detail: e.message,
    });
  }
}

// =====================================================
// Salesforce からレポートを取得（成績画面の salesforce.js と同じ認証方式）
// =====================================================
async function fetchSalesforceReport(reportId) {
  const CLIENT_ID      = process.env.SF_CLIENT_ID;
  const CLIENT_SECRET  = process.env.SF_CLIENT_SECRET;
  const LOGIN_URL      = process.env.SF_LOGIN_URL || 'https://login.salesforce.com';
  const QUOTAGUARD_URL = process.env.QUOTAGUARD_URL;

  let dispatcher;
  try { dispatcher = QUOTAGUARD_URL ? new ProxyAgent(QUOTAGUARD_URL) : undefined; }
  catch (e) { dispatcher = undefined; }
  const sfFetch = (url, options = {}) =>
    dispatcher ? undiciFetch(url, { ...options, dispatcher }) : fetch(url, options);

  const tokenRes = await sfFetch(`${LOGIN_URL}/services/oauth2/token`, {
    method : 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body   : new URLSearchParams({ grant_type: 'client_credentials', client_id: CLIENT_ID, client_secret: CLIENT_SECRET }),
  });
  if (!tokenRes.ok) {
    const err = new Error('SF認証失敗: ' + (await tokenRes.text()).slice(0, 300));
    err.hint = 'Salesforceの認証に失敗しました（成績画面も表示できない場合は共通の設定を確認してください）。';
    throw err;
  }
  const { access_token, instance_url } = await tokenRes.json();

  const auth = { 'Authorization': `Bearer ${access_token}`, 'Content-Type': 'application/json' };

  // ダッシュボードのID（01Z…）が設定されている場合は、その表の元レポートのIDを調べます
  if (/^01Z/.test(reportId)) {
    const d = await sfFetch(`${instance_url}/services/data/v58.0/analytics/dashboards/${reportId}/describe`, { headers: auth });
    if (!d.ok) {
      const err = new Error(`ダッシュボード取得失敗 HTTP ${d.status}: ${(await d.text()).slice(0, 300)}`);
      err.hint = 'ダッシュボードが見つからないか、閲覧権限がありません。連携用ユーザーにダッシュボードのフォルダを共有してください。';
      throw err;
    }
    const comps = (await d.json()).components || [];
    const hit = comps.find(c => c.reportId && /重要事項説明|重説/.test(`${c.header || ''}${c.title || ''}`))
             || comps.find(c => c.reportId);
    if (!hit) throw new Error('ダッシュボードに元レポートが見つかりません');
    reportId = hit.reportId;
  }

  // includeDetails=true で1件ずつの明細行まで取得します（ダッシュボードは集計だけのため、元レポートを読む）
  const r = await sfFetch(`${instance_url}/services/data/v58.0/analytics/reports/${reportId}?includeDetails=true`, {
    headers: auth,
  });
  if (!r.ok) {
    const text = await r.text();
    const err = new Error(`レポート取得失敗 HTTP ${r.status}: ${text.slice(0, 300)}`);
    if (r.status === 403 || r.status === 404) {
      err.hint = 'レポートが見つからないか、閲覧権限がありません。連携用ユーザーにレポートのフォルダを共有してください。';
    }
    throw err;
  }
  const report = await r.json();
  report._reportId = reportId;
  return report;
}

// =====================================================
// レポートの明細行を { date, time, staff, sales, note } に整える
// =====================================================
function parseReport(report) {
  const cols = report.reportMetadata?.detailColumns || [];
  const info = report.reportExtendedMetadata?.detailColumnInfo || {};
  const labels = cols.map(c => info[c]?.label || c);

  const used = new Set();
  const col = {};
  // 取り違えを防ぐため、特徴的な列から順に決める（例：「重説担当」を先に取ってから「担当者」を探す）
  for (const k of ['staff', 'sales', 'helper', 'date', 'time', 'place', 'note', 'duty']) {
    let i = -1;
    for (const kw of COLUMN_KEYWORDS[k]) {
      i = labels.findIndex((l, idx) => !used.has(idx) && l.includes(kw));
      if (i >= 0) break;
    }
    col[k] = i;
    if (i >= 0) used.add(i);
  }
  const type = i => (i >= 0 ? info[cols[i]]?.dataType || '' : '');

  // 明細行を集める。表形式は "T!T"、サマリー形式は各グループ（"0!T" など）に入っています
  const factMap = report.factMap || {};
  let detailRows = factMap['T!T']?.rows || [];
  if (!detailRows.length) {
    detailRows = Object.entries(factMap)
      .filter(([k]) => k !== 'T!T')
      .flatMap(([, v]) => v.rows || []);
  }

  const cell = (row, i) => (i >= 0 ? row.dataCells?.[i] : null);
  const out = [], duties = {};
  for (const row of detailRows) {
    const dc = cell(row, col.date);
    const { date, time: timeFromDate } = toDateTime(dc, type(col.date));
    if (!date) continue;

    const tc = cell(row, col.time);
    const time = normalizeTime(tc ? String(tc.label ?? tc.value ?? '') : '') || timeFromDate;
    const staff = shortName(textOf(cell(row, col.staff)), JUSETSU_STAFF);
    const sales = shortName(textOf(cell(row, col.sales)));
    // 画面の「備考」欄：契約場所（その他以外）・営業補助者・備考 をまとめて表示
    const place  = textOf(cell(row, col.place));
    const helper = shortName(textOf(cell(row, col.helper)));
    const note = [
      PLACE_HIDE.includes(place) ? '' : place,
      helper ? `補助:${helper}` : '',
      textOf(cell(row, col.note)),
    ].filter(Boolean).join(' / ');
    const duty  = shortName(textOf(cell(row, col.duty)), JUSETSU_STAFF);
    if (duty && !duties[date]) duties[date] = duty;
    if (!staff && !sales) continue;
    out.push({ date, time, staff, sales, note });
  }

  const staff = [];
  out.forEach(x => { if (x.staff && !staff.includes(x.staff)) staff.push(x.staff); });
  Object.values(duties).forEach(d => { if (d && !staff.includes(d)) staff.push(d); });

  const need = { date: '日付', staff: '重説担当' };
  const missing = Object.entries(need).filter(([k]) => col[k] < 0).map(([, v]) => v);
  const show = i => (i >= 0 ? `${labels[i]}（${type(i) || '型不明'}）` : '★見つかりません');
  const debug = {
    reportId   : report._reportId || '',
    reportName : report.reportMetadata?.name || '',
    reportFormat: report.reportMetadata?.reportFormat || '',
    columns    : labels,
    mapping    : Object.fromEntries(Object.keys(COLUMN_KEYWORDS).map(k => [k, show(col[k])])),
    detailRows : detailRows.length,
    allData    : report.allData !== false, // false のときは2000行を超えて切れています
    missing,
  };
  console.log('[jusetsu] 列の対応:', JSON.stringify(debug.mapping));

  return {
    data: { rows: out, duties: Object.entries(duties).map(([date, name]) => ({ date, name })), staff },
    debug,
  };
}

const textOf = c => (c ? String(c.label ?? c.value ?? '').replace(/\s+/g, ' ').trim() : '')
  .replace(/^-$/, '');

/**
 * 日付セルから「YYYY-MM-DD」と（日時型なら）「HH:MM」を取り出す
 * 日時型はUTCで返ってくるので、日本時間に直します。
 */
function toDateTime(c, dataType) {
  if (!c) return { date: '', time: '' };
  const v = c.value;
  if (dataType === 'datetime' && v) {
    const d = new Date(v);
    if (!isNaN(d)) {
      const j = new Date(d.getTime() + 9 * 3600 * 1000);
      const iso = j.toISOString();
      return { date: iso.slice(0, 10), time: iso.slice(11, 16) };
    }
  }
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)) return { date: v.slice(0, 10), time: '' };
  return { date: toIsoDate(String(c.label ?? '')), time: normalizeTime(String(c.label ?? '').replace(/^\S+\s*/, '')) };
}

/**
 * 「深田　花子」「深田 花子 （営業事務課）」のようなフルネームを、画面用の苗字にそろえる
 * known（重説担当6名など）に前方一致すればその名前、無ければ最初の空白までを使います。
 */
function shortName(v, known = []) {
  const s = String(v || '').replace(/[（(][^）)]*[）)]/g, '').replace(/[\s　]+/g, ' ').trim();
  if (!s) return '';
  const hit = known.find(k => s.startsWith(k));
  if (hit) return hit;
  return s.split(' ')[0];
}

// =====================================================
// ここから下は従来のスプレッドシート版（SF_REPORT_JUSETSU 未設定時・当番タブ用）
// =====================================================
async function sheetHandler(req, res) {
  const sheetId = process.env.JUSETSU_SHEET_ID;
  const gid     = process.env.JUSETSU_SHEET_GID || '0';

  if (!sheetId && !process.env.JUSETSU_CSV_URL) {
    return res.status(500).json({
      error: '重説の読み取り先が設定されていません',
      hint : 'Vercelの環境変数 SF_REPORT_JUSETSU にSalesforceのレポートIDを設定してください。',
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
      const r = await fetch(url, { redirect: 'follow', cache: 'no-store' });
      const text = await r.text();
      if (!r.ok) { problems.push(`HTTP ${r.status}`); continue; }
      if (/^\s*</.test(text)) { problems.push('閲覧権限がありません'); continue; }

      const data = parseJusetsu(parseCsv(text));
      if (!data.rows.length && !data.duties.length) { problems.push('見出し（日付・重説担当）が見つかりません'); continue; }

      const dutyGid = process.env.JUSETSU_DUTY_GID;
      if (dutyGid && sheetId) {
        const duties = await fetchDuties(sheetId, dutyGid);
        if (duties) {
          data.duties = duties;
          duties.forEach(d => { if (d.name && !data.staff.includes(d.name)) data.staff.push(d.name); });
        }
      }
      return res.status(200).json({ success: true, source: 'sheet', ...data, fetchedAt: new Date().toISOString() });
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

/** 当番のシートを読む（日付と当番名だけの簡単な表）。読めなければ null */
async function fetchDuties(sheetId, gid) {
  const urls = [
    `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv&gid=${gid}`,
    `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:csv&gid=${gid}`,
  ];
  for (const url of urls) {
    try {
      const r = await fetch(url, { redirect: 'follow', cache: 'no-store' });
      const text = await r.text();
      if (!r.ok || /^\s*</.test(text)) continue;

      const rows = parseCsv(text);
      const clean = v => String(v ?? '').replace(/\s+/g, ' ').trim();
      let head = rows.findIndex(x => x.some(c => clean(c).includes('日付')));
      let dateCol = 0, nameCol = 1;
      if (head >= 0) {
        const h = rows[head].map(clean);
        dateCol = h.findIndex(c => c.includes('日付'));
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

/** スプレッドシートの一覧表を読み取る（見出しの文字で列を探す） */
function parseJusetsu(rows) {
  const clean = v => String(v ?? '').replace(/\s+/g, ' ').trim();
  const headIdx = rows.findIndex(r => {
    const t = r.map(clean).join('|');
    return t.includes('日付') && (t.includes('重説担当') || t.includes('担当'));
  });
  if (headIdx < 0) return { rows: [], duties: [], staff: [] };

  const head = rows[headIdx].map(clean);
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
    if (col.duty >= 0) {
      const d = clean(row[col.duty]);
      if (d && !duties[date]) duties[date] = d;
    }
    const staff = col.staff >= 0 ? clean(row[col.staff]) : '';
    const sales = col.sales >= 0 ? clean(row[col.sales]) : '';
    if (!staff && !sales) continue;
    out.push({
      date,
      time : normalizeTime(col.time >= 0 ? clean(row[col.time]) : ''),
      staff,
      sales,
      note : col.note >= 0 ? clean(row[col.note]) : '',
    });
  }
  const staff = [];
  out.forEach(x => { if (x.staff && !staff.includes(x.staff)) staff.push(x.staff); });
  Object.values(duties).forEach(d => { if (d && !staff.includes(d)) staff.push(d); });
  return { rows: out, duties: Object.entries(duties).map(([date, name]) => ({ date, name })), staff };
}

/** 時間を「HH:MM」にそろえる（「21:00:00」「21：00」「21時00分」「20:00:00.000Z」に対応） */
function normalizeTime(v) {
  const s = String(v).replace(/[：]/g, ':').trim();
  if (!s) return '';
  let m = s.match(/(\d{1,2}):(\d{2})/);
  if (!m) m = s.match(/(\d{1,2})\s*時\s*(\d{1,2})?\s*分?/);
  if (!m) return '';
  const h = String(Number(m[1])).padStart(2, '0');
  const mi = String(Number(m[2] || 0)).padStart(2, '0');
  return `${h}:${mi}`;
}

/** 日付をYYYY-MM-DDにそろえる（「2026/8/26」「8/26」「8月26日」「2026-08-26」に対応） */
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
    if (now.getMonth() + 1 === 12 && m === 1) y += 1;
    if (now.getMonth() + 1 === 1 && m === 12) y -= 1;
  }
  if (!(m >= 1 && m <= 12 && d >= 1 && d <= 31)) return '';
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}
