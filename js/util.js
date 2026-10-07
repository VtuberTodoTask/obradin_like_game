// 乱数（シード固定で再現可能）と時刻ユーティリティ
(function (A) {
  'use strict';

  function mulberry32(a) {
    return function () {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  class RNG {
    constructor(seed) {
      this.next = mulberry32(seed >>> 0);
    }
    int(a, b) {
      return a + Math.floor(this.next() * (b - a + 1));
    }
    chance(p) {
      return this.next() < p;
    }
    pick(arr) {
      return arr[Math.floor(this.next() * arr.length)];
    }
    shuffle(arr) {
      const a = arr.slice();
      for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(this.next() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
      }
      return a;
    }
    sample(arr, n) {
      return this.shuffle(arr).slice(0, n);
    }
    // pairs: [[value, weight], ...]
    weighted(pairs) {
      const total = pairs.reduce((s, p) => s + p[1], 0);
      let r = this.next() * total;
      for (const [v, w] of pairs) {
        if ((r -= w) < 0) return v;
      }
      return pairs[pairs.length - 1][0];
    }
  }

  function mixSeed(seed, salt) {
    let h = (seed >>> 0) ^ Math.imul(salt + 1, 0x9e3779b1);
    h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
    return (h ^ (h >>> 16)) >>> 0;
  }

  const DAY = 1440;
  const pad2 = (n) => String(n).padStart(2, '0');
  const tAbs = (day, minute) => (day - 1) * DAY + minute;
  const dayOf = (t) => Math.floor(t / DAY) + 1;
  const fmtT = (t) => {
    const m = ((t % DAY) + DAY) % DAY;
    return `D${pad2(dayOf(t))} ${pad2(Math.floor(m / 60))}:${pad2(m % 60)}`;
  };
  const range = (a, b) => {
    const out = [];
    for (let i = a; i <= b; i++) out.push(i);
    return out;
  };

  A.RNG = RNG;
  A.mixSeed = mixSeed;
  // 同シードの別型・別JSONを、進行と文章キャッシュへ重ねないための内容識別。
  function scenarioFingerprint(sc) {
    const text = JSON.stringify({ residents: sc.residents.map((r) => [r.id, r.token, r.name, r.profile]),
      facts: sc.facts.map((f) => [f.type, f.args, f.loc]), initial: sc.initial_known_ids, rules: sc.publicCulture });
    let hash = 2166136261;
    for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
    return (hash >>> 0).toString(16);
  }
  A.util = { DAY, pad2, tAbs, dayOf, fmtT, range, scenarioFingerprint };
})(window.ASARIYA = window.ASARIYA || {});
