export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  // Vercel環境のIP情報を取得(デバッグ用)
  const clientIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
                   req.headers['cf-connecting-ip'] ||
                   req.socket?.remoteAddress ||
                   'unknown';
  const vercelEnv = process.env.VERCEL_ENV || 'unknown';
  const deploymentId = process.env.VERCEL_DEPLOYMENT_ID?.slice(0, 8) || 'unknown';

  const CLIENT_ID     = process.env.SF_CLIENT_ID;
  const CLIENT_SECRET = process.env.SF_CLIENT_SECRET;
  const LOGIN_URL     = process.env.SF_LOGIN_URL || 'https://login.salesforce.com';

  const REPORT_IDS = {
    annual_personal : process.env.SF_REPORT_ANNUAL_PERSONAL,
    q3_personal     : process.env.SF_REPORT_Q3_PERSONAL,
    annual_course   : process.env.SF_REPORT_ANNUAL_COURSE,
    q3_course       : process.env.SF_REPORT_Q3_COURSE,
  };

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
    const tokenRes = await fetch(`${LOGIN_URL}/services/oauth2/token`, {
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
      return res.status(500).json({ error: 'SF認証失敗', detail: err, debug: { clientIp, vercelEnv, deploymentId } });
    }

    const tokenData    = await tokenRes.json();
    const accessToken  = tokenData.access_token;
    const instanceUrl  = tokenData.instance_url;

    // ② レポートデータ取得
    const reportRes = await fetch(
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
      return res.status(500).json({ error: 'レポート取得失敗', detail: err, debug: { clientIp, vercelEnv, deploymentId } });
    }

    const reportData = await reportRes.json();

    // ③ データを整形してフロントエンドに返す
    const formatted = formatReport(reportData, reportKey);
    return res.status(200).json({
      success: true,
      data: formatted,
      raw: reportData,
      debug: { clientIp, vercelEnv, deploymentId, timestamp: new Date().toISOString() }
    });

  } catch(e) {
    return res.status(500).json({ error: e.message, debug: { clientIp, vercelEnv, deploymentId } });
  }
}

/**
 * Salesforceのレポートデータを整形する
 * レポートの形式によってここを調整してください
 */
function formatReport(reportData, reportKey) {
  try {
    const factMap      = reportData.factMap || {};
    const columns      = reportData.reportMetadata?.detailColumns || [];
    const groupings    = reportData.groupingsDown?.groupings || [];

    // 個人ランキング系（明細レポート）
    if (reportKey.includes('personal')) {
      const rows = [];
      Object.keys(factMap).forEach(key => {
        if (!key.endsWith('!T')) return; // 合計行をスキップ
        const cells = factMap[key]?.dataCells || [];
        if (cells.length === 0) return;

        // ※ 列の順番はレポートの設定によって異なります
        // 情シスのレポート構成に合わせてインデックスを調整してください
        rows.push({
          name  : cells[0]?.label || '',   // 氏名列（例：0列目）
          amount: cells[1]?.value || 0,    // 売上金額列（例：1列目）
          role  : cells[2]?.label || '',   // 役職列（例：2列目）
        });
      });

      // 金額降順にソート
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
