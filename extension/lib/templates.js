// 汎用ハーネスのテンプレート（用途別のベストプラクティス）。
// 中間表現（IR）の断片として持ち、LLMはこれを出発点にヒアリング回答に合わせて調整する。
// LLMに接続できないときは、このテンプレートだけでハーネスを生成できる。

export const USE_CASES = {
  dev: [
    { id: 'web', label: 'Web開発（フロントエンド・フルスタック）' },
    { id: 'backend', label: 'バックエンド・API開発' },
    { id: 'data', label: 'データ分析・SQL・バッチ処理' },
    { id: 'infra', label: 'インフラ・運用自動化・スクリプト' },
    { id: 'general-dev', label: 'その他の開発' },
  ],
  biz: [
    { id: 'docs', label: '文書作成（企画書・マニュアル・議事録）' },
    { id: 'report', label: '報告書・集計・データ整理' },
    { id: 'office', label: '定型事務（申請・帳票・メール対応）' },
    { id: 'research', label: '調査・比較検討' },
  ],
};

const COMMON_DEV = {
  rules: [
    { category: '進め方', rule: '大きな変更に着手する前に、変更方針と影響範囲を短く説明してから進める', reason: '手戻りを防ぐため' },
    { category: '進め方', rule: '既存のコードの書き方・命名・ディレクトリ構成に合わせる', reason: '一貫性を保つため' },
    { category: '品質', rule: '変更したらテスト・リント・型チェックを実行し、結果を報告する', reason: '動作を確認してから完了とするため' },
    { category: '品質', rule: '不明点や仕様の曖昧さは推測で埋めず、質問するか前提を明記する', reason: '誤った実装を防ぐため' },
  ],
  prohibitions: [
    { rule: '秘密情報（APIキー、パスワード、接続文字列）をコードやログに書かない', reason: '情報漏えいを防ぐため' },
    { rule: '依頼されていないファイルの大規模な書き換え・削除をしない', reason: '意図しない変更を防ぐため' },
    { rule: 'git push、本番環境へのデプロイ、データベースの破壊的操作を勝手に行わない', reason: '影響が大きく取り消せないため' },
  ],
  verification: [
    { name: 'テスト', how: 'プロジェクトのテストコマンドを実行し、失敗がないことを確認する' },
    { name: '差分の確認', how: '変更差分を見直し、不要な変更・デバッグ用コードが残っていないか確認する' },
  ],
  roles: [
    {
      id: 'code-reviewer', name: 'コードレビュー担当', readOnly: true,
      description: '変更差分をレビューし、不具合・可読性・セキュリティ上の問題を指摘する。実装後やPR作成前に使う',
      responsibilities: ['変更差分を読み、問題点を重要度順に指摘する', '修正案を具体的に示す'],
      checklist: ['仕様どおりに動くか', 'エラー処理・境界値', '命名と可読性', '秘密情報の混入', 'テストの有無'],
    },
  ],
  permissions: { level: 'standard', denyPaths: ['.env', '.env.*', 'secrets/', '*.pem', '*.key'], denyCommands: ['rm -rf', 'git push --force', 'git push -f'], allowCommands: [] },
};

const COMMON_BIZ = {
  rules: [
    { category: '進め方', rule: '作業前に目的・提出先・締め切りを確認し、不明なら質問する', reason: '手戻りを防ぐため' },
    { category: '品質', rule: '数値・日付・固有名詞は元資料と照合し、出典を示す', reason: '誤記を防ぐため' },
    { category: '文書', rule: '結論を先に書き、1文は短くする', reason: '読み手がすぐ判断できるようにするため' },
  ],
  prohibitions: [
    { rule: '個人情報・顧客情報を必要以上に転記・出力しない', reason: '情報保護のため' },
    { rule: '確認できない情報を事実として書かない', reason: '誤情報の拡散を防ぐため' },
    { rule: 'メール送信・申請の確定など、取り消せない操作を代行しない', reason: '最終確認は担当者が行うため' },
  ],
  verification: [
    { name: '元資料との照合', how: '数値・日付・固有名詞を元資料と突き合わせる' },
    { name: '体裁の確認', how: '表記ルール・テンプレートどおりになっているか確認する' },
  ],
  roles: [
    {
      id: 'document-checker', name: '提出前チェック担当', readOnly: true,
      description: '作成した文書を提出前に確認し、誤記・表記ゆれ・抜け漏れを指摘する',
      responsibilities: ['誤字脱字・表記ゆれを指摘する', '数値と元資料の不一致を指摘する', '読み手にとって分かりにくい箇所を指摘する'],
      checklist: ['結論が冒頭にあるか', '数値・日付の整合', '表記ルール', '個人情報の有無'],
    },
  ],
  permissions: { level: 'standard', denyPaths: ['.env', 'secrets/'], denyCommands: ['rm -rf'], allowCommands: [] },
};

const SPECIFIC = {
  web: {
    rules: [
      { category: 'フロントエンド', rule: 'UIを変更したら、表示崩れがないか主要な画面幅で確認する', reason: 'レイアウト崩れを防ぐため' },
      { category: 'フロントエンド', rule: 'アクセシビリティ（ラベル、代替テキスト、キーボード操作）を考慮する', reason: '誰でも使えるようにするため' },
    ],
    workflows: [
      { id: 'implement-feature', name: '機能追加', description: '新しい画面・機能を追加するときに使う',
        steps: ['要件と完成条件を確認する', '関連する既存コードを読み、変更箇所を洗い出す', '実装する', 'テストを追加・更新する', 'テスト・リントを実行し結果を報告する'],
        checks: ['既存の画面に影響がないか', 'テストが通るか'] },
      { id: 'fix-bug', name: '不具合修正', description: '不具合の調査と修正をするときに使う',
        steps: ['再現手順を確認する', '原因箇所を特定し、原因を説明する', '最小限の修正を行う', '再発防止のテストを追加する', 'テストを実行する'],
        checks: ['原因を説明できているか', '修正範囲が最小か'] },
    ],
  },
  backend: {
    rules: [
      { category: 'API', rule: 'APIの入出力（リクエスト・レスポンス形式）を変える場合は、互換性への影響を説明する', reason: '利用側の障害を防ぐため' },
      { category: 'データベース', rule: 'スキーマ変更はマイグレーションとして作成し、戻し方も用意する', reason: '安全に適用・切り戻しするため' },
    ],
    workflows: [
      { id: 'add-endpoint', name: 'APIの追加・変更', description: 'APIエンドポイントを追加・変更するときに使う',
        steps: ['仕様（入力・出力・エラー）を確認する', '既存のAPIの実装パターンを確認する', '実装する', '正常系・異常系のテストを書く', 'テストを実行する'],
        checks: ['入力値の検証', 'エラー時の応答', '認可の確認'] },
      { id: 'fix-bug', name: '不具合修正', description: '不具合の調査と修正をするときに使う',
        steps: ['ログや再現手順から原因を特定する', '原因を説明する', '最小限の修正を行う', '再発防止のテストを追加する', 'テストを実行する'],
        checks: ['原因を説明できているか'] },
    ],
  },
  data: {
    rules: [
      { category: 'SQL', rule: '本番データに対するクエリは、まず件数確認やLIMIT付きで実行する', reason: '負荷と誤操作を防ぐため' },
      { category: 'SQL', rule: 'UPDATE・DELETE・DDL は実行前に対象と件数を示し、確認を得る', reason: 'データ破損を防ぐため' },
      { category: '分析', rule: '集計結果には、使ったデータの範囲・条件・前提を必ず添える', reason: '結果を正しく解釈できるようにするため' },
    ],
    prohibitions: [
      { rule: '確認なしに本番データベースへ書き込み・削除をしない', reason: '取り消せないため' },
    ],
    workflows: [
      { id: 'write-query', name: 'SQLの作成', description: '集計・抽出のSQLを書くときに使う',
        steps: ['目的と出力イメージ（列・粒度）を確認する', '対象テーブルと結合条件を確認する', 'SQLを書く', '少量で実行して結果を検証する', 'SQLと結果の読み方を説明する'],
        checks: ['結合で行が重複していないか', 'NULLの扱い', '期間・条件の境界'] },
      { id: 'analyze-data', name: 'データ分析', description: 'データを集計・可視化して示唆を出すときに使う',
        steps: ['問いと判断したいことを確認する', 'データの欠損・外れ値を確認する', '集計・可視化する', '結果と限界を説明する'],
        checks: ['母数と条件が明記されているか'] },
    ],
  },
  infra: {
    rules: [
      { category: '運用', rule: '本番環境に影響するコマンドは、実行前に内容と影響範囲を示して確認を得る', reason: '障害を防ぐため' },
      { category: 'スクリプト', rule: 'スクリプトは何度実行しても同じ結果になるように書く（冪等性）', reason: '再実行で壊れないようにするため' },
    ],
    prohibitions: [
      { rule: 'クラウド資源の削除・停止、権限の変更を確認なしに行わない', reason: '影響が大きく取り消せないため' },
    ],
    workflows: [
      { id: 'write-script', name: '自動化スクリプトの作成', description: '運用作業を自動化するスクリプトを書くときに使う',
        steps: ['手作業の手順を確認する', 'ドライラン（確認だけするモード）を用意する', 'スクリプトを書く', 'ドライランで動作を確認する', '使い方を説明する'],
        checks: ['エラー時に途中で止まるか', 'ログが残るか'] },
    ],
  },
  'general-dev': {
    workflows: [
      { id: 'implement-change', name: '変更の実装', description: 'コードを追加・変更するときに使う',
        steps: ['依頼内容と完成条件を確認する', '関連コードを読む', '実装する', 'テストを実行する', '変更内容を報告する'],
        checks: ['テストが通るか'] },
    ],
  },
  docs: {
    rules: [
      { category: '文書', rule: '読み手と目的を最初に確認し、それに合わせて構成を決める', reason: '伝わる文書にするため' },
    ],
    workflows: [
      { id: 'write-document', name: '文書の作成', description: '企画書・マニュアル・報告書などを書くときに使う',
        steps: ['読み手・目的・分量を確認する', '構成案を作って確認する', '本文を書く', '提出前チェックを行う'],
        checks: ['結論が冒頭にあるか', '表記ルールどおりか'] },
      { id: 'write-minutes', name: '議事録の作成', description: '会議メモから議事録を作るときに使う',
        steps: ['会議名・日時・参加者を整理する', '決定事項・宿題（担当・期限）を抜き出す', '議論の要点をまとめる', '不明点を確認事項として残す'],
        checks: ['決定事項と担当・期限が明確か'] },
    ],
  },
  report: {
    rules: [
      { category: '集計', rule: '集計の条件・期間・母数を明記する', reason: '数字を正しく読めるようにするため' },
    ],
    workflows: [
      { id: 'create-report', name: '報告書・集計の作成', description: 'データを集計して報告書にまとめるときに使う',
        steps: ['報告の目的と読み手を確認する', 'データの範囲と条件を確認する', '集計する', '結論と根拠をまとめる', '数値を元データと照合する'],
        checks: ['数値の照合', '前回との比較の妥当性'] },
    ],
  },
  office: {
    rules: [
      { category: '事務', rule: '社内のテンプレート・記入例がある場合は必ずそれに従う', reason: '差し戻しを防ぐため' },
    ],
    workflows: [
      { id: 'prepare-form', name: '申請・帳票の作成', description: '申請書・帳票を作成するときに使う',
        steps: ['必要な情報と添付物を確認する', 'テンプレートに沿って作成する', '記入漏れ・計算をチェックする', '担当者に最終確認を依頼する'],
        checks: ['必須項目の記入', '金額・日付の整合'] },
      { id: 'draft-email', name: 'メール文面の作成', description: '社内外へのメールの下書きを作るときに使う',
        steps: ['相手・目的・期限を確認する', '要件を冒頭に書く', '下書きを作る（送信は担当者が行う）'],
        checks: ['宛先・敬語・添付の記載'] },
    ],
  },
  research: {
    rules: [
      { category: '調査', rule: '情報源を明記し、事実と推測を区別して書く', reason: '判断材料として信頼できるようにするため' },
    ],
    workflows: [
      { id: 'compare-options', name: '比較検討', description: '複数の選択肢を比較して推奨をまとめるときに使う',
        steps: ['比較の目的と評価軸を確認する', '各選択肢の情報を集める', '評価軸ごとに比較表を作る', '推奨と理由、懸念点をまとめる'],
        checks: ['評価軸が目的に合っているか', '情報源が示されているか'] },
    ],
  },
};

// 用途に応じたテンプレートIRを作る
export function templateIr({ workType, useCase, hearing = {} }) {
  const common = workType === 'biz' ? COMMON_BIZ : COMMON_DEV;
  const sp = SPECIFIC[useCase] || {};
  const name = hearing.projectName || '（プロジェクト名）';
  return {
    meta: { name, summary: hearing.purpose || '', language: hearing.language || 'ja', workType, mode: 'general', useCase },
    overview: { purpose: hearing.purpose || '', deliverables: splitLines(hearing.deliverables), audience: hearing.audience || '' },
    context: {
      techStack: splitLines(hearing.techStack),
      structure: '',
      commands: parseCommands(hearing.commands),
      glossary: [],
    },
    rules: [...common.rules, ...(sp.rules || [])],
    prohibitions: [...common.prohibitions, ...(sp.prohibitions || [])],
    workflows: [...(sp.workflows || [])],
    roles: [...common.roles],
    verification: [...common.verification],
    cautions: [],
    permissions: { ...common.permissions, level: hearing.caution || common.permissions.level },
  };
}

export function splitLines(s) {
  return String(s || '').split(/\r?\n|、|,/).map(x => x.trim()).filter(Boolean);
}

// 「テスト: npm test」のような行をコマンド一覧にする
export function parseCommands(s) {
  return String(s || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean).map(l => {
    const m = l.match(/^([^:：]+)[:：]\s*(.+)$/);
    return m ? { name: m[1].trim(), command: m[2].trim(), description: '' } : { name: l, command: l, description: '' };
  });
}
