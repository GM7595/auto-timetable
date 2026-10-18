# タイテ作成ツール

イベントの進行表を組み、当日の遅延・出演条件・時間短縮に合わせて調整案を比較する試作アプリです。Vinext / React、Cloudflare Worker、D1 / Drizzleを使用しています。

## チーム内の作業範囲

共有GitHub上の作業ディレクトリは `timetable-tool/` です。インストール・起動・テストはこのディレクトリ内で行います。他のメンバーの `tibo-reset/` などとは依存・設定・生成物を分離し、ルートにアプリ用のファイルを置きません。

所有者のローカルにある `../cue/` は、既存Sitesへの公開専用チェックアウトとして残しています。共有Gitでは管理しません。このディレクトリの `.openai/hosting.json` はローカル開発用の設定だけを持ち、既存公開先のIDや秘密情報を含みません。既存サイトへ反映するときは、公開用チェックアウトのSite設定を維持してソースを同期します。

## 表示設定

右上の歯車「表示・連携設定」→「表示モード」で、ライト・ダーク・端末に合わせるを選択できます。初期設定は端末に合わせるで、選択はブラウザ内に保存します。タイテやAPI設定には影響しません。

新しいイベントは上部の専用ボタン、イベント設定はイベント名の横の鉛筆、変更履歴はイベント情報の横から開きます。枠の追加とCSV・JSONの書き出しは進行表のツールバーにまとめています。

## ローカル起動

Node.js 22.13.0以上を使用し、このディレクトリで実行します。

```sh
npm run install:ci
npm run build
node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 execute DB --local --config dist/server/wrangler.json --persist-to .wrangler/state --file drizzle/0000_omniscient_tenebrous.sql
npm run dev
```

開発画面は通常 `http://127.0.0.1:5173` です。実際のURLは起動時の表示を確認してください。ビルド済みWorkerの確認には `npm start` を使います。

ローカルDBは `.wrangler/state` に保存されます。適用済みのSQLは再実行しません。スキーマ変更時は `npm run db:generate` で新しいSQLを生成し、再ビルド後に未適用のファイルを順に実行します。この操作が変更するのはローカルDBです。本番への反映はSitesの公開手順で行います。

```sh
npm run build
npm run lint
npx tsc --noEmit
node --experimental-strip-types --test lib/planner.test.ts
node --test lib/decisions.test.mjs lib/agent-proposals.test.mjs lib/dots-instructions.test.mjs lib/page.test.mjs lib/timetable.test.mjs lib/theme.test.mjs
```

Sitesプラグインを使う場合は、そのインストール・プレビュー・ビルド・公開の手順に従ってください。

## 保存とAPI

D1の `cue_event_state` テーブルに、イベント全体をJSONとして1件保存します。行IDは `primary` です。初回の読み込みでサンプルイベントを作成します。画面は接続できない場合に端末内の保存へ切り替わり、保存先を表示します。JSON / CSVの書き出しも利用できます。

| API | 入出力 |
| --- | --- |
| `GET /api/event` | `{ state, storage: "cloud", aiConfigured }` |
| `PUT /api/event` | 入力 `{ state, expectedRevision }`。保存後の `state` を返す |
| `POST /api/plans` | 入力 `{ state, text }`。`{ plans, issue, engine, aiStatus, elapsedMs, notice?, decisions? }` を返す |
| `POST /api/decisions/check` | 合成データで実APIに接続し、`{ configured, aiStatus, decisions?, notice? }` を返す。イベント情報は送信しない |
| `GET /api/agent` | 現在のイベントへのエージェント提案を直近5件取得する。進行表は変更しない |
| `GET /api/status` | Decisionsの設定有無、MCPの提供状態を返す。dots本体の稼働は観測できないため `dotsConnected: null` |

保存時は `state.revision` と `expectedRevision` に同じ、読み込み済みのバージョン番号を指定します。サーバーが原子的に比較し、成功時に1増やします。競合時は `409` と最新の `state` を返し、後から来た変更で上書きしません。

JSONの大きさ・枠数・文字数・時刻・IDの重複などをサーバーで検証します。ブラウザからの更新と提案リクエストには同一オリジンの確認を行います。解釈できない依頼や成立する案がない依頼は、説明付きの `422` になります。

入力例：`いまの進行が10分押しています`、`次の登壇者が15分遅れます`、`ライトニングトークは16:10まで出演できません`、`全体を10分短縮したい`。自由な日本語を何でも解釈する仕組みではなく、対象と時間が明確な変更に対応しています。

## 進行表のルール

- 転換時間は各枠の直前に確保します。先頭枠には転換を加算しません。
- 完了・進行中・固定された枠の開始時刻は `fixedStart` で保持し、提案の保存後にも同じ時刻を再現します。
- 出演可能な開始・終了時刻、会場の音止め、終演時刻を検証します。休憩以外の枠は音止め時間をまたがず、枠全体を後ろへ移します。
- 出演者が連続する場合の準備時間などは注意点として表示します。手動編集で成立しなくなった条件も隠しません。
- 案APIは重大な制約違反がなく、保存後も同じ開始・終了を再現する案だけを返します。画面も制約違反がある案の反映を拒否します。

時間の正しさは通常のコードで検証します。候補生成は最大800候補の決定的な探索で、同じ入力から同じ候補を作ります。すべての並び順を探索する最適化や、観客の満足度を予測する仕組みではありません。

## Decisions API

`OPENAI_API_KEY` がサーバーに設定されている場合、成立した案が複数あるときに、[Decisions API](https://developers.openai.com/api/docs/guides/decisions) の `gpt-6-luna` で有限の案IDから1つを選び、先頭に表示します。変更内容、出演者の準備、機材、メモ、構成を比較の材料にします。AIが時間制約を保証したり、新しい案を生成したりすることはありません。

キー未設定時は `engine: "rules"`、`aiStatus: "not-configured"` として動作します。拒否・タイムアウト・通信失敗・不正なIDの場合も、検証済みのルールによる順序へ切り替え、その理由を表示します。成立する案が1件だけの場合はAPIを呼びません。

「連携・保存」→「接続を確認」は、保存されたイベントを使わずに実APIへ小さな比較リクエストを送ります。キーの存在と接続成功を区別し、認証・権限・利用枠・レート制限・通信失敗を固定メッセージで表示します。実際に比較した場合はモデル名と所要時間、安全な診断情報を返します。上流のエラー本文や秘密情報は返さず、ログにも保存しません。キーを差し替えた場合は、新しい環境設定を反映するためSitesで再デプロイします。

設定名は `.env.example` に記載しています。実際のキーはSitesのサーバー用シークレットとして管理し、リポジトリやブラウザへ渡しません。キーがなくても進行表の編集とルールによる調整案は利用できます。

## dots / MCPと公開範囲

`POST /mcp` はステートレスなJSON-RPCで、MCP `2026-07-28` の `server/discover`、`tools/list`、`tools/call` に対応します。

- `get_event`：保存済みイベントと進行表を取得。
- `list_open_issues`：現在の制約違反・注意点を取得。
- `propose_change`：保存済みイベントへの変更案を取得。`applied: false` と元のバージョンを返し、イベントは変更しません。
- `get_agent_context`：最新のイベント・revision・変更履歴・保存済み提案・操作範囲を取得。
- `publish_change_proposal`：`{ text, expectedRevision, requestId }` を受け取り、コードで検証・Decisionsで比較した候補を提案として保存。進行表には適用しない。

`publish_change_proposal` の提案はD1の `cue_agent_proposal` に保存されます。作成前・作成後・書き込み時に進行表のrevisionとイベントIDを検査します。同一イベントの同じrequestId・内容・revisionは再試行しても同じ提案を返し、内容の異なる再利用は409にします。上限はイベントごとに100件で、自動削除しません。画面には直近5件が表示され、15秒ごとと画面に戻った時に取得します。古いrevisionへの提案は反映できません。

### dots側の初回設定

1. サイトの「表示・連携設定」→「連携・保存」→「dotsへの指示をコピー」。
2. 自分のdotの会話に貼り付ける。Sitesが用意したこのサイトのプラグインを使用する。ツールが見つからない場合はそのプラグインを接続する。
3. dotが `get_agent_context` で現在のイベントを確認する。以後、主催者から変更連絡を受けたら、内容を整理して `publish_change_proposal` でサイトに提案を保存する。
4. サイト上の「エージェントからの提案」から候補を比較し、主催者が反映する。

MCPツールはdots以外のエージェントでも使えます。MCPアクセスや提案の受信だけで「dots接続済み」「自動監視中」とは表示しません。dots本体で責任を割り当てる初回操作が必要です。外部メール・フォーム監視や定期実行は、対象と頻度の指定・必要な接続なしには開始しません。進行表の自動確定や第三者への通知機能もありません。これらを設定しない限り、dotsは会話で受けた変更連絡を処理する運用です。

公開先は所有者だけが利用する非公開Sitesを前提にします。ブラウザとMCPのアクセス制御にはSitesの認証境界を使い、1件のイベントを共有します。ユーザー別のデータ分離や公開閲覧者向けの権限設計はありません。URLをコピーしても他の人へアクセス権は付与されません。公開時はD1の `DB` バインド、マイグレーション、MCP機能をSites経由で設定してください。
