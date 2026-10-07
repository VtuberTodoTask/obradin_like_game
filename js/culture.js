// シェルター文化と人物設定（改修仕様 v0.2 §2・§3）
//
// 文化はシェルターごとにランダムに作る（前のシェルターで覚えたルールが次で通用しないように）。
//  - 区画の性格（役割・評判・呼び名）、区画間の関係
//  - 目印：ある属性の値（区画・職能分類・序列の帯）を持つ住人にだけ見られる描写。決定的（描写されたら必ずその値を持つ）
//  - 序列：強さと習慣。番号の習慣（入居順を一意に読み解ける）は必ず一つ持たせ、順番の習慣を1〜2個選ぶ
// 文化のルールは、どの資料にも一般論として書かない。プレイヤーは個別の描写の例から自分で見つける。
(function (A) {
  'use strict';
  const CFG = A.CONFIG;
  const C = () => CFG.culture;
  const PP = () => CFG.people;

  // 区画に役割を割り当てる（住人の区画の割り当てより前に呼ぶ。役割と職能・入居順を確率的に連動させるため）
  function assignRoles(ctx, districts) {
    const { rng } = ctx;
    const roles = rng.sample(Object.keys(C().roles), districts.length);
    const out = {};
    districts.forEach((d, i) => (out[d] = roles[i]));
    return out;
  }

  // 住人を区画に割り当てるときの重み（役割に合う職能・入居の早さなら重くする。必ず一致はさせない）
  function districtWeight(role, jobCode, entryRank) {
    const def = C().roles[role];
    let w = 1;
    if (def.categories && def.categories.includes(CFG.jobByCode[jobCode].category)) w *= 3;
    if (def.entry === 'early' && entryRank < 0.35) w *= 3;
    if (def.entry === 'late' && entryRank > 0.65) w *= 3;
    return w;
  }

  // 住人の割り当てが済んでから、文化の残りと人物設定を作る
  function build(ctx) {
    const { rng } = ctx;
    const cfg = C();
    const districts = ctx.districts;
    const roleOf = ctx.districtRoles;

    // --- 区画の性格（評判・呼び名は区画ごとに別の語）
    const usedNick = new Set();
    const dist = {};
    for (const d of districts) {
      const role = cfg.roles[roleOf[d]];
      const nick = rng.shuffle(role.nicknames).find((n) => !usedNick.has(n)) || role.nicknames[0];
      usedNick.add(nick);
      dist[d] = { role: roleOf[d], role_label: role.label, reputation: rng.pick(role.reputations), nickname: nick, markers: [] };
    }

    // --- 目印の割り当て（目印は全体で重複させない）
    const free = new Set(Object.keys(cfg.markers).filter((m) => !cfg.markers[m].band));
    const takeMarker = (prefCats) => {
      const pool = [...free];
      const pref = pool.filter((m) => (cfg.markers[m].affinity || []).some((c) => prefCats.includes(c)));
      const m = rng.pick(pref.length && rng.chance(0.7) ? pref : pool);
      free.delete(m);
      return m;
    };
    for (const d of districts) {
      const n = rng.int(...cfg.districtMarkers);
      const cats = cfg.roles[roleOf[d]].categories || [];
      for (let i = 0; i < n; i++) dist[d].markers.push(takeMarker(cats));
    }
    const jobMarkers = {};
    for (const c of Object.keys(CFG.categories)) {
      if (c === 'admin') continue; // 相談役は最初から全員分かっているので、管理班の目印は手がかりにならない
      if (rng.chance(cfg.categoryMarkerChance)) jobMarkers[c] = takeMarker([c]);
    }
    let band = null;
    if (rng.chance(cfg.bandMarkerChance)) {
      const bm = rng.pick(Object.keys(cfg.markers).filter((m) => cfg.markers[m].band));
      band = { marker: bm, max_entry: rng.int(...cfg.bandMax) };
    }

    // --- 区画間の関係
    const relations = [];
    for (let i = 0; i < districts.length; i++) {
      for (let j = i + 1; j < districts.length; j++) {
        const [a, b] = rng.chance(0.5) ? [districts[i], districts[j]] : [districts[j], districts[i]];
        relations.push({ a, b, type: rng.weighted(cfg.districtRelations) });
      }
    }

    // --- 序列
    const numberCustom = rng.pick(Object.keys(cfg.numberCustoms));
    const orderCustoms = rng.sample(Object.keys(cfg.orderCustoms), rng.int(1, 2));
    const seniority = {
      strength: rng.weighted(cfg.seniorityStrength),
      number_custom: numberCustom,
      order_customs: orderCustoms,
      honorific: rng.pick(cfg.honorifics),
      band,
    };

    // 目印の定義（このシェルターで使うものだけ。LLM と検証器が描写の語彙として使う）
    const used = new Set([...districts.flatMap((d) => dist[d].markers), ...Object.values(jobMarkers), ...(band ? [band.marker] : [])]);
    const markers = {};
    for (const m of used) {
      const def = cfg.markers[m];
      markers[m] = { kind: def.kind, label: def.label, keywords: def.keywords, self: def.self, other: def.other };
    }
    // 目印 → 属性（論理層の正解。プレイヤーには見せない）
    const markerAttr = {};
    for (const d of districts) for (const m of dist[d].markers) markerAttr[m] = { attr: 'district', value: d };
    for (const [c, m] of Object.entries(jobMarkers)) markerAttr[m] = { attr: 'category', value: c };
    if (band) markerAttr[band.marker] = { attr: 'band', value: band.max_entry };

    ctx.culture = { districts: dist, district_relations: relations, job_markers: jobMarkers, seniority, markers, marker_attr: markerAttr };
    buildPeople(ctx);
  }

  // その住人が持つ目印（属性値から決まる。描写するかどうかは生成器が決める）
  function markersOf(ctx, r) {
    const cu = ctx.culture;
    const out = [...cu.districts[r.district].markers];
    const jm = cu.job_markers[CFG.jobByCode[r.job_code].category];
    if (jm) out.push(jm);
    if (cu.seniority.band && r.entry_order <= cu.seniority.band.max_entry) out.push(cu.seniority.band.marker);
    return out;
  }

  function ageBand(age) {
    return PP().ageBands.find((b) => age <= b.max).key;
  }

  // 人物設定の拡張：性別・年齢層・性格タグ・文化への態度・持続的な特徴・経歴・関係の呼び方
  // 一人称を性別・年齢に合わせる（住人の生成時は性別がまだないため、ここで置き換える。乱数は使わない）
  const PRONOUN_FIT = {
    male: { あたし: '俺', うち: '僕' },
    female: { 俺: 'あたし', 僕: 'わたし', わし: 'うち' },
  };
  function fitPronoun(pronoun, gender, age) {
    let x = (PRONOUN_FIT[gender] || {})[pronoun] || pronoun;
    if (x === 'わし' && age < 50) x = gender === 'female' ? 'うち' : '俺';
    return x;
  }

  function buildPeople(ctx) {
    const { rng } = ctx;
    const pp = PP();
    const traitPool = rng.shuffle(pp.traits);
    let ti = 0;
    for (const r of ctx.residents) {
      const p = r.profile;
      p.gender = rng.weighted(pp.genders);
      // 子どももいるようにする（相談役は大人）
      if (!r.is_counselor && rng.chance(0.08)) p.age = rng.int(11, 15);
      p.age_band = ageBand(p.age);
      p.pronoun = fitPronoun(p.pronoun, p.gender, p.age);
      p.personality_tags = rng.sample(pp.personalityTags, rng.int(2, 3));
      p.personality = p.personality_tags.join('・');
      const others = ctx.districts.filter((d) => d !== r.district);
      p.attitude = {
        seniority: rng.weighted(pp.seniority),
        loyalty: rng.weighted(pp.loyalty),
        // 偏見は自分の区画以外にだけ向ける
        prejudice: rng.chance(pp.prejudiceChance) && others.length ? { district: rng.pick(others), type: rng.pick(Object.keys(pp.prejudiceTypes)) } : null,
      };
      p.traits = [traitPool[ti++ % traitPool.length]].concat(rng.chance(0.4) ? [traitPool[ti++ % traitPool.length]] : []);
      p.markers = markersOf(ctx, r); // 文化の目印（自動で付与。描写は生成器が配置した分だけ）
      p.background = rng.pick(pp.backgrounds);
    }
    // 関係ごとの呼び方
    const byId = ctx.byId;
    const term = (from, to, type, fromIsMentor) => {
      const T = pp.relationTerms;
      const a = byId.get(from).profile;
      const b = byId.get(to).profile;
      if (type === 'family') {
        if (b.age - a.age >= 18) return T.family.olderFar[b.gender];
        if (b.age > a.age) return T.family.older[b.gender];
        return '';
      }
      if (type === 'mentor' && !fromIsMentor) return T.mentor.toMentor;
      return '';
    };
    for (const x of ctx.relations) {
      // 師弟は a が師、b が弟子とする
      x.terms = { a_to_b: term(x.a, x.b, x.type, true), b_to_a: term(x.b, x.a, x.type, false) };
    }
  }

  A.Culture = { assignRoles, districtWeight, build, markersOf, ageBand, fitPronoun };
})(window.ASARIYA = window.ASARIYA || {});
