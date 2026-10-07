// 設定（設計書 §4.2 / §3 / §14 の値）。試作では JS ファイルとして持ち、file:// でも読めるようにしている。
(function (A) {
  'use strict';

  A.CONFIG = {
    version: '0.1-proto',

    scale: {
      residents: [12, 16],
      districts: [3, 4],
      counselors: [2, 3],
      entryGaps: [0, 2], // 入居番号の欠番の数（退去・抹消された元住人）
      period: [7, 21], // 事件の期間（最後の死亡日）
      survivorWeights: [[0, 60], [1, 30], [2, 10]],
      trickCountWeights: [[0, 20], [1, 45], [2, 35]],
      dailyEntriesMin: 4, // 異変前の日常のエントリの最低数（1人あたり。手がかりを日をまたいで散らす）
      idFactsPerEntry: 2, // 1エントリに置ける身元の観察事実の上限
    },

    districtLetters: ['A', 'B', 'C', 'D'],
    alertMax: 8, // 警戒度の上限（改修仕様 v0.2 §9）
    alertRecoverOnSuccess: 1, // 正しい ID を入力するたびに下げる量
    counselorCode: 51,

    // §4.2 職能コード表
    jobs: [
      { code: 11, category: 'medical', name: '医師', weight: 1 },
      { code: 12, category: 'medical', name: '看護', weight: 1.5 },
      { code: 13, category: 'medical', name: '薬剤管理', weight: 1 },
      { code: 21, category: 'food', name: '農耕', weight: 2.5 },
      { code: 22, category: 'food', name: '調理', weight: 1.5 },
      { code: 23, category: 'food', name: '配給管理', weight: 1 },
      { code: 31, category: 'facility', name: '電気', weight: 1.5 },
      { code: 32, category: 'facility', name: '空調・浄水', weight: 1.5 },
      { code: 33, category: 'facility', name: '修繕', weight: 1.5 },
      { code: 41, category: 'security', name: '警備', weight: 1.5 },
      { code: 42, category: 'security', name: '外部偵察', weight: 1 },
      { code: 51, category: 'admin', name: '相談役', weight: 0 },
      { code: 52, category: 'admin', name: '記録係', weight: 0.7 },
    ],
    categories: { medical: '医療', food: '食料', facility: '設備', security: '保安', admin: '管理' },

    crises: {
      outbreak: { label: '感染症の流行', weight: 25, primary: 'infection', causes: [['infection', 70], ['murder', 15], ['accident', 15]] },
      famine: { label: '食料の枯渇', weight: 25, primary: 'starvation', causes: [['starvation', 65], ['murder', 20], ['accident', 15]] },
      leak: { label: '放射能汚染', weight: 20, primary: 'radiation', causes: [['radiation', 70], ['accident', 20], ['murder', 10]] },
      strife: { label: '内部抗争', weight: 30, primary: 'murder', causes: [['murder', 70], ['accident', 30]] },
    },

    causes: {
      murder: '殺人',
      infection: '感染症',
      radiation: '被曝',
      starvation: '飢餓',
      accident: '事故',
      intruder: '侵入者による殺害',
    },

    // 死の徴候（設計書 §8.1 の DEATH_SIGN）。
    //  causes：両立する死因（論理層）
    //  label：抽象的な内容。物語の正本の出来事と、LLM に渡す必須事実に使う（「{V}は」に続く形）
    //  keywords：LLM 文章化の機械的な事前判定に使う語（本文にどれかがあれば、書き漏らしなしとみなす）
    //  template：テンプレート文章化用の文。self は本人の最期、other は遺体を見た人の記録（{V} は死者）
    signs: {
      fever: { causes: ['infection'], label: '高熱にうなされていた', keywords: ['熱'],
        template: { self: '熱が下がらない。視界がぐらぐらと揺れている。', other: '{V}の体は、燃えるように熱かった。' } },
      cough: { causes: ['infection'], label: '血の混じった咳が止まらなかった', keywords: ['咳', '血痰'],
        template: { self: '咳が止まらない。口の中に血の味がする。', other: '{V}の枕元には、血の混じった痰が残っていた。' } },
      rash: { causes: ['infection'], label: '赤い発疹が全身に広がっていた', keywords: ['発疹'],
        template: { self: '腕の赤い発疹が、胸まで広がってきた。', other: '{V}の首筋から胸にかけて、赤い発疹が広がっていた。' } },
      hairloss: { causes: ['radiation'], label: '髪がごっそり抜け落ちていた', keywords: ['髪', '抜け'],
        template: { self: '髪をかき上げたら、ごっそりと抜けた。', other: '{V}の枕には、抜けた髪が束になって落ちていた。' } },
      burn: { causes: ['radiation'], label: '皮膚が赤くただれていた', keywords: ['ただれ'],
        template: { self: '皮膚が赤くただれて、触れると剥がれる。', other: '{V}の手の皮膚は、赤くただれて剥がれかけていた。' } },
      dosimeter: { causes: ['radiation'], label: '胸の線量計が鳴りやまなかった', keywords: ['線量計'],
        template: { self: '胸の線量計が鳴りやまない。', other: '{V}の胸の線量計は、振り切れたまま鳴り続けていた。' } },
      nausea: { causes: ['radiation', 'infection', 'starvation'], label: 'ひどい吐き気に襲われていた', keywords: ['吐'],
        template: { self: '吐き気がひどい。', other: '{V}の周りには、吐いた跡があった。' } },
      hunger: { causes: ['starvation'], label: '何日も何も食べていなかった', keywords: ['食べていない', '口にしていない', '飢え', 'やせ', 'あばら'],
        template: { self: 'もう何日も、何も口にしていない。', other: '{V}はやせ細り、あばら骨が浮き出ていた。' } },
      weak: { causes: ['starvation'], label: '飢えで指一本動かせなくなっていた', keywords: ['動かせない', '力が入らない', '空腹', '配給缶'],
        template: { self: '空腹の痛みも、もう感じない。指一本動かせない。', other: '{V}の手には、空の配給缶が握られていた。' } },
      blow: { causes: ['murder'], label: '後頭部を硬いもので殴られた', keywords: ['殴', '後頭部'],
        template: { self: '後頭部に重い衝撃。床が目の前に迫ってくる。', other: '{V}の後頭部は、硬いもので割られていた。' } },
      strangle: { causes: ['murder'], label: '首を絞められた', keywords: ['絞', '指の跡'],
        template: { self: '首に何かが巻きついて、息ができない。', other: '{V}の首には、くっきりと指の跡が残っていた。' } },
      stab: { causes: ['murder'], label: '脇腹を刃物で刺された', keywords: ['刺'],
        template: { self: '脇腹に、熱いものが突き刺さった。', other: '{V}の脇腹には、深い刺し傷があった。' } },
      push: { causes: ['murder'], label: '背中を突き飛ばされ、縦坑に落ちた', keywords: ['突き飛ば', '突き落と'],
        template: { self: '背中を強く突き飛ばされた。足が宙を泳ぐ。', other: '{V}の背中には、両手で突かれたような痣があった。' } },
      fall: { causes: ['accident'], label: '腐った床板が抜けて縦坑に落ちた', keywords: ['床板', '転落', '落ち'],
        template: { self: '足元の床板が抜けた。落ちていく。', other: '{V}は縦坑の底で、腐った足場板と一緒に倒れていた。' } },
      shock: { causes: ['accident'], label: '配電盤に触れて感電した', keywords: ['感電', '配電盤'],
        template: { self: '配電盤に触れた瞬間、全身が跳ね上がった。', other: '{V}は配電盤の前で倒れていた。指先が黒く焦げていた。' } },
      crush: { causes: ['accident'], label: '崩れた天井の瓦礫の下敷きになった', keywords: ['瓦礫', '下敷き'],
        template: { self: '天井が崩れてきた。胸の上の瓦礫が重い。', other: '{V}は、崩れた天井の瓦礫の下敷きになっていた。' } },
      // 侵入者の徴候は、どれも「住人ではない者に襲われた」と読み取れるようにする（銃だけでは住人の犯行と区別できない）
      stranger: { causes: ['intruder'], label: 'チップの応答がない見知らぬ人物に刃物で切りつけられた', keywords: ['見知らぬ', 'チップの応答', '靴跡'],
        template: { self: '見たことのない顔だ。チップの応答がない――住人じゃない。そいつが刃物を振り上げた。', other: '{V}は深く切りつけられていた。そばには、住人の誰のものでもない大きな靴跡が残っていた。' } },
      gunshot: { causes: ['intruder'], label: 'チップの応答がない見知らぬ人影に、胸を銃で撃たれた', keywords: ['銃', '撃', '破裂音', '弾'],
        template: { self: 'チップの応答がない見知らぬ人影が、銃を構えた。乾いた破裂音。胸に穴が開いた。ここに銃なんてないはずなのに。', other: '{V}の胸には銃創があった。このシェルターの住人は誰も銃を持っていない。' } },
      mask: { causes: ['intruder'], label: 'ガスマスクをつけた見知らぬ人影に、鉄の棒で殴られた', keywords: ['ガスマスク', '吸収缶'],
        template: { self: 'ガスマスクをつけた見知らぬ人影が、くぐもった声で何か言いながら、鉄の棒を振り下ろした。', other: '{V}は頭を割られて倒れていた。床には、住人の誰も持っていないガスマスクの吸収缶が転がっていた。' } },
    },
    signSets: {
      infection: ['fever', 'cough', 'rash'],
      radiation: ['hairloss', 'burn', 'dosimeter'],
      starvation: ['hunger', 'weak'],
      murder: ['blow', 'strangle', 'stab', 'push'],
      accident: ['fall', 'shock', 'crush'],
      intruder: ['stranger', 'gunshot', 'mask'],
    },

    // §7 安全判定
    verdict: {
      results: { safe: '安全', danger: '危険', worthless: '価値なし' },
      reasons: ['潜伏者', '感染', '汚染', '侵入者'],
    },

    emotions: {
      calm: '平静', anxiety: '不安', fear: '恐怖', anger: '怒り', sadness: '悲しみ',
      relief: '安堵', despair: '絶望', pain: '苦痛', guilt: '罪悪感', resolve: '決意',
    },

    places: {
      generator: '発電室', clinic: '医務室', canteen: '食堂', farm: '水耕室', water: '浄水室',
      storage: '倉庫', hatch: '外部ハッチ前', shaft: '縦坑', corridor: '通路', room: '自室', pantry: '食料庫の前',
      workshop: '工作室', office: '管理室',
    },

    relationTypes: [
      ['family', 20], ['friend', 30], ['lover', 15], ['rival', 25], ['mentor', 10],
    ],
    relationLabels: { family: '家族', friend: '友人', lover: '恋人', rival: '対立', mentor: '師弟' },

    names: {
      surnames: ['灰谷', '鉄村', '霧島', '砂田', '黒須', '白石', '柊', '宮下', '小野寺', '早瀬', '鳴海', '久住', '槙', '葛城',
        '東雲', '朝比奈', '氷室', '真壁', '藤代', '篠原', '三条', '高遠', '有馬', '桐生', '日向', '沢渡', '綾瀬', '古賀',
        '若林', '菅野', '瀬戸', '結城', '千早', '戸川', '野々村', '秋津', '雨宮', '志摩', '堀', '遠野'],
      given: ['ミナ', 'ハル', 'ソウ', 'リン', 'ユキ', 'カイ', 'ナギ', 'トウマ', 'サク', 'レン', 'アオイ', 'ヒナ', 'ケイ', 'ジン',
        'ユウ', 'マコト', 'シオン', 'ヨル', 'イオ', 'タキ', 'コウ', 'ルイ', 'ミツ', 'ノア', 'セナ', 'アキ', 'チカ', 'ハヤテ',
        'スズ', 'ロク', 'ウタ', 'イブキ', 'カナエ', 'トキ', 'ヒロ', 'モモ', 'ツバキ', 'シン', 'ナツ', 'エマ'],
    },

    // 話し方の特徴（一人称・口癖・文末の癖）。口癖は住人ごとに一意にする。
    voices: {
      pronouns: [['私', 30], ['俺', 20], ['僕', 15], ['あたし', 10], ['わし', 5], ['自分', 8], ['うち', 6], ['わたし', 10]],
      tics: ['ちくしょう', 'やれやれ', '神様', 'まったく', 'ふん', 'なんてこった', '仕方ない', '参ったな', 'ああ、もう',
        'くそったれ', 'まあいい', '冗談じゃない', 'やだなあ', 'うへえ', '頼むよ', 'よし', 'さて', 'ままならない',
        'どうしたものか', '知るか', '南無阿弥陀仏', 'へっ'],
      styles: [['plain', 60], ['ellipsis', 20], ['exclaim', 20]],
    },
    personalities: ['慎重', '短気', '楽天的', '皮肉屋', '臆病', '面倒見がいい', '無口', '信心深い', '几帳面', '気まぐれ'],

    // ---------------------------------------------------------------- 人物設定（改修仕様 v0.2 §2）
    people: {
      genders: [['male', 50], ['female', 50]],
      genderLabels: { male: '男性', female: '女性' },
      pronoun3: { male: '彼', female: '彼女' }, // 三人称の代名詞
      ageBands: [
        { key: 'child', label: '子ども', max: 15 },
        { key: 'young', label: '若者', max: 29 },
        { key: 'adult', label: '壮年', max: 59 },
        { key: 'old', label: '老年', max: 200 },
      ],
      personalityTags: ['几帳面', '短気', '臆病', '皮肉屋', '世話焼き', '楽天的', '無口', '信心深い', '気まぐれ', '頑固', 'お人好し', '神経質', '負けず嫌い', '慎重'],
      seniority: [['respect', 40], ['indifferent', 40], ['rebel', 20]],
      seniorityLabels: { respect: '序列を重んじる', indifferent: '序列を気にしない', rebel: '序列に反発する' },
      loyalty: [['partisan', 50], ['neutral', 50]],
      loyaltyLabels: { partisan: '身内びいき', neutral: '中立' },
      prejudiceChance: 0.4,
      prejudiceTypes: { looks_down: '見下している', fears: '恐れている' },
      // 持続的な特徴（目印ではないもの）。目印の語（culture.markers の keywords）を含めないこと
      traits: [
        '左頬に古い傷跡がある', '話すとき指を鳴らす癖がある', '古い腕時計を大事にしている', '右足を少し引きずって歩く',
        '笑うと目尻に深い皺が寄る', 'いつも爪を噛んでいる', '背が高く、戸口で頭を屈める', '声が低くよく通る',
        '眼鏡のつるを糸で直している', '手の甲に火傷の痕がある', '左手の小指が欠けている', '早口でまくしたてる',
        'そばかすが多い', '耳が少し遠い', 'いつも同じ擦り切れた帽子をかぶっている', '指の関節が太い',
      ],
      backgrounds: [
        '地上では教師をしていた', '大崩壊の前は港で働いていた', '家族を地上で失った', 'このシェルターで生まれた',
        '偵察隊に拾われてここへ来た', '元は別のシェルターの住人だった', '若い頃は配送の仕事をしていた',
        '鉱山で働いていた', '地上では歌うたいだった', '大崩壊のとき子どもだった', '旅の行商人だった', '列車の整備士だった',
      ],
      // 関係ごとの呼び方（呼ぶ側から見た相手）
      relationTerms: {
        family: { olderFar: { male: '父さん', female: '母さん' }, older: { male: '兄さん', female: '姉さん' } },
        mentor: { toMentor: '先生' },
      },
    },

    // ---------------------------------------------------------------- シェルター文化（改修仕様 v0.2 §3）
    culture: {
      roles: {
        farming: { label: '農業区画', categories: ['food'], reputations: ['汚れ仕事の連中', '朝の早い働き者たち'], nicknames: ['土いじり', '泥足'] },
        facility: { label: '設備区画', categories: ['facility'], reputations: ['油まみれの職人たち', '愛想のない連中'], nicknames: ['油まみれ', 'ネジ屋'] },
        veterans: { label: '古参の居住区画', entry: 'early', reputations: ['気位が高い', '昔話ばかりの年寄り'], nicknames: ['上の連中', 'お偉方'] },
        newcomers: { label: '新入りの区画', entry: 'late', reputations: ['新参者の吹きだまり', '騒がしい若造たち'], nicknames: ['流れ者', 'よそ者'] },
        medical: { label: '医療区画', categories: ['medical'], reputations: ['お高くとまった連中', '取り澄ました連中'], nicknames: ['白衣組', '薬臭い連中'] },
        storage: { label: '倉庫区画', categories: ['security'], reputations: ['物資を握る連中', '口の固い番人たち'], nicknames: ['倉庫番', '鍵持ち'] },
      },
      districtRelations: [['rivalry', 30], ['looks_down', 30], ['depends', 20], ['indifferent', 20]],
      districtRelationLabels: { rivalry: '対立', looks_down: '見下し', depends: '依存', indifferent: '無関心' },
      // 目印：ある属性の値を持つ住人にだけ見られる描写。self は書き手本人、other は他人（{I}・{P} を置き換える）。
      // keywords は LLM 文章化で「予約語」として使う（指定された人物以外に使わせない）
      markers: {
        smell_soil: { kind: 'smell', label: '湿った土の匂い', keywords: ['土の匂い', '泥の匂い'], affinity: ['food'],
          self: '{I}の袖には、湿った土の匂いが染みついている。', other: '{P}の服から、湿った土の匂いがした。' },
        smell_oil: { kind: 'smell', label: '機械油の匂い', keywords: ['機械油'], affinity: ['facility'],
          self: '{I}の指先は、洗っても機械油の匂いが取れない。', other: '{P}の指先から、機械油の匂いがした。' },
        smell_disinfectant: { kind: 'smell', label: '消毒液の匂い', keywords: ['消毒液'], affinity: ['medical'],
          self: '{I}の手は、いつも消毒液の匂いがする。', other: '{P}が近くを通ると、消毒液の匂いがした。' },
        smell_mold: { kind: 'smell', label: 'かすかなカビの匂い', keywords: ['カビ'],
          self: '{I}の上着は、どうしてもカビ臭くなる。', other: '{P}の上着は、かすかにカビ臭かった。' },
        smell_smoke: { kind: 'smell', label: '煙の匂い', keywords: ['煙の匂い', '煤'],
          self: '{I}の髪には、煙の匂いが残っている。', other: '{P}の髪から、煙の匂いがした。' },
        armband_green: { kind: 'clothing', label: '緑の腕章', keywords: ['緑の腕章'],
          self: '{I}は今日も、緑の腕章を巻いた。', other: '{P}は緑の腕章を巻いていた。' },
        armband_red: { kind: 'clothing', label: '赤い腕章', keywords: ['赤い腕章'],
          self: '{I}は今日も、赤い腕章を巻いた。', other: '{P}の腕には、赤い腕章があった。' },
        armband_blue: { kind: 'clothing', label: '青い腕章', keywords: ['青い腕章'],
          self: '{I}は今日も、青い腕章を巻いた。', other: '{P}は青い腕章をつけていた。' },
        boots_rubber: { kind: 'clothing', label: '泥のこびりついたゴム長靴', keywords: ['ゴム長', '長靴'], affinity: ['food'],
          self: '{I}のゴム長靴は、今日も泥だらけだ。', other: '{P}は泥のこびりついたゴム長靴を履いていた。' },
        scarf_grey: { kind: 'clothing', label: '灰色の襟巻き', keywords: ['襟巻き'],
          self: '{I}は灰色の襟巻きを首に巻き直した。', other: '{P}は灰色の襟巻きを首に巻いていた。' },
        hair_braid: { kind: 'clothing', label: '細く編み込んだ髪', keywords: ['編み込'],
          self: '{I}は朝、髪を細く編み込んだ。', other: '{P}の髪は細く編み込まれていた。' },
        // 言葉づかいの予約語は、ふつうの言い回し（「言っちゃった」「ただでさえ」など）と紛れない語尾にする
        dialect_jake: { kind: 'speech', label: '語尾の「〜じゃけえ」', keywords: ['じゃけえ', 'じゃけん'],
          self: '{I}はつい「そうじゃけえ」と口にした。', other: '{P}が「もう少しで終わるじゃけえ」と言った。' },
        dialect_dabe: { kind: 'speech', label: '語尾の「〜だべ」', keywords: ['だべ'],
          self: '{I}は「わかってるだべ」と返した。', other: '{P}は「それはおらの分だべ」と言った。' },
        dialect_yansu: { kind: 'speech', label: '語尾の「〜やんす」', keywords: ['やんす'],
          self: '{I}は思わず「すまんでやんす」と言った。', other: '{P}が「それでいいでやんす」と笑った。' },
        habit_bread: { kind: 'habit', label: 'パンを細かくちぎって食べる', keywords: ['細かくちぎ'],
          self: '{I}はいつものように、パンを細かくちぎって食べた。', other: '{P}はパンを細かくちぎって食べていた。' },
        habit_pray: { kind: 'habit', label: '食事の前に両手を額に当てる', keywords: ['両手を額に'],
          self: '{I}は食事の前に、両手を額に当てた。', other: '{P}は食事の前に、両手を額に当てていた。' },
        habit_knock: { kind: 'habit', label: '扉を三度叩いてから入る', keywords: ['三度叩'],
          self: '{I}は扉を三度叩いてから入った。', other: '{P}は扉を三度叩いてから入ってきた。' },
        habit_hum: { kind: 'habit', label: '作業中に鼻歌を歌う', keywords: ['鼻歌'],
          self: '{I}はつい鼻歌を歌っていた。', other: '{P}が鼻歌を歌っていた。' },
        item_shell: { kind: 'item', label: '貝殻のお守り', keywords: ['貝殻'],
          self: '{I}は首から下げた貝殻のお守りを握った。', other: '{P}の首から、貝殻のお守りが下がっていた。' },
        item_whistle: { kind: 'item', label: '銀の笛', keywords: ['銀の笛'],
          self: '{I}は胸元の銀の笛を確かめた。', other: '{P}の胸元で、銀の笛が揺れていた。' },
        item_beads: { kind: 'item', label: '木の数珠', keywords: ['数珠'],
          self: '{I}は手首の木の数珠を指で繰った。', other: '{P}の手首には、木の数珠が巻かれていた。' },
        badge_old: { kind: 'item', label: '古びたバッジ', keywords: ['古びたバッジ', '古いバッジ'], band: true,
          self: '{I}は胸の古びたバッジを磨いた。', other: '{P}の胸には、古びたバッジが光っていた。' },
        pin_bronze: { kind: 'item', label: '襟の銅のピン', keywords: ['銅のピン'], band: true,
          self: '{I}は襟の銅のピンを付け直した。', other: '{P}の襟には、銅のピンが留められていた。' },
      },
      districtMarkers: [1, 2], // 各区画の目印の数
      categoryMarkerChance: 0.4, // 各職能分類に目印を付ける確率
      bandMarkerChance: 0.6, // 序列の帯（入居順の小さい住人）の目印を付ける確率
      bandMax: [3, 5],
      seniorityStrength: [['strict', 40], ['formal', 40], ['crumbling', 20]],
      seniorityLabels: { strict: '厳格', formal: '形式的', crumbling: '崩れかけ' },
      // 入居順に従う番号の習慣（必ず一つ持たせる。入居順を一意に読み解ける唯一の習慣のため）
      numberCustoms: {
        card: { label: '配給カードの番号', scene: 'queue' },
        locker: { label: '食堂の私物棚の番号', scene: 'meal' },
        room: { label: '部屋の扉の番号札', scene: 'quarters' },
      },
      // 入居順に従う順番の習慣（1〜2個を選ぶ）
      orderCustoms: {
        queue_order: { label: '配給の列は入居順', scene: 'queue' },
        seat_order: { label: '食堂の席順は入居順', scene: 'meal' },
        honorific: { label: '先に来た人への呼び方', scene: 'chat' },
        speaking_order: { label: '会合での発言の順番', scene: 'meeting' },
      },
      // 呼び方：[前に付ける語, 後に付ける語]。senior は先に来た人、junior は後から来た人への呼び方
      honorifics: [
        { senior: ['', '先輩'], junior: ['新入りの', ''] },
        { senior: ['古株の', ''], junior: ['新顔の', ''] },
      ],
      ruleExamples: 2, // ルールを学習するのに必要な例の数 K
      directFactsInDialogue: 3, // 会話ログに置ける直接の事実（区画など）の上限（1シナリオあたり）
    },
    shelterNames: ['ミズナラ', 'カゲロウ', 'アカツキ', 'ヒバリ', 'クロガネ', 'シラサギ', 'ウツロ', 'ナナカマド'],
  };

  A.CONFIG.jobByCode = Object.fromEntries(A.CONFIG.jobs.map((j) => [j.code, j]));
})(window.ASARIYA = window.ASARIYA || {});
