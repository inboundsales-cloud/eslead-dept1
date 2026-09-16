// =====================================================
// ロープレ予定との重複を「毎朝まとめてチェック」するAPI（Vercel Cronで定期実行します）
//
// notion-create.js の checkRoleplayConflict は「書類回収を新規登録した、その瞬間」
// にしかチェックしません。そのため、
//  ・すでに登録済みの書類回収案件（このAPIを追加する前に登録されたものを含む）
//  ・書類回収を登録した後で、ロープレの予定表（スプレッドシート）側が更新されたケース
// は、これまで一切チェックされていませんでした。
//
// このAPIは、今日から数日先までの「まだ回収されていない」書類回収案件を、
// 呼ばれるたびに毎回そのときのロープレ予定表と突き合わせます。
// 重複が解消されるまでは、対象日である限り毎日通知します
// （一度通知したら同じ組み合わせは黙る、という仕組みはあえて持たせていません。
//   「未解決なら毎日通知してほしい」というご要望に合わせています）。
//
// ---- 使用する環境変数 ----
//   NOTION_API_KEY   … 既存のものをそのまま使います
//   LW_WEBHOOK_URL   … notion-create.jsと共通（LINE WORKS Incoming Webhook）
//   CRON_SECRET      … 新規。Vercelはcron実行時にこの値を使って自動で
//                       `Authorization: Bearer <CRON_SECRET>` ヘッダーを
//                       付けてくれるので、それと一致するかを確認し、
//                       外部から誰でも叩けてしまわないようにします。
//                       Vercelの環境変数に、適当なランダム文字列（16文字以上推奨）
//                       を設定してください。
//   CHECK_DAYS_AHEAD … 省略可。今日を含めて何日先まで見るか（既定7＝今日+6日先まで）
//
// ---- vercel.json への追加が必要です ----
// 毎朝9:30(日本時間)ごろに実行するには、プロジェクト直下の vercel.json に
// 次の内容を追加してください（すでに vercel.json がある場合は "crons" の
// 部分だけをマージしてください。他の設定を消さないようご注意ください）。
//
//   {
//     "crons": [
//       { "path": "/api/check-roleplay-conflicts", "schedule": "30 0 * * *" }
//     ]
//   }
//
// Vercelのcronスケジュールは常にUTCで解釈されるため、日本時間9:30は
// UTC 0:30 = "30 0 * * *" です。
// ※Vercelの無料(Hobby)プランは「1日1回」までのcronは使えますが、実行時刻が
//   最大±59分ずれることがあります（9:30ちょうどではなく9:00〜9:59の間に
//   実行される場合があります）。時刻を秒単位で厳密に合わせたい場合はProプラン
//   以上が必要です。
// =====================================================

import { roleplayTrainersOn, notifyLineWorks, buildConflictMessage, gp, queryAllNotion, isoToday, addDaysIso, cut } from './_shared.js';

const SHORUI_DB = 'f83e35035a8946448a45b5d4dec52960'; // 書類回収（notion-create.jsのTARGETS.shoruiと同じID）
const DAYS_AHEAD_DEFAULT = 7; // 今日を含めて何日分先まで見るか

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  const CRON_SECRET = process.env.CRON_SECRET;
  if (!CRON_SECRET) {
    return res.status(500).json({ error: 'サーバー設定エラー（CRON_SECRET 未設定）。Vercelの環境変数にCRON_SECRETを設定してください。' });
  }
  const auth = req.headers?.authorization || '';
  if (auth !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ error: '認証エラー' });
  }

  const API_KEY = process.env.NOTION_API_KEY;
  if (!API_KEY) return res.status(500).json({ error: 'サーバー設定エラー（NOTION_API_KEY 未設定）' });

  try {
    const daysAhead = Number(process.env.CHECK_DAYS_AHEAD) || DAYS_AHEAD_DEFAULT;
    const today = isoToday(); // 日本時間の「今日」
    const targetDates = Array.from({ length: daysAhead }, (_, i) => addDaysIso(today, i));
    const dateSet = new Set(targetDates);

    // 書類回収DBを全件取得し、対象期間内・未回収のものだけに絞ります
    const pages = await queryAllNotion(API_KEY, SHORUI_DB, null);
    const rows = pages.map(p => ({
      plan: gp(p, '回収予定日'),
      who: gp(p, '担当者名'),
      rep: gp(p, '回収担当者'), // まとめの代表者がいれば、実際に回収へ行くのはこの人
      dept: gp(p, '部'),
      bukken: gp(p, '物件名'),
      customer: gp(p, 'お客様名'),
      state: gp(p, '状態') || '未回収',
    })).filter(x => dateSet.has(x.plan) && x.state !== '回収済');

    // 同じ日付のロープレ予約者一覧は、その日に案件が何件あっても1回だけ取得して使い回します
    const trainersByDate = new Map();
    const getTrainers = async d => {
      if (!trainersByDate.has(d)) trainersByDate.set(d, await roleplayTrainersOn(d));
      return trainersByDate.get(d);
    };

    // 同じ人・同じ日に複数の書類回収案件が重なっていても、通知は1通にまとめます
    const grouped = new Map(); // key: "日付|担当者" -> {plan,who,dept,items:[{bukken,customer}]}
    for (const x of rows) {
      const who = x.rep || x.who;
      if (!who) continue;
      const trainers = await getTrainers(x.plan);
      if (!trainers.includes(who)) continue;
      const key = x.plan + '|' + who;
      if (!grouped.has(key)) grouped.set(key, { plan: x.plan, who, dept: x.dept, items: [] });
      grouped.get(key).items.push({ bukken: x.bukken, customer: x.customer });
    }

    const conflicts = [...grouped.values()];
    for (const c of conflicts) {
      const label = c.items
        .map(it => cut(it.bukken, 60).trim() || cut(it.customer, 60).trim())
        .filter(Boolean).join('、');
      await notifyLineWorks(buildConflictMessage({ dept: c.dept, who: c.who, plan: c.plan, bukken: label, customer: '' }));
    }

    return res.status(200).json({
      success: true,
      checkedRange: [targetDates[0], targetDates[targetDates.length - 1]],
      checkedCount: rows.length,
      conflictCount: conflicts.length,
      conflicts: conflicts.map(c => ({ plan: c.plan, who: c.who, dept: c.dept })),
    });
  } catch (e) {
    console.error('[check-roleplay-conflicts]', e);
    return res.status(500).json({ error: '通信エラーが発生しました', detail: e.message });
  }
}
