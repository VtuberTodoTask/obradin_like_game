// UIと回帰テストが共用する認証・途中確定の状態遷移。
(function (A) {
  'use strict';
  function normalizeId(raw) {
    const s = String(raw).normalize('NFKC').trim().toUpperCase();
    const m = s.match(/^([A-Z])\s*[-ー−‐_ ]?\s*(\d{1,2})\s*[-ー−‐_ ]?\s*(\d{2})$/);
    return m ? `${m[1]}-${m[2].padStart(2, '0')}-${m[3]}` : null;
  }
  function authenticate(state, sc, raw) {
    if (state.over) return { kind: 'finished' };
    if (state.disconnected) return { kind: 'disconnected' };
    const id = normalizeId(raw);
    if (!id) return { kind: 'format' };
    const [district, order, job] = id.split('-');
    if (!sc.shelter.districts.includes(district) || Number(order) < 1 || Number(order) > sc.shelter.max_entry || !A.CONFIG.jobByCode[Number(job)]) return { kind: 'format', id };
    if (state.unlocked.has(id)) return { kind: 'known', id };
    const r = sc.residents.find((r) => r.id === id);
    if (r) {
      state.unlocked.add(id); state.unlockOrder.push(id);
      state.alert = Math.max(0, state.alert - A.CONFIG.alertRecoverOnSuccess);
      return { kind: 'success', id, token: r.token, mismatch: !!state.selTok && state.selTok !== r.token };
    }
    if (state.tried.includes(id)) return { kind: 'repeated', id };
    state.tried.push(id); state.alert++;
    if (state.alert >= A.CONFIG.alertMax) {
      if (sc.meta.mode === 'hard') state.over = true;
      else state.disconnected = true;
    }
    return { kind: 'rejected', id };
  }
  function reconnect(state) {
    if (!state.disconnected || state.over) return false;
    state.disconnected = false; state.alert = 0; state.reconnections++; return true;
  }
  function isCorrect(sc, state, r) {
    if (!state.unlocked.has(r.id)) return false;
    const answer = state.answers.people[r.token] || {};
    if (answer.status !== r.status) return false;
    if (r.status === 'alive') return true;
    const death = sc.deaths.find((d) => d.victim === r.id);
    if (answer.cause !== death.cause) return false;
    if (death.cause !== 'murder') return true;
    const killer = sc.residents.find((r) => r.id === death.killer);
    return state.unlocked.has(killer.id) && answer.killer === killer.token;
  }
  function confirmBatch(state, sc, count = A.CONFIG.investigation.confirmGroup) {
    if (state.over || sc.meta.mode === 'hard') return [];
    const candidates = sc.residents.filter((r) => !state.confirmed[r.token] && isCorrect(sc, state, r));
    if (candidates.length < count) return [];
    const group = candidates.slice(0, count);
    for (const r of group) state.confirmed[r.token] = { ...state.answers.people[r.token] };
    return group.map((r) => r.token);
  }
  function serialize(state) {
    return { unlockOrder: state.unlockOrder, alert: state.alert, tried: state.tried, memos: state.memos, drafts: state.drafts,
      pins: state.pins, comparison: state.comparison, confirmed: state.confirmed, disconnected: state.disconnected,
      reconnections: state.reconnections, answers: state.answers, result: state.result, over: state.over,
      termLog: state.termLog.slice(0, 30), filters: state.filters, selTok: state.selTok };
  }
  function restore(state, sc, data) {
    data = JSON.parse(JSON.stringify(data));
    for (const id of data.unlockOrder || []) if (sc.residents.some((r) => r.id === id) && !state.unlocked.has(id)) {
      state.unlocked.add(id); state.unlockOrder.push(id);
    }
    for (const key of ['alert', 'tried', 'memos', 'drafts', 'pins', 'comparison', 'confirmed', 'disconnected', 'reconnections', 'answers', 'result', 'over', 'termLog', 'filters', 'selTok'])
      if (data[key] != null) state[key] = data[key];
    // 保存済みの確定回答は別の下書きで上書きしない。
    for (const [token, answer] of Object.entries(state.confirmed)) state.answers.people[token] = { ...answer };
  }
  A.Investigation = { normalizeId, authenticate, reconnect, confirmBatch, isCorrect, serialize, restore };
})(window.ASARIYA = window.ASARIYA || {});
