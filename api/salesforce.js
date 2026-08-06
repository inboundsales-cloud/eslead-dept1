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
 *     [0] s!Achievement__c.Amount__c … 金額
 *     [1] RowCount                   … 件数
 *
 * ラベルから氏名・部・課・役職を取り出して返します。
 */
function formatReport(reportData, reportKey) {
  try {
    const factMap   = reportData.factMap || {};
    const groupings = reportData.groupingsDown?.groupings || [];

    const rows = [];
    groupings.forEach(group => {
      const agg    = factMap[`${group.key}!T`]?.aggregates || [];
      const amount = Number(agg[0]?.value) || 0;
      const count  = Number(agg[1]?.value) || 0;
      const label  = group.label || '';

      rows.push({ ...parseLabel(label), label, amount, count });
    });

    rows.sort((a, b) => b.amount - a.amount);
    return rows;
  } catch(e) {
    console.error('formatReport error:', e);
    return [];
  }
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
