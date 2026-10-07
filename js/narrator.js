// 文章化（設計書 §10）
// 試作ではブラウザ単体で動かすため、LLM の代わりにテンプレートで文章化する。
// 入力（書き手のプロフィール・場面の認識・必ず含める手がかり事実）と出力（人物トークン {P:ID} を含む文章）の
// 形は LLM 版と同じにしてあり、narrateEntry を LLM 呼び出しに差し替えられる。
// 往復検証は solver.js の verifyNarration が行う。
(function (A) {
  'use strict';
  const CFG = A.CONFIG;
  const { fmtT } = A.util;

  const I = '{I}';
  const tok = (id) => `{P:${id}}`;

  // ---------------------------------------------------------------- 語彙

  const SELF_JOB = {
    11: [`${I}は朝から診察に追われた。`, `${I}は医務室で傷の縫合をした。`],
    12: [`${I}は病人の体温を測って回った。`, `${I}は夜通し病人に付き添った。`],
    13: [`${I}は薬棚の在庫を数え直した。`, `${I}は薬品庫の鍵を確かめてから眠ることにした。`],
    21: [`${I}は水耕棚の苗の世話をした。`, `${I}は芋の収穫を手伝った。`],
    22: [`${I}は朝食のスープを仕込んだ。`, `${I}は厨房で芋の皮をむき続けた。`],
    23: [`${I}は配給帳簿をつけた。`, `${I}は倉庫の在庫表と帳簿を突き合わせた。`],
    31: [`${I}は発電機の点検をした。`, `${I}は切れた配線を継ぎ直した。`],
    32: [`${I}は浄水フィルターを交換した。`, `${I}は換気ダクトの詰まりを取った。`],
    33: [`${I}は壊れた扉の蝶番を直した。`, `${I}は配管の水漏れを塞いだ。`],
    41: [`${I}は夜の通路を見回った。`, `${I}は警棒を腰に下げて巡回した。`],
    42: [`${I}は防護服の破れを繕った。次はまた地上に出る。`, `${I}は地上で拾った缶詰を倉庫に運び込んだ。`],
    51: [`${I}は管理AIの端末に向かい、今週の方針を話し合った。`, `${I}は住人たちの相談に一日中付き合った。`],
    52: [`${I}は昨日の会議録を清書した。`, `${I}は古い記録の束を整理した。`],
  };

  // 職能ごとの典型的な作業（正本・下書き・LLM の検証で共通に使う）
  const JOB_TASKS = {
    11: '負傷者の傷を縫っていた', 12: '病人の体温を測って回っていた', 13: '薬棚の在庫を数えていた',
    21: '水耕棚の苗に水をやっていた', 22: '厨房で大鍋をかき回していた', 23: '配給帳簿をつけていた',
    31: '発電機の配線を点検していた', 32: '浄水フィルターを交換していた', 33: '壊れた扉の蝶番を直していた',
    41: '警棒を下げて通路を巡回していた', 42: '防護服を着込んで地上へ出る準備をしていた',
    51: '管理AIの端末に向かっていた', 52: '会議の内容を書き留めていた',
  };

  const DUTY = {
    11: '負傷者の診察と治療', 12: '病人の看護', 13: '薬品庫の管理', 21: '水耕棚の世話', 22: '厨房',
    23: '配給帳簿の管理', 31: '発電機と配線の保守', 32: '浄水装置と換気設備の管理', 33: '扉や配管の修繕',
    41: '通路の巡回', 42: '地上の偵察', 51: '住人の相談', 52: '会議の記録',
  };

  // 死の徴候の文（設定 CFG.signs の template から作る）
  const SIGN_TEXT = Object.fromEntries(
    Object.entries(CFG.signs).map(([k, v]) => [k, { self: v.template.self, other: (V) => v.template.other.split('{V}').join(V) }]),
  );

  const CLOSERS = {
    calm: ['今日も一日が終わった。', '悪くない日だった。', '明日も同じ一日だといい。'],
    anxiety: ['嫌な予感がする。', '何かがおかしい。', '眠れそうにない。'],
    fear: ['怖い。', '扉に鍵をかけて眠ることにする。', '手の震えが止まらない。'],
    anger: ['腹が立つ。', '誰がやったか、必ず突き止めてやる。'],
    sadness: ['胸が痛む。', 'あの声をもう聞けないのか。'],
    relief: ['少しだけ、ほっとした。'],
    despair: ['もう駄目かもしれない。', 'ここから出られる日は来ない。'],
    guilt: ['許してくれ。', 'もう後戻りはできない。'],
    resolve: ['やるしかない。', '迷っている時間はない。'],
    pain: ['痛い。'],
  };

  const CRISIS = {
    outbreak: {
      onset: (d) => [`${d}区画で熱を出した者がいるらしい。`, '医務室の前に、咳をする人の列ができていた。'],
      mid: (d) => [`また熱病の患者が出た。${d}区画は隔離されるらしい。`, '誰かが咳をするたびに、皆が距離を取る。'],
      onsetDlg: (d) => [['C', `${d}区画で発熱者が出ている。`], ['AI', '医務室の記録でも発熱の報告が増えています。感染症の可能性があります。']],
      midDlg: (d) => [['C', `${d}区画を隔離する。`], ['AI', `了解しました。${d}区画の隔壁を閉鎖します。`]],
    },
    famine: {
      onset: () => ['今日の配給は、いつもの半分だった。', '水耕棚の苗が根腐れを起こしているらしい。'],
      mid: () => ['配給がさらに減らされた。', '食料庫に鍵がかけられた。皆の目つきが変わってきた。'],
      onsetDlg: () => [['C', '水耕棚の収穫が落ちている。'], ['AI', '食料備蓄の減少速度が想定を上回っています。']],
      midDlg: () => [['C', '配給を半分にする。'], ['AI', '了解しました。配給量を変更します。']],
    },
    leak: {
      onset: () => ['浄水室の近くで線量計が鳴ったらしい。', '水の味がおかしい。金気臭い。'],
      mid: () => ['浄水系統が汚染されたと聞いた。飲み水は配給制になった。', '線量計を首から下げる者が増えた。'],
      onsetDlg: () => [['C', '浄水室で線量計が反応したと聞いた。'], ['AI', '浄水系統で放射線量の上昇を検知しています。']],
      midDlg: () => [['C', '汚染された系統の水は使わせるな。'], ['AI', '了解しました。給水系統を切り替えます。']],
    },
    strife: {
      onset: () => ['食堂で怒鳴り合いがあった。', `誰かが${I}の部屋の扉をこじ開けようとした跡がある。`],
      mid: () => ['夜間の外出が禁止された。', '通路で誰かとすれ違うたび、背中が冷たくなる。'],
      onsetDlg: () => [['C', '最近、住人同士の諍いが多い。'], ['AI', '住人間の接触記録で、衝突の兆候が増加しています。']],
      midDlg: () => [['C', '夜間の外出を禁止する。'], ['AI', '了解しました。夜間は通路の照明を落とします。']],
    },
  };

  const RELATION = {
    family: (O) => [`${O}は${I}の家族だ。ここで生きていけるのは、あの人のおかげだ。`, `${O}と夕食を食べた。家族と過ごせる時間は貴重だ。`],
    friend: (O) => [`${O}とは古い友人だ。今日も少し話した。`, `${O}が冗談を言って笑わせてくれた。`],
    lover: (O) => [`${O}と目が合った。誰にも言えない関係だけれど。`, `夜、${O}とこっそり会った。`],
    rival: (O) => [`${O}とまた言い争いになった。あいつとは反りが合わない。`, `${O}の顔を見るだけで腹が立つ。`],
    mentor: (O) => [`${O}には、生き方を教わった。今でも頭が上がらない。`, `${O}に叱られた。あの人の言うことはいつも正しい。`],
  };

  // ---------------------------------------------------------------- 主観ログ

  function makeView(ctx, writerId, entry) {
    return { ctx, rng: ctx.rng, writer: ctx.byId.get(writerId), entry, rendered: [] };
  }
  const ref = (v, id) => (v.writer && id === v.writer.id ? I : tok(id));
  const pick = (v, arr) => v.rng.pick(arr);
  const placeName = (key) => CFG.places[key] || key;
  const jobName = (code) => CFG.jobByCode[code].name;
  const catName = (c) => CFG.categories[c];

  function entryOffsetText(P, Q, k, qIsI) {
    if (k === 1) return `${P}は${Q}のすぐ後にここへ来た。`;
    if (k === -1) return `${P}は${Q}のすぐ前にここへ来た。`;
    if (k > 0) return `${P}は${Q}より${k}人後にここへ来た。`;
    return qIsI ? `${P}は${I}より${-k}人先にここへ来ていた。` : `${P}は${Q}より${-k}人先にここへ来ていた。`;
  }

  const LOG_FACT = {
    // f.mode：observe はその場で見聞きしたこと、recall は前から知っていること（物語の正本の配置に合わせる）
    DISTRICT: (g, v, f) => {
      const P = ref(v, g.p);
      if (f.mode === 'observe') return `${P}が、${g.d}区画にある自分の部屋へ戻っていった。`;
      return pick(v, [`${P}は${g.d}区画に住んでいる。`, `${P}の部屋は${g.d}区画の奥にあると聞いた。`]);
    },
    NOT_DISTRICT: (g, v) => {
      const P = ref(v, g.p);
      return pick(v, [`${P}は${g.d}区画の住人ではない。`, `${P}は、${g.d}区画には住んだことがないと言っていた。`]);
    },
    SAME_DISTRICT: (g, v, f) => {
      const P = ref(v, g.p);
      if (g.q === v.writer.id) return f.mode === 'observe' ? `隣の部屋の${P}が、夜遅くまで物音を立てていた。` : `${P}は${I}と同じ区画に住んでいる。`;
      const Q = ref(v, g.q);
      return pick(v, [`${P}と${Q}は同じ区画に住んでいる。`, `${Q}の隣の部屋に住んでいるのが${P}だ。`]);
    },
    // 職能の作業は正本（story.js）と同じ JOB_TASKS で描く（下書きと正本の食い違いを防ぐ）
    JOB: (g, v, f) => {
      const P = ref(v, g.p);
      if (f.mode === 'observe') return pick(v, [`${P}が${JOB_TASKS[g.j]}。`, `${P}が${JOB_TASKS[g.j]}のを見かけた。`]);
      return pick(v, [`前に、${P}が${JOB_TASKS[g.j]}のを見たことがある。`, `${P}といえば、${JOB_TASKS[g.j].replace(/ていた$/, 'ている')}姿しか思い浮かばない。`]);
    },
    NOT_JOB: (g, v) => {
      const P = ref(v, g.p);
      const n = jobName(g.j);
      return pick(v, [`${P}は${n}の仕事はしていない。`, `${P}に${n}のことを尋ねたら、自分の担当ではないと言われた。`]);
    },
    JOB_CATEGORY: (g, v) => {
      const P = ref(v, g.p);
      return pick(v, [`${P}は${catName(g.c)}班の一員だ。`, `${P}は${catName(g.c)}班に所属している。`]);
    },
    SAME_JOB: (g, v, f) => {
      const P = ref(v, g.p);
      if (g.q === v.writer.id) return f.mode === 'observe' ? `${P}は${I}と同じ持ち場で働いている。今日も並んで作業をした。` : `${P}と${I}は同じ仕事を受け持っている。`;
      const Q = ref(v, g.q);
      return pick(v, [`${P}と${Q}は同じ仕事をしている。`, `${P}は${Q}と同じ持ち場で働いている。`]);
    },
    ENTRY_ORDER: (g, v) => {
      const P = ref(v, g.p);
      if (g.n === 1) return `${P}は、このシェルターの最初の入居者だ。`;
      if (g.n === v.ctx.maxEntry) return `${P}は、一番最後にここへ来た入居者だ。`;
      return pick(v, [`${P}は${g.n}番目にここへ来たと言っていた。`, `${P}の入居順は${g.n}番目だ。`]);
    },
    ENTRY_OFFSET: (g, v) => entryOffsetText(ref(v, g.p), ref(v, g.q), g.k, g.q === v.writer.id),
    ENTRY_BETWEEN: (g, v) => `${ref(v, g.q)}、${ref(v, g.p)}、${ref(v, g.r)}の順に、続けてここへ来た。`,
    ENTERED_BEFORE: (g, v) => {
      const P = ref(v, g.p);
      const Q = ref(v, g.q);
      return pick(v, [`${P}は${Q}より古くからここにいる。`, `${Q}が来たとき、${P}はもうここで暮らしていた。`]);
    },
    DEATH_SIGN: (g, v) => (g.p === v.writer.id ? SIGN_TEXT[g.sign].self : SIGN_TEXT[g.sign].other(ref(v, g.p))),
    KILLED_BY: (g, v, f) => {
      const K = ref(v, g.k);
      if (g.p === v.writer.id) {
        if (g.dark) return `闇の中で「すまない」と囁いたのは、${K}の声だった。間違いない。`;
        return pick(v, [`振り返ると、${K}がいた。`, `最後に見えたのは、${K}の顔だった。`, `${K}が、${I}を見下ろしている。`]);
      }
      const V = ref(v, g.p);
      if (f.certainty === 'low') {
        return pick(v, [
          `${V}が倒れた場所から走り去った人影は、${K}だった気がする。暗くて、はっきりとは見えなかったが。`,
          `停電の闇の中、${V}のそばから${K}に似た背格好の誰かが駆けていった。たぶん${K}だ。`,
        ]);
      }
      return pick(v, [`${K}が${V}に襲いかかるのを、物陰から見てしまった。`, `${V}の倒れている場所から、${K}が慌てて離れていくのを見た。手が血に濡れていた。`]);
    },
    DEATH_CLAIM: (g, v) => {
      const C = ref(v, g.claimer);
      const V = ref(v, g.p);
      const c = CFG.causes[g.cause];
      return pick(v, [`${C}は、${V}は${c}で死んだのだと皆に説明していた。`, `${V}の死は${c}によるものだと、${C}が言っていた。`]);
    },
    STYLE_SHIFT: () => '', // 語り口（一人称・口癖）の変化そのものが手がかり

    // ---- 観察事実（改修仕様 v0.2 §4.2）。答え・文化のルールの一般論・否定は書かない
    OBS_WORK: (g, v, f) => {
      const P = ref(v, g.p);
      if (f.mode === 'observe') return pick(v, [`${P}が${JOB_TASKS[g.j]}。`, `${P}が${JOB_TASKS[g.j]}のを見かけた。`]);
      return pick(v, [`前に、${P}が${JOB_TASKS[g.j]}のを見たことがある。`, `${P}といえば、${JOB_TASKS[g.j].replace(/ていた$/, 'ている')}姿しか思い浮かばない。`]);
    },
    OBS_MARKER: (g, v, f) => {
      const m = v.ctx.culture.markers[g.marker];
      if (g.p === v.writer.id) return m.self;
      const P = ref(v, g.p);
      if (f.mode === 'observe') return m.other.split('{P}').join(P);
      if (m.kind === 'smell') return `${P}からは、いつも${m.label}がする。`;
      if (m.kind === 'speech') return `${P}の話し方には、いつも${m.label}が混じる。`;
      if (m.kind === 'habit') return `${P}は、いつも${m.label}。`;
      return `${P}といえば、あの${m.label}だ。`;
    },
    OBS_NUMBER: (g, v, f) => {
      const cu = v.ctx.culture;
      const label = CFG.culture.numberCustoms[cu.seniority.number_custom].label;
      if (g.p === v.writer.id) return `${I}の${label}は${g.n}だ。`;
      const P = ref(v, g.p);
      if (f.mode !== 'observe') return `${P}の${label}は、たしか${g.n}だった。`;
      return {
        card: `${P}の配給カードには、${g.n}と刻まれていた。`,
        locker: `${P}が、${g.n}番の私物棚に食器をしまった。`,
        room: `${P}の部屋の扉には、${g.n}の札が掛かっている。`,
      }[cu.seniority.number_custom];
    },
    OBS_AHEAD: (g, v, f) => {
      const P = ref(v, g.p);
      const Q = ref(v, g.q);
      const w = v.writer.id;
      if (g.custom === 'speaking_order') {
        if (f.mode !== 'observe') return `会合では、いつも${P}が先に口を開き、${Q}はその後だ。`;
        if (g.q === w) return `朝の会合で、${P}が話し終えるのを待ってから、${I}は口を開いた。`;
        return `朝の会合で、${P}が話し終えてから、${Q}が口を開いた。`;
      }
      if (f.mode !== 'observe') return `配給の列では、いつも${P}が${Q}より前に並ぶ。`;
      if (g.q === w) return `配給の列で、${P}の後ろに並んだ。`;
      if (g.p === w) return `配給の列で、${Q}は${I}より後ろに並んでいた。`;
      return `配給の列で、${P}が${Q}の前に並んでいた。`;
    },
    OBS_ADJACENT: (g, v) => {
      const P = ref(v, g.p);
      const Q = ref(v, g.q);
      if (g.q === v.writer.id) return `食堂では、${P}のすぐ下座が${I}の席だ。`;
      if (g.p === v.writer.id) return `食堂では、${Q}が${I}のすぐ下座に座る。`;
      return `食堂で、${Q}が${P}のすぐ下座に座っていた。`;
    },
    OBS_HONORIFIC: (g, v) => {
      const [pre, post] = g.term === 'senior' ? v.ctx.culture.seniority.honorific.senior : v.ctx.culture.seniority.honorific.junior;
      const P = ref(v, g.p);
      if (g.term === 'senior') return pick(v, [`${pre}${P}${post}に声をかけた。`, `${pre}${P}${post}に、配給のことで相談した。`]);
      return pick(v, [`${pre}${P}${post}が、遠慮がちに挨拶してきた。`, `${pre}${P}${post}に、通路の掃除を頼んだ。`]);
    },
    OBS_INGROUP: (g, v, f) => {
      const P = ref(v, g.p);
      if (f.mode !== 'observe') return `うちの区画の${P}とは、昔からの顔なじみだ。`;
      return pick(v, [`うちの区画の${P}と、少し立ち話をした。`, `うちの区画の${P}が、黙って隣に来た。`]);
    },
    OBS_OUTGROUP: (g, v, f) => {
      const P = ref(v, g.p);
      if (f.mode !== 'observe') return `${g.nickname}の${P}とは、あまり口をきかない。`;
      return pick(v, [`あの${g.nickname}の${P}が、こっちを見ていた。`, `${g.nickname}の${P}が、隅の席に陣取っていた。`]);
    },
  };

  const LOG_FLAVOR = {
    selfJob: (p, v) => pick(v, SELF_JOB[v.writer.job_code]),
    // 場面への入り方（物語の正本の場面に対応）
    visit: (p) => `${placeName(p.place)}へ${p.reason}行った。`,
    meal: (p, v) => (p.lunch ? pick(v, ['食堂で昼食をとった。', '昼、食堂で芋のスープをすすった。']) : pick(v, ['食堂で夕食をとった。', '夕食の時間、食堂はいつもより賑やかだった。'])),
    chat: (p, v) => pick(v, ['通路で立ち話をした。', '仕事の合間に、通路で少し話し込んだ。']),
    queue: (p, v) => pick(v, ['配給の列に並んだ。', '倉庫の前の配給の列に並んだ。']),
    meeting: (p, v) => pick(v, ['朝の会合に出た。', '食堂で朝の会合があった。']),
    quarters: (p) => (p.home ? `夜、${p.district}区画の自分の部屋に戻った。` : `夜、${p.district}区画に住む知り合いを訪ねた。`),
    onsetView: (p, v) => {
      if (p.crisis === 'outbreak') {
        return p.subject === v.writer.id ? '熱が出て、医務室に運び込まれた。体が言うことをきかない。' : `${ref(v, p.subject)}が高熱を出して、医務室に運び込まれた。`;
      }
      if (p.crisis === 'famine') return '水耕棚の苗が、一斉に根腐れしているのが見つかった。';
      if (p.crisis === 'leak') return '浄水室で線量計が鳴った。浄水系統が汚染されているらしい。';
      if (p.a === v.writer.id || p.b === v.writer.id) return `食堂で${ref(v, p.a === v.writer.id ? p.b : p.a)}と掴み合いの喧嘩になった。`;
      return `食堂で${ref(v, p.a)}と${ref(v, p.b)}が掴み合いの喧嘩をした。`;
    },
    assemblyView: (p, v) =>
      p.counselor === v.writer.id ? `${I}は住人を食堂に集め、${p.policy}を告げた。` : `食堂に全員が集められた。相談役の${ref(v, p.counselor)}が、${p.policy}を告げた。`,
    effectView: (p, v) => {
      if (p.crisis === 'outbreak') {
        return v.writer.district === p.district ? `${p.district}区画の隔壁が閉じられた。${I}たちは閉じ込められた。` : `${p.district}区画の隔壁が閉じられた。`;
      }
      return { famine: '配給所に、半分になった配給を受け取る列ができた。', leak: '飲み水の配給所に長い列ができた。', strife: '夜の通路の照明が落とされた。真っ暗だ。' }[p.crisis];
    },
    quarrelView: (p, v) => {
      if (p.a === v.writer.id || p.b === v.writer.id) return `${ref(v, p.a === v.writer.id ? p.b : p.a)}と${p.topic}のことで言い争いになった。`;
      return `${ref(v, p.a)}と${ref(v, p.b)}が、${p.topic}のことで言い争っていた。`;
    },
    daily: (p, v) => pick(v, ['今日も変わりのない一日だった。', '朝の点呼が終わった。', '通路の照明がまたちらついている。', '地上は今日も灰が降っているらしい。', '食堂で久しぶりに笑い声を聞いた。']),
    relation: (p, v) => pick(v, RELATION[p.type](ref(v, p.other))),
    crisisOnset: (p, v) => pick(v, CRISIS[v.ctx.crisis].onset(p.district)),
    crisisMid: (p, v) => pick(v, CRISIS[v.ctx.crisis].mid(p.district)),
    finalOpen: (p, v) => (p.dark ? `${placeName(p.place)}の灯りが急に落ちた。何も見えない。` : pick(v, [`${placeName(p.place)}にいる。`, `${placeName(p.place)}へ向かう途中だった。`])),
    finalEnd: (p, v) => {
      let s = pick(v, ['視界が暗くなっていく。', '寒い。指先から感覚が消えていく。', '誰か――', '音が遠ざかる。', `${I}は、まだ……`]);
      if (v.rng.chance(0.5)) s = `${v.writer.profile.tic}……${s}`;
      return s;
    },
    foundBody: (p, v) => pick(v, [`${placeName(p.place)}で、${tok(p.v)}が倒れているのを見つけた。もう息はなかった。`, `${tok(p.v)}が死んでいた。${placeName(p.place)}でのことだ。`]),
    sawAttack: (p) => `${placeName(p.place)}の方から物音がして、駆けつけた。`,
    darkness: (p) => `${placeName(p.place)}の灯りが落ちた。暗闇の中で、誰かが揉み合う音がした。`,
    chipRemoval: () => `鏡の前で、首の後ろにメスを当てる。ここに埋まっているものを取り出せば、${I}の記録はここで途切れる。`,
    missingBody: (p) => `${tok(p.k)}の姿がどこにもない。生体信号が途絶えたと聞いたが、遺体はどこからも見つかっていない。`,
    postShift: (p, v) => pick(v, [`${tok(p.v)}の部屋の寝台は硬い。それでも、ここで眠るしかない。`, `${tok(p.v)}の名で呼ばれるのにも、少しずつ慣れてきた。`]),
    postHide: (p, v) => pick(v, [`誰も${I}を疑っていない。`, '鏡を見るたびに、首の後ろの傷が疼く。']),
    survivorNow: (p, v) => pick(v, [`${I}はまだ生きている。${placeName(p.place)}に身を潜めて、物音に耳を澄ましている。`, `今日も誰の声もしない。${placeName(p.place)}の隅で、膝を抱えている。`]),
    aftermath: (p, v) => pick(v, ['もう何日も、誰とも話していない。', '通路に倒れたままの遺体を、片付ける気力もない。', '管理AIの端末は沈黙したままだ。']),
    intruderStill: () => '倉庫の奥から、住人のものではない足音が聞こえる。あいつはまだここにいる。',
    intruderGone: () => 'あの人影はもういない。外部ハッチの方で、重い扉の閉まる音がした。',
    noFood: () => '食料庫は空っぽだ。もう何も残っていない。',
    closer: (p, v) => {
      const prof = v.writer.profile;
      let s = pick(v, CLOSERS[v.entry.emotion] || CLOSERS.calm);
      const forceTic = v.entry.kind === 'transplanted' || v.entry.kind === 'chipRemoval';
      if (forceTic || v.rng.chance(0.7)) s += `${prof.tic}。`;
      if (prof.style === 'ellipsis') s = s.replace(/。$/, '……');
      else if (prof.style === 'exclaim') s = s.replace(/。$/, '！');
      return s;
    },
  };

  function narrateEntry(ctx, entry) {
    if (entry.deleted) {
      entry.text = '';
      entry.rendered = [];
      return;
    }
    const v = makeView(ctx, entry.writer, entry);
    const out = [];
    for (const part of entry.parts) {
      if (part.fact) {
        const f = factOf(ctx, part.fact);
        // 同じエントリで、人物以外が同じ文にならないよう、文型を選び直す
        const shape = (t) => t.replace(/\{P:[^}]+\}/g, '＠');
        let text = LOG_FACT[f.type](f.args, v, f);
        for (let k = 0; k < 4 && out.some((x) => shape(x) === shape(text)); k++) text = LOG_FACT[f.type](f.args, v, f);
        out.push(text);
        v.rendered.push(f.id);
      } else {
        out.push(LOG_FLAVOR[part.flavor](part.params, v));
      }
    }
    entry.text = out.join('').split(I).join(v.writer.profile.pronoun);
    entry.rendered = v.rendered;
  }

  // ---------------------------------------------------------------- 相談役と管理AIの会話

  const DLG_FACT = {
    DISTRICT: (g) => [['C', `${tok(g.p)}の居住区画を確認したい。`], ['AI', `${tok(g.p)}は${g.d}区画に居住しています。`]],
    NOT_DISTRICT: (g) => [['AI', `照会結果。${tok(g.p)}は${g.d}区画の居住者ではありません。`]],
    SAME_DISTRICT: (g) => [['C', `${tok(g.p)}と${tok(g.q)}は同じ区画だったか。`], ['AI', 'はい。同一区画に居住しています。']],
    JOB: (g) => [['C', `${tok(g.p)}には、引き続き${DUTY[g.j]}を任せる。`], ['AI', '了解しました。']],
    NOT_JOB: (g) => [['AI', `照会結果。${tok(g.p)}の職能は${jobName(g.j)}ではありません。`]],
    JOB_CATEGORY: (g) => [['AI', `${tok(g.p)}は${catName(g.c)}班に所属しています。`]],
    SAME_JOB: (g) => [['C', `${tok(g.p)}には、${tok(g.q)}と同じ持ち場を続けてもらう。`], ['AI', '了解しました。']],
    ENTRY_ORDER: (g) => [['AI', `記録上、${tok(g.p)}は${g.n}番目の入居者です。`]],
    ENTRY_OFFSET: (g) => [['C', entryOffsetText(tok(g.p), tok(g.q), g.k, false).replace(/。$/, 'んだったな。')], ['AI', 'はい。入居記録と一致します。']],
    ENTRY_BETWEEN: (g) => [['AI', `${tok(g.q)}、${tok(g.p)}、${tok(g.r)}は、この順に続けて入居しています。`]],
    ENTERED_BEFORE: (g) => [['C', `${tok(g.p)}は${tok(g.q)}より古株だったな。`], ['AI', 'はい。']],
    SIGNAL_LOST: (g) => [['AI', `${tok(g.p)}の生体信号が途絶しました。最終記録時刻は ${fmtT(g.t)} です。`]],
    LOG_DELETED: (g) => [['C', `${tok(g.p)}の最期の記録は消してくれ。皆を動揺させたくない。`], ['AI', `要請を受理しました。${tok(g.p)}の記録のうち、最後の${g.count}件を削除しました。`]],
    DEATH_CLAIM: (g) => [['C', `${tok(g.p)}の死因は${CFG.causes[g.cause]}だ。そう記録してくれ。`], ['AI', `了解しました。${tok(g.p)}の死因を「${CFG.causes[g.cause]}」として記録します。`]],
  };

  const DLG_FLAVOR = {
    aiBoot: (p) => [['AI', `定時報告。登録住人${p.n}名、全員の生体信号は正常です。`], ['C', '了解。今週もよろしく頼む。']],
    crisisOnsetDlg: (p, ctx) => CRISIS[ctx.crisis].onsetDlg(p.district),
    crisisMidDlg: (p, ctx) => CRISIS[ctx.crisis].midDlg(p.district),
    // 相談役の方針の決定（偏見・序列観を理由に残す）
    policyDlg: (p) => [['C', `方針を決めた。${p.policy.replace(/こと$/, '')}。${p.reason || ''}`], ['AI', '了解しました。方針として記録し、住人に通知します。']],
    supplies: (p) => [['AI', `食料備蓄は残り約${p.days}日分です。`], ['C', p.days < 15 ? '……そんなに少ないのか。' : 'わかった。']],
    suppliesOut: () => [['AI', '食料備蓄が尽きました。'], ['C', '……配給は、もうできないということか。']],
    reaction: (p, ctx) => [['C', ctx.rng.pick(['……そうか。', 'また一人、か。', '……わかった。', '記録しておいてくれ。'])]],
    counselorsGone: () => [['AI', '相談役全員の生体信号が途絶しました。以後、対話ログは記録されません。']],
  };

  function narrateDialogue(ctx, entry) {
    const lines = [];
    const rendered = [];
    for (const part of entry.parts) {
      let pairs;
      if (part.fact) {
        const f = factOf(ctx, part.fact);
        pairs = DLG_FACT[f.type](f.args);
        rendered.push(f.id);
      } else {
        pairs = DLG_FLAVOR[part.flavor](part.params, ctx);
      }
      for (const [who, text] of pairs) lines.push({ speaker: who === 'AI' ? 'AI' : entry.speaker, text });
    }
    entry.lines = lines;
    entry.rendered = rendered;
  }

  function factOf(ctx, fid) {
    if (!ctx._narrFacts || ctx._narrFacts.size !== ctx.facts.length) ctx._narrFacts = new Map(ctx.facts.map((f) => [f.id, f]));
    return ctx._narrFacts.get(fid);
  }

  function narrate(ctx) {
    for (const entries of Object.values(ctx.logs)) entries.forEach((e) => narrateEntry(ctx, e));
    ctx.dialogue.forEach((e) => narrateDialogue(ctx, e));
  }

  A.Narrator = { narrate, narrateEntry, SIGN_TEXT, JOB_TASKS };
})(window.ASARIYA = window.ASARIYA || {});
