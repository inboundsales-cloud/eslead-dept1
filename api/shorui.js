// =====================================================
// 書類管理回収ボード用API（GET /api/shorui）
//
// Salesforceの2本のレポートを読み込み、424件の名簿（_shorui-baseline.js）と
// 照らし合わせて、進捗・残り・未申込・猶予中などを数えて返します。
//   ・書類回収サイネージ … 環境変数 SF_REPORT_SHORUI
//   ・物件残戸数         … 環境変数 SF_REPORT_ZANKO
// 接続方法（QuotaGuard経由・Client Credentials）は api/salesforce.js と同じです。
// 既存の api/salesforce.js には一切手を加えていません。
//
// 調査用：/api/shorui?debug=1 … レポートの列名だけを返します（データは返しません）
// 毎週の記録：/api/shorui?snapshot=1 … Vercel Cron が毎週金曜23時台（日本時間）に呼び、
//   その時点の数字を「その週の締め」として非公開のBlobに保存します。
//   Cron以外からは保存できないよう、環境変数 CRON_SECRET で確かめます。
//   締めのルール：金曜23時時点の数字で記録。土曜の実績は翌週に数えます。
// =====================================================
import { fetch as undiciFetch, ProxyAgent } from 'undici';
import { BASELINE } from './_shorui-baseline.js';
import { put, list, get } from '@vercel/blob';

// ---- 決めごと（ここを直せば動きを変えられます）----
const GRACE_DAYS = 14;                    // 契約日の翌日から何日で「未申込」に数え始めるか
const COUNT_KUBUN = ['契約', '引渡'];      // 数える契約区分
const BU_LIST = ['1部', '2部', '3部'];     // 表示する部（それ以外は「その他」）
const WEEKLY_TARGET = 20;                 // 各部の毎週の目標本数
const SNAP_PREFIX = 'shorui/snapshots/';  // 毎週の記録の保存場所（Blob）
const CLOSE_RULE = '各週の締めは、金曜23時時点の数字で記録します。土曜の実績は翌週に数えます。Salesforceへの入力が翌営業日になった分も翌週に数えます。';

// レポートの列名（Salesforceの表示名）。前後の空白・全角半角の違いは無視して探します。
const COLS_SHORUI = {
  code: ['成約コード'], bukken: ['物件名'], kubun: ['契約区分'], heya: ['部屋名'],
  bu: ['契約者（主）: 担当者（社員）: 部'], ka: ['契約者（主）: 担当者（社員）: 部課'],
  tanto: ['契約者（主）: 担当者名'], keiyakubi: ['契約日付'], gositu: ['号室'],
  shinsa: ['審査'], hikiwatashi1: ['初回引渡日'], type: ['部屋タイプ'],
};
const COLS_ZANKO = { bukken: ['物件名'], heya: ['部屋名'], bango: ['部屋番号'], seiyaku: ['成約済'] };

// ---- 問い合わせ回数の節約（日中30分・夜間2時間に1回だけSalesforceへ）----
const JST = () => new Date(Date.now() + 9 * 3600000);
const IS_DAY = () => { const h = JST().getUTCHours(); return h >= 8 && h < 20; };
const TTL = () => (IS_DAY() ? 30 : 120) * 60000;
let memo = null;          // { at, data }
let inflight = null;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'GET') return res.status(405).json({ error: 'GETのみ対応しています' });

  const ids = { shorui: process.env.SF_REPORT_SHORUI, zanko: process.env.SF_REPORT_ZANKO };
  if (!ids.shorui || !ids.zanko) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(500).json({ error: '環境変数 SF_REPORT_SHORUI / SF_REPORT_ZANKO が未設定です' });
  }

  try {
    if (req.query?.debug === '1') {
      const [a, b] = await Promise.all([fetchReport(ids.shorui), fetchReport(ids.zanko)]);
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json({ 書類回収サイネージ: columnLabels(a), 物件残戸数: columnLabels(b) });
    }
    if (req.query?.snapshot === '1') {
      const secret = process.env.CRON_SECRET;
      if (!secret || req.headers?.authorization !== `Bearer ${secret}`) {
        res.setHeader('Cache-Control', 'no-store');
        return res.status(401).json({ error: '記録はVercel Cronからのみ受け付けます' });
      }
      const [a, b] = await Promise.all([fetchReport(ids.shorui), fetchReport(ids.zanko)]);
      const d = build(a, b);
      const snap = { 締め日: d.今日, 記録時刻: new Date().toISOString(), 締めのルール: CLOSE_RULE,
        全体: d.全体, 週: d.週, 部: d.部.map(({ 部, 進捗, 目標進捗, 今週あと, 新しく未申込, 未申込, 猶予中, 申込済 }) => ({ 部, 進捗, 目標進捗, 今週あと, 新しく未申込, 未申込, 猶予中, 申込済 })),
        課: d.課 };
      await put(`${SNAP_PREFIX}${d.今日}.json`, JSON.stringify(snap), { access: 'private', addRandomSuffix: false, allowOverwrite: true, contentType: 'application/json' });
      memo = null;
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json({ success: true, 記録した締め日: d.今日 });
    }
    const fresh = req.query?.fresh === '1';
    if (!memo || fresh || Date.now() - memo.at >= TTL()) {
      if (!inflight) {
        inflight = Promise.all([fetchReport(ids.shorui), fetchReport(ids.zanko)])
          .then(async ([a, b]) => { const data = build(a, b); data.週ごとの記録 = await readHistory(data); memo = { at: Date.now(), data }; })
          .finally(() => { inflight = null; });
      }
      await inflight;
    }
    res.setHeader('Cache-Control', fresh ? 'no-store' : 'public, max-age=0, s-maxage=600');
    return res.status(200).json({ success: true, fetchedAt: new Date(memo.at).toISOString(), ...memo.data });
  } catch (e) {
    console.error('[shorui]', e);
    res.setHeader('Cache-Control', 'no-store');
    return res.status(500).json({ error: e.message });
  }
}

// =====================================================
// 集計
// =====================================================
function build(repShorui, repZanko) {
  const checks = [];
  const today = JST(); today.setUTCHours(0, 0, 0, 0);
  const todayStr = today.toISOString().slice(0, 10);

  // ---- 書類回収サイネージ：契約・引渡の成約を、部屋ごとに1件にまとめる ----
  const s = readRows(repShorui, COLS_SHORUI, checks, '書類回収サイネージ');
  const contracts = new Map(); // 部屋 → 成約
  for (const r of s.rows) {
    if (r.type && r.type !== '投資用') continue;
    if (!COUNT_KUBUN.includes(r.kubun)) continue;
    const room = roomKey(r.heya, r.gositu);
    if (!room) { checks.push({ 項目: '部屋名・号室が空欄', 内容: `成約コード ${r.code}` }); continue; }
    const c = {
      部屋: room, 成約コード: r.code, 物件名: r.bukken, 号室: num(r.gositu), 担当者: name(r.tanto),
      部: bu(r.bu), 課: ka(r.ka), 契約区分: r.kubun, 契約日: r.keiyakubi || '', 初回引渡日: r.hikiwatashi1 || '',
      申込済: !!(r.shinsa && String(r.shinsa).trim() !== ''),
    };
    if (!c.契約日) checks.push({ 項目: '契約日付が空欄', 内容: `${c.担当者}・成約コード ${c.成約コード}` });
    const days = c.契約日 ? Math.floor((today - (Date.parse(c.契約日) + 86400000)) / 86400000) : 999;
    c.状態 = c.申込済 ? '申込済' : (days >= GRACE_DAYS ? '未申込' : '猶予中');
    const prev = contracts.get(room);
    if (prev) {
      checks.push({ 項目: '同じ部屋に契約・引渡の成約が2件以上', 内容: `${c.物件名} ${c.号室}号室（${prev.成約コード}・${c.成約コード}）` });
      if (c.契約日 < prev.契約日) continue;
    }
    contracts.set(room, c);
  }

  // ---- 物件残戸数：部屋ごとの成約済チェック ----
  const z = readRows(repZanko, COLS_ZANKO, checks, '物件残戸数');
  const rooms = [];
  for (const r of z.rows) {
    const room = roomKey(r.heya, r.bango);
    if (!room) continue;
    rooms.push({ 部屋: room, 物件名: r.bukken || r._group || '', 号室: num(r.bango), 成約済: r.seiyaku });
  }

  // ---- 名簿との照らし合わせ ----
  const listUnsold = BASELINE['未契約の部屋'], listMishin = BASELINE['未申込の成約'];
  const inList = new Set([...listUnsold.map(x => x.部屋), ...listMishin.map(x => x.部屋)]);
  const emptyBu = () => Object.fromEntries([...BU_LIST, 'その他'].map(b => [b, 0]));
  const doneBu = emptyBu(), newBu = emptyBu(), doneKa = {}, newKa = {};
  const addKa = (o, b, k) => { const key = `${b} ${k}`; o[key] = (o[key] || 0) + 1; };
  let doneUnsold = 0, doneMishin = 0, unsoldWaiting = 0, unsoldLeft = 0, mishinLeft = 0;
  const donePerson = new Map(); // 「氏名｜部｜課」→ 処理した件数
  const addP = (n, b, k) => { const key = `${n}｜${b}｜${k}`; donePerson.set(key, (donePerson.get(key) || 0) + 1); };

  for (const x of listUnsold) {          // 未契約の部屋：契約して申込まで済めば1件
    const c = contracts.get(x.部屋);
    if (c && c.申込済) { doneUnsold++; doneBu[c.部]++; addKa(doneKa, c.部, c.課); addP(c.担当者, c.部, c.課); }
    else if (c) unsoldWaiting++;          // 契約済み・申込待ち（猶予中または未申込）
    else unsoldLeft++;
  }
  for (const x of listMishin) {          // 未申込の成約：申込済になれば1件（部・課は名簿の担当で数える）
    const c = contracts.get(x.部屋);
    if (c && c.申込済) { doneMishin++; doneBu[x.部]++; addKa(doneKa, x.部, x.課); addP(x.担当者, x.部, x.課); }
    else mishinLeft++;
  }
  const newMishin = [];                   // 名簿の外で新しく未申込になった成約（母数に加える）
  for (const c of contracts.values()) {
    if (c.状態 === '未申込' && !inList.has(c.部屋)) { newMishin.push(c); newBu[c.部]++; addKa(newKa, c.部, c.課); }
  }

  const start = BASELINE['スタート'], pre = BASELINE['スタート時点の処理済み'];
  const done = doneUnsold + doneMishin;
  const 母数 = start.合計 + newMishin.length;
  const 進捗 = pre.合計 + done;

  // ---- 週の目標（今日以降で一番近い金曜日の目標）----
  const fridays = BASELINE['週の目標'].金曜日;
  let wi = fridays.findIndex(f => f >= todayStr);
  if (wi < 0) wi = fridays.length - 1;
  const 週 = { 締め日: fridays[wi], 何週目: wi + 1, 週数: fridays.length,
    全体の目標進捗: WEEKLY_TARGET * BU_LIST.length * (wi + 1), 各部の目標進捗: WEEKLY_TARGET * (wi + 1) };
  週.全体の目標残り = Math.max(0, start.合計 - 週.全体の目標進捗);

  // ---- 今の状態（全体・部・課・社員）----
  const people = new Map();
  const stat = emptyStat(), statBu = {}, statKa = {};
  for (const b of [...BU_LIST, 'その他']) statBu[b] = emptyStat();
  for (const c of contracts.values()) {
    stat[c.状態]++; statBu[c.部][c.状態]++;
    const kk = `${c.部} ${c.課}`; (statKa[kk] ||= emptyStat())[c.状態]++;
    const pk = `${c.担当者}｜${c.部}｜${c.課}`;
    if (!people.has(pk)) people.set(pk, { 氏名: c.担当者, 部: c.部, 課: c.課, 進捗: 0, 未申込: 0, 猶予中: 0, 申込済: 0, 未申込の一覧: [] });
    const p = people.get(pk); p[c.状態]++;
    if (c.状態 === '未申込') p.未申込の一覧.push({ 物件名: c.物件名, 号室: c.号室, 契約日: c.契約日, 初回引渡日: c.初回引渡日 });
  }
  for (const [pk, n] of donePerson) {   // 処理した件数を社員に付ける（今は成約が無い人も載せる）
    if (!people.has(pk)) { const [氏名, 部, 課] = pk.split('｜'); people.set(pk, { 氏名, 部, 課, 進捗: 0, 未申込: 0, 猶予中: 0, 申込済: 0, 未申込の一覧: [] }); }
    people.get(pk).進捗 = n;
  }
  const unsoldNow = rooms.filter(r => !r.成約済);
  const bukken = {};
  for (const r of rooms) { const b = (bukken[r.物件名] ||= { 物件名: r.物件名, 部屋数: 0, 未契約: 0 }); b.部屋数++; if (!r.成約済) b.未契約++; }

  const bus = [...BU_LIST, 'その他'].map(b => ({ 部: b, 進捗: doneBu[b], 目標進捗: b === 'その他' ? null : 週.各部の目標進捗,
    今週あと: b === 'その他' ? null : Math.max(0, 週.各部の目標進捗 - doneBu[b]),
    新しく未申込: newBu[b], ...statBu[b] }));
  const kas = Object.keys(statKa).sort().map(k => ({ 課: k, 部: k.split(' ')[0], 進捗: doneKa[k] || 0, 新しく未申込: newKa[k] || 0, ...statKa[k] }));

  if (s.allData === false) checks.push({ 項目: '書類回収サイネージの行数が上限を超えています', 内容: '一部のデータが読み込めていません（2,000行の上限）' });
  if (z.allData === false) checks.push({ 項目: '物件残戸数の行数が上限を超えています', 内容: '一部のデータが読み込めていません（2,000行の上限）' });

  const REASON = {
    '部屋名・号室が空欄': '名簿と照らし合わせられず数えられないため、営業事務課で部屋名・号室を入力',
    '契約日付が空欄': '2週間の判定ができず「未申込」として数えられてしまうため、営業事務課で契約日付を入力',
    '同じ部屋に契約・引渡の成約が2件以上': 'どちらの成約を数えるか決まらず本数がずれるため、営業事務課で重複を確認・修正',
  };
  const reasonOf = (k) => REASON[k] || (k.includes('列が見つかりません') ? 'レポートの列名が変わったため数えられません。サイネージの担当者がレポートの列を確認'
    : k.includes('上限') ? 'データの一部しか読めておらず本数が少なく出るため、サイネージの担当者がレポートの条件を確認' : '内容を確認してください');
  checks.forEach((c, i) => { c.番号 = i + 1; c['理由・対応'] = reasonOf(c.項目); });

  return {
    今日: todayStr,
    全体: { スタート: start, 母数, 進捗, 残り: 母数 - 進捗, スタート時点の処理済み: pre.合計,
      うち新しく未申込: newMishin.length,
      今週あと: Math.max(0, (母数 - 進捗) - 週.全体の目標残り), 今週の先行: Math.max(0, 週.全体の目標残り - (母数 - 進捗)),
      残りの内訳: { 未契約のまま: unsoldLeft, 契約済み申込待ち: unsoldWaiting, 未申込: mishinLeft + newMishin.length },
      処理済みの内訳: { 未契約から: doneUnsold, 未申込から: doneMishin } },
    週, 今の状態: { ...stat, 未契約: unsoldNow.length },
    部: bus, 課: kas,
    社員: [...people.values()].sort((a, b) => b.未申込 - a.未申込 || b.猶予中 - a.猶予中),
    更新の間隔: '日中30分ごと・夜間2時間ごと',
    物件: Object.values(bukken),
    確認: checks,
  };
}
const emptyStat = () => ({ 未申込: 0, 猶予中: 0, 申込済: 0 });

// 毎週の記録を読み、グラフ用の「週ごとの目標の残りと実際の残り」を作ります。
// 記録が読めなくても、ほかの数字は表示できるようにしています。
async function readHistory(d) {
  const start = BASELINE['スタート'].合計, fridays = BASELINE['週の目標'].金曜日;
  const per = WEEKLY_TARGET * BU_LIST.length;
  const snaps = {};
  let err = '';
  try {
    const { blobs } = await list({ prefix: SNAP_PREFIX });
    for (const bl of blobs) {
      const r = await get(bl.pathname, { access: 'private' });
      if (r?.statusCode === 200) { const j = JSON.parse(await new Response(r.stream).text()); snaps[j.締め日] = j; }
    }
  } catch (e) { err = '毎週の記録を読めませんでした：' + e.message; console.error('[shorui] history', e); }
  const rows = [{ 金曜日: 'スタート', 目標の残り: start, 実際の残り: start - BASELINE['スタート時点の処理済み'].合計, 記録: '10/16の名簿作成時' }];
  fridays.forEach((f, i) => {
    const s = snaps[f];
    rows.push({ 金曜日: f, 目標の残り: Math.max(0, start - per * (i + 1)),
      実際の残り: s ? s.全体.残り : (f === d.週.締め日 ? d.全体.残り : null),
      記録: s ? '締め（金曜23時時点）' : (f === d.週.締め日 ? '今週（途中経過）' : '') });
  });
  return { 締めのルール: CLOSE_RULE, 週: rows, エラー: err };
}

// =====================================================
// レポートの読み取り（表形式・グループ化された形式の両方に対応）
// =====================================================
const norm = s => String(s ?? '').normalize('NFKC').replace(/\s+/g, '');
function columnLabels(rep) {
  const info = rep.reportExtendedMetadata?.detailColumnInfo || {};
  return (rep.reportMetadata?.detailColumns || []).map(k => info[k]?.label || k);
}
function readRows(rep, colsDef, checks, title) {
  const info = rep.reportExtendedMetadata?.detailColumnInfo || {};
  const cols = rep.reportMetadata?.detailColumns || [];
  const labels = cols.map(k => norm(info[k]?.label || k));
  const types = cols.map(k => String(info[k]?.dataType || '').toLowerCase());
  const idx = {};
  for (const [key, names] of Object.entries(colsDef)) {
    idx[key] = labels.findIndex(l => names.some(n => l === norm(n)));
    const grouped = (rep.groupingsDown?.groupings || []).length > 0;
    if (idx[key] < 0 && key !== 'type' && !(grouped && key === 'bukken')) checks.push({ 項目: `${title}に列が見つかりません`, 内容: names[0] });
  }
  const fm = rep.factMap || {};
  const groups = rep.groupingsDown?.groupings || [];
  const blocks = groups.length ? flatGroups(groups).map(g => ({ rows: fm[`${g.key}!T`]?.rows || [], label: g.label })) : [{ rows: fm['T!T']?.rows || [], label: '' }];
  const rows = [];
  for (const blk of blocks) for (const row of blk.rows) {
    const cells = row.dataCells || [];
    const o = { _group: blk.label };
    for (const [key, i] of Object.entries(idx)) {
      if (i < 0) { o[key] = ''; continue; }
      const cell = cells[i] || {};
      o[key] = cellValue(cell, types[i]);
    }
    rows.push(o);
  }
  return { rows, allData: rep.allData };
}
function flatGroups(groups) { // 一番下の階層のグループだけを取り出します
  const out = [];
  const walk = g => (g.groupings && g.groupings.length ? g.groupings.forEach(walk) : out.push(g));
  groups.forEach(walk);
  return out;
}
// 値の取り出し方：Salesforceは、参照項目（物件名・部屋名など）の value に「レコードID」を、
// label に「画面に表示される名前」を入れて返します。そのため、日付・チェックは value、
// それ以外は label（画面の表示どおり）を使います。空欄は value が空で、label が「-」になります。
function cellValue(cell, type) {
  const v = cell.value;
  if (typeof v === 'boolean') return v;
  if (v === null || v === undefined || v === '') return '';
  if (type.includes('date')) return String(typeof v === 'object' ? (cell.label || '') : v).slice(0, 10).replace(/\//g, '-');
  if (type === 'boolean') return v === true || String(v).toLowerCase() === 'true';
  const l = cell.label;
  if (l !== undefined && l !== null && l !== '-' && l !== '') return String(l).trim();
  return typeof v === 'object' ? '' : String(v).trim();
}
const num = v => { const n = parseInt(String(v ?? '').replace(/[^\d]/g, ''), 10); return Number.isFinite(n) ? String(n) : String(v ?? '').trim(); };
const roomKey = (heya, gositu) => { const code = String(heya ?? '').trim().split(/\s+/)[0]; const g = num(gositu); return code && g ? `${code}-${g}` : ''; };
const name = s => String(s ?? '').replace(/[\s　]+/g, ' ').trim();
function bu(s) { const m = norm(s).match(/投資営業(\d)部/); return m && BU_LIST.includes(`${m[1]}部`) ? `${m[1]}部` : 'その他'; }
function ka(s) { const m = norm(s).match(/(\d+)課/); return m ? `${m[1]}課` : ''; }

// =====================================================
// Salesforce への接続（api/salesforce.js と同じ方式）
// =====================================================
let _agent, _agentUrl, _tok = null;
const TOKEN_TTL = 25 * 60000;
function sfFetch(url, options = {}) {
  const Q = process.env.QUOTAGUARD_URL;
  if (Q && _agentUrl !== Q) {
    try { _agent = new ProxyAgent(Q); } catch (e) { console.error('[shorui] ProxyAgent init failed:', e.message); _agent = undefined; }
    _agentUrl = Q;
  }
  return (Q && _agent) ? undiciFetch(url, { ...options, dispatcher: _agent }) : fetch(url, options);
}
async function sfToken(force) {
  if (!force && _tok && Date.now() - _tok.at < TOKEN_TTL) return _tok;
  const LOGIN_URL = process.env.SF_LOGIN_URL || 'https://login.salesforce.com';
  const r = await sfFetch(`${LOGIN_URL}/services/oauth2/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: process.env.SF_CLIENT_ID, client_secret: process.env.SF_CLIENT_SECRET }),
  });
  if (!r.ok) { _tok = null; throw new Error('SF認証失敗: ' + (await r.text()).slice(0, 300)); }
  const { access_token, instance_url } = await r.json();
  _tok = { at: Date.now(), token: access_token, url: instance_url };
  return _tok;
}
async function fetchReport(reportId) {
  for (let i = 0; i < 2; i++) {
    const t = await sfToken(i > 0);
    // includeDetails=true … 合計だけでなく、1行ずつの明細も受け取ります
    const r = await sfFetch(`${t.url}/services/data/v58.0/analytics/reports/${reportId}?includeDetails=true`, {
      method: 'GET', headers: { Authorization: `Bearer ${t.token}`, 'Content-Type': 'application/json' },
    });
    if (r.status === 401 && i === 0) { _tok = null; continue; }
    if (!r.ok) throw new Error('レポート取得失敗: ' + (await r.text()).slice(0, 300));
    return r.json();
  }
}
