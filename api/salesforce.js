// =====================================================
// Salesforce レポート取得API（QuotaGuardプロキシ対応版・問い合わせ回数の節約つき）
//
// 環境変数 QUOTAGUARD_URL が設定されている場合：
//   → QuotaGuardのHTTPプロキシ経由でSalesforceに接続
//     （QuotaGuardの静的IPからアクセスするため、
// 　　　SalesforceのIP制限にそのIPだけ登録すればOK）
// 未設定の場合：
//   → 従来どおり直接接続（フォールバック）
//
// 注意：Vercel(Node.js)の標準fetchは HTTPS_PROXY 等の
// 環境変数を無視するため、undici の ProxyAgent で
// 明示的にプロキシを通しています。
// =====================================================
import { fetch as undiciFetch, ProxyAgent } from 'undici';

// =====================================================
// ★ 対応表（ここだけ直せば画面の表示項目を合わせられます）
// =====================================================
// Salesforceのレポートに含まれる「集計項目」を、画面側の
// 「実数」「売上予定金額」に結び付けるための表です。
//
// 並び順(0番目・1番目…)ではなく、集計項目のラベルやAPI名に
// 下のキーワードが含まれるかどうかで探します。したがって
// レポートの列を増やしたり並べ替えたりしても壊れません。
//
// 例: レポートの集計項目名が「予定売上高の合計」だった場合は
//     AMOUNT_KEYWORDS に '予定売上高' を1行足すだけで対応できます。
// 上から順に探し、最初に見つかったものを採用します。
const SEISEKI_KEYWORDS = ['成績額', '成績'];                          // → 画面の「成績額」
const AMOUNT_KEYWORDS  = ['売上予定金額', '売上予定', '予定金額'];      // → 画面の「売上予定金額」
const COUNT_KEYWORDS   = ['実数', '本数', '契約本数', '件数', 'RowCount']; // → 件数(現在は画面未使用)

// 「成績額」が見つからなかった場合の保険。
// 通貨型の集計項目のうち最初のものを成績額として扱います。
// (売上予定金額は保険を使いません。無ければ画面に「－」と出ます)
const FALLBACK_ENABLED = true;

// =====================================================
// Salesforceへの問い合わせ回数を減らすしくみ（QuotaGuardの月間リクエスト数の節約）
// =====================================================
//  ・新しい画面は GET /api/salesforce?all=1&b=時間の区切り で、8本のレポートを1回で受け取ります。
//    同じ区切りのあいだは、どの端末も同じURLになるので、Vercelのキャッシュから返ります
//    （何台で見ていても、Salesforceに取りに行くのは日中30分に1回・夜間2時間に1回だけです）
//  ・Salesforceへのログイン（トークン）は1回取ったら、しばらく使い回します
//  ・古い画面の POST（1本ずつ）にも、このサーバーの中の控えから返します
const JST_HOUR = () => (new Date().getUTCHours() + 9) % 24;
const IS_DAY = () => { const h = JST_HOUR(); return h >= 8 && h < 20; };
const REPORT_TTL = () => (IS_DAY() ? 30 : 120) * 60000;
const TOKEN_TTL  = 25 * 60000;
const ALL_KEYS = ['annual_personal', 'q3_personal', 'annual_course', 'q3_course',
  'annual_personal_plan', 'q3_personal_plan', 'annual_course_plan', 'q3_course_plan'];
const mem = new Map();      // reportKey → { at, data } … 整えたあとの結果の控え
let inflightAll = null;     // 8本まとめて取りに行っている最中の約束（同時に来た問い合わせは1回にまとめます）
const inflightOne = new Map();

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  // ---- レポートID（Vercelの環境変数で設定します）----
  // 画面の「成績額」の列に使うレポート（年間成績 / 3ヶ月通算）
  //   annual_personal / q3_personal / annual_course / q3_course
  // 画面の「売上予定金額」の列に使うレポート（〜成績計上予定）
  //   末尾に _plan が付いた4本
  // どちらの系統も、レポート内の集計項目名は「成績額 合計」です。
  // どの列に出すかはレポートの取り違えではなく、この対応で決めています。
  const REPORT_IDS = reportIds();

  // ===== 新しい画面：8本まとめて（GET） =====
  if (req.method === 'GET') {
    if (req.query?.all !== '1') return res.status(400).json({ error: 'all=1 を付けてください' });
    const bucketed = !!req.query?.b;
    const fresh = req.query?.fresh === '1';
    // 区切り付きの問い合わせはVercelのキャッシュに長めに置きます（区切りが変わるとURLも変わります）
    const okHeader = fresh ? 'no-store' : bucketed ? 'public, max-age=0, s-maxage=7200' : 'public, max-age=0, s-maxage=300';
    // このサーバーの控えが新しければ、それを返します（「更新」は控えが1分より古いときだけ取り直し）
    const maxAge = fresh ? 60000 : bucketed ? 60000 : REPORT_TTL();
    const keys = ALL_KEYS.filter(k => REPORT_IDS[k]);
    const fresher = keys.every(k => mem.has(k) && Date.now() - mem.get(k).at < maxAge);
    if (!fresher) {
      if (!inflightAll) inflightAll = fetchAll(REPORT_IDS, keys).finally(() => { inflightAll = null; });
      try { await inflightAll; }
      catch (e) { res.setHeader('Cache-Control', 'no-store'); return res.status(500).json({ error: e.message }); }
    }
    const data = {}, errors = {};
    let oldest = Date.now();
    ALL_KEYS.forEach(k => {
      const m = mem.get(k);
      data[k] = m ? m.data : null;
      if (m) oldest = Math.min(oldest, m.at); else errors[k] = REPORT_IDS[k] ? (lastErr.get(k) || '取得できませんでした') : '環境変数が未設定です';
    });
    if (!data.annual_personal) {
      res.setHeader('Cache-Control', 'no-store');
      return res.status(502).json({ error: '個人レポート(年間成績)を取得できませんでした', errors });
    }
    // 一部だけ取れなかったときは、キャッシュを短くして早めにやり直します
    res.setHeader('Cache-Control', Object.keys(errors).some(k => REPORT_IDS[k]) ? 'public, max-age=0, s-maxage=120' : okHeader);
    return res.status(200).json({ success: true, data, errors, fetchedAt: new Date(oldest).toISOString(), sfCalls: sfCount });
  }

  // ===== 古い画面：1本ずつ（POST）。このサーバーの控えがあれば、それを返します =====
  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  } catch(e) {
    return res.status(400).json({ error: 'Invalid JSON body' });
  }

  const reportKey = body?.reportKey; // 'annual_personal' など
  const reportId  = REPORT_IDS[reportKey];

  if (!reportKey || !reportId) {
    return res.status(400).json({ error: 'reportKey が不正です', validKeys: Object.keys(REPORT_IDS) });
  }

  try {
    if (body?.includeRaw === true) {
      // 調査用：Salesforceの元データ（raw）も返します（毎回取りに行きます）
      const reportData = await fetchReport(reportId);
      const formatted = formatReport(reportData, reportKey);
      mem.set(reportKey, { at: Date.now(), data: formatted });
      return res.status(200).json({ success: true, data: formatted, raw: reportData });
    }
    const m = mem.get(reportKey);
    if (!m || Date.now() - m.at >= REPORT_TTL()) {
      if (!inflightOne.has(reportKey)) {
        inflightOne.set(reportKey, fetchReport(reportId)
          .then(rd => { mem.set(reportKey, { at: Date.now(), data: formatReport(rd, reportKey) }); })
          .finally(() => inflightOne.delete(reportKey)));
      }
      await inflightOne.get(reportKey);
    }
    return res.status(200).json({ success: true, data: mem.get(reportKey).data });
  } catch(e) {
    return res.status(500).json({ error: e.message, via: process.env.QUOTAGUARD_URL ? 'proxy' : 'direct' });
  }
}

function reportIds() {
  return {
    annual_personal      : process.env.SF_REPORT_ANNUAL_PERSONAL,
    q3_personal          : process.env.SF_REPORT_Q3_PERSONAL,
    annual_course        : process.env.SF_REPORT_ANNUAL_COURSE,
    q3_course            : process.env.SF_REPORT_Q3_COURSE,
    annual_personal_plan : process.env.SF_REPORT_ANNUAL_PERSONAL_PLAN,
    q3_personal_plan     : process.env.SF_REPORT_Q3_PERSONAL_PLAN,
    annual_course_plan   : process.env.SF_REPORT_ANNUAL_COURSE_PLAN,
    q3_course_plan       : process.env.SF_REPORT_Q3_COURSE_PLAN,
  };
}

// 8本を、1回のログインで続けて取ります（取れなかった1本は前の控えを残します）
const lastErr = new Map();
async function fetchAll(ids, keys) {
  await sfToken(); // ログインを先に1回だけ済ませます（失敗したらここで止まります）
  await Promise.all(keys.map(async k => {
    try {
      const rd = await fetchReport(ids[k]);
      mem.set(k, { at: Date.now(), data: formatReport(rd, k) });
      lastErr.delete(k);
    } catch (e) { lastErr.set(k, e.message); }
  }));
}

// ===== Salesforce への接続（QuotaGuard経由）とログインの使い回し =====
// 注意：Vercel(Node.js)の標準fetchは HTTPS_PROXY 等の環境変数を無視するため、
// undici の ProxyAgent で明示的にプロキシを通しています。
let _agent, _agentUrl;
let sfCount = 0; // このサーバーが起動してからSalesforceに問い合わせた回数
function sfFetch(url, options = {}) {
  const Q = process.env.QUOTAGUARD_URL; // 例: http://user:pass@xxx.quotaguard.com:9293
  if (Q && _agentUrl !== Q) {
    try { _agent = new ProxyAgent(Q); }
    catch (e) { console.error('[salesforce] ProxyAgent init failed:', e.message); _agent = undefined; }
    _agentUrl = Q;
  }
  sfCount++;
  return (Q && _agent) ? undiciFetch(url, { ...options, dispatcher: _agent }) : fetch(url, options);
}
let _tok = null; // { at, token, url }
async function sfToken(force) {
  if (!force && _tok && Date.now() - _tok.at < TOKEN_TTL) return _tok;
  const LOGIN_URL = process.env.SF_LOGIN_URL || 'https://login.salesforce.com';
  // Salesforce OAuth2.0 認証（Client Credentials フロー）
  const tokenRes = await sfFetch(`${LOGIN_URL}/services/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type   : 'client_credentials',
      client_id    : process.env.SF_CLIENT_ID,
      client_secret: process.env.SF_CLIENT_SECRET,
    })
  });
  if (!tokenRes.ok) { _tok = null; throw new Error('SF認証失敗: ' + (await tokenRes.text()).slice(0, 300)); }
  const { access_token, instance_url } = await tokenRes.json();
  _tok = { at: Date.now(), token: access_token, url: instance_url };
  return _tok;
}
// レポートを1本取ります。ログインが切れていたら1回だけ取り直します
async function fetchReport(reportId) {
  for (let i = 0; i < 2; i++) {
    const t = await sfToken(i > 0);
    const r = await sfFetch(`${t.url}/services/data/v58.0/analytics/reports/${reportId}`, {
      method: 'GET', headers: { 'Authorization': `Bearer ${t.token}`, 'Content-Type': 'application/json' },
    });
    if (r.status === 401 && i === 0) { _tok = null; continue; }
    if (!r.ok) throw new Error('レポート取得失敗: ' + (await r.text()).slice(0, 300));
    return r.json();
  }
}

/**
 * Salesforceのレポートデータを整形する
 *
 * 対象レポートは「サマリー形式(SUMMARY)」で、以下の構造になっています。
 *   groupingsDown.groupings[] … グループの見出し
 *     key   : "0", "1", ...
 *     label : "石川　郁也　（投資営業1部1課　主任）"  ← 個人レポートの場合
 *   factMap["0!T"].aggregates[] … そのグループの集計値
 *
 * 集計値のどれが金額でどれが実数かは、ファイル冒頭の対応表
 * (AMOUNT_KEYWORDS / COUNT_KEYWORDS) を使ってラベルから判定します。
 *
 * 返す項目: { name, dept, course, role, label, amount, count }
 *   amount … 画面の「売上予定金額」
 *   count  … 画面の「実数」
 */
function formatReport(reportData, reportKey) {
  try {
    const factMap   = reportData.factMap || {};
    const groupings = reportData.groupingsDown?.groupings || [];
    const idx       = resolveAggregateIndexes(reportData);

    const num = (agg, i) => (i >= 0 ? Number(agg[i]?.value) || 0 : null);

    const rows = [];
    groupings.forEach(group => {
      const agg   = factMap[`${group.key}!T`]?.aggregates || [];
      const label = group.label || '';
      rows.push({
        ...parseLabel(label),
        label,
        seiseki: num(agg, idx.seiseki) || 0,  // 成績額
        amount : num(agg, idx.amount),        // 売上予定金額(無ければ null)
        count  : num(agg, idx.count) || 0,    // 件数
      });
    });

    rows.sort((a, b) => b.seiseki - a.seiseki);
    return rows;
  } catch(e) {
    console.error('formatReport error:', e);
    return [];
  }
}

/**
 * 対応表をもとに「何番目の集計値が金額／実数か」を特定する
 *
 * reportMetadata.aggregates … 例) ["s!Amount__c", "RowCount"]  ← factMapの並び順
 * reportExtendedMetadata.aggregateColumnInfo … 各項目のラベルとデータ型
 *
 * 見つからなければ -1 を返し、その項目は0として扱われます。
 * Vercelのログに判定結果を出すので、ズレていたら冒頭の対応表を直してください。
 */
function resolveAggregateIndexes(reportData) {
  const keys = reportData.reportMetadata?.aggregates || [];
  const info = reportData.reportExtendedMetadata?.aggregateColumnInfo || {};

  // キーワードに合致する集計項目を探す（ラベル・API名の両方を対象にする）
  const findBy = keywords => {
    for (const kw of keywords) {
      const hit = keys.findIndex(k => {
        const text = `${k} ${info[k]?.label || ''}`;
        return text.toLowerCase().includes(kw.toLowerCase());
      });
      if (hit >= 0) return hit;
    }
    return -1;
  };

  const isMoney = k => {
    const t = info[k]?.dataType || '';
    return k !== 'RowCount' && (t === 'currency' || t === 'double' || t === 'int' || t === 'percent');
  };

  let seiseki = findBy(SEISEKI_KEYWORDS);
  let amount  = findBy(AMOUNT_KEYWORDS);
  let count   = findBy(COUNT_KEYWORDS);

  // 「成績額」と「売上予定金額」が同じ列を指してしまった場合は成績額を優先
  if (amount >= 0 && amount === seiseki) amount = -1;

  if (FALLBACK_ENABLED) {
    // 成績額が見つからない場合のみ、通貨・数値型の最初の項目で代用する
    if (seiseki < 0) seiseki = keys.findIndex(k => isMoney(k) && keys.indexOf(k) !== amount);
    if (count < 0)   count   = keys.indexOf('RowCount');
  }

  const show = i => (i >= 0 ? `${i}: ${info[keys[i]]?.label || keys[i]}` : '★見つかりません');
  console.log('[salesforce] 集計項目の対応:', JSON.stringify({
    集計項目一覧: keys.map((k, i) => `${i}: ${info[k]?.label || k}`),
    成績額      : show(seiseki),
    売上予定金額: show(amount),
    件数        : show(count),
  }));

  return { seiseki, amount, count };
}

/**
 * グループのラベルから氏名・部・課・役職を取り出す
 *
 * 例) "石川　郁也　（投資営業1部1課　主任）"
 *     → { name:'石川 郁也', dept:'1部', course:'1課', role:'主任' }
 *
 * 括弧が無い場合（課別レポートなど）は name にラベル全体が入ります。
 */
function parseLabel(label) {
  const norm = s => s.replace(/[\s　]+/g, ' ').trim();
  const m = label.match(/^(.*?)[（(]([^）)]*)[）)]\s*$/);

  if (!m) {
    // 括弧なし: ラベルそのものが名称（課別レポートなど）
    const dept = label.match(/(\d+)部/);
    return { name: norm(label), dept: dept ? `${dept[1]}部` : '', course: '', role: '' };
  }

  const name  = norm(m[1]);
  const inner = norm(m[2]);                       // "投資営業1部1課 主任"
  const dc    = inner.match(/(\d+)部\s*(\d+)課/); // 部・課の番号
  const parts = inner.split(' ').filter(Boolean);

  return {
    name,
    dept  : dc ? `${dc[1]}部` : '',
    course: dc ? `${dc[2]}課` : '',
    role  : parts.length ? parts[parts.length - 1] : '',
  };
}
