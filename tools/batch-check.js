// node tools/batch-check.js 1 100 --report docs/ai/validation.json
// node tools/batch-check.js --fixed / --dump 3 / 1 20 --large / 1 3 --llm
const fs = require('node:fs');
const { load } = require('./load');
const A = load({ localConfig: true });
const args = process.argv.slice(2);
const value = (flag) => args[args.indexOf(flag) + 1];
const opts = { fixed: args.includes('--fixed'), size: args.includes('--large') ? 'large' : 'standard', mode: args.includes('--hard') ? 'hard' : 'standard' };
const useLLM = args.includes('--llm');
const positional = args.filter((a, i) => !a.startsWith('--') && !['--report', '--dump', '--review'].includes(args[i - 1]));
const hist = (values) => values.reduce((out, v) => (out[v] = (out[v] || 0) + 1, out), {});
function summary(rows) {
  const successes = rows.filter((r) => r.pass);
  const distribution = (key) => {
    const values = successes.map((r) => r.metrics[key]);
    return { min: values.length ? Math.min(...values) : null, max: values.length ? Math.max(...values) : null,
      mean: values.length ? values.reduce((a, b) => a + b, 0) / values.length : null, distribution: hist(values) };
  };
  return { pass: successes.length, count: rows.length, generationFailures: rows.filter((r) => r.generationError).length,
    retries: rows.reduce((n, r) => n + Math.max(0, (r.attempts || 1) - 1), 0), attempts: hist(rows.map((r) => r.attempts || 'failed')),
    types: hist(successes.map((r) => r.type)), tricks: hist(successes.flatMap((r) => r.tricks)), residents: hist(successes.map((r) => r.residents)),
    verdicts: hist(successes.map((r) => r.verdict.result)), steps: hist(successes.map((r) => r.steps.length)),
    logs: distribution('logs'), characters: distribution('characters'), directNumbers: distribution('directNumbers'),
    killersInFinal: distribution('killersInFinal'), multiSourceConclusions: distribution('multiSourceConclusions') };
}
async function main() {
  if (useLLM && !A.LLM.isConfigured()) throw new Error('--llm には config.local.js の API キーが必要です');
  if (args.includes('--dump')) {
    const { scenario } = A.Generator.generate(Number(value('--dump')), opts);
    if (useLLM) await A.LLM.narrateScenario(scenario, { cache: false });
    process.stdout.write(JSON.stringify(scenario, null, 2)); return;
  }
  const start = opts.fixed ? 730 : Number(positional[0] || 1), count = opts.fixed ? 1 : Number(positional[1] || 20);
  if (!Number.isSafeInteger(count) || count < 1 || count > 10000) throw new Error('本数は1〜10000の整数で指定してください');
  const rows = [], began = Date.now();
  for (let seed = start; seed < start + count; seed++) {
    try {
      const { scenario: sc, failures } = A.Generator.generate(seed, opts);
      const llm = useLLM ? await A.LLM.narrateScenario(sc, { cache: false }) : null;
      const report = A.Verifier.verify(sc);
      const row = { seed, pass: report.pass, checks: report.validation, attempts: sc.meta.attempts, failures,
        residents: sc.residents.length, type: sc.meta.type, tricks: sc.tricks.map((t) => t.type), verdict: report.outcome.verdict,
        steps: report.reach.steps, metrics: report.metrics, errors: report.errors,
        trace: args.includes('--trace') || !rows.some((r) => r.type === sc.meta.type) ? report.trace : undefined,
        llm: llm ? { calls: llm.stats.calls, entries: llm.entries, accepted: llm.llm, fallbacks: llm.specErrors.length,
          metrics: llm.metrics, stats: llm.stats, diagnostics: llm.diagnostics, scope: llm.scope } : '未実施' };
      rows.push(row);
      console.log(`seed ${seed} ${report.pass ? 'PASS' : 'FAIL'} 因果=${report.validation.truth} 推論=${report.validation.evidence} 本文=${report.validation.text} 試行=${sc.meta.attempts} 住人=${sc.residents.length} 型=${sc.meta.type} ログ=${report.metrics.logs} 文字=${report.metrics.characters}`);
      if (!report.pass) console.log(report.errors.join('\n'));
    } catch (e) {
      rows.push({ seed, pass: false, generationError: e.message, failures: e.failures || [] });
      console.log(`seed ${seed} FAIL ${e.message}\n${(e.failures || []).join('\n')}`);
    }
  }
  const output = { format: A.CONFIG.version, generatedAt: new Date().toISOString(), mode: opts, llm: useLLM ? '実施' : '未実施',
    humanBlindPlay: '未実施', durationMs: Date.now() - began, summary: summary(rows), rows };
  console.log(JSON.stringify(output.summary, null, 2));
  if (args.includes('--report')) fs.writeFileSync(value('--report'), JSON.stringify(output, null, 2) + '\n');
  if (args.includes('--review')) fs.writeFileSync(value('--review'), '# 検証レポート\n\n```json\n' + JSON.stringify(output.summary, null, 2) + '\n```\n\nLLM: ' + output.llm + '。正解を知らない人によるプレイ確認: 未実施。\n');
  if (output.summary.pass !== count) process.exitCode = 1;
}
main().catch((e) => { console.error(e.message); process.exitCode = 1; });
