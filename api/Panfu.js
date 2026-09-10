// =====================================================
// パンフレット・価格表 在庫管理ボード用API
//
// 営業戦略室が管理する「物件パンフ・価格表管理表」スプレッドシートを読み取り、
// サイネージが表示しやすい形に整えて返します。
// 入力はスプレッドシート側で行い、アプリは表示するだけです。
//
// 【スプレッドシートの様式】
// 1行目に見出しを置いた、ふつうの一覧表です。列の並び順は自由で、
// 見出しの文字で列を探すので、列を増やしても問題ありません。
//
//   物件名称        | 販売期  | パンフ  | パンフメモ           | 価格表   | 価格表メモ | desk net's | 備考
//   大曾根アヴェール | 26年3Q | 配布中  |                     | 配布中   |           | TRUE       |
//   桜山ル・ヴェール | 26年3Q | 完売    |                     | 完売     |           | FALSE      | 配布禁止
//
//  ・「パンフ」「価格表」には状態（配布中／完売／分譲前／条件付き配布 など）を書きます。
//    決まった選択肢はありません。文言に応じて画面側で色分けされます。
//  ・「desk net's」は原本の有無の代わりに、デスクネッツの書籍でも確認できるかどうかを
//    TRUE / FALSE（○ / ×でも可）で入力します。
//
// 【スプレッドシート側の準備】
//  共有 →「リンクを知っている全員」→「閲覧者」にしてください。
//  環境変数（省略した場合は下記のデフォルトのシートを読みます）
//    PANHU_SHEET_ID  … スプレッドシートのID
//    PANHU_SHEET_GID … シートのgid（省略時は先頭のタブ）
//    PANHU_CSV_URL   … CSVを直接指定したい場合（上記より優先）
// =====================================================

const DEFAULT_SHEET_ID = '1Q_zrTCnizjTHfe7AX5DzoIsary3qHEt8CihzMI20O30';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const fresh = req.query?.fresh === '1';
  res.setHeader('Cache-Control', fresh
    ? 'no-store'
    : 'public, max-age=0, s-maxage=30, stale-while-revalidate=60');

  const sheetId = process.env.PANHU_SHEET_ID || DEFAULT_SHEET_ID;
  const gid     = process.env.PANHU_SHEET_GID || '0';

  const candidates = [
    process.env.PANHU_CSV_URL,
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

      const items = parsePanhu(parseCsv(text));
      if (!items.length) { problems.push('見出し（物件名称・パンフ など）が見つかりません'); continue; }

      return res.status(200).json({ success: true, items, fetchedAt: new Date().toISOString() });
    } catch (e) {
      problems.push(e.message);
    }
  }

  console.error('[panhu] 取得失敗:', problems.join(' / '));
  return res.status(502).json({
    error : 'スプレッドシートを読み込めませんでした',
    hint  : 'スプレッドシートの共有設定を「リンクを知っている全員（閲覧者）」にしてください。',
    detail: problems,
  });
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
function parsePanhu(rows) {
  const clean = v => String(v ?? '').replace(/\s+/g, ' ').trim();

  // 見出しの行を探す（「物件名称」と「パンフ」の両方を含む行）
  const headIdx = rows.findIndex(r => {
    const t = r.map(clean).join('|');
    return (t.includes('物件名称') || t.includes('物件名')) && t.includes('パンフ');
  });
  if (headIdx < 0) return [];

  const head = rows[headIdx].map(clean);
  // 複数の条件をすべて満たす最初の列を探す（例：「パンフ」は含むが「メモ」は含まない）
  const find = (mustInclude, mustExclude = []) =>
    head.findIndex(h => h && mustInclude.every(k => h.includes(k)) && !mustExclude.some(k => h.includes(k)));

  const col = {
    name    : find(['物件名']),
    period  : find(['販売期']),
    panhu   : find(['パンフ'], ['メモ']),
    panhuM  : find(['パンフ', 'メモ']),
    kakaku  : find(['価格表'], ['メモ']),
    kakakuM : find(['価格表', 'メモ']),
    desknet : (() => { const i = find(["desk"]); return i >= 0 ? i : find(['デスクネッツ']); })(),
    note    : find(['備考']),
  };
  if (col.name < 0) return [];

  const truthy = v => /^(true|○|◯|✓|✔|yes|あり|y)$/i.test(clean(v));

  const out = [];
  for (let r = headIdx + 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row) continue;
    const name = clean(row[col.name]);
    if (!name) continue; // 物件名称が空の行は区切り・余白として無視

    out.push({
      name,
      period     : col.period  >= 0 ? clean(row[col.period])  : '',
      panhuStatus: col.panhu   >= 0 ? clean(row[col.panhu])   : '',
      panhuMemo  : col.panhuM  >= 0 ? clean(row[col.panhuM])  : '',
      kakakuStatus: col.kakaku >= 0 ? clean(row[col.kakaku])  : '',
      kakakuMemo : col.kakakuM >= 0 ? clean(row[col.kakakuM]) : '',
      desknet    : col.desknet >= 0 ? truthy(row[col.desknet]) : false,
      note       : col.note    >= 0 ? clean(row[col.note])    : '',
    });
  }
  return out;
}
