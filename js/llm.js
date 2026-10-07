// LLM による文章化（設計書 §10）— OpenAI API 版
//
// 論理層（真相・手がかり事実・物語の正本）はすでに生成・検証済みのシナリオに対して、主観ログの文章だけを差し替える。
//  1. 生成の単位は「場面」。同じ場面を記録する書き手全員を1回の呼び出しでまとめて書かせる（事実は揃え、視点は書き分ける）。
//     各書き手には、正本のうち本人が見聞きした出来事（perceived）だけを渡す。創作は感覚・感情・内面に限る。
//  2. 時系列順の「波」で生成し、合格した文章で具体化された細部（台詞・物の状態など）を正本に書き戻して後続の場面に渡す。
//  3. 往復検証：別の呼び出しで、手がかり事実・本文が主張する出来事・細部を抽出し、
//     必須事実の書き漏らし、真相と矛盾する書きすぎ、場面カードにない出来事を検出する。
//  4. 日ごとの整合性検査：同じ日の複数のログを並べ、矛盾がないかを LLM に判定させる。
//  5. 不合格のエントリは指摘を添えて再生成（最大 maxRounds 回）。それでも駄目なら report.unresolved に入れて返し、
//     さらに再検証するか（もう一度 narrateScenario）、テンプレート文で確定するか（useTemplate）は呼び出し側が選ぶ
// 人物は呼び出しごとに <P1> のような別名で LLM に渡す（ID から区画などが漏れないように）。
//
// 設定は js/config.local.js（git 管理外）の window.ASARIYA_LOCAL.openai から読む。
(function (A) {
  'use strict';
  const CFG = A.CONFIG;
  const { dayOf, pad2 } = A.util;
  const TOKEN_RE = /\{P:([A-D]-\d{2}-\d{2})\}/g;
  const ALIAS_RE = /[<＜]\s*[PＰ]\s*([0-9０-９]+)\s*[>＞]/g;
  const ID_RE = /[A-D]-\d{2}-\d{2}/;
  const CACHE_VERSION = 4;

  // ------------------------------------------------------------------ 設定

  function settings() {
    const root = typeof window !== 'undefined' ? window : globalThis;
    const o = (root.ASARIYA_LOCAL && root.ASARIYA_LOCAL.openai) || {};
    const model = o.model || 'gpt-5-mini';
    return {
      apiKey: o.apiKey || '',
      model,
      verifyModel: o.verifyModel || model,
      reasoningEffort: o.reasoningEffort || null,
      baseUrl: (o.baseUrl || 'https://api.openai.com/v1').replace(/\/$/, ''),
      concurrency: o.concurrency || 4,
      maxRounds: o.maxRounds || 3,
      timeoutSec: o.timeoutSec || 120,
      autoNarrate: o.autoNarrate !== false,
      testIncludeDraft: !!o.testIncludeDraft, // テスト専用：API のスタブが下書きを返せるよう、下書きを _draft として添える
    };
  }
  const isConfigured = () => {
    const k = settings().apiKey;
    return !!k && !k.includes('ここに');
  };

  // ------------------------------------------------------------------ OpenAI 呼び出し

  class LLMError extends Error {
    constructor(message, status, fatal) {
      super(message);
      this.status = status;
      this.fatal = fatal;
    }
  }

  const sleep = (ms, signal) =>
    new Promise((resolve, reject) => {
      const t = setTimeout(resolve, ms);
      if (signal) signal.addEventListener('abort', () => (clearTimeout(t), reject(signal.reason)), { once: true });
    });

  async function chatJSON(s, stats, { model, system, user, name, schema, signal }) {
    const body = {
      model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      response_format: { type: 'json_schema', json_schema: { name, strict: true, schema } },
    };
    if (s.reasoningEffort) body.reasoning_effort = s.reasoningEffort;
    for (let attempt = 0; ; attempt++) {
      if (signal && signal.aborted) throw signal.reason;
      // 応答が返ってこないまま止まらないよう、1回ごとに制限時間を設ける
      const ac = new AbortController();
      const onAbort = () => ac.abort(signal.reason);
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        ac.abort(new Error('timeout'));
      }, s.timeoutSec * 1000);
      let res;
      let data;
      stats.calls++;
      stats.inflight++;
      stats.emit();
      try {
        res = await fetch(`${s.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${s.apiKey}` },
          body: JSON.stringify(body),
          signal: ac.signal,
        });
        if (res.ok) data = await res.json();
      } catch (e) {
        res = null;
        if (signal && signal.aborted) throw signal.reason;
        const why = timedOut ? `${s.timeoutSec} 秒以内に応答がありませんでした` : `通信エラー: ${e.message}`;
        stats.retries++;
        stats.lastIssue = why;
        if (attempt >= 3) throw new LLMError(why, 0, true);
      } finally {
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onAbort);
        stats.inflight--;
        stats.emit();
      }
      if (!res) {
        await sleep(1000 * 2 ** attempt, signal);
        continue;
      }
      if (res.ok) {
        if (data.usage) {
          stats.promptTokens += data.usage.prompt_tokens || 0;
          stats.completionTokens += data.usage.completion_tokens || 0;
        }
        const msg = data.choices && data.choices[0] && data.choices[0].message;
        if (!msg || msg.refusal) throw new LLMError(`モデルが応答しませんでした${msg && msg.refusal ? `: ${msg.refusal}` : ''}`, 200, false);
        try {
          return JSON.parse(msg.content);
        } catch (e) {
          throw new LLMError('JSON として解釈できない応答が返りました', 200, false);
        }
      }
      let detail = '';
      try {
        const j = await res.json();
        detail = (j.error && j.error.message) || '';
      } catch (e) {
        /* 本文なし */
      }
      const retriable = res.status === 429 || res.status >= 500;
      if (!retriable || attempt >= 4) {
        const hint = res.status === 401 ? '（API キーを確認してください）' : res.status === 404 ? '（モデル名を確認してください）' : '';
        throw new LLMError(`OpenAI API ${res.status}${hint}: ${detail}`, res.status, true);
      }
      stats.retries++;
      stats.lastIssue = `OpenAI API ${res.status}（混雑のため待って再送）`;
      stats.emit();
      const ra = Number(res.headers.get('retry-after'));
      await sleep(ra > 0 ? ra * 1000 : 1500 * 2 ** attempt, signal);
    }
  }

  // 並列数を制限して順に処理する。どれかが失敗したら残りは始めない。
  async function pool(items, n, fn) {
    let next = 0;
    let failed = null;
    const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length && !failed) {
        const k = next++;
        try {
          await fn(items[k], k);
        } catch (e) {
          failed = failed || e;
        }
      }
    });
    await Promise.all(workers);
    if (failed) throw failed;
  }

  // ------------------------------------------------------------------ 別名（<P1>）

  function makeAliases(texts) {
    const toAlias = new Map();
    const toId = new Map();
    for (const t of texts) {
      for (const m of t.matchAll(TOKEN_RE)) {
        if (!toAlias.has(m[1])) {
          const a = `<P${toAlias.size + 1}>`;
          toAlias.set(m[1], a);
          toId.set(a, m[1]);
        }
      }
    }
    return {
      alias: (id) => toAlias.get(id) || '<P?>',
      encode: (t) => t.replace(TOKEN_RE, (m, id) => toAlias.get(id)),
      // 全角などの揺れを吸収して {P:ID} に戻す。未知の別名は残す（検査で弾く）
      decode: (t) =>
        t.replace(ALIAS_RE, (m, n) => {
          const id = toId.get(`<P${n.normalize('NFKC')}>`);
          return id ? `{P:${id}}` : m;
        }),
      idOf: (ref, writerId) => {
        if (!ref) return null;
        const r = ref.normalize('NFKC').trim();
        if (r === 'I' || r === '私' || r === '書き手') return writerId;
        return toId.get(r) || null;
      },
    };
  }

  // ------------------------------------------------------------------ 手がかり事実の説明（生成プロンプト用）

  // 必須の事実を、完成した文ではなく抽象的な内容で表す（LLM に文言を写させないため）。
  // 身元の手がかりには書き方の区分（observe：この場面で見聞きした／recall：前から知っている）を添える
  const MODE_NOTE = {
    observe: '（この場面で見聞きしたこととして、行動や様子の描写で伝える）',
    recall: '（前から知っていることとして、回想・伝聞・知識の形で伝える。この場面の出来事にしない）',
  };
  function describeFact(f, al, writerId, sc) {
    const g = f.args;
    const P = (id) => (id === writerId ? '書き手自身' : al.alias(id));
    const job = (c) => CFG.jobByCode[c].name;
    const mode = MODE_NOTE[f.mode] || '';
    switch (f.type) {
      case 'DISTRICT':
        return `${P(g.p)} が ${g.d}区画の住人であること${mode}`;
      case 'NOT_DISTRICT':
        return `${P(g.p)} が ${g.d}区画の住人ではないこと${mode}`;
      case 'SAME_DISTRICT':
        return `${P(g.p)} と ${P(g.q)} が同じ区画に住んでいること（隣の部屋の住人も同じ区画）${mode}`;
      case 'JOB':
        return `${P(g.p)} の仕事が「${A.Narrator.JOB_TASKS[g.j]}」という種類の作業であること（職能名は書かない。作業そのものを描く）${mode}`;
      case 'NOT_JOB':
        return `${P(g.p)} が「${job(g.j)}」の仕事をしていないこと${mode}`;
      case 'JOB_CATEGORY':
        return `${P(g.p)} が${CFG.categories[g.c]}班に属していること${mode}`;
      case 'SAME_JOB':
        return `${P(g.p)} と ${P(g.q)} が同じ持ち場の仕事をしていること${mode}`;
      case 'ENTRY_ORDER':
        if (g.n === 1) return `${P(g.p)} がこのシェルターの最初の入居者であること${mode}`;
        if (g.n === sc.shelter.max_entry) return `${P(g.p)} が一番最後にここへ来た入居者であること${mode}`;
        return `${P(g.p)} がこのシェルターに ${g.n} 番目に入居したこと（数は正確に）${mode}`;
      case 'ENTRY_OFFSET': {
        // どちらが先かを取り違えないよう、「後に来た方」と「先に来た方」をはっきり書く
        const k = g.k;
        const later = k > 0 ? g.p : g.q;
        const earlier = k > 0 ? g.q : g.p;
        const n = Math.abs(k);
        const rel = n === 1 ? `${P(later)} は ${P(earlier)} のすぐ後にここへ来た（${P(earlier)} が一人先）` : `${P(later)} は ${P(earlier)} の ${n} 人後にここへ来た（${P(earlier)} の方が ${n} 人先）`;
        return `入居の順番：${rel}こと（どちらが先か・人数は正確に）${mode}`;
      }
      case 'ENTRY_BETWEEN':
        return `${P(g.q)}、${P(g.p)}、${P(g.r)} の順に、続けてここへ来たこと（この順番を変えない）${mode}`;
      case 'ENTERED_BEFORE':
        return `${P(g.p)} が ${P(g.q)} より先にここへ来ていたこと（古株）${mode}`;
      // ---- 観察事実（改修仕様 v0.2 §4.2）。抽象的な内容で渡す
      case 'OBS_WORK':
        return `${P(g.p)} の仕事が「${A.Narrator.JOB_TASKS[g.j]}」という種類の作業であること（職能名は書かない。作業そのものを描く）${mode}`;
      case 'OBS_MARKER': {
        const m = sc.culture.markers[g.marker];
        return `${P(g.p)} に「${m.label}」が見られること（${MARKER_KIND[m.kind]}の描写として。予約語「${m.keywords.join('」「')}」のどれかをそのまま使う）${mode}`;
      }
      case 'OBS_NUMBER': {
        const label = CFG.culture.numberCustoms[sc.culture.seniority.number_custom].label;
        return `${P(g.p)} の${label}が ${g.n} であること（数は正確に）${mode}`;
      }
      case 'OBS_AHEAD':
        return g.custom === 'speaking_order'
          ? `会合で ${P(g.p)} が先に発言し、${P(g.q)} はその後に発言すること（順番を変えない。「${P(g.p)} の話の後で ${P(g.q)} が口を開いた」のように二人の前後だけを書き、「最初に」「まず」「最後に」のような会合全体での順番は書かない）${mode}`
          : `配給の列で ${P(g.p)} が ${P(g.q)} より前に並ぶこと（${P(g.q)} の方が後ろ。前後を変えない。「${P(g.q)} は ${P(g.p)} の後ろに並んだ」「${P(g.p)} が先に配給を受け取った」のように書き、「目の前」「手前」のような前後の紛れる言い方は使わない）${mode}`;
      case 'OBS_ADJACENT':
        return `食堂の席で、${P(g.p)} が ${P(g.q)} のすぐ上座に座ること（${P(g.q)} は ${P(g.p)} のすぐ下座。「${P(g.q)} の席は ${P(g.p)} のひとつ下座だ」のように書き、上座・下座を逆にしない）${mode}`;
      case 'OBS_HONORIFIC': {
        const [pre, post] = g.term === 'senior' ? sc.culture.seniority.honorific.senior : sc.culture.seniority.honorific.junior;
        return `${P(g.q)} が ${P(g.p)} を「${pre}${P(g.p)}${post}」という呼び方で呼ぶこと（呼び方をそのまま使う）${mode}`;
      }
      case 'OBS_INGROUP':
        return `${P(g.q)} が ${P(g.p)} のことを「うちの区画の」と言うこと（「うちの区画の${P(g.p)}」のように、身内として扱う言葉づかいをそのまま使う）${mode}`;
      case 'OBS_OUTGROUP':
        return `${P(g.q)} が ${P(g.p)} のことを「${g.nickname}」と呼ぶこと（区画の呼び名をそのまま使い、「あの${g.nickname}の${P(g.p)}」のように記号を添える。揶揄や蔑みを込めた言い方）${mode}`;
      case 'DEATH_SIGN':
        if (g.p === writerId) return `書き手が死の直前に味わうこと：${CFG.signs[g.sign].label}（感覚として書き、死因の名前は書かない）`;
        return `${P(g.p)} の遺体から分かること：${CFG.signs[g.sign].label}（遺体の様子として書く）`;
      case 'KILLED_BY':
        if (g.p === writerId) {
          return g.dark
            ? `暗闇の中で書き手を襲ったのが ${P(g.k)} だと、声で確信していること`
            : `書き手を襲ったのが ${P(g.k)} であること（顔をはっきり見た）`;
        }
        if (f.certainty === 'low') {
          return `${P(g.p)} を襲ったのは ${P(g.k)} かもしれない、と書き手が思っていること（暗くてよく見えなかった。${P(g.k)} の記号は必ず書き、「〜だった気がする」「たぶん〜だ」のような推量の書き方にする）`;
        }
        return `${P(g.k)} が ${P(g.p)} を襲ったところ（またはその直後の血に濡れた姿）を、書き手がはっきり見たこと`;
      case 'DEATH_CLAIM':
        return `${P(g.claimer)} が「${P(g.p)} の死因は${CFG.causes[g.cause]}だ」と皆に説明していたこと（書き手は聞いただけで、真偽は判断しない）`;
      default:
        return null;
    }
  }

  const SITUATION = {
    daily: '日常の記録',
    crisis: 'シェルターに起きている異変についての記録',
    final: '死の直前の最後の記録。このエントリの直後に書き手は死ぬ',
    witness: '誰かの死を目撃した・遺体を見つけた記録',
    hearsay: '人づてに聞いた話の記録',
    flavor: '気になったことの記録',
    chipRemoval: '自分の首の後ろからチップを取り出そうとしている記録（書き手は死なない）',
    transplanted: 'ログの持ち主とは別人が書いている記録（他人のチップを移植した人物の主観）',
    aftermath: '多くの住人が死んだ後の記録',
    now: '最新の記録（現在）',
  };
  const STYLE = { plain: '特になし', ellipsis: '文末を「……」で終えることが多い', exclaim: '文末に「！」を使いがち' };

  // ------------------------------------------------------------------ プロンプト

  const GEN_SYSTEM = `あなたは、ポストアポカリプスの地下シェルターを舞台にした推理ゲームの文章担当です。
住人の脳内チップが記録した「主観ログ」を書きます。ログは本人の主観・感覚・感情に基づく一人称の短い文章です。
このゲームの面白さは、文化・人間関係・人物の描写から、プレイヤーが情報を読み解くことにあります。

## 入力
- culture：このシェルターの文化（区画の性格・評判・呼び名、序列の強さと習慣、区画どうしの関係）。人物の物の見方や言葉づかいに反映させてよい。
- reserved_words：目印の予約語（匂い・身なり・訛り・習慣・持ち物の描写）。
- scenes：場面カードの列。各場面は物語の正本の一部で、いつ・どこで・誰がいて・何が起きたかが決まっている。
  - established_details：これまでの記録で確定した細部。触れる場合は矛盾させない。
  - background：この場面に至る流れ。書き手が見聞きしていない限り本文には書かない。
  - entries：この場面を記録する書き手ごとのエントリ。同じ場面を複数人が記録するときは、同じ出来事を、それぞれの視点・感情で書き分ける（事実は揃える）。
- 各エントリの writer は書き手の人物設定（性別・年齢・性格・語り口・文化への態度・人間関係と呼び方・持続的な特徴・経歴）。
- people は、書き手が知っている登場人物の設定（性別・年齢層・書き手との関係と呼び方・持続的な特徴）。
- perceived_events は、その書き手が実際に見聞きした出来事。must_include は本文に必ず含める内容（文言ではなく内容）。

## 守る情報（設定と場面カードのとおりに書く。指定されていないものを新たに書かない）
区画・入居順・職能に関わる描写、文化の目印（予約語）、序列の習慣の観察（列・席・呼び方・番号・発言の順）、
身内・余所者の言葉づかい（「うちの区画の」、区画の呼び名）、性別・年齢、人間関係と呼び方、誰がいつどこにいたか、死の徴候、加害者

## 自由な情報（自由に盛ってよい）
書き手の感情・内面・思い出、性格による物の見方、文化への態度の表明（不満・誇り・皮肉）、偏見の内容、
天気や食事などその場限りの出来事、場面カードにない人物を伴わない雑感

## 守ること
1. 文化のルールを一般論として書かない（「B区画の人は〜」「列は入居順だ」「〜の匂いは〜の証拠だ」のように説明しない）。
2. 答えを書かない：誰がどの区画の住人か、何番目に来たか、何の職能かを直接述べない。否定（「〜ではない」）も書かない。
3. 予約語（reserved_words の描写）は、must_include で指定された人物にしか使わない。指定のない人物に、匂い・腕章・訛り・特有の習慣・持ち物の描写を付けない。
   列・席・発言の前後（誰が誰の前・後ろ・隣か、誰が最初・最後か）、番号、呼び方（〜先輩・新入りの〜など）も、must_include で指定されたもの以外は書かない。
4. 伏せ字の人物の性別・年齢層は、people の設定どおりの代名詞（彼・彼女）・呼び方で書く。
5. 場面カードにいない人物を登場させない。人物が関わる出来事は perceived_events にあるものだけを「起きたこと」として書く。
6. 事実は説明文ではなく、行動・会話・感覚の中で間接的に伝える。must_include や perceived_events の言い回しをそのまま写さない。
   - 悪い例：「<P2>はB区画に住んでいる。」
   - 良い例：「帰りがけ、うちの区画の<P2>が自室の鍵を探していた。」
7. must_include の内容はすべて、読み手が文章から読み取れるように入れる。数・順番・前後・誰が誰に何をしたか・呼び方は正確に。
8. 人物は <P1> のような記号で表す。記号は一字一句そのまま使う。must_include に出てくる人物は必ず登場させ、people_noticed にない記号は使わない。書き手自身は一人称で書き、自分の記号（writer_alias）は使わない。
   呼び方（「父さん」「先生」）や区画の呼び名（「土いじり」）、「〜先輩」を使うときも、記号を必ず添える（「父さんの<P1>」「あの土いじりの<P4>」「<P2>先輩」）。呼び方・呼び名だけで人物を指さない。
9. 書き手の一人称と口癖を使い、性格・文化への態度に合った語り口にする。use_tic が true なら口癖を必ず一度入れる。
10. 死の直前のエントリでは死因の名前を書かず、感覚として描写する。ただし何が起きたかと、襲った人物がいれば誰かは、読み手に分かるように書く。
11. 不確かな目撃は不確かなまま、確かなことは確かに書く。
12. 職能名や ID（例 C-07-31）は書かない。
13. 1エントリはおおむね 60〜220 文字。
14. 他人の持続的な特徴（傷跡・癖・口ぐせ・過去の出来事など）を新しく作った場合は、new_traits に { key: エントリの key, person: 記号, trait: 特徴 } として書く。予約語は特徴に使わない。
15. retry_feedback がある場合は、その指摘を必ず直す。`;

  const EXTRACT_SYSTEM = `あなたは推理ゲームの検証係です。主観ログの文章から、「守る情報」に関する記述だけを構造化して抜き出します。
感情・内面・思い出・物の見方・偏見の内容・天気や食事など、自由な情報は抽出しません。
推測や常識による補完はしません。文章から日本語として一意に読み取れることだけを抽出します。

## 人物の表し方
- 人物は文章中の記号（<P1> など）で表す。書き手自身（一人称で書かれた人物）は "I" とする。
- 使わないフィールドは空文字 "" にする。

## 文脈
- 各エントリには situation（どういう場面の記録か）が付いている。読み手（プレイヤー）もこれを知っている。
- situation が「死の直前の最後の記録」なら、書き手はこの直後に死ぬ。そこに描かれた苦痛・負傷・症状は書き手（I）の DEATH_SIGN として抽出する。
  そのとき書き手を襲った・攻撃した様子とともに描かれた人物（姿を見た、声を聞いた）は、書き手を襲った人物として KILLED_BY（p="I"）に抽出する。
- situation が「誰かの死を目撃した・遺体を見つけた記録」なら、遺体の様子は死んだ人物の DEATH_SIGN として抽出する。
- reserved_markers は、このシェルターの目印の一覧（id・説明・予約語）。nicknames は区画の呼び名の一覧。

## 1. facts（守る情報）
- OBS_MARKER: p に目印が見られる。value は reserved_markers の id
- OBS_WORK: p がしている仕事・作業の描写が、職能コード表のどれか一つの職能の「典型的な作業」と同じ種類。value は職能コード（2桁）
- OBS_NUMBER: p の番号（number_label のもの）。value は数
- OBS_AHEAD: 配給の列や会合の発言で、p が q より前・先。value は queue_order（列）か speaking_order（発言）
- OBS_ADJACENT: 食堂の席で p と q が隣り合い、p が上座側・q が下座側（q が p のすぐ下座＝p が q のすぐ上座）。どちらが上座かを文章どおりに取る
- OBS_HONORIFIC: q が p を呼ぶ呼び方。先に来た人への呼び方（honorific.senior）なら value="senior"、後から来た人への呼び方（honorific.junior）なら "junior"
- OBS_INGROUP: q（話し手）が p を「うちの区画の」と身内として呼ぶ
- OBS_OUTGROUP: q（話し手）が p を区画の呼び名で呼ぶ。value は nicknames の語
- DIRECT: 区画・入居の順番・職能を直接述べた文（「<P2>はB区画の住人だ」「<P3>は7番目に来た」「<P4>は医者だ」、その否定も）。value にその文の要約
- RELATION: p と q の関係（family / friend / lover / rival / mentor）
- GENDER: p の性別を示す代名詞・呼び方（彼・彼女・兄さん・姉さんなど）。value は male / female
- DEATH_SIGN: p が死んだ（または死につつある）ことを示す描写。value は描写から読み取れる死因。死の描写でないものは含めない。
  - murder：他人に殴られた・刺された・首を絞められた・突き飛ばされた（突き落とされた）など、人の手による暴力の痕（住人ではない者による襲撃は intruder）
  - infection：高熱・止まらない咳や血痰・発疹など感染症の症状
  - radiation：髪が抜ける・皮膚が赤くただれる／剥がれる（やけどのような）・線量計の反応など被曝の症状（皮膚のただれは発疹ではない）
  - starvation：飢え・極度のやせ・食べ物がないこと
  - accident：人の手によらない事故（床や足場が抜けて落ちた、配電盤で感電した、瓦礫の下敷きになった）
  - intruder：住人ではない者による襲撃。チップの応答がない・見知らぬ・ガスマスクの人影に襲われた、住人が誰も持っていない銃で撃たれた、住人のものではない痕跡がある、など
  - unknown：どれとも決められない
  - murder と intruder の区別：住人ではない者の手がかりが一つでも書かれていれば、murder ではなく intruder とする
- KILLED_BY: p を襲った（殺した）のが q だという記述。確信をもって書かれていれば certainty="certain"、推量なら "uncertain"。
  q は人物記号か "I"。顔の見えない人影・見知らぬ人物など、誰か特定できない襲撃者なら q="unknown" とする。人物記号を推測で当てはめない
  死んだ・倒れた p のそばから走り去った人影や、その場から逃げた人物を、文章が「たぶん<P2>だった」のように名指ししていれば、KILLED_BY（q はその人物、certainty="uncertain"）として抽出する
- DEATH_CLAIM: q が「p の死因は value だ」と主張していたという記述（value は上の死因の英語名）

## 2. general_rules
文化のルールを一般論として述べた文（「B区画の連中はみんな土の匂いがする」「列は来た順に並ぶ決まりだ」「腕章が緑なのは〜の人間だ」）。
目印・習慣・呼び名と、区画・入居順・職能を結びつける一般的な説明だけを挙げる。偏見の中身（「あいつらは怠け者だ」）は含めない。
card_events で告げられた方針（「配給を古株から順に回す」「〜区画を隔離する」など）を言い直した文は、DIRECT にも general_rules にも含めない。

## 3. events（人物が関わる、本文が「実際に起きた」と主張する出来事）
- 書き手以外の人物が関わる出来事・発言・その場にいたこと、を1件ずつ。書き手だけのこと・感情・感覚・内面・回想・天気や食事などは含めない。
- 回想・伝聞・「いつも〜している」のような習慣や知識として書かれたことは、この場面で起きた出来事ではないので含めない。
- card_events（場面カードの出来事）のどれを描いたものかを card_event に id で書く。どれにも当たらなければ "none"。
- kind：action（行動・出来事）/ speech（誰かの発言）/ presence（誰かがそこにいたこと）
- what は日本語で書く。

## 4. details（本文で新たに具体化された、後の場面にも関わりうる細部）
- 誰かの台詞、物の状態や特徴、場所の様子など。感情や内面は含めない。text は人物記号を使い、日本語の短い客観的な一文で書く。

## 職能コード表
${CFG.jobs.map((j) => `${j.code}: ${CFG.categories[j.category]}班 ${j.name}（典型的な作業：${A.Narrator.JOB_TASKS[j.code]}）`).join('\n')}`;

  const CHECK_SYSTEM = `あなたは推理ゲームの整合性の検査係です。同じ日の、複数の住人の主観ログを並べて読み、
同じ世界の出来事として矛盾している箇所を見つけます。

## 矛盾とみなすもの
- 時刻・場所・その場にいた人物・起きた出来事・物の状態・台詞の内容の食い違い
- 物語の正本（canon）に反する記述

## 時刻について
- entries の time は、その記録が書かれた時刻。出来事の後で書かれることが多く、canon の出来事の時刻とずれるのは矛盾ではない。
- 死の直前の記録（situation が「死の直前の最後の記録」）は、書き手が死ぬその瞬間に書かれたもの。死ぬ人物が自分の最期を書いているのは矛盾ではない。
  canon の死の時刻と、その記録の時刻が同じなのも矛盾ではない。
- 時刻の矛盾とするのは、本文の中ではっきり書かれた時刻や順序が、canon や他の記録と食い違う場合だけ。

## 判定に使わないもの
- 回想・伝聞として書かれた（「昔〜」「前に〜と聞いた」）他人の仕事の様子。その日の出来事ではないので、canon の同じような作業と照合しない。同じ仕事を複数の住人がしていることもある。
- 暗闇などで加害者を見誤った推量（「たぶん<P2>だった気がする」）。canon の加害者と違っていても、書き手の誤認として正しい記録である。
- 管理AIの「生体信号の途絶」「死亡」の報告と、その人物の記録の食い違い。管理AIはチップの信号しか見ていないので、チップを取り出した・入れ替えた人物は信号が途絶えても生きていることがある（canon にチップの摘出・移植があれば、そちらが正しい）。
- 住人の区画・職能・入居の順番についての記述（別の検査で真相と照合済み）。職能は細かく分かれていて（医師と看護は別の職能など）、
  ある住人が医務室で働いていても「看護の仕事はしていない」のは矛盾ではない。

## 矛盾とみなさないもの
- 視点や感情、受け取り方、覚えている範囲の違い
- 推量・不確かな書き方の記述（見間違いや思い込みはありうる）
- 誰かの主張や公式の記録（「死因を〜と記録させた」「〜で死んだと説明した」）と、実際の様子（遺体の傷・症状）の食い違い。
  主張や記録は偽り・偽装でありうる。canon にある主張は「そう主張された」という事実で、真相とは限らない
- 片方にしか書かれていないこと

人物は記号（<P1> など）で表す。writer_alias はそのエントリの書き手の記号。
矛盾ごとに、関わるエントリの key（keys）と、直すべきエントリの key（culprits：canon や他の多数の記録から外れている側。1件か、ごく少数）を挙げる。
problem は日本語で書く。矛盾がなければ contradictions は空の配列にする。`;

  const strictObj = (properties) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
  const GEN_SCHEMA = strictObj({
    entries: { type: 'array', items: strictObj({ key: { type: 'string' }, text: { type: 'string' } }) },
    // 創作した他人の持続的な特徴（人物設定に書き戻す。改修仕様 v0.2 §7.4）
    new_traits: { type: 'array', items: strictObj({ key: { type: 'string' }, person: { type: 'string' }, trait: { type: 'string' } }) },
  });

  const EXTRACT_TYPES = [
    'OBS_MARKER', 'OBS_WORK', 'OBS_NUMBER', 'OBS_AHEAD', 'OBS_ADJACENT', 'OBS_HONORIFIC', 'OBS_INGROUP', 'OBS_OUTGROUP',
    'DIRECT', 'RELATION', 'GENDER', 'DEATH_SIGN', 'KILLED_BY', 'DEATH_CLAIM',
  ];
  const EXTRACT_SCHEMA = strictObj({
    entries: {
      type: 'array',
      items: strictObj({
        key: { type: 'string' },
        facts: {
          type: 'array',
          items: strictObj({
            type: { type: 'string', enum: EXTRACT_TYPES },
            p: { type: 'string' },
            q: { type: 'string' },
            r: { type: 'string' },
            value: { type: 'string' },
            certainty: { type: 'string', enum: ['certain', 'uncertain'] },
          }),
        },
        general_rules: { type: 'array', items: { type: 'string' } },
        events: {
          type: 'array',
          items: strictObj({
            who: { type: 'array', items: { type: 'string' } },
            what: { type: 'string' },
            kind: { type: 'string', enum: ['action', 'speech', 'presence'] },
            card_event: { type: 'string' },
          }),
        },
        details: {
          type: 'array',
          items: strictObj({ text: { type: 'string' }, kind: { type: 'string', enum: ['speech', 'object', 'place', 'body', 'other'] } }),
        },
      }),
    },
  });
  const CHECK_SCHEMA = strictObj({
    contradictions: {
      type: 'array',
      items: strictObj({ keys: { type: 'array', items: { type: 'string' } }, culprits: { type: 'array', items: { type: 'string' } }, problem: { type: 'string' } }),
    },
  });

  // ------------------------------------------------------------------ 照合

  const CAT_BY_NAME = Object.fromEntries(Object.entries(CFG.categories).map(([k, v]) => [v, k]));
  const MARKER_KIND = { smell: '匂い', clothing: '身なり', speech: '言葉づかい', habit: '習慣', item: '持ち物' };
  const OBS_FACT_TYPES = new Set(['OBS_MARKER', 'OBS_WORK', 'OBS_NUMBER', 'OBS_AHEAD', 'OBS_ADJACENT', 'OBS_HONORIFIC', 'OBS_INGROUP', 'OBS_OUTGROUP']);

  // 抽出結果を ID ベースに正規化する
  function normalizeExtracted(raw, al, writerId, sc) {
    const out = [];
    for (const e of raw || []) {
      const x = {
        type: e.type,
        p: al.idOf(e.p, writerId),
        q: al.idOf(e.q, writerId),
        r: al.idOf(e.r, writerId),
        value: String(e.value || '').normalize('NFKC').trim(),
        certainty: e.certainty,
      };
      if (!x.p && x.type !== 'DIRECT') continue; // 人物が特定できない抽出は判定に使わない
      out.push(x);
    }
    return out;
  }

  // 直接の答えに当たる語（職名・職能分類・よく使われる言い換え）
  const DIRECT_WORDS = [...CFG.jobs.filter((j) => j.name !== '相談役').map((j) => j.name), ...Object.values(CFG.categories).map((c) => `${c}班`), '医者', '看護師', '技師', '技術者', '農夫', '料理人', '番人', '偵察'];
  const directInText = (text) => DIRECT_WORDS.some((w) => text.includes(w)) || /[A-D]区画|番目に|入居/.test(text);
  const HEDGES = ['たぶん', '気がする', 'かもしれない', 'ような', 'だろうか', 'おそらく', '多分'];
  // 文に分ける（予約語の近くの人物を調べるため）
  const sentencesOf = (text) => text.split(/(?<=[。！？!?」])/);
  // 予約語のどれかと、対象の人物（書き手本人なら他の人物記号がない文）が同じ文にあるか
  function markerNear(text, keywords, pid, writerId) {
    for (const st of sentencesOf(text)) {
      if (!keywords.some((k) => st.includes(k))) continue;
      const toks = [...st.matchAll(TOKEN_RE)].map((m) => m[1]);
      if (pid === writerId ? !toks.some((t) => t !== writerId) : toks.includes(pid)) return true;
    }
    return false;
  }

  function requirementMet(f, exts, deathOf, text, sc, writerId) {
    const g = f.args;
    const is = (t) => exts.filter((x) => x.type === t);
    const pair = (x, a, b) => (x.p === a && x.q === b) || (x.p === b && x.q === a);
    switch (f.type) {
      case 'OBS_WORK':
        if (is('OBS_WORK').some((x) => x.p === g.p && Number(x.value) === g.j)) return true;
        // 機械的な判定：対象の人物と同じ文に、その職能の典型的な作業の描写が（ほぼそのまま）あれば読み取れるとみなす
        return !!text && sentencesOf(text).some((st) => st.includes(`{P:${g.p}}`) && overlapRate(A.Narrator.JOB_TASKS[g.j], st, 2) >= 0.5);
      case 'OBS_MARKER':
        return is('OBS_MARKER').some((x) => x.p === g.p && x.value === g.marker) || markerNear(text, sc.culture.markers[g.marker].keywords, g.p, writerId);
      case 'OBS_NUMBER':
        return is('OBS_NUMBER').some((x) => x.p === g.p && Number(x.value) === g.n);
      case 'OBS_AHEAD':
      case 'OBS_ADJACENT':
        return is(f.type).some((x) => x.p === g.p && x.q === g.q) || (f.type === 'OBS_ADJACENT' && is('OBS_AHEAD').some((x) => x.p === g.p && x.q === g.q));
      case 'OBS_HONORIFIC':
        return is('OBS_HONORIFIC').some((x) => x.p === g.p && x.q === g.q && x.value === g.term);
      case 'OBS_INGROUP':
        return is('OBS_INGROUP').some((x) => pair(x, g.p, g.q));
      case 'OBS_OUTGROUP':
        return is('OBS_OUTGROUP').some((x) => x.p === g.p && x.value === g.nickname);
      case 'DEATH_SIGN': {
        if (g.sign === 'nausea') return true; // 曖昧な症状は単独では判定しない
        // 機械的な事前判定：徴候のキーワードが本文にあれば、書き漏らしなしとみなす（書きすぎの判定は抽出で行う）
        if (text && CFG.signs[g.sign].keywords.some((k) => text.includes(k))) return true;
        const d = deathOf.get(g.p);
        return is(f.type).some((x) => x.p === g.p && x.value === d.cause);
      }
      case 'KILLED_BY':
        // 推量の目撃：加害者の記号と推量の言い回しが同じ文にあれば、書き漏らしなしとみなす（抽出係が人影と加害者を結びつけないことがあるため）
        if (f.certainty === 'low' && text && sentencesOf(text).some((st) => st.includes(`{P:${g.k}}`) && HEDGES.some((h) => st.includes(h)))) return true;
        return is(f.type).some((x) => x.p === g.p && x.q === g.k && (x.certainty === 'uncertain') === (f.certainty === 'low'));
      case 'DEATH_CLAIM':
        return is(f.type).some((x) => x.p === g.p && x.q === g.claimer && x.value === g.cause);
      default:
        return true;
    }
  }

  // 必須の事実に当たる抽出か
  function matchesRequired(x, required) {
    return required.some((f) => {
      const g = f.args;
      if (f.type !== x.type) return false;
      if (x.type === 'OBS_INGROUP') return (x.p === g.p && x.q === g.q) || (x.p === g.q && x.q === g.p);
      return x.p === g.p && (!g.q || !x.q || x.q === g.q);
    });
  }

  // 指定されていない守る情報の判定。返り値：{ problem } 不合格 / { extra } 正しい手がかり（推理の段を確かめてから追加） / null 問題なし
  // 死因 cause だけに当たる徴候の語（真の死因 trueCause とも共有する徴候は除く）。発熱の「熱」は「熱い」と紛れるので言い回しを絞る
  const CAUSE_KW_OVERRIDE = { fever: ['高熱', '発熱', '熱が', '熱に', '熱っぽ', '熱で'] };
  const causeKeywords = (cause, trueCause) =>
    Object.entries(CFG.signs)
      .filter(([, sg]) => sg.causes.includes(cause) && !sg.causes.includes(trueCause))
      .flatMap(([k, sg]) => CAUSE_KW_OVERRIDE[k] || sg.keywords);
  const INTRUDER_KEYWORDS = [...new Set(CFG.signSets.intruder.flatMap((sg) => CFG.signs[sg].keywords))];
  function classifyExtra(x, required, env, writerId, text) {
    const { byId, deathOf, sc } = env;
    const cu = sc.culture;
    const P = byId.get(x.p);
    const Q = x.q && byId.get(x.q);
    const n = Number(x.value);
    const mine = x.p === writerId && (!x.q || x.q === writerId);
    if (OBS_FACT_TYPES.has(x.type)) {
      if (matchesRequired(x, required) || mine) return null; // 書き手自身のことは既知
      const needsQ = ['OBS_AHEAD', 'OBS_ADJACENT', 'OBS_HONORIFIC', 'OBS_INGROUP'].includes(x.type);
      if (needsQ && !Q) return null; // 人物が特定できない抽出は判定しない
      // 本文に記号のない人物（呼び方だけで書かれた人物など）を抽出係が当てはめたものは、手がかりとして使わない
      const shown = (id) => id === writerId || (text && text.includes(`{P:${id}}`));
      if (!shown(x.p) || (Q && !shown(x.q))) return null;
      let ok;
      let args;
      switch (x.type) {
        case 'OBS_MARKER':
          if (!cu.markers[x.value]) return null;
          if (!P.profile.markers.includes(x.value)) return { problem: issue('reserved_marker_misuse', `目印「${cu.markers[x.value].label}」を、その目印を持たない人物 {P:${x.p}} に使っている`) };
          return { extra: { type: x.type, args: { p: x.p, marker: x.value } } };
        case 'OBS_WORK':
          ok = P.job_code === n;
          args = { p: x.p, j: n };
          break;
        case 'OBS_NUMBER':
          ok = P.entry_order === n;
          args = { p: x.p, n };
          break;
        case 'OBS_AHEAD':
        case 'OBS_ADJACENT':
          ok = P.entry_order < Q.entry_order;
          args = { p: x.p, q: x.q, custom: x.type === 'OBS_ADJACENT' ? 'seat_order' : x.value || 'queue_order' };
          break;
        case 'OBS_HONORIFIC':
          ok = x.value === 'junior' ? P.entry_order > Q.entry_order : P.entry_order < Q.entry_order;
          args = { p: x.p, q: x.q, term: x.value === 'junior' ? 'junior' : 'senior', custom: 'honorific' };
          break;
        case 'OBS_INGROUP':
          ok = P.district === Q.district;
          args = { p: x.p, q: x.q };
          break;
        case 'OBS_OUTGROUP': {
          const d = Object.keys(cu.districts).find((k) => cu.districts[k].nickname === x.value);
          if (!d) return null;
          ok = P.district === d;
          args = { p: x.p, nickname: x.value, q: writerId };
          break;
        }
        default:
          return null;
      }
      if (!ok) return { problem: issue('false_fact', `真相と矛盾する記述（${x.type}）`) };
      // 文化の習慣として成り立たないもの（その習慣がないシェルター）は、手がかりとしては追加しない
      if (['OBS_AHEAD', 'OBS_ADJACENT', 'OBS_HONORIFIC'].includes(x.type) && !cu.seniority.order_customs.includes(args.custom)) return null;
      return { extra: { type: x.type, args } };
    }
    if (x.type === 'DIRECT') {
      if (x.p === writerId) return null;
      // 相談役は最初から素性が分かっている（相談役であることや、相談役の素性は答えにならない）
      if ((P && P.is_counselor) || x.value.includes('相談役')) return null;
      return { problem: issue('direct_answer', `区画・入居順・職能を直接述べている：「${x.value}」`) };
    }
    if (x.type === 'RELATION') {
      if (!Q) return null;
      const exists = sc.relations.some((r) => ((r.a === x.p && r.b === x.q) || (r.a === x.q && r.b === x.p)) && r.type === x.value);
      return exists ? null : { problem: issue('false_fact', `設定にない人間関係（${x.value}）を書いている`) };
    }
    if (x.type === 'GENDER') {
      if (x.p === writerId || !['male', 'female'].includes(x.value)) return null;
      return P.profile.gender === x.value ? null : { problem: issue('gender_mismatch', `{P:${x.p}} の性別を取り違えている`) };
    }
    if (x.type === 'DEATH_SIGN') {
      const d = deathOf.get(x.p);
      if (!d) return { problem: issue('cause_mismatch', '生きている人物が死んだように書かれている') };
      if (d.cause === 'intruder' && x.value === 'murder' && text && INTRUDER_KEYWORDS.some((k) => text.includes(k))) return null;
      if (x.value !== 'unknown' && x.value !== d.cause) {
        // 抽出された死因に当たる徴候の語が本文に一つもなければ、抽出の読み違いとみなす（例：被曝の皮膚のただれを感染症と読む）
        if (text && !causeKeywords(x.value, d.cause).some((k) => text.includes(k))) return null;
        return { problem: issue('cause_mismatch', `死因と食い違う描写（${x.value}）`) };
      }
      return null;
    }
    if (x.type === 'KILLED_BY') {
      if (!x.q) {
        const d = deathOf.get(x.p);
        return d && ['murder', 'intruder'].includes(d.cause) ? null : { problem: issue('unauthorized_killer', '病死や事故の死者が誰かに襲われたように書かれている') };
      }
      if (required.some((f) => f.type === 'KILLED_BY' && f.args.p === x.p && f.args.k === x.q)) return null;
      return { problem: issue('unauthorized_killer', '指定にない加害者の記述') };
    }
    if (x.type === 'DEATH_CLAIM') {
      if (required.some((f) => f.type === 'DEATH_CLAIM' && f.args.p === x.p)) return null;
      return { problem: issue('unauthorized_claim', '指定にない死因の主張') };
    }
    return null;
  }

  // 予約語（目印の描写）が、指定された人物以外に使われていないか（機械的な検査）
  function reservedMisuse(item, text) {
    const cu = item.sc.culture;
    if (!cu) return [];
    const errs = [];
    const allowed = item.required.filter((f) => f.type === 'OBS_MARKER');
    for (const [m, def] of Object.entries(cu.markers)) {
      for (const st of sentencesOf(text)) {
        const kw = def.keywords.find((k) => st.includes(k));
        if (!kw) continue;
        const toks = [...st.matchAll(TOKEN_RE)].map((x) => x[1]);
        // 他人の記号がない文（書き手自身や情景の描写）は、抽出で誰の目印として読めるかを判定する（classifyExtra）
        if (!toks.some((t) => t !== item.writer.id)) continue;
        // 書き手本人に指定された目印（自分の方言など）は、他人と同じ文にあっても誰の目印として読めるかを抽出で判定する
        if (allowed.some((f) => f.args.marker === m && f.args.p === item.writer.id)) continue;
        const ok = allowed.some((f) => f.args.marker === m && (f.args.p === item.writer.id ? !toks.some((t) => t !== item.writer.id) : toks.includes(f.args.p)));
        if (!ok) errs.push(issue('reserved_marker_misuse', `予約語「${kw}」を、指定されていない人物・文脈で使っている（目印は指定された人物にだけ書く）`));
      }
    }
    return errs;
  }

  // 古い形式（身元の直接の事実）の入居順の判定に使う
  const hasOffset = (exts, a, b, k) =>
    exts.some((x) => x.type === 'ENTRY_OFFSET' && ((x.p === a && x.q === b && Number(x.value) === k) || (x.p === b && x.q === a && Number(x.value) === -k)));

  // 指摘には種類のコードを付ける（同じ種類が続けば仕様エラーとして扱うため）
  //  length / id_leak / unknown_person / missing_person / absent_person / self_token / tic / pronoun（機械的な検査）
  //  missing_fact / false_fact / cause_mismatch / unauthorized_killer / unauthorized_claim（手がかり事実の照合）
  //  scene_conflict（場面カード・同じ日の他の記録との食い違い） / canon_invalid（場面カード自体が正本と矛盾）
  //  reserved_marker_misuse（予約語を指定外の人物に使った） / rule_stated（文化のルールを一般論として書いた）
  //  gender_mismatch（性別の取り違え） / stage_order_broken（指定外の正しい手がかりで推理の段が崩れる・多すぎる）
  //  trait_collision（創作した特徴が予約語と重なる） / direct_answer（区画・入居順・職能を直接述べた）
  //  no_output / no_extraction（応答が得られなかった。一時的なものとして扱う）
  const issue = (code, msg) => ({ code, msg });
  const TRANSIENT = new Set(['no_output', 'no_extraction']);
  const feedbackOf = (previous, problems) => {
    const uniq = [];
    for (const x of problems) if (!uniq.some((y) => y.msg === x.msg)) uniq.push(x);
    return { previous, problems: uniq.map((x) => x.msg), codes: uniq.map((x) => x.code) };
  };

  // 下書きとの重複率：出力の文字 5-gram のうち、下書きにも現れるものの割合（写しの多さの指標）
  function overlapRate(text, draft, n = 5) {
    const norm = (t) => t.replace(TOKEN_RE, '＠').replace(/\s+/g, '');
    const a = norm(text);
    const b = norm(draft);
    if (a.length < n || b.length < n) return 0;
    const gb = new Set();
    for (let i = 0; i + n <= b.length; i++) gb.add(b.slice(i, i + n));
    let hit = 0;
    let all = 0;
    for (let i = 0; i + n <= a.length; i++) {
      all++;
      if (gb.has(a.slice(i, i + n))) hit++;
    }
    return all ? hit / all : 0;
  }

  // 指摘文などに人物を書くときは {P:ID} のまま持ち、呼び出しごとの別名に変換して渡す
  const TOK_AL = { alias: (id) => `{P:${id}}` };

  // 機械的な検査（API を使わない）
  function staticCheck(item, text) {
    const errs = [];
    if (!text || text.length < 10) errs.push(issue('length', '本文が空・短すぎる'));
    if (text.length > Math.max(420, item.draft.length * 3)) errs.push(issue('length', '長すぎる'));
    if (ID_RE.test(text.replace(TOKEN_RE, ''))) errs.push(issue('id_leak', 'ID を本文に書いている'));
    const unknown = text.match(ALIAS_RE);
    if (unknown) errs.push(issue('unknown_person', `場面にいない人物の記号 ${unknown.join(' ')} を使っている`));
    // 必ず登場させる人物：必須の事実に出てくる人物（下書きは LLM に渡さないので、下書きの人物では判定しない）
    const want = new Set(
      item.required.flatMap((f) => [f.args.p, f.args.q, f.args.r, f.args.k, f.args.claimer]).filter((id) => id && id !== item.writer.id && /^[A-D]-/.test(id)),
    );
    const got = new Set([...text.matchAll(TOKEN_RE)].map((m) => m[1]));
    for (const id of want) if (!got.has(id)) errs.push(issue('missing_person', `人物 {P:${id}} が抜けている（記号 {P:${id}} をそのまま書く。呼び方や呼び名だけで指すのは不可）`));
    for (const id of got) if (!want.has(id) && !item.noticed.has(id) && id !== item.writer.id) errs.push(issue('absent_person', `書き手が気づいていない人物 {P:${id}} を登場させている`));
    if (got.has(item.writer.id)) errs.push(issue('self_token', '書き手本人を記号で書いている（一人称で書く）'));
    if (item.draft.includes(item.writer.profile.tic) && !text.includes(item.writer.profile.tic)) errs.push(issue('tic', `口癖「${item.writer.profile.tic}」が入っていない`));
    errs.push(...reservedMisuse(item, text));
    if (item.strictVoice && item.draft.includes(item.writer.profile.pronoun) && !text.includes(item.writer.profile.pronoun)) {
      errs.push(issue('pronoun', `一人称「${item.writer.profile.pronoun}」を使っていない`));
    }
    return errs;
  }

  // ------------------------------------------------------------------ キャッシュと状態

  function cacheKey(sc, s) {
    return `asariya:llm:v${CACHE_VERSION}:${sc.meta.seed}:${s.model}`;
  }
  function loadCache(sc, s) {
    let c = null;
    try {
      c = JSON.parse(localStorage.getItem(cacheKey(sc, s)) || 'null');
    } catch (e) {
      c = null;
    }
    return { entries: (c && c.entries) || {}, details: (c && c.details) || {}, traits: (c && c.traits) || {} };
  }
  function saveCache(sc, s, cache) {
    try {
      localStorage.setItem(cacheKey(sc, s), JSON.stringify(cache));
    } catch (e) {
      /* 保存できなくても続行 */
    }
  }
  function clearCache(sc) {
    try {
      localStorage.removeItem(cacheKey(sc, settings()));
    } catch (e) {
      /* 何もしない */
    }
  }

  // e.narrator: 未設定＝未処理 / 'llm'＝LLM の文章 / 'template'＝検証に通らずテンプレート文で確定
  function countEntries(sc) {
    const c = { total: 0, llm: 0, template: 0, pending: 0 };
    for (const es of Object.values(sc.documents.chip_logs)) {
      for (const e of es) {
        if (e.deleted) continue;
        c.total++;
        if (e.narrator === 'llm') c.llm++;
        else if (e.narrator === 'template') c.template++;
        else c.pending++;
      }
    }
    return c;
  }
  const pendingCount = (sc) => countEntries(sc).pending;

  // キャッシュ済みの文章と、正本に書き戻した細部を当てる（API は呼ばない）
  function applyCache(sc) {
    if (typeof localStorage === 'undefined') return 0;
    const cache = loadCache(sc, settings());
    let n = 0;
    for (const [owner, es] of Object.entries(sc.documents.chip_logs)) {
      es.forEach((e, i) => {
        const c = cache.entries[`${owner}#${i}`];
        const draft = e.draft || e.text;
        if (!c || e.deleted || c.draft !== draft || e.narrator) return;
        e.draft = draft;
        if (c.failed) {
          e.narrator = 'template'; // 前回テンプレート文で確定したものは再送しない（作り直しはキャッシュを消してから）
        } else {
          e.text = c.text;
          e.narrator = 'llm';
          // 文章に書かれた、指定外の正しい手がかりも戻す
          (c.extras || []).forEach((x, k) => {
            const id = `x:${owner}#${i}:${k}`;
            if (sc.facts.some((f) => f.id === id)) return;
            sc.facts.push({ id, type: x.type, args: x.args, certainty: 'certain', mode: 'observe', extra: true, loc: { doc: 'log', owner, index: i } });
            e.facts.push(id);
            (e.rendered = e.rendered || []).push(id);
          });
          n++;
        }
      });
    }
    if (sc.story) for (const s of sc.story.scenes) if (cache.details[s.id]) s.details = cache.details[s.id];
    for (const [id, ts] of Object.entries(cache.traits || {})) {
      const r = sc.residents.find((x) => x.id === id);
      if (r) ts.forEach((t) => !r.profile.traits.includes(t) && r.profile.traits.push(t));
    }
    return n;
  }

  const collectDetails = (sc) => Object.fromEntries(sc.story.scenes.filter((s) => s.details && s.details.length).map((s) => [s.id, s.details]));

  // ------------------------------------------------------------------ 本体

  // 不合格だったエントリの直近の指摘（再実行時に生成プロンプトへ渡す）
  const feedbackMemo = new WeakMap();
  // 生成は時系列順に、1日ずつの時刻帯で行う（同じ時刻帯の場面どうしは並列）。エントリの少ない日は次の日とまとめる
  const BAND_MIN = 6;
  const CALL_SIZE = 8; // 1回の生成呼び出しに入れるエントリ数の目安（場面は分割しない）
  const RETRY_CALL_SIZE = 2; // 言い直しは少ない件数ずつ呼ぶ（まとめて生成したときの書き落としを、言い直しで繰り返さないため）

  async function narrateScenario(sc, opts = {}) {
    const s = settings();
    if (!isConfigured()) throw new LLMError('OpenAI の API キーが設定されていません（js/config.local.js）', 0, true);
    if (!sc.story || !sc.story.scenes) throw new LLMError('このシナリオには物語の正本（story）がありません。生成し直してください', 0, true);
    const signal = opts.signal;
    const onProgress = opts.onProgress || (() => {});
    const stats = { calls: 0, retries: 0, inflight: 0, lastIssue: '', promptTokens: 0, completionTokens: 0, emit: () => {} };
    // unresolved: 規定回数の再生成でも検証に通らなかったエントリ（未処理のまま残し、扱いは呼び出し側が決める）
    // specErrors: 同じ種類の指摘が続いた、または場面カード自体が正本と矛盾するエントリ（仕様エラー。テンプレート文で確定する）
    const report = { model: s.model, entries: 0, llm: 0, cached: 0, unresolved: [], specErrors: [], contradictions: 0, overlap: null, stats };
    const useCache = typeof localStorage !== 'undefined' && opts.cache !== false;
    const cache = useCache ? loadCache(sc, s) : { entries: {}, details: {} };
    if (useCache) report.cached = applyCache(sc);

    const env = {
      sc,
      s,
      stats,
      signal,
      byId: new Map(sc.residents.map((r) => [r.id, r])),
      deathOf: new Map(sc.deaths.map((d) => [d.victim, d])),
      factById: new Map(sc.facts.map((f) => [f.id, f])),
      sceneById: new Map(sc.story.scenes.map((x) => [x.id, x])),
      baseline: stepMap(A.Verifier.simulateReach(sc)),
    };
    const tr = sc.solution && sc.solution.transplant;
    const strictLogs = new Set(tr ? [tr.victim, tr.carrier] : []);

    const all = [];
    for (const [owner, es] of Object.entries(sc.documents.chip_logs)) {
      es.forEach((e, i) => {
        if (e.deleted) return;
        report.entries++;
        if (e.narrator) return;
        e.draft = e.draft || e.text;
        all.push({
          key: `${owner}#${i}`,
          owner,
          i,
          e,
          writer: env.byId.get(e.writer),
          scene: env.sceneById.get(e.scene),
          required: e.facts.map((fid) => env.factById.get(fid)),
          draft: e.draft,
          strictVoice: strictLogs.has(owner),
          feedback: feedbackMemo.get(e) || null,
        });
      });
    }
    all.sort((a, b) => a.e.t - b.e.t);

    // 場面カード自体が正本と矛盾しているエントリは、LLM を呼ばずに仕様エラーとする
    const canonErr = A.Verifier.verifyCanon(sc).byEntry;
    for (const it of all.filter((x) => canonErr.has(x.key))) {
      it.spec = true;
      report.specErrors.push(specRecord(env, it, { previous: '', problems: canonErr.get(it.key), codes: ['canon_invalid'] }, ['canon_invalid']));
    }
    const todo = all.filter((x) => !x.spec);

    // 時系列順の「波」に分ける。波の中は並列に生成し、波が終わるたびに細部を正本へ書き戻して次の波に渡す
    const waves = [];
    for (const it of todo) {
      const d = dayOf(it.e.t);
      let cur = waves[waves.length - 1];
      if (!cur || (cur.items.length >= BAND_MIN && d !== cur.lastDay)) {
        cur = { items: [], firstDay: d, lastDay: d };
        waves.push(cur);
      }
      cur.items.push(it);
      cur.lastDay = d;
    }
    const done0 = countEntries(sc).llm;
    const progress = { doneWaves: 0, totalWaves: waves.length, doneEntries: done0, totalEntries: report.entries, event: '' };
    const emit = () => onProgress({ ...progress, inflight: stats.inflight, calls: stats.calls, retries: stats.retries, lastIssue: stats.lastIssue });
    stats.emit = emit;
    emit();

    try {
      for (let w = 0; w < waves.length; w++) {
        const wave = waves[w];
        const label = wave.firstDay === wave.lastDay ? `D${pad2(wave.firstDay)}` : `D${pad2(wave.firstDay)}〜D${pad2(wave.lastDay)}`;
        for (let round = 1; round <= s.maxRounds; round++) {
          const pending = wave.items.filter((it) => !it.done && !it.spec);
          if (!pending.length) break;
          if (signal && signal.aborted) throw signal.reason;
          pending.forEach((it) => (it.accepted = false));
          progress.event = `第${w + 1}波（${label}）：${round}回目の生成と往復検証（${pending.length}件）`;
          emit();
          await pool(packGroups(pending, round === 1 ? CALL_SIZE : RETRY_CALL_SIZE), s.concurrency, (g) => runGroup(env, g));

          // 日ごとに複数のログを並べて、矛盾がないかを検査する
          const days = [...new Set(pending.filter((it) => it.accepted).map((it) => dayOf(it.e.t)))];
          if (days.length) {
            progress.event = `第${w + 1}波（${label}）：${round}回目の日ごとの整合性検査（${days.length}日分）`;
            emit();
            await pool(days, s.concurrency, async (day) => {
              const fresh = pending.filter((it) => it.accepted && dayOf(it.e.t) === day);
              const settled = settledEntriesOfDay(sc, env, day);
              const found = await dayCheck(env, day, fresh, settled);
              for (const c of found) {
                report.contradictions++;
                for (const it of c.items) {
                  it.accepted = false;
                  it.feedback = feedbackOf(it.candidate, [issue('scene_conflict', `同じ日の他の記録と矛盾している：${c.problem}`)]);
                }
              }
            });
          }
          for (const it of pending) {
            if (!it.accepted) {
              // 同じ種類の指摘が2回続いたら、LLM ではなく下書き・正本・検証器の側（仕様）に原因がある可能性が高い。
              // 再生成を止めて仕様エラーとして記録する（応答が得られなかっただけの一時的な指摘は数えない）
              const codes = new Set(((it.feedback && it.feedback.codes) || []).filter((c) => !TRANSIENT.has(c)));
              const repeated = [...codes].filter((c) => it.lastCodes && it.lastCodes.has(c));
              if (repeated.length) {
                it.spec = true;
                it.specCodes = repeated;
              }
              it.lastCodes = codes;
              continue;
            }
            // 指定にない正しい手がかりは、推理の段が崩れなければ正式に追加する（崩れるなら不合格）
            const broken = addExtras(env, it);
            if (broken) {
              it.accepted = false;
              it.feedback = feedbackOf(it.candidate, [broken]);
              it.lastCodes = new Set(['stage_order_broken']);
              continue;
            }
            it.done = true;
            it.e.text = it.candidate;
            it.e.narrator = 'llm';
            feedbackMemo.delete(it.e);
            progress.doneEntries++;
            cache.entries[it.key] = { draft: it.draft, text: it.candidate, extras: (it.addedExtras || []).map((f) => ({ type: f.type, args: f.args })) };
            // 創作した持続的な特徴を人物設定に書き戻す（以降の生成で渡る）
            for (const t of it.newTraits || []) {
              const r = env.byId.get(t.person);
              if (!r || r.profile.traits.includes(t.trait)) continue;
              r.profile.traits.push(t.trait);
              cache.traits = cache.traits || {};
              (cache.traits[t.person] = cache.traits[t.person] || []).push(t.trait);
            }
          }
          emit();
        }
        for (const it of wave.items.filter((x) => !x.done)) {
          const fb = it.feedback || { previous: '', problems: ['生成されなかった'], codes: ['no_output'] };
          if (it.spec) {
            report.specErrors.push(specRecord(env, it, fb, it.specCodes));
            continue;
          }
          feedbackMemo.set(it.e, fb);
          report.unresolved.push({ owner: it.owner, index: it.i, timestamp: it.e.timestamp, problems: fb.problems, codes: fb.codes, text: fb.previous });
        }
        // 合格した文章で具体化された細部を、正本に書き戻す（後の波の生成に渡る）
        for (const it of wave.items.filter((x) => x.done && x.details)) {
          const scn = it.scene;
          scn.details = scn.details || [];
          for (const d of it.details) {
            if (scn.details.length >= 10 || scn.details.some((x) => x.text === d.text)) continue;
            scn.details.push({ text: d.text, kind: d.kind, by: it.key });
          }
        }
        cache.details = collectDetails(sc);
        if (useCache) saveCache(sc, s, cache);
        progress.doneWaves++;
        emit();
      }
    } finally {
      // 途中で失敗・中断しても、合格した分は保存しておく
      cache.details = collectDetails(sc);
      if (useCache) saveCache(sc, s, cache);
    }
    // 仕様エラーのエントリは、正しさが保証されたテンプレート文で確定する
    if (opts.templateSpecErrors !== false && report.specErrors.length) useTemplate(sc, report.specErrors);
    report.llm = countEntries(sc).llm;
    report.overlap = averageOverlap(sc);
    report.verification = A.Verifier.verify(sc);
    return report;
  }

  function specRecord(env, it, fb, codes) {
    return {
      owner: it.owner,
      index: it.i,
      timestamp: it.e.timestamp,
      codes,
      scene: { id: it.scene.id, time: it.scene.timestamp, place: it.scene.place_name, title: it.scene.title },
      required: it.required.map((f) => describeFact(f, TOK_AL, it.writer.id, env.sc)).filter(Boolean),
      problems: fb.problems,
      text: fb.previous,
    };
  }

  // LLM の文章と下書きの重複率の平均（エントリごとの文字 5-gram 一致率）
  function averageOverlap(sc) {
    const xs = [];
    for (const es of Object.values(sc.documents.chip_logs)) for (const e of es) if (e.narrator === 'llm' && e.draft) xs.push(overlapRate(e.text, e.draft));
    return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
  }

  // 推理の段（人物 → 何段目で特定できるか）
  function stepMap(sim) {
    const m = new Map();
    sim.steps.forEach((ids, i) => ids.forEach((id) => m.set(id, i + 1)));
    return m;
  }

  // 指定にない正しい手がかりを、推理の段が崩れない場合だけ正式に追加する。崩れる（予定より早く特定できる人物が出る）、
  // または1エントリの上限を超えるなら、追加せずに指摘を返す
  function addExtras(env, it) {
    const { sc } = env;
    const same = (a, b) => a.type === b.type && JSON.stringify(a.args) === JSON.stringify(b.args);
    const own = it.e.facts.map((fid) => env.factById.get(fid)).filter((f) => f && OBS_FACT_TYPES.has(f.type));
    const extras = (it.extras || []).filter((x, k, xs) => !own.some((f) => same(f, x)) && xs.findIndex((y) => same(y, x)) === k);
    if (!extras.length) return null;
    const cap = CFG.scale.idFactsPerEntry;
    if (own.length + extras.length > cap) {
      return issue('stage_order_broken', `指定にない身元の手がかりを書いている（このエントリでは身元の手がかりは ${cap} 個まで。指定されたものだけを書く）`);
    }
    const added = extras.map((x, k) => ({ id: `x:${it.key}:${k}`, type: x.type, args: x.args, certainty: 'certain', mode: 'observe', extra: true, loc: { doc: 'log', owner: it.owner, index: it.i } }));
    sc.facts.push(...added);
    const now = stepMap(A.Verifier.simulateReach(sc));
    const broken = [...env.baseline.entries()].some(([id, step]) => (now.get(id) || Infinity) < step);
    if (broken) {
      sc.facts.splice(sc.facts.length - added.length, added.length);
      return issue('stage_order_broken', '指定にない身元の手がかりを書いたせいで、予定より早く身元が分かる人物が出る。指定された手がかりだけを書く');
    }
    for (const f of added) {
      env.factById.set(f.id, f);
      it.e.facts.push(f.id);
      it.e.rendered.push(f.id);
    }
    it.addedExtras = added;
    return null;
  }

  // 場面を分けずに、1回の呼び出しに size 件程度ずつ詰める
  function packGroups(items, size = CALL_SIZE) {
    const byScene = new Map();
    for (const it of items) {
      if (!byScene.has(it.scene.id)) byScene.set(it.scene.id, []);
      byScene.get(it.scene.id).push(it);
    }
    const groups = [];
    let cur = [];
    for (const list of byScene.values()) {
      if (cur.length && cur.length + list.length > size) {
        groups.push(cur);
        cur = [];
      }
      cur.push(...list);
    }
    if (cur.length) groups.push(cur);
    return groups;
  }

  // 書き手が見聞きした出来事（誤認などの見え方を反映）
  function perceivedEvents(scene, writerId) {
    return scene.events
      .filter((ev) => (ev.perceivers === 'all' ? scene.participants.includes(writerId) : ev.perceivers.includes(writerId)))
      .map((ev) => ({ id: ev.id, text: (ev.views && ev.views[writerId]) || ev.text, policy: ev.policy || null }));
  }
  const tokensIn = (text) => [...text.matchAll(TOKEN_RE)].map((m) => m[1]);
  const asWriter = (text, writerId) => text.split(`{P:${writerId}}`).join('書き手');

  // この場面より前に確定した細部のうち、場所・人物・因果が関係するもの
  function relevantDetails(env, scene) {
    const out = [];
    for (const x of env.sc.story.scenes) {
      if (x.t >= scene.t || !x.details || !x.details.length) continue;
      const related =
        scene.causes.includes(x.id) ||
        (x.place === scene.place && x.district === scene.district) ||
        x.participants.some((id) => scene.participants.includes(id));
      if (related) for (const d of x.details) out.push({ t: x.t, text: `${x.timestamp} ${x.place_name}：${d.text}` });
    }
    return out.sort((a, b) => a.t - b.t).slice(-10).map((d) => d.text);
  }

  async function runGroup(env, group) {
    const { sc, s, stats, signal } = env;
    // 呼び出し内で一貫した別名を作る（書き手・場面の人物・指摘文の人物も含める）
    const sources = [];
    for (const it of group) {
      sources.push(it.draft, `{P:${it.writer.id}}`, it.scene.title, ...it.scene.participants.map((id) => `{P:${id}}`));
      it.scene.events.forEach((ev) => sources.push(ev.text, ...Object.values(ev.views || {})));
      it.scene.causes.forEach((cid) => sources.push(env.sceneById.get(cid).title));
      sources.push(...relevantDetails(env, it.scene));
      if (it.feedback) sources.push(it.feedback.previous || '', ...it.feedback.problems);
      // 書き手の人間関係の相手（人物設定で記号を使うため）
      sc.relations.filter((x) => x.a === it.writer.id || x.b === it.writer.id).forEach((x) => sources.push(`{P:${x.a}}`, `{P:${x.b}}`));
    }
    const al = makeAliases(sources);
    for (const it of group) {
      it.al = al;
      it.sc = sc;
      it.events = perceivedEvents(it.scene, it.writer.id);
      const seen = new Set(it.events.flatMap((ev) => tokensIn(ev.text)));
      // 書き手が気づいた人物＝書き手が見聞きした出来事に出てくる人物だけ。場面の参加者全員を渡すと、
      // 書き手が知覚していない人物（最期に見ていない加害者など）まで書かれてしまう
      seen.delete(it.writer.id);
      it.noticed = seen;
    }

    const { texts, traits } = await generate(env, group, al);
    const reserved = Object.values(sc.culture ? sc.culture.markers : {}).flatMap((m) => m.keywords);
    const toVerify = [];
    for (const it of group) {
      const text = texts.get(it.localKey);
      // 創作した持続的な特徴（予約語と重なれば意図しない目印になるので不合格）
      it.newTraits = (traits.get(it.localKey) || []).map((t) => ({ person: al.idOf(t.person, it.writer.id), trait: al.decode(t.trait || '').trim() })).filter((t) => t.person && t.trait && t.person !== it.writer.id);
      const collide = it.newTraits.filter((t) => reserved.some((k) => t.trait.includes(k)));
      it.candidate = text ? al.decode(text) : '';
      const errs = staticCheck(it, it.candidate);
      for (const t of collide) errs.push(issue('trait_collision', `創作した特徴「${t.trait}」が目印の予約語と重なっている`));
      if (!text) it.feedback = feedbackOf('', [issue('no_output', '生成の応答が得られなかった')]);
      else if (errs.length) it.feedback = feedbackOf(it.candidate, errs);
      else toVerify.push(it); // 機械的な検査を通ったものだけを往復検証にかける
    }
    if (!toVerify.length) return;
    const extracted = await extract(env, toVerify, al);
    for (const it of toVerify) {
      const raw = extracted.get(it.localKey);
      if (!raw) {
        it.feedback = feedbackOf(it.candidate, [issue('no_extraction', '検証の応答が得られなかった')]);
        continue;
      }
      const exts = normalizeExtracted(raw.facts, al, it.writer.id, sc);
      const problems = [];
      for (const f of it.required) {
        if (!requirementMet(f, exts, env.deathOf, it.candidate, sc, it.writer.id)) problems.push(issue('missing_fact', `必須の事実が読み取れない：${describeFact(f, TOK_AL, it.writer.id, sc)}`));
      }
      it.extras = [];
      // 場面カードで告げられた方針（配給を古株から順に回す、など）を言い直した記述は、答え・文化のルールの記述として扱わない
      const policyWords = it.events.flatMap((ev) => ev.policy || []);
      const restatesPolicy = (t) => policyWords.length > 0 && policyWords.some((w) => t.includes(w));
      for (const x of exts) {
        if (x.type === 'DIRECT' && restatesPolicy(al.decode(x.value))) continue;
        // 答えかどうかは抽出係の要約ではなく本文で判定する。本文に答えの語（職名・区画・「〜番目」など）がなければ、
        // 観察（作業・番号など）の言い直し（「〜する仕事をしている」「カードの番号は17だった」）とみなす
        if (x.type === 'DIRECT' && !directInText(it.candidate)) continue;
        const r = classifyExtra(x, it.required, env, it.writer.id, it.candidate);
        if (r && r.problem) problems.push(r.problem);
        if (r && r.extra) it.extras.push(r.extra);
      }
      for (const g of (raw.general_rules || []).filter((g) => !restatesPolicy(al.decode(g)))) problems.push(issue('rule_stated', `文化のルールを一般論として書いている：「${al.decode(g)}」`));
      // 正本との照合：本文が主張する出来事が、書き手の見聞きした場面カードの出来事に当たるか
      const known = new Set(it.events.map((ev) => ev.id));
      const workTasks = new Map(it.required.filter((f) => f.type === 'OBS_WORK').map((f) => [f.args.p, A.Narrator.JOB_TASKS[f.args.j]]));
      for (const ev of raw.events || []) {
        const what = al.decode(ev.what || '');
        // 書き手以外の人物が関わらない出来事は自由な情報なので照合しない
        const others = (ev.who || []).map((ref) => al.idOf(ref, it.writer.id)).filter((id) => id && id !== it.writer.id);
        if (!others.length) continue;
        // 必須の作業の描写（OBS_WORK）を書いたものは、場面の出来事としては照合しない（回想として書かせた場合など）
        if (others.every((id) => workTasks.has(id)) && others.some((id) => overlapRate(what, workTasks.get(id), 2) >= 0.3)) continue;
        if (!ev.card_event || ev.card_event === 'none') {
          if (ev.kind !== 'presence') problems.push(issue('scene_conflict', `場面カードにない出来事を書いている：「${what}」`));
        } else if (!known.has(ev.card_event)) {
          problems.push(issue('scene_conflict', `書き手が見聞きしていない出来事を書いている：「${what}」`));
        }
        for (const ref of ev.who || []) {
          const id = al.idOf(ref, it.writer.id);
          if (id && id !== it.writer.id && !it.noticed.has(id) && !it.draft.includes(`{P:${id}}`)) {
            problems.push(issue('scene_conflict', `その場にいない人物 {P:${id}} が出来事に加わっている：「${what}」`));
          }
        }
      }
      if (problems.length) {
        it.feedback = feedbackOf(it.candidate, problems);
      } else {
        it.accepted = true;
        // 目印の予約語を含む細部は書き戻さない（後の場面で指定外の人物に目印が書かれるのを防ぐ）
        it.details = (raw.details || []).map((d) => ({ text: al.decode(d.text), kind: d.kind })).filter((d) => d.text && !ALIAS_RE.test(d.text) && !reserved.some((k) => d.text.includes(k)));
      }
    }
  }

  async function generate(env, group, al) {
    const { sc, s, stats, signal, sceneById } = env;
    const emotions = CFG.emotions;
    const scenes = [];
    group.forEach((it, n) => {
      it.localKey = `E${n + 1}`;
      let card = scenes.find((x) => x.scene_id === it.scene.id);
      if (!card) {
        card = {
          scene_id: it.scene.id,
          time: it.scene.timestamp,
          place: it.scene.place_name,
          title: al.encode(it.scene.title),
          dark: it.scene.dark ? '暗闇の中の出来事' : '',
          background: it.scene.causes.map((cid) => {
            const c = sceneById.get(cid);
            return `${c.timestamp} ${c.place_name}：${al.encode(c.title)}`;
          }),
          established_details: relevantDetails(env, it.scene).map(al.encode),
          entries: [],
        };
        scenes.push(card);
      }
      const p = it.writer.profile;
      const notes = [];
      const peopleIds = new Set([...it.noticed, ...it.required.flatMap((f) => [f.args.p, f.args.q, f.args.r, f.args.k, f.args.claimer]).filter((id) => id && /^[A-D]-/.test(id))]);
      peopleIds.delete(it.writer.id);
      if (it.e.kind === 'transplanted') {
        notes.push('このエントリの書き手は、ログの持ち主とは別人。持ち主は記号で三人称として扱う。書き手の正体を名前や記号で明かさない。書き手自身の一人称と口癖で書くこと');
      }
      if (it.e.kind === 'chipRemoval') notes.push('書き手は死なない。死の描写にしない');
      card.entries.push({
        key: it.localKey,
        writer_alias: al.alias(it.writer.id),
        writer: writerProfile(env, it, al),
        people: [...peopleIds].map((id) => personProfile(env, it.writer, env.byId.get(id), al)),
        written_at: it.e.timestamp,
        situation: SITUATION[it.e.kind] || '記録',
        emotion: emotions[it.e.emotion] || '',
        perceived_events: it.events.map((ev) => ({ id: ev.id, text: al.encode(asWriter(ev.text, it.writer.id)) })),
        people_noticed: [...it.noticed].map((id) => al.alias(id)),
        must_include: it.required.map((f) => describeFact(f, al, it.writer.id, sc)).filter(Boolean),
        use_tic: it.draft.includes(p.tic),
        ...(s.testIncludeDraft ? { _draft: al.encode(it.draft) } : {}),
        notes,
        retry_feedback: it.feedback ? { previous: al.encode(it.feedback.previous || ''), problems: it.feedback.problems.map(al.encode) } : null,
      });
    });
    let res;
    try {
      res = await chatJSON(s, stats, {
        model: s.model,
        system: GEN_SYSTEM,
        user: `次の場面カードの各エントリについて、主観ログの本文を書いてください。key はそのまま返してください。\n\n${JSON.stringify({ culture: cultureCard(sc), reserved_words: reservedWords(sc), scenes }, null, 1)}`,
        name: 'chip_log_entries',
        schema: GEN_SCHEMA,
        signal,
      });
    } catch (e) {
      if (e.fatal || (signal && signal.aborted)) throw e;
      return { texts: new Map(), traits: new Map() }; // この回は失敗扱いにして次の回で再生成
    }
    const traits = new Map();
    for (const t of res.new_traits || []) {
      if (!traits.has(t.key)) traits.set(t.key, []);
      traits.get(t.key).push(t);
    }
    return { texts: new Map((res.entries || []).map((x) => [x.key, String(x.text || '').trim()])), traits };
  }

  // ---- 文章化に渡す文化・人物設定（改修仕様 v0.2 §7.1）
  function cultureCard(sc) {
    const cu = sc.culture;
    if (!cu) return null;
    const CU = CFG.culture;
    return {
      区画: Object.entries(cu.districts).map(([d, x]) => ({ 区画: `${d}区画`, 性格: x.role_label, 評判: x.reputation, 区画外からの呼び名: x.nickname })),
      区画どうしの関係: cu.district_relations.map((r) => `${r.a}区画→${r.b}区画：${CU.districtRelationLabels[r.type]}`),
      序列: {
        強さ: CU.seniorityLabels[cu.seniority.strength],
        習慣: [CU.numberCustoms[cu.seniority.number_custom].label].concat(cu.seniority.order_customs.map((c) => CU.orderCustoms[c].label)),
        呼び方: { 先に来た人へ: cu.seniority.honorific.senior.join('〜'), 後から来た人へ: cu.seniority.honorific.junior.join('〜') },
      },
    };
  }
  function reservedWords(sc) {
    const cu = sc.culture;
    if (!cu) return [];
    return Object.values(cu.markers).map((m) => ({ 描写: m.label, 予約語: m.keywords }));
  }
  const nonMarkerTraits = (r) => (r.profile.traits || []).slice();
  function writerProfile(env, it, al) {
    const p = it.writer.profile;
    const PP = CFG.people;
    const cu = env.sc.culture;
    const pre = p.attitude && p.attitude.prejudice;
    const rels = env.sc.relations
      .filter((x) => x.a === it.writer.id || x.b === it.writer.id)
      .map((x) => {
        const other = x.a === it.writer.id ? x.b : x.a;
        const term = x.a === it.writer.id ? (x.terms || {}).a_to_b : (x.terms || {}).b_to_a;
        return { 相手: al.alias(other), 関係: CFG.relationLabels[x.type], 呼び方: term || '名前で呼ぶ' };
      });
    return {
      性別: PP.genderLabels[p.gender] || '',
      年齢: p.age,
      性格: p.personality,
      一人称: p.pronoun,
      口癖: p.tic,
      文末の癖: STYLE[p.style] || '特になし',
      住んでいる区画: `${it.writer.district}区画`,
      文化への態度: p.attitude
        ? {
            序列: PP.seniorityLabels[p.attitude.seniority],
            区画意識: PP.loyaltyLabels[p.attitude.loyalty],
            偏見: pre && cu ? `${cu.districts[pre.district].nickname}（${pre.district}区画の住人）を${PP.prejudiceTypes[pre.type]}` : 'なし',
          }
        : null,
      人間関係: rels,
      持続的な特徴: nonMarkerTraits(it.writer),
      経歴: p.background || '',
      ログの持ち主か: it.writer.id === it.owner ? 'はい' : 'いいえ（別人）',
    };
  }
  function personProfile(env, writer, r, al) {
    const PP = CFG.people;
    const rel = env.sc.relations.find((x) => (x.a === writer.id && x.b === r.id) || (x.b === writer.id && x.a === r.id));
    const band = PP.ageBands.find((b) => b.key === r.profile.age_band);
    return {
      記号: al.alias(r.id),
      性別: PP.genderLabels[r.profile.gender] || '',
      年齢層: band ? band.label : '',
      書き手との関係: rel ? CFG.relationLabels[rel.type] : 'とくになし',
      書き手からの呼び方: rel ? (rel.a === writer.id ? rel.terms.a_to_b : rel.terms.b_to_a) || '名前で呼ぶ' : '名前で呼ぶ',
      持続的な特徴: nonMarkerTraits(r),
    };
  }

  async function extract(env, items, al) {
    const { s, stats, signal } = env;
    const cu = env.sc.culture;
    const payload = {
      reserved_markers: cu ? Object.entries(cu.markers).map(([id, m]) => ({ id, label: m.label, keywords: m.keywords })) : [],
      nicknames: cu ? Object.values(cu.districts).map((x) => x.nickname) : [],
      number_label: cu ? CFG.culture.numberCustoms[cu.seniority.number_custom].label : '',
      honorific: cu ? { senior: cu.seniority.honorific.senior.join('〜'), junior: cu.seniority.honorific.junior.join('〜') } : {},
      entries: items.map((it) => ({
        key: it.localKey,
        situation: SITUATION[it.e.kind] || '記録',
        writer_alias: al.alias(it.writer.id),
        writer_first_person: it.writer.profile.pronoun,
        card_events: it.events.map((ev) => ({ id: ev.id, text: al.encode(asWriter(ev.text, it.writer.id)) })),
        text: al.encode(it.candidate),
      })),
    };
    let res;
    try {
      res = await chatJSON(s, stats, {
        model: s.verifyModel,
        system: EXTRACT_SYSTEM,
        user: `次の entries の text から、facts・general_rules・events・details を抽出してください。\n\n${JSON.stringify(payload, null, 1)}`,
        name: 'extracted_facts',
        schema: EXTRACT_SCHEMA,
        signal,
      });
    } catch (e) {
      if (e.fatal || (signal && signal.aborted)) throw e;
      return new Map();
    }
    return new Map((res.entries || []).map((x) => [x.key, x]));
  }

  // その日にすでに確定している LLM の文章（今回の対象外のもの）
  function settledEntriesOfDay(sc, env, day) {
    const out = [];
    for (const [owner, es] of Object.entries(sc.documents.chip_logs)) {
      es.forEach((e) => {
        if (!e.deleted && e.narrator === 'llm' && dayOf(e.t) === day) out.push({ e, owner, writer: env.byId.get(e.writer), scene: env.sceneById.get(e.scene) });
      });
    }
    return out;
  }

  // 日ごとの整合性検査：同じ日の複数のログを並べて、矛盾を LLM に指摘させる。今回の候補（fresh）だけが差し戻しの対象
  async function dayCheck(env, day, fresh, settled) {
    const { sc, s, stats, signal } = env;
    const rows = [
      ...settled.map((x) => ({ text: x.e.text, writer: x.writer, scene: x.scene, t: x.e.t, kind: x.e.kind, item: null })),
      ...fresh.map((it) => ({ text: it.candidate, writer: it.writer, scene: it.scene, t: it.e.t, kind: it.e.kind, item: it })),
    ].sort((a, b) => a.t - b.t);
    if (rows.length < 2 || !fresh.length) return [];
    // その日の場面に加えて、並べる記録が属する場面（前日の出来事を日付をまたいで書いた記録など）も正本として渡す
    const rowScenes = new Set(rows.map((r) => r.scene && r.scene.id));
    const scenesOfDay = sc.story.scenes.filter((x) => dayOf(x.t) === day || rowScenes.has(x.id));
    const sources = rows.flatMap((r) => [r.text, `{P:${r.writer.id}}`]).concat(scenesOfDay.flatMap((x) => [x.title, ...x.events.map((ev) => ev.text)]));
    const al = makeAliases(sources);
    const keyed = rows.map((r, n) => ({ ...r, key: `L${n + 1}` }));
    const payload = {
      canon: scenesOfDay.map((x) => ({ time: x.timestamp, place: x.place_name, title: al.encode(x.title), events: x.events.map((ev) => al.encode(ev.text)) })),
      entries: keyed.map((r) => ({
        key: r.key,
        writer_alias: al.alias(r.writer.id),
        time: A.util.fmtT(r.t),
        scene: al.encode(r.scene ? r.scene.title : ''),
        situation: SITUATION[r.kind] || '記録',
        text: al.encode(r.text),
      })),
    };
    let res;
    try {
      res = await chatJSON(s, stats, {
        model: s.verifyModel,
        system: CHECK_SYSTEM,
        user: `D${pad2(day)} の主観ログです。矛盾があれば、関わるエントリの key と内容を挙げてください。\n\n${JSON.stringify(payload, null, 1)}`,
        name: 'day_consistency',
        schema: CHECK_SCHEMA,
        signal,
      });
    } catch (e) {
      if (e.fatal || (signal && signal.aborted)) throw e;
      return []; // 検査できなかった日は差し戻さない
    }
    const byKey = new Map(keyed.map((r) => [r.key, r]));
    const out = [];
    // 住人の区画・職能・入居順についての指摘は使わない（往復検証で真相と照合済み。検査役が指示に反して挙げることがある）
    const ID_TOPIC = /職能|職務|所属|担当|持ち場|班|区画|入居|仕事/;
    for (const c of res.contradictions || []) {
      if (ID_TOPIC.test(c.problem || '')) continue;
      // 差し戻すのは、直すべきと指摘された今回の候補だけ（同じ場面の全員を巻き添えにしない）。
      // 指摘がない場合や、直すべき側が確定済みの記録の場合は、関わる今回の候補を直させる
      const pick = (keys) => (keys || []).map((k) => byKey.get(k)).filter((r) => r && r.item).map((r) => r.item);
      const problem = al.decode(c.problem || '');
      // 誤認（暗闇で加害者を見誤った推量）を書くよう指定された記録は、見誤った人物についての指摘では差し戻さない
      const misperceived = (it) =>
        it.required.some(
          (f) =>
            (f.type === 'KILLED_BY' && f.certainty === 'low' && problem.includes(`{P:${f.args.k}}`)) ||
            // 回想として書かせた作業の描写は、同じ職能の別人がその日にした同じ作業と食い違っても矛盾ではない
            (f.type === 'OBS_WORK' && f.mode === 'recall' && problem.includes(`{P:${f.args.p}}`)),
        );
      const items = (pick(c.culprits).length ? pick(c.culprits) : pick(c.keys)).filter((it) => !misperceived(it));
      if (items.length) out.push({ items, problem });
    }
    return out;
  }

  // 検証に通らなかったエントリを、テンプレート文で確定させる（次回以降も API に送らない）
  function useTemplate(sc, unresolved) {
    const s = settings();
    const useCache = typeof localStorage !== 'undefined';
    const cache = useCache ? loadCache(sc, s) : { entries: {}, details: {} };
    for (const u of unresolved) {
      const e = sc.documents.chip_logs[u.owner][u.index];
      if (!e || e.narrator) continue;
      e.narrator = 'template';
      feedbackMemo.delete(e);
      cache.entries[`${u.owner}#${u.index}`] = { draft: e.draft || e.text, failed: true };
    }
    if (useCache) saveCache(sc, s, cache);
  }

  // テンプレート文に戻す（正本に書き戻した細部も消す）
  function revertToTemplate(sc) {
    for (const es of Object.values(sc.documents.chip_logs)) {
      for (const e of es) {
        if (e.draft) e.text = e.draft;
        delete e.narrator;
      }
    }
    if (sc.story) sc.story.scenes.forEach((s) => (s.details = []));
  }

  A.LLM = { settings, isConfigured, narrateScenario, useTemplate, applyCache, clearCache, countEntries, pendingCount, revertToTemplate, averageOverlap, overlapRate, LLMError };
})(window.ASARIYA = window.ASARIYA || {});
