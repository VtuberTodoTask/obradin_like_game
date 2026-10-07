// 意味抽出と独立監査は保存サンプル／スタブ。実AIの抽出精度とは区別する。
const test = require('node:test'), assert = require('node:assert/strict');
const { load } = require('./load'), { stubFetch } = require('./narration-stub');
const A = load(), plain = (x) => JSON.parse(JSON.stringify(x));
test('実APIの保存済み抽出4件と350→305の対照例をAPIなしで再照合', () => {
  const fixtures = require('../docs/ai/narration-examples.json'), sc = A.Generator.fixed().scenario;
  for (const c of fixtures.cases) {
    const [owner, index] = c.entryId.split('#'), al = A.Semantics.aliases(sc, sc.documents.chip_logs[owner][Number(index)], c.references);
    const result = A.Semantics.compare(c.expected, A.Semantics.decodeExtraction(c.extraction, al),
      A.Semantics.transform(c.audit, al.decode), al.decode(c.text));
    assert.equal(result.pass, c.expectedDecision, c.name);
  }
});
function sample(type, text, changes = {}) {
  const sc = A.Generator.fixed().scenario, f = sc.facts.find((v) => v.type === type);
  if (type === 'KEY') f.args.serial = '350';
  const want = A.Semantics.contract(sc, f), e = f.loc.doc === 'log' ? sc.documents.chip_logs[f.loc.owner][f.loc.index] : sc.documents.counselor_dialogues[f.loc.index];
  const line = text || A.Evidence.render(f);
  const o = { type, args: { ...f.args }, qualifiers: { ...want.qualifiers }, source_kind: want.source_kind,
    modality: want.modality, polarity: want.polarity, quote: line, ...changes };
  const audit = { grounding: [{ index: 0, supported: true, quote: line }], equivalences: [], additions: [], quality: [], uncertain: false };
  return { sc, f, e, want, text: line, o, audit };
}
function check(s) { return A.Semantics.compare([s.want], { observations: [s.o] }, s.audit, s.text); }
test('同義の自然な受付文と漢数字は採用（抽出サンプル）', () => {
  const s = sample('NUMBER');
  s.text = s.o.quote = `入居の受付票を手に取った。{P:${s.f.args.p}}は三番と記されていた。`;
  s.o.args.n = '三'; s.audit.grounding[0].quote = s.text;
  assert.equal(check(s).pass, true);
  assert.notEqual(s.text, A.Evidence.render(s.f));
});
test('異なる時刻表記を分精度で照合', () => {
  const s = sample('ACK'); s.o.args.t = '第4日 9時50分';
  assert.equal(check(s).pass, true);
});
test('文書の主張・既存の性格・本人の感情・品質警告は事実変更と区別', () => {
  const s = sample('NUMBER'); s.text += '。私はいつもの慎重さで読み直した。少しほっとした。';
  s.audit.additions = [{ kind: 'allowed', quote: '私はいつもの慎重さで読み直した', reason: '既存の人物設定' }];
  s.audit.quality = [{ code: 'quality_warning', quote: '少しほっとした', reason: '感情の締めが反復' }];
  assert.equal(check(s).pass, true); assert.equal(check(s).quality.length, 1);
});
for (const [type, field, value, code] of [
  ['KEY', 'serial', '305', 'changed_value'], ['NUMBER', 'p', 'A-01-51', 'changed_subject'],
  ['PREVIOUS', 'p', 'A-01-51', 'changed_subject'], ['SHOCK', 'v', 'C-06-41', 'changed_object'],
  ['ALIBI', 'end', A.util.tAbs(4, 599), 'changed_time'],
]) test(`${type}.${field}の変更を${code}として具体的に報告`, () => {
  const s = sample(type); s.o.args[field] = value;
  const result = check(s); assert.equal(result.pass, false);
  const issue = result.issues.find((i) => i.code === code);
  assert.equal(issue.field, field); assert.equal(issue.actual, value); assert.ok(issue.quote);
});
test('貸与なしの否定を失うと拒否', () => {
  const s = sample('KEY'); s.o.qualifiers.no_transfer = false;
  assert.ok(check(s).issues.some((i) => i.code === 'lost_negation' && i.field === 'no_transfer'));
});
test('本文305から抽出器が350を捏造しても数値の引用検査で拒否', () => {
  const s = sample('KEY'); s.text = s.o.quote = s.text.replace('番号350', '番号305');
  s.audit.grounding[0].quote = s.text;
  assert.ok(check(s).issues.some((i) => i.code === 'verification_uncertain' && i.field === 'serial'));
});
test('鍵の三百五十を350と照合し、305や1350へは一致させない', () => {
  const s = sample('KEY'); s.text = s.o.quote = s.text.replace('番号350', '番号三百五十');
  s.audit.grounding[0].quote = s.text; assert.equal(check(s).pass, true);
  s.text = s.o.quote = s.text.replace('三百五十', '1350'); s.audit.grounding[0].quote = s.text;
  assert.equal(check(s).pass, false);
});
test('一人称SELFは実際の書き手へ戻り、別人物の印へ混同しない', () => {
  const sc = A.Generator.fixed().scenario, own = sc.residents[0].id;
  const e = sc.documents.chip_logs[own][0], al = A.Semantics.aliases(sc, e);
  const extraction = A.Semantics.decodeExtraction({ observations: [{ fields: [{ key: 'p', value: 'SELF' }], qualifiers: [], quote: '私' }] }, al);
  assert.equal(extraction.observations[0].args.p, own);
});
test('入居の前後の逆転・重要区間の欠落・期間拡張を拒否', () => {
  const s = sample('PREVIOUS'); s.o.type = 'NEXT'; assert.equal(check(s).pass, false);
  const q = sample('ALIBI'); delete q.o.args.start; assert.ok(check(q).issues.some((i) => i.code === 'missing_required_evidence'));
  const q2 = sample('ALIBI'); q2.o.args.start = 0; assert.ok(check(q2).issues.some((i) => i.code === 'changed_time'));
});
test('文書を直接見た経験へ、証言を事実へ変えると拒否', () => {
  const s = sample('NUMBER'); s.o.source_kind = 'direct'; assert.ok(check(s).issues.some((i) => i.code === 'changed_source'));
  const q = sample('CLAIM'); q.o.modality = 'observed'; assert.ok(check(q).issues.some((i) => i.code === 'changed_modality'));
});
test('pがqの直前とqがpの直後は同じ隣接関係として採用', () => {
  const s = sample('PREVIOUS');
  s.o.type = 'NEXT'; [s.o.args.p, s.o.args.q] = [s.o.args.q, s.o.args.p];
  assert.equal(check(s).pass, true);
  s.o.type = 'BEFORE'; assert.equal(check(s).pass, false);
});
for (const kind of ['unauthorized_event', 'unauthorized_trait', 'viewpoint_violation', 'verification_uncertain'])
  test(`${kind}には本文の引用が必要で、不許可は採用しない`, () => {
    const s = sample('NUMBER'); s.text += '私は死後も自分の脈が止まったことを見ていた。';
    s.audit.additions = [{ kind, quote: '私は死後も自分の脈が止まったことを見ていた', reason: '根拠なしの追加' }];
    assert.ok(check(s).issues.some((i) => i.code === kind));
    s.audit.additions[0].quote = '本文にない文'; assert.ok(check(s).issues.some((i) => i.code === 'verification_uncertain'));
  });
test('内部事実だけを残した眠い本文と、捏造された引用を拒否', () => {
  const s = sample('NUMBER'); s.text = '眠い。'; assert.equal(check(s).pass, false);
  const r = A.Semantics.compare([s.want], { observations: [] }, { grounding: [], uncertain: false }, s.text);
  assert.ok(r.issues.some((i) => i.code === 'missing_required_evidence'));
});
test('未知参照・実名・内部IDを拒否し、別名復元は同じ人物へ戻る', () => {
  const s = sample('NUMBER'), al = A.Semantics.aliases(s.sc, s.e);
  assert.equal(al.decode(al.encode(s.text)), s.text);
  assert.ok(A.Semantics.formatIssues(s.sc, '<P999>', al, 'one', 'one').length);
  assert.ok(A.Semantics.formatIssues(s.sc, '{P:C-03-31}', al, 'one', 'one').length);
  assert.ok(A.Semantics.formatIssues(s.sc, s.sc.residents[2].name, al, 'one', 'one').length);
});
test('最期の本人記憶と機械の脈拍停止が別資料で、世界内の規定が読める', () => {
  const sc = A.Generator.fixed().scenario, e = Object.values(sc.documents.chip_logs).flat().find((v) => v.kind === 'final' && !v.deleted);
  assert.ok(!e.text.includes('脈拍信号')); assert.ok(e.machineText.includes('医療端末'));
  assert.ok(!e.text.includes('配給券の番号ではない'));
  assert.ok(sc.publicCulture.text.includes('900mSv'));
  assert.equal(A.Verifier.verify(sc).pass, true);
});
test('全文採用の意味検証記録を本文の変更・契約の変更へ流用できない', async () => {
  const options = {}, B = load({ ASARIYA_LOCAL: { openai: { apiKey: 'stub', repairRounds: 0 } }, fetch: stubFetch(options) }); options.A = B;
  const sc = B.Generator.fixed().scenario, report = await B.LLM.narrateScenario(sc, { cache: false, limit: 3 });
  assert.equal(report.llm, 3); assert.equal(report.verification.pass, true);
  const e = Object.values(sc.documents.chip_logs).flat().find((v) => v.semantic);
  e.text = '眠い。'; assert.ok(B.Evidence.check(sc).errors.length);
});
test('具体的な局所修正で採用し、保存本文は生成APIなしで再採用できる（抽出スタブ）', async () => {
  const saved = new Map(), localStorage = { getItem: (k) => saved.get(k), setItem: (k, v) => saved.set(k, v), removeItem: (k) => saved.delete(k) };
  const options = { failFirst: 1 }, state = {}, B = load({ localStorage,
    ASARIYA_LOCAL: { openai: { apiKey: 'stub', repairRounds: 2 } }, fetch: stubFetch(options, state) }); options.A = B;
  const sc = B.Generator.fixed().scenario, r = await B.LLM.narrateScenario(sc, { limit: 1 });
  assert.equal(r.llm, 1); assert.equal(r.metrics.initiallyAccepted, 0); assert.equal(r.metrics.accepted, 1);
  const d = r.diagnostics[0]; assert.ok(d.attempts[1].generationInput.repair.previous_text);
  assert.ok(d.attempts[1].generationInput.repair.issues[0].field);
  const before = state.generated, result = await B.Narration.recheck(sc, d);
  assert.equal(result.result.pass, true); assert.equal(state.generated, before);
  assert.equal(result.stats.phases.generation, undefined);
  const restored = B.Generator.fixed().scenario; B.LLM.applyCache(restored);
  assert.equal(B.LLM.countEntries(restored).llm, 1);
  const key = [...saved.keys()][0], c = JSON.parse(saved.get(key)); Object.values(c.entries)[0].version = 'old';
  saved.set(key, JSON.stringify(c)); const other = B.Generator.fixed().scenario; B.LLM.applyCache(other);
  assert.equal(B.LLM.countEntries(other).llm, 0);
});
test('保存本文の再採用で文面が変われば後続を未処理へ戻し、古い依存キャッシュを使わない', async () => {
  const saved = new Map(), localStorage = { getItem: (k) => saved.get(k), setItem: (k, v) => saved.set(k, v) };
  const options = {}, state = {}, B = load({ localStorage,
    ASARIYA_LOCAL: { openai: { apiKey: 'stub', repairRounds: 0 } }, fetch: stubFetch(options, state) }); options.A = B;
  const sc = B.Generator.fixed().scenario, report = await B.LLM.narrateScenario(sc, { limit: 8 }), d = report.diagnostics[0];
  const old = d.attempts[0].output.text;
  d.attempts[0].output.text = old + ' '; state.texts.set(old + ' ', state.texts.get(old));
  const result = await B.Narration.recheck(sc, d);
  assert.equal(result.result.pass, true); assert.ok(result.invalidated.length > 0);
  for (const id of result.invalidated) {
    const [owner, i] = id.split('#'), entry = sc.documents.chip_logs[owner][Number(i)];
    assert.equal(entry.narrator, undefined); assert.equal(entry.semantic, undefined);
  }
  const restored = B.Generator.fixed().scenario; B.LLM.applyCache(restored);
  assert.ok(B.LLM.countEntries(restored).llm < 8);
  assert.equal(B.Verifier.verify(restored).pass, true);
});
