// シナリオ生成と検証を Node でまとめて回す（設計書 §12.3 の完了条件の確認用）
//   node tools/batch-check.js [開始シード=1] [本数=20]          テンプレート文で生成・検証
//   node tools/batch-check.js [開始シード] [本数] --llm          LLM で文章化して往復検証まで行う（API を呼ぶ）
//   node tools/batch-check.js --dump シード [--llm]              シナリオ JSON を出力
//   node tools/batch-check.js [開始] [本数] --llm --review 出力.md  人が読むためのログの抜き出しとチェックリストを書き出す
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const context = { console, fetch, setTimeout, clearTimeout, AbortController };
context.window = context;
vm.createContext(context);
const files = ['config.js', 'config.local.js', 'util.js', 'solver.js', 'tricks.js', 'narrator.js', 'culture.js', 'story.js', 'generator.js', 'llm.js'];
for (const f of files) {
  const p = path.join(root, 'js', f);
  if (!fs.existsSync(p)) continue; // config.local.js は無くてもよい
  vm.runInContext(fs.readFileSync(p, 'utf8'), context, { filename: f });
}
const A = context.ASARIYA;

const args = process.argv.slice(2);
const useLLM = args.includes('--llm');
const reviewIdx = args.indexOf('--review');
const reviewFile = reviewIdx >= 0 ? args[reviewIdx + 1] : null;
const review = [];

// 人が読んで確かめるための抜き出し（改修仕様 v0.2 §11 第2段階 7）
function collectReview(sc) {
  const nm = (id) => (sc.residents.find((r) => r.id === id) || {}).name || id;
  const show = (t) => t.replace(/\{P:([^}]+)\}/g, (m, id) => `〔${nm(id)}〕`);
  const picks = [];
  const logs = Object.entries(sc.documents.chip_logs);
  const daily = logs.flatMap(([o, es]) => es.filter((e) => e.narrator === 'llm' && e.kind === 'daily' && e.facts.length).map((e) => [o, e]));
  const other = logs.flatMap(([o, es]) => es.filter((e) => e.narrator === 'llm' && ['crisis', 'witness', 'final'].includes(e.kind)).map((e) => [o, e]));
  for (const [o, e] of daily.slice(0, 2).concat(other.slice(0, 1))) {
    const r = sc.residents.find((x) => x.id === e.writer);
    const head = `- **${nm(e.writer)}**（${r.profile.personality}、${A.CONFIG.people.genderLabels[r.profile.gender]}・${r.profile.age}歳） ${e.timestamp}［${e.kind}］`;
    picks.push(`${head}\n  > ${show(e.text)}`);
  }
  const checklist = ['答え（区画・入居順・職能）を直接述べる文がない', '文化のルールの一般論がない', '人物の性格・態度・関係が文章から読み取れる'];
  review.push(`## シード ${sc.meta.seed}（${sc.shelter.name}）\n\n${picks.join('\n\n')}\n\n${checklist.map((c) => `- [ ] ${c}`).join('\n')}\n`);
}
const positional = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--review');

async function narrate(sc) {
  if (!useLLM) return null;
  if (!A.LLM.isConfigured()) throw new Error('js/config.local.js に OpenAI の API キーが設定されていません');
  const rep = await A.LLM.narrateScenario(sc, { cache: false });
  // 対話できないので、検証に通らなかったエントリはテンプレート文で確定させる
  A.LLM.useTemplate(sc, rep.unresolved);
  return rep;
}

async function main() {
  if (useLLM && !A.LLM.isConfigured()) {
    console.log('--llm には js/config.local.js の OpenAI API キーが必要です（js/config.local.example.js をコピーして作成）');
    return 1;
  }
  const dumpIdx = args.indexOf('--dump');
  if (dumpIdx >= 0) {
    const { scenario } = A.Generator.generate(Number(args[dumpIdx + 1]));
    await narrate(scenario);
    process.stdout.write(JSON.stringify(scenario, null, 2));
    return 0;
  }

  const start = Number(positional[0] || 1);
  const count = Number(positional[1] || 20);
  let pass = 0;
  const t0 = Date.now();
  const total = { entries: 0, llm: 0, unresolved: 0, spec: 0, calls: 0, tokens: 0, overlap: [], specCodes: {}, unresolvedCodes: {} };
  // 推理の段数・学習されるルールの分布（改修仕様 v0.2 §11）
  const dist = { steps: {}, rules: {}, ruleStep: {}, ruleKinds: {}, dialogue: {}, attempts: {} };
  const inc = (m, k) => (m[k] = (m[k] || 0) + 1);
  for (let s = start; s < start + count; s++) {
    try {
      const { scenario: sc, report } = A.Generator.generate(s);
      const rep = await narrate(sc);
      if (rep && reviewFile) collectReview(sc);
      let llmNote = '';
      let ok = true;
      if (rep) {
        total.entries += rep.entries;
        total.llm += rep.llm;
        total.unresolved += rep.unresolved.length;
        total.spec += rep.specErrors.length;
        if (rep.overlap != null) total.overlap.push(rep.overlap);
        rep.specErrors.forEach((f) => f.codes.forEach((c) => (total.specCodes[c] = (total.specCodes[c] || 0) + 1)));
        rep.unresolved.forEach((f) => (f.codes || []).forEach((c) => (total.unresolvedCodes[c] = (total.unresolvedCodes[c] || 0) + 1)));
        total.calls += rep.stats.calls;
        total.tokens += rep.stats.promptTokens + rep.stats.completionTokens;
        ok = rep.verification.pass;
        llmNote =
          `  LLM ${rep.llm}/${rep.entries} 未解決${rep.unresolved.length} 仕様エラー${rep.specErrors.length}` +
          ` 重複率${rep.overlap == null ? '—' : (rep.overlap * 100).toFixed(1) + '%'} API${rep.stats.calls}回`;
      }
      if (ok) pass++;
      const dead = sc.residents.filter((r) => r.status === 'dead').length;
      const v = sc.current_state.verdict;
      const rules = report.reach.rules || [];
      inc(dist.steps, report.reach.steps.length);
      inc(dist.rules, rules.length);
      inc(dist.attempts, sc.meta.attempts);
      inc(dist.dialogue, sc.facts.filter((f) => f.loc.doc === 'dialogue' && ['DISTRICT', 'ENTRY_ORDER'].includes(f.type)).length);
      rules.forEach((r) => {
        inc(dist.ruleStep, r.step);
        inc(dist.ruleKinds, r.rule.split(':')[0]);
      });
      console.log(
        `seed ${String(s).padStart(5)}  ${ok ? 'OK' : 'NG'}  試行${sc.meta.attempts}  住人${sc.residents.length} 死者${dead}  ` +
          `段数${report.reach.steps.length} [${report.reach.perStep.join(',')}] ルール${rules.length}  ` +
          `危機=${sc.shelter.crisis}  トリック=${sc.tricks.map((t) => t.type).join('+') || 'なし'}  ` +
          `判定=${v.result}${v.reasons.length ? '(' + v.reasons.join(',') + ')' : ''}${llmNote}`,
      );
      if (rep) {
        rep.specErrors.forEach((f) => console.log(`      ! 仕様エラー ${f.owner}#${f.index} 〔${f.codes.join(',')}〕 ${f.problems.slice(0, 2).join(' / ')}`));
        rep.unresolved.forEach((f) => console.log(`      - 未解決 ${f.owner}#${f.index} 〔${(f.codes || []).join(',')}〕 ${f.problems.slice(0, 2).join(' / ')}`));
        if (!ok) rep.verification.errors.slice(0, 5).forEach((e) => console.log('      ! ' + e));
      }
    } catch (e) {
      console.log(`seed ${String(s).padStart(5)}  NG  ${e.message}`);
      (e.failures || []).slice(0, 5).forEach((f) => console.log('      - ' + f));
      if (e.fatal) break;
    }
  }
  console.log(`\n${pass}/${count} 本が到達可能性・一意性・往復検証を通過 (${Date.now() - t0}ms)`);
  const fmt = (m) =>
    Object.entries(m)
      .sort((a, b) => (isNaN(a[0]) ? a[0].localeCompare(b[0]) : a[0] - b[0]))
      .map(([k, v]) => `${k}:${v}`)
      .join(' ');
  console.log(`推理の段数の分布：${fmt(dist.steps)}`);
  console.log(`学習されるルール数の分布：${fmt(dist.rules)}`);
  console.log(`ルールを学習した段の分布：${fmt(dist.ruleStep)}（0＝最初から読める資料で学習）`);
  console.log(`学習されるルールの種類：${fmt(dist.ruleKinds)}`);
  console.log(`会話ログの直接の事実の数：${fmt(dist.dialogue)}`);
  console.log(`生成の試行回数：${fmt(dist.attempts)}`);
  if (useLLM) {
    const avg = total.overlap.length ? total.overlap.reduce((a, b) => a + b, 0) / total.overlap.length : null;
    console.log(`LLM 文章化：合格 ${total.llm}/${total.entries}（${total.entries ? Math.round((100 * total.llm) / total.entries) : 0}%）・ 未解決 ${total.unresolved} ・ 仕様エラー ${total.spec} ・ API ${total.calls} 回 ・ ${total.tokens} トークン`);
    console.log(`下書きとの重複率（平均）：${avg == null ? '—' : (avg * 100).toFixed(1) + '%'}`);
    console.log(`仕様エラーの内訳：${JSON.stringify(total.specCodes)} ／ 未解決の内訳：${JSON.stringify(total.unresolvedCodes)}`);
  }
  if (reviewFile && review.length) {
    fs.writeFileSync(reviewFile, `# LLM 文章化の抜き出し（人が読んで確かめる）\n\n${review.join('\n')}`, 'utf8');
    console.log(`抜き出しを書き出した：${reviewFile}`);
  }
  return pass === count ? 0 : 1;
}

main().then((code) => process.exit(code));
