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
 * レポートの形式によってここを調整してください
 */
function formatReport(reportData, reportKey) {
  try {
    const factMap      = reportData.factMap || {};
    const groupings    = reportData.groupingsDown?.groupings || [];

    // 個人ランキング系（明細レポート）
    if (reportKey.includes('personal')) {
      const rows = [];
      Object.keys(factMap).forEach(key => {
        if (!key.endsWith('!T')) return; // 合計行をスキップ
        const cells = factMap[key]?.dataCells || [];
        if (cells.length === 0) return;

        // ※ 列の順番はレポートの設定によって異なります
        // 実レポートの構成に合わせてインデックスを調整してください
        rows.push({
          name  : cells[0]?.label || '',   // 氏名列（例：0列目）
          amount: cells[1]?.value || 0,    // 売上金額列（例：1列目）
          role  : cells[2]?.label || '',   // 役職列（例：2列目）
        });
      });

      rows.sort((a, b) => Number(b.amount) - Number(a.amount));
      return rows;
    }

    // 課別ランキング系（集計レポート）
    if (reportKey.includes('course')) {
      const rows = [];
      groupings.forEach(group => {
        const key    = group.key + '!T';
        const cells  = factMap[key]?.dataCells || [];
        rows.push({
          name  : group.label || '',        // 課名
          chief : '',                        // 課長名（レポートに含まれる場合は調整）
          dept  : '',                        // 部名（レポートに含まれる場合は調整）
          amount: cells[0]?.value || 0,     // 売上金額
        });
      });

      rows.sort((a, b) => Number(b.amount) - Number(a.amount));
      return rows;
    }

    return [];
  } catch(e) {
    console.error('formatReport error:', e);
    return [];
  }
}
