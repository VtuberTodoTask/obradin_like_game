// 構造化抽出のスタブ。実モデルの意味抽出の信頼性を測るものではない。
function responseFor(body, options = {}, state = {}) {
  const input = JSON.parse(body.messages[1].content), name = body.response_format.json_schema.name;
  state.texts ||= new Map(); state.generated ||= 0;
  if (name === 'whole_subjective_log') {
    state.generated++;
    const contracts = input.required;
    const lines = contracts.map((c) => options.A.Evidence.render({ type: c.predicate,
      args: Object.fromEntries(Object.entries(c.args).map(([k, v]) => [k, options.A.Semantics.normalize(k, v)])) }).replace(/\{P:(<P\d+>)\}/g, '$1'));
    let text = state.generated <= (options.failFirst || 0) ? '眠い。' : lines.join('\n');
    text = text.replace('入居受付票を確かめた。', '入居の受付票に目を通した。');
    state.texts.set(text, text === '眠い。' ? [] : contracts.map((c, i) => ({ type: c.predicate,
      fields: Object.entries(c.args).map(([key, value]) => ({ key, value: String(value) })),
      qualifiers: Object.entries(c.qualifiers).map(([key, value]) => ({ key, value })),
      source_kind: c.source_kind, modality: c.modality, polarity: c.polarity, quote: lines[i] === text ? text : text.split('\n')[i] })));
    return { entry_id: input.entry_id, text };
  }
  if (name === 'log_evidence_extraction') return { observations: state.texts.get(input.text) || [], additions: [] };
  if (name === 'log_evidence_audit') return { grounding: input.extraction.observations.map((o, index) => ({ index, supported: true, quote: o.quote, reason: 'スタブの対応済み引用' })),
    equivalences: [], additions: [], quality: [], uncertain: false };
  throw new Error('Unknown test request: ' + name);
}
function stubFetch(options = {}, state = {}) {
  return async (_url, request) => ({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(responseFor(JSON.parse(request.body), options, state)) } }] }) });
}
module.exports = { responseFor, stubFetch };
