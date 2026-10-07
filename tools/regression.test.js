const test = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./load');
const { stubFetch } = require('./narration-stub');
const A = load(), plain = (x) => JSON.parse(JSON.stringify(x));
const clone = (sc) => plain(sc);
const scenario = (seed = 1, opts = {}) => A.Generator.generate(seed, opts).scenario;
function entryFor(sc, type) {
  const f = sc.facts.find((f) => f.type === type);
  const es = f.loc.doc === 'log' ? sc.documents.chip_logs[f.loc.owner] : f.loc.doc === 'hatch' ? sc.documents.hatch_log : sc.documents.counselor_dialogues;
  return { f, e: es[f.loc.index] };
}
function changeText(item, change) {
  if (item.f.loc.doc === 'dialogue') item.e.lines[0].text = change(item.e.lines[0].text);
  else item.e.text = change(item.e.text);
}
function removeObservation(sc, type) {
  const item = entryFor(sc, type), { f, e } = item;
  changeText(item, (text) => text.split('\n').filter((line) => line !== A.Evidence.render(f)).join('\n'));
  e.facts = e.facts.filter((id) => id !== f.id); e.rendered = e.rendered.filter((id) => id !== f.id);
  sc.facts = sc.facts.filter((x) => x.id !== f.id);
}
function state(sc) {
  return { unlocked: new Set(sc.initial_known_ids), unlockOrder: [], alert: 0, tried: [], memos: {}, drafts: {},
    pins: [], comparison: [], confirmed: {}, filters: {}, disconnected: false, reconnections: 0, answers: { people: {}, verdict: {} },
    over: false, result: null, termLog: [], selTok: null };
}
function rejectedIds(sc) {
  const ids = [];
  for (const d of sc.shelter.districts) for (let e = 1; e <= sc.shelter.max_entry; e++) for (const j of A.CONFIG.jobs) {
    const id = `${d}-${String(e).padStart(2, '0')}-${j.code}`;
    if (!sc.residents.some((r) => r.id === id)) ids.push(id);
  }
  return ids;
}
function answer(sc, s, r) {
  const d = sc.deaths.find((d) => d.victim === r.id);
  s.answers.people[r.token] = { status: r.status, cause: d?.cause || '', killer: d?.killer ? sc.residents.find((r) => r.id === d.killer).token : '' };
}

test('固定・標準・大人数・ハードを同じ三種類の検証に通す', () => {
  for (const opts of [{ fixed: true }, {}, { size: 'large' }, { mode: 'hard' }]) for (let seed = 1; seed <= 9; seed++) {
    const sc = scenario(seed, opts), report = A.Verifier.verify(sc);
    assert.equal(report.pass, true, report.errors.join('\n'));
    assert.ok(sc.residents.length >= (opts.size === 'large' && !opts.fixed ? 12 : 8));
  }
});
test('同じシードと形式・設定が再現する', () => {
  for (const opts of [{}, { fixed: true }, { size: 'large' }, { mode: 'hard' }]) assert.equal(JSON.stringify(scenario(3, opts)), JSON.stringify(scenario(3, opts)));
});
for (const [name, change] of [
  ['本文を眠いへ', () => '眠い。'],
  ['人物を別人へ', (s) => s.replace(/\{P:[^}]+\}/, '{P:A-01-51}')],
  ['番号を変更', (s) => s.replace('3番', '7番')],
  ['否定を反転', (s) => s.replace('渡されていない', '渡されている')],
]) test(`内部事実を残しても${name}変更を検出`, () => {
  const sc = scenario(1), item = entryFor(sc, name === '否定を反転' ? 'KEY' : 'NUMBER');
  changeText(item, change); assert.equal(A.Evidence.check(sc).errors.length > 0, true);
  assert.equal(A.Verifier.verify(sc).pass, false);
});
test('前後の反転・主体対象の入れ替え・時刻変更を検出', () => {
  for (const change of [(s) => s.replace('一つ前', '一つ後'), (s) => {
    const refs = s.match(/\{P:[^}]+\}/g); return s.replace(/\{P:[^}]+\}/g, (r) => r === refs[0] ? refs[1] : refs[0]);
  }]) {
    const sc = scenario(1), item = entryFor(sc, 'PREVIOUS'); changeText(item, change); assert.ok(A.Evidence.check(sc).errors.length);
  }
  const sc = scenario(1); changeText(entryFor(sc, 'SWITCH'), (s) => s.replace('10:00', '10:01')); assert.equal(A.Verifier.verify(sc).pass, false);
});
for (const [seed, proof] of [[1, 'SWITCH'], [2, 'PUSH'], [3, 'INJECT']]) test(`型${seed}: 決定的な${proof}を除くと別解または到達不能`, () => {
  const sc = scenario(seed); removeObservation(sc, proof);
  assert.equal(A.Evidence.check(sc).errors.length, 0, '本文と証拠契約は整合したまま除去');
  const report = A.Verifier.verify(sc); assert.equal(report.pass, false);
  assert.ok(report.errors.some((e) => /別解|解読できない/.test(e)));
});
test('未解読の本人ログから入口証拠を先取りしない', () => {
  const sc = scenario(1), { f, e } = entryFor(sc, 'HOME'), owner = f.args.p;
  sc.documents.chip_logs[f.loc.owner].splice(f.loc.index, 1);
  sc.documents.chip_logs[owner].unshift(e);
  for (const [id, es] of Object.entries(sc.documents.chip_logs)) es.forEach((entry, index) => entry.facts.forEach((fid) => {
    sc.facts.find((f) => f.id === fid).loc = { doc: 'log', owner: id, index };
  }));
  assert.equal(A.Inference.simulateReach(sc).reachable, false);
});
test('隠された属性・文化の正解・writer・certaintyは候補を減らす入力でない', () => {
  const sc = scenario(3), baseline = A.Inference.simulateReach(sc), outcome = A.Verifier.deriveOutcome(sc);
  for (const r of sc.residents.filter((r) => !sc.initial_known_ids.includes(r.id))) { r.job_code = 42; r.district = 'D'; r.entry_order = 99; }
  sc.culture = { marker_attr: 'category', markers: { wrong: 'D' } };
  for (const f of sc.facts) f.certainty = 'certain';
  for (const e of Object.values(sc.documents.chip_logs).flat()) e.writer = 'hidden-wrong-writer';
  assert.deepEqual(plain(A.Inference.simulateReach(sc).steps), plain(baseline.steps));
  assert.deepEqual(plain(A.Verifier.deriveOutcome(sc)), plain(outcome));
});
test('文化の例が不足・複数候補なら区画を確定しない', () => {
  const sc = scenario(1), fs = A.Evidence.read(sc, new Set(sc.initial_known_ids)).observations;
  const noExamples = fs.filter((f) => f.type !== 'MARKER' || !sc.initial_known_ids.includes(f.args.p));
  const rules = A.Inference.cultureCandidates(sc, noExamples, new Map(sc.initial_known_ids.map((id) => [id, id])));
  assert.ok(rules.length > 1); assert.ok(new Set(rules.map((r) => r.attr)).size > 1);
});
test('身体の死とチップの記録継続を分け、特徴証拠を除くと生存者を特定できない', () => {
  const sc = scenario(3), tr = sc.solution.transplant;
  let outcome = A.Verifier.deriveOutcome(sc);
  assert.equal(outcome.people[tr.victim].status, 'dead'); assert.equal(outcome.people[tr.carrier].status, 'alive');
  assert.ok(sc.documents.chip_logs[tr.victim].at(-1).t > sc.deaths.find((d) => d.victim === tr.victim).t);
  removeObservation(sc, 'FEATURE'); outcome = A.Verifier.deriveOutcome(sc);
  assert.equal(outcome.people[tr.carrier].status, 'ambiguous');
});
test('確信する誤証言を映像で退け、弱い正証言は独立した操作記録と照合', () => {
  for (const seed of [1, 2, 3]) {
    const sc = scenario(seed), report = A.Verifier.verify(sc);
    assert.equal(report.outcome.contested[0].resolved, true);
    assert.ok(report.outcome.contested[0].rejectedBy.length);
    assert.equal(report.outcome.people[sc.deaths[0].victim].killers[0], sc.deaths[0].killer);
  }
});
test('将来の観察と死後の行動を因果検証で拒否する', () => {
  const sc = scenario(1); sc.story.incidents[0].actions.find((a) => a.id === 'power').t = A.util.tAbs(99, 0);
  assert.ok(A.Inference.verifyTruth(sc).errors.length);
  const other = scenario(2), item = entryFor(other, 'GEAR'); item.f.args.end += A.util.DAY;
  item.e.text = A.Evidence.render(item.f); assert.ok(A.Inference.verifyTruth(other).errors.length);
});
test('全既存トリックの適用例と複数の安全判定を確認', () => {
  const seen = new Set(), verdicts = new Set(), survivorCounts = new Set();
  for (let seed = 1; seed <= 100; seed++) { const sc = scenario(seed); sc.tricks.forEach((t) => seen.add(t.type)); verdicts.add(sc.current_state.verdict.result); survivorCounts.add(sc.current_state.survivors.length); }
  for (const type of ['chip_transplant', 'log_tamper', 'death_disguise', 'misperception', 'unrecorded_person']) assert.ok(seen.has(type));
  for (const verdict of ['danger', 'safe', 'worthless']) assert.ok(verdicts.has(verdict));
  for (const count of [0, 1, 2]) assert.ok(survivorCounts.has(count));
});
test('死亡時刻を本文と契約で一緒に変えても真相との不一致を検出する', () => {
  const sc = scenario(730, { fixed: true }), item = entryFor(sc, 'TERMINAL');
  item.f.args.t -= 1; item.e.text = A.Evidence.render(item.f);
  assert.ok(A.Inference.verifyTruth(sc).errors.some((e) => e.includes('死亡時刻')));
});
test('標準の警戒度は即終了せず、形式・拒否済みは加算しない', () => {
  const sc = scenario(1), s = state(sc), rejects = rejectedIds(sc);
  s.memos.example = 'keep'; A.Investigation.authenticate(s, sc, 'bad'); assert.equal(s.alert, 0);
  A.Investigation.authenticate(s, sc, rejects[0]); A.Investigation.authenticate(s, sc, rejects[0]); assert.equal(s.alert, 1);
  for (const id of rejects.slice(1, 8)) A.Investigation.authenticate(s, sc, id);
  assert.equal(s.disconnected, true); assert.equal(s.over, false); assert.equal(s.result, null); assert.equal(s.memos.example, 'keep');
  assert.equal(A.Investigation.reconnect(s), true); assert.equal(s.reconnections, 1);
  A.Investigation.authenticate(s, sc, rejects[0]); assert.equal(s.alert, 0);
});
test('ハードのみ上限で終了し、再接続では復帰しない', () => {
  const sc = scenario(1, { mode: 'hard' }), s = state(sc);
  for (const id of rejectedIds(sc).slice(0, 8)) A.Investigation.authenticate(s, sc, id);
  assert.equal(s.over, true); assert.equal(A.Investigation.reconnect(s), false);
});
test('認証の成功と選択人物の推定の食い違いを区別', () => {
  const sc = scenario(1), s = state(sc); s.selTok = sc.residents[3].token;
  assert.equal(A.Investigation.authenticate(s, sc, sc.residents[2].id).mismatch, true);
});
test('途中確認は三人で確定し、未知の加害者を開示しない', () => {
  const sc = scenario(2), s = state(sc);
  sc.residents.forEach((r) => { s.unlocked.add(r.id); answer(sc, s, r); });
  const victim = sc.residents[4], killer = sc.residents[2];
  s.unlocked.delete(killer.id); assert.equal(A.Investigation.isCorrect(sc, s, victim), false);
  s.unlocked.add(killer.id);
  const one = state(sc); one.unlocked.add(killer.id); answer(sc, one, killer); assert.equal(A.Investigation.confirmBatch(one, sc).length, 0);
  const result = A.Investigation.confirmBatch(s, sc); assert.equal(result.length, 3); assert.equal(Object.keys(s.confirmed).length, 3);
});
test('保存復元は仮の名前・根拠・比較・途中確定・再接続を保持', () => {
  const sc = scenario(3), s = state(sc), r = sc.residents[2];
  A.Investigation.authenticate(s, sc, r.id); answer(sc, s, r);
  s.drafts[r.token] = { nickname: '観察者', district: 'C', evidence: ['dialogue#0'] };
  s.pins = ['dialogue#0', 'dialogue#1']; s.comparison = s.pins.slice(); s.reconnections = 2; s.disconnected = true;
  s.confirmed[r.token] = plain(s.answers.people[r.token]);
  const data = plain(A.Investigation.serialize(s)), restored = state(sc);
  A.Investigation.restore(restored, sc, data);
  assert.deepEqual(plain(A.Investigation.serialize(restored)), data); assert.ok(restored.unlocked.has(r.id));
});
test('同シードの別事件は保存を分け、補筆だけなら内容識別を保持する', () => {
  const sc = scenario(1), narrated = clone(sc);
  narrated.documents.chip_logs[sc.initial_known_ids[0]][0].atmosphere = '胸が苦しい。';
  assert.equal(A.util.scenarioFingerprint(sc), A.util.scenarioFingerprint(narrated));
  const other = scenario(1, { type: 'ration' });
  assert.notEqual(A.util.scenarioFingerprint(sc), A.util.scenarioFingerprint(other));
  const altered = clone(sc); altered.facts[0].args.extra = '別資料';
  assert.notEqual(A.util.scenarioFingerprint(sc), A.util.scenarioFingerprint(altered));
});

test('旧JSONを新検証へ通ったものとして読み込まない', () => {
  const sc = scenario(1); sc.meta.version = '0.1-proto'; assert.equal(A.Verifier.verify(sc).pass, false);
});
test('LLMが観察を変えた場合はテンプレートへ戻す（通信スタブ）', async () => {
  const options = { failFirst: 999 }, state = {};
  const B = load({ ASARIYA_LOCAL: { openai: { apiKey: 'stub', maxRounds: 1 } }, fetch: stubFetch(options, state) }); options.A = B;
  const sc = B.Generator.fixed().scenario, before = JSON.stringify(sc.documents.chip_logs);
  const report = await B.LLM.narrateScenario(sc, { cache: false });
  assert.ok(state.generated > 0); assert.equal(report.llm, 0); assert.equal(report.specErrors.length, report.entries); assert.equal(report.verification.pass, true);
  for (const error of report.specErrors) {
    const entry = sc.documents.chip_logs[error.owner][error.index];
    assert.equal(error.timestamp, entry.timestamp);
    assert.equal(error.scene.id, entry.scene);
    assert.deepEqual(plain(error.required), entry.text.split('\n'));
  }
  assert.ok(before.includes('時刻')); assert.ok(Object.values(sc.documents.chip_logs).flat().every((e) => e.deleted || e.narrator === 'template'));
});

test('LLMの不合格理由は復元でき、旧キャッシュの理由は不明として扱う', async () => {
  const saved = new Map(), localStorage = { getItem: (k) => saved.get(k) || null,
    setItem: (k, v) => saved.set(k, v), removeItem: (k) => saved.delete(k) };
  const options = { failFirst: 999 }, state = {};
  const B = load({ localStorage, ASARIYA_LOCAL: { openai: { apiKey: 'stub', maxRounds: 1 } }, fetch: stubFetch(options, state) }); options.A = B;
  const sc = B.Generator.fixed().scenario;
  assert.equal(B.LLM.diagnostics(sc).status, '未実施');
  await B.LLM.narrateScenario(sc);
  const diagnostic = B.LLM.diagnostics(sc), restored = B.Generator.fixed().scenario;
  assert.equal(diagnostic.counts.template, 41); assert.equal(diagnostic.errors.length, 41);
  assert.deepEqual(plain(diagnostic.errors[0].codes), ['missing_required_evidence']);
  const before = state.generated;
  B.LLM.applyCache(restored);
  assert.deepEqual(plain(B.LLM.diagnostics(restored)), plain(diagnostic)); assert.equal(state.generated, before);
  const [key, serialized] = [...saved.entries()][0], cache = JSON.parse(serialized);
  Object.values(cache.entries).forEach((entry) => { delete entry.error; });
  saved.set(key, JSON.stringify(cache));
  const legacy = B.Generator.fixed().scenario; B.LLM.applyCache(legacy);
  const oldDiagnostic = B.LLM.diagnostics(legacy);
  assert.equal(oldDiagnostic.counts.template, 41);
  assert.deepEqual(plain(oldDiagnostic.errors[0].codes), ['cached_fallback']);
  assert.ok(oldDiagnostic.errors[0].problems[0].includes('個別の理由が保存されていない'));
  B.LLM.revertToTemplate(restored);
  assert.equal(B.LLM.diagnostics(restored).status, '未実施');
  assert.equal(B.LLM.diagnostics(restored).errors.length, 0);
});
