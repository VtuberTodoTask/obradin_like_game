// プレイ用 UI（設計書 §12.1-3）
//  資料の一覧と閲覧／ID の入力と解錠（伏せ字の一斉解除）／警戒度／最終回答と正誤判定
//  ＋ 開発用の検証器パネル（検証レポート・一括検証・JSON の入出力）
(function (A) {
  'use strict';
  const CFG = A.CONFIG;
  const { dayOf } = A.util;

  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const TOKEN_RE = /\{P:([A-D]-\d{2}-\d{2})\}/g;

  const S = {
    sc: null,
    report: null,
    source: 'gen',
    byId: new Map(),
    byTok: new Map(),
    unlocked: new Set(),
    unlockOrder: [],
    alert: 0,
    tried: [],
    memos: {},
    drafts: {}, pins: [], comparison: [], confirmed: {}, filters: { text: '', day: '' },
    disconnected: false, reconnections: 0,
    answers: { people: {}, verdict: { result: '', reasons: [] } },
    result: null,
    over: false,
    termLog: [],
    current: 'brief',
    selTok: null,
    justRevealed: null,
    narrating: null, // 実行中の LLM 文章化の AbortController
    llmRun: null, // LLM 文章化の一連の流れ（選択待ちを含む）が進行中なら非 null
    llmChoice: null, // 選択待ちのときの決定関数
    llmReport: null,
  };

  // ------------------------------------------------------------------ 起動・保存

  function boot() {
    const params = new URLSearchParams(location.search);
    const seed = Number(params.get('seed'));
    startSeed(params.get('scenario') === 'fixed' ? 730 : Number.isFinite(seed) && seed > 0 ? seed : randomSeed());
    bindStatic();
  }

  const randomSeed = () => Math.floor(Math.random() * 999999) + 1;

  function startSeed(seed) {
    let gen;
    try {
      const params = new URLSearchParams(location.search);
      gen = A.Generator.generate(seed, { fixed: params.get('scenario') === 'fixed',
        size: params.get('size') === 'large' ? 'large' : 'standard', mode: params.get('mode') === 'hard' ? 'hard' : 'standard' });
    } catch (e) {
      alert(e.message);
      return;
    }
    S.source = 'gen';
    setScenario(gen.scenario, gen.report);
    try {
      const params = new URLSearchParams(location.search); params.set('seed', seed);
      history.replaceState(null, '', `?${params}`);
    } catch (e) {
      /* file:// では失敗することがある */
    }
  }

  function setScenario(sc, report) {
    if (S.narrating) {
      S.narrating.abort();
      S.narrating = null;
    }
    if (S.llmChoice) S.llmChoice('later');
    S.llmRun = null;
    S.sc = sc;
    S.report = report;
    S.llmReport = null;
    if (A.LLM) A.LLM.applyCache(sc);
    S.byId = new Map(sc.residents.map((r) => [r.id, r]));
    S.byTok = new Map(sc.residents.map((r) => [r.token, r]));
    resetProgress();
    loadProgress();
    S.current = 'brief';
    renderAll();
    if (A.LLM && A.LLM.isConfigured() && A.LLM.settings().autoNarrate && A.LLM.pendingCount(sc) > 0) runNarration();
  }

  // ------------------------------------------------------------------ LLM による文章化

  // 文章化 → 検証に通らないエントリや通信エラーがあれば、さらに再検証するかテンプレート文を使うかを選ばせる
  async function runNarration() {
    if (S.llmRun || !A.LLM) return;
    const sc = S.sc;
    const run = {};
    S.llmRun = run;
    const dlg = $('#llmDlg');
    if (!dlg.open) dlg.showModal();
    renderTop();
    for (let pass = 1; ; pass++) {
      const out = await narrateOnce(sc, pass);
      if (S.sc !== sc || S.llmRun !== run) return;
      if (out.kind === 'done' || out.kind === 'aborted') break;
      const choice = await askLLMChoice(out);
      if (S.sc !== sc || S.llmRun !== run) return;
      if (choice === 'retry') continue;
      if (out.kind === 'unresolved') {
        A.LLM.useTemplate(sc, out.rep.unresolved);
        term('warn', `${out.rep.unresolved.length} 件のエントリはテンプレート文を使う`);
      } else {
        term('warn', '未処理のエントリはテンプレート文のまま（「LLMで文章化」で再開できる）');
      }
      break;
    }
    S.llmRun = null;
    if (dlg.open) dlg.close();
    saveProgress();
    renderAll();
  }

  async function narrateOnce(sc, pass) {
    const ac = new AbortController();
    S.narrating = ac;
    $('#llmTitle').textContent = pass > 1 ? `主観ログを再検証中（${pass}回目）` : '主観ログを復元中';
    $('#llmError').hidden = true;
    $('#btnLLMCancel').hidden = false;
    $('#btnLLMRetry').hidden = true;
    $('#btnLLMTemplate').hidden = true;
    $('#llmBar').style.width = '0%';
    $('#llmStatus').textContent = '準備中…';
    $('#llmActivity').textContent = '';
    // 応答待ちの間も動いていることが分かるよう、経過時間を毎秒表示する
    const started = Date.now();
    let last = null;
    const showActivity = () => {
      if (S.sc !== sc || !last) return;
      const secs = Math.round((Date.now() - started) / 1000);
      const parts = [last.event, `応答待ち ${last.inflight} 件`, `経過 ${secs} 秒`, `API ${last.calls} 回`];
      if (last.retries) parts.push(`再送 ${last.retries} 回（${last.lastIssue}）`);
      $('#llmActivity').textContent = parts.filter(Boolean).join(' ・ ');
    };
    const timer = setInterval(showActivity, 1000);
    try {
      const rep = await A.LLM.narrateScenario(sc, {
        signal: ac.signal,
        onProgress: (p) => {
          if (S.sc !== sc) return;
          last = p;
          $('#llmBar').style.width = `${p.totalEntries ? Math.round((100 * p.doneEntries) / p.totalEntries) : 100}%`;
          $('#llmStatus').textContent = `全文の生成・検証 ${p.doneEntries}/${p.totalEntries} 件`;
          showActivity();
        },
      });
      if (S.sc !== sc) return { kind: 'aborted' };
      S.llmReport = rep;
      term(
        rep.unresolved.length ? 'warn' : 'info',
        `LLM 文章化：${rep.llm}/${rep.entries} エントリ${rep.unresolved.length ? `・検証に通らない ${rep.unresolved.length} 件` : ''}・矛盾の指摘 ${rep.contradictions} 件・API ${rep.stats.calls} 回`,
      );
      if (rep.specErrors.length) {
        term('warn', `LLM文章化：検証不合格 ${rep.specErrors.length} 件をテンプレートへ戻した。シナリオの検証結果とは別。詳細は検証器の「LLM検証の指摘」。`);
      }
      return rep.unresolved.length ? { kind: 'unresolved', rep } : { kind: 'done', rep };
    } catch (e) {
      if (ac.signal.aborted) {
        if (S.sc === sc) term('warn', 'LLM 文章化を中断した（済んだ分は保存済み）');
        return { kind: 'aborted' };
      }
      if (S.sc === sc) term('err', `LLM 文章化に失敗：${e.message}`);
      return { kind: 'error', error: e };
    } finally {
      clearInterval(timer);
      if (S.narrating === ac) S.narrating = null;
      if (S.sc === sc) renderAll();
    }
  }

  function askLLMChoice(out) {
    const box = $('#llmError');
    const rounds = A.LLM.settings().maxRounds;
    if (out.kind === 'unresolved') {
      const list = out.rep.unresolved;
      $('#llmTitle').textContent = '検証に通らないエントリがあります';
      const items = list
        .map(
          (u) => `<li><span class="mono">${esc(u.timestamp)}</span> ${personHTML(u.owner)} の主観ログ
            <ul>${u.problems.map((p) => `<li>${rich(p)}</li>`).join('')}</ul>
            ${u.text ? `<div class="muted">最後の出力：${rich(u.text)}</div>` : ''}</li>`,
        )
        .join('');
      box.innerHTML = `<div class="banner">エラー：${list.length} 件のエントリが、${rounds} 回の再生成でも往復検証に通りませんでした。</div>
        <p>「さらに再検証する」は前回の指摘を添えて、もう一度最大 ${rounds} 回まで作り直します（API を呼びます）。
        「テンプレート文を使う」は、その ${list.length} 件だけ正しさが保証されたテンプレート文で確定します。</p>
        <details><summary>詳細（推理のネタバレを含む）</summary><ul class="llm-fail">${items}</ul></details>`;
      $('#btnLLMRetry').textContent = 'さらに再検証する';
      $('#btnLLMTemplate').textContent = 'テンプレート文を使う';
    } else {
      $('#llmTitle').textContent = '通信エラー';
      box.innerHTML = `<div class="banner">エラー：${esc(out.error.message)}</div>
        <p>合格した分は保存済み。「再試行する」で残りを続けます。テンプレート文で遊ぶ場合も、後で上部の「LLMで文章化」から再開できます。</p>`;
      $('#btnLLMRetry').textContent = '再試行する';
      $('#btnLLMTemplate').textContent = 'テンプレート文で遊ぶ';
    }
    box.hidden = false;
    $('#btnLLMCancel').hidden = true;
    $('#btnLLMRetry').hidden = false;
    $('#btnLLMTemplate').hidden = false;
    return new Promise((resolve) => {
      S.llmChoice = (c) => {
        S.llmChoice = null;
        resolve(c);
      };
    });
  }

  function resetProgress() {
    S.unlocked = new Set(S.sc.initial_known_ids);
    S.unlockOrder = [];
    S.alert = 0;
    S.tried = [];
    S.memos = {};
    S.drafts = {}; S.pins = []; S.comparison = []; S.confirmed = {};
    S.filters = { text: '', day: '' }; S.disconnected = false; S.reconnections = 0;
    S.answers = { people: {}, verdict: { result: '', reasons: [] } };
    S.result = null;
    S.over = false;
    S.termLog = [];
    S.selTok = null;
  }

  const storageKey = () => `asariya:v2:${S.source}:${S.sc.meta.version}:${S.sc.meta.fixed ? 'fixed' : S.sc.meta.seed}:${S.sc.meta.size}:${S.sc.meta.mode}:${A.util.scenarioFingerprint(S.sc)}`;

  function saveProgress() {
    try {
      localStorage.setItem(
        storageKey(),
        JSON.stringify(A.Investigation.serialize(S)),
      );
    } catch (e) {
      /* 保存できない環境では何もしない */
    }
  }

  function loadProgress() {
    let data = null;
    try {
      data = JSON.parse(localStorage.getItem(storageKey()) || 'null');
    } catch (e) {
      data = null;
    }
    if (!data) return;
    A.Investigation.restore(S, S.sc, data);
  }

  // ------------------------------------------------------------------ 表示の部品

  function personHTML(id) {
    const r = S.byId.get(id);
    if (!r) return esc(id);
    const sel = S.selTok === r.token ? ' sel' : '';
    const rev = S.justRevealed === r.token ? ' reveal' : '';
    if (S.unlocked.has(id)) return `<span class="tok known${sel}${rev}" data-tok="${r.token}" title="${r.id}">${esc(r.name)}</span>`;
    const nickname = S.drafts[r.token]?.nickname;
    return `<span class="tok masked${sel}" data-tok="${r.token}" title="未解読の人物">${nickname ? esc(nickname) + ' ' : ''}⟨${r.token}⟩</span>`;
  }
  const rich = (text) => esc(text).replace(TOKEN_RE, (m, id) => personHTML(id));
  const labelOf = (r) => (S.unlocked.has(r.id) ? `${r.name}（${r.id}）` : `${S.drafts[r.token]?.nickname || ''}⟨${r.token}⟩`);
  const jobLabel = (code) => `${code} ${CFG.jobByCode[code].name}`;
  const lastEntry = (id) => {
    const es = S.sc.documents.chip_logs[id] || [];
    return es[es.length - 1];
  };

  function readableDocs() {
    const docs = [{ key: 'dialogue' }, { key: 'hatch' }];
    for (const id of S.unlocked) docs.push({ key: `log:${id}` });
    return docs;
  }

  // 閲覧可能な資料に現れる人物トークンと、その出現箇所
  function occurrences() {
    const map = new Map();
    const add = (id, doc, idx, when) => {
      const r = S.byId.get(id);
      if (!r) return;
      if (!map.has(r.token)) map.set(r.token, []);
      map.get(r.token).push({ doc, idx, when });
    };
    const scan = (text, doc, idx, when) => {
      for (const m of text.matchAll(TOKEN_RE)) add(m[1], doc, idx, when);
    };
    const D = S.sc.documents;
    D.counselor_dialogues.forEach((e, i) => {
      e.lines.forEach((l) => {
        if (l.speaker !== 'AI' && l.speaker) add(l.speaker, 'dialogue', i, e.timestamp);
        scan(l.text, 'dialogue', i, e.timestamp);
      });
    });
    D.hatch_log.forEach((h, i) => h.auth && add(h.auth, 'hatch', i, h.timestamp));
    for (const id of S.unlocked) {
      (D.chip_logs[id] || []).forEach((e, i) => !e.deleted && scan(e.text, `log:${id}`, i, e.timestamp));
    }
    D.overview.counselors.forEach((id) => add(id, 'overview', 0, '概要'));
    return map;
  }

  function docTitle(key) {
    if (key === 'brief') return '漁り屋の手引き';
    if (key === 'overview') return 'シェルター概要';
    if (key === 'jobs') return '職能コード表';
    if (key === 'hatch') return '外部ハッチ開閉記録';
    if (key === 'dialogue') return '相談役と管理AIの会話ログ';
    if (key === 'timeline') return '時系列・資料比較';
    if (key.startsWith('log:')) {
      const r = S.byId.get(key.slice(4));
      return `主観ログ：${r.name}`;
    }
    return key;
  }

  // ------------------------------------------------------------------ 描画

  function renderAll() {
    renderTop();
    renderDocList();
    renderViewer();
    renderTerminal();
    renderPeople();
  }

  function renderTop() {
    const sc = S.sc;
    $('#connInfo').innerHTML =
      `接続先 <b>${esc(sc.shelter.name)}</b> ／ 現在時刻 <b>D${String(sc.shelter.now_day).padStart(2, '0')}</b> ／ ` +
      `シード <b>${esc(sc.meta.seed)}</b>${S.source === 'json' ? '（JSON）' : ''}`;
    const pips = [];
    for (let i = 0; i < CFG.alertMax; i++) pips.push(`<span class="pip${i < S.alert ? ' on' : ''}"></span>`);
    $('#alertMeter').innerHTML = `警戒度 ${pips.join('')}`;
    $('#btnAnswer').textContent = S.result ? '結果を見る' : '最終回答';
    const configured = A.LLM && A.LLM.isConfigured();
    const cnt = A.LLM ? A.LLM.countEntries(sc) : { total: 0, llm: 0, pending: 0 };
    $('#narrInfo').innerHTML = cnt.llm
      ? `文章 <span class="llm">LLM ${cnt.llm}/${cnt.total}</span>`
      : `文章 テンプレート${configured ? '' : '（API キー未設定）'}`;
    if (cnt.template) $('#narrInfo').innerHTML += ` ／ <span class="fallback">検証不合格・復帰 ${cnt.template}件</span>`;
    $('#btnLLM').hidden = !configured || cnt.pending === 0 || !!S.llmRun;
  }

  function renderDocList() {
    const sc = S.sc;
    const now = sc.shelter.now_day;
    const base = ['brief', 'overview', 'jobs', 'hatch', 'dialogue', 'timeline'];
    const btn = (key, label, meta, extra = '') =>
      `<button class="doc${S.current === key ? ' active' : ''}${extra}" data-doc="${key}">${label}${meta ? `<span class="meta">${meta}</span>` : ''}</button>`;
    let html = `<div class="doc-group"><h3>資料</h3>${base.map((k) => btn(k, docTitle(k))).join('')}</div>`;
    const ids = sc.initial_known_ids.concat(S.unlockOrder.filter((id) => !sc.initial_known_ids.includes(id)));
    html += `<div class="doc-group"><h3><span>主観ログ</span><span>${S.unlocked.size}/${sc.residents.length} 解読</span></h3>`;
    for (const id of ids) {
      const r = S.byId.get(id);
      const last = lastEntry(id);
      const live = last && dayOf(last.t) >= now;
      const meta = `${id} ・ 最終更新 ${last ? `<span class="${live ? 'live' : ''}">${last.timestamp}</span>` : '—'}`;
      html += btn(`log:${id}`, esc(r.name), meta, S.justRevealed === r.token ? ' new' : '');
    }
    html += '</div>';
    $('#docList').innerHTML = html;
  }

  function renderViewer() {
    const key = S.current;
    let html;
    if (key === 'brief') html = viewBrief();
    else if (key === 'overview') html = viewOverview();
    else if (key === 'jobs') html = viewJobs();
    else if (key === 'hatch') html = viewHatch();
    else if (key === 'dialogue') html = viewDialogue();
    else if (key === 'timeline') html = viewTimeline();
    else html = viewLog(key.slice(4));
    $('#viewer').innerHTML = html;
  }

  function viewBrief() {
    const sc = S.sc;
    return `<div class="prose">
      <h1 class="doc-title">漁り屋の手引き</h1>
      <p class="doc-sub">接続先：${esc(sc.shelter.name)}</p>
      <p>連絡が途絶えたシェルターの管理AIに接続した。君は漁り屋だ。抜き出したデータを読み解き、このシェルターが<b>探索するのに安全かどうか</b>を判定してほしい。</p>
      <h3>やること</h3>
      <ol>
        <li>全住人の身元（ID と名前の対応）を突き止める</li>
        <li>死者それぞれの死因と、殺人なら加害者を特定する</li>
        <li>生存者がいるかどうかを見極める</li>
        <li>シェルターの安全判定を下す（右上の「最終回答」）</li>
      </ol>
      <h3>ID と伏せ字</h3>
      <p>住人の ID は <code>区画-入居順-職能コード</code>（例 <code>C-07-31</code>）。管理AIはログの人名を ID に置き換えて保存しているため、解読していない人物は <span class="tok masked">⟨x9Kq⟩</span> のような<b>伏せ字</b>で表示される。同じ伏せ字は常に同じ人物を指す。</p>
      <p>右の「ID 認証」に正しい ID を入力すると、その人物の<b>主観ログ</b>が開き、全資料の伏せ字が名前に置き換わる。認証はその ID の存在を確かめるもので、選択人物との対応は別に確認する。誤った ID は警戒度を上げる。${S.sc.meta.mode === 'hard' ? 'ハードモードでは上限で接続を遮断し、真相を開示する。' : '上限では認証だけを一時停止する。資料とメモは残り、「再接続」ですぐ再開できる。'}同じ拒否済み ID と形式エラーには追加加算しない。</p>
      <ul>
        <li><b>区画</b>：住んでいる区画。</li>
        <li><b>入居順</b>：シェルター全体での通し番号。受付の記録は連続し、欠番はない。同じ番号の住人は二人といない。</li>
        <li><b>職能</b>：仕事の内容から読み取る。対応は「職能コード表」を参照。</li>
      </ul>
      <p>身なりの支給規則、入居の前後、専任資格、道具の受領と操作を照合して身元を調べる。素性が分かった人の記録を開くと、既読の発言の意味が変わる場合がある。番号が見える例も入口として少数残されている。</p>
      <ul>
      </ul>
      <h3>資料の性質</h3>
      <ul>
        <li><b>主観ログ</b>には感覚、考え、他人の発言が混じる。暗さや距離、他資料との一致を調べる。確信している証言が誤り、不確かな証言が正しい場合もある。身体の死と、チップの最終更新は区別する。</li>
        <li><b>生存者のログは現在まで更新され続けている</b>。最終更新の時刻に注意。</li>
        <li>相談役と管理AIの会話や、管理AIに登録された<b>公式記録は改ざん・偽装されうる</b>。</li>
        <li>チップは住人の脳内にあるが、取り出して別人に移すこともできるという噂がある。一人称や口癖などの<b>語り口</b>は人によって違う。</li>
        <li>外部ハッチの開閉記録は管理AIが機械的に残したもので、改ざんされていない。</li>
      </ul>
      <h3>安全判定のルール</h3>
      <table class="kv">
        <tr><th>身内同士の殺し合いで、全員死亡または生存者に加害者がいない</th><td>安全</td></tr>
        <tr><th>加害者が生き延びて潜伏している</th><td>危険（潜伏者）</td></tr>
        <tr><th>感染症による死者がいる</th><td>危険（感染）</td></tr>
        <tr><th>被曝による死者がいる</th><td>危険（汚染）</td></tr>
        <tr><th>侵入者がまだ中に残っている</th><td>危険（侵入者）</td></tr>
        <tr><th>飢餓（物資が尽きている）</th><td>価値なし</td></tr>
      </table>
      <p>死因が混在するときは <b>危険 ＞ 価値なし ＞ 安全</b> の順に優先する。危険の理由が複数あればすべて挙げること。</p>
      <h3>操作</h3>
      <ul>
        <li>伏せ字や名前をクリックすると、同じ人物がすべて強調され、右の人物索引にメモと出現箇所が表示される。</li>
        <li>人物の仮の名前・身元候補・回答の下書き・根拠を保存できる。各記録の「ピン留め」で時系列と2件の資料比較へ送れる。</li>
        <li>標準モードでは「最終回答」の途中確認で、正しい回答が${CFG.investigation.confirmGroup}人分そろうとまとめて確定する。項目ごとの正誤は表示しない。</li>
        <li>進行状況と調査メモはこのブラウザに自動保存される。</li>
      </ul>
    </div>`;
  }

  function viewOverview() {
    const sc = S.sc;
    const o = sc.documents.overview;
    const gaps = o.max_entry - o.resident_count;
    return `<h1 class="doc-title">シェルター概要</h1>
      <p class="doc-sub">管理AI 抽出データ</p>
      <table class="kv">
        <tr><th>名称</th><td>${esc(o.shelter_name)}</td></tr>
        <tr><th>区画</th><td>${o.districts.join('、')}</td></tr>
        <tr><th>登録住人数（チップ保有者）</th><td>${o.resident_count} 名</td></tr>
        <tr><th>入居番号</th><td>01 〜 ${String(o.max_entry).padStart(2, '0')}（最新の入居者は ${o.max_entry} 番。現在の登録者 ${o.resident_count} 名${gaps ? `、欠番 ${gaps}` : ''}）</td></tr>
        <tr><th>相談役</th><td>${o.counselors.map((id) => `${personHTML(id)} <span class="mono muted">${id}</span>`).join('<br>')}</td></tr>
        <tr><th>記録期間</th><td>D01 〜 D${String(o.now_day).padStart(2, '0')}（現在）</td></tr>
      </table>
      <p class="muted">相談役の ID は管理AIの公開情報として最初から判明している。ここが推理の入口になる。</p>
      <h3>支給品と受付の規定</h3><p>${esc(sc.publicCulture.text)}</p>`;
  }

  function viewJobs() {
    const rows = S.sc.documents.job_code_table.map((j) => `<tr><td class="num">${j.code}</td><td>${esc(j.category)}</td><td>${esc(j.name)}</td></tr>`).join('');
    return `<h1 class="doc-title">職能コード表</h1>
      <p class="doc-sub">同じ職能を複数人が持つことがある</p>
      <table class="data"><tr><th>コード</th><th>分類</th><th>職能</th></tr>${rows}</table>`;
  }

  function viewHatch() {
    const rows = S.sc.documents.hatch_log
      .map(
        (h, i) =>
          `<tr data-entry="${i}"><td class="num">${h.timestamp}</td><td>${h.side === 'inside' ? '内側から開放' : '外側から開放'}</td>` +
          `<td>${h.auth ? personHTML(h.auth) : '<span class="bad">なし（強制開放）</span>'}${pinButton('hatch', i)}</td></tr>`,
      )
      .join('');
    return `<h1 class="doc-title">外部ハッチ開閉記録</h1>
      <p class="doc-sub">管理AIが自動記録 ・ 認証にはチップを使う</p>
      <p>出入口はこのハッチだけ。認証なしの開放一回で一人だけ通る。外側からなら入場、内側からなら退場。住人のチップ認証による通過とは区別する。</p>
      ${rows ? `<table class="data"><tr><th>時刻</th><th>操作</th><th>認証</th></tr>${rows}</table>` : '<p class="muted">記録期間中の開閉はない。</p>'}`;
  }

  function viewDialogue() {
    const es = S.sc.documents.counselor_dialogues
      .map((e, i) => {
        const lines = e.lines
          .map((l) => {
            const ai = l.speaker === 'AI';
            return `<div class="dlg-line${ai ? ' ai' : ''}"><span class="who">${ai ? '管理AI' : personHTML(l.speaker)}</span><span>${rich(l.text)}</span></div>`;
          })
          .join('');
        return `<div class="entry" data-entry="${i}"><div class="entry-head">${e.timestamp}${pinButton('dialogue', i)}</div><div class="entry-text">${lines}</div></div>`;
      })
      .join('');
    return `<h1 class="doc-title">相談役と管理AIの会話ログ</h1><p class="doc-sub">相談役だけが管理AIと対話できる</p>${es}`;
  }

  function viewLog(id) {
    const r = S.byId.get(id);
    const es = S.sc.documents.chip_logs[id] || [];
    const last = es[es.length - 1];
    const body = es
      .map((e, i) => {
        if (e.deleted) {
          return `<div class="entry deleted" data-entry="${i}"><div class="entry-head">${e.timestamp}</div><div class="entry-text">▓▓▓ この記録は削除されています ▓▓▓</div></div>`;
        }
        const emo = e.emotion ? `<span class="emo ${e.emotion}">${CFG.emotions[e.emotion] || e.emotion}</span>` : '';
        return `<div class="entry" data-entry="${i}"><div class="entry-head">${e.timestamp}${emo}${pinButton('log:' + id, i)}</div><div class="entry-text">${rich(e.text)}</div>${e.machineText ? `<div class="machine-record"><b>医療端末の自動付記</b><div class="entry-text">${rich(e.machineText)}</div></div>` : ''}</div>`;
      })
      .join('');
    return `<h1 class="doc-title">${personHTML(id)} の主観ログ</h1>
      <p class="doc-sub">ID <b>${id}</b> ・ 区画 <b>${r.district}</b> ・ 入居順 <b>${r.entry_order}</b> ・ 職能 <b>${jobLabel(r.job_code)}</b> ・ 最終更新 <b>${last ? last.timestamp : '—'}</b></p>
      ${body}`;
  }

  function renderTerminal() {
    $('#termLog').innerHTML = S.termLog
      .slice(0, 8)
      .map((m) => `<li class="${m.kind}">${esc(m.text)}</li>`)
      .join('');
    $('#idInput').disabled = S.over || S.disconnected;
    $('#btnReconnect').hidden = !S.disconnected || S.over;
  }

  function renderPeople() {
    const occ = occurrences();
    const toks = [...occ.keys()].sort((a, b) => {
      const ra = S.byTok.get(a);
      const rb = S.byTok.get(b);
      const ka = S.unlocked.has(ra.id);
      const kb = S.unlocked.has(rb.id);
      if (ka !== kb) return ka ? -1 : 1;
      return ka ? ra.id.localeCompare(rb.id) : occ.get(b).length - occ.get(a).length;
    });
    $('#peopleCount').textContent = `${toks.length}人を確認`;
    $('#tokGrid').innerHTML = toks
      .map((t) => {
        const r = S.byTok.get(t);
        return personHTML(r.id).replace('class="tok', `class="tok${S.memos[t] ? ' has-memo' : ''}`);
      })
      .join('');
    const sel = S.selTok && S.byTok.get(S.selTok);
    if (!sel) {
      $('#tokDetail').innerHTML = '<p class="hint">伏せ字や名前をクリックすると、メモと出現箇所が表示される。</p>';
      return;
    }
    const list = (occ.get(S.selTok) || [])
      .map((o) => `<li data-doc="${o.doc}" data-idx="${o.idx}"><span class="when">${esc(o.when)}</span>${esc(docTitle(o.doc))}</li>`)
      .join('');
    const draft = S.drafts[S.selTok] || {};
    const answer = S.answers.people[S.selTok] || {};
    const fields = [['nickname', '仮の名前'], ['district', '区画候補'], ['order', '入居順候補'], ['job', '職能候補']]
      .map(([key, label]) => `<label>${label}<input data-draft="${key}" value="${esc(draft[key] || '')}" maxlength="60" placeholder="自分の推測"></label>`).join('');
    const opts = (map, value) => `<option value="">未記入</option>` + Object.entries(map).map(([v, label]) => `<option value="${esc(v)}"${v === value ? ' selected' : ''}>${esc(label)}</option>`).join('');
    const killers = Object.fromEntries([...occ.keys()].map((tok) => [tok, labelOf(S.byTok.get(tok))]));
    const refs = (draft.evidence || []).map((r) => {
      const item = visibleEntries().find((e) => e.ref === r);
      return item ? `<li><button class="btn ghost" data-jump="${esc(r)}">${esc(item.timestamp)} ${esc(docTitle(item.doc))}</button></li>` : '';
    }).join('');
    $('#tokDetail').innerHTML = `
      <div class="head"><b>${personHTML(sel.id)}</b><span class="id">${S.unlocked.has(sel.id) ? sel.id : '未解読'}</span></div>
      <div class="hypotheses">${fields}
        <label>生死候補<select data-hypothesis="status"${S.confirmed[S.selTok] ? ' disabled' : ''}>${opts({ alive: '生存', dead: '死亡' }, answer.status)}</select></label>
        <label>死因候補<select data-hypothesis="cause"${S.confirmed[S.selTok] ? ' disabled' : ''}>${opts(CFG.causes, answer.cause)}</select></label>
        <label>加害者候補<select data-hypothesis="killer"${S.confirmed[S.selTok] ? ' disabled' : ''}>${opts(killers, answer.killer)}</select></label>
      </div><p class="hint">候補は自分の推測。生死・死因・加害者の下書きは最終回答と共通。</p>
      <textarea id="memo" placeholder="推理メモ（区画・入居順・職能の候補など）">${esc(S.memos[S.selTok] || '')}</textarea>
      <h4>保存した根拠</h4><ul>${refs || '<li>各記録の「この人物の根拠へ」で紐付ける。</li>'}</ul>
      <ul class="occ">${list || '<li>閲覧中の資料には出てこない</li>'}</ul>`;
  }

  // 時系列・比較はこの一覧だけを使う。未解読資料の件数・時刻・writer・場面名を読まない。
  function visibleEntries() {
    const out = [];
    const add = (doc, es) => es.forEach((e, i) => {
      if (e.deleted) return;
      const text = doc === 'dialogue' ? e.lines.map((l) => `${l.speaker === 'AI' ? '管理AI' : labelOf(S.byId.get(l.speaker))}：${l.text}`).join('\n') : e.text + (e.machineText ? `\n【医療端末の自動付記】${e.machineText}` : '');
      const visibleText = text.replace(TOKEN_RE, (_, id) => {
        const r = S.byId.get(id);
        return r ? `${labelOf(r)} ${S.drafts[r.token]?.nickname || ''}` : '未登録の人物';
      });
      out.push({ ref: `${doc}#${i}`, doc, index: i, t: e.t, timestamp: e.timestamp, text, visibleText });
    });
    add('dialogue', S.sc.documents.counselor_dialogues);
    add('hatch', S.sc.documents.hatch_log);
    for (const id of S.unlocked) add(`log:${id}`, S.sc.documents.chip_logs[id] || []);
    return out.sort((a, b) => a.t - b.t);
  }
  function pinButton(doc, i) {
    const ref = `${doc}#${i}`;
    return `<span class="entry-actions"><button class="btn ghost" data-pin="${esc(ref)}">${S.pins.includes(ref) ? 'ピン解除' : 'ピン留め'}</button>${S.selTok ? `<button class="btn ghost" data-evidence="${esc(ref)}">この人物の根拠へ</button>` : ''}</span>`;
  }
  function viewTimeline() {
    const entries = visibleEntries();
    const search = (S.filters.text || '').trim().toLocaleLowerCase();
    const filtered = entries.filter((e) => (!search || e.visibleText.toLocaleLowerCase().includes(search)) && (!S.filters.day || UDay(e.t) === Number(S.filters.day)));
    const pinned = entries.filter((e) => S.pins.includes(e.ref));
    const card = (e) => `<article class="entry"><div class="entry-head">${esc(e.timestamp)}${pinButton(e.doc, e.index)}</div>
      <button class="btn ghost" data-jump="${esc(e.ref)}">${esc(docTitle(e.doc))}へ戻る</button><div class="entry-text">${rich(e.text)}</div></article>`;
    const selected = S.comparison.map((ref) => pinned.find((e) => e.ref === ref)).filter(Boolean).slice(0, 2);
    const options = '<option value="">資料を選ぶ</option>' + pinned.map((e) => `<option value="${esc(e.ref)}">${esc(e.timestamp + ' ' + docTitle(e.doc))}</option>`).join('');
    const selector = (i) => `<select data-compare="${i}">${options.replace(`value="${esc(S.comparison[i] || '')}"`, `value="${esc(S.comparison[i] || '')}" selected`)}</select>`;
    return `<h1 class="doc-title">時系列・資料比較</h1><p>閲覧できる資料だけを表示。仮の名前や人物の伏せ字でも検索できる。</p>
      <div class="timeline-filters"><label>人物・仮の名前・文章<input id="timelineText" value="${esc(S.filters.text)}" placeholder="表示中の文章を検索"></label>
        <label>日付<input id="timelineDay" type="number" min="1" value="${esc(S.filters.day)}" placeholder="全日"></label><button class="btn" id="btnFilter">絞り込む</button></div>
      <h3>ピン留めした2件を比較</h3><div class="compare-select">${selector(0)}${selector(1)}</div>
      <div class="comparison">${selected.map(card).join('') || '<p class="hint">各資料のピン留めから比較する記録を選ぶ。</p>'}</div>
      <details><summary>ピン留め一覧（${pinned.length}件）</summary>${pinned.map(card).join('')}</details>
      <h3>閲覧できる時系列（${filtered.length}件）</h3>${filtered.map(card).join('')}`;
  }
  const UDay = (t) => A.util.dayOf(t);
  function jumpTo(ref) {
    const item = visibleEntries().find((e) => e.ref === ref);
    if (item) openDoc(item.doc, item.index);
  }

  // ------------------------------------------------------------------ 操作

  function openDoc(key, idx) {
    if (key.startsWith('log:') && !S.unlocked.has(key.slice(4))) return;
    S.current = key;
    renderDocList();
    renderViewer();
    const v = $('#viewer');
    if (idx == null) {
      v.scrollTop = 0;
      return;
    }
    const el = $(`[data-entry="${idx}"]`, v);
    if (el) {
      el.scrollIntoView({ block: 'center' });
      el.classList.add('flash');
    }
  }

  function term(kind, text) {
    S.termLog.unshift({ kind, text });
  }

  function normalizeId(raw) {
    return A.Investigation.normalizeId(raw);
  }

  function tryUnlock(raw) {
    const result = A.Investigation.authenticate(S, S.sc, raw);
    S.justRevealed = null;
    if (result.kind === 'success') {
      const r = S.byId.get(result.id);
      S.justRevealed = r.token;
      term('ok', `認証成功：${result.id} → ${r.name}（⟨${r.token}⟩）`);
      if (result.mismatch) term('warn', '認証されたのは選択中の人物とは別のトークン。人物の下書きとの対応を見直してください。');
      S.current = `log:${result.id}`;
    } else if (result.kind === 'known') {
      term('info', `${result.id} は解読済み`); S.current = `log:${result.id}`;
    } else if (result.kind === 'format') term('warn', '形式または公開された区画・番号範囲・職能コードに合わないため送信していない。');
    else if (result.kind === 'repeated') term('warn', '拒否済みの ID。警戒度は変わらない。');
    else if (result.kind === 'rejected') term('err', `認証失敗：${result.id}。警戒度 ${S.alert}/${CFG.alertMax}`);
    else if (result.kind === 'disconnected') term('warn', '認証を再開するには再接続してください。');
    if (S.disconnected) term('info', '認証を一時停止。資料とメモは保持。「再接続」で再開できる。');
    saveProgress(); renderAll();
    if (S.over && !S.result) showResult();
  }

  function selectToken(tok) {
    S.selTok = S.selTok === tok ? null : tok;
    $$('.tok').forEach((el) => el.classList.toggle('sel', !!S.selTok && el.dataset.tok === S.selTok));
    renderPeople();
    if (S.selTok) {
      const draft = S.drafts[S.selTok] || {};
      if (draft.district && draft.order && draft.job) $('#idInput').value = `${draft.district}-${draft.order}-${draft.job}`;
      else $('#idInput').value = '';
    }
    saveProgress();
  }

  // ------------------------------------------------------------------ 最終回答

  function openAnswer() {
    if (S.result || S.over) {
      showResult();
      return;
    }
    const sc = S.sc;
    const rows = sc.residents.slice().sort((a, b) => {
      const ka = S.unlocked.has(a.id);
      const kb = S.unlocked.has(b.id);
      if (ka !== kb) return ka ? -1 : 1;
      return ka ? a.id.localeCompare(b.id) : a.token.localeCompare(b.token);
    });
    const opt = (v, label, cur) => `<option value="${v}"${v === cur ? ' selected' : ''}>${esc(label)}</option>`;
    const killerOpts = (cur) => opt('', '—', cur) + rows.map((r) => opt(r.token, labelOf(r), cur)).join('');
    const html = rows
      .map((r) => {
        const a = S.answers.people[r.token] || {};
        const causeOpts = opt('', '—', a.cause) + Object.entries(CFG.causes).map(([k, v]) => opt(k, v, a.cause)).join('');
        const fixed = S.confirmed[r.token] ? ' disabled' : '';
        return `<tr data-tok="${r.token}"${fixed ? ' class="confirmed"' : ''}>
          <td>${personHTML(r.id)}${S.unlocked.has(r.id) ? ` <span class="mono muted">${r.id}</span>` : ''}</td>
          <td><select data-f="status"${fixed}>${opt('', '—', a.status)}${opt('alive', '生存', a.status)}${opt('dead', '死亡', a.status)}</select>${fixed ? '確定' : ''}</td>
          <td><select data-f="cause"${fixed || (a.status === 'dead' ? '' : ' disabled')}>${causeOpts}</select></td>
          <td><select data-f="killer"${fixed || (a.status === 'dead' && a.cause === 'murder' ? '' : ' disabled')}>${killerOpts(a.killer)}</select></td>
        </tr>`;
      })
      .join('');
    $('#answerTable').innerHTML = `<tr><th>人物</th><th>状態</th><th>死因</th><th>加害者（殺人の場合）</th></tr>${html}`;

    const v = S.answers.verdict;
    const radio = (k, label) => `<label><input type="radio" name="verdict" value="${k}"${v.result === k ? ' checked' : ''}> ${label}</label>`;
    const reasons = CFG.verdict.reasons
      .map((x) => `<label><input type="checkbox" name="reason" value="${x}"${v.reasons.includes(x) ? ' checked' : ''}${v.result === 'danger' ? '' : ' disabled'}> ${x}</label>`)
      .join('');
    $('#verdictBox').innerHTML = `<legend>安全判定</legend>${radio('safe', '安全')}${radio('danger', '危険')}${radio('worthless', '価値なし')}<div class="reasons">危険の理由：${reasons}</div>`;
    $('#btnConfirm').hidden = S.sc.meta.mode === 'hard';
    $('#btnConfirm').textContent = `${CFG.investigation.confirmGroup}人まとめて途中確認`;
    if (!$('#answerDlg').open) $('#answerDlg').showModal();
  }

  function onAnswerChange(e) {
    const tr = e.target.closest('tr[data-tok]');
    if (tr) {
      if (S.confirmed[tr.dataset.tok]) return;
      const a = (S.answers.people[tr.dataset.tok] = S.answers.people[tr.dataset.tok] || {});
      a[e.target.dataset.f] = e.target.value;
      const cause = $('select[data-f="cause"]', tr);
      const killer = $('select[data-f="killer"]', tr);
      cause.disabled = a.status !== 'dead';
      killer.disabled = a.status !== 'dead' || a.cause !== 'murder';
    } else if (e.target.name === 'verdict') {
      S.answers.verdict.result = e.target.value;
      $$('input[name="reason"]').forEach((cb) => (cb.disabled = e.target.value !== 'danger'));
    } else if (e.target.name === 'reason') {
      S.answers.verdict.reasons = $$('input[name="reason"]:checked').map((cb) => cb.value);
    }
    saveProgress();
  }

  function confirmAnswers() {
    const group = A.Investigation.confirmBatch(S, S.sc);
    $('#confirmStatus').textContent = group.length ? `${group.length}人分の回答が確定した。` : '今回はまとまった確定なし。';
    saveProgress(); openAnswer(); renderPeople();
  }

  function submitAnswer() {
    const v = S.answers.verdict;
    if (!v.result) {
      alert('安全判定を選んでください。');
      return;
    }
    if (!confirm('この内容で提出しますか？ 提出すると真相が開示されます。')) return;
    S.result = grade();
    S.over = true;
    saveProgress();
    $('#answerDlg').close();
    renderAll();
    showResult();
  }

  function grade() {
    const sc = S.sc;
    const deathOf = new Map(sc.deaths.map((d) => [d.victim, d]));
    const rows = sc.residents.map((r) => {
      const a = S.answers.people[r.token] || {};
      const d = deathOf.get(r.id);
      const identity = S.unlocked.has(r.id);
      const status = a.status === r.status;
      const cause = r.status === 'dead' ? status && a.cause === d.cause : status;
      const killer = d && d.cause === 'murder' ? cause && a.killer === S.byId.get(d.killer).token : cause;
      return { id: r.id, identity, status, cause, killer, ok: identity && status && cause && killer };
    });
    const tv = sc.current_state.verdict;
    const av = S.answers.verdict;
    const verdict =
      av.result === tv.result && (tv.result !== 'danger' || [...av.reasons].sort().join() === [...tv.reasons].sort().join());
    return { rows, verdict };
  }

  const causeLabel = (c) => (c ? CFG.causes[c] : '—');
  const verdictLabel = (v) => `${CFG.verdict.results[v.result] || '—'}${v.result === 'danger' && v.reasons.length ? `（${v.reasons.join('・')}）` : ''}`;
  const mark = (ok) => (ok ? '<span class="good">○</span>' : '<span class="bad">×</span>');

  function trickExplain(t) {
    const n = (id) => {
      const r = S.byId.get(id);
      return r ? `${r.name}（${r.id}）` : id;
    };
    switch (t.type) {
      case 'chip_transplant':
        return `${n(t.actor)} が ${n(t.target)} を殺害し、そのチップを自分に移植してなりすました。${n(t.actor)} のログはチップ摘出で途切れ、${n(t.target)} のログは ${n(t.actor)} の語り口で現在まで続いている。`;
      case 'log_tamper':
        return `相談役 ${n(t.actor)} が ${n(t.target)} の最期の記録を削除させ、死因を「事故」と記録させた。真の死因は「${CFG.causes[t.hidden_cause]}」。`;
      case 'death_disguise':
        return `${n(t.target)} の死は「${CFG.causes[t.recorded_cause]}」とされたが、本人の最期の感覚が示すとおり殺人だった（主張したのは ${n(t.actor)}）。`;
      case 'misperception':
        return `${n(t.witness)} は暗闇の中で ${n(t.target)} の加害者を ${n(t.wrong)} だと思い込んだが、見間違いだった。`;
      case 'unrecorded_person':
        return `チップを持たない侵入者が ${t.targets.map(n).join('、')} を殺害した。侵入者は${t.present ? '今もシェルターの中にいる' : 'すでに外へ出ていった'}。`;
      default:
        return t.name;
    }
  }

  function showResult() {
    const sc = S.sc;
    const res = S.result;
    const deathOf = new Map(sc.deaths.map((d) => [d.victim, d]));
    let head = '';
    if (!res) {
      head = '<div class="banner">侵入検知により接続が遮断された。回答は提出されていない。</div>';
    } else {
      const R = res.rows;
      const dead = sc.residents.filter((r) => r.status === 'dead');
      const deathOk = R.filter((x) => S.byId.get(x.id).status === 'dead' && x.cause && x.killer).length;
      const perfect = R.every((x) => x.ok) && res.verdict;
      head = `<p>${perfect ? '<b class="good">完全解明。</b>すべての身元・死因・安全判定が正しい。' : '真相とは食い違う点がある。'}</p>
        <div class="score">
          <div>身元<b>${R.filter((x) => x.identity).length}/${R.length}</b></div>
          <div>生死<b>${R.filter((x) => x.status).length}/${R.length}</b></div>
          <div>死因・加害者<b>${deathOk}/${dead.length}</b></div>
          <div>安全判定<b>${res.verdict ? '<span class="good">正解</span>' : '<span class="bad">不正解</span>'}</b></div>
        </div>`;
    }
    const resultMap = new Map((res ? res.rows : []).map((x) => [x.id, x]));
    const rows = sc.residents
      .slice()
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((r) => {
        const d = deathOf.get(r.id);
        const a = S.answers.people[r.token] || {};
        const x = resultMap.get(r.id);
        const yours = res
          ? `${a.status === 'alive' ? '生存' : a.status === 'dead' ? '死亡' : '—'} / ${causeLabel(a.cause)}${a.killer ? ` / ${labelOf(S.byTok.get(a.killer))}` : ''}`
          : '';
        return `<tr><td>${esc(r.name)} <span class="mono muted">${r.id}</span></td>
          <td>${res ? mark(x.identity) : ''}</td>
          <td>${r.status === 'alive' ? '<span class="good">生存</span>' : '死亡'}</td>
          <td>${d ? `${causeLabel(d.cause)}${d.killer ? `（${esc(S.byId.get(d.killer).name)}）` : ''}${d.recorded_cause ? ` <span class="muted">記録上は${causeLabel(d.recorded_cause)}</span>` : ''}` : '—'}</td>
          <td>${d ? `<span class="mono muted">${d.time}</span>` : ''}</td>
          <td>${res ? `${mark(x.ok)} <span class="muted">${esc(yours)}</span>` : ''}</td></tr>`;
      })
      .join('');
    const tricks = sc.tricks.length ? `<ul>${sc.tricks.map((t) => `<li><b>${esc(t.name)}</b>：${esc(trickExplain(t))}</li>`).join('')}</ul>` : '<p class="muted">トリックは使われていない。</p>';
    $('#resultTitle').textContent = res ? '結果と真相' : '接続遮断';
    $('#resultBody').innerHTML = `${head}
      <p>安全判定の真相：<b>${verdictLabel(sc.current_state.verdict)}</b>${res ? ` ／ あなたの回答：${verdictLabel(S.answers.verdict)} ${mark(res.verdict)}` : ''}</p>
      <p class="muted">危機：${esc(CFG.crises[sc.shelter.crisis].label)} ／ 物資：${{ depleted: '枯渇', low: '残りわずか', sufficient: '十分' }[sc.shelter.supplies]}</p>
      <p class="muted">再接続 ${S.reconnections}回 ／ 途中確定 ${Object.keys(S.confirmed).length}人</p>
      <h3 style="margin:14px 0 4px">トリック</h3>${tricks}
      <details${res ? '' : ' open'}><summary>住人の真相</summary>
        <div class="table-wrap" style="padding:0"><table class="answer-table">
          <tr><th>住人</th><th>${res ? '身元' : ''}</th><th>状態</th><th>死因（加害者）</th><th>死亡時刻</th><th>${res ? 'あなたの回答' : ''}</th></tr>${rows}
        </table></div>
      </details>`;
    $('#resultDlg').showModal();
  }

  // ------------------------------------------------------------------ 検証器（開発用）

  function openDev() {
    const sc = S.sc;
    const rep = S.report = A.Verifier.verify(sc);
    const narration = A.LLM.diagnostics(sc);
    const steps = rep.reach.steps
      .map((s, i) => `<tr><td>第${i + 1}段</td><td>${s.length}人</td><td>${s.map((id) => `${esc(S.byId.get(id)?.name || '名前不明')} <span class="mono">${esc(id)}</span>`).join(' ／ ')}</td></tr>`)
      .join('');
    $('#devBody').innerHTML = `
      <div class="dev-section"><h3>シナリオ生成</h3>
        <div class="dev-row">シード <input type="number" id="devSeed" value="${esc(sc.meta.seed)}" style="width:9em">
          <button class="btn primary" id="devGen">生成して遊ぶ</button>
          <button class="btn" id="devRand">ランダム</button>
          <button class="btn" id="devFixed">固定シナリオ「灯台」</button>
          <select id="devSize"><option value="standard">8〜10人</option><option value="large"${sc.meta.size === 'large' ? ' selected' : ''}>12〜16人</option></select>
          <select id="devMode"><option value="standard">標準モード</option><option value="hard"${sc.meta.mode === 'hard' ? ' selected' : ''}>ハードモード</option></select>
          <button class="btn" id="devExport">JSON 出力</button>
          <label class="btn">JSON 読込<input type="file" id="devImport" accept=".json,application/json" hidden></label>
        </div>
      </div>
      <div class="dev-section"><h3>現在のシナリオの検証レポート</h3>
        <p>表示中のシナリオ：${rep.pass ? '<b class="good">PASS</b>' : '<b class="bad">FAIL</b>'} ・ 生成試行 ${sc.meta.attempts || '—'} 回 ・
          住人 ${sc.residents.length} ・ 区画 ${sc.shelter.districts.length} ・ 死者 ${sc.deaths.length} ・ 手がかり事実 ${sc.facts.length} 件</p>
        <p class="muted">この結果は現在の本文から事件を解けるかの検査。LLMが不合格でも、検証済みのテンプレートへ戻した後の本文はPASSになる。</p>
        <p id="devLLMSummary">LLM文章化：<b class="${narration.counts.template ? 'bad' : narration.status === 'PASS' ? 'good' : 'muted'}">${esc(narration.status)}</b>
          ・ LLM採用 ${narration.counts.llm}/${narration.counts.total}件 ・ テンプレートへ復帰 ${narration.counts.template}件 ・ 未処理 ${narration.counts.pending}件
          ${narration.errors.length ? '<button class="btn" id="devLLMDetails">LLM検証の指摘を開く</button>' : ''}</p>
        <p>到達可能性：${rep.reach.reachable ? '<span class="good">全員に到達可能</span>' : '<span class="bad">到達不能あり</span>'} ・
          推理の段数 ${rep.reach.steps.length}（各段の解読数 ${rep.reach.perStep.join(' / ')}）</p>
        <details id="devReachSteps"><summary>段ごとの解読（ネタバレ）</summary><table class="data"><thead><tr><th>段</th><th>人数</th><th>解読できる人物・ID</th></tr></thead><tbody>${steps}</tbody></table></details>
        <p>因果 ${rep.validation.truth ? 'PASS' : 'FAIL'} ／ 証拠からの推論 ${rep.validation.evidence ? 'PASS' : 'FAIL'} ／ 本文の掲載 ${rep.validation.text ? 'PASS' : 'FAIL'}</p>
        <p>主観ログ ${rep.metrics.logs}件 ／ ${rep.metrics.characters}字 ／ 番号そのものの観察 ${rep.metrics.directNumbers}件 ／ 複数資料を要する結論 ${rep.metrics.multiSourceConclusions}件</p>
        <details><summary>導出経路・仮説の更新（ネタバレ）</summary><pre class="trace">${esc(JSON.stringify(rep.trace, null, 2))}</pre></details>
        <details><summary>学習される文化のルール（ネタバレ）：${(rep.reach.rules || []).length} 個</summary>${devCulture(sc, rep)}</details>
        ${rep.errors.length ? `<pre class="errors">${esc(rep.errors.join('\n'))}</pre>` : ''}
        <details><summary>真相（ネタバレ）</summary>
          <p>危機：${esc(CFG.crises[sc.shelter.crisis].label)} ／ 判定：${verdictLabel(sc.current_state.verdict)}</p>
          <ul>${sc.tricks.map((t) => `<li>${esc(t.name)}：${esc(trickExplain(t))}</li>`).join('') || '<li>トリックなし</li>'}</ul>
          <table class="data" style="max-width:none"><tr><th>ID</th><th>名前</th><th>状態</th><th>死因</th><th>加害者</th><th>時刻</th></tr>
          ${sc.residents
            .map((r) => {
              const d = sc.deaths.find((x) => x.victim === r.id);
              return `<tr><td class="num">${r.id}</td><td>${esc(r.name)}</td><td>${r.status === 'alive' ? '生存' : '死亡'}</td><td>${d ? causeLabel(d.cause) : ''}</td><td class="num">${d && d.killer ? d.killer : ''}</td><td class="num">${d ? d.time : ''}</td></tr>`;
            })
            .join('')}</table>
        </details>
      </div>
      ${devLLMSection()}
      <div class="dev-section"><h3>一括検証（§12.3）</h3>
        <div class="dev-row">開始シード <input type="number" id="batchStart" value="1" style="width:7em">
          本数 <input type="number" id="batchCount" value="20" style="width:5em">
          <button class="btn" id="devBatch">実行</button></div>
        <div id="batchOut"></div>
      </div>`;
    $('#devDlg').showModal();
  }

  // 文化と、プレイヤーが学習できるルール（検証器パネル用。ネタバレ）
  function devCulture(sc, rep) {
    if (sc.meta.generator === 'incident-v2') return `<pre>${esc(JSON.stringify(rep.reach.candidateRules, null, 2))}</pre>`;
    const cu = sc.culture;
    if (!cu) return '<p class="muted">文化の設定がない（古い形式）</p>';
    const label = (r) => {
      const [kind, key] = r.rule.split(':');
      if (kind === 'marker') {
        const a = cu.marker_attr[key];
        const v = a.attr === 'district' ? `${a.value}区画` : a.attr === 'category' ? `${CFG.categories[a.value]}班` : `入居順 ${a.value} 以下`;
        return `目印「${cu.markers[key].label}」⇒ ${v}`;
      }
      if (kind === 'nickname') return `呼び名「${key}」⇒ ${Object.keys(cu.districts).find((d) => cu.districts[d].nickname === key)}区画`;
      if (kind === 'ingroup') return '「うちの区画の」⇒ 同じ区画';
      if (kind === 'number') return `${CFG.culture.numberCustoms[cu.seniority.number_custom].label} ⇒ 入居順`;
      return `${CFG.culture.orderCustoms[key].label}`;
    };
    const rules = (rep.reach.rules || []).map((r) => `<li>第${r.step}段で学習：${esc(label(r))}</li>`).join('');
    const ds = Object.entries(cu.districts)
      .map(([d, x]) => `<li>${d}区画：${esc(x.role_label)}・評判「${esc(x.reputation)}」・呼び名「${esc(x.nickname)}」・目印 ${x.markers.map((m) => esc(cu.markers[m].label)).join('／')}</li>`)
      .join('');
    return `<ul>${rules}</ul><p>区画</p><ul>${ds}</ul>
      <p>序列：${esc(CFG.culture.seniorityLabels[cu.seniority.strength])} ／ 習慣：${esc(CFG.culture.numberCustoms[cu.seniority.number_custom].label)}、${cu.seniority.order_customs.map((c) => esc(CFG.culture.orderCustoms[c].label)).join('、')}</p>`;
  }

  function devLLMSection() {
    const configured = A.LLM.isConfigured();
    const s = A.LLM.settings();
    const rep = S.llmReport;
    const diagnostic = A.LLM.diagnostics(S.sc), counts = diagnostic.counts;
    const pending = counts.pending;
    const errors = S.sc.meta.generator === 'incident-v2' ? diagnostic.errors : rep?.specErrors || diagnostic.errors;
    const fb = (rep?.unresolved || [])
        .map((f) => `<li><span class="mono">${f.owner} #${f.index}</span>：${rich(f.problems.slice(0, 3).join(' ／ '))}</li>`)
        .join('');
    const spec = errors
        .map((f) => {
          const entry = S.sc.documents.chip_logs[f.owner]?.[f.index];
          const scene = f.scene || S.sc.story.scenes.find((s) => s.id === entry?.scene);
          const sceneInfo = scene ? `場面 ${esc(scene.id)} ${esc(scene.place)}「${rich(scene.title)}」` : '場面情報なし';
          const required = f.required || (entry ? (entry.draft || entry.text).split('\n') : []);
          return `<li><span class="mono">${esc(f.owner)} #${esc(f.index)}</span> ${esc(f.timestamp || entry?.timestamp || '時刻不明')} 〔${esc(f.codes.join(', '))}〕 ${sceneInfo}
            <ul><li>必須：${required.map(rich).join(' ／ ') || '—'}</li><li>指摘：${f.problems.map(rich).join(' ／ ')}</li>${f.text ? `<li>最後の出力：${rich(f.text)}</li>` : ''}</ul></li>`;
        })
        .join('');
    const byCode = {};
    errors.forEach((f) => f.codes.forEach((c) => (byCode[c] = (byCode[c] || 0) + 1)));
    const detail = `<p>LLM採用 ${counts.llm}/${counts.total}件 ・ テンプレートへ復帰 ${counts.template}件 ・ 未処理 ${pending}件</p>
      ${diagnostic.records.length ? `<p>全文の生成対象 ${diagnostic.metrics.target}件 ・ 初回採用 ${diagnostic.metrics.initiallyAccepted}件 ・ 修正後を含む採用 ${diagnostic.metrics.accepted}件 ・ 復帰 ${diagnostic.metrics.fallback}件<br>真の意味変更・誤検知の人による確認：未実施。品質警告 ${diagnostic.metrics.qualityWarnings}件</p>` : ''}
      ${rep ? `<p>今回の実行：不合格 ${rep.specErrors.length}件 ・ 未解決 ${rep.unresolved.length}件 ・ API ${rep.stats.calls}回
        ・ トークン 入力 ${rep.stats.promptTokens} / 出力 ${rep.stats.completionTokens} ・ 再送 ${rep.stats.retries}回</p>`
        : `<p class="muted">${counts.llm + counts.template ? 'エントリの結果と指摘は保存済みのデータから復元。前回のAPI呼び出し回数は保存していない。' : 'このシナリオのLLM文章化は未実施。'}</p>`}
      ${spec ? `<details id="devLLMErrors"><summary>LLM検証の指摘（${errors.length}件：${esc(Object.entries(byCode).map(([c, n]) => `${c} ${n}`).join('、'))}）</summary><ul class="llm-fail">${spec}</ul></details>` : ''}
      ${diagnostic.records.length ? `<details id="devLLMDiagnostics"><summary>生成入力・全文・抽出・引用・修正履歴（ネタバレ）</summary>${diagnostic.records.map((d) => `<details><summary>${esc(d.entryId)} ／ ${esc(d.origin)} ／ ${d.attempts.length}試行</summary><button class="btn" data-recheck="${esc(d.entryId)}">保存本文を再検査（生成APIは呼ばない）</button><pre class="trace">${esc(JSON.stringify(d, null, 2))}</pre></details>`).join('')}</details>` : ''}
      ${fb ? `<details><summary>直近の実行で検証に通らなかったエントリ（未解決 ${rep.unresolved.length}）</summary><ul>${fb}</ul></details>` : ''}`;
    return `<div class="dev-section"><h3>LLM による文章化（§10）</h3>
      ${configured ? `<p>モデル <span class="mono">${esc(s.model)}</span>（検証 <span class="mono">${esc(s.verifyModel)}</span>）・ 自動実行 ${s.autoNarrate ? 'オン' : 'オフ'}</p>` : '<p>API未設定。文章化する場合は js/config.local.example.js を js/config.local.js へコピーして設定する。</p>'}
      ${detail}
      <div class="dev-row">
        <button class="btn" id="devLLMRun"${configured && pending ? '' : ' disabled'}>未処理分を文章化</button>
        <button class="btn" id="devLLMRedo"${configured ? '' : ' disabled'}>キャッシュを消して作り直す</button>
        <button class="btn" id="devLLMRevert">テンプレート文に戻す</button>
      </div></div>`;
  }

  function runBatch() {
    const start = Number($('#batchStart').value) || 1;
    const count = Math.min(500, Number($('#batchCount').value) || 20);
    const rows = [];
    let pass = 0;
    const t0 = performance.now();
    for (let s = start; s < start + count; s++) {
      try {
        const { scenario: sc, report } = A.Generator.generate(s);
        pass++;
        rows.push(`<tr><td class="num">${s}</td><td class="good">PASS</td><td class="num">${sc.meta.attempts}</td><td class="num">${sc.residents.length}</td>
          <td class="num">${report.reach.steps.length} [${report.reach.perStep.join(',')}]</td><td>${esc(CFG.crises[sc.shelter.crisis].label)}</td>
          <td>${esc(sc.tricks.map((t) => t.name).join('・') || '—')}</td><td>${verdictLabel(sc.current_state.verdict)}</td></tr>`);
      } catch (e) {
        rows.push(`<tr><td class="num">${s}</td><td class="bad">FAIL</td><td colspan="6">${esc(e.message)}</td></tr>`);
      }
    }
    $('#batchOut').innerHTML = `<p>${pass}/${count} 本が因果・到達可能性・一意性・本文検査を通過（${Math.round(performance.now() - t0)}ms）</p>
      <div class="table-wrap" style="padding:0"><table class="data" style="max-width:none">
      <tr><th>シード</th><th>結果</th><th>試行</th><th>住人</th><th>段数</th><th>危機</th><th>トリック</th><th>判定</th></tr>${rows.join('')}</table></div>`;
  }

  function exportJSON() {
    const blob = new Blob([JSON.stringify(S.sc, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `asariya-scenario-${S.sc.meta.seed}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  function importJSON(file) {
    const reader = new FileReader();
    reader.onload = () => {
      let sc;
      try {
        sc = JSON.parse(reader.result);
      } catch (e) {
        alert('JSON として読めませんでした。');
        return;
      }
      let report;
      try {
        report = A.Verifier.verify(sc);
      } catch (e) {
        alert(`シナリオの形式が不正です：${e.message}`);
        return;
      }
      if (!report.pass) { alert(`読み込めません：\n${report.errors.slice(0, 5).join('\n')}`); return; }
      S.source = 'json';
      setScenario(sc, report);
      $('#devDlg').close();
    };
    reader.readAsText(file);
  }

  // ------------------------------------------------------------------ イベント

  function bindStatic() {
    $('#unlockForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const input = $('#idInput');
      tryUnlock(input.value);
      input.value = '';
      input.focus();
    });
    $('#docList').addEventListener('click', (e) => {
      const b = e.target.closest('[data-doc]');
      if (b) openDoc(b.dataset.doc);
    });
    document.addEventListener('click', (e) => {
      const t = e.target.closest('.tok[data-tok]');
      if (t && !t.closest('select') && !t.closest('#answerDlg')) {
        selectToken(t.dataset.tok);
        return;
      }
      const o = e.target.closest('.occ li[data-doc]');
      if (o) openDoc(o.dataset.doc, Number(o.dataset.idx));
      if (e.target.matches('[data-close]')) e.target.closest('dialog').close();
      const pin = e.target.closest('[data-pin]');
      if (pin && visibleEntries().some((x) => x.ref === pin.dataset.pin)) {
        const ref = pin.dataset.pin;
        S.pins = S.pins.includes(ref) ? S.pins.filter((r) => r !== ref) : S.pins.concat(ref);
        S.comparison = S.pins.slice(-2); saveProgress(); renderViewer(); renderPeople();
      }
      const evidence = e.target.closest('[data-evidence]');
      if (evidence && S.selTok && visibleEntries().some((x) => x.ref === evidence.dataset.evidence)) {
        const draft = S.drafts[S.selTok] = S.drafts[S.selTok] || {};
        draft.evidence = [...new Set((draft.evidence || []).concat(evidence.dataset.evidence))];
        saveProgress(); renderPeople();
      }
      const jump = e.target.closest('[data-jump]'); if (jump) jumpTo(jump.dataset.jump);
      if (e.target.id === 'btnFilter') {
        S.filters = { text: $('#timelineText').value, day: $('#timelineDay').value };
        saveProgress(); renderViewer();
      }
    });
    document.addEventListener('input', (e) => {
      if (e.target.id === 'memo') {
        S.memos[S.selTok] = e.target.value;
        if (!e.target.value) delete S.memos[S.selTok];
        saveProgress();
      }
      if (e.target.dataset.draft && S.selTok) {
        const draft = S.drafts[S.selTok] = S.drafts[S.selTok] || {};
        draft[e.target.dataset.draft] = e.target.value;
        if (draft.district && draft.order && draft.job) $('#idInput').value = `${draft.district}-${draft.order}-${draft.job}`;
        saveProgress();
      }
    });
    $('#tokDetail').addEventListener('change', (e) => {
      if (e.target.dataset.hypothesis && S.selTok && !S.confirmed[S.selTok]) {
        const answer = S.answers.people[S.selTok] = S.answers.people[S.selTok] || {};
        answer[e.target.dataset.hypothesis] = e.target.value; saveProgress();
      }
      if (e.target.dataset.draft === 'nickname' && S.selTok) {
        const r = S.byTok.get(S.selTok);
        if (!S.unlocked.has(r.id)) $$('.tok[data-tok]').filter((el) => el.dataset.tok === S.selTok)
          .forEach((el) => { el.textContent = `${S.drafts[S.selTok]?.nickname || ''} ⟨${S.selTok}⟩`.trim(); });
      }
    });
    $('#viewer').addEventListener('change', (e) => {
      if (e.target.dataset.compare != null) { S.comparison[Number(e.target.dataset.compare)] = e.target.value; saveProgress(); renderViewer(); }
    });
    $('#btnReconnect').addEventListener('click', () => {
      if (A.Investigation.reconnect(S)) { term('info', '再接続した。資料とメモを保持して認証を再開。'); saveProgress(); renderAll(); }
    });
    $('#btnConfirm').addEventListener('click', confirmAnswers);
    $('#btnAnswer').addEventListener('click', openAnswer);
    $('#answerDlg').addEventListener('change', onAnswerChange);
    $('#btnSubmit').addEventListener('click', submitAnswer);
    $('#btnNew').addEventListener('click', () => {
      if (S.unlockOrder.length && !S.over && !confirm('新しいシナリオを始めますか？（今の進行状況は保存されています）')) return;
      const params = new URLSearchParams(location.search); params.delete('scenario'); history.replaceState(null, '', `?${params}`);
      startSeed(randomSeed());
    });
    $('#btnNext').addEventListener('click', () => {
      $('#resultDlg').close();
      const params = new URLSearchParams(location.search); params.delete('scenario'); history.replaceState(null, '', `?${params}`);
      startSeed(randomSeed());
    });
    $('#btnRetry').addEventListener('click', () => {
      if (!confirm('進行状況を消して、同じシナリオを最初からやり直しますか？')) return;
      resetProgress();
      saveProgress();
      S.current = 'brief';
      $('#resultDlg').close();
      renderAll();
    });
    $('#btnDev').addEventListener('click', openDev);
    $('#devDlg').addEventListener('click', (e) => {
      if (e.target.id === 'devGen') {
        $('#devDlg').close();
        const params = new URLSearchParams(location.search); params.delete('scenario');
        params.set('size', $('#devSize').value); params.set('mode', $('#devMode').value);
        history.replaceState(null, '', `?${params}`);
        startSeed(Number($('#devSeed').value) || 1);
      } else if (e.target.id === 'devFixed') {
        $('#devDlg').close(); const params = new URLSearchParams(location.search);
        params.set('scenario', 'fixed'); params.set('mode', $('#devMode').value); history.replaceState(null, '', `?${params}`);
        startSeed(730);
      } else if (e.target.id === 'devRand') {
        $('#devSeed').value = randomSeed();
      } else if (e.target.id === 'devExport') exportJSON();
      else if (e.target.id === 'devLLMDetails') {
        const details = $('#devLLMErrors');
        if (details) { details.open = true; details.scrollIntoView({ block: 'start' }); }
      }
      else if (e.target.dataset.recheck) recheckNarration(e.target.dataset.recheck, e.target);
      else if (e.target.id === 'devBatch') runBatch();
      else if (e.target.id === 'devLLMRun') {
        $('#devDlg').close();
        runNarration();
      } else if (e.target.id === 'devLLMRedo') {
        if (!confirm('このシナリオの LLM 文章のキャッシュを消して、すべて作り直しますか？（API を再度呼び出します）')) return;
        A.LLM.clearCache(S.sc);
        A.LLM.revertToTemplate(S.sc);
        S.llmReport = null;
        $('#devDlg').close();
        renderAll();
        runNarration();
      } else if (e.target.id === 'devLLMRevert') {
        A.LLM.revertToTemplate(S.sc);
        S.llmReport = null;
        renderAll();
        openDev();
      }
    });
    $('#btnLLM').addEventListener('click', runNarration);
    $('#btnLLMCancel').addEventListener('click', () => {
      if (S.narrating) S.narrating.abort();
      $('#llmDlg').close();
    });
    $('#btnLLMRetry').addEventListener('click', () => S.llmChoice && S.llmChoice('retry'));
    $('#btnLLMTemplate').addEventListener('click', () => S.llmChoice && S.llmChoice('template'));
    $('#llmDlg').addEventListener('cancel', (e) => {
      // 選択待ちのときは Esc で閉じさせず、どちらかを選んでもらう。実行中なら中断扱い
      if (S.llmChoice) e.preventDefault();
      else if (S.narrating) S.narrating.abort();
    });
    $('#devDlg').addEventListener('change', (e) => {
      if (e.target.id === 'devImport' && e.target.files[0]) importJSON(e.target.files[0]);
    });
  }

  async function recheckNarration(entryId, button) {
    const sc = S.sc, [owner, index] = entryId.split('#'), entry = sc.documents.chip_logs[owner]?.[Number(index)];
    if (!entry?.narrationDiagnostic || !A.LLM.isConfigured()) return;
    button.disabled = true; button.textContent = '保存本文の意味を再検査中…';
    try {
      const result = await A.Narration.recheck(sc, entry.narrationDiagnostic);
      if (S.sc !== sc) return;
      S.llmReport = null;
      term(result.result.pass ? 'ok' : 'warn', `保存本文の再検査 ${entryId}：${result.result.pass ? '採用' : '不採用'}（生成APIなし、検証API ${result.stats.calls}回）`);
      if (result.invalidated.length) term('info', `参照先の本文が変わったため、後続 ${result.invalidated.length}件を再処理対象へ戻した。「未処理分を文章化」で再検査できる。`);
      saveProgress(); renderAll(); openDev();
    } catch (error) {
      term('err', `再検査に失敗：${error.message}`);
      button.disabled = false; button.textContent = '保存本文を再検査（生成APIは呼ばない）';
    }
  }

  document.addEventListener('DOMContentLoaded', boot);
})(window.ASARIYA = window.ASARIYA || {});
