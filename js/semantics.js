// 全文生成用の意味契約・参照変換・照合。抽出結果は本文の引用と独立監査に結び付ける。
(function (A) {
  'use strict';
  const VERSION = 'semantic-3', PROMPT = 'whole-log-4';
  const PERSON = new Set(['p', 'q', 'v', 'k', 'a', 'b', 'owner']);
  const TIME = new Set(['t', 'start', 'end']);
  const NUMBER = new Set(['n', 'amount', 'limit', 'days', 'value']);
  const FREE = new Set(['task', 'quote', 'scope', 'lesson', 'goal', 'choice', 'feeling', 'meaning', 'route', 'sign', 'hazard', 'defect', 'operation', 'qualification']);
  const SOURCES = {
    WORK: 'document', NEXT: 'document', PREVIOUS: 'document', NUMBER: 'document', LAST: 'document', FAULT: 'document',
    KEY: 'document', LIMIT: 'document', RATIONS: 'document', PLAN: 'memory', MENTOR: 'speech',
    WORDS: 'speech', CLAIM: 'speech', TESTIMONY: 'speech', OFFICIAL: 'speech', REVISION: 'machine',
    SWITCH: 'machine', TEST: 'document', PULSE_END: 'machine', BODY_SENSOR: 'machine', LIVE: 'machine',
    CHIP: 'machine', CARRIER: 'machine', LAST_SENSE: 'memory', ALIBI: 'machine', ACK: 'memory', DOSE_SETTING: 'memory',
  };
  const QUALIFIERS = {
    WORK: { registered_duty: true, work_seen: true },
    ACK: { read_warning: true, signed_warning: true, repeated_warning: true, chose_override: true },
    KEY: { no_duplicate: true, no_transfer: true, qualified: true }, GEAR: { no_exchange: true, no_transfer: true },
    KIT: { no_transfer: true, continuous_sight: true }, SWITCH: { qualified: true, no_other_operation: true },
    PUSH: { qualified: true, intact_platform: true }, INJECT: { qualified: true, intravenous: true },
    ALIBI: { continuous_video: true, no_exit: true }, EXPOSE: { first_contact: true },
    FEATURE: { unique_among_residents: true }, DOSE_SETTING: { understood_warning: true, manual_override: true },
    SHOCK: { pulse_stopped: true, no_recovery: true }, FALL: { pulse_stopped: true, intact_platform: true },
    STOP: { pulse_stopped: true, no_recovery: true }, TERMINAL: { pulse_stopped: true, no_recovery: true },
    STARVE: { pulse_stopped: true, no_recovery: true }, LIVE: { pulse: true, breathing: true },
    CARRIER: { pulse: true, breathing: true }, BODY_SENSOR: { pulse_stopped: true, fixed_camera: true },
    COLLAPSE: { pulse_stopped: true, single_collapse: true }, RAID: { unauthenticated_attacker: true, pulse_stopped: true },
    HATCH: { unauthenticated: true, only_entrance: true, one_person: true },
  };
  // 受領・所在という出来事は肯定。貸与なし等の否定は個別のqualifierで保持する。
  const polarity = () => 'affirmative';
  const modality = (type) => ['WORDS', 'CLAIM', 'TESTIMONY', 'OFFICIAL', 'MENTOR'].includes(type) ? 'reported' : 'observed';
  function contract(sc, f) {
    const observer = f.type === 'PULSE_END' || f.loc.doc === 'hatch' ? 'AI' : f.type === 'CARRIER' ? 'chip_carrier'
      : f.loc.owner || sc.documents.counselor_dialogues[f.loc.index]?.writer || 'AI';
    return { evidence_id: f.id, predicate: f.type, args: { ...f.args }, subject: f.args.p || f.args.v || f.args.owner || null,
      object: f.args.q || f.args.v || null, observer, source_kind: SOURCES[f.type] || 'direct',
      modality: modality(f.type), polarity: polarity(f.type), qualifiers: { ...(QUALIFIERS[f.type] || {}) },
      time: f.args.t ?? null, interval: f.args.start == null ? null : [f.args.start, f.args.end],
      value: f.args.n ?? f.args.value ?? f.args.amount ?? f.args.serial ?? null, unit: f.args.unit || (f.args.amount != null ? '単位' : null),
      required_precision: TIME.has(Object.keys(f.args).find((k) => TIME.has(k))) ? 'minute' : 'relation',
      epistemic_scope: f.type === 'LAST_SENSE' ? '本人が意識を失う前の感覚だけ。死亡確認や機械信号は自動付記へ分離。'
        : '指定された情報源が示す範囲。発言は事実へ昇格しない。他人の内面を創作しない。',
      critical_fields: [...Object.keys(f.args), 'source_kind', 'modality', 'polarity', ...Object.keys(QUALIFIERS[f.type] || {})] };
  }
  function attach(sc) {
    for (const f of sc.facts) f.semantic = contract(sc, f);
    sc.meta.evidenceVersion = VERSION;
  }
  function required(sc, e) {
    return e.facts.filter((id) => !(e.machineFacts || []).includes(id)).map((id) => contract(sc, sc.facts.find((f) => f.id === id)));
  }
  function hash(value) {
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    let n = 2166136261;
    for (let i = 0; i < text.length; i++) n = Math.imul(n ^ text.charCodeAt(i), 16777619);
    return (n >>> 0).toString(16);
  }
  function number(value) {
    const s = String(value).normalize('NFKC').trim();
    if (/^\d+(\.\d+)?$/.test(s)) return Number(s);
    if (s === '零' || s === '〇') return 0;
    const digits = '一二三四五六七八九';
    if (/^[一二三四五六七八九]+$/.test(s)) return Number([...s].map((x) => digits.indexOf(x) + 1).join(''));
    if (/^[一二三四五六七八九十百千]+$/.test(s)) {
      let result = 0, digit = 0;
      for (const ch of s) {
        if (digits.includes(ch)) digit = digits.indexOf(ch) + 1;
        else { result += (digit || 1) * ({ 十: 10, 百: 100, 千: 1000 })[ch]; digit = 0; }
      }
      return result + digit;
    }
    return s;
  }
  function normalize(key, value) {
    if (TIME.has(key)) {
      if (typeof value === 'number' || /^\d+$/.test(String(value))) return Number(value);
      const s = String(value).normalize('NFKC').trim();
      const m = s.match(/^D(\d{2})[ T]+(\d{1,2}):(\d{1,2})$/) || s.match(/^第?(\d+)日(?:目)?\s*(\d{1,2})時\s*(\d{1,2})分$/);
      return m ? A.util.tAbs(Number(m[1]), Number(m[2]) * 60 + Number(m[3])) : value;
    }
    if (NUMBER.has(key) || key === 'serial' && /^\d+$/.test(String(value))) return number(value);
    return typeof value === 'string' ? value.normalize('NFKC').trim() : value;
  }
  function aliases(sc, e, savedMapping) {
    const own = Object.values(sc.documents.chip_logs).find((es) => es.includes(e)) || [];
    const preceding = own.filter((x) => x.t < e.t && !x.deleted).slice(-2).map((x) => x.text);
    const sceneTexts = Object.values(sc.documents.chip_logs).flat().filter((x) => x !== e && x.scene === e.scene && !x.deleted && x.narrator === 'llm').map((x) => x.text);
    const refs = new Set([e.draft || e.text, ...preceding, ...sceneTexts].flatMap((v) => v.match(/\{P:[^}]+\}/g) || []));
    // 参照の正体は渡さない。移植後の書き手は SELF で扱い、隠されたIDを追加しない。
    const mapping = savedMapping || Object.fromEntries([...refs].map((ref, i) => [ref, `<P${i + 1}>`]));
    const reverse = Object.fromEntries(Object.entries(mapping).map(([id, alias]) => [alias, id]));
    const encode = (text) => String(text).replace(/\{P:[^}]+\}/g, (ref) => mapping[ref] || '<UNKNOWN>');
    const decode = (text) => String(text).replace(/[<＜]\s*[PＰ]\s*([0-9０-９]+)\s*[>＞]/g, (_, n) => reverse[`<P${n.normalize('NFKC')}>`] || `<UNKNOWN:P${n}>`);
    const owner = Object.keys(sc.documents.chip_logs).find((id) => sc.documents.chip_logs[id].includes(e));
    const tr = sc.solution.transplant, self = tr?.victim === owner && e.t >= tr.t ? tr.carrier : owner;
    return { mapping, reverse, encode, decode, self, selfReference: mapping[`{P:${self}}`] || 'SELF' };
  }
  function transform(value, fn) {
    if (typeof value === 'string') return fn(value);
    if (Array.isArray(value)) return value.map((v) => transform(v, fn));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, transform(v, fn)]));
    return value;
  }
  function encodeContracts(items, al) {
    const readable = items.map((v) => ({ ...v,
      args: Object.fromEntries(Object.entries(v.args).map(([k, value]) => [k, TIME.has(k) ? A.util.fmtT(value) : value])),
      time: v.time == null ? null : A.util.fmtT(v.time), interval: v.interval?.map(A.util.fmtT) || null }));
    return transform(readable, (s) => s.replace(/\b[A-D]-\d{2}-\d{2}\b/g, (id) => al.mapping[`{P:${id}}`] || 'SELF'));
  }
  function decodeExtraction(result, al) {
    return { observations: (result.observations || []).map((o) => ({ ...o,
      args: Object.fromEntries(o.fields.map((f) => [f.key, PERSON.has(f.key) ? f.value === 'SELF' ? al.self : al.decode(f.value).replace(/^\{P:|\}$/g, '') : normalize(f.key, f.value)])),
      qualifiers: Object.fromEntries(o.qualifiers.map((f) => [f.key, f.value])), quote: al.decode(o.quote) })),
      additions: result.additions || [] };
  }
  function formatIssues(sc, text, al, entryId, returnedId) {
    const issues = [];
    if (entryId !== returnedId) issues.push({ code: 'entry_id_error', expected: entryId, actual: returnedId });
    if (!String(text || '').trim()) issues.push({ code: 'empty_text', quote: '' });
    if (/\{P:|\b[A-D]-\d{2}-\d{2}\b/.test(String(text))) issues.push({ code: 'reference_mapping_error', quote: text, detail: '内部IDの露出' });
    const decoded = al.decode(text || '');
    if (/UNKNOWN|[<＜]\s*[PＰ]/.test(decoded) || sc.residents.some((r) => decoded.includes(r.name)))
      issues.push({ code: 'reference_mapping_error', quote: text, detail: '未知の参照または実名の露出' });
    return issues;
  }
  function compare(expected, extraction, audit, text) {
    const issues = [], used = new Set(), matched = [];
    const add = (code, field, a, b, o) => issues.push({ code, field, expected: a, actual: b, quote: o?.quote || '' });
    if (!audit || audit.uncertain) add('verification_uncertain', 'audit', false, audit?.uncertain, null);
    const observations = extraction.observations || [];
    for (const want of expected) {
      // 「pがqの直前」と「qがpの直後」は同じ隣接関係。単なる先/後のBEFOREへは拡張しない。
      const options = observations.map((o, i) => {
        const inverse = (want.predicate === 'PREVIOUS' && o.type === 'NEXT') || (want.predicate === 'NEXT' && o.type === 'PREVIOUS');
        return { o: inverse ? { ...o, type: want.predicate, args: { ...o.args, p: o.args.q, q: o.args.p } } : o, i };
      }).filter(({ o, i }) => !used.has(i) && o.type === want.predicate);
      const best = options.sort((a, b) => Object.keys(want.args).filter((k) => normalize(k, a.o.args[k]) === normalize(k, want.args[k])).length
        < Object.keys(want.args).filter((k) => normalize(k, b.o.args[k]) === normalize(k, want.args[k])).length ? 1 : -1)[0];
      if (!best) { add('missing_required_evidence', want.predicate, want.args, null, null); continue; }
      const { o, i } = best; used.add(i);
      if (!o.quote || !text.includes(o.quote)) add('verification_uncertain', 'quote', '本文に存在する引用', o.quote, o);
      const grounding = audit?.grounding?.find((g) => g.index === i);
      if (!grounding?.supported || !grounding.quote || !text.includes(grounding.quote)) add('verification_uncertain', 'grounding', true, grounding, o);
      const args = Object.fromEntries(Object.keys(want.args).map((key) => [key, o.args[key]]));
      for (const key of Object.keys(o.args)) if (!(key in want.args)) add('unauthorized_event', key, null, o.args[key], o);
      for (const [key, value] of Object.entries(want.args)) {
        const actual = o.args[key];
        if (normalize(key, value) === normalize(key, actual)) { args[key] = value; continue; }
        const equivalence = audit?.equivalences?.find((v) => v.index === i && v.field === key && v.equivalent
          && v.expected === String(value) && v.actual === String(actual) && v.quote && text.includes(v.quote));
        if (FREE.has(key) && equivalence) { args[key] = value; continue; }
        add(actual == null ? 'missing_required_evidence' : PERSON.has(key) ? key === 'q' || key === 'v' ? 'changed_object' : 'changed_subject'
          : TIME.has(key) ? 'changed_time' : ['NEXT', 'PREVIOUS', 'BEFORE'].includes(want.predicate) ? 'reversed_order' : 'changed_value', key, value, actual, o);
      }
      for (const key of ['source_kind', 'modality', 'polarity']) if (o[key] !== want[key])
        add(key === 'source_kind' ? 'changed_source' : key === 'polarity' ? 'lost_negation' : 'changed_modality', key, want[key], o[key], o);
      for (const [key, value] of Object.entries(want.qualifiers)) if (o.qualifiers?.[key] !== value)
        add(key.startsWith('no_') ? 'lost_negation' : 'missing_required_evidence', key, value, o.qualifiers?.[key], o);
      // 引用による決定的な人物・数値の支えも必要。期待値だけを返した抽出を受け入れない。
      for (const [key, value] of Object.entries(args)) {
        if (PERSON.has(key) && !o.quote.includes(`{P:${value}}`) && !(value === want.observer && /私|俺|僕|わたし|あたし|自分/.test(o.quote))) add('verification_uncertain', key, value, '引用に人物参照なし', o);
        if (NUMBER.has(key) || key === 'serial' && /^\d+$/.test(String(value))) {
          const tokens = o.quote.normalize('NFKC').match(/\d+(?:\.\d+)?|[一二三四五六七八九十百千〇零]+/g) || [];
          if (!tokens.some((v) => number(v) === number(value))) add('verification_uncertain', key, value, '引用に対応する数値なし', o);
        }
      }
      matched.push({ type: o.type, args, quote: o.quote, source_kind: o.source_kind, modality: o.modality, polarity: o.polarity });
    }
    observations.forEach((o, i) => { if (!used.has(i)) add('unauthorized_event', 'observation', null, o, o); });
    for (const item of audit?.additions || []) {
      if (!item.quote || !text.includes(item.quote)) add('verification_uncertain', 'addition_quote', true, item, null);
      else if (item.kind !== 'allowed') issues.push({ code: item.kind, quote: item.quote, detail: item.reason });
    }
    return { pass: !issues.length, issues, observations: matched, quality: audit?.quality || [] };
  }
  function receipt(sc, e, text, result) {
    return { version: VERSION, prompt: PROMPT, textHash: hash(text), contractHash: hash(required(sc, e)),
      observations: result.observations, auditPass: result.pass, quality: result.quality };
  }
  function readReceipt(sc, e, text) {
    const r = e.semantic;
    const errors = [];
    if (r.version !== VERSION || r.prompt !== PROMPT || r.textHash !== hash(text) || r.contractHash !== hash(required(sc, e)) || !r.auditPass)
      errors.push('全文の意味検証記録が本文・証拠契約・検証版と一致しない');
    if (!Array.isArray(r.observations) || r.observations.some((o) => !o.quote || !text.includes(o.quote))) errors.push('意味抽出の引用が本文にない');
    return { errors, observations: errors.length ? [] : r.observations.map((o) => ({ type: o.type, args: { ...o.args } })) };
  }
  A.Semantics = { VERSION, PROMPT, PERSON, FREE, SOURCES, QUALIFIERS, contract, attach, required, hash,
    normalize, aliases, transform, encodeContracts, decodeExtraction, formatIssues, compare, receipt, readReceipt };
})(window.ASARIYA = window.ASARIYA || {});
