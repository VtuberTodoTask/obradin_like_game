// 物語の正本（設計書 §6.5 [5] 出来事と認識）
//
// ログを書く前に、日ごと・場面ごとに「いつ・どこで・誰がいて・何が起きたか」を記した時系列表（scenes）を作る。
// 危機の発端 → 協議 → 方針の告知 → その影響 → 口論 → 死 → 発見 のような因果のつながりも causes に持つ。
// 主観ログの各エントリはどれか一つの場面に属し、その書き手が見聞きした出来事（perceivers）だけを知っている。
//
// 出力：ctx.scenes（正本）、ctx.logs（主観ログのエントリ）、ctx.dialogue（会話ログ）、ctx.hatch（ハッチ記録）
// エントリの parts はテンプレート文章化（narrator.js）用、scene / perceived は LLM 文章化（llm.js）用。
(function (A) {
  'use strict';
  const CFG = A.CONFIG;
  const { DAY, tAbs, dayOf } = A.util;

  const tok = (id) => `{P:${id}}`;
  const F = (f) => ({ fact: f.id });
  const FL = (flavor, params) => ({ flavor, params: params || {} });

  // 職能ごとの持ち場と、他の住人がそこを訪れる理由
  const WORKPLACE = {
    11: 'clinic', 12: 'clinic', 13: 'clinic', 21: 'farm', 22: 'canteen', 23: 'storage', 31: 'generator',
    32: 'water', 33: 'workshop', 41: 'corridor', 42: 'hatch', 51: 'office', 52: 'office',
  };
  const VISIT = {
    clinic: '薬をもらいに', farm: '収穫を手伝いに', canteen: '早めの食事をとりに', storage: '配給を受け取りに',
    generator: '照明の不具合を伝えに', water: '水を汲みに', workshop: '壊れた道具を直してもらいに', corridor: '用事を済ませに',
    hatch: '地上の様子を聞きに', office: '相談をしに',
  };
  // 正本に書く、職能ごとの客観的な作業の描写（テンプレート文と共通）
  const CANON_ACT = A.Narrator.JOB_TASKS;
  const POLICY = {
    outbreak: (d) => `${d}区画を隔離すること`,
    famine: () => '配給を半分に減らすこと',
    leak: () => '汚染された系統の水を使わないこと',
    strife: () => '夜間の外出を禁止すること',
  };
  const TOPIC = { outbreak: '隔離', famine: '食料', leak: '飲み水', strife: '夜間外出の禁止' };

  const placeName = (key, district) => (key === 'quarters' ? `${district}区画の居住区` : CFG.places[key] || key);

  // 手がかり事実の客観的な言い方（正本の出来事に使う）
  function factStatement(f, sc) {
    const g = f.args;
    const P = tok(g.p);
    const job = (c) => CFG.jobByCode[c].name;
    switch (f.type) {
      case 'DISTRICT': return `${P}は${g.d}区画に住んでいる`;
      case 'NOT_DISTRICT': return `${P}は${g.d}区画の住人ではない`;
      case 'SAME_DISTRICT': return `${P}と${tok(g.q)}は同じ区画に住んでいる`;
      case 'JOB': return `${P}が${CANON_ACT[g.j]}`;
      case 'NOT_JOB': return `${P}は${job(g.j)}の仕事はしていない`;
      case 'JOB_CATEGORY': return `${P}は${CFG.categories[g.c]}班に所属している`;
      case 'SAME_JOB': return `${P}と${tok(g.q)}は同じ持ち場で働いている`;
      case 'ENTRY_ORDER':
        if (g.n === 1) return `${P}はこのシェルターの最初の入居者だ`;
        if (g.n === sc.maxEntry) return `${P}は一番最後にここへ来た入居者だ`;
        return `${P}は${g.n}番目にここへ来た`;
      case 'ENTRY_OFFSET': {
        const k = g.k;
        const rel = k === 1 ? 'すぐ後' : k === -1 ? 'すぐ前' : k > 0 ? `${k}人後` : `${-k}人前`;
        return `${P}は${tok(g.q)}の${rel}にここへ来た`;
      }
      case 'ENTRY_BETWEEN': return `${tok(g.q)}、${P}、${tok(g.r)}の順に、続けてここへ来た`;
      case 'ENTERED_BEFORE': return `${P}は${tok(g.q)}より先にここへ来ていた`;
      default: return '';
    }
  }

  // ------------------------------------------------------------------ 正本の部品

  function makeBook(ctx) {
    const book = { scenes: [], seq: 0 };
    book.scene = (kind, t, place, opts = {}) => {
      const s = {
        id: `S${String(++book.seq).padStart(3, '0')}`,
        kind,
        t,
        place,
        district: opts.district || null,
        title: opts.title || '',
        participants: [...new Set(opts.participants || [])],
        others: opts.others || [],
        events: [],
        causes: opts.causes || [],
        facts: [],
        entries: [],
        dark: !!opts.dark,
        details: [],
      };
      book.scenes.push(s);
      return s;
    };
    book.join = (s, ids) => ids.forEach((id) => id && !s.participants.includes(id) && s.participants.push(id));
    // perceivers: 'all'（その場の全員）か住人 ID の配列。views: 書き手ごとの見え方（誤認など）
    book.event = (s, text, perceivers = 'all', opts = {}) => {
      const e = { id: `${s.id}-e${s.events.length + 1}`, text, perceivers, views: opts.views || null, facts: opts.facts || [] };
      if (opts.policy) e.policy = opts.policy; // 告げられた方針の語（方針の言い直しを文化のルールの記述と取り違えないため）
      s.events.push(e);
      return e;
    };
    return book;
  }

  const perceives = (s, e, id) => (e.perceivers === 'all' ? s.participants.includes(id) : e.perceivers.includes(id));

  // ------------------------------------------------------------------ 本体

  function build(ctx) {
    const { rng } = ctx;
    const TL = ctx.timeline;
    const nowEnd = tAbs(TL.nowDay, DAY - 1);
    const counselors = ctx.residents.filter((r) => r.is_counselor).map((r) => r.id);
    const byId = ctx.byId;
    const book = makeBook(ctx);
    const loc = (owner) => ({ doc: 'log', owner });
    const DLG = { doc: 'dialogue' };
    ctx.residents.forEach((r) => (ctx.logs[r.id] = []));
    const aliveIds = (t) => ctx.residents.map((r) => r.id).filter((id) => ctx.canAct(id, t));
    const speakerAt = (t, exclude = []) => {
      const cs = counselors.filter((c) => !exclude.includes(c) && ctx.canAct(c, t));
      return cs.length ? rng.pick(cs) : null;
    };

    // 書き手 writer が場面 s を記録するエントリを作る（同じ場面・同じ書き手なら一つにまとめる）
    const record = (s, writer, opts = {}) => {
      const owner = opts.owner || writer;
      let e = s.entries.find((x) => x.writer === writer && x.owner === owner);
      if (!e) {
        e = {
          t: opts.t != null ? opts.t : s.t + rng.int(20, 150),
          kind: opts.kind,
          emotion: opts.emotion,
          writer,
          owner,
          scene: s.id,
          parts: [],
          deleted: !!opts.deleted,
        };
        s.entries.push(e);
        ctx.logs[owner].push(e);
      }
      if (opts.parts) e.parts.push(...opts.parts);
      return e;
    };
    const addDialogue = (e) => ctx.dialogue.push(e);

    // ================================================================ 異変前の日常
    const preDays = Math.max(1, TL.crisisDay - 1);
    const cu = ctx.culture;
    const slot = new Map();
    // 一人が同じ日に二つの「作業」場面や二つの「夜の居住区」場面に同時にいないよう、居場所を管理する
    const EXCLUSIVE = new Set(['work', 'quarters']);
    const occ = new Map(); // `${id}|${day}|${kind}` → 場面のキー
    const keyOf = (c) => `${c[0]}|${c[1]}|${c[2]}|${c[3] || ''}`;
    const freeFor = (id, c) => {
      if (!id || !EXCLUSIVE.has(c[1])) return true;
      const k = occ.get(`${id}|${c[0]}|${c[1]}`);
      return !k || k === keyOf(c);
    };
    const joinRoutine = (s, ids) => {
      for (const id of ids) {
        if (!id) continue;
        if (EXCLUSIVE.has(s.kind)) {
          const k = `${id}|${dayOf(s.t)}|${s.kind}`;
          if (occ.has(k) && occ.get(k) !== s.key) continue; // 同じ時間帯に別の場所にいる人は加えない
          occ.set(k, s.key);
        }
        book.join(s, [id]);
      }
    };
    // 日常の場面の種類：朝の会合・持ち場での作業・配給の列・昼食・立ち話・夕食・夜の居住区
    const ROUTINE = {
      meeting: { from: 7 * 60 + 30, to: 8 * 60 + 20, place: 'canteen', title: '朝の会合', event: '住人たちが食堂に集まり、朝の会合が開かれた', share: 0.7 },
      work: { from: 9 * 60, to: 10 * 60 + 40 },
      queue: { from: 11 * 60, to: 11 * 60 + 40, place: 'storage', title: '配給の列', event: '倉庫の前に、配給を受け取る住人の列ができていた', share: 0.5 },
      lunch: { from: 12 * 60, to: 12 * 60 + 40, place: 'canteen', title: '食堂の昼食', event: '住人たちが食堂で昼食をとっていた', share: 0.5 },
      chat: { from: 15 * 60, to: 17 * 60, place: 'corridor', title: '通路での立ち話', event: '住人たちが通路で立ち話をしていた', share: 0 },
      meal: { from: 18 * 60, to: 19 * 60 + 30, place: 'canteen', title: '食堂の夕食', event: '住人たちが食堂で夕食をとっていた', share: 0.5 },
      quarters: { from: 21 * 60, to: 22 * 60 + 30 },
    };
    const routine = (day, kind, place, district) => {
      const key = keyOf([day, kind, place, district]);
      if (slot.has(key)) return slot.get(key);
      const def = ROUTINE[kind];
      const t = tAbs(day, rng.int(def.from, def.to));
      let s;
      if (kind === 'work') {
        s = book.scene(kind, t, place, { title: `${placeName(place)}での作業` });
        s.key = key;
        joinRoutine(s, ctx.residents.filter((r) => WORKPLACE[r.job_code] === place).map((r) => r.id));
        // 誰がどこで働いているかは手がかりそのものなので、背景の出来事には名前を出さない
        book.event(s, `${placeName(place)}では持ち場の住人たちが働いていた`);
      } else if (kind === 'quarters') {
        s = book.scene(kind, t, 'quarters', { district, title: `夜の${district}区画` });
        s.key = key;
        joinRoutine(s, ctx.residents.filter((r) => r.district === district).map((r) => r.id));
        book.event(s, `夜、${district}区画の住人たちは居住区の自室に戻っていた`);
      } else {
        s = book.scene(kind, t, def.place, { title: def.title });
        s.key = key;
        if (def.share) joinRoutine(s, rng.sample(ctx.residents.map((r) => r.id), Math.ceil(ctx.residents.length * def.share)));
        book.event(s, def.event);
      }
      slot.set(key, s);
      return s;
    };
    const visitorNote = (s, w) => {
      const r = byId.get(w);
      if (s.kind === 'work' && WORKPLACE[r.job_code] !== s.place && !s.events.some((e) => e.visitor === w)) {
        const e = book.event(s, `${tok(w)}が${VISIT[s.place]}${placeName(s.place)}を訪れた`, [w]);
        e.visitor = w;
      }
    };

    // 身元に関わる観察事実を置く（改修仕様 v0.2 §4）。書き方の区分（f.mode）は2種類：
    //  observe：その場で見聞きしたこととして書く。正本上、書き手と対象がその時刻にその場にいる場合だけ
    //  recall：前から知っていること（知識・回想・伝聞）として書く。場所を問わない
    // 候補の場面は、関係する人物全員がその時間帯に空いていて、書き手のエントリの身元の観察が上限未満のもの。
    // そのうち書き手がすでに記録している場面を優先し（エントリをまとめる）、1場面の記録者は MAX_RECORDERS 人まで。
    const MAX_RECORDERS = 4;
    const MAX_ID_PER_ENTRY = CFG.scale.idFactsPerEntry;
    const ID_OBS = A.Solver.OBS_TYPES;
    const days = A.util.range(1, preDays);
    const preDay = () => rng.int(1, preDays);
    const recorders = (key) => (slot.has(key) ? slot.get(key).entries.map((e) => e.writer) : []);
    const idCount = (key, w) => {
      const s = slot.get(key);
      const e = s && s.entries.find((x) => x.writer === w && x.owner === w);
      return e ? e.parts.filter((p) => p.fact && ID_OBS.has(factOf(ctx, p.fact).type)).length : 0;
    };
    const choose = (cands, w, people, needIdRoom) => {
      const ok = cands.filter((c) => people.every((id) => freeFor(id, c)) && (!needIdRoom || idCount(keyOf(c), w) < MAX_ID_PER_ENTRY));
      if (!ok.length) return null;
      const mine = ok.filter((c) => recorders(keyOf(c)).includes(w));
      if (mine.length) return routine(...rng.pick(mine));
      const open = rng.shuffle(ok).sort((a, b) => recorders(keyOf(a)).length - recorders(keyOf(b)).length);
      const best = open.filter((c) => recorders(keyOf(c)).length < MAX_RECORDERS);
      return routine(...(best.length ? best[0] : open[0]));
    };
    const slots = (kinds, district) =>
      days.flatMap((d) =>
        kinds.map((k) => (k === 'quarters' ? [d, k, 'quarters', district] : k === 'work' ? [d, k, district] : [d, k, ROUTINE[k].place])),
      );
    const NUMBER_SCENE = { card: 'queue', locker: 'meal', room: 'quarters' };
    const ORDER_SCENE = { queue_order: 'queue', seat_order: 'meal', honorific: 'chat', speaking_order: 'meeting' };
    const numLabel = CFG.culture.numberCustoms[cu.seniority.number_custom].label;
    const hon = cu.seniority.honorific;
    // 観察事実ごとの、observe で置ける場面の候補・居合わせる人物・正本の出来事（客観）
    const placement = (f, w) => {
      const g = f.args;
      const p = byId.get(g.p);
      const wr = byId.get(w);
      const self = g.p === w;
      const P = tok(g.p);
      const Q = g.q ? tok(g.q) : '';
      const talk = ['lunch', 'chat', 'meal', 'queue'];
      switch (f.type) {
        case 'OBS_WORK':
          return { cands: slots(['work'], WORKPLACE[p.job_code]), people: [w, g.p], text: `${P}が${CANON_ACT[g.j]}` };
        case 'OBS_MARKER': {
          const m = cu.markers[g.marker];
          const cands = self ? slots(['lunch', 'chat', 'meal', 'queue', 'meeting']).concat(slots(['work'], WORKPLACE[wr.job_code])) : slots(talk);
          return { cands, people: [w, g.p], text: m.other.split('{P}').join(P).replace(/。$/, '') };
        }
        case 'OBS_NUMBER': {
          const k = NUMBER_SCENE[cu.seniority.number_custom];
          if (k === 'quarters' && p.district !== wr.district) return null; // よその区画の夜には出向かない
          return { cands: k === 'quarters' ? slots(['quarters'], p.district) : slots([k]), people: [w, g.p], text: `${P}の${numLabel}は${g.n}だった` };
        }
        case 'OBS_AHEAD': {
          const k = ORDER_SCENE[g.custom];
          const text = g.custom === 'speaking_order' ? `朝の会合で、${P}が${Q}より先に口を開いた` : `配給の列で、${P}が${Q}より前に並んでいた`;
          return { cands: slots([k]), people: [w, g.p, g.q], text };
        }
        case 'OBS_ADJACENT':
          return { cands: slots(['meal']), people: [w, g.p, g.q], text: `食堂で、${Q}が${P}のすぐ下座に座っていた` };
        case 'OBS_HONORIFIC': {
          const [pre, post] = g.term === 'senior' ? hon.senior : hon.junior;
          return { cands: slots(['chat', 'lunch', 'meal']), people: [w, g.p], text: `${Q}が${P}を「${pre}〈名前〉${post}」と呼んだ` };
        }
        case 'OBS_INGROUP':
          return { cands: slots(talk).concat(slots(['quarters'], wr.district)), people: [w, g.p], text: `${Q}が${P}のことを「うちの区画の」と言った` };
        case 'OBS_OUTGROUP':
          return { cands: slots(talk), people: [w, g.p], text: `${Q}が${P}のことを「${g.nickname}」と呼んだ` };
        default:
          return null;
      }
    };
    for (const f of ctx.facts.filter((x) => x.loc.doc === 'log')) {
      const w = f.loc.owner;
      const plan = placement(f, w);
      let s = null;
      if (plan) {
        s = choose(plan.cands, w, plan.people, true);
        if (s) joinRoutine(s, plan.people);
      }
      if (s && plan.people.every((id) => s.participants.includes(id))) {
        // observe：正本上、書き手と対象がその場にいる場面で、その場で見聞きしたこととして書く
        f.mode = 'observe';
        visitorNote(s, w);
        book.event(s, plan.text, [w], { facts: [f.id] });
      } else {
        // recall：書き手が前から知っていること（知識・回想・伝聞）として書く。場面の出来事にはしない。
        // 対象の人物はその場にいなくてよいので、書き手が居合わせる食事・立ち話・列の場面に付ける
        f.mode = 'recall';
        s = choose(slots(['lunch', 'chat', 'meal', 'queue']), w, [w], true) || choose(slots(['lunch', 'chat', 'meal', 'queue', 'meeting']), w + '#', [w], false);
        joinRoutine(s, [w]);
      }
      s.facts.push(f.id);
      record(s, w, { kind: 'daily', emotion: rng.pick(['calm', 'calm', 'anxiety', 'relief']), parts: [F(f)] });
    }
    // 関係の描写（食事の席で）
    for (const r of ctx.residents) {
      ctx.relations
        .filter((x) => x.a === r.id || x.b === r.id)
        .slice(0, 2)
        .forEach((x) => {
          if (!rng.chance(0.6)) return;
          const o = x.a === r.id ? x.b : x.a;
          const s = choose(slots(['lunch', 'meal']), r.id, [r.id, o], false);
          joinRoutine(s, [r.id, o]);
          const label = CFG.relationLabels[x.type];
          book.event(s, `${tok(r.id)}と${tok(o)}が言葉を交わした（二人の関係：${label}）`, [r.id]);
          record(s, r.id, { kind: 'daily', emotion: rng.pick(['calm', 'relief']), parts: [FL('relation', { other: o, type: x.type })] });
        });
    }
    // 異変前のエントリが規定数に満たない住人は、自分の持ち場の作業や日々の場面を記録する（手がかりを日をまたいで散らす）
    for (const r of ctx.residents) {
      const have = () => ctx.logs[r.id].length;
      const kinds = ['work', 'meeting', 'queue', 'lunch', 'chat', 'meal'];
      for (let guard = 0; have() < CFG.scale.dailyEntriesMin && guard < 12; guard++) {
        const k = kinds[guard % kinds.length];
        const s = choose(k === 'work' ? slots(['work'], WORKPLACE[r.job_code]) : slots([k]), r.id + '#', [r.id], false);
        if (!s || s.entries.some((e) => e.writer === r.id)) continue;
        joinRoutine(s, [r.id]);
        if (!s.participants.includes(r.id)) continue;
        record(s, r.id, { kind: 'daily', emotion: rng.pick(['calm', 'relief', 'anxiety']) });
      }
    }
    // 各エントリの冒頭（場面への入り方）と締め
    for (const s of book.scenes) {
      for (const e of s.entries) {
        const r = byId.get(e.writer);
        let open;
        if (s.kind === 'work' && WORKPLACE[r.job_code] === s.place) {
          open = FL('selfJob');
          // 書き手自身がその場で何をしていたかも正本に持つ（LLM には下書きを渡さないため）
          if (!s.events.some((ev) => ev.worker === e.writer)) book.event(s, `${tok(e.writer)}は持ち場で${CANON_ACT[r.job_code]}`, [e.writer]).worker = e.writer;
        } else if (s.kind === 'work') open = FL('visit', { place: s.place, reason: VISIT[s.place] });
        else if (s.kind === 'meal' || s.kind === 'lunch') open = FL('meal', { lunch: s.kind === 'lunch' });
        else if (s.kind === 'chat') open = FL('chat');
        else if (s.kind === 'queue') open = FL('queue');
        else if (s.kind === 'meeting') open = FL('meeting');
        else open = FL('quarters', { district: s.district, home: r.district === s.district });
        e.parts.unshift(open);
        e.parts.push(FL('closer'));
      }
    }

    // 会話ログ：起動報告と ID の手がかり
    addDialogue({ t: tAbs(1, rng.int(7 * 60, 9 * 60)), speaker: rng.pick(counselors), parts: [FL('aiBoot', { n: ctx.residents.length })] });
    for (const f of ctx.facts.filter((x) => x.loc.doc === 'dialogue')) {
      addDialogue({ t: tAbs(preDay(), rng.int(9 * 60, 22 * 60)), speaker: rng.pick(counselors), parts: [F(f)] });
    }

    // ================================================================ 危機の因果の連鎖
    const crisis = ctx.crisis;
    // 方針を告げる相談役（文化と事件の連動：その相談役の偏見・序列観を方針に反映する。改修仕様 v0.2 §6.3）
    const tAsm = tAbs(TL.crisisDay + 1, rng.int(8 * 60, 10 * 60));
    const cAsm = speakerAt(tAsm);
    const lead = cAsm ? byId.get(cAsm).profile.attitude : null;
    const prejudiced = lead && lead.prejudice && ['outbreak', 'strife'].includes(crisis) && rng.chance(0.7) ? lead.prejudice : null;
    const crisisDistrict = prejudiced ? prejudiced.district : rng.pick(ctx.districts);
    const firstOf = (cause) => ctx.deaths.find((d) => d.cause === cause);
    const pickAlive = (t, n, exclude = []) => rng.sample(aliveIds(t).filter((id) => !exclude.includes(id)), n);
    const writable = (ids, t) => ids.filter((id) => ctx.canAct(id, t + 150));

    // 1) 発端
    const tOn = tAbs(TL.crisisDay, rng.int(8 * 60, 13 * 60));
    let onset;
    {
      let parts = [];
      let text;
      const params = { crisis, district: crisisDistrict };
      if (crisis === 'outbreak') {
        const d = firstOf('infection');
        const subject = d && ctx.canAct(d.victim, tOn + 150) ? d.victim : rng.pick(aliveIds(tOn));
        const staff = writable(ctx.residents.filter((r) => [11, 12].includes(r.job_code)).map((r) => r.id), tOn).slice(0, 2);
        parts = [subject, ...staff, ...pickAlive(tOn, 1, [subject, ...staff])];
        text = `${tok(subject)}が高熱を出して医務室に運び込まれた`;
        params.subject = subject;
        onset = book.scene('onset', tOn, 'clinic', { title: '最初の発熱者', participants: parts });
      } else if (crisis === 'famine') {
        const farmers = writable(ctx.residents.filter((r) => [21, 23].includes(r.job_code)).map((r) => r.id), tOn).slice(0, 2);
        parts = [...farmers, ...pickAlive(tOn, 2, farmers)];
        text = '水耕棚の苗が一斉に根腐れしているのが見つかった';
        onset = book.scene('onset', tOn, 'farm', { title: '水耕棚の根腐れ', participants: parts });
      } else if (crisis === 'leak') {
        const techs = writable(ctx.residents.filter((r) => r.job_code === 32).map((r) => r.id), tOn).slice(0, 2);
        parts = [...techs, ...pickAlive(tOn, 2, techs)];
        text = '浄水室で線量計が鳴り、浄水系統が汚染されていることが分かった';
        onset = book.scene('onset', tOn, 'water', { title: '浄水系統の汚染', participants: parts });
      } else {
        const pair = quarrelPair(ctx, tOn);
        parts = [...pair, ...pickAlive(tOn, 2, pair)];
        text = `${tok(pair[0])}と${tok(pair[1])}が食堂で掴み合いの喧嘩をした`;
        params.a = pair[0];
        params.b = pair[1];
        onset = book.scene('onset', tOn, 'canteen', { title: '食堂での喧嘩', participants: parts });
      }
      book.event(onset, text);
      for (const id of writable(onset.participants, tOn).slice(0, 4)) {
        record(onset, id, { kind: 'crisis', emotion: 'anxiety', parts: [FL('onsetView', params), FL('closer')] });
      }
    }

    // 2) 相談役と管理AIの協議（会話ログ）
    const tConsult = tOn + rng.int(60, 240);
    const cConsult = speakerAt(tConsult);
    let consult = null;
    if (cConsult) {
      consult = book.scene('consult', tConsult, 'office', { title: '相談役と管理AIの協議', participants: [cConsult], causes: [onset.id] });
      book.event(consult, `相談役の${tok(cConsult)}が管理AIと異変への対応を協議した`, []);
      addDialogue({ t: tConsult, speaker: cConsult, scene: consult.id, parts: [FL('crisisOnsetDlg', { district: crisisDistrict })] });
    }

    // 3) 方針の告知（全員を食堂に集める）
    let assembly = null;
    const seniorFirst = crisis === 'famine' && ['strict', 'formal'].includes(cu.seniority.strength);
    const policy = seniorFirst
      ? '配給を古株から順に回すこと'
      : crisis === 'strife' && prejudiced
        ? `${crisisDistrict}区画の住人の夜間の外出を禁じること`
        : POLICY[crisis](crisisDistrict);
    // 方針の理由（相談役の偏見・序列観）。会話ログに残す
    const nick = cu.districts[crisisDistrict].nickname;
    const reason = prejudiced
      ? prejudiced.type === 'fears'
        ? `${nick}の連中には近づきたくない。`
        : `${nick}の連中は信用ならん。`
      : seniorFirst
        ? lead && lead.seniority === 'rebel'
          ? '本当は気が進まないが、皆がそう望んでいる。'
          : 'ここを支えてきたのは古株だ。'
        : '';
    if (cAsm) {
      const tDec = tAsm - rng.int(30, 90);
      const dec = book.scene('consult', tDec, 'office', { title: '方針の決定', participants: [cAsm], causes: [onset.id].concat(consult ? [consult.id] : []) });
      // 方針を言い直した記述に出やすい語。告知を聞いた記録で、これらを含む記述は答え・一般論として扱わない
      const policyWords = seniorFirst ? ['古株', '先に来た', '古い順', '古参'] : [`${crisisDistrict}区画`, '外出', '隔離', '配給', '水'];
      book.event(dec, `相談役の${tok(cAsm)}が管理AIに、${policy}を伝えた`, [], { policy: policyWords });
      addDialogue({ t: tDec, speaker: cAsm, scene: dec.id, parts: [FL('policyDlg', { policy, reason })] });
      assembly = book.scene('assembly', tAsm, 'canteen', { title: '食堂での告知', participants: aliveIds(tAsm), causes: [onset.id, dec.id] });
      book.event(assembly, `相談役の${tok(cAsm)}が住人を食堂に集め、${policy}を告げた`, 'all', { policy: policyWords });
      for (const id of rng.sample(writable(assembly.participants, tAsm), 5)) {
        record(assembly, id, { kind: 'crisis', emotion: rng.pick(['anxiety', 'fear', 'anger']), parts: [FL('assemblyView', { counselor: cAsm, policy }), FL('closer')] });
      }
    }

    // 4) 方針の影響
    {
      const tEff = tAbs(TL.crisisDay + 1, rng.int(13 * 60, 21 * 60));
      let eff;
      if (crisis === 'outbreak') {
        const inD = aliveIds(tEff).filter((id) => byId.get(id).district === crisisDistrict);
        eff = book.scene('effect', tEff, 'quarters', { district: crisisDistrict, title: `${crisisDistrict}区画の隔離`, participants: inD });
        book.event(eff, `${crisisDistrict}区画の隔壁が閉じられ、${crisisDistrict}区画の住人は居住区に閉じ込められた`);
      } else {
        const place = { famine: 'storage', leak: 'canteen', strife: 'corridor' }[crisis];
        const t = crisis === 'strife' ? tAbs(TL.crisisDay + 1, rng.int(22 * 60, 23 * 60)) : tEff;
        eff = book.scene('effect', t, place, { title: '方針の影響', participants: pickAlive(t, 4) });
        const text = {
          famine: '配給所に、半分になった配給を受け取る列ができた',
          leak: '飲み水の配給所に長い列ができた',
          strife: '夜の通路の照明が落とされ、通路は真っ暗になった',
        }[crisis];
        book.event(eff, text);
      }
      eff.causes = assembly ? [assembly.id] : [onset.id];
      for (const id of writable(eff.participants, eff.t).slice(0, 3)) {
        record(eff, id, { kind: 'crisis', emotion: rng.pick(['anxiety', 'fear', 'anger']), parts: [FL('effectView', { crisis, district: crisisDistrict }), FL('closer')] });
      }

      // 5) 口論（後の殺人の当事者や、対立している二人）
      const lastQ = Math.max(TL.crisisDay + 1, TL.lastDeathDay - 1);
      const tQ = tAbs(rng.int(TL.crisisDay + 1, lastQ), rng.int(10 * 60, 20 * 60));
      const pair = quarrelPair(ctx, tQ);
      if (pair) {
        const q = book.scene('quarrel', tQ, rng.pick(['canteen', 'pantry', 'corridor']), {
          title: '口論',
          participants: [...pair, ...pickAlive(tQ, 2, pair)],
          causes: [eff.id],
        });
        book.event(q, `${tok(pair[0])}と${tok(pair[1])}が${TOPIC[crisis]}のことで激しく言い争った`);
        for (const id of writable(q.participants, tQ).slice(0, 3)) {
          record(q, id, { kind: 'crisis', emotion: rng.pick(['anger', 'anxiety', 'fear']), parts: [FL('quarrelView', { a: pair[0], b: pair[1], topic: TOPIC[crisis] }), FL('closer')] });
        }
      }
    }

    // 物資の報告（会話ログ）
    {
      const daysLeft = { depleted: rng.int(4, 9), low: rng.int(25, 60), sufficient: rng.int(150, 400) }[ctx.state.supplies];
      const t3 = tConsult + rng.int(60, 300);
      const c3 = speakerAt(t3);
      if (c3) addDialogue({ t: t3, speaker: c3, parts: [FL('supplies', { days: daysLeft })] });
      if (ctx.state.supplies === 'depleted') {
        const t4 = tAbs(Math.max(TL.crisisDay + 1, TL.lastDeathDay - rng.int(1, 3)), rng.int(8 * 60, 20 * 60));
        const c4 = speakerAt(t4);
        if (c4) addDialogue({ t: t4, speaker: c4, parts: [FL('suppliesOut')] });
      }
    }

    // ================================================================ 死
    const crisisRoot = assembly || onset;
    // 死の原因として結ぶのは、その時刻より前に起きた危機の場面のうち最新のもの（時間が逆行しないように）
    const chain = book.scenes.filter((x) => ['onset', 'assembly', 'effect', 'quarrel'].includes(x.kind));
    const causeAt = (t) => {
      const before = chain.filter((x) => x.t < t).sort((a, b) => b.t - a.t);
      return (before[0] || onset).id;
    };
    for (const d of ctx.deaths) {
      const V = d.victim;
      const signs = pickSigns(rng, d.cause);
      d.signs = signs;
      d.location = placeFor(rng, d.cause, signs);
      const place = d.location;

      let wit = d.forcedWitness || null;
      const mustWitness = d.finalDeleted || (d.cause === 'murder' && !d.killerInFinal);
      if (!wit && (mustWitness || rng.chance(0.5))) wit = ctx.pickWitness(d, d.misperception ? [d.misperception.witness] : []);
      if (mustWitness && !wit) {
        if (d.finalDeleted) throw new Error('改ざんされた死の目撃者がいない');
        d.killerInFinal = true;
      }
      const sawKiller = !!wit && d.cause === 'murder' && !d.killerInFinal;

      // 死の場面
      const ds = book.scene('death', d.t, place, {
        title: `${CFG.places[place]}での死`,
        participants: [V].concat(d.cause === 'murder' ? [d.killer] : []),
        others: d.cause === 'intruder' ? ['チップを持たない見知らぬ侵入者'] : [],
        causes: [causeAt(d.t)],
        dark: d.dark,
      });
      const harm = harmText(d, signs);
      const harmEvent = book.event(ds, harm, [V]);
      if (d.cause === 'murder') {
        const who = [];
        if (d.killerInFinal) who.push(V);
        if (sawKiller) who.push(wit.id);
        book.event(ds, `${tok(V)}を襲ったのは${tok(d.killer)}だった${d.dark ? '（暗闇の中、声で分かった）' : ''}`, who);
      }
      book.event(ds, `${tok(V)}が息を引き取った`, []);

      if (!d.finalDeleted) {
        const parts = [FL('finalOpen', { place, dark: d.dark })];
        const signParts = signs.map((sg) => F(addSceneFact(ds, ctx.addFact('DEATH_SIGN', { p: V, sign: sg, causes: CFG.signs[sg].causes }, 'certain', loc(V)))));
        harmEvent.facts = signParts.map((x) => x.fact);
        if (d.cause === 'murder' && d.killerInFinal) {
          const kp = F(addSceneFact(ds, ctx.addFact('KILLED_BY', { p: V, k: d.killer, dark: d.dark }, 'certain', loc(V))));
          if (d.dark) parts.push(...signParts, kp);
          else parts.push(kp, ...signParts);
        } else parts.push(...signParts);
        parts.push(FL('finalEnd'));
        record(ds, V, { t: d.t, kind: 'final', emotion: finalEmotion(rng, d.cause), parts });
      } else {
        const del1 = { t: d.t - rng.int(120, 600), kind: 'deleted', deleted: true, emotion: null, writer: V, owner: V, scene: ds.id, parts: [] };
        const del2 = { t: d.t, kind: 'deleted', deleted: true, emotion: null, writer: V, owner: V, scene: ds.id, parts: [] };
        ctx.logs[V].push(del1, del2);
      }

      // 襲撃を目撃した（その場にいた）／遺体を見つけた
      if (wit) {
        // 目撃者が見る徴候は、本人が最期に感じたものと同じ（刺されたのに絞殺の痕、のような食い違いを防ぐ）
        const ws = rng.pick(signs.filter((x) => x !== 'nausea'));
        if (sawKiller) {
          book.join(ds, [wit.id]);
          harmEvent.perceivers.push(wit.id);
          const parts = [FL('sawAttack', { v: V, place })];
          parts.push(F(addSceneFact(ds, ctx.addFact('DEATH_SIGN', { p: V, sign: ws, causes: CFG.signs[ws].causes }, 'certain', loc(wit.id)))));
          parts.push(F(addSceneFact(ds, ctx.addFact('KILLED_BY', { p: V, k: d.killer }, 'certain', loc(wit.id)))));
          parts.push(FL('closer'));
          record(ds, wit.id, { t: wit.t, kind: 'witness', emotion: rng.pick(['fear', 'anger']), parts });
        } else {
          const disc = book.scene('discovery', wit.t - 10, place, { title: `${tok(V)}の遺体の発見`, participants: [wit.id], causes: [ds.id] });
          const f = ctx.addFact('DEATH_SIGN', { p: V, sign: ws, causes: CFG.signs[ws].causes }, 'certain', loc(wit.id));
          addSceneFact(disc, f);
          book.event(disc, `${tok(wit.id)}が${CFG.places[place]}で${tok(V)}の遺体を見つけた。${otherSignText(ws, V)}`, 'all', { facts: [f.id] });
          record(disc, wit.id, { t: wit.t, kind: 'witness', emotion: rng.pick(['fear', 'sadness', 'anger']), parts: [FL('foundBody', { v: V, place }), F(f), FL('closer')] });
        }
        d.witness = wit.id;
      }

      // 主観の誤認：暗闇で、その場にいた W1 が別人を犯人だと思い込む
      if (d.misperception) {
        const m = d.misperception;
        book.join(ds, [m.witness]);
        const f = ctx.addFact('KILLED_BY', { p: V, k: m.wrong }, 'low', loc(m.witness));
        addSceneFact(ds, f);
        book.event(ds, `暗闇の中、${tok(V)}のそばから人影が走り去った`, [m.witness], {
          facts: [f.id],
          views: { [m.witness]: `暗闇の中、${tok(V)}のそばから人影が走り去った。書き手はそれが${tok(m.wrong)}だった気がしている（はっきりとは見えていない）` },
        });
        record(ds, m.witness, { t: m.t, kind: 'witness', emotion: 'fear', parts: [FL('darkness', { place }), F(f), FL('closer')] });
      }

      // 管理AIの生体信号途絶の報告（チップが生きている移植被害者は報告されない）
      if (d.trick !== 'chip_transplant') {
        const tr = d.t + rng.int(5, 60);
        const c = speakerAt(tr, [V]);
        if (c) {
          const rep = book.scene('ai_report', tr, 'office', { title: '生体信号途絶の報告', participants: [c], causes: [ds.id] });
          book.event(rep, `管理AIが相談役の${tok(c)}に、${tok(V)}の生体信号の途絶を報告した`, []);
          addDialogue({ t: tr, speaker: c, scene: rep.id, parts: [F(ctx.addFact('SIGNAL_LOST', { p: V, t: d.t }, 'certain', DLG)), FL('reaction')] });
        }
      }

      // ログの改ざん（会話ログ）
      if (d.tamper) {
        const C = d.tamper.counselor;
        const sc = book.scene('consult', d.tamper.t, 'office', { title: '記録の削除の依頼', participants: [C], causes: [ds.id] });
        book.event(sc, `相談役の${tok(C)}が管理AIに、${tok(V)}の最期の記録の削除と、死因を事故と記録することを頼んだ`, []);
        addDialogue({
          t: d.tamper.t,
          speaker: C,
          scene: sc.id,
          parts: [F(ctx.addFact('LOG_DELETED', { p: V, by: C, count: 2 }, 'certain', DLG)), F(ctx.addFact('DEATH_CLAIM', { p: V, cause: d.recorded_cause, claimer: C }, 'claim', DLG))],
        });
      }

      // 死因の偽装
      if (d.disguise) {
        const g = d.disguise;
        const cause = CFG.causes[d.recorded_cause];
        if (g.via === 'dialogue') {
          const sc = book.scene('consult', g.t, 'office', { title: '死因の記録', participants: [g.claimer], causes: [ds.id] });
          book.event(sc, `相談役の${tok(g.claimer)}が管理AIに、${tok(V)}の死因を${cause}と記録させた`, []);
          addDialogue({ t: g.t, speaker: g.claimer, scene: sc.id, parts: [F(ctx.addFact('DEATH_CLAIM', { p: V, cause: d.recorded_cause, claimer: g.claimer }, 'claim', DLG))] });
        } else {
          const sc = book.scene('claim', g.t, 'canteen', { title: '死因の噂', participants: [g.claimer, g.writer], causes: [ds.id] });
          const f = ctx.addFact('DEATH_CLAIM', { p: V, cause: d.recorded_cause, claimer: g.claimer }, 'claim', loc(g.writer));
          addSceneFact(sc, f);
          book.event(sc, `${tok(g.claimer)}が食堂で、${tok(V)}は${cause}で死んだのだと皆に説明した`, 'all', { facts: [f.id] });
          record(sc, g.writer, { t: g.t + 30, kind: 'hearsay', emotion: 'anxiety', parts: [F(f), FL('closer')] });
        }
      }
    }

    // ================================================================ チップの移植
    const tr = ctx.transplant;
    if (tr) {
      const { victim: V, carrier: K, t: tK } = tr;
      const vDeath = book.scenes.find((s) => s.kind === 'death' && s.participants[0] === V);
      const rm = book.scene('chip_removal', tK - 20, 'room', { title: 'チップの摘出', participants: [K], causes: [vDeath.id] });
      book.event(rm, `${tok(K)}が自室の鏡の前で、自分の首の後ろからチップを取り出そうとした`);
      record(rm, K, { t: tK - rng.int(3, 15), kind: 'chipRemoval', emotion: 'resolve', parts: [FL('chipRemoval'), FL('closer')] });
      const trT = tK + rng.int(5, 60);
      const c = speakerAt(trT, [K]);
      if (c) {
        const rep = book.scene('ai_report', trT, 'office', { title: '生体信号途絶の報告', participants: [c], causes: [rm.id] });
        book.event(rep, `管理AIが相談役の${tok(c)}に、${tok(K)}の生体信号の途絶を報告した`, []);
        addDialogue({ t: trT, speaker: c, scene: rep.id, parts: [F(ctx.addFact('SIGNAL_LOST', { p: K, t: tK }, 'certain', DLG)), FL('reaction')] });
      }
      const tm = tK + rng.int(DAY / 2, DAY);
      const others = rng.shuffle(ctx.residents.map((r) => r.id).filter((id) => id !== K && id !== V && ctx.canAct(id, tm + 5)));
      if (others.length) {
        const ms = book.scene('missing', tm - 30, 'corridor', { title: `${tok(K)}の失踪`, participants: [others[0]], causes: [rm.id] });
        book.event(ms, `${tok(K)}の姿がどこにもなく、遺体も見つからない`);
        record(ms, others[0], { t: tm, kind: 'flavor', emotion: 'anxiety', parts: [FL('missingBody', { k: K }), FL('closer')] });
      }
      const startDay = dayOf(tK) + 1;
      const days = [...new Set([rng.int(startDay, TL.nowDay), rng.int(startDay, TL.nowDay), TL.nowDay])].sort((a, b) => a - b);
      let prev = rm;
      days.forEach((day, i) => {
        const t = tAbs(day, rng.int(6 * 60, 22 * 60));
        const isNow = day === TL.nowDay;
        const hide = isNow ? rng.pick(['storage', 'farm', 'room', 'generator']) : 'room';
        const s = book.scene(isNow ? 'now' : 'hiding', t - 30, hide, { title: isNow ? '現在' : 'なりすまし', participants: [K], causes: [prev.id] });
        book.event(s, `${tok(K)}は${tok(V)}のチップを埋め込み、${tok(V)}になりすまして暮らしている`);
        let parts;
        if (i === 0) {
          const f = ctx.addFact('STYLE_SHIFT', { log: V, writer: K }, 'certain', loc(V));
          addSceneFact(s, f);
          parts = [F(f), FL('postShift', { v: V }), FL('closer')];
        } else if (isNow) {
          parts = [FL('survivorNow', { place: hide }), ...intruderNote(ctx, book, s, t, K), FL('closer')];
        } else {
          parts = [FL('selfJob'), FL('postHide'), FL('closer')];
        }
        record(s, K, { owner: V, t, kind: 'transplanted', emotion: rng.pick(['guilt', 'calm', 'fear']), parts });
        prev = s;
      });
    }

    // ================================================================ 生存者
    for (const id of ctx.state.survivors) {
      if (tr && tr.carrier === id) continue;
      if (TL.nowDay - 1 > TL.lastDeathDay && rng.chance(0.7)) {
        const t = tAbs(rng.int(TL.lastDeathDay + 1, TL.nowDay - 1), rng.int(6 * 60, 22 * 60));
        const s = book.scene('aftermath', t - 30, 'room', { title: '最後の死の後', participants: [id], causes: [crisisRoot.id] });
        book.event(s, `${tok(id)}は誰もいなくなったシェルターで、一人で過ごしていた`);
        record(s, id, { t, kind: 'aftermath', emotion: rng.pick(['despair', 'sadness', 'fear']), parts: [FL('aftermath'), FL('closer')] });
      }
      const t = tAbs(TL.nowDay, rng.int(6 * 60, 22 * 60));
      const hide = rng.pick(['storage', 'farm', 'room', 'generator', 'canteen']);
      const s = book.scene('now', t - 30, hide, { title: '現在', participants: [id], causes: [crisisRoot.id] });
      book.event(s, `${tok(id)}はまだ生きていて、${CFG.places[hide]}に身を潜めている`);
      const parts = [FL('survivorNow', { place: hide }), ...intruderNote(ctx, book, s, t, id)];
      if (ctx.state.supplies === 'depleted') {
        book.event(s, '食料庫は空で、食べ物はもう何も残っていない');
        parts.push(FL('noFood'));
      }
      parts.push(FL('closer'));
      record(s, id, { t, kind: 'now', emotion: rng.pick(['fear', 'despair', 'calm']), parts });
    }

    // 相談役が全員いなくなった後の管理AIの独白
    {
      const ends = counselors.map((c) => ctx.endT(c));
      if (ends.every((e) => e < nowEnd)) addDialogue({ t: Math.max(...ends) + rng.int(30, 240), speaker: null, parts: [FL('counselorsGone')] });
    }

    // ================================================================ 外部ハッチ
    const addHatch = (t, side, auth) => {
      const f = ctx.addFact('HATCH', { t, side, auth }, 'certain', { doc: 'hatch' });
      ctx.hatch.push({ t, side, auth, facts: [f.id] });
    };
    for (const s of ctx.residents.filter((r) => r.job_code === 42)) {
      const trips = rng.int(1, 2);
      for (let i = 0; i < trips; i++) {
        const day = rng.int(1, Math.min(TL.crisisDay + 2, TL.lastDeathDay));
        const out = tAbs(day, rng.int(6 * 60, 9 * 60));
        const back = out + rng.int(4 * 60, 8 * 60);
        if (ctx.canAct(s.id, back + 5)) {
          addHatch(out, 'inside', s.id);
          addHatch(back, 'outside', s.id);
        }
      }
    }
    if (ctx.intruder) {
      const it = ctx.intruder;
      addHatch(it.enterT, 'outside', null);
      const s = book.scene('intrusion', it.enterT, 'hatch', { title: '侵入', others: ['チップを持たない見知らぬ侵入者'] });
      book.event(s, '外部ハッチが外側から強制的に開けられ、チップを持たない何者かが侵入した', []);
      if (!it.present) {
        addHatch(it.exitT, 'inside', null);
        const s2 = book.scene('intrusion', it.exitT, 'hatch', { title: '侵入者の退去', others: ['侵入者'], causes: [s.id] });
        book.event(s2, '侵入者が内側から外部ハッチを開けて出ていった', []);
      }
    }

    // ================================================================ 仕上げ：時刻順に並べ、事実の所在と知覚を確定
    book.scenes.sort((a, b) => a.t - b.t);
    for (const [owner, entries] of Object.entries(ctx.logs)) {
      entries.sort((a, b) => a.t - b.t);
      for (let i = 1; i < entries.length; i++) if (entries[i].t <= entries[i - 1].t) entries[i].t = entries[i - 1].t + 1;
      entries.forEach((e, i) => {
        e.facts = e.parts.filter((p) => p.fact).map((p) => p.fact);
        e.facts.forEach((fid) => (factOf(ctx, fid).loc.index = i));
        e.owner = owner;
        const s = book.scenes.find((x) => x.id === e.scene);
        e.perceived = s ? s.events.filter((ev) => perceives(s, ev, e.writer)).map((ev) => ev.id) : [];
      });
    }
    ctx.dialogue.sort((a, b) => a.t - b.t);
    ctx.dialogue.forEach((e, i) => {
      e.facts = e.parts.filter((p) => p.fact).map((p) => p.fact);
      e.facts.forEach((fid) => (factOf(ctx, fid).loc.index = i));
    });
    ctx.hatch.sort((a, b) => a.t - b.t);
    ctx.hatch.forEach((e, i) => e.facts.forEach((fid) => (factOf(ctx, fid).loc.index = i)));
    ctx.scenes = book.scenes;
  }

  // ------------------------------------------------------------------ 補助

  function addSceneFact(s, f) {
    s.facts.push(f.id);
    return f;
  }

  function factOf(ctx, fid) {
    if (!ctx._storyFacts || ctx._storyFacts.size !== ctx.facts.length) ctx._storyFacts = new Map(ctx.facts.map((f) => [f.id, f]));
    return ctx._storyFacts.get(fid);
  }

  // 口論の当事者：これから起きる殺人の加害者と被害者 → 対立関係 → 誰か二人
  function quarrelPair(ctx, t) {
    const { rng } = ctx;
    const ok = (id) => ctx.canAct(id, t + 150);
    const m = ctx.deaths.find((d) => d.cause === 'murder' && d.t > t + 60 && ok(d.victim) && ok(d.killer));
    if (m) return rng.shuffle([m.killer, m.victim]);
    const rivals = ctx.relations.filter((x) => x.type === 'rival' && ok(x.a) && ok(x.b));
    if (rivals.length) {
      const x = rng.pick(rivals);
      return [x.a, x.b];
    }
    const alive = ctx.residents.map((r) => r.id).filter(ok);
    return alive.length >= 2 ? rng.sample(alive, 2) : null;
  }

  function intruderNote(ctx, book, s, t, writer) {
    const it = ctx.intruder;
    if (!it || t < it.enterT) return [];
    if (it.present) {
      book.event(s, '倉庫の奥に、住人ではない何者かが潜んでいて、足音が聞こえる', [writer]);
      return [FL('intruderStill')];
    }
    if (t > it.exitT) {
      book.event(s, '侵入者はもういない。外部ハッチの方で重い扉の閉まる音がした', [writer]);
      return [FL('intruderGone')];
    }
    return [];
  }

  function pickSigns(rng, cause) {
    const set = CFG.signSets[cause];
    // 病気は複数の症状が重なりうるが、外傷は一つに絞る
    const n = ['infection', 'radiation', 'starvation'].includes(cause) ? rng.int(1, 2) : 1;
    const signs = rng.sample(set, n);
    if (CFG.signs.nausea.causes.includes(cause) && rng.chance(0.3)) signs.push('nausea');
    return signs;
  }

  function placeFor(rng, cause, signs) {
    if (signs.includes('fall') || signs.includes('push')) return 'shaft';
    if (signs.includes('shock')) return 'generator';
    if (signs.includes('crush')) return 'storage';
    const byCause = {
      infection: ['clinic', 'room'],
      radiation: ['water', 'room', 'clinic'],
      starvation: ['room', 'pantry'],
      murder: ['generator', 'storage', 'corridor', 'room', 'farm'],
      accident: ['generator', 'storage'],
      intruder: ['hatch', 'storage', 'corridor'],
    };
    return rng.pick(byCause[cause]);
  }

  function finalEmotion(rng, cause) {
    const m = {
      murder: ['fear', 'pain'], infection: ['pain', 'despair'], radiation: ['pain', 'despair'],
      starvation: ['despair'], accident: ['fear', 'pain'], intruder: ['fear'],
    };
    return rng.pick(m[cause]);
  }

  // 正本に書く、死の直前の出来事（客観）。徴候表の label を使う
  function harmText(d, signs) {
    const parts = signs.map((s) => CFG.signs[s].label);
    return `${tok(d.victim)}は${parts.join('うえに、')}`;
  }
  function otherSignText(sign, V) {
    return A.Narrator.SIGN_TEXT[sign].other(tok(V));
  }

  A.Story = { build, factStatement, perceives, placeName };
})(window.ASARIYA = window.ASARIYA || {});
