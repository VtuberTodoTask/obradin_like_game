// トリックテンプレート（設計書 §9）。プラグイン形式で登録する。
// 各プラグインは apply(ctx) で真相データ（ctx.deaths など）を書き換え、適用記録を返す。
// 適用できない場合は null を返す。必須の手がかり事実は generator.js の buildEvents が
// 死亡記録に付いたフラグ（tamper / disguise / misperception など）から生成する。
(function (A) {
  'use strict';
  const { tAbs } = A.util;
  const registry = [];

  function register(plugin) {
    registry.push(plugin);
    registry.sort((a, b) => a.order - b.order);
  }

  const freeDeaths = (ctx) => ctx.deaths.filter((d) => !d.trick);
  const counselorIds = (ctx) => ctx.residents.filter((r) => r.is_counselor).map((r) => r.id);

  // 殺人でない死を殺人に置き換える（殺人を前提とするトリック用）
  function convertToMurder(ctx) {
    const knownKillers = ctx.deaths.filter((d) => d.killer).map((d) => d.killer);
    for (const d of ctx.rng.shuffle(freeDeaths(ctx))) {
      if (d.cause === 'murder') return d;
      const k = ctx.pickKiller(d, knownKillers);
      if (k) {
        d.cause = 'murder';
        d.killer = k;
        return d;
      }
    }
    return null;
  }

  // 1. チップの移植：加害者 K が被害者 V のチップを自分に移し、V になりすます。
  //    K の記録はチップ摘出で途切れ（死んだように見える）、V のログは K の語り口で現在まで続く。
  register({
    id: 'chip_transplant',
    name: 'チップの移植',
    order: 10,
    apply(ctx) {
      const { rng } = ctx;
      if (!ctx.survivors.length) return null;
      const survivors = ctx.survivors.map((id) => ctx.byId.get(id));
      const nonC = survivors.filter((r) => !r.is_counselor);
      const K = rng.pick(nonC.length ? nonC : survivors);
      const cand = freeDeaths(ctx).filter((d) => d.victim !== K.id);
      if (!cand.length) return null;
      const pref = cand.filter((d) => !ctx.byId.get(d.victim).is_counselor);
      const d = rng.pick(pref.length ? pref : cand);
      d.cause = 'murder';
      d.killer = K.id;
      d.trick = 'chip_transplant';
      d.killerInFinal = true;
      ctx.transplant = { victim: d.victim, carrier: K.id, t: d.t + rng.int(30, 120) };
      // 語り口の変化が読み取れるよう、一人称を変えておく
      const V = ctx.byId.get(d.victim);
      if (V.profile.pronoun === K.profile.pronoun) {
        const others = A.CONFIG.voices.pronouns.filter(([p]) => p !== K.profile.pronoun && A.Culture.fitPronoun(p, V.profile.gender, V.profile.age) === p);
        V.profile.pronoun = rng.weighted(others);
      }
      return { type: 'chip_transplant', name: this.name, target: d.victim, actor: K.id, effect: '加害者が生存しているため危険（潜伏者）' };
    },
  });

  // 4. 記録にない人物：チップを持たない侵入者。外部ハッチの開閉記録に「認証なし」の開放が残る。
  register({
    id: 'unrecorded_person',
    name: '記録にない人物',
    order: 20,
    apply(ctx) {
      const { rng } = ctx;
      const free = freeDeaths(ctx);
      if (!free.length) return null;
      const n = rng.int(1, Math.min(3, free.length));
      const start = rng.int(0, free.length - n);
      const victims = free.slice(start, start + n);
      victims.forEach((d) => {
        d.cause = 'intruder';
        d.killer = null;
        d.trick = 'unrecorded_person';
      });
      const firstT = victims[0].t;
      const lastT = victims[victims.length - 1].t;
      const enterT = Math.max(tAbs(ctx.timeline.crisisDay, 0), firstT - rng.int(60, 720));
      const present = rng.chance(0.5);
      const exitLimit = tAbs(ctx.timeline.nowDay, 0) - 60;
      const exitT = present ? null : Math.min(exitLimit, lastT + rng.int(60, 720));
      ctx.intruder = { enterT, exitT, present, victims: victims.map((d) => d.victim) };
      return {
        type: 'unrecorded_person',
        name: this.name,
        variant: 'intruder',
        targets: victims.map((d) => d.victim),
        present,
        effect: present ? '侵入者が中に残っているため危険（侵入者）' : '侵入者は退去済み',
      };
    },
  });

  // 2. ログの改ざん：相談役が管理AIに、死者の最期の記録の削除と死因の書き換えを依頼する。
  //    真の死因は目撃者のログからしか分からない。
  register({
    id: 'log_tamper',
    name: 'ログの改ざん',
    order: 30,
    apply(ctx) {
      const { rng } = ctx;
      for (const d of rng.shuffle(freeDeaths(ctx))) {
        const tReq = d.t + rng.int(60, 360);
        const cs = counselorIds(ctx).filter((c) => c !== d.victim && ctx.canAct(c, tReq));
        if (!cs.length) continue;
        const C = rng.pick(cs);
        const W = ctx.pickWitness(d, [C, d.killer]);
        if (!W) continue;
        const hideInfection = ctx.crisis !== 'outbreak' && rng.chance(0.5);
        if (hideInfection) {
          d.cause = 'infection';
          d.killer = null;
        } else {
          d.cause = 'murder';
          d.killer = rng.chance(0.5) ? C : ctx.pickKiller(d, [], [W.id]);
          if (!d.killer) d.killer = C;
        }
        d.trick = 'log_tamper';
        d.finalDeleted = true;
        d.killerInFinal = false;
        d.recorded_cause = 'accident';
        d.forcedWitness = W;
        d.tamper = { counselor: C, t: tReq };
        return {
          type: 'log_tamper',
          name: this.name,
          target: d.victim,
          actor: C,
          hidden_cause: d.cause,
          effect: hideInfection ? '隠された感染症のため危険（感染）' : '隠された殺人',
        };
      }
      return null;
    },
  });

  // 5. 死因の偽装：殺人を事故や感染症に見せかける。本人の最期の感覚と公式の記録が食い違う。
  register({
    id: 'death_disguise',
    name: '死因の偽装',
    order: 40,
    apply(ctx) {
      const { rng } = ctx;
      const murders = rng.shuffle(freeDeaths(ctx).filter((d) => d.cause === 'murder'));
      const conv = murders.length ? null : convertToMurder(ctx);
      for (const d of murders.length ? murders : conv ? [conv] : []) {
        const tc = d.t + rng.int(60, 600);
        const cs = counselorIds(ctx).filter((c) => c !== d.victim && ctx.canAct(c, tc));
        let via;
        let claimer;
        let writer = null;
        if (cs.length) {
          via = 'dialogue';
          claimer = cs.includes(d.killer) ? d.killer : rng.pick(cs);
        } else if (ctx.canAct(d.killer, tc)) {
          const ws = ctx.residents.map((r) => r.id).filter((id) => id !== d.victim && id !== d.killer && ctx.canAct(id, tc + 30));
          if (!ws.length) continue;
          via = 'hearsay';
          claimer = d.killer;
          writer = rng.pick(ws);
        } else continue;
        const fake = ctx.crisis !== 'outbreak' && rng.chance(0.5) ? 'infection' : 'accident';
        d.recorded_cause = fake;
        d.trick = 'death_disguise';
        d.killerInFinal = true;
        d.disguise = { via, claimer, writer, t: tc };
        return {
          type: 'death_disguise',
          name: this.name,
          target: d.victim,
          actor: claimer,
          recorded_cause: fake,
          effect: `公式記録は「${A.CONFIG.causes[fake]}」だが真相は殺人`,
        };
      }
      return null;
    },
  });

  // 3. 主観の誤認：暗闇の中で、目撃者が別の人物を犯人だと思い込む。
  register({
    id: 'misperception',
    name: '主観の誤認',
    order: 50,
    apply(ctx) {
      const { rng } = ctx;
      const murders = rng.shuffle(freeDeaths(ctx).filter((d) => d.cause === 'murder'));
      const conv = murders.length ? null : convertToMurder(ctx);
      for (const d of murders.length ? murders : conv ? [conv] : []) {
        const tw = d.t + rng.int(2, 30);
        const all = ctx.residents.map((r) => r.id).filter((id) => id !== d.victim && id !== d.killer);
        const ws = all.filter((id) => ctx.canAct(id, tw + 5));
        if (!ws.length) continue;
        const W1 = rng.pick(ws);
        const xs = all.filter((id) => id !== W1 && ctx.canAct(id, d.t));
        if (!xs.length) continue;
        const X = rng.pick(xs);
        d.dark = true;
        d.killerInFinal = true;
        d.trick = 'misperception';
        d.misperception = { witness: W1, wrong: X, t: tw };
        return { type: 'misperception', name: this.name, target: d.victim, witness: W1, wrong: X, effect: '直接の影響なし（犯人の取り違えを誘う）' };
      }
      return null;
    },
  });

  function applyAll(ctx) {
    const { rng } = ctx;
    const n = rng.weighted(A.CONFIG.scale.trickCountWeights);
    const shuffled = rng.shuffle(registry);
    const picked = shuffled.slice(0, n).sort((a, b) => a.order - b.order);
    const spare = shuffled.slice(n);
    const records = [];
    ctx.sanitize();
    for (const p of picked.concat(spare)) {
      if (records.length >= n) break;
      const rec = p.apply(ctx);
      if (rec) records.push(rec);
      ctx.sanitize();
    }
    ctx.tricks = records;
  }

  A.Tricks = { register, registry, applyAll };
})(window.ASARIYA = window.ASARIYA || {});
