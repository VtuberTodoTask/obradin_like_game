// 推論に渡すのは本文の抽出結果と公開情報のみ。真相は verify の最終照合専用。
(function (A) {
  'use strict';
  const U = A.util, E = A.Evidence;
  const taskToJob = new Map(Object.entries(E.tasks).map(([j, task]) => [task, Number(j)]));
  const pick = (fs, type) => fs.filter((f) => f.type === type);
  const refs = (fs) => [...new Set(fs.filter(Boolean).map((f) => f.source))];

  function cultureCandidates(sc, fs, known) {
    const marks = sc.publicCulture.marks;
    const result = [];
    // 全単射の候補を列挙する。真の marker_attr / markers には触れない。
    for (const attr of sc.publicCulture.hypotheses) {
      const values = attr === 'district' ? sc.documents.overview.districts : attr === 'category'
        ? [...new Set(sc.documents.job_code_table.map((j) => j.category))] : sc.publicCulture.bands.map((_, i) => i);
      const groups = new Map();
      for (const f of pick(fs, 'MARKER')) {
        if (!known.has(f.args.p)) continue;
        const [d, e, j] = known.get(f.args.p).split('-');
        const value = attr === 'district' ? d : attr === 'category' ? sc.documents.job_code_table.find((x) => x.code === Number(j)).category
          : sc.publicCulture.bands.findIndex(([a, b]) => Number(e) >= a && Number(e) <= b);
        if (!groups.has(f.args.mark)) groups.set(f.args.mark, new Set());
        groups.get(f.args.mark).add(value);
      }
      const walk = (index, mapping) => {
        if (index === marks.length) { result.push({ attr, mapping: { ...mapping } }); return; }
        const mark = marks[index], observed = groups.get(mark) || new Set();
        for (const value of values) {
          if (Object.values(mapping).includes(value) || [...observed].some((v) => v !== value)) continue;
          mapping[mark] = value; walk(index + 1, mapping); delete mapping[mark];
        }
      };
      walk(0, {});
    }
    return result;
  }
  function identity(sc, fs, known) {
    const people = sc.residents.map((r) => r.id); // ここでは不透明な人物参照としてのみ利用。
    const index = new Map(people.map((p, i) => [p, i]));
    const candidateRules = cultureCandidates(sc, fs, known);
    const constraints = [];
    // 匿名の操作と継続した道具の所持を結ぶと、操作主体の専任資格が読める。
    // 私人の持ち物だけ、あるいは単なる手伝いの作業だけでは職能を確定しない。
    for (const [actionType, itemType, job] of [['SWITCH', 'KEY', 31], ['PUSH', 'GEAR', 23], ['INJECT', 'KIT', 11]]) {
      for (const action of pick(fs, actionType)) for (const item of pick(fs, itemType)) {
        if (action.args.serial === item.args.serial && item.args.start <= action.args.t && item.args.end >= action.args.t)
          constraints.push({ type: 'J', p: item.args.p, value: job, sources: refs([action, item]) });
      }
    }
    for (const f of fs) {
      const g = f.args;
      if (f.type === 'HOME') constraints.push({ type: 'D', p: g.p, value: g.district, sources: refs([f]) });
      if (f.type === 'WORK' && taskToJob.has(g.task)) constraints.push({ type: 'J', p: g.p, value: taskToJob.get(g.task), sources: refs([f]) });
      if (f.type === 'MARKER' && candidateRules.length) {
        const values = candidateRules.map((r) => `${r.attr}:${r.mapping[g.mark]}`);
        if (new Set(values).size === 1 && candidateRules[0].attr === 'district') constraints.push({ type: 'D', p: g.p,
          value: candidateRules[0].mapping[g.mark], sources: refs([f, ...pick(fs, 'MARKER').filter((x) => known.has(x.args.p))]) });
      }
      if (f.type === 'NUMBER') constraints.push({ type: 'E', p: g.p, value: g.n, sources: refs([f]) });
      if (f.type === 'LAST') constraints.push({ type: 'E', p: g.p, value: sc.documents.overview.max_entry, sources: refs([f]) });
    }
    const out = {}, derivations = [];
    for (const comp of ['D', 'E', 'J']) {
      const base = comp === 'D' ? sc.documents.overview.districts : comp === 'E' ? U.range(1, sc.documents.overview.max_entry)
        : sc.documents.job_code_table.map((j) => j.code);
      const doms = people.map((p) => known.has(p) ? [comp === 'D' ? known.get(p).split('-')[0] : Number(known.get(p).split('-')[comp === 'E' ? 1 : 2])]
        : base.filter((v) => comp !== 'J' || v !== 51));
      for (const c of constraints.filter((x) => x.type === comp)) {
        if (index.has(c.p)) doms[index.get(c.p)] = doms[index.get(c.p)].filter((v) => v === c.value);
      }
      const cons = [];
      if (comp === 'E') {
        for (let i = 0; i < people.length; i++) for (let j = i + 1; j < people.length; j++) cons.push({ a: i, b: j, check: (x, y) => x !== y });
        for (const f of fs) {
          if (!['NEXT', 'PREVIOUS', 'BEFORE'].includes(f.type) || !index.has(f.args.p) || !index.has(f.args.q)) continue;
          cons.push({ a: index.get(f.args.p), b: index.get(f.args.q), check: f.type === 'NEXT' ? (x, y) => x === y + 1
            : f.type === 'PREVIOUS' ? (x, y) => x === y - 1 : (x, y) => x > y });
        }
      }
      const candidates = people.map((p, i) => known.has(p) ? -1 : i).filter((i) => i >= 0);
      const solved = A.Solver.uniqueVars(doms, cons, candidates);
      out[comp] = solved;
      if (!solved) return { decoded: [], errors: [`公開された身元証拠が矛盾 (${comp})`], candidateRules, derivations };
    }
    const decoded = [];
    for (let i = 0; i < people.length; i++) {
      if (known.has(people[i]) || !['D', 'E', 'J'].every((c) => out[c].uniq.has(i))) continue;
      const id = `${out.D.sol[i]}-${U.pad2(out.E.sol[i])}-${out.J.sol[i]}`;
      decoded.push({ p: people[i], id });
      derivations.push({ p: people[i], id,
        D: constraints.filter((x) => x.p === people[i] && x.type === 'D').flatMap((x) => x.sources),
        J: constraints.filter((x) => x.p === people[i] && x.type === 'J').flatMap((x) => x.sources),
        E: refs(fs.filter((f) => ['NUMBER', 'LAST', 'NEXT', 'PREVIOUS', 'BEFORE'].includes(f.type))) });
    }
    return { decoded, errors: [], candidateRules, derivations };
  }

  function derive(sc, fs) {
    const people = Object.fromEntries(sc.residents.map((r) => [r.id, { status: 'ambiguous', causes: [], killers: [], derivations: [] }]));
    const deathResults = new Map(), aliveResults = new Map();
    function dead(p, cause, k, observations, rule) {
      if (!people[p]) return;
      if (!deathResults.has(p)) deathResults.set(p, []);
      deathResults.get(p).push({ cause, k, sources: refs(observations), rule });
    }
    function alive(p, observations, rule) {
      if (!people[p]) return;
      if (!aliveResults.has(p)) aliveResults.set(p, []);
      aliveResults.get(p).push({ sources: refs(observations), rule });
    }
    const now = U.tAbs(sc.documents.overview.now_day, 0);
    for (const live of pick(fs, 'LIVE')) if (live.args.t >= now) alive(live.args.p, [live], '当日の身体計測と映像');
    for (const terminal of pick(fs, 'SHOCK')) {
      const g = terminal.args;
      const faults = pick(fs, 'FAULT').filter((f) => f.args.device === g.device && f.args.defect === '接地線の断線' && f.args.hazard === '通電すれば筐体に触れた人が感電する');
      for (const op of pick(fs, 'SWITCH').filter((f) => f.args.device === g.device && f.args.t + 1 === g.t && f.args.operation === '遮断を解除し通電')) {
        for (const key of pick(fs, 'KEY').filter((f) => f.args.serial === op.args.serial && f.args.start <= op.args.t && f.args.end >= op.args.t)) {
          const ack = pick(fs, 'ACK').find((f) => f.args.p === key.args.p && f.args.device === g.device && f.args.t < op.args.t);
          const words = pick(fs, 'WORDS').find((f) => f.args.p === key.args.p && f.args.quote === '止めておいた。もう触っていい');
          if (faults.length && ack && words) dead(g.v, 'murder', key.args.p, [terminal, op, key, ack, words, faults[0]], '故障認識＋専用鍵＋通電履歴＋安全を偽る発言＋身体の感電');
        }
      }
      // 必要な操作記録がなければ事故説が残る。感電という単独観察を殺人へ昇格させない。
    }
    for (const terminal of pick(fs, 'FALL')) {
      for (const push of pick(fs, 'PUSH').filter((f) => f.args.v === terminal.args.v && f.args.t + 1 === terminal.args.t && f.args.scope === '青い縫い目から肩まで途切れない両腕')) {
        for (const gear of pick(fs, 'GEAR').filter((f) => f.args.serial === push.args.serial && f.args.start <= push.args.t && f.args.end >= push.args.t))
          dead(terminal.args.v, 'murder', gear.args.p, [terminal, push, gear], '足場正常＋意図的な両腕の接触＋貸出なしの手袋');
      }
    }
    for (const terminal of pick(fs, 'STOP')) {
      for (const injection of pick(fs, 'INJECT').filter((f) => f.args.v === terminal.args.v && f.args.t + 1 === terminal.args.t)) {
        for (const limit of pick(fs, 'LIMIT').filter((f) => f.args.drug === injection.args.drug && injection.args.amount >= f.args.limit * 10)) {
          for (const kit of pick(fs, 'KIT').filter((f) => f.args.serial === injection.args.serial && f.args.start <= injection.args.t && f.args.end >= injection.args.t)) {
            const setting = pick(fs, 'DOSE_SETTING').find((f) => f.args.p === kit.args.p && f.args.drug === injection.args.drug
              && f.args.limit === limit.args.limit && f.args.amount === injection.args.amount && f.args.t < injection.args.t);
            if (setting) dead(terminal.args.v, 'murder', kit.args.p, [terminal, injection, limit, kit, setting], '警告を理解した増量＋致死量の静脈投与＋身体の停止＋注射器の途切れない所持');
          }
        }
      }
    }
    for (const terminal of pick(fs, 'TERMINAL')) {
      const p = terminal.args.p;
      for (const test of pick(fs, 'TEST').filter((f) => f.args.p === p && f.args.t < terminal.args.t)) {
        for (const exposure of pick(fs, 'EXPOSE').filter((f) => f.args.p === p && f.args.t < test.args.t)) {
          const infection = test.args.method === '架空病K専用の検査試薬' && test.args.value === 1 && test.args.meaning === '感染成立を示す陽性だった'
            && test.args.t - exposure.args.t >= U.DAY * 3 && terminal.args.sign === '発熱と赤い発疹';
          const radiation = test.args.method === '積算線量計' && test.args.value >= 900 && test.args.meaning === '致死域の被曝を示す'
            && terminal.args.sign === '皮膚の剥離と吐き気';
          if (infection || radiation) dead(p, infection ? 'infection' : 'radiation', null, [terminal, test, exposure], '接触→検査→症状の経過→死亡');
        }
      }
    }
    for (const terminal of pick(fs, 'STARVE')) {
      for (const ration of pick(fs, 'RATIONS').filter((f) => f.args.p === terminal.args.p && U.dayOf(terminal.args.t) - U.dayOf(f.args.t) === terminal.args.days && terminal.args.days >= 21))
        dead(terminal.args.p, 'starvation', null, [terminal, ration], '個人への配達停止と21日以上の消耗');
    }
    for (const terminal of pick(fs, 'BODY_SENSOR')) {
      const ration = pick(fs, 'RATIONS').find((f) => f.args.p === terminal.args.p && U.dayOf(terminal.args.t) - U.dayOf(f.args.t) >= 21);
      const sense = pick(fs, 'LAST_SENSE').find((f) => f.args.p === terminal.args.p && f.args.t === terminal.args.t && f.args.feeling === '空腹と指が動かない感覚');
      if (ration && sense) dead(terminal.args.p, 'starvation', null, [terminal, ration, sense], '21日以上の配達停止＋本人の消耗＋通信とは別の身体の測定');
    }
    for (const terminal of pick(fs, 'COLLAPSE')) dead(terminal.args.p, 'accident', null, [terminal], '同じ梁の一度の崩落と身体の停止');
    const hatches = pick(fs, 'HATCH').sort((a, b) => a.args.t - b.args.t);
    for (const raid of pick(fs, 'RAID')) {
      const prior = hatches.filter((f) => f.args.t < raid.args.t).at(-1);
      if (prior?.args.side === '外側') dead(raid.args.v, 'intruder', null, [raid, prior], '外側の無認証通過と外来者の襲撃');
    }
    for (const carrier of pick(fs, 'CARRIER').filter((f) => f.args.t >= now)) {
      for (const chip of pick(fs, 'CHIP').filter((f) => f.args.serial === carrier.args.serial && f.args.t < carrier.args.t)) {
        for (const feature of pick(fs, 'FEATURE').filter((f) => f.args.feature === carrier.args.feature)) {
          const stop = pick(fs, 'STOP').find((f) => f.args.v === chip.args.owner && f.args.t < chip.args.t);
          if (stop) alive(feature.args.p, [carrier, chip, feature, stop], '死者の身体停止＋同一製造番号＋別の身体特徴＋当日の脈');
        }
      }
    }
    // 身体の死だけ判明した段階も保持する。死因や加害者はまだ確定しない。
    for (const terminal of fs.filter((f) => ['SHOCK', 'FALL', 'STOP', 'TERMINAL', 'STARVE', 'COLLAPSE', 'RAID', 'BODY_SENSOR'].includes(f.type))) {
      const p = terminal.args.v || terminal.args.p;
      if (people[p] && !deathResults.has(p)) people[p] = { status: aliveResults.has(p) ? 'ambiguous' : 'dead', causes: Object.keys(A.CONFIG.causes), killers: [],
        derivations: [{ sources: refs([terminal]), rule: '身体の停止。死因と加害者は未確定' }] };
    }
    for (const [p, results] of deathResults) {
      const causes = [...new Set(results.map((r) => r.cause))], killers = [...new Set(results.map((r) => r.k).filter(Boolean))];
      people[p] = { status: aliveResults.has(p) ? 'ambiguous' : 'dead', causes, killers, derivations: results };
    }
    for (const [p, results] of aliveResults) {
      if (!deathResults.has(p)) people[p] = { status: 'alive', causes: null, killers: [], derivations: results };
    }
    const contested = [];
    for (const claim of pick(fs, 'CLAIM')) {
      const alibi = pick(fs, 'ALIBI').find((f) => f.args.p === claim.args.q && pick(fs, 'SWITCH').concat(pick(fs, 'PUSH'), pick(fs, 'INJECT'))
        .some((a) => a.args.t >= f.args.start && a.args.t <= f.args.end));
      contested.push({ claim: claim.source, rejectedBy: alibi ? [alibi.source] : [], resolved: !!alibi,
        reason: alibi ? '連続映像の所在が主張された現場と両立しない' : '確信の強さだけでは採用できない' });
    }
    const reasons = [], allKillers = new Set(Object.values(people).flatMap((p) => p.causes?.includes('murder') ? p.killers : []));
    if (Object.entries(people).some(([id, p]) => p.status === 'alive' && allKillers.has(id))) reasons.push('潜伏者');
    if (Object.values(people).some((p) => p.status === 'dead' && p.causes?.length === 1 && p.causes[0] === 'infection')) reasons.push('感染');
    if (Object.values(people).some((p) => p.status === 'dead' && p.causes?.length === 1 && p.causes[0] === 'radiation')) reasons.push('汚染');
    const intruder = hatches.length ? { present: hatches.at(-1).args.side === '外側', sources: refs(hatches) } : null;
    if (intruder?.present) reasons.push('侵入者');
    const supplies = pick(fs, 'SUPPLIES').sort((a, b) => a.args.t - b.args.t).at(-1);
    const complete = Object.values(people).every((p) => p.status !== 'ambiguous' && (p.status === 'alive' || p.causes.length === 1));
    const result = complete && supplies ? reasons.length ? 'danger' : supplies.args.state === '空' ? 'worthless' : 'safe' : 'ambiguous';
    return { people, intruder, contested, verdict: { result, reasons },
      safetySources: [...new Set(Object.values(people).flatMap((p) => p.derivations.flatMap((d) => d.sources)).concat(refs(hatches), refs([supplies])))],
      partial: Object.entries(people).filter(([, p]) => p.status !== 'ambiguous').map(([id, p]) => `${id}:${p.status}:${p.causes?.join() || ''}`) };
  }
  function simulateReach(sc) {
    const known = new Map(sc.initial_known_ids.map((id) => [id, id]));
    const steps = [], derivations = [], partialSteps = [], errors = [];
    let candidateRules = [];
    for (let guard = 0; guard < sc.residents.length + 1; guard++) {
      const read = E.read(sc, new Set(known.keys()));
      errors.push(...read.errors);
      const outcome = derive(sc, read.observations);
      partialSteps.push({ step: steps.length, conclusions: outcome.partial, sources: [...new Set(read.observations.map((f) => f.source))] });
      const stage = identity(sc, read.observations, known);
      candidateRules = stage.candidateRules; errors.push(...stage.errors);
      if (errors.length || !stage.decoded.length) break;
      const decoded = [];
      for (const d of stage.decoded) {
        // 導出したIDは認証に送る値。人物参照の文字列から属性は読み取らない。
        known.set(d.p, d.id); decoded.push(d.p);
      }
      steps.push(decoded); derivations.push(...stage.derivations.map((d) => ({ ...d, step: steps.length })));
    }
    return { reachable: known.size === sc.residents.length && !errors.length, known, steps, perStep: steps.map((s) => s.length), errors,
      derivations, partialSteps, candidateRules, rules: candidateRules.map((r) => ({ rule: `${r.attr}:${JSON.stringify(r.mapping)}`, step: 0 })) };
  }
  function verifyTruth(sc) {
    const errors = [], actions = new Map(sc.story.incidents.flatMap((i) => i.actions).map((a) => [a.id, a]));
    const deathTimes = new Map(sc.deaths.map((d) => [d.victim, d.t]));
    const residentMap = new Map(sc.residents.map((r) => [r.id, r]));
    const observations = E.read(sc).observations;
    for (const action of actions.values()) {
      if (action.p && deathTimes.has(action.p) && action.t > deathTimes.get(action.p)) errors.push(`${action.id}: 死後の行動`);
      for (const pre of action.preconditions) {
        if (pre.kind === 'job' && residentMap.get(action.p)?.job_code !== pre.code) errors.push(`${action.id}: 必要な専任権限がない`);
        if (['key', 'gear', 'kit'].includes(pre.kind) && !observations.some((f) => f.type === pre.kind.toUpperCase() && f.args.p === action.p
          && f.args.serial === pre.serial && f.args.start <= action.t && f.args.end >= action.t)) errors.push(`${action.id}: 道具の所持条件を満たさない`);
        if (pre.kind === 'knowledge' && !observations.some((f) => f.type === 'DOSE_SETTING' && f.args.p === action.p && f.args.drug === pre.drug && f.args.t < action.t)) errors.push(`${action.id}: 投与量の知識と選択の根拠がない`);
      }
      for (const cause of action.causes) if (!actions.has(cause) || actions.get(cause).t >= action.t) errors.push(`${action.id}: 原因の行動順が不正`);
    }
    for (const death of sc.deaths) {
      const action = actions.get(death.action);
      if (!action || action.t > death.t || action.p && action.p !== death.victim && death.cause !== 'murder') errors.push(`${death.victim}: 死亡と原因行動が接続しない`);
      if (death.killer && (death.killer === death.victim || deathTimes.has(death.killer) && deathTimes.get(death.killer) <= death.t)) errors.push(`${death.victim}: 加害者が行動できない`);
      const consequence = sc.story.incidents.flatMap((i) => i.consequences).find((c) => c.p === death.victim);
      if (!consequence || consequence.t !== death.t || consequence.cause !== death.cause || consequence.killer !== death.killer || !consequence.causes.includes(death.action)) errors.push(`${death.victim}: 行動の結果と死亡が一致しない`);
    }
    for (const o of observations) {
      if (o.args.t && o.args.t > o.recordedAt) errors.push(`${o.source}: 未来の観察`);
      if (['KEY', 'GEAR', 'KIT', 'ALIBI'].includes(o.type) && o.args.end > o.recordedAt) errors.push(`${o.source}: 将来の所持・所在を観察している`);
      if (['SHOCK', 'FALL', 'STOP', 'TERMINAL', 'STARVE', 'COLLAPSE', 'RAID', 'BODY_SENSOR', 'LAST_SENSE'].includes(o.type)) {
        const p = o.args.p || o.args.v;
        if (deathTimes.get(p) !== o.args.t) errors.push(`${o.source}: 身体の停止と真相の死亡時刻が一致しない`);
      }
    }
    for (const [owner, es] of Object.entries(sc.documents.chip_logs)) {
      const d = deathTimes.get(owner), tr = sc.solution.transplant;
      for (const e of es) {
        if (d && e.t > d && !(tr?.victim === owner && e.t >= tr.t && E.extract(e.text).observations.every((o) => o.type === 'CARRIER'))) errors.push(`${owner}: 死後の主観記録`);
      }
    }
    for (const revision of sc.solution.reinterpretations) {
      const old = revision.earlier.map((id) => sc.facts.find((f) => f.id === id));
      const added = revision.added.map((id) => sc.facts.find((f) => f.id === id));
      if (old.some((f) => !f || f.loc.doc === 'log' && !sc.initial_known_ids.includes(f.loc.owner)) || added.some((f) => !f)) errors.push('再解釈の資料が閲覧経路にない');
      if (!added.some((f) => f?.loc.owner === revision.unlock)) errors.push('再解釈に解読で開く追加証拠がない');
    }
    return { errors };
  }
  function metrics(sc, outcome) {
    const es = Object.values(sc.documents.chip_logs).flat().filter((e) => !e.deleted);
    const read = E.read(sc).observations;
    const distribution = {};
    for (const e of es) distribution[e.role] = (distribution[e.role] || 0) + 1;
    const counts = new Map();
    for (const f of read) counts.set(E.signature(f), (counts.get(E.signature(f)) || 0) + 1);
    return { logs: es.length, characters: es.reduce((sum, e) => sum + e.text.replace(/\{P:[^}]+\}/g, '〔人物〕').length, 0), roles: distribution,
      evidenceByDocument: Object.fromEntries(E.entries(sc).map((x) => [`${x.doc}:${x.owner || ''}#${x.index}`, x.e.facts.length])),
      duplicates: [...counts.values()].reduce((sum, c) => sum + Math.max(0, c - 1), 0), atmosphereOnly: es.filter((e) => !e.facts.length).length,
      directNumbers: pick(read, 'NUMBER').length,
      killersInFinal: sc.deaths.filter((d) => d.killer && (sc.documents.chip_logs[d.victim] || []).filter((e) => !e.deleted && e.kind === 'final')
        .some((e) => e.text.includes(`{P:${d.killer}}`))).length,
      multiSourceConclusions: Object.values(outcome.people).filter((p) => p.derivations.some((d) => d.sources.length >= 2)).length,
      lengths: es.map((e) => e.text.replace(/\{P:[^}]+\}/g, '〔人物〕').length) };
  }
  function verify(sc) {
    if (sc.meta?.version !== A.CONFIG.version || sc.meta?.generator !== 'incident-v2') {
      return { pass: false, errors: ['対応外のシナリオ形式です。現在の画面で同じシードから再生成してください（旧JSONは新しい検証の対象外）。'], reach: { reachable: false, steps: [], perStep: [], rules: [] } };
    }
    const text = E.check(sc), truth = verifyTruth(sc), reach = simulateReach(sc);
    const read = E.read(sc, new Set(reach.known.keys())), outcome = derive(sc, read.observations);
    const errors = [...text.errors, ...truth.errors, ...reach.errors];
    if (!reach.reachable) errors.push('閲覧可能な証拠から全員を解読できない');
    const deathOf = new Map(sc.deaths.map((d) => [d.victim, d]));
    for (const r of sc.residents) {
      if (reach.known.has(r.id) && reach.known.get(r.id) !== r.id) errors.push(`${r.id}: 導出した身元が真相と不一致`);
      const p = outcome.people[r.id], d = deathOf.get(r.id);
      if (p.status !== r.status) errors.push(`${r.id}: 生死の別解が残る`);
      if (d && (p.causes.length !== 1 || p.causes[0] !== d.cause)) errors.push(`${r.id}: 死因の別解が残る`);
      if (d?.cause === 'murder' && (p.killers.length !== 1 || p.killers[0] !== d.killer)) errors.push(`${r.id}: 加害者の別解が残る`);
    }
    if (JSON.stringify(outcome.verdict) !== JSON.stringify(sc.current_state.verdict)) errors.push('導出した安全判定が真相と一致しない');
    if (!!outcome.intruder !== !!sc.current_state.intruder || outcome.intruder && outcome.intruder.present !== sc.current_state.intruder.present) errors.push('侵入者の所在に別解が残る');
    const trace = { identity: reach.derivations, people: outcome.people, safety: outcome.safetySources, contested: outcome.contested,
      reinterpretations: sc.solution.reinterpretations.map((r) => ({ ...r, earlierSources: r.earlier.map((id) => sc.facts.find((f) => f.id === id)?.loc),
        addedSources: r.added.map((id) => sc.facts.find((f) => f.id === id)?.loc) })) };
    return { pass: !errors.length, errors, reach, outcome, truth, text,
      trace, metrics: metrics(sc, outcome), validation: { truth: !truth.errors.length, evidence: reach.reachable && !errors.some((e) => /別解|不一致|一致しない/.test(e)),
        text: !text.errors.length, llmSemantics: '自由な補筆の意味は決定的な検査の対象外。推論は限定文法の観察本文だけを使う。' } };
  }
  A.Inference = { identity, cultureCandidates, derive, simulateReach, verifyTruth, metrics };
  A.Verifier = { verify, simulateReach, deriveOutcome: (sc) => derive(sc, E.read(sc).observations), verifyCanon: verifyTruth };
})(window.ASARIYA = window.ASARIYA || {});
