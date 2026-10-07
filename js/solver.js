// 検証器（設計書 §8）
//  - 有限領域の制約充足ソルバー（AC-3 + バックトラック）
//  - 到達可能性の検証（§8.2）：プレイヤーの推理を模擬し、解読できる ID を段ごとに増やす
//  - 一意性の検証（§8.3）：死因・加害者・生死・安全判定が手がかり事実から一意に導けるか
//  - 文章の往復検証（§10.4 の簡易版）：各エントリが割り当てられた手がかり事実をすべて描写しているか
(function (A) {
  'use strict';

  // ---------------------------------------------------------------- CSP
  // domains: number[][]（変数ごとの候補値） cons: {a, b, check(va, vb)}[]

  function makeAdj(n, cons) {
    const adj = Array.from({ length: n }, () => []);
    cons.forEach((c, i) => {
      adj[c.a].push(i);
      adj[c.b].push(i);
    });
    return adj;
  }

  function revise(doms, c, x) {
    const isA = x === c.a;
    const dy = doms[isA ? c.b : c.a];
    const before = doms[x].length;
    doms[x] = doms[x].filter((vx) => dy.some((vy) => (isA ? c.check(vx, vy) : c.check(vy, vx))));
    return doms[x].length !== before;
  }

  function propagate(doms, cons, adj, queue) {
    while (queue.length) {
      const [ci, x] = queue.pop();
      const c = cons[ci];
      if (revise(doms, c, x)) {
        if (!doms[x].length) return false;
        for (const cj of adj[x]) {
          if (cj === ci) continue;
          const cc = cons[cj];
          queue.push([cj, cc.a === x ? cc.b : cc.a]);
        }
      }
    }
    return true;
  }

  function search(doms, cons, adj) {
    let best = -1;
    for (let i = 0; i < doms.length; i++) {
      if (doms[i].length > 1 && (best < 0 || doms[i].length < doms[best].length)) best = i;
    }
    if (best < 0) return doms.map((d) => d[0]);
    for (const v of doms[best]) {
      const nd = doms.slice();
      nd[best] = [v];
      const q = adj[best].map((ci) => [ci, cons[ci].a === best ? cons[ci].b : cons[ci].a]);
      if (propagate(nd, cons, adj, q)) {
        const r = search(nd, cons, adj);
        if (r) return r;
      }
    }
    return null;
  }

  function solve(domains, cons) {
    if (domains.some((d) => !d.length)) return null;
    const adj = makeAdj(domains.length, cons);
    const doms = domains.slice();
    const q = [];
    cons.forEach((c, i) => q.push([i, c.a], [i, c.b]));
    if (!propagate(doms, cons, adj, q)) return null;
    return search(doms, cons, adj);
  }

  // 解を一つ求め、その値を禁止して再度解く標準的な一意性判定（§8.2）
  function uniqueVars(domains, cons, candidates) {
    const sol = solve(domains, cons);
    if (!sol) return null;
    const uniq = new Set();
    for (const i of candidates) {
      const d2 = domains.slice();
      d2[i] = domains[i].filter((v) => v !== sol[i]);
      if (!solve(d2, cons)) uniq.add(i);
    }
    return { sol, uniq };
  }

  // ---------------------------------------------------------------- 身元（ID）の推理

  const ID_TYPES = new Set([
    'DISTRICT', 'NOT_DISTRICT', 'SAME_DISTRICT',
    'JOB', 'NOT_JOB', 'JOB_CATEGORY', 'SAME_JOB',
    'ENTRY_ORDER', 'ENTRY_OFFSET', 'ENTRY_BETWEEN', 'ENTERED_BEFORE',
  ]);
  const COMPONENT_OF = {
    DISTRICT: 'D', NOT_DISTRICT: 'D', SAME_DISTRICT: 'D',
    JOB: 'J', NOT_JOB: 'J', JOB_CATEGORY: 'J', SAME_JOB: 'J',
    ENTRY_ORDER: 'E', ENTRY_OFFSET: 'E', ENTRY_BETWEEN: 'E', ENTERED_BEFORE: 'E', ENTRY_MAX: 'E',
  };
  // 主観ログに置く観察事実（改修仕様 v0.2 §4.2）。文化のルールを学習して初めて身元の制約になる（OBS_WORK を除く）
  const OBS_TYPES = new Set(['OBS_MARKER', 'OBS_WORK', 'OBS_NUMBER', 'OBS_AHEAD', 'OBS_ADJACENT', 'OBS_HONORIFIC', 'OBS_INGROUP', 'OBS_OUTGROUP']);
  // 主観ログに置いてはいけない、答えそのものの形の事実（改修仕様 v0.2 §4.1）
  const DIRECT_TYPES = new Set(['DISTRICT', 'NOT_DISTRICT', 'JOB', 'NOT_JOB', 'JOB_CATEGORY', 'ENTRY_ORDER', 'ENTRY_OFFSET', 'ENTRY_BETWEEN', 'SAME_DISTRICT', 'SAME_JOB', 'ENTERED_BEFORE']);

  const valueOf = (r, comp) => (comp === 'D' ? r.district : comp === 'E' ? r.entry_order : r.job_code);

  // ID の3要素は互いに制約を持たないので、区画・入居順・職能の3つの CSP に分けて解く。
  function buildCSP(sc, comp, facts, known) {
    const CFG = A.CONFIG;
    const res = sc.residents;
    const idx = new Map(res.map((r, i) => [r.id, i]));
    let base;
    if (comp === 'D') base = sc.shelter.districts.slice();
    else if (comp === 'E') base = A.util.range(1, sc.shelter.max_entry);
    else base = CFG.jobs.map((j) => j.code);

    const doms = res.map((r) => {
      if (known.has(r.id)) return [valueOf(r, comp)];
      // 相談役は最初から全員判明している（概要に記載）ので、未解読者の職能は 51 ではない
      if (comp === 'J') return base.filter((v) => v !== CFG.counselorCode);
      return base.slice();
    });
    const cons = [];
    const filt = (id, pred) => {
      const i = idx.get(id);
      doms[i] = doms[i].filter(pred);
    };
    const bin = (a, b, check) => {
      if (a !== b) cons.push({ a: idx.get(a), b: idx.get(b), check });
    };

    for (const f of facts) {
      if (COMPONENT_OF[f.type] !== comp) continue;
      const g = f.args;
      switch (f.type) {
        case 'DISTRICT': filt(g.p, (v) => v === g.d); break;
        case 'NOT_DISTRICT': filt(g.p, (v) => v !== g.d); break;
        case 'SAME_DISTRICT': bin(g.p, g.q, (x, y) => x === y); break;
        case 'JOB': filt(g.p, (v) => v === g.j); break;
        case 'NOT_JOB': filt(g.p, (v) => v !== g.j); break;
        case 'JOB_CATEGORY': filt(g.p, (v) => CFG.jobByCode[v].category === g.c); break;
        case 'SAME_JOB': bin(g.p, g.q, (x, y) => x === y); break;
        case 'ENTRY_ORDER': filt(g.p, (v) => v === g.n); break;
        case 'ENTRY_OFFSET': bin(g.p, g.q, (x, y) => x === y + g.k); break;
        case 'ENTRY_BETWEEN':
          bin(g.p, g.q, (x, y) => x === y + 1);
          bin(g.p, g.r, (x, y) => x === y - 1);
          break;
        case 'ENTERED_BEFORE': bin(g.p, g.q, (x, y) => x < y); break;
        case 'ENTRY_MAX': filt(g.p, (v) => v <= g.n); break;
      }
    }
    if (comp === 'E') {
      // 入居順は通し番号なので全員異なる
      for (let i = 0; i < res.length; i++) {
        for (let j = i + 1; j < res.length; j++) cons.push({ a: i, b: j, check: (x, y) => x !== y });
      }
    }
    return { doms, cons };
  }

  // その時点で読める資料にある、身元に関わる事実（直接の事実＋観察事実）
  function readableIdFacts(sc, known) {
    return sc.facts.filter((f) => (ID_TYPES.has(f.type) || OBS_TYPES.has(f.type)) && (f.loc.doc !== 'log' || known.has(f.loc.owner)));
  }

  // ---------------------------------------------------------------- 文化のルールの学習（改修仕様 v0.2 §5）

  // 人物の属性値（目印の仮説の候補）。序列の帯は、その文化に帯の目印がある場合だけ候補にする
  function attrValues(sc, r) {
    const CFG = A.CONFIG;
    const out = [{ attr: 'district', value: r.district }, { attr: 'category', value: CFG.jobByCode[r.job_code].category }];
    const band = sc.culture && sc.culture.seniority.band;
    if (band && r.entry_order <= band.max_entry) out.push({ attr: 'band', value: band.max_entry });
    return out;
  }

  // 例の全員が共通して持つ属性値。ちょうど一つなら、その目印・呼び名が何を表すかを区別できる（紛らわしくない）
  function sharedAttr(sc, people) {
    let shared = attrValues(sc, people[0]);
    for (const r of people.slice(1)) {
      const mine = attrValues(sc, r);
      shared = shared.filter((x) => mine.some((y) => y.attr === x.attr && y.value === x.value));
    }
    return shared.length === 1 ? shared[0] : null;
  }

  // 読める観察事実のうち、既知の人物についての観察（＝例）から、学習できるルールを求める
  //  marker:<m>    目印 m ⇒ 属性値（区画・職能分類・序列の帯）
  //  nickname:<n>  呼び名 n ⇒ 区画
  //  ingroup       「うちの区画の」⇒ 同じ区画
  //  number        番号の習慣 ⇒ 入居順
  //  order:<c>     順番の習慣 c（列・席・呼び方・発言順）⇒ 入居順の前後
  function learnRules(sc, facts, known) {
    const rules = new Map();
    if (!sc.culture) return rules;
    const K = A.CONFIG.culture.ruleExamples;
    const byId = new Map(sc.residents.map((r) => [r.id, r]));
    const kn = (id) => known.has(id);
    const group = (pred, keyOf) => {
      const m = new Map();
      for (const f of facts) {
        if (!pred(f)) continue;
        const k = keyOf(f);
        if (!m.has(k)) m.set(k, []);
        m.get(k).push(f);
      }
      return m;
    };
    // 目印・呼び名：例の人物が K 人以上、反例がなく、紛らわしくない
    for (const [m, fs] of group((f) => f.type === 'OBS_MARKER' && kn(f.args.p), (f) => f.args.marker)) {
      const people = [...new Set(fs.map((f) => f.args.p))].map((id) => byId.get(id));
      if (people.length < K) continue;
      const a = sharedAttr(sc, people);
      if (a) rules.set(`marker:${m}`, { kind: 'marker', marker: m, ...a });
    }
    for (const [n, fs] of group((f) => f.type === 'OBS_OUTGROUP' && kn(f.args.p), (f) => f.args.nickname)) {
      const people = [...new Set(fs.map((f) => f.args.p))].map((id) => byId.get(id));
      if (people.length < K) continue;
      const a = sharedAttr(sc, people);
      if (a && a.attr === 'district') rules.set(`nickname:${n}`, { kind: 'nickname', nickname: n, ...a });
    }
    // 身内の言葉：既知の二人の組が K 組以上、すべて同じ区画
    {
      const pairs = new Set();
      let bad = false;
      for (const f of facts) {
        if (f.type !== 'OBS_INGROUP' || !kn(f.args.p) || !kn(f.args.q)) continue;
        if (byId.get(f.args.p).district !== byId.get(f.args.q).district) bad = true;
        pairs.add([f.args.p, f.args.q].sort().join('|'));
      }
      if (!bad && pairs.size >= K) rules.set('ingroup', { kind: 'ingroup' });
    }
    // 番号の習慣：既知の人物の番号が K 人以上、すべて入居順と一致
    {
      const people = new Set();
      let bad = false;
      for (const f of facts) {
        if (f.type !== 'OBS_NUMBER' || !kn(f.args.p)) continue;
        if (byId.get(f.args.p).entry_order !== f.args.n) bad = true;
        people.add(f.args.p);
      }
      if (!bad && people.size >= K) rules.set('number', { kind: 'number' });
    }
    // 順番の習慣：既知の二人の組が K 組以上、すべて入居順と一致
    const before = (f) => (f.type === 'OBS_HONORIFIC' && f.args.term === 'junior' ? [f.args.q, f.args.p] : [f.args.p, f.args.q]);
    for (const [c, fs] of group((f) => ['OBS_AHEAD', 'OBS_ADJACENT', 'OBS_HONORIFIC'].includes(f.type), (f) => f.args.custom)) {
      const pairs = new Set();
      let bad = false;
      for (const f of fs) {
        const [x, y] = before(f);
        if (!kn(x) || !kn(y)) continue;
        if (byId.get(x).entry_order >= byId.get(y).entry_order) bad = true;
        pairs.add([x, y].sort().join('|'));
      }
      if (!bad && pairs.size >= K) rules.set(`order:${c}`, { kind: 'order', custom: c });
    }
    return rules;
  }

  // 学習したルールを使って、観察事実を CSP の制約（直接の事実の形）に変換する
  function deriveFromObservations(facts, rules) {
    const out = [];
    const mk = (type, args) => ({ type, args });
    for (const f of facts) {
      const g = f.args;
      switch (f.type) {
        case 'OBS_WORK':
          out.push(mk('JOB', { p: g.p, j: g.j })); // 作業内容 ⇒ 職能は常識として扱う
          break;
        case 'OBS_MARKER': {
          const r = rules.get(`marker:${g.marker}`);
          if (!r) break;
          if (r.attr === 'district') out.push(mk('DISTRICT', { p: g.p, d: r.value }));
          else if (r.attr === 'category') out.push(mk('JOB_CATEGORY', { p: g.p, c: r.value }));
          else out.push(mk('ENTRY_MAX', { p: g.p, n: r.value }));
          break;
        }
        case 'OBS_OUTGROUP': {
          const r = rules.get(`nickname:${g.nickname}`);
          if (r) out.push(mk('DISTRICT', { p: g.p, d: r.value }));
          break;
        }
        case 'OBS_INGROUP':
          if (rules.has('ingroup')) out.push(mk('SAME_DISTRICT', { p: g.p, q: g.q }));
          break;
        case 'OBS_NUMBER':
          if (rules.has('number')) out.push(mk('ENTRY_ORDER', { p: g.p, n: g.n }));
          break;
        case 'OBS_AHEAD':
        case 'OBS_ADJACENT':
          // 列・席の隣接は「その時点の生存者の中で」の隣接なので、前後関係だけを使う
          if (rules.has(`order:${g.custom}`)) out.push(mk('ENTERED_BEFORE', { p: g.p, q: g.q }));
          break;
        case 'OBS_HONORIFIC':
          if (rules.has(`order:${g.custom}`)) out.push(g.term === 'junior' ? mk('ENTERED_BEFORE', { p: g.q, q: g.p }) : mk('ENTERED_BEFORE', { p: g.p, q: g.q }));
          break;
        default:
          if (ID_TYPES.has(f.type)) out.push(f); // 会話ログなどの直接の事実
      }
    }
    return out;
  }

  // §8.2 到達可能性の検証（ルールの学習を含むプレイヤーの推理の模擬）
  function simulateReach(sc) {
    const known = new Set(sc.initial_known_ids);
    const steps = [];
    const errors = [];
    const learned = new Map(); // ルール → 学習した段（0 は最初から読める資料で学習）
    for (let guard = 0; guard < 64; guard++) {
      const cand = [];
      sc.residents.forEach((r, i) => {
        if (!known.has(r.id)) cand.push(i);
      });
      const readable = readableIdFacts(sc, known);
      const rules = learnRules(sc, readable, known);
      for (const k of rules.keys()) if (!learned.has(k)) learned.set(k, steps.length);
      if (!cand.length) break;
      const facts = deriveFromObservations(readable, rules);
      const uniq = {};
      for (const comp of ['D', 'E', 'J']) {
        const { doms, cons } = buildCSP(sc, comp, facts, known);
        const r = uniqueVars(doms, cons, cand);
        if (!r) {
          errors.push(`手がかり事実が矛盾しています（${comp}）`);
          return { steps, known, reachable: false, errors, rules: learned };
        }
        for (const i of r.uniq) {
          if (r.sol[i] !== valueOf(sc.residents[i], comp)) errors.push(`一意解が真相と食い違っています: ${sc.residents[i].id} (${comp})`);
        }
        uniq[comp] = r.uniq;
      }
      const decoded = cand.filter((i) => uniq.D.has(i) && uniq.E.has(i) && uniq.J.has(i)).map((i) => sc.residents[i].id);
      if (!decoded.length) break;
      decoded.forEach((id) => known.add(id));
      steps.push(decoded);
    }
    return { steps, known, reachable: known.size === sc.residents.length && !errors.length, errors, rules: learned };
  }

  // ---------------------------------------------------------------- 死因・生死・安全判定（§8.3）

  function deriveOutcome(sc) {
    const CFG = A.CONFIG;
    const facts = sc.facts;
    const logs = sc.documents.chip_logs;
    const now = sc.shelter.now_day;
    const lastDay = (id) => {
      const es = logs[id] || [];
      return es.length ? A.util.dayOf(es[es.length - 1].t) : 0;
    };
    const certain = facts.filter((f) => f.certainty === 'certain');
    const shiftByLog = {};
    const shiftByWriter = {};
    certain.filter((f) => f.type === 'STYLE_SHIFT').forEach((f) => {
      shiftByLog[f.args.log] = f.args.writer;
      shiftByWriter[f.args.writer] = f.args.log;
    });

    const people = {};
    for (const r of sc.residents) {
      const signs = certain.filter((f) => f.type === 'DEATH_SIGN' && f.args.p === r.id);
      const dead = signs.length > 0;
      const aliveOwn = lastDay(r.id) >= now && !shiftByLog[r.id];
      const aliveShift = !!shiftByWriter[r.id] && lastDay(shiftByWriter[r.id]) >= now;
      const alive = aliveOwn || aliveShift;
      const status = dead && !alive ? 'dead' : alive && !dead ? 'alive' : 'ambiguous';
      let causes = null;
      let killers = [];
      if (dead) {
        causes = Object.keys(CFG.causes);
        for (const s of signs) causes = causes.filter((c) => s.args.causes.includes(c));
        killers = [...new Set(certain.filter((f) => f.type === 'KILLED_BY' && f.args.p === r.id).map((f) => f.args.k))];
      }
      people[r.id] = { status, causes, killers };
    }

    // 外部ハッチの記録：認証なしの開放の最後が「外側から」なら、侵入者はまだ中にいる
    const unauth = certain.filter((f) => f.type === 'HATCH' && !f.args.auth).sort((a, b) => a.args.t - b.args.t);
    const intruder = unauth.length ? { present: unauth[unauth.length - 1].args.side === 'outside' } : null;

    const reasons = [];
    const aliveIds = Object.keys(people).filter((id) => people[id].status === 'alive');
    const allKillers = new Set();
    let anyCause = new Set();
    for (const id in people) {
      const p = people[id];
      if (p.status !== 'dead' || !p.causes || p.causes.length !== 1) continue;
      anyCause.add(p.causes[0]);
      if (p.causes[0] === 'murder') p.killers.forEach((k) => allKillers.add(k));
    }
    if (aliveIds.some((id) => allKillers.has(id))) reasons.push('潜伏者');
    if (anyCause.has('infection')) reasons.push('感染');
    if (anyCause.has('radiation')) reasons.push('汚染');
    if (intruder && intruder.present) reasons.push('侵入者');
    const result = reasons.length ? 'danger' : anyCause.has('starvation') ? 'worthless' : 'safe';
    return { people, intruder, verdict: { result, reasons } };
  }

  function verifyOutcome(sc) {
    const errors = [];
    const derived = deriveOutcome(sc);
    const deathOf = new Map(sc.deaths.map((d) => [d.victim, d]));
    for (const r of sc.residents) {
      const p = derived.people[r.id];
      if (p.status !== r.status) {
        errors.push(`${r.id}: 生死が一意に定まらない／真相と不一致（導出=${p.status}, 真相=${r.status}）`);
        continue;
      }
      if (r.status !== 'dead') continue;
      const d = deathOf.get(r.id);
      if (!p.causes || p.causes.length !== 1 || p.causes[0] !== d.cause) {
        errors.push(`${r.id}: 死因が一意に定まらない（候補=${(p.causes || []).join(',')}, 真相=${d.cause}）`);
      }
      if (d.cause === 'murder' && (p.killers.length !== 1 || p.killers[0] !== d.killer)) {
        errors.push(`${r.id}: 加害者が一意に定まらない（候補=${p.killers.join(',')}, 真相=${d.killer}）`);
      }
    }
    const truthIntruder = sc.current_state.intruder;
    if (!!truthIntruder !== !!derived.intruder || (truthIntruder && truthIntruder.present !== derived.intruder.present)) {
      errors.push('侵入者の所在が一意に定まらない');
    }
    const tv = sc.current_state.verdict;
    if (tv.result !== derived.verdict.result || tv.reasons.join() !== derived.verdict.reasons.join()) {
      errors.push(`安全判定が真相と不一致（導出=${derived.verdict.result}/${derived.verdict.reasons.join(',')}）`);
    }
    return { derived, errors };
  }

  // ---------------------------------------------------------------- 文章の往復検証（簡易）

  function verifyNarration(sc) {
    const errors = [];
    const factById = new Map(sc.facts.map((f) => [f.id, f]));
    const check = (where, facts, rendered, text, writer) => {
      for (const fid of facts) {
        if (!rendered.includes(fid)) errors.push(`${where}: 手がかり事実 ${fid} が文章化されていない`);
        const f = factById.get(fid);
        const p = f && f.args && f.args.p;
        if (p && p !== writer && f.type !== 'SIGNAL_LOST' && !text.includes(`{P:${p}}`)) {
          errors.push(`${where}: ${fid} の対象人物が本文に現れない`);
        }
      }
      if (writer && text.includes(`{P:${writer}}`)) errors.push(`${where}: 書き手本人の ID が本文に含まれている`);
    };
    for (const [owner, entries] of Object.entries(sc.documents.chip_logs)) {
      entries.forEach((e, i) => {
        if (e.deleted) {
          if (e.facts.length) errors.push(`${owner}#${i}: 削除済みエントリに手がかりがある`);
          return;
        }
        check(`${owner}#${i}`, e.facts, e.rendered, e.text, e.writer);
      });
    }
    sc.documents.counselor_dialogues.forEach((e, i) => {
      check(`dialogue#${i}`, e.facts, e.rendered, e.lines.map((l) => l.text).join(''), null);
    });
    // 事実の所在とエントリの対応
    for (const f of sc.facts) {
      if (f.loc.doc === 'log') {
        const e = (sc.documents.chip_logs[f.loc.owner] || [])[f.loc.index];
        if (!e || !e.facts.includes(f.id)) errors.push(`${f.id}: 所在エントリが見つからない`);
      }
    }
    return { errors };
  }

  // ---------------------------------------------------------------- 物語の正本の構造検査（LLM に渡す前の前提）

  const EXCLUSIVE_KINDS = ['work', 'quarters'];

  // 全エントリについて、場面カードが正本と食い違っていないかを確かめる。
  // 矛盾した場面カードからは、LLM が何度書き直しても矛盾のない文章は作れない。
  function verifyCanon(sc) {
    const errors = [];
    const byEntry = new Map(); // "<owner>#<index>" → そのエントリの場面カードの問題
    if (!sc.story || !sc.story.scenes) return { errors, byEntry }; // 正本を持たない古い形式
    const scenes = new Map(sc.story.scenes.map((s) => [s.id, s]));
    const deathT = new Map(sc.deaths.map((d) => [d.victim, d.t]));
    const factById = new Map(sc.facts.map((f) => [f.id, f]));
    const day = (t) => A.util.dayOf(t);
    // 一人が同じ時間帯に二つの場所にいない／死後の場面にいない
    const where = new Map();
    for (const s of scenes.values()) {
      for (const id of s.participants) {
        if (EXCLUSIVE_KINDS.includes(s.kind)) {
          const k = `${id}|${day(s.t)}|${s.kind}`;
          if (where.has(k) && where.get(k) !== s.id) errors.push(`正本：${id} が同じ時間帯に二つの場面（${where.get(k)}, ${s.id}）にいる`);
          where.set(k, s.id);
        }
        if (deathT.has(id) && s.t > deathT.get(id)) errors.push(`正本：死亡後の ${id} が場面 ${s.id} にいる`);
      }
    }
    for (const [owner, entries] of Object.entries(sc.documents.chip_logs)) {
      entries.forEach((e, i) => {
        if (e.deleted) return;
        const where2 = `${owner}#${i}`;
        const n0 = errors.length;
        const s = scenes.get(e.scene);
        if (!s) {
          errors.push(`場面カード：${where2} の場面 ${e.scene} が正本にない`);
          return;
        }
        // 場面カードの場所＝正本上のその時刻の書き手の所在
        if (!s.participants.includes(e.writer)) errors.push(`場面カード：${where2} の書き手 ${e.writer} が場面 ${s.id}（${s.place_name}）にいない`);
        if (e.t < s.t) errors.push(`場面カード：${where2} が場面 ${s.id} より前の時刻に書かれている`);
        for (const eid of e.perceived || []) {
          const ev = s.events.find((x) => x.id === eid);
          const sees = ev && (ev.perceivers === 'all' ? s.participants.includes(e.writer) : ev.perceivers.includes(e.writer));
          if (!sees) errors.push(`場面カード：${where2} の書き手が見聞きしていない出来事 ${eid} を渡している`);
        }
        // observe の手がかりの対象が、その場面にいて、書き手が見聞きした出来事として正本にある
        for (const fid of e.facts) {
          const f = factById.get(fid);
          // LLM の文章から書き戻した手がかり（extra）は、推理の段の検査で別に確かめているので対象外
          if (!f || f.mode !== 'observe' || f.extra) continue;
          const people = [f.args.p, ['SAME_JOB', 'OBS_AHEAD', 'OBS_ADJACENT'].includes(f.type) ? f.args.q : null].filter((id) => id && id !== e.writer);
          for (const id of people) if (!s.participants.includes(id)) errors.push(`場面カード：${where2} の手がかり ${fid}（observe）の対象 ${id} が場面 ${s.id} にいない`);
          if (!s.events.some((ev) => (ev.facts || []).includes(fid) && (e.perceived || []).includes(ev.id))) {
            errors.push(`場面カード：${where2} の手がかり ${fid}（observe）が、書き手の見聞きした出来事として正本にない`);
          }
        }
        if (errors.length > n0) byEntry.set(where2, errors.slice(n0));
      });
    }
    return { errors, byEntry };
  }

  // 死因の分類の不変条件：徴候・死因・加害者の語彙が生成器・徴候表・検証器で一致していること
  function verifyCauseInvariants(sc) {
    const errors = [];
    const CFG = A.CONFIG;
    const deathOf = new Map(sc.deaths.map((d) => [d.victim, d]));
    const ids = new Set(sc.residents.map((r) => r.id));
    for (const f of sc.facts) {
      if (f.type !== 'DEATH_SIGN') continue;
      const d = deathOf.get(f.args.p);
      if (!d) errors.push(`不変条件：${f.id} の対象 ${f.args.p} は死者ではない`);
      else if (!f.args.causes.includes(d.cause)) errors.push(`不変条件：${f.id}（${f.args.sign}）の死因候補 ${f.args.causes.join(',')} が真の死因 ${d.cause} を含まない`);
    }
    for (const d of sc.deaths) {
      for (const sg of d.signs || []) {
        const def = CFG.signs[sg];
        if (!def || !def.causes.includes(d.cause)) errors.push(`不変条件：${d.victim} の徴候 ${sg} が死因 ${d.cause} と両立しない`);
      }
      if (d.cause === 'intruder' && d.killer) errors.push(`不変条件：侵入者による死 ${d.victim} に住人の加害者 ${d.killer} が付いている`);
      if (d.cause === 'murder' && !ids.has(d.killer)) errors.push(`不変条件：殺人 ${d.victim} の加害者が住人ではない`);
      if (!['murder', 'intruder'].includes(d.cause) && d.killer) errors.push(`不変条件：${d.cause} の死 ${d.victim} に加害者が付いている`);
    }
    return { errors };
  }

  // ---------------------------------------------------------------- 手がかりの形（改修仕様 v0.2 §4・§11 第1段階）

  function verifyClueForm(sc, reach) {
    const CFG = A.CONFIG;
    const errors = [];
    if (!sc.culture) return { errors };
    const factById = new Map(sc.facts.map((f) => [f.id, f]));
    for (const [owner, entries] of Object.entries(sc.documents.chip_logs)) {
      entries.forEach((e, i) => {
        const fs = e.facts.map((fid) => factById.get(fid));
        const direct = fs.filter((f) => DIRECT_TYPES.has(f.type));
        if (direct.length) errors.push(`主観ログ ${owner}#${i} に答えの形の事実（${direct.map((f) => f.type).join(',')}）がある`);
        const obs = fs.filter((f) => OBS_TYPES.has(f.type)).length;
        if (obs > CFG.scale.idFactsPerEntry) errors.push(`主観ログ ${owner}#${i} の身元の観察事実が ${obs} 個（上限 ${CFG.scale.idFactsPerEntry}）`);
      });
      const daily = entries.filter((e) => e.kind === 'daily').length;
      if (daily < CFG.scale.dailyEntriesMin) errors.push(`${owner} の日常のエントリが ${daily} 件（最低 ${CFG.scale.dailyEntriesMin}）`);
    }
    const direct = sc.facts.filter((f) => f.loc.doc === 'dialogue' && DIRECT_TYPES.has(f.type)).length;
    if (direct > CFG.culture.directFactsInDialogue) errors.push(`会話ログの直接の事実が ${direct} 件（上限 ${CFG.culture.directFactsInDialogue}）`);
    if (reach.rules && reach.rules.size < 2) errors.push(`学習される文化のルールが ${reach.rules.size} 個（2個以上必要）`);
    return { errors };
  }

  // ---------------------------------------------------------------- まとめ

  function verify(sc) {
    const reach = simulateReach(sc);
    const outcome = verifyOutcome(sc);
    const narration = verifyNarration(sc);
    const canon = verifyCanon(sc);
    const invariants = verifyCauseInvariants(sc);
    const clueForm = verifyClueForm(sc, reach);
    const errors = [];
    if (!reach.reachable) {
      const missing = sc.residents.filter((r) => !reach.known.has(r.id)).map((r) => r.id);
      errors.push(...reach.errors);
      if (missing.length) errors.push(`到達不能な住人: ${missing.join(', ')}`);
    }
    errors.push(...outcome.errors, ...narration.errors, ...canon.errors, ...invariants.errors, ...clueForm.errors);
    return {
      pass: errors.length === 0,
      reach: {
        reachable: reach.reachable,
        steps: reach.steps,
        perStep: reach.steps.map((s) => s.length),
        rules: [...(reach.rules || new Map()).entries()].map(([rule, step]) => ({ rule, step })),
      },
      outcome: outcome.derived,
      errors,
    };
  }

  A.Solver = { solve, uniqueVars, buildCSP, ID_TYPES, OBS_TYPES, DIRECT_TYPES, learnRules, deriveFromObservations };
  A.Verifier = { verify, simulateReach, deriveOutcome, verifyCanon, verifyCauseInvariants };
})(window.ASARIYA = window.ASARIYA || {});
