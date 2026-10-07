// シナリオ生成器（設計書 §6 のパイプライン）
//  [1] 住人 → [2] 関係 → [3] 事件（トリック適用） → [4] 現在の状態と安全判定
//  → [6] 解錠グラフ（ID の手がかり配置）＋到達可能性 → [5] 物語の正本と各エントリ（story.js）
//  → [8] 文章化（narrator.js） → [7] 検証（solver.js） → [9] JSON
// 検証に失敗したら、シードから派生させた別の乱数系列で最初からやり直す（再現性は保たれる）。
(function (A) {
  'use strict';
  const CFG = A.CONFIG;
  const { DAY, pad2, tAbs, dayOf, fmtT, range } = A.util;

  function generate(seed, opts = {}) {
    const maxAttempts = opts.maxAttempts || 40;
    const failures = [];
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const rng = new A.RNG(A.mixSeed(seed, attempt));
      let sc;
      try {
        sc = build(rng, seed);
      } catch (e) {
        failures.push(String(e && e.message ? e.message : e));
        continue;
      }
      const report = A.Verifier.verify(sc);
      if (report.pass) {
        sc.meta.attempts = attempt + 1;
        sc.meta.difficulty = { steps: report.reach.steps.length, per_step: report.reach.perStep };
        return { scenario: sc, report, failures };
      }
      failures.push(report.errors.slice(0, 3).join(' / '));
    }
    const err = new Error(`シード ${seed}: ${maxAttempts} 回試行しても検証を通過するシナリオを生成できませんでした`);
    err.failures = failures;
    throw err;
  }

  function build(rng, seed) {
    const ctx = newContext(rng, seed);
    genResidents(ctx);
    genRelations(ctx);
    A.Culture.build(ctx);
    genIncident(ctx);
    A.Tricks.applyAll(ctx);
    finalizeIncident(ctx);
    deriveState(ctx);
    designIdentityClues(ctx);
    A.Story.build(ctx);
    A.Narrator.narrate(ctx);
    return assemble(ctx);
  }

  // ------------------------------------------------------------------ context

  function newContext(rng, seed) {
    const ctx = {
      rng,
      seed,
      residents: [],
      byId: new Map(),
      relations: [],
      deaths: [],
      deathOf: new Map(),
      tricks: [],
      facts: [],
      logs: {},
      dialogue: [],
      hatch: [],
      transplant: null,
      intruder: null,
    };
    ctx.aliveAt = (id, t) => {
      const d = ctx.deathOf.get(id);
      return !d || d.t > t;
    };
    // その時刻に本人として行動・記録できるか（チップを移植した加害者は、移植後は本人として記録されない）
    ctx.canAct = (id, t) =>
      !!id && ctx.aliveAt(id, t) && !(ctx.transplant && ctx.transplant.carrier === id && t >= ctx.transplant.t);
    ctx.endT = (id) => {
      const d = ctx.deathOf.get(id);
      if (d) return d.t;
      if (ctx.transplant && ctx.transplant.carrier === id) return ctx.transplant.t;
      return tAbs(ctx.timeline.nowDay, DAY - 1);
    };
    ctx.addFact = (type, args, certainty, loc) => {
      const f = { id: `f${ctx.facts.length + 1}`, type, args, certainty, loc: Object.assign({}, loc) };
      ctx.facts.push(f);
      return f;
    };
    ctx.pickKiller = (d, preferred = [], exclude = []) => {
      const tr = ctx.transplant;
      const alive = ctx.residents
        .map((r) => r.id)
        .filter((id) => id !== d.victim && !exclude.includes(id) && ctx.canAct(id, d.t))
        .filter((id) => !(tr && tr.carrier === id && d.t > ctx.deathOf.get(tr.victim).t));
      if (!alive.length) return null;
      const prev = preferred.filter((k) => alive.includes(k));
      if (prev.length && rng.chance(0.6)) return rng.pick(prev);
      // 文化と事件の連動：被害者の区画を見下している・対立している区画の住人を、加害者に選びやすくする
      const cu = ctx.culture;
      if (cu) {
        const vd = ctx.byId.get(d.victim).district;
        const hostile = alive.filter((id) => {
          const kd = ctx.byId.get(id).district;
          return kd !== vd && cu.district_relations.some((r) => (r.type === 'looks_down' && r.a === kd && r.b === vd) || (r.type === 'rivalry' && ((r.a === kd && r.b === vd) || (r.a === vd && r.b === kd))));
        });
        if (hostile.length && rng.chance(0.5)) return rng.pick(hostile);
      }
      const rivals = ctx.relations
        .filter((x) => x.type === 'rival' && (x.a === d.victim || x.b === d.victim))
        .map((x) => (x.a === d.victim ? x.b : x.a))
        .filter((id) => alive.includes(id));
      if (rivals.length && rng.chance(0.6)) return rng.pick(rivals);
      return rng.pick(alive);
    };
    ctx.pickWitness = (d, exclude = []) => {
      for (const r of rng.shuffle(ctx.residents)) {
        if (r.id === d.victim || r.id === d.killer || exclude.includes(r.id)) continue;
        const t = d.t + rng.int(20, 300);
        if (ctx.canAct(r.id, t + 5)) return { id: r.id, t };
      }
      return null;
    };
    ctx.sanitize = () => finalizeIncident(ctx);
    return ctx;
  }

  // ------------------------------------------------------------------ [1] 住人

  function genResidents(ctx) {
    const { rng } = ctx;
    const S = CFG.scale;
    const n = rng.int(...S.residents);
    const k = rng.int(...S.districts);
    const districts = CFG.districtLetters.slice(0, k);
    const nC = rng.int(...S.counselors);
    const maxEntry = n + rng.int(...S.entryGaps);

    // 入居順：1..maxEntry から n 個（最大値は必ず使う）。残りは欠番。
    const entries = rng.shuffle(rng.sample(range(1, maxEntry - 1), n - 1).concat([maxEntry]));

    const jobs = [];
    for (let i = 0; i < nC; i++) jobs.push(CFG.counselorCode);
    const pool = CFG.jobs.filter((j) => j.weight > 0).map((j) => [j.code, j.weight]);
    let recorders = 0;
    while (jobs.length < n) {
      const c = rng.weighted(pool);
      if (c === 52 && recorders++ >= 1) continue;
      jobs.push(c);
    }
    if (!jobs.includes(42) && rng.chance(0.7)) jobs[rng.int(nC, n - 1)] = 42;
    const jobS = rng.shuffle(jobs);

    // 区画：文化の役割と、職能・入居の早さを確率的に連動させて割り当てる（必ず一致はさせない）。各区画に最低2人
    ctx.districtRoles = A.Culture.assignRoles(ctx, districts);
    const distS = jobS.map((j, i) => rng.weighted(districts.map((d) => [d, A.Culture.districtWeight(ctx.districtRoles[d], j, (entries[i] - 1) / maxEntry)])));
    for (const d of districts) {
      while (distS.filter((x) => x === d).length < 2) {
        const counts = districts.map((x) => [x, distS.filter((y) => y === x).length]).sort((a, b) => b[1] - a[1]);
        const from = counts[0][0];
        const idx = rng.pick(distS.map((x, i) => (x === from ? i : -1)).filter((i) => i >= 0));
        distS[idx] = d;
      }
    }

    const surnames = rng.sample(CFG.names.surnames, n);
    const givens = rng.sample(CFG.names.given, n);
    const tics = rng.sample(CFG.voices.tics, n);
    const tokens = new Set();
    const alphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    while (tokens.size < n) {
      let s = '';
      for (let i = 0; i < 4; i++) s += alphabet[rng.int(0, alphabet.length - 1)];
      tokens.add(s);
    }
    const tokenList = [...tokens];

    for (let i = 0; i < n; i++) {
      const d = distS[i];
      const e = entries[i];
      const j = jobS[i];
      const isC = j === CFG.counselorCode;
      const r = {
        id: `${d}-${pad2(e)}-${j}`,
        token: tokenList[i],
        name: surnames[i] + givens[i],
        district: d,
        entry_order: e,
        job_code: j,
        is_counselor: isC,
        profile: {
          age: isC ? rng.int(38, 70) : rng.int(16, 68),
          personality: rng.pick(CFG.personalities),
          pronoun: rng.weighted(CFG.voices.pronouns),
          tic: tics[i],
          style: rng.weighted(CFG.voices.styles),
        },
      };
      ctx.residents.push(r);
      ctx.byId.set(r.id, r);
    }
    ctx.districts = districts;
    ctx.maxEntry = maxEntry;
    // 人物設定の拡張とシェルター文化は、関係の生成の後で作る（関係の呼び方を決めるため）
    ctx.shelterName = `第${rng.int(3, 48)}シェルター「${rng.pick(CFG.shelterNames)}」`;
  }

  // ------------------------------------------------------------------ [2] 関係

  function genRelations(ctx) {
    const { rng } = ctx;
    const ids = ctx.residents.map((r) => r.id);
    const want = Math.round(ids.length * 0.7);
    const seen = new Set();
    for (let tries = 0; tries < 200 && ctx.relations.length < want; tries++) {
      const [a, b] = rng.sample(ids, 2);
      const key = [a, b].sort().join('|');
      if (seen.has(key)) continue;
      seen.add(key);
      const type = rng.weighted(CFG.relationTypes);
      const hiddenable = type === 'lover' || type === 'rival';
      ctx.relations.push({ a, b, type, known_to_ai: hiddenable ? rng.chance(0.4) : true });
    }
  }

  // ------------------------------------------------------------------ [3] 事件

  function genIncident(ctx) {
    const { rng } = ctx;
    const S = CFG.scale;
    const lastDeathDay = rng.int(...S.period);
    // 異変前の日常（手がかりの場面）を2日以上とれるよう、異変は D03 以降に始める
    const crisisDay = rng.int(3, Math.min(4, lastDeathDay - 3));
    const nowDay = lastDeathDay + rng.int(2, 4);
    ctx.timeline = { crisisDay, lastDeathDay, nowDay };
    ctx.crisis = rng.weighted(Object.entries(CFG.crises).map(([k, c]) => [k, c.weight]));
    const crisis = CFG.crises[ctx.crisis];

    const nS = rng.weighted(S.survivorWeights);
    const order = rng.shuffle(ctx.residents.map((r) => r.id));
    ctx.survivors = order.slice(0, nS);
    const deaths = order.slice(nS).map((victim) => ({ victim, day: rng.int(crisisDay + 1, lastDeathDay), minute: rng.int(0, DAY - 1) }));
    let maxI = 0;
    deaths.forEach((d, i) => {
      if (d.day > deaths[maxI].day) maxI = i;
    });
    deaths[maxI].day = lastDeathDay;
    deaths.forEach((d) => (d.t = tAbs(d.day, d.minute)));
    deaths.sort((a, b) => a.t - b.t);
    for (let i = 1; i < deaths.length; i++) if (deaths[i].t <= deaths[i - 1].t) deaths[i].t = deaths[i - 1].t + 1;
    // 文化と事件の連動（改修仕様 v0.2 §6.3）：序列が厳格なシェルターの飢餓では、入居番号の大きい住人から先に死にやすい
    // （配給が古株から回るため。死んだ順番が入居順の手がかりになる）
    if (ctx.crisis === 'famine' && ctx.culture && ctx.culture.seniority.strength === 'strict') {
      const byNewest = deaths
        .map((d) => ({ victim: d.victim, key: ctx.byId.get(d.victim).entry_order + rng.int(-2, 2) }))
        .sort((a, b) => b.key - a.key);
      deaths.forEach((d, i) => (d.victim = byNewest[i].victim));
    }
    ctx.deaths = deaths;
    deaths.forEach((d) => ctx.deathOf.set(d.victim, d));

    const killers = [];
    deaths.forEach((d, i) => {
      Object.assign(d, {
        killer: null, trick: null, recorded_cause: null, finalDeleted: false, dark: false,
        killerInFinal: rng.chance(0.65), witness: null,
      });
      let cause = i === 0 ? crisis.primary : rng.weighted(crisis.causes);
      if (cause === 'murder') {
        const k = ctx.pickKiller(d, killers);
        if (k) {
          d.killer = k;
          if (!killers.includes(k)) killers.push(k);
        } else cause = crisis.primary === 'murder' ? 'accident' : crisis.primary;
      }
      d.cause = cause;
    });
  }

  // トリック適用後の整合性回復（死者・移植後の加害者は犯行できない）
  function finalizeIncident(ctx) {
    const killers = ctx.deaths.filter((d) => d.killer).map((d) => d.killer);
    const tr = ctx.transplant;
    for (const d of ctx.deaths) {
      if (d.cause !== 'murder') {
        d.killer = null;
        continue;
      }
      if (d.trick) continue;
      const bad =
        !d.killer || d.killer === d.victim || !ctx.canAct(d.killer, d.t) ||
        (tr && tr.carrier === d.killer && d.t > ctx.deathOf.get(tr.victim).t);
      if (bad) {
        d.killer = ctx.pickKiller(d, killers);
        if (!d.killer) d.cause = 'accident';
      }
    }
    for (const d of ctx.deaths) d.t = Math.round(d.t);
  }

  // ------------------------------------------------------------------ [4] 現在の状態

  function deriveState(ctx) {
    const { rng } = ctx;
    const survivors = ctx.residents.filter((r) => !ctx.deathOf.has(r.id)).map((r) => r.id);
    const causes = new Set(ctx.deaths.map((d) => d.cause));
    const supplies = causes.has('starvation') ? 'depleted' : ctx.crisis === 'famine' ? 'low' : rng.pick(['low', 'sufficient']);
    const killerIds = new Set(ctx.deaths.filter((d) => d.cause === 'murder').map((d) => d.killer));
    const reasons = [];
    const threats = [];
    if (survivors.some((id) => killerIds.has(id))) {
      reasons.push('潜伏者');
      threats.push('killer_in_hiding');
    }
    if (causes.has('infection')) {
      reasons.push('感染');
      threats.push('infection');
    }
    if (causes.has('radiation')) {
      reasons.push('汚染');
      threats.push('contamination');
    }
    if (ctx.intruder && ctx.intruder.present) {
      reasons.push('侵入者');
      threats.push('intruder_inside');
    }
    const result = reasons.length ? 'danger' : supplies === 'depleted' ? 'worthless' : 'safe';
    ctx.state = { survivors, supplies, hidden_threats: threats, verdict: { result, reasons } };
  }

  // ------------------------------------------------------------------ [6] 解錠グラフ（改修仕様 v0.2 §6）

  // 住人を「段」に分け、各段の人物の区画・入居順・職能を、それより前の段で学習できる文化のルールと観察事実で
  // 読み解けるようにする。主観ログには答えの形の事実を置かない（観察事実だけ）。
  //  - ルールは、既知の人物についての例（アンカー）を置いて、学習できることを確かめてから使う
  //  - 区画：身内の言葉（うちの区画の）／区画の目印／区画の呼び名。どれも使えないときだけ会話ログの直接の事実（上限あり）
  //  - 職能：作業の観察（作業内容 ⇒ 職能は常識）
  //  - 入居順：番号の習慣。ときどき、順番の習慣で前後の既知の人物に挟ませる
  function designIdentityClues(ctx) {
    const { rng } = ctx;
    const cu = ctx.culture;
    const K = CFG.culture.ruleExamples;
    const counselors = ctx.residents.filter((r) => r.is_counselor);
    const known = counselors.slice();
    const knownSet = new Set(known.map((r) => r.id));
    const remaining = rng.shuffle(ctx.residents.filter((r) => !r.is_counselor));
    let dialogueLeft = CFG.culture.directFactsInDialogue;
    const view = reachView(ctx);
    const log = (w) => ({ doc: 'log', owner: w.id });
    const obs = (type, args, writer) => ctx.addFact(type, args, 'certain', log(writer));
    const temp = (type, args, writer) => ({ type, args, certainty: 'certain', loc: log(writer) });
    const rulesWith = (extra = []) => A.Solver.learnRules(view, ctx.facts.concat(extra), knownSet);
    const anyWriter = (p, pred = () => true) => {
      const ws = known.filter((w) => w.id !== p.id && pred(w));
      return ws.length ? rng.pick(ws) : null;
    };
    // 仮のアンカーで学習できると確かめてから、正式に置く
    const commitIfLearned = (ruleKey, extra) => {
      if (rulesWith().has(ruleKey)) return true;
      if (!rulesWith(extra).has(ruleKey)) return false;
      for (const f of extra) ctx.addFact(f.type, f.args, 'certain', f.loc);
      return true;
    };

    // --- 番号の習慣：相談役が自分の番号を書く（最初から読める例）
    for (const c of counselors) obs('OBS_NUMBER', { p: c.id, n: c.entry_order }, c);

    // --- 身内の言葉：同じ区画の既知の二人の組を K 組
    const ensureIngroup = () => {
      const pairs = [];
      for (let i = 0; i < known.length; i++) {
        for (let j = i + 1; j < known.length; j++) if (known[i].district === known[j].district) pairs.push([known[i], known[j]]);
      }
      if (pairs.length < K) return false;
      const extra = rng.sample(pairs, K).map(([x, y]) => (rng.chance(0.5) ? temp('OBS_INGROUP', { p: y.id, q: x.id }, x) : temp('OBS_INGROUP', { p: x.id, q: y.id }, y)));
      return commitIfLearned('ingroup', extra);
    };
    // --- 区画の目印：その区画の既知の住人を例にする（紛らわしくなければ学習できる）
    const ensureMarker = (m, d) => {
      const ex = known.filter((r) => r.district === d);
      if (ex.length < K) return false;
      const extra = ex.map((x) => {
        const w = rng.chance(0.5) ? x : anyWriter(x) || x; // 本人の記述（私の腕章）か、他の既知の住人の記述
        return temp('OBS_MARKER', { p: x.id, marker: m }, w);
      });
      return commitIfLearned(`marker:${m}`, extra);
    };
    // --- 区画の呼び名：その区画の既知の住人を、区画外の既知の住人が呼び名で呼ぶ
    const ensureNickname = (n, d) => {
      const ex = known.filter((r) => r.district === d);
      if (ex.length < K) return false;
      const extra = [];
      for (const x of ex) {
        const w = anyWriter(x, (w) => w.district !== d);
        if (!w) return false;
        extra.push(temp('OBS_OUTGROUP', { p: x.id, nickname: n, q: w.id }, w));
      }
      return commitIfLearned(`nickname:${n}`, extra);
    };
    // --- 順番の習慣：x が y より先（入居順）。誰が書くかは習慣ごとに決まる
    const orderFact = (c, x, y) => {
      const writerOf = (cands) => cands.find((r) => knownSet.has(r.id)) || null;
      if (c === 'honorific') {
        if (knownSet.has(y.id)) return { type: 'OBS_HONORIFIC', args: { p: x.id, q: y.id, term: 'senior', custom: c }, writer: y };
        if (knownSet.has(x.id)) return { type: 'OBS_HONORIFIC', args: { p: y.id, q: x.id, term: 'junior', custom: c }, writer: x };
        return null;
      }
      const type = c === 'seat_order' ? 'OBS_ADJACENT' : 'OBS_AHEAD';
      const w = writerOf([y, x]) || anyWriter(x, (w) => w.id !== y.id);
      return w ? { type, args: { p: x.id, q: y.id, custom: c }, writer: w } : null;
    };
    const sorted = ctx.residents.slice().sort((a, b) => a.entry_order - b.entry_order);
    const consecutive = (x, y) => sorted.indexOf(y) - sorted.indexOf(x) === 1; // 席の隣（異変前は全員が生きている）
    const ensureOrder = (c) => {
      const pairs = [];
      for (const x of known) for (const y of known) if (x.entry_order < y.entry_order && (c !== 'seat_order' || consecutive(x, y))) pairs.push([x, y]);
      if (pairs.length < K) return false;
      const extra = rng
        .sample(pairs, K)
        .map(([x, y]) => orderFact(c, x, y))
        .filter(Boolean)
        .map((o) => temp(o.type, o.args, o.writer));
      return extra.length >= K && commitIfLearned(`order:${c}`, extra);
    };

    const planDistrict = (p) => {
      const d = p.district;
      for (const method of rng.shuffle(['ingroup', 'marker', 'nickname'])) {
        if (method === 'ingroup') {
          const w = anyWriter(p, (w) => w.district === d);
          if (w && ensureIngroup()) {
            obs('OBS_INGROUP', { p: p.id, q: w.id }, w);
            return true;
          }
        } else if (method === 'marker') {
          for (const m of rng.shuffle(cu.districts[d].markers)) {
            if (ensureMarker(m, d)) {
              obs('OBS_MARKER', { p: p.id, marker: m }, anyWriter(p));
              return true;
            }
          }
        } else {
          const w = anyWriter(p, (w) => w.district !== d);
          const n = cu.districts[d].nickname;
          if (w && ensureNickname(n, d)) {
            obs('OBS_OUTGROUP', { p: p.id, nickname: n, q: w.id }, w);
            return true;
          }
        }
      }
      return false;
    };
    const planJob = (p) => obs('OBS_WORK', { p: p.id, j: p.job_code }, anyWriter(p));
    const planEntry = (p) => {
      const e = p.entry_order;
      const a = known.find((r) => r.entry_order === e - 1);
      const b = known.find((r) => r.entry_order === e + 1);
      // ときどき、順番の習慣で前後の既知の人物に挟ませる（番号の差が2なので一意に決まる）
      if (a && b && rng.chance(0.35)) {
        for (const c of rng.shuffle(cu.seniority.order_customs.slice())) {
          if (!ensureOrder(c)) continue;
          const o1 = orderFact(c, a, p);
          const o2 = orderFact(c, p, b);
          if (o1 && o2) {
            obs(o1.type, o1.args, o1.writer);
            obs(o2.type, o2.args, o2.writer);
            return;
          }
        }
      }
      obs('OBS_NUMBER', { p: p.id, n: e }, anyWriter(p));
    };
    const seedByDialogue = (p) => {
      ctx.addFact('DISTRICT', { p: p.id, d: p.district }, 'certain', { doc: 'dialogue' });
      dialogueLeft--;
    };

    const stages = [counselors.map((r) => r.id)];
    while (remaining.length) {
      const size = rng.int(2, 4);
      const batch = [];
      for (const p of remaining.slice()) {
        if (batch.length >= size) break;
        if (planDistrict(p)) batch.push(p);
      }
      if (!batch.length) {
        // どのルールも使えないときは、知っている住人の少ない区画の人物を会話ログの直接の事実で特定させる
        if (dialogueLeft <= 0) throw new Error('区画を読み解かせる手段がない（会話ログの直接の事実も上限）');
        const count = (d) => known.filter((r) => r.district === d).length;
        const byNeed = remaining.slice().sort((x, y) => count(x.district) - count(y.district));
        const seen = new Set();
        for (const p of byNeed) {
          if (batch.length >= Math.min(2, dialogueLeft) || seen.has(p.district)) continue;
          seen.add(p.district);
          seedByDialogue(p);
          batch.push(p);
        }
      }
      for (const p of batch) {
        planJob(p);
        planEntry(p);
        remaining.splice(remaining.indexOf(p), 1);
      }
      known.push(...batch);
      batch.forEach((p) => knownSet.add(p.id));
      stages.push(batch.map((r) => r.id));
    }
    ctx.stages = stages;
    addIdentityNoise(ctx);

    // 到達可能性の検証（ルールの学習を含む）。届かない住人がいれば、残りの直接の事実で補う
    for (let round = 0; round < 4; round++) {
      const sim = A.Verifier.simulateReach(reachView(ctx));
      if (sim.errors.length) throw new Error(sim.errors[0]);
      if (sim.reachable) return;
      const stuck = ctx.residents.find((r) => !sim.known.has(r.id));
      if (!stuck || dialogueLeft <= 0) break;
      seedByDialogue(stuck);
    }
    throw new Error('到達可能性を満たす手がかり配置を作れなかった');
  }

  // 推理を豊かにする、それだけでは特定に至らない観察（真実のもの）。どの住人のログに置いてもよい
  function addIdentityNoise(ctx) {
    const { rng } = ctx;
    const cu = ctx.culture;
    const res = ctx.residents;
    const pick = (pred) => {
      const xs = res.filter(pred);
      return xs.length ? rng.pick(xs) : null;
    };
    for (const p of res) {
      if (p.is_counselor || !rng.chance(0.6)) continue;
      const kinds = [];
      const jm = cu.job_markers[CFG.jobByCode[p.job_code].category];
      if (jm) kinds.push('jobMarker');
      if (cu.seniority.band && p.entry_order <= cu.seniority.band.max_entry) kinds.push('band');
      if (cu.seniority.order_customs.some((c) => c !== 'seat_order')) kinds.push('order');
      if (!kinds.length) continue;
      const kind = rng.pick(kinds);
      if (kind === 'jobMarker' || kind === 'band') {
        const m = kind === 'band' ? cu.seniority.band.marker : jm;
        const w = rng.chance(0.4) ? p : pick((r) => r.id !== p.id);
        ctx.addFact('OBS_MARKER', { p: p.id, marker: m }, 'certain', { doc: 'log', owner: w.id });
      } else {
        const c = rng.pick(cu.seniority.order_customs.filter((x) => x !== 'seat_order'));
        const other = pick((r) => r.id !== p.id && r.entry_order !== p.entry_order);
        if (!other) continue;
        const [x, y] = p.entry_order < other.entry_order ? [p, other] : [other, p];
        if (c === 'honorific') ctx.addFact('OBS_HONORIFIC', { p: x.id, q: y.id, term: 'senior', custom: c }, 'certain', { doc: 'log', owner: y.id });
        else ctx.addFact('OBS_AHEAD', { p: x.id, q: y.id, custom: c }, 'certain', { doc: 'log', owner: rng.pick([x, y]).id });
      }
    }
  }

  function reachView(ctx) {
    return {
      residents: ctx.residents,
      shelter: { districts: ctx.districts, max_entry: ctx.maxEntry },
      facts: ctx.facts,
      culture: ctx.culture,
      initial_known_ids: ctx.residents.filter((r) => r.is_counselor).map((r) => r.id),
    };
  }

  // [5] 出来事と認識（物語の正本と、そこから切り出す主観ログのエントリ）は story.js

  // ------------------------------------------------------------------ [9] JSON

  function assemble(ctx) {
    const TL = ctx.timeline;
    const counselors = ctx.residents.filter((r) => r.is_counselor).map((r) => r.id);
    const stripEntry = (e) => ({
      t: e.t,
      timestamp: fmtT(e.t),
      kind: e.kind,
      emotion: e.emotion,
      text: e.text,
      deleted: !!e.deleted,
      writer: e.writer,
      facts: e.facts,
      rendered: e.rendered,
      scene: e.scene,
      perceived: e.perceived,
    });
    // 物語の正本：場面の時系列（LLM 文章化で書き手に渡す情報の出どころ。details は LLM が書き戻す）
    const stripScene = (s) => ({
      id: s.id,
      t: s.t,
      timestamp: fmtT(s.t),
      day: dayOf(s.t),
      kind: s.kind,
      title: s.title,
      place: s.place,
      place_name: A.Story.placeName(s.place, s.district),
      district: s.district,
      dark: s.dark,
      participants: s.participants,
      others: s.others,
      events: s.events.map((e) => ({ id: e.id, text: e.text, perceivers: e.perceivers, views: e.views, facts: e.facts })),
      causes: s.causes,
      facts: s.facts,
      details: [],
    });
    return {
      meta: { seed: ctx.seed, version: CFG.version, generator: 'html-prototype' },
      shelter: {
        name: ctx.shelterName,
        districts: ctx.districts,
        max_entry: ctx.maxEntry,
        resident_count: ctx.residents.length,
        supplies: ctx.state.supplies,
        crisis: ctx.crisis,
        crisis_day: TL.crisisDay,
        last_death_day: TL.lastDeathDay,
        now_day: TL.nowDay,
      },
      residents: ctx.residents.map((r) => ({
        id: r.id,
        token: r.token,
        name: r.name,
        district: r.district,
        entry_order: r.entry_order,
        job_code: r.job_code,
        is_counselor: r.is_counselor,
        profile: r.profile,
        status: ctx.deathOf.has(r.id) ? 'dead' : 'alive',
      })),
      relations: ctx.relations,
      deaths: ctx.deaths.map((d) => ({
        victim: d.victim,
        cause: d.cause,
        killer: d.killer,
        day: dayOf(d.t),
        time: fmtT(d.t),
        t: d.t,
        location: d.location,
        recorded_cause: d.recorded_cause,
        witness: d.witness,
        signs: d.signs,
        trick: d.trick,
      })),
      tricks: ctx.tricks,
      current_state: {
        survivors: ctx.state.survivors,
        hidden_threats: ctx.state.hidden_threats,
        intruder: ctx.intruder ? { present: ctx.intruder.present } : null,
        verdict: ctx.state.verdict,
      },
      documents: {
        overview: {
          shelter_name: ctx.shelterName,
          districts: ctx.districts,
          resident_count: ctx.residents.length,
          max_entry: ctx.maxEntry,
          counselors,
          now_day: TL.nowDay,
        },
        job_code_table: CFG.jobs.map((j) => ({ code: j.code, category: CFG.categories[j.category], name: j.name })),
        counselor_dialogues: ctx.dialogue.map((e) => ({ t: e.t, timestamp: fmtT(e.t), scene: e.scene || null, lines: e.lines, facts: e.facts, rendered: e.rendered })),
        chip_logs: Object.fromEntries(Object.entries(ctx.logs).map(([id, es]) => [id, es.map(stripEntry)])),
        hatch_log: ctx.hatch.map((h) => ({ t: h.t, timestamp: fmtT(h.t), side: h.side, auth: h.auth, facts: h.facts })),
      },
      story: { scenes: ctx.scenes.map(stripScene) },
      culture: ctx.culture, // シェルター文化（改修仕様 v0.2 §3）。marker_attr は真相（画面には出さない）
      facts: ctx.facts,
      initial_known_ids: counselors,
      solution: {
        stages: ctx.stages,
        transplant: ctx.transplant,
        intruder: ctx.intruder,
      },
    };
  }

  A.Generator = { generate };
})(window.ASARIYA = window.ASARIYA || {});
