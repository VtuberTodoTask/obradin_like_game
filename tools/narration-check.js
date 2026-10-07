// 保存済み入出力の採取／再検査。実APIは --real を明示した時だけ。
const fs = require('node:fs');
const { load } = require('./load');
const { stubFetch } = require('./narration-stub');
const args = process.argv.slice(2), real = args.includes('--real');
const value = (key) => args[args.indexOf(key) + 1];
const stubOptions = {}, A = load(real ? { localConfig: true } : {
  ASARIYA_LOCAL: { openai: { apiKey: 'test-stub', repairRounds: 2 } }, fetch: stubFetch(stubOptions),
});
stubOptions.A = A;
async function main() {
  const saved = args.includes('--recheck') ? JSON.parse(fs.readFileSync(value('--recheck'), 'utf8')) : null;
  const sc = args.includes('--seed') ? A.Generator.generate(Number(value('--seed'))).scenario
    : saved && !saved.fixed ? A.Generator.generate(saved.seed).scenario : A.Generator.fixed().scenario;
  let report;
  if (args.includes('--recheck')) {
    const results = [];
    const selected = args.includes('--entry') ? saved.diagnostics.filter((d) => d.entryId === value('--entry')) : saved.diagnostics;
    if (!selected.length) throw new Error('指定した保存エントリがありません');
    for (const d of selected) {
      results.push(await A.Narration.recheck(sc, d));
      console.log(`保存本文の再検査 ${results.length}/${selected.length}`);
      if (args.includes('--report')) fs.writeFileSync(value('--report'), JSON.stringify({ mode: real ? 'real-recheck-in-progress' : 'stub-recheck-in-progress',
        fixed: saved.fixed, seed: sc.meta.seed, diagnostics: selected, results }, null, 2) + '\n');
    }
    const stats = results.reduce((sum, r) => {
      for (const key of ['calls', 'promptTokens', 'completionTokens', 'retries']) sum[key] = (sum[key] || 0) + r.stats[key];
      for (const [key, n] of Object.entries(r.stats.phases)) sum.phases[key] = (sum.phases[key] || 0) + n;
      return sum;
    }, { phases: { generation: 0, repair: 0 } });
    report = { mode: real ? '実APIによる保存本文の再検査' : '抽出スタブによる保存本文の再検査',
      model: A.LLM.settings().model, fixed: saved.fixed, seed: sc.meta.seed, diagnostics: selected,
      metrics: A.Narration.metrics(selected), stats, verification: A.Verifier.verify(sc), results };
  } else {
    const types = args.includes('--types') ? value('--types').split(',') : ['NUMBER', 'WORK', 'PREVIOUS', 'KEY', 'ACK', 'PLAN', 'LAST_SENSE', 'TEST', 'ALIBI', 'SWITCH'];
    const entryIds = args.includes('--all') ? undefined : [...new Set(types.map((type) => {
      const f = sc.facts.find((f) => f.type === type && f.loc.doc === 'log'); return f && `${f.loc.owner}#${f.loc.index}`;
    }).filter(Boolean))];
    report = await A.LLM.narrateScenario(sc, { cache: false, entryIds,
      onDiagnostic: (_d, r) => { if (args.includes('--report')) fs.writeFileSync(value('--report'), JSON.stringify({ ...r, fixed: !!sc.meta.fixed, seed: sc.meta.seed }, null, 2) + '\n'); },
      onProgress: (p) => { if (!p.inflight) console.log(`全文 ${p.doneEntries}/${p.totalEntries} API ${p.calls}回`); } });
    report.mode = real ? '実API' : '意味抽出・監査のスタブ（実モデルの信頼性は未検証）';
    report.fixed = !!sc.meta.fixed; report.seed = sc.meta.seed;
    if (!report.verification.pass) process.exitCode = 1;
  }
  if (args.includes('--report')) fs.writeFileSync(value('--report'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ mode: report.mode, model: report.model, metrics: report.metrics,
    stats: report.stats, verification: report.verification?.pass }, null, 2));
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
