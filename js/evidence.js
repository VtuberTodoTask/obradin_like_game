// v2: 本文を独立に読み戻す限定文法。rendered / writer / certainty は推論に使わない。
(function (A) {
  'use strict';
  const specs = new Map();
  const ref = (p) => `{P:${p}}`;
  const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const peopleFields = new Set(['p', 'q', 'v', 'k', 'a', 'b', 'owner']);
  const numericFields = new Set(['n', 't', 'start', 'end', 'amount', 'limit', 'days', 'value']);
  const timeFields = new Set(['t', 'start', 'end']);
  function define(type, template) {
    template = template.replace(/\[(t|start|end)\]分/g, '[$1]');
    const fields = [];
    let last = 0, pattern = '^';
    for (const m of template.matchAll(/\[([a-z]+)\]/g)) {
      pattern += escape(template.slice(last, m.index));
      const key = m[1];
      if (fields.includes(key)) pattern += `\\k<${key}>`;
      else {
        fields.push(key);
        pattern += `(?<${key}>${peopleFields.has(key) ? '\\{P:[A-D]-\\d{2}-\\d{2}\\}' : timeFields.has(key) ? 'D\\d{2} \\d{2}:\\d{2}' : numericFields.has(key) ? '\\d+' : '[^\\n]+?'})`;
      }
      last = m.index + m[0].length;
    }
    pattern += escape(template.slice(last)) + '$';
    specs.set(type, { template, fields, re: new RegExp(pattern) });
  }
  define('MARKER', '[p]の支給上着の縫い印は[mark]だった。');
  define('HOME', '[p]は[district]区画の寝室を開け、「ここが自分の部屋だ」と言った。');
  define('WORK', '当番表の担当欄は[p]。持ち場で[task]をしているところを見た。');
  define('NEXT', '入居台帳を開くと、[q]、[p]の順で受付の行が続いていた。');
  define('PREVIOUS', '入居台帳では、[q]の一つ前の受付行に[p]が載っていた。');
  define('NUMBER', '入居受付票を確かめた。[p]の入居順の欄は[n]番だった。');
  define('BEFORE', '[p]は[q]より後に入居した。入居順に並ぶ列では、[q]が前で[p]が後だった。');
  define('LAST', '[p]が最後の入居者だった。その後は誰も入居していない。');
  define('MENTOR', '[p]は[q]を「先生」と呼んでいた。以前に[lesson]を教わったという。');
  define('WORDS', '[p]は「[quote]」と言った。私には[scope]しか分からなかった。');
  define('FAULT', 'D[day]の点検票を読んだ。[device]の[defect]は未修理で、[hazard]と明記されていた。');
  define('ACK', '時刻[t]分、[p]が[device]の断線と感電の警告を読んだ。本人が署名し、警告を復唱してから遮断の解除を選んだ。');
  define('LAST_SENSE', '時刻[t]分、[p]の最後の記憶は[feeling]。');
  define('PULSE_END', '時刻[t]分、医療端末が[p]の身体の脈拍信号停止を記録した。');
  define('KEY', '[p]が[qualification]を照合して、番号[serial]の青い印の操作鍵を受け取った。鍵は複製がなく、[start]分から[end]分まで他人へ渡されていない。');
  define('SWITCH', '時刻[t]分、[device]の自動履歴に操作鍵[serial]で[operation]した記録がある。[qualification]の照合は成功し、別の操作は記録されていない。');
  define('SHOCK', '時刻[t]分、[v]が[device]に触れ、指先が焦げて全身が跳ねた。直後に脈と呼吸が止まり、蘇生しても戻らなかった。');
  define('GEAR', '[p]が番号[serial]の作業手袋を受領した。片方の青い縫い目も照合した。[start]分から[end]分まで貸し出しも交換もなかった。');
  define('PUSH', '時刻[t]分、番号[serial]の青い縫い目の手袋をした両腕が[v]の背を強く押した。私は[scope]を見た。直前にその腕の主が[qualification]を照合した。手すりも足場も壊れていなかった。');
  define('FALL', '時刻[t]分、[v]が縦坑へ落ちた。底で脈と呼吸が止まったことを確認した。足場が抜けた跡はなかった。');
  define('KIT', '[p]は番号[serial]の青い印の注射器を持って処置室へ入った。[start]分から[end]分まで人に渡さず、私の目の前で手に持ち続けていた。');
  define('INJECT', '時刻[t]分、番号[serial]の注射器から薬剤[drug]が[amount]単位、[v]の静脈に入るのを見た。投与する腕の主は[qualification]を照合していた。目盛りと腕の接続を近くで確かめた。');
  define('LIMIT', '薬剤[drug]の封入説明には、静脈投与の上限が[limit]単位で、その十倍以上では一分以内に呼吸停止するとある。');
  define('DOSE_SETTING', '時刻[t]分、[p]は薬剤[drug]の上限[limit]単位を読み上げた。それから警告を解除し、投与量を[amount]単位へ手動で増やした。数字の取り違えではなく、警告を読んで選んだ操作だった。');
  define('STOP', '時刻[t]分、[v]は処置台で呼吸と脈が止まった。蘇生しても戻らず、その身体の死亡を確認した。');
  define('ALIBI', '[p]は[start]分から[end]分まで[place]の途切れない映像に映っていた。その間に外へ出ていない。');
  define('CLAIM', '[p]は「[q]の仕業に間違いない」と言った。ただし[scope]で、手元や顔を確認した話ではなかった。');
  define('TESTIMONY', '[p]は「[quote]。確信はない」と話した。[scope]ので、後で記録と照合するつもりだ。');
  define('OFFICIAL', '[p]は管理AIに、[v]の死を[label]として登録した。診察や現場確認はせず、本人の申告だけによる登録だった。');
  define('REVISION', '[owner]の[t]分の記録は版[old]から版[new]へ変更されている。変更内容の本文は残っていない。監査用の時刻だけが保存されている。');
  define('EXPOSE', '時刻[t]、[p]は[source]で[route]。これが最初の接触で、その前には接触していない。');
  define('TEST', '時刻[t]分、[p]の[method]の測定票を読んだ。値は[value][unit]、判定欄は「[meaning]」。票の人物と測定した身体を照合した。');
  define('RATIONS', '時刻[t]分から[p]への食事の配達が止まった。倉庫の備蓄は別に残っていたが、その人の受領欄はずっと空白だった。');
  define('STARVE', '時刻[t]分、[p]は食事を受け取れないまま[days]日が経ち、ひどくやせて動けなくなった。脈と呼吸が止まり、蘇生しても戻らなかった。');
  define('TERMINAL', '時刻[t]分、[p]の[sign]が続き、脈と呼吸が止まった。処置を続けても戻らず、死亡を確認した。');
  define('COLLAPSE', '時刻[t]分、[p]が救助に入った通路で、腐食した同じ梁が一度に崩れた。瓦礫の下から身体を出したが、脈と呼吸が戻らなかった。');
  define('BODY_SENSOR', '時刻[t]分、壁面の医療端末で[p]の身体の脈と呼吸が止まった。固定カメラでも同じ身体を確認し、その後も動かず回復していない。チップの通信切断だけによる判定ではない。');
  define('SUPPLIES', '時刻[t]分、残る食料は[state]。倉庫内を数えて確認した。各人への配達量とは別の集計だ。');
  define('LIVE', '時刻[t]分、[p]の当日の映像と身体計測を確認した。身体は温かく、呼吸と脈がある。[place]で動いている。');
  define('FEATURE', '[p]の右手には[feature]がある。全員の手を検めたが、この特徴を持つのは一人だけだった。');
  define('CHIP', '[owner]の身体から摘出されたチップの製造番号は[serial]だった。[t]分にその同じ番号が別の身体で再接続された。元の身体は動いていない。');
  define('CARRIER', '時刻[t]分、製造番号[serial]のチップから届く映像の右手には[feature]がある。脈と呼吸があり、その身体は[place]で動いている。');
  define('RAID', '時刻[t]分、[v]がチップ認証を持たない外来者の刃物で刺された。直後に脈と呼吸が止まり戻らなかった。外来者は外套のまま[place]へ向かった。');
  define('HATCH', '時刻[t]分、外部ハッチが[side]から認証なしで開いた。この通路以外に出入口はなく、認証なしの開放一回につき一人だけ通過した。');
  define('PLAN', '[p]の記録に「[goal]ために[choice]を選んだ」とあった。');

  const tasks = {
    11: '診断と治療方針の決定', 12: '病床での看護と採血', 13: '薬剤の保管と払い出し',
    21: '栽培床の播種と収穫', 22: '共同厨房での調理', 23: '食料の配給と受領管理',
    31: '配電回路の測定と遮断', 32: '空調フィルターと浄水の運転', 33: '壁と足場の修繕',
    41: '居住区域の巡回警備', 42: '地上への偵察', 51: '管理AIとの方針協議', 52: '記録台帳の照合と保管',
  };
  function render(f) {
    const spec = specs.get(f.type);
    if (!spec) throw new Error(`未知の観察型 ${f.type}`);
    return spec.template.replace(/\[([a-z]+)\]/g, (_, key) => peopleFields.has(key) ? ref(f.args[key]) : timeFields.has(key) ? A.util.fmtT(f.args[key]) : String(f.args[key]));
  }
  function extract(text) {
    const out = [], errors = [];
    for (const paragraph of String(text).split('\n').filter(Boolean)) {
      let found = false;
      for (const [type, spec] of specs) {
        const match = paragraph.match(spec.re);
        if (!match) continue;
        const args = {};
        for (const key of spec.fields) {
          const value = match.groups[key];
          args[key] = peopleFields.has(key) ? value.slice(3, -1) : timeFields.has(key)
            ? A.util.tAbs(Number(value.slice(1, 3)), Number(value.slice(4, 6)) * 60 + Number(value.slice(7, 9)))
            : numericFields.has(key) ? Number(value) : value;
        }
        out.push({ type, args });
        found = true;
        break;
      }
      if (!found) errors.push(`観察の対象・数値・否定・前後関係を読み戻せない: ${paragraph.slice(0, 70)}`);
    }
    return { observations: out, errors };
  }
  const signature = (f) => `${f.type}:${JSON.stringify(Object.entries(f.args).sort(([a], [b]) => a.localeCompare(b)))}`;
  function entries(sc, known) {
    const out = [];
    sc.documents.counselor_dialogues.forEach((e, index) => out.push({ e, doc: 'dialogue', index }));
    sc.documents.hatch_log.forEach((e, index) => out.push({ e, doc: 'hatch', index }));
    for (const [owner, es] of Object.entries(sc.documents.chip_logs)) {
      if (known && !known.has(owner)) continue;
      es.forEach((e, index) => { if (!e.deleted) out.push({ e, doc: 'log', owner, index }); });
    }
    return out;
  }
  function read(sc, known) {
    const observations = [], errors = [];
    for (const item of entries(sc, known)) {
      const text = item.doc === 'dialogue' ? item.e.lines.map((l) => l.text).join('\n') : item.e.text;
      const parsed = parseEntry(sc, item.e, text);
      parsed.errors.forEach((err) => errors.push(`${item.doc}:${item.owner || ''}#${item.index}: ${err}`));
      parsed.observations.forEach((f, index) => observations.push({ ...f,
        source: `${item.doc}:${item.owner || ''}#${item.index}`, observation: index,
        loc: { doc: item.doc, owner: item.owner, index: item.index }, recordedAt: item.e.t,
      }));
    }
    return { observations, errors };
  }
  function check(sc) {
    const errors = read(sc).errors, byId = new Map(sc.facts.map((f) => [f.id, f]));
    for (const item of entries(sc)) {
      const text = item.doc === 'dialogue' ? item.e.lines.map((l) => l.text).join('\n') : item.e.text;
      const actual = parseEntry(sc, item.e, text).observations.map(signature).sort();
      const required = item.e.facts.map((id) => byId.get(id));
      if (required.some((f) => !f)) { errors.push('存在しない必須証拠への参照'); continue; }
      if (JSON.stringify(actual) !== JSON.stringify(required.map(signature).sort())) errors.push(`${item.doc}:${item.owner || ''}#${item.index}: 本文の証拠が設計と一致しない`);
      for (const f of required) {
        if (f.loc.doc !== item.doc || f.loc.owner !== item.owner || f.loc.index !== item.index) errors.push(`${f.id}: 証拠の出典が一致しない`);
      }
    }
    for (const f of sc.facts) {
      const es = f.loc.doc === 'log' ? sc.documents.chip_logs[f.loc.owner] : f.loc.doc === 'hatch' ? sc.documents.hatch_log : sc.documents.counselor_dialogues;
      if (!es || !es[f.loc.index] || !es[f.loc.index].facts.includes(f.id) || es[f.loc.index].deleted) errors.push(`${f.id}: 必須証拠が読める本文にない`);
    }
    return { errors };
  }
  function parseEntry(sc, e, text) {
    const parsed = e.semantic ? A.Semantics.readReceipt(sc, e, text) : extract(text);
    if (e.machineText) {
      const machine = extract(e.machineText);
      parsed.observations.push(...machine.observations); parsed.errors.push(...machine.errors);
    }
    return parsed;
  }
  A.Evidence = { render, extract, read, check, entries, signature, tasks, parseEntry,
    vocabulary: () => [...specs].map(([type, spec]) => ({ type, description: spec.template, fields: spec.fields })) };
})(window.ASARIYA = window.ASARIYA || {});
