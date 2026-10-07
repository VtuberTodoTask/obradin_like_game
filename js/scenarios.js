// 目的 → 前提を満たす行動 → 結果 → 知覚 → 解読経路。固定版も同じ事件の型を使う。
(function (A) {
  'use strict';
  const C = A.CONFIG, U = A.util;
  const TYPES = ['equipment', 'ration', 'identity'];
  const LABELS = { equipment: '通電された隔離盤', ration: '配給停止と縦坑', identity: '再開した死者の記録' };
  function generate(seed, opts = {}) {
    if (!Number.isSafeInteger(seed) || seed < 1) throw new Error('シードは正の整数で指定してください');
    const failures = [];
    for (let attempt = 0; attempt < (opts.maxAttempts || C.investigation.maxAttempts); attempt++) {
      const sc = build(seed, opts, attempt);
      const report = A.Verifier.verify(sc);
      if (report.pass) {
        sc.meta.attempts = attempt + 1;
        sc.meta.difficulty = { steps: report.reach.steps.length, per_step: report.reach.perStep };
        return { scenario: sc, report, failures };
      }
      failures.push(report.errors.join(' / '));
    }
    const e = new Error(`シード ${seed}: 生成を検証できませんでした`); e.failures = failures; throw e;
  }
  function build(seed, opts, attempt) {
    const fixed = !!opts.fixed;
    const rng = new A.RNG(A.mixSeed(fixed ? 730 : seed, attempt));
    const type = opts.type || (fixed ? 'equipment' : TYPES[(seed - 1) % TYPES.length]);
    if (!TYPES.includes(type)) throw new Error('対応していない事件の型');
    const size = opts.size || 'standard';
    const n = fixed ? 8 : rng.int(...(size === 'large' ? C.investigation.largeResidents : C.investigation.standardResidents));
    const actorSurvives = fixed || type === 'identity' || rng.chance(C.investigation.actorSurvivalProbability);
    const counselorSurvives = !(type === 'ration' && !actorSurvives && rng.chance(C.investigation.emptyShelterProbability));
    const collapse = type === 'equipment' && !fixed && rng.chance(0.35);
    const counselors = C.investigation.counselors;
    if (counselors !== 2) throw new Error('現在の事件の型は相談役2人を必要とします');
    const jobLists = {
      equipment: [51, 51, 31, 23, 11, 41, 52, 32],
      ration: [51, 51, 23, 31, 11, 41, 52, 22],
      identity: [51, 51, 11, 12, 52, 41, 23, 32],
    };
    const jobs = jobLists[type].slice();
    while (jobs.length < n) jobs.push(rng.pick([21, 22, 33, 41, 42, jobs[2]]));
    const surnames = rng.sample(C.names.surnames, n), given = rng.sample(C.names.given, n);
    const marks = rng.shuffle(['葉形', '輪形', '矢形']);
    const districts = ['A', 'B', 'C'];
    const districtFor = ['A', 'B', 'C', 'A', 'B', 'C', 'A', 'B'];
    while (districtFor.length < n) districtFor.push(rng.pick(districts));
    const tokens = new Set();
    while (tokens.size < n) tokens.add(rng.int(0, 0xffffff).toString(36).padStart(5, '0'));
    const tokenList = [...tokens];
    const residents = jobs.map((j, i) => ({
      id: `${districtFor[i]}-${U.pad2(i + 1)}-${j}`, token: tokenList[i], name: surnames[i] + given[i],
      district: districtFor[i], entry_order: i + 1, job_code: j, is_counselor: i < 2,
      profile: { age: rng.int(25, 67), gender: rng.pick(['male', 'female']), personality: rng.pick(C.personalities),
        pronoun: i === 2 ? '俺' : '私', style: 'plain', tic: '', traits: [],
        goal: i === 2 ? '自分の生存と権限を守る' : i === 4 ? '記録の食い違いを公にする' : '仲間を救う' },
      status: i === 1 && counselorSurvives || i === 2 && actorSurvives ? 'alive' : 'dead',
    }));
    const ids = residents.map((r) => r.id);
    const [c1, c2, actor, witness, victim, guard] = ids;
    const nowDay = type === 'ration' ? n + 31 : 24;
    const sc = {
      meta: { seed, version: C.version, generator: 'incident-v2', fixed, size,
        mode: opts.mode || C.investigation.defaultMode, type, title: LABELS[type] },
      shelter: { name: fixed ? '基準シェルター「灯台」' : `第${rng.int(3, 48)}シェルター「${rng.pick(C.shelterNames)}」`,
        districts, max_entry: n, resident_count: n, crisis: type === 'equipment' ? 'leak' : type === 'ration' ? 'famine' : 'outbreak',
        crisis_day: 2, now_day: nowDay, last_death_day: 0, supplies: type === 'ration' ? 'depleted' : 'low' },
      residents, relations: [{ a: actor, b: witness, type: 'mentor', known_to_ai: false },
        { a: actor, b: victim, type: 'rival', known_to_ai: false }], deaths: [], tricks: [],
      documents: { chip_logs: Object.fromEntries(ids.map((id) => [id, []])), counselor_dialogues: [], hatch_log: [],
        job_code_table: C.jobs.map((j) => ({ code: j.code, category: C.categories[j.category], name: j.name })) },
      initial_known_ids: [c1, c2], facts: [], story: { scenes: [], incidents: [] },
      culture: { marker_attr: 'district', markers: Object.fromEntries(districts.map((d, i) => [marks[i], d])) },
      publicCulture: { marks, hypotheses: ['district', 'category', 'band'], bands: [[1, 3], [4, n]],
        text: '支給上着の縫い印は、区画・職能分類・入居の帯のいずれか一つの系統で配られる。同じ系統には同じ印、異なる系統には違う印を渡す。入居の帯は01〜03番と04番以降。入居台帳は受付順の連続した記録で、欠番や抹消はない。当番表の担当欄には登録資格を持つ者だけを載せ、手伝いは補助欄へ記す。入居受付票の番号はその台帳の入居順を表す。線量計はmSvで積算し、このシェルターの医療票では900mSv以上を致死域の被曝と判定する。架空病Kの試薬は判定コード1を感染陽性とする。' },
      solution: { stages: [], transplant: null, intruder: null, reinterpretations: [] },
    };
    sc.documents.overview = { shelter_name: sc.shelter.name, districts, resident_count: n, max_entry: n, counselors: [c1, c2], now_day: nowDay };
    let serial = 0;
    function add(owner, t, role, observations, doc = 'log') {
      const es = doc === 'log' ? sc.documents.chip_logs[owner] : doc === 'hatch' ? sc.documents.hatch_log : sc.documents.counselor_dialogues;
      const loc = { doc, ...(doc === 'log' ? { owner } : {}), index: es.length };
      const facts = observations.map(([type, args]) => {
        if (type === 'PLAN') delete args.scope;
        const qualification = { KEY: '専任資格', SWITCH: '電気の専任資格', PUSH: '配給管理の専任資格', INJECT: '医師の専任資格' }[type];
        if (qualification) args.qualification = qualification;
        const f = { id: `e${++serial}`, type, args, certainty: type === 'CLAIM' || type === 'OFFICIAL' ? 'claim' : 'observation', loc,
          sourceGroup: `${doc}:${owner}:${t}`, scope: args.scope || '近距離の観察または機器の測定' };
        sc.facts.push(f); return f;
      });
      const text = facts.map(A.Evidence.render).join('\n');
      const e = { t, timestamp: U.fmtT(t), kind: role === '最期の身体' ? 'final' : role === '身元の証拠' ? 'daily' : 'witness',
        role, text, writer: owner, facts: facts.map((f) => f.id), rendered: facts.map((f) => f.id), deleted: false, emotion: 'anxiety',
        scene: `s${serial}`, perceived: [], narrator: undefined };
      if (role === '最期の身体') {
        const signal = { id: `e${++serial}`, type: 'PULSE_END', args: { p: owner, t }, loc,
          certainty: 'measurement', sourceGroup: `machine:${owner}:${t}`, scope: '医療端末の自動付記' };
        sc.facts.push(signal); e.facts.push(signal.id); e.rendered.push(signal.id);
        e.machineFacts = [signal.id]; e.machineText = A.Evidence.render(signal);
      }
      if (doc === 'dialogue') e.lines = [{ speaker: owner || 'AI', text }];
      if (doc === 'hatch') Object.assign(e, { side: observations[0][1].side === '外側' ? 'outside' : 'inside', auth: null });
      es.push(e);
      sc.story.scenes.push({ id: e.scene, t, timestamp: e.timestamp, day: U.dayOf(t), title: role, kind: 'record',
        place: 'archive', place_name: '記録を残した場所', participants: [owner].filter(Boolean), events: [], causes: [], facts: e.facts,
        details: [], perspective: { objective: residents.find((r) => r.id === owner)?.profile.goal, observations: facts.map((f) => ({ type: f.type, args: f.args })),
          scope: facts.map((f) => f.scope) } });
      return e;
    }
    // 身元は独立した文化例と順序制約から解く。本人の未解読記録に入口の証拠を置かない。
    for (let i = 0; i < 2; i++) add(ids[i], U.tAbs(1, 500 + i * 10), '文化の比較', [
      ['MARKER', { p: ids[i], mark: marks[i] }],
    ]);
    for (let i = 2; i < n; i++) {
      const p = ids[i], q = ids[i - 1], owner = i === 2 ? c1 : i === 3 ? c2 : ids[i - 2];
      const districtObs = i === 2
        ? ['HOME', { p, district: residents[i].district }]
        : ['MARKER', { p, mark: marks[districts.indexOf(residents[i].district)] }];
      add(owner, U.tAbs(1, 600 + i * 12), '身元の証拠', i === 2 ? [districtObs] : [districtObs, ['WORK', { p, task: A.Evidence.tasks[jobs[i]] }]]);
      let orderObs;
      if (i === 2) orderObs = ['NUMBER', { p, n: 3 }];
      else if (i === n - 1) orderObs = ['LAST', { p }];
      else orderObs = [i % 2 ? 'PREVIOUS' : 'NEXT', i % 2 ? { p: q, q: p } : { p, q }];
      // 「より後」は通し番号・全員別番号・末尾既知と併せて使う。他の順序証拠と同時に解ける。
      add(owner, U.tAbs(1, 606 + i * 12), '身元の証拠', [orderObs]);
    }
    // 既読資料の二つの引っ掛かり。解読後の記録は単なる名前の置換以上の意味を持つ。
    const early1 = add(c1, U.tAbs(4, type === 'identity' ? 660 : 597), '後で意味が変わる伏線', [
      ['WORDS', { p: actor, quote: type === 'equipment' ? '止めておいた。もう触っていい' : type === 'ration' ? '自分の分だけは確保した' : `{P:${victim}}の記録が再開した。本人が戻ったはずだ`, scope: '発言' }],
    ], 'dialogue');
    const early2 = add(c2, U.tAbs(2, 490), '後で意味が変わる伏線', [
      ['WORDS', { p: witness, quote: '先生に任せた', scope: '呼びかけ' }],
    ], 'dialogue');
    const motive = add(actor, U.tAbs(2, 520), '目的と選択', [
      ['PLAN', { p: actor, goal: '自分だけが生き延びる', choice: type === 'equipment' ? '危険を告げず設備を動かすこと' : type === 'ration' ? '他人への配給を止めて倉庫の在庫を隠すこと' : '別のチップで記録を続けること', scope: '本人が残した決意' }],
    ]);
    const mentor = add(witness, U.tAbs(2, 525), '呼称と関係', [
      ['MENTOR', { p: witness, q: actor, lesson: type === 'equipment' ? '回路の測定' : type === 'ration' ? '配給票の扱い' : '採血の手順' }],
    ]);
    const incident = { id: 'central', type, title: LABELS[type], participants: [actor, victim, witness],
      objectives: [{ p: actor, goal: residents[2].profile.goal }, { p: victim, goal: residents[4].profile.goal }],
      actions: [], consequences: [], evidence: [], downstream: [] };
    sc.story.incidents.push(incident);
    const actionT = U.tAbs(4, 600), terminalT = actionT + 1;
    const key = String(rng.int(300, 999)), device = `隔離盤${rng.pick(['赤', '青', '白'])}`;
    const addAction = (id, p, t, verb, preconditions, causes = []) => {
      const a = { id, p, t, verb, place: type === 'ration' ? '縦坑' : type === 'equipment' ? '機械室' : '処置室', preconditions, causes };
      incident.actions.push(a); return a;
    };
    const addDeath = (p, cause, killer, t, action, location) => {
      sc.deaths.push({ victim: p, cause, killer, t, day: U.dayOf(t), time: U.fmtT(t), location, action,
        signs: [], recorded_cause: null, trick: null });
      incident.consequences.push({ p, t, status: 'dead', cause, killer, causes: [action] });
    };
    let decisive, privateProof = motive;
    if (type === 'equipment') {
      add(c1, U.tAbs(3, 400), '危機の前提', [['FAULT', { day: '03', device, defect: '接地線の断線', hazard: '通電すれば筐体に触れた人が感電する' }]]);
      add(c1, actionT + 30, '権限の引き継ぎ', [['KEY', { p: actor, serial: key, start: actionT - 15, end: terminalT + 20 }]]);
      privateProof = add(actor, actionT - 5, '故障への認識', [['ACK', { p: actor, device, t: actionT - 10 }]]);
      decisive = add(witness, actionT + 3, '設備操作の観察', [['SWITCH', { t: actionT, device, serial: key, operation: '遮断を解除し通電' }]]);
      add(c2, terminalT + 2, '死亡の確認', [['SHOCK', { t: terminalT, v: victim, device }]]);
      addAction('fault', actor, U.tAbs(3, 400), '断線を点検して認識', [{ kind: 'job', code: 31 }]);
      addAction('power', actor, actionT, '故障を知りながら通電', [{ kind: 'job', code: 31 }, { kind: 'key', serial: key }], ['fault']);
      addDeath(victim, 'murder', actor, terminalT, 'power', 'generator_room');
    } else if (type === 'ration') {
      add(c1, U.tAbs(3, 400), '対立の争点', [['PLAN', { p: victim, goal: '配給の受領欄と在庫の食い違いを公にする', choice: '縦坑脇で担当者と会うこと', scope: '本人の予定' }]], 'dialogue');
      add(c1, actionT + 30, '継続的な所持', [['GEAR', { p: actor, serial: key, start: actionT - 15, end: terminalT + 20 }]]);
      decisive = add(witness, actionT + 3, '接触の観察', [['PUSH', { t: actionT, serial: key, v: victim, scope: '青い縫い目から肩まで途切れない両腕' }]]);
      add(c2, terminalT + 2, '死亡の確認', [['FALL', { t: terminalT, v: victim }]]);
      addAction('dispute', victim, U.tAbs(3, 400), '配給の隠匿を調査', [{ kind: 'job', code: 11 }]);
      addAction('push', actor, actionT, '受領票を隠すため突き落とす', [{ kind: 'job', code: 23 }, { kind: 'gear', serial: key }], ['dispute']);
      addDeath(victim, 'murder', actor, terminalT, 'push', 'shaft');
    } else {
      add(c1, U.tAbs(3, 400), '治療の条件', [['LIMIT', { drug: 'ネムリ液', limit: 2 }]], 'dialogue');
      add(c1, actionT + 30, '継続的な所持', [['KIT', { p: actor, serial: key, start: actionT - 15, end: terminalT + 20 }]]);
      privateProof = add(actor, actionT - 3, '薬剤の警告への認識', [['DOSE_SETTING', { p: actor, t: actionT - 5, drug: 'ネムリ液', limit: 2, amount: 30 }]]);
      decisive = add(witness, actionT + 3, '投与の観察', [['INJECT', { t: actionT, serial: key, drug: 'ネムリ液', amount: 30, v: victim }]]);
      add(c2, terminalT + 2, '死亡の確認', [['STOP', { t: terminalT, v: victim }]]);
      addAction('dose', actor, actionT, '致死量を静脈投与', [{ kind: 'job', code: 11 }, { kind: 'kit', serial: key }, { kind: 'knowledge', drug: 'ネムリ液' }]);
      addDeath(victim, 'murder', actor, terminalT, 'dose', 'medical_room');
    }
    add(victim, terminalT, '最期の身体', [['LAST_SENSE', { p: victim, t: terminalT,
      feeling: type === 'equipment' ? '指先の熱と全身の跳ね' : type === 'ration' ? '背中への衝撃と落下' : '注射の痛みと息苦しさ' }]]);
    // 誤認の確信と弱い正証言は、表現の強さで判定せず、映像・操作番号と照合する。
    const earlyClaim = add(c2, actionT + 10, '確信を持つ誤証言', [['CLAIM', { p: witness, q: guard, scope: '遠い暗がりの輪郭だけ' }]], 'dialogue');
    const alibi = add(guard, actionT + 21, '反証', [['ALIBI', { p: guard, start: actionT - 20, end: actionT + 20, place: '保安室' }]]);
    add(witness, actionT + 12, '弱い表現の正証言', [['TESTIMONY', { p: witness, quote: '青い印の道具を持つ人が操作した', scope: '手元だけ見えた' }]]);
    sc.tricks.push({ type: 'misperception', name: '主観の誤認', target: victim, wrong: guard, witness });
    const disguise = type !== 'identity' && (fixed || seed % 2 === 0 || opts.trick === 'death_disguise');
    if (disguise) {
      add(c2, actionT + 25, '偽の公式登録', [['OFFICIAL', { p: c2, v: victim, label: '事故' }]], 'dialogue');
      sc.deaths[0].recorded_cause = 'accident';
      sc.tricks.push({ type: 'death_disguise', name: '死因の偽装', target: victim, actor: c2, recorded_cause: 'accident' });
    }
    const tamper = fixed || seed % 5 === 0 || opts.trick === 'log_tamper';
    if (tamper) {
      const deleted = sc.documents.chip_logs[victim].find((e) => e.kind === 'final');
      const removed = new Set(deleted.facts); sc.facts = sc.facts.filter((f) => !removed.has(f.id));
      deleted.deleted = true; deleted.text = ''; deleted.facts = []; deleted.rendered = [];
      add(c2, actionT + 30, '変更の監査記録', [['REVISION', { owner: victim, t: terminalT, old: '1', new: '2' }]], 'dialogue');
      sc.tricks.push({ type: 'log_tamper', name: 'ログの改ざん', target: victim, actor: c2, hidden_cause: 'murder' });
    }
    // 生存判定に必要な移植の検査。身体の死とチップの更新を分ける。
    const transplant = type === 'identity';
    if (transplant) {
      const chip = `T${rng.int(100, 999)}`, feature = '小指の欠損と三本の古い傷';
      add(witness, U.tAbs(3, 500), '身体特徴の比較', [['FEATURE', { p: actor, feature }]]);
      add(witness, terminalT + 60, '摘出と更新時刻', [['CHIP', { owner: victim, serial: chip, t: terminalT + 45 }]]);
      add(victim, U.tAbs(nowDay, 600), '記録の身体が違う', [['CARRIER', { t: U.tAbs(nowDay, 600), serial: chip, feature, place: '奥の隔離室' }]]);
      sc.solution.transplant = { victim, carrier: actor, t: terminalT + 45 };
      sc.tricks.push({ type: 'chip_transplant', name: 'チップの移植', target: victim, actor });
      addAction('transplant', actor, terminalT + 45, '死者のチップを装着', [{ kind: 'job', code: 11 }], ['dose']);
    }
    // 補助事件: 同じ危機を共有しても、一人ずつの接触・検査・経過を残す。
    const crisis = { id: 'crisis', type: collapse ? 'collapse' : sc.shelter.crisis, participants: ids.filter((p) => (p !== actor || !actorSurvives) && p !== c2 && p !== victim),
      objectives: [{ p: witness, goal: '救助する' }], actions: [], consequences: [], evidence: [], downstream: [] };
    sc.story.incidents.push(crisis);
    for (let i = 0; i < n; i++) {
      const p = ids[i];
      if ([c2, victim].includes(p) || p === actor && actorSurvives) continue;
      const exposureT = U.tAbs(2, 800 + i * 5);
      const deathT = U.tAbs(type === 'ration' ? 25 + i : collapse ? 10 : 10 + i, 700);
      const cause = collapse ? 'accident' : type === 'equipment' ? 'radiation' : type === 'ration' ? 'starvation' : 'infection';
      const a = { id: `exposure${i}`, p, t: exposureT, verb: type === 'ration' ? '食事の供給停止' : '救助中に危険源へ接触', place: '救助区画',
        preconditions: [], causes: [] };
      crisis.actions.push(a);
      if (collapse) {
        add(p, exposureT, '救助の目的', [['PLAN', { p, goal: '通路に残る資材を回収する', choice: '梁の下へ救助に入ること', scope: '自分で決めた行動' }]]);
        add(c2, deathT + 1, '死亡の確認', [['COLLAPSE', { p, t: deathT }]]);
        a.t = deathT - 1; a.verb = '共通する梁の崩落に巻き込まれる';
      } else if (cause === 'starvation') {
        add(p, exposureT, '配給停止の経過', [['RATIONS', { p, t: exposureT }]]);
        add(c2, deathT + 1, '死亡の確認', [['STARVE', { p, t: deathT, days: U.dayOf(deathT) - 2 }]]);
      } else {
        const source = cause === 'radiation' ? '亀裂のある遮蔽壁' : '発症した隔離患者の病床';
        add(p, exposureT, '接触と検査', [
          ['EXPOSE', { p, t: exposureT, source, route: cause === 'radiation' ? '線量計を持って救助に入った' : '防護具が破れたまま看護した' }],
          ['TEST', { p, t: exposureT + (cause === 'infection' ? U.DAY * 3 : 30), method: cause === 'radiation' ? '積算線量計' : '架空病K専用の検査試薬',
            value: cause === 'radiation' ? 900 : 1, unit: cause === 'radiation' ? 'mSv' : '（判定コード）', meaning: cause === 'radiation' ? '致死域の被曝を示す' : '感染成立を示す陽性だった' }],
        ]);
        // 感染は接触 → 三日後の検査 → 発症を経て死。被曝も接触前に症状を置かない。
        const es = sc.documents.chip_logs[p];
        es[es.length - 1].t = exposureT + (cause === 'infection' ? U.DAY * 3 : 30);
        es[es.length - 1].timestamp = U.fmtT(es[es.length - 1].t);
        sc.story.scenes[sc.story.scenes.length - 1].t = es[es.length - 1].t;
        add(c2, deathT + 1, '死亡の確認', [['TERMINAL', { p, t: deathT, sign: cause === 'radiation' ? '皮膚の剥離と吐き気' : '発熱と赤い発疹' }]]);
      }
      add(p, deathT, '最期の身体', [['LAST_SENSE', { p, t: deathT, feeling: collapse ? '天井の軋みと瓦礫の重み' : cause === 'starvation' ? '空腹と指が動かない感覚' : cause === 'radiation' ? '皮膚の痛みと線量警報' : '発熱と息苦しさ' }]]);
      sc.deaths.push({ victim: p, cause, killer: null, t: deathT, day: U.dayOf(deathT), time: U.fmtT(deathT), location: 'quarters',
        action: a.id, signs: [], recorded_cause: null, trick: null });
      crisis.consequences.push({ p, t: deathT, status: 'dead', cause, killer: null, causes: [a.id] });
    }
    // 侵入者: ハッチ、襲撃、帰路を照合し、住人の認証と混同しない。
    const intruder = !fixed && !transplant && (seed % 7 === 0 || opts.trick === 'unrecorded_person');
    if (intruder) {
      const p = ids[n - 1], d = sc.deaths.find((d) => d.victim === p);
      const enterT = d.t - 20;
      add(null, enterT, '認証なしの通過', [['HATCH', { t: enterT, side: '外側' }]], 'hatch');
      // 重ねた死因を作らず、行動と最終証拠を丸ごと置換する。
      const last = sc.documents.chip_logs[c2].find((e) => e.facts.some((id) => sc.facts.find((f) => f.id === id)?.args.p === p && ['TERMINAL', 'STARVE', 'COLLAPSE'].includes(sc.facts.find((f) => f.id === id)?.type)));
      const oldFacts = new Set(last.facts); sc.facts = sc.facts.filter((f) => !oldFacts.has(f.id));
      const f = { id: `e${++serial}`, type: 'RAID', args: { t: d.t, v: p, place: '物資庫' }, certainty: 'observation',
        loc: { doc: 'log', owner: c2, index: sc.documents.chip_logs[c2].indexOf(last) } };
      sc.facts.push(f); last.facts = [f.id]; last.rendered = [f.id]; last.text = A.Evidence.render(f);
      const own = sc.documents.chip_logs[p].find((e) => e.kind === 'final');
      const sense = sc.facts.find((f) => f.id === own.facts[0]); sense.args.feeling = '刃物の痛みと外套の影'; own.text = A.Evidence.render(sense);
      d.cause = 'intruder'; d.action = 'raid';
      const result = crisis.consequences.find((x) => x.p === p); result.cause = 'intruder'; result.causes = ['raid'];
      crisis.actions.push({ id: 'entry', p: null, t: enterT, verb: '外側から侵入', place: '外部ハッチ', preconditions: [], causes: [] },
        { id: 'raid', p: null, t: d.t - 1, verb: '外来者の襲撃', place: '物資庫', preconditions: [], causes: ['entry'] });
      const present = seed % 2 === 1;
      if (!present) add(null, d.t + 20, '認証なしの通過', [['HATCH', { t: d.t + 20, side: '内側' }]], 'hatch');
      sc.solution.intruder = { present, enterT, exitT: present ? null : d.t + 20, victims: [p] };
      sc.tricks.push({ type: 'unrecorded_person', name: '記録にない人物', targets: [p], present, variant: 'intruder' });
    }
    const currentT = U.tAbs(nowDay, 700);
    if (counselorSurvives) add(c2, currentT, '現在の生存', [['LIVE', { p: c2, t: currentT, place: '備蓄庫脇の寝室' }]]);
    else {
      const exposureT = U.tAbs(2, 830), deathT = U.tAbs(Math.max(...sc.deaths.map((d) => d.day)) + 1, 700);
      add(c2, exposureT, '配給停止の経過', [['RATIONS', { p: c2, t: exposureT }]]);
      add(c2, deathT, '最期の身体', [['LAST_SENSE', { p: c2, t: deathT, feeling: '空腹と指が動かない感覚' }]]);
      add(null, deathT + 20, '身体の停止の自動記録', [['BODY_SENSOR', { p: c2, t: deathT }]], 'dialogue');
      const action = { id: 'counselor_food', p: c2, t: exposureT, verb: '食事の供給停止', place: '寝室', preconditions: [], causes: [] };
      crisis.actions.push(action); crisis.participants.push(c2);
      crisis.consequences.push({ p: c2, t: deathT, status: 'dead', cause: 'starvation', killer: null, causes: [action.id] });
      sc.deaths.push({ victim: c2, cause: 'starvation', killer: null, t: deathT, day: U.dayOf(deathT), time: U.fmtT(deathT), location: 'quarters', action: action.id, signs: [] });
    }
    if (!transplant && actorSurvives) add(actor, currentT, '現在の生存', [['LIVE', { p: actor, t: currentT, place: '奥の隔離室' }]]);
    add(counselorSurvives ? c2 : null, currentT + 1, '現在の物資', [['SUPPLIES', { t: currentT + 1, state: type === 'ration' ? '空' : '少量ある' }]], counselorSurvives ? 'log' : 'dialogue');
    const causes = new Set(sc.deaths.map((d) => d.cause)), reasons = actorSurvives ? ['潜伏者'] : [];
    if (causes.has('infection')) reasons.push('感染');
    if (causes.has('radiation')) reasons.push('汚染');
    if (sc.solution.intruder?.present) reasons.push('侵入者');
    sc.current_state = { survivors: [counselorSurvives ? c2 : null, actorSurvives ? actor : null].filter(Boolean), hidden_threats: reasons, intruder: sc.solution.intruder ? { present: sc.solution.intruder.present } : null,
      verdict: { result: reasons.length ? 'danger' : type === 'ration' ? 'worthless' : 'safe', reasons } };
    sc.shelter.last_death_day = Math.max(...sc.deaths.map((d) => d.day));
    sc.solution.reinterpretations = [
      { earlier: early1.facts, unlock: actor, added: [...new Set(motive.facts.concat(privateProof.facts, decisive.facts,
        type === 'identity' ? sc.facts.filter((f) => ['CHIP', 'CARRIER', 'FEATURE', 'STOP'].includes(f.type)).map((f) => f.id) : []))],
        before: type === 'equipment' ? '単なる故障事故か、意図した通電か' : type === 'ration' ? '全体に物資がないのか、一部が隠されたのか' : '記録再開は本人の回復を意味するか',
        after: type === 'equipment' ? '専任者が故障を認識してから通電した。停止したという発言は安全の保証にならない' : type === 'ration' ? '個人への配給停止と倉庫の備蓄は別。隠匿の調査者への接触が殺害につながる' : '身体が死んでもチップが別の身体で更新する。現在までの更新は元の人の生存ではない' },
      { earlier: earlyClaim.facts, unlock: guard, added: alibi.facts.concat(decisive.facts), before: '輪郭を見た証言者は、この人の犯行に確信を持っている',
        after: '連続映像ではその人物は保安室から出ていない。確信した人違いを排除し、道具と操作の証拠へ戻って加害者を確定する',
        alternative: '道具の所持と操作主体の照合も別人を示す。本人の解読では、現場にいなかったという独立した所在の反証が開く。' },
    ];
    // 時刻順へ並べた後、出典の添字を必ず更新する。
    const factMap = new Map(sc.facts.map((f) => [f.id, f]));
    for (const [owner, es] of Object.entries(sc.documents.chip_logs)) {
      es.sort((a, b) => a.t - b.t);
      es.forEach((e, index) => e.facts.forEach((id) => { factMap.get(id).loc = { doc: 'log', owner, index }; }));
    }
    A.Semantics.attach(sc);
    return sc;
  }
  A.Incidents = { types: TYPES, labels: LABELS, build };
  A.Generator = { generate, fixed: () => generate(730, { fixed: true }) };
})(window.ASARIYA = window.ASARIYA || {});
