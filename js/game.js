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
    startSeed(Number.isFinite(seed) && seed > 0 ? seed : randomSeed());
    bindStatic();
  }

  const randomSeed = () => Math.floor(Math.random() * 999999) + 1;

  function startSeed(seed) {
    let gen;
    try {
      gen = A.Generator.generate(seed);
    } catch (e) {
      alert(e.message);
      return;
    }
    S.source = 'gen';
    setScenario(gen.scenario, gen.report);
    try {
      history.replaceState(null, '', `?seed=${seed}`);
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
          $('#llmStatus').textContent = `時系列の波 ${p.doneWaves}/${p.totalWaves} ・ エントリ ${p.doneEntries}/${p.totalEntries}`;
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
        term('warn', `仕様エラー ${rep.specErrors.length} 件（同じ種類の指摘が続いた／場面カードが正本と矛盾）はテンプレート文で確定した。内訳は検証器パネル`);
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
    S.answers = { people: {}, verdict: { result: '', reasons: [] } };
    S.result = null;
    S.over = false;
    S.termLog = [];
    S.selTok = null;
  }

  const storageKey = () => `asariya:v1:${S.source}:${S.sc.meta.seed}`;

  function saveProgress() {
    try {
      localStorage.setItem(
        storageKey(),
        JSON.stringify({
          unlockOrder: S.unlockOrder, alert: S.alert, tried: S.tried, memos: S.memos,
          answers: S.answers, result: S.result, over: S.over, termLog: S.termLog.slice(0, 30),
        }),
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
    (data.unlockOrder || []).forEach((id) => {
      if (S.byId.has(id)) {
        S.unlocked.add(id);
        S.unlockOrder.push(id);
      }
    });
    S.alert = data.alert || 0;
    S.tried = data.tried || [];
    S.memos = data.memos || {};
    S.answers = data.answers || S.answers;
    S.result = data.result || null;
    S.over = !!data.over;
    S.termLog = data.termLog || [];
  }

  // ------------------------------------------------------------------ 表示の部品

  function personHTML(id) {
    const r = S.byId.get(id);
    if (!r) return esc(id);
    const sel = S.selTok === r.token ? ' sel' : '';
    const rev = S.justRevealed === r.token ? ' reveal' : '';
    if (S.unlocked.has(id)) return `<span class="tok known${sel}${rev}" data-tok="${r.token}" title="${r.id}">${esc(r.name)}</span>`;
    return `<span class="tok masked${sel}" data-tok="${r.token}" title="未解読の人物">⟨${r.token}⟩</span>`;
  }
  const rich = (text) => esc(text).replace(TOKEN_RE, (m, id) => personHTML(id));
  const labelOf = (r) => (S.unlocked.has(r.id) ? `${r.name}（${r.id}）` : `⟨${r.token}⟩`);
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
    $('#btnLLM').hidden = !configured || cnt.pending === 0 || !!S.llmRun;
  }

  function renderDocList() {
    const sc = S.sc;
    const now = sc.shelter.now_day;
    const base = ['brief', 'overview', 'jobs', 'hatch', 'dialogue'];
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
      <p>右の「ID 認証」に正しい ID を入力すると、その人物の<b>主観ログ</b>が開き、全資料の伏せ字が名前に置き換わる。誤った ID を送ると<b>警戒度</b>が上がり、${CFG.alertMax} に達すると接続を遮断される。正しい ID を入力するたびに、警戒度は ${CFG.alertRecoverOnSuccess} 下がる。</p>
      <ul>
        <li><b>区画</b>：住んでいる区画。</li>
        <li><b>入居順</b>：シェルター全体での通し番号。欠番がありうる。同じ番号の住人は二人といない。</li>
        <li><b>職能</b>：仕事の内容から読み取る。対応は「職能コード表」を参照。</li>
      </ul>
      <p>主観ログには、誰がどの区画の住人か、何番目に来たかは書かれていない。手がかりは、人々の身なりや匂い、言葉づかい、並び方や呼び方といった<b>このシェルターの暮らしぶり</b>の中にある。素性の分かった住人の描写と見比べて、このシェルターならではの決まりごとを見つけ出してほしい。決まりごとはシェルターごとに違う。</p>
      <ul>
      </ul>
      <h3>資料の性質</h3>
      <ul>
        <li><b>主観ログ</b>は本人の感覚と感情の記録で、嘘はつけない。ただし暗闇や混乱の中での<b>思い込み・見間違い</b>はありうる。死者のログの最後のエントリは、死の直前の感覚だ。</li>
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
        <li>進行状況とメモはこのブラウザに自動保存される。</li>
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
      <p class="muted">相談役の ID は管理AIの公開情報として最初から判明している。ここが推理の入口になる。</p>`;
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
          `<td>${h.auth ? personHTML(h.auth) : '<span class="bad">なし（強制開放）</span>'}</td></tr>`,
      )
      .join('');
    return `<h1 class="doc-title">外部ハッチ開閉記録</h1>
      <p class="doc-sub">管理AIが自動記録 ・ 認証にはチップを使う</p>
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
        return `<div class="entry" data-entry="${i}"><div class="entry-head">${e.timestamp}</div><div class="entry-text">${lines}</div></div>`;
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
        return `<div class="entry" data-entry="${i}"><div class="entry-head">${e.timestamp}${emo}</div><div class="entry-text">${rich(e.text)}</div></div>`;
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
    $('#idInput').disabled = S.over;
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
    $('#tokDetail').innerHTML = `
      <div class="head"><b>${personHTML(sel.id)}</b><span class="id">${S.unlocked.has(sel.id) ? sel.id : '未解読'}</span></div>
      <textarea id="memo" placeholder="推理メモ（区画・入居順・職能の候補など）">${esc(S.memos[S.selTok] || '')}</textarea>
      <ul class="occ">${list || '<li>閲覧中の資料には出てこない</li>'}</ul>`;
  }

  // ------------------------------------------------------------------ 操作

  function openDoc(key, idx) {
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
    const s = raw.normalize('NFKC').trim().toUpperCase();
    const m = s.match(/^([A-Z])\s*[-ー−‐_ ]?\s*(\d{1,2})\s*[-ー−‐_ ]?\s*(\d{2})$/);
    return m ? `${m[1]}-${m[2].padStart(2, '0')}-${m[3]}` : null;
  }

  function tryUnlock(raw) {
    if (S.over) return;
    const sc = S.sc;
    const id = normalizeId(raw);
    S.justRevealed = null;
    if (!id) {
      term('warn', '形式エラー：区画-入居順-職能 の形で入力（例 C-07-31）');
    } else if (S.unlocked.has(id)) {
      term('info', `${id} は解読済み`);
      openDoc(`log:${id}`);
    } else {
      const [d, e, j] = id.split('-');
      const n = Number(e);
      if (!sc.shelter.districts.includes(d) || n < 1 || n > sc.shelter.max_entry || !CFG.jobByCode[Number(j)]) {
        term('warn', `${id}：存在しない区画・入居番号・職能コードを含む（送信していない）`);
      } else if (S.byId.has(id)) {
        const r = S.byId.get(id);
        S.unlocked.add(id);
        S.unlockOrder.push(id);
        S.justRevealed = r.token;
        if (S.selTok === r.token) S.selTok = r.token;
        term('ok', `認証成功：${id} の主観ログを取得。伏せ字 ⟨${r.token}⟩ を解除 → ${r.name}`);
        // 正しい ID のたびに警戒度を下げる（改修仕様 v0.2 §9）。推理が進んでいる間は試行の余地が回復する
        if (S.alert > 0) {
          S.alert = Math.max(0, S.alert - (CFG.alertRecoverOnSuccess || 0));
          term('info', `警戒度が下がった：${S.alert}/${CFG.alertMax}`);
        }
        S.current = `log:${id}`;
      } else if (S.tried.includes(id)) {
        term('warn', `${id} は拒否済みの ID（警戒度は変わらない）`);
      } else {
        S.tried.push(id);
        S.alert++;
        term('err', `認証失敗：${id} に該当する記録なし。警戒度 ${S.alert}/${CFG.alertMax}`);
        if (S.alert >= CFG.alertMax) {
          S.over = true;
          term('err', '侵入検知。管理AIとの接続が遮断された。');
        }
      }
    }
    saveProgress();
    renderAll();
    if (S.justRevealed) {
      const tok = S.justRevealed;
      setTimeout(() => {
        if (S.justRevealed === tok) S.justRevealed = null;
      }, 2000);
    }
    if (S.over && !S.result) showResult();
  }

  function selectToken(tok) {
    S.selTok = S.selTok === tok ? null : tok;
    $$('.tok').forEach((el) => el.classList.toggle('sel', !!S.selTok && el.dataset.tok === S.selTok));
    renderPeople();
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
        return `<tr data-tok="${r.token}">
          <td>${personHTML(r.id)}${S.unlocked.has(r.id) ? ` <span class="mono muted">${r.id}</span>` : ''}</td>
          <td><select data-f="status">${opt('', '—', a.status)}${opt('alive', '生存', a.status)}${opt('dead', '死亡', a.status)}</select></td>
          <td><select data-f="cause"${a.status === 'dead' ? '' : ' disabled'}>${causeOpts}</select></td>
          <td><select data-f="killer"${a.status === 'dead' && a.cause === 'murder' ? '' : ' disabled'}>${killerOpts(a.killer)}</select></td>
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
    $('#answerDlg').showModal();
  }

  function onAnswerChange(e) {
    const tr = e.target.closest('tr[data-tok]');
    if (tr) {
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
    const rep = S.report;
    const steps = rep.reach.steps
      .map((s, i) => `<li>第${i + 1}段：${s.length}人 <span class="mono muted">${s.join(' ')}</span></li>`)
      .join('');
    $('#devBody').innerHTML = `
      <div class="dev-section"><h3>シナリオ生成</h3>
        <div class="dev-row">シード <input type="number" id="devSeed" value="${esc(sc.meta.seed)}" style="width:9em">
          <button class="btn primary" id="devGen">生成して遊ぶ</button>
          <button class="btn" id="devRand">ランダム</button>
          <button class="btn" id="devExport">JSON 出力</button>
          <label class="btn">JSON 読込<input type="file" id="devImport" accept=".json,application/json" hidden></label>
        </div>
      </div>
      <div class="dev-section"><h3>現在のシナリオの検証レポート</h3>
        <p>${rep.pass ? '<b class="good">PASS</b>' : '<b class="bad">FAIL</b>'} ・ 生成試行 ${sc.meta.attempts || '—'} 回 ・
          住人 ${sc.residents.length} ・ 区画 ${sc.shelter.districts.length} ・ 死者 ${sc.deaths.length} ・ 手がかり事実 ${sc.facts.length} 件</p>
        <p>到達可能性：${rep.reach.reachable ? '<span class="good">全員に到達可能</span>' : '<span class="bad">到達不能あり</span>'} ・
          推理の段数 ${rep.reach.steps.length}（各段の解読数 ${rep.reach.perStep.join(' / ')}）</p>
        <details><summary>段ごとの解読（ネタバレ）</summary><ol>${steps}</ol></details>
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
    if (!A.LLM || !A.LLM.isConfigured()) {
      return `<div class="dev-section"><h3>LLM による文章化（§10）</h3>
        <p>未設定。<code>js/config.local.example.js</code> を <code>js/config.local.js</code> にコピーし、OpenAI の API キーを書き込んでから再読み込みする。
        <code>config.local.js</code> は .gitignore で git 管理外になっている。</p></div>`;
    }
    const s = A.LLM.settings();
    const rep = S.llmReport;
    const pending = A.LLM.pendingCount(S.sc);
    let detail = '<p class="muted">このセッションではまだ実行していない（キャッシュ済みの文章は自動で適用される）。</p>';
    if (rep) {
      const st = rep.stats;
      const fb = rep.unresolved
        .map((f) => `<li><span class="mono">${f.owner} #${f.index}</span>：${rich(f.problems.slice(0, 3).join(' ／ '))}</li>`)
        .join('');
      const spec = rep.specErrors
        .map(
          (f) => `<li><span class="mono">${f.owner} #${f.index}</span> ${esc(f.timestamp)} 〔${esc(f.codes.join(', '))}〕 場面 ${esc(f.scene.id)} ${esc(f.scene.place)}「${rich(f.scene.title)}」
            <ul><li>必須：${f.required.map(rich).join(' ／ ') || '—'}</li><li>指摘：${f.problems.map(rich).join(' ／ ')}</li>${f.text ? `<li>最後の出力：${rich(f.text)}</li>` : ''}</ul></li>`,
        )
        .join('');
      const byCode = {};
      rep.specErrors.forEach((f) => f.codes.forEach((c) => (byCode[c] = (byCode[c] || 0) + 1)));
      detail = `<p>LLM ${rep.llm}/${rep.entries} エントリ（今回キャッシュから ${rep.cached}）・ 未解決 ${rep.unresolved.length} ・ 仕様エラー ${rep.specErrors.length}
        ・ 下書きとの重複率 ${rep.overlap == null ? '—' : (rep.overlap * 100).toFixed(1) + '%'}</p>
        <p>API ${st.calls} 回 ・ トークン 入力 ${st.promptTokens} / 出力 ${st.completionTokens}
        ・ 再送 ${st.retries} 回 ・ 日ごとの矛盾の指摘 ${rep.contradictions} 件 ・ 構造検証 ${rep.verification.pass ? '<span class="good">PASS</span>' : '<span class="bad">FAIL</span>'}</p>
        <p>テンプレート文で確定したエントリ ${A.LLM.countEntries(S.sc).template} 件</p>
        ${spec ? `<details><summary>仕様エラー（${rep.specErrors.length}：${esc(Object.entries(byCode).map(([c, n]) => `${c} ${n}`).join('、'))}）</summary><ul class="llm-fail">${spec}</ul></details>` : ''}
        ${fb ? `<details><summary>直近の実行で検証に通らなかったエントリ（未解決 ${rep.unresolved.length}）</summary><ul>${fb}</ul></details>` : ''}`;
    }
    return `<div class="dev-section"><h3>LLM による文章化（§10）</h3>
      <p>モデル <span class="mono">${esc(s.model)}</span>（検証 <span class="mono">${esc(s.verifyModel)}</span>）・ 未処理 ${pending} エントリ ・ 自動実行 ${s.autoNarrate ? 'オン' : 'オフ'}</p>
      ${detail}
      <div class="dev-row">
        <button class="btn" id="devLLMRun"${pending ? '' : ' disabled'}>未処理分を文章化</button>
        <button class="btn" id="devLLMRedo">キャッシュを消して作り直す</button>
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
    $('#batchOut').innerHTML = `<p>${pass}/${count} 本が到達可能性・一意性・往復検証を通過（${Math.round(performance.now() - t0)}ms）</p>
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
      if (!report.pass && !confirm(`検証に失敗しました：\n${report.errors.slice(0, 5).join('\n')}\n\nそれでも読み込みますか？`)) return;
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
    });
    document.addEventListener('input', (e) => {
      if (e.target.id === 'memo') {
        S.memos[S.selTok] = e.target.value;
        if (!e.target.value) delete S.memos[S.selTok];
        saveProgress();
      }
    });
    $('#tokDetail').addEventListener('change', () => renderPeople());
    $('#btnAnswer').addEventListener('click', openAnswer);
    $('#answerDlg').addEventListener('change', onAnswerChange);
    $('#btnSubmit').addEventListener('click', submitAnswer);
    $('#btnNew').addEventListener('click', () => {
      if (S.unlockOrder.length && !S.over && !confirm('新しいシナリオを始めますか？（今の進行状況は保存されています）')) return;
      startSeed(randomSeed());
    });
    $('#btnNext').addEventListener('click', () => {
      $('#resultDlg').close();
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
        startSeed(Number($('#devSeed').value) || 1);
      } else if (e.target.id === 'devRand') {
        $('#devSeed').value = randomSeed();
      } else if (e.target.id === 'devExport') exportJSON();
      else if (e.target.id === 'devBatch') runBatch();
      else if (e.target.id === 'devLLMRun') {
        $('#devDlg').close();
        runNarration();
      } else if (e.target.id === 'devLLMRedo') {
        if (!confirm('このシナリオの LLM 文章のキャッシュを消して、すべて作り直しますか？（API を再度呼び出します）')) return;
        A.LLM.clearCache(S.sc);
        A.LLM.revertToTemplate(S.sc);
        $('#devDlg').close();
        renderAll();
        runNarration();
      } else if (e.target.id === 'devLLMRevert') {
        A.LLM.revertToTemplate(S.sc);
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

  document.addEventListener('DOMContentLoaded', boot);
})(window.ASARIYA = window.ASARIYA || {});
