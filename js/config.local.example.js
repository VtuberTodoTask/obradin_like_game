// ローカル設定のひな形。
// このファイルを同じフォルダに「config.local.js」という名前でコピーし、API キーを書き込む。
// config.local.js は .gitignore で git 管理外になっているので、キーがコミットされることはない。
// ※ キーはブラウザ上の JS から送信される。このフォルダを公開サーバーに置かないこと。
window.ASARIYA_LOCAL = {
  openai: {
    apiKey: 'sk-ここにAPIキー',
    model: 'gpt-5-mini', // 文章の生成に使うモデル
    // verifyModel: 'gpt-5-mini', // 往復検証（事実の抽出）に使うモデル。省略すると model と同じ
    reasoningEffort: 'low', // 推論モデル用の設定。推論しないモデル（gpt-4.1 系など）を使う場合はこの行を消す
    concurrency: 4, // 同時に処理する主観ログの数
    repairRounds: 2, // 全文生成の不合格エントリを局所修正する回数。モデル設定はそのまま使う
    timeoutSec: 120, // 1回のリクエストの制限時間（秒）。超えたら打ち切って再送する
    autoNarrate: true, // シナリオ生成後に自動で LLM 文章化する
  },
};
