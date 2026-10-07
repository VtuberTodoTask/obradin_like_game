// 実APIの保存済み引用と、数値を変えた対照例を小さな回帰用データへ取り出す。
const fs = require('node:fs');
const { load } = require('./load');
const A = load(), sc = A.Generator.fixed().scenario;
const cases = [];
function saved(file, index, name, expectedDecision) {
  const report = JSON.parse(fs.readFileSync(file, 'utf8')), d = report.diagnostics[index], a = d.attempts.at(-1);
  const [owner, i] = d.entryId.split('#'), e = sc.documents.chip_logs[owner][Number(i)];
  cases.push({ name, origin: 'saved-real-api', source: file, entryId: d.entryId, promptVersion: d.promptVersion,
    text: a.output.text, references: d.referenceMapping, expected: A.Semantics.required(sc, e), extraction: a.extraction, audit: a.audit, expectedDecision });
}
saved('docs/ai/narration-current.json', 0, 'natural-number', true);
saved('docs/ai/narration-current.json', 2, 'equivalent-adjacency', true);
saved('docs/ai/narration-qualification.json', 0, 'automatic-switch-record', true);
saved('docs/ai/narration-key-final.json', 0, 'dedicated-key-document', true);
const f = sc.facts.find((f) => f.type === 'KEY'), e = sc.documents.chip_logs[f.loc.owner][f.loc.index];
const altered = { ...f, args: { ...f.args, serial: '350' } }, want = A.Semantics.contract(sc, altered), al = A.Semantics.aliases(sc, e);
const text = al.encode(A.Evidence.render({ ...altered, args: { ...altered.args, serial: '305' } }));
const encoded = A.Semantics.encodeContracts([want], al)[0];
const extraction = { observations: [{ type: 'KEY', fields: Object.entries({ ...encoded.args, serial: '305' }).map(([key, v]) => ({ key, value: String(v) })),
  qualifiers: Object.entries(want.qualifiers).map(([key, value]) => ({ key, value })), source_kind: want.source_kind, modality: want.modality,
  polarity: want.polarity, quote: text }], additions: [] };
cases.push({ name: '350-changed-to-305', origin: 'controlled-extraction-sample', entryId: `${f.loc.owner}#${f.loc.index}`,
  text, references: al.mapping, expected: [want], extraction, audit: { grounding: [{ index: 0, supported: true, quote: text }],
    equivalences: [], additions: [], quality: [], uncertain: false }, expectedDecision: false });
for (const c of cases) {
  const [owner, i] = c.entryId.split('#'), al = A.Semantics.aliases(sc, sc.documents.chip_logs[owner][Number(i)], c.references);
  c.result = A.Semantics.compare(c.expected, A.Semantics.decodeExtraction(c.extraction, al), A.Semantics.transform(c.audit, al.decode), al.decode(c.text));
  if (c.result.pass !== c.expectedDecision) throw new Error('Unexpected fixture decision: ' + c.name);
}
fs.writeFileSync('docs/ai/narration-examples.json', JSON.stringify({ seed: 730, fixed: true, evidenceVersion: A.Semantics.VERSION,
  note: 'Saved LLM extraction/audit replay is not a new measurement of model reliability. Controlled sample is explicitly marked.', cases }, null, 2) + '\n');
console.log(`saved ${cases.length} cases`);
