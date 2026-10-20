// 業務特化ハーネス用の資料チェックリスト（要件定義書 5.1 / 5.2）。
// priority: required（必須） / recommended（推奨） / optional（任意）

export const CHECKLISTS = {
  dev: [
    { id: 'purpose', priority: 'required', label: '目的・成果物の定義', examples: '要件書、設計書', target: '指示ファイルの冒頭',
      hint: 'このプロジェクトで何を作り、何ができたら完成か' },
    { id: 'process', priority: 'required', label: '開発手順', examples: '開発フロー、リリース手順', target: 'スキル',
      hint: '機能追加・修正・リリースの進め方、ブランチ運用' },
    { id: 'environment', priority: 'required', label: '環境情報', examples: 'ディレクトリ構成、ビルド・テストのコマンド、既存ソースコード', target: '指示ファイル',
      hint: '言語・フレームワーク、ディレクトリ構成、ビルド・テスト・リントのコマンド' },
    { id: 'conventions', priority: 'recommended', label: '規約', examples: 'コーディング規約、命名規則', target: '指示ファイルのルール節',
      hint: '命名規則、書き方のルール、コメントやテストの方針' },
    { id: 'review', priority: 'recommended', label: 'レビュー基準', examples: 'レビュー観点、PRテンプレート', target: 'レビュー用サブエージェント',
      hint: 'レビューで必ず見る観点、マージの条件' },
    { id: 'prohibitions', priority: 'recommended', label: '禁止事項・セキュリティ要件', examples: '触ってはいけない領域、機密情報の扱い', target: '権限設定',
      hint: '変更してはいけないファイルやディレクトリ、実行してはいけないコマンド' },
    { id: 'pitfalls', priority: 'optional', label: '過去の失敗・よくある指摘', examples: '障害報告、PRのレビューコメント', target: '「注意点」節',
      hint: '過去に起きた障害や、レビューでよく指摘されること' },
    { id: 'integrations', priority: 'optional', label: '外部連携情報', examples: '利用API、社内ツール', target: '指示ファイル（連携先の説明）',
      hint: '連携する外部API・社内システムと、その使い方' },
  ],
  biz: [
    { id: 'purpose', priority: 'required', label: '業務の目的・成果物の定義', examples: '業務概要、依頼書', target: '指示ファイルの冒頭',
      hint: 'この業務で何を作り、誰に渡すのか' },
    { id: 'procedure', priority: 'required', label: '手順書・業務フロー', examples: 'SOP、作業マニュアル、説明用スライド、業務画面のスクリーンショット', target: 'スキル',
      hint: '作業の順番、使うシステムや帳票、受け渡し先' },
    { id: 'examples', priority: 'required', label: '成果物の見本（良い例）', examples: '過去の報告書、帳票、テンプレート', target: 'スキル内の例、品質基準',
      hint: '過去の良い成果物と、どこが良いのか' },
    { id: 'criteria', priority: 'recommended', label: '判断基準', examples: '承認基準、例外時の対応ルール', target: '指示ファイルのルール節',
      hint: '判断に迷う場面と、そのときの基準・エスカレーション先' },
    { id: 'style', priority: 'recommended', label: '文書スタイル・用語集', examples: '表記ルール、社内用語集', target: '指示ファイルのルール節',
      hint: '表記ゆれのルール、社内用語、敬語・文体' },
    { id: 'checklist', priority: 'recommended', label: 'チェックリスト', examples: '提出前確認項目、検収基準', target: 'レビュー用サブエージェント',
      hint: '提出前に必ず確認すること' },
    { id: 'compliance', priority: 'recommended', label: '禁止事項・コンプライアンス', examples: '個人情報の扱い、社内規程', target: '権限設定、指示ファイル',
      hint: '扱ってはいけない情報、やってはいけないこと' },
    { id: 'pitfalls', priority: 'optional', label: '過去の失敗・FAQ', examples: '差し戻し事例、問い合わせ集', target: '「注意点」節',
      hint: 'よく差し戻される点、よくある質問' },
  ],
};

export const PRIORITY_LABEL = { required: '必須', recommended: '推奨', optional: '任意' };

export function checklistFor(workType) {
  return CHECKLISTS[workType === 'biz' ? 'biz' : 'dev'];
}

const RANK = { missing: 0, partial: 1, full: 2 };

/**
 * 充足度を集計する。
 * materials: [{ id, name, included, digest: { coverage: { [itemId]: 'full'|'partial' } } }]
 * answers:   [{ itemId, answer }]  補完ヒアリングの回答
 * hearing:   ヒアリング回答（目的など一部の項目を部分的に満たす）
 */
export function computeCoverage(workType, materials, answers = [], hearing = {}) {
  const items = checklistFor(workType);
  const result = {};
  for (const item of items) result[item.id] = { status: 'missing', sources: [] };

  const bump = (id, status, source) => {
    const r = result[id];
    if (!r) return;
    if (RANK[status] > RANK[r.status]) r.status = status;
    if (source && !r.sources.includes(source)) r.sources.push(source);
  };

  for (const m of materials || []) {
    if (m.included === false || !m.digest?.coverage) continue;
    for (const [id, st] of Object.entries(m.digest.coverage)) {
      if (st === 'full' || st === 'partial') bump(id, st, m.name);
    }
  }
  for (const a of answers || []) {
    if (a.answer && a.answer.trim().length >= 4) bump(a.itemId, 'partial', '補完ヒアリング');
  }
  if (hearing.purpose && hearing.purpose.trim().length >= 10) bump('purpose', 'partial', 'ヒアリング');
  if (workType !== 'biz' && (hearing.techStack || hearing.commands)) bump('environment', 'partial', 'ヒアリング');

  const list = items.map(item => ({ ...item, ...result[item.id] }));
  const score = list.reduce((s, i) => s + RANK[i.status], 0) / (list.length * 2);
  const missingRequired = list.filter(i => i.priority === 'required' && i.status === 'missing');
  return { items: list, score, missingRequired };
}
