// 主観ログ全文 → 独立した意味抽出 → 引用の監査・比較 → 局所修正／テンプレート復帰。
(function (A) {
  'use strict';
  const M = A.Semantics;
  const object = (properties) => ({ type: 'object', additionalProperties: false, properties, required: Object.keys(properties) });
  const string = { type: 'string' }, bool = { type: 'boolean' }, integer = { type: 'integer' };
  const list = (items) => ({ type: 'array', items });
  const fields = list(object({ key: string, value: string }));
  const EXTRACT_SCHEMA = object({ observations: list(object({ type: { type: 'string', enum: A.Evidence.vocabulary().map((v) => v.type) },
    fields, qualifiers: list(object({ key: string, value: bool })), source_kind: { type: 'string', enum: ['direct', 'memory', 'speech', 'document', 'machine'] },
    modality: { type: 'string', enum: ['observed', 'reported', 'inferred', 'hypothetical', 'question'] },
    polarity: { type: 'string', enum: ['affirmative', 'negative_constraint', 'negative'] }, quote: string })),
    additions: list(object({ kind: string, quote: string, reason: string })) });
  const AUDIT_SCHEMA = object({ grounding: list(object({ index: integer, supported: bool, quote: string, reason: string })),
    equivalences: list(object({ index: integer, field: string, expected: string, actual: string, equivalent: bool, quote: string })),
    additions: list(object({ kind: { type: 'string', enum: ['allowed', 'unauthorized_event', 'unauthorized_trait', 'viewpoint_violation', 'changed_modality', 'verification_uncertain'] }, quote: string, reason: string })),
    quality: list(object({ code: { type: 'string', enum: ['quality_warning'] }, quote: string, reason: string })), uncertain: bool });
  const GENERATE_SCHEMA = object({ entry_id: string, text: string });
  function entryId(owner, index) { return `${owner}#${index}`; }
  function context(sc, owner, index) {
    const e = sc.documents.chip_logs[owner][index], tr = sc.solution.transplant;
    const writer = sc.residents.find((r) => r.id === (tr?.victim === owner && e.t >= tr.t ? tr.carrier : owner));
    const previous = sc.documents.chip_logs[owner].filter((x) => x.t < e.t && !x.deleted).slice(-2);
    return { time: e.timestamp, role: e.role, persona: { pronoun: writer.profile.pronoun,
      personality: writer.profile.personality, goal: e.kind === 'final' ? null : writer.profile.goal },
      rules: sc.publicCulture.text, previous: previous.map((x) => x.text), required: M.required(sc, e),
      scene_records: Object.values(sc.documents.chip_logs).flat().filter((x) => x !== e && x.scene === e.scene && !x.deleted && x.narrator === 'llm').map((x) => ({ time: x.timestamp, text: x.text })),
      scope: e.kind === 'final' ? '意識を失う前の感覚。脈拍停止や自分の死亡確認は語らない。' : '示された観察・文書・会話のみ。他人の内面、未提示の道具・出来事・特徴を足さない。' };
  }
  function contextKey(sc, owner, index) { return M.hash(context(sc, owner, index)); }
  function extractionInput(text, input, al) {
    return { text, references: Object.keys(al.reverse), time: input.time, observer: al.selfReference,
      public_rules: input.rules,
      vocabulary: A.Evidence.vocabulary().map((v) => ({ ...v, qualifiers: Object.keys(M.QUALIFIERS[v.type] || {}),
        default_source: M.SOURCES[v.type] || 'direct' })),
      conventions: 'observerは書き手自身の参照。一人称（私、俺、僕等）はobserverへ対応させる。source_kindは知った経路。modalityのobservedは直接観察・本人の記憶・実際に閲覧した文書/機械記録の内容を記すこと。reportedは他者の発言を引用した場合、inferredは推測。過去形や「書類に記された」だけをreportedにしない。polarityは出来事自体の肯否。鍵を受領したならaffirmative、受領していないならnegative。複製や貸与なしは個別qualifiersで保持する。文型は語彙説明でありコピー不要。NEXTはpがqの直後、PREVIOUSはpがqの直前、BEFOREはpがqより後（隣接不要）。WORKは当番登録と実際の作業の両方。ACKは警告の読解・署名・復唱・解除の選択で、単なる応答ではない。LAST_SENSEは意識を失う前の本人の最後の感覚。',
      note: '期待する証拠一覧は与えていない。本文に明示されたものだけ抽出する。fieldは語彙のfieldsにあるものだけ。valuesは文型の意味へ正規化し、引用は本文をそのままコピー。LAST_SENSEの本人と現在時刻だけはobserver/timeというプログラムのヘッダーで確定する。他の過去の操作時刻・区間は本文に必要。足りない情報を補完せず、そのfieldは省く。'
    };
  }
  const EXTRACT_SYSTEM = '独立した読解者として主観記録の意味を抽出する。正解を推測しない。証拠のtypeと各field、情報源、発言か観察か、否定・期間の制約を読み取る。qualifiersは本文または公開規定で支えられた場合のみtrue。時刻はD04 10:00形式、人物は渡された<Pn>参照で返す。全文の引用に各要素を含める。感情や既存設定に沿う表現を事件の事実へ変えない。未知の出来事・特徴・アリバイ・他人の内面などはadditionsへ記録する。';
  const GENERATE_SYSTEM = 'シェルターの主観ログ全文を書いてtextへ返す。必須証拠は意味を守り、自然な語順変更・言い換え・台詞化ができる。完成文のコピーは不要。エントリIDと時刻ヘッダーはプログラムが管理する。人物は与えられた<Pn>のみを使い、実名・内部IDを書かない。本人の感情と、既存の人物設定に沿う語り方は許可。意味を増やさない情景も許可。新しい持ち物・資格・接触・所在・症状・識別特徴・アリバイは追加しない。渡されたqualificationの職種は省かず、専任資格の照合結果を示す。source_kind machineは端末の自動履歴として、documentは閲覧した票や台帳として示し、単なる「記録」とぼかさない。発言や推測は断定へ変えない。主観として知れない死亡確認・機械情報は自身の経験へ変えない。別解の排除や解き方を説明しない。長さは60〜180字を目安とし、必要な証拠を優先する。';
  const AUDIT_SYSTEM = '抽出と本文の対応を独立に監査する。groundingは各抽出が引用の意味に支えられているか判定し、本文中の引用を添える。equivalencesは必須証拠の文字列fieldの自然な同義表現を比較する。expectedとactualには入力のargs/fieldsの値をそのまま返し、比較対象自体を言い換えない。文字列fieldの抽出が短い要約でも、引用の前後に必要な意味が全部明示されているなら全文を引用して同義と判定できる。例えば「線量計を持って救助に入った」に対し本文が救助と線量計の携帯を共に示す場合は、それらを一緒に読む。本文に欠落した情報を期待値で補わない。人物・数値・時刻・区間・否定・情報源・主張の種類を意味の同じものとして勝手に変えない。必須証拠と公開規定・知覚可能な文脈にない論理に影響する追加をadditionsへ分類する。自己の感情と既存の性格は許可。他人の目的の根拠なき断定、自己の死後の経験、未設定の持続的特徴は不許可。qualityは硬さ・長さ・反復等の警告で合否と分ける。根拠がない判定はuncertainとする。';
  function phase(stats, name) { stats.phases[name] = (stats.phases[name] || 0) + 1; }
  async function assess(sc, owner, index, text, input, al, stats, signal) {
    phase(stats, 'extraction');
    const extractInput = extractionInput(text, input, al);
    const extraction = await A.LLM.requestJSON({ model: A.LLM.settings().verifyModel, signal,
      name: 'log_evidence_extraction', system: EXTRACT_SYSTEM, user: JSON.stringify(extractInput), schema: EXTRACT_SCHEMA }, stats);
    phase(stats, 'audit');
    const expected = M.encodeContracts(input.required, al);
    const auditInput = { text, extraction, required: expected, allowed_context: { persona: input.persona, public_rules: input.rules, scope: input.scope,
      allowed_inner_voice: '本人の感情・評価、記録を覚えておきたい/心に留めたい等の証拠の意味を増やさない意向は許可。新しい殺意、接触の決意、アリバイ、行動の実行はこの許可に含まれない。',
      observer: al.selfReference, time: input.time, conventions: extractInput.conventions,
      header_scope: 'LAST_SENSEの本人と現在時刻だけは記録ヘッダーが保証する。それ以外の操作時刻は本文に必要。' } };
    const audit = await A.LLM.requestJSON({ model: A.LLM.settings().verifyModel, signal,
      name: 'log_evidence_audit', system: AUDIT_SYSTEM, user: JSON.stringify(auditInput), schema: AUDIT_SCHEMA }, stats);
    const decodedText = al.decode(text), decoded = M.decodeExtraction(extraction, al);
    const decodedAudit = M.transform(audit, al.decode);
    const result = M.compare(input.required, decoded, decodedAudit, decodedText);
    return { ...result, extraction, audit, extractInput, auditInput, decodedText,
      extractionSystem: EXTRACT_SYSTEM, auditSystem: AUDIT_SYSTEM };
  }
  function applyEntryCache(sc, owner, index, cache) {
    const e = sc.documents.chip_logs[owner][index];
    if (cache.version !== M.VERSION || cache.prompt !== M.PROMPT || cache.contextHash !== contextKey(sc, owner, index)) return false;
    if (cache.failed) {
      e.narrator = 'template'; e.narrationError = cache.error; e.narrationDiagnostic = cache.diagnostic; return true;
    }
    if (!cache.semantic || typeof cache.text !== 'string') return false;
    const probe = { ...e, semantic: cache.semantic };
    if (M.readReceipt(sc, probe, cache.text).errors.length) return false;
    e.text = cache.text; e.semantic = cache.semantic; e.narrator = 'llm'; e.narrationDiagnostic = cache.diagnostic; return true;
  }
  function metrics(diagnostics) {
    const target = diagnostics.length, initiallyAccepted = diagnostics.filter((d) => d.attempts[0]?.pass).length;
    const accepted = diagnostics.filter((d) => d.origin === 'llm').length;
    const codes = {};
    for (const d of diagnostics) for (const code of new Set(d.attempts.flatMap((a) => a.issues.map((v) => v.code)))) codes[code] = (codes[code] || 0) + 1;
    const finalCodes = {};
    for (const d of diagnostics) for (const code of new Set(d.attempts.at(-1).issues.map((v) => v.code))) finalCodes[code] = (finalCodes[code] || 0) + 1;
    return { target, initiallyAccepted, accepted, fallback: target - accepted,
      initialAcceptanceRate: target ? initiallyAccepted / target : null, finalAcceptanceRate: target ? accepted / target : null,
      fallbackRate: target ? (target - accepted) / target : null, automaticClassifications: codes, finalAutomaticClassifications: finalCodes,
      uncertain: diagnostics.filter((d) => d.attempts.some((a) => a.issues.some((i) => i.code === 'verification_uncertain'))).length,
      unresolvedUncertain: diagnostics.filter((d) => d.origin !== 'llm' && d.attempts.at(-1).issues.some((i) => i.code === 'verification_uncertain')).length,
      qualityWarnings: diagnostics.filter((d) => d.attempts.some((a) => a.quality?.length)).length,
      humanConfirmedSemanticChanges: null, humanConfirmedFalsePositives: null };
  }
  async function run(sc, opts = {}) {
    const s = A.LLM.settings();
    if (!A.LLM.isConfigured()) throw new A.LLM.LLMError('APIキー未設定。テンプレートで遊べます。', 0, true);
    const stats = { calls: 0, retries: 0, inflight: 0, promptTokens: 0, completionTokens: 0, lastIssue: '', phases: {}, emit: () => {} };
    const report = { model: s.model, entries: 0, llm: 0, cached: opts.cache === false ? 0 : A.LLM.applyCache(sc),
      unresolved: [], specErrors: [], contradictions: 0, overlap: null, stats, diagnostics: [],
      scope: '全文生成・独立した意味抽出・引用監査。数学的な意味保証ではない。' };
    let items = Object.entries(sc.documents.chip_logs).flatMap(([owner, es]) => es.map((e, index) => ({ owner, index, e })).filter((x) => !x.e.deleted));
    items.sort((a, b) => a.e.t - b.e.t);
    if (opts.entryIds) items = items.filter((x) => opts.entryIds.includes(entryId(x.owner, x.index)));
    if (opts.limit) items = items.slice(0, opts.limit);
    report.entries = items.length;
    const cache = opts.cache === false ? { entries: {}, details: {} } : A.LLM.loadCache(sc);
    let done = 0;
    stats.emit = () => opts.onProgress?.({ event: '全文の生成・意味抽出と照合', calls: stats.calls, inflight: stats.inflight,
      retries: stats.retries, totalEntries: items.length, doneEntries: done, totalWaves: items.length, doneWaves: done });
    for (const { owner, index, e } of items) {
      if (opts.signal?.aborted) throw opts.signal.reason;
      if (e.narrator) { done++; if (e.narrator === 'llm') report.llm++; continue; }
      const draft = e.draft || e.text; e.draft = draft;
      const input = context(sc, owner, index), al = M.aliases(sc, e), id = `log-${done + 1}`;
      const encoded = { ...input, narrator_ref: al.selfReference, required: M.encodeContracts(input.required, al), previous: input.previous.map((v) => al.encode(v)),
        scene_records: input.scene_records.map((x) => ({ ...x, text: al.encode(x.text) })), entry_id: id,
        semantics: 'narrator_refが書き手。別の<Pn>を自分にしない。一人称の主語を明示できる。時刻のt/start/endは実際の観察・操作の日時で、本文に意味を残す（LAST_SENSEの現在時刻はヘッダーが保証）。全qualifiersも意味を維持する。NEXTはpがqの直後、PREVIOUSはpがqの直前。WORKは当番登録と実際の作業。ACKは断線・感電警告を読み署名・復唱した上で解除を選んだ記憶。PLANは実際に選んだ決意で、単なる仮定ではない。受領や所在の肯定と、貸与等の否定を混同しない。' };
      const diagnostic = { seed: sc.meta.seed, generatorVersion: sc.meta.version, evidenceVersion: M.VERSION,
        promptVersion: M.PROMPT, model: s.model, verifyModel: s.verifyModel, sceneId: e.scene, entryId: entryId(owner, index),
        referenceMapping: al.mapping, stages: ['内部ID→別名→参照検査→内部IDへ復元→意味抽出の照合'],
        contextHash: contextKey(sc, owner, index), template: draft, required: input.required, attempts: [], origin: 'template' };
      diagnostic.responseSchemas = { generation: GENERATE_SCHEMA, extraction: EXTRACT_SCHEMA, audit: AUDIT_SCHEMA };
      let accepted = false, feedback = null;
      for (let round = 0; round <= s.repairRounds; round++) {
        const generationInput = feedback ? { ...encoded, repair: feedback } : encoded;
        phase(stats, round ? 'repair' : 'generation');
        const candidate = await A.LLM.requestJSON({ model: s.model, signal: opts.signal, name: 'whole_subjective_log',
          system: GENERATE_SYSTEM, user: JSON.stringify(generationInput), schema: GENERATE_SCHEMA }, stats);
        let result = { pass: false, issues: M.formatIssues(sc, candidate.text, al, id, candidate.entry_id), quality: [] };
        if (!result.issues.length) {
          try { result = await assess(sc, owner, index, candidate.text, input, al, stats, opts.signal); }
          catch (error) {
            if (opts.signal?.aborted) throw error;
            result.issues = [{ code: 'verification_uncertain', quote: candidate.text, detail: '意味抽出または監査の応答を取得できなかった。' }];
          }
        }
        const attempt = { round, generationInput, generationSystem: GENERATE_SYSTEM, output: candidate,
          extractionSystem: result.extractionSystem || null, auditSystem: result.auditSystem || null, extractionInput: result.extractInput || null,
          extraction: result.extraction || null, auditInput: result.auditInput || null, audit: result.audit || null,
          pass: result.pass, issues: result.issues, quality: result.quality };
        diagnostic.attempts.push(attempt);
        if (result.pass) {
          e.text = result.decodedText; e.semantic = M.receipt(sc, e, e.text, result); e.narrator = 'llm';
          diagnostic.origin = 'llm'; accepted = true; report.llm++; break;
        }
        const readableIssues = result.issues.map((v) => ['t', 'start', 'end'].includes(v.field) ? { ...v,
          expected: typeof v.expected === 'number' ? A.util.fmtT(v.expected) : v.expected,
          actual: typeof v.actual === 'number' ? A.util.fmtT(v.actual) : v.actual } : v);
        feedback = { previous_text: candidate.text, issues: M.transform(readableIssues,
          (v) => al.encode(v).replace(/\b[A-D]-\d{2}-\d{2}\b/g, (id) => al.mapping[`{P:${id}}`] || 'SELF')),
          instruction: '引用された問題のfieldだけを、requiredの意味に合わせて修正する。他の合格した観察は維持し、自然な言い換えは使える。' };
      }
      e.narrationDiagnostic = diagnostic;
      if (!accepted) {
        e.text = draft; delete e.semantic; e.narrator = 'template';
        const problems = diagnostic.attempts.at(-1).issues;
        e.narrationError = { codes: [...new Set(problems.map((i) => i.code))], problems: problems.map((i) => JSON.stringify(i)) };
        report.specErrors.push({ owner, index, timestamp: e.timestamp, scene: sc.story.scenes.find((v) => v.id === e.scene),
          required: draft.split('\n'), ...e.narrationError });
      }
      report.diagnostics.push(diagnostic);
      opts.onDiagnostic?.(diagnostic, report);
      cache.entries[entryId(owner, index)] = { version: M.VERSION, prompt: M.PROMPT, contextHash: diagnostic.contextHash,
        draft, failed: !accepted, text: e.text, semantic: e.semantic, error: e.narrationError, diagnostic };
      if (opts.cache !== false) A.LLM.saveCache(sc, cache);
      done++; stats.emit();
    }
    report.metrics = metrics(report.diagnostics);
    report.verification = A.Verifier.verify(sc);
    sc.meta.narration = { model: s.model, prompt: M.PROMPT, validation: report.scope };
    return report;
  }
  async function recheck(sc, diagnostic, opts = {}) {
    const [owner, index] = diagnostic.entryId.split('#'), e = sc.documents.chip_logs[owner][Number(index)];
    const latest = diagnostic.attempts.at(-1), input = context(sc, owner, Number(index)), al = M.aliases(sc, e, diagnostic.referenceMapping);
    const stats = { calls: 0, retries: 0, inflight: 0, promptTokens: 0, completionTokens: 0, phases: {}, emit: () => {} };
    const previousText = e.text;
    const form = M.formatIssues(sc, latest.output.text, al, latest.generationInput.entry_id, latest.output.entry_id);
    const result = form.length ? { pass: false, issues: form, quality: [] }
      : await assess(sc, owner, Number(index), latest.output.text, input, al, stats, opts.signal);
    if (result.pass) {
      e.draft = e.draft || e.text; e.text = result.decodedText; e.semantic = M.receipt(sc, e, e.text, result); e.narrator = 'llm';
      delete e.narrationError;
    } else {
      e.text = e.draft || e.text; delete e.semantic; e.narrator = 'template';
      e.narrationError = { codes: [...new Set(result.issues.map((v) => v.code))], problems: result.issues.map((v) => JSON.stringify(v)) };
    }
    diagnostic.attempts.push({ ...latest, phase: 'recheck', evidenceVersion: M.VERSION, promptVersion: M.PROMPT, required: input.required, pass: result.pass, issues: result.issues,
      extractionSystem: result.extractionSystem || null, auditSystem: result.auditSystem || null,
      extractionInput: result.extractInput, extraction: result.extraction, auditInput: result.auditInput, audit: result.audit, quality: result.quality });
    diagnostic.origin = result.pass ? 'llm' : 'template'; e.narrationDiagnostic = diagnostic;
    // 書き直した記録を参照した後続本文は、既存の意味検証を流用せず未処理へ戻す。
    const invalidated = [];
    if (previousText !== e.text) for (const [laterIndex, later] of sc.documents.chip_logs[owner].entries()) if (later.t > e.t && later.narrator) {
      later.text = later.draft || later.text;
      for (const key of ['semantic', 'narrator', 'narrationError', 'narrationDiagnostic']) delete later[key];
      invalidated.push(entryId(owner, laterIndex));
    }
    const cache = A.LLM.loadCache(sc);
    cache.entries[entryId(owner, Number(index))] = { version: M.VERSION, prompt: M.PROMPT, contextHash: contextKey(sc, owner, Number(index)),
      draft: e.draft || e.text, failed: !result.pass, text: e.text, semantic: e.semantic, diagnostic, error: e.narrationError };
    A.LLM.saveCache(sc, cache);
    return { result, stats, invalidated }; // 再生成APIは呼ばない。意味検証だけをやり直す。
  }
  A.Narration = { run, recheck, assess, context, contextKey, applyEntryCache, metrics, schemas: { GENERATE_SCHEMA, EXTRACT_SCHEMA, AUDIT_SCHEMA } };
})(window.ASARIYA = window.ASARIYA || {});
