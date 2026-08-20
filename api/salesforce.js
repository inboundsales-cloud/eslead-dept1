// =====================================================
// Salesforce レポート取得API（QuotaGuardプロキシ対応版）
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

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const CLIENT_ID      = process.env.SF_CLIENT_ID;
  const CLIENT_SECRET  = process.env.SF_CLIENT_SECRET;
  const LOGIN_URL      = process.env.SF_LOGIN_URL || 'https://login.salesforce.com';
  const QUOTAGUARD_URL = process.env.QUOTAGUARD_URL; // 例: http://user:pass@xxx.quotaguard.com:9293

  const REPORT_IDS = {
    annual_personal : process.env.SF_REPORT_ANNUAL_PERSONAL,
    q3_personal     : process.env.SF_REPORT_Q3_PERSONAL,
    annual_course   : process.env.SF_REPORT_ANNUAL_COURSE,
    q3_course       : process.env.SF_REPORT_Q3_COURSE,
  };

  // ===== プロキシ設定 =====
  let dispatcher;
  try {
    dispatcher = QUOTAGUARD_URL ? new ProxyAgent(QUOTAGUARD_URL) : undefined;
  } catch (e) {
    console.error('[salesforce] ProxyAgent init failed:', e.message);
    dispatcher = undefined; // プロキシ初期化に失敗したら直接通信にフォールバック
  }
  console.log('[salesforce] outbound mode:', dispatcher ? 'QuotaGuard proxy' : 'direct');

  // プロキシ有無を吸収したfetchラッパー
  const sfFetch = (url, options = {}) =>
    dispatcher ? undiciFetch(url, { ...options, dispatcher }) : fetch(url, options);

  // リクエストボディのパース
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
    // ① Salesforce OAuth2.0 認証（Client Credentials フロー）
    const tokenRes = await sfFetch(`${LOGIN_URL}/services/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type   : 'client_credentials',
        client_id    : CLIENT_ID,
        client_secret: CLIENT_SECRET,
      })
    });

    if (!tokenRes.ok) {
      const err = await tokenRes.text();
      return res.status(500).json({ error: 'SF認証失敗', detail: err, via: dispatcher ? 'proxy' : 'direct' });
    }

    const tokenData    = await tokenRes.json();
    const accessToken  = tokenData.access_token;
    const instanceUrl  = tokenData.instance_url;

    // ② レポートデータ取得（こちらもプロキシ経由）
    const reportRes = await sfFetch(
      `${instanceUrl}/services/data/v58.0/analytics/reports/${reportId}`,
      {
        method : 'GET',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type' : 'application/json',
        }
      }
    );

    if (!reportRes.ok) {
      const err = await reportRes.text();
      return res.status(500).json({ error: 'レポート取得失敗', detail: err, via: dispatcher ? 'proxy' : 'direct' });
    }

    const reportData = await reportRes.json();

    // ③ データを整形してフロントエンドに返す
    const formatted = formatReport(reportData, reportKey);
    return res.status(200).json({ success: true, data: formatted, raw: reportData });

  } catch(e) {
    return res.status(500).json({ error: e.message, via: dispatcher ? 'proxy' : 'direct' });
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
