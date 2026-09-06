// =============================================================================
// roofMesh — 「自由屋根」を立体にする
//
//   ★ 屋根型を選んで作るのではない。各軒線から内側へ勾配なりに立ち上がる
//     傾いた平面を並べ、その下側包絡を採る（roofcalc.js）。辺ごとに
//     【どこまで立ち上げるか】を 0〜1 で与えるだけで、
//         4辺とも 0 … 寄棟      妻側2辺が 1 … 切妻
//         妻側が途中 … 入母屋・はかま腰
//     が全部おなじ仕組みで出る。さらに棟を横へずらせば、招き屋根から
//     片流れまで続く。型の切り替えではなく、ひと続きの変形になる。
//
//   ⚠️ roofcalc.js は 05 からそのまま移設したもので、座標は【メートル】前提。
//     01 は mm なので、この境目で 1/1000 して呼び、戻り値を 1000 倍する。
//     計算そのものには手を入れない（563 行の幾何を単位のために触るのは割に合わない）。
//
//   原点は 01 の屋根グループに合わせて【壁の天端の中心】。y=0 が壁の天端。
// =============================================================================
import * as THREE from 'three';
import { buildRoof, outlineEdges, ridgeAxisOf, maxRidgeY } from './roofcalc.js';
import { AppState } from '../appState.js';

const S = 1000;               // m ⇔ mm
const ROOF_FINISH = 60;       // 上層＝葺き材[mm]
const ROOF_THICK = 150;       // 葺き材＋下地[mm]。01 の既存屋根の厚みに合わせる
// ⚠️ 稜線は屋根面とまったく同じ高さにある。そのまま描くと深度が拮抗して面に
//   食われ、線が消えたり点線状になったりする。ほんの少し浮かせる。
const LINE_LIFT = 8;          // [mm]
const PARAPET_H = 300;        // パラペットの立ち上がり[mm]
const PARAPET_T = 150;        // パラペットの厚み[mm]
export const EAVE_MAX = 1200; // 軒の出の上限[mm]
export const EAVE_SNAP = 50;  // 軒の出の刻み[mm]

/* その辺の外向き。軒先はこの向きへ出る。 */
export const OUT_DIR = { w: [-1, 0], e: [1, 0], s: [0, -1], n: [0, 1] };

const EDGE_KEYS = ['w', 'e', 's', 'n'];

/* 既定のパラメータ。01 の他の屋根と同じ流儀で b.roof.params に入る。 */
export const FREE_ROOF_DEFAULTS = {
  slope: 4,        // 寸（4寸 = 4/10）
  eaves: 600,      // 軒の出[mm]
  gw: 0, ge: 0, gs: 0, gn: 0,   // 辺ごとの切妻の度合い 0（寄棟）〜1（切妻）
  st: 0,           // 棟のずれ -1〜1。0=中央、±1=軒まで寄せきり（片流れ）
  step: false,     // true なら差し掛け（棟に垂直な段差が出る）
  // ★ 辺ごとの軒の出[mm]。負なら「軒の出」の値に従う。
  //   ⚠️ 4辺ぶんを既定値で持たせない。全体の値を動かしたときに、辺ごとの値が
  //     古いまま残って効かなくなる。「指定なし」を持てる形にしておく。
  ow: -1, oe: -1, os: -1, on: -1,
  // ★ 矩形ごと・辺ごとの上書き。キーは "矩形番号:辺"。
  //   ⚠️ ここを既定値の器（空オブジェクト）として持たせてはいけない。
  //     FREE_ROOF_DEFAULTS を展開して作った p に【同じ参照】が入り、
  //     書き込むと既定値そのものが汚れて、他の建物にまで移る。
  //     読むときは p.outs || {} とし、書くときだけ器を作ること。
  //   outs   … "ri:辺" → 軒の出[mm]。無ければ o辺／eaves に従う。
  //   gbl    … "ri:辺" → 切妻の度合い 0〜1。無ければ g辺 に従う。
  //   shf    … "ri" → { t, step }。無ければ ri=0 だけ st/step に従う。
  // ★ 屋上の平場。1=平場なし（素の屋根）… 0=平場いっぱい（陸屋根）。
  flatT: 1,
  // ★ 平場をいっぱいまで広げた先。軒の出なしの陸屋根＋パラペット。
  parapet: false,
  // ★ 直方体を並べた形で、棟をひと続きにするか。
  //   true  … 1本の棟（軒から棟までの距離を揃えるので、棟の高さが揃う）
  //   false … 棟は別々（それぞれの幅なりの高さになり、谷で出会う）
  //   ⚠️ 既定は【ひと続き】。並べた形に大屋根を掛けるとき、ふつうに欲しいのは
  //     1本の棟の寄棟であって、小さい箱に別の屋根が載った形ではない。
  join: true,
};

/* 矩形 ri の辺 k の軒の出[mm]。
   ★ 軒先のバーは矩形ごと・辺ごとに1本ずつ出るので、値もそこまで細かく持つ。
     ⚠️ 「辺ごと」までしか持っていなかったときは、L字の東側のバーを引くと
       もう一方の矩形の東の軒まで一緒に動いて、片方だけ詰められなかった。 */
const outOf = (p, ri, k) => {
  const own = (p.outs || {})[`${ri}:${k}`];
  if (typeof own === 'number' && own >= 0) return own;
  const v = p['o' + k];
  return (typeof v === 'number' && v >= 0) ? v : Math.max(p.eaves || 0, 0);
};

/* 矩形 ri の辺 k の切妻の度合い 0〜1。 */
const gableOf = (p, ri, k) => {
  const own = (p.gbl || {})[`${ri}:${k}`];
  const v = (typeof own === 'number') ? own : (p['g' + k] ?? 0);
  return Math.min(1, Math.max(0, v));
};

/* 矩形 ri の棟のずれ。 */
const shiftOf = (p, ri) => {
  const own = (p.shf || {})[ri];
  const src = own || (ri === 0 ? { t: p.st, step: p.step } : null);
  if (!src) return { t: 0, step: false };
  return { t: Math.max(-1, Math.min(1, src.t || 0)), step: !!src.step };
};

// ★追加：屋根の切り欠き（上から見て長方形の穴）。05 と同じ考え方。
//   ★ 穴に面するところは【鉛直】に下り、底は壁の天端（＝屋上の高さ）。
//   ★ 外壁まで届いた辺は、その先の軒も含めて切り落とす（軒の出が 0 の辺だけ）。
//   ⚠️ 小さくしきって消す、はしない。消すのはパネルのボタン。
export const NOTCH_MIN = 2000;    // 一辺の最小[mm]
export const NOTCH_SNAP = 250;    // 動かす刻み[mm]

/* この屋根の切り欠き。ブロックの中心を原点とした mm。無ければ null。 */
export function freeNotch(b) {
  const o = freeRoofOwner(b) || b;
  const p = o && o.roof && o.roof.params && o.roof.params['自由屋根'];
  const n = p && p.notch;
  return n ? { ...n } : null;
}

/* 屋根が載っている外形の矩形（ブロックの中心を原点とした mm）。 */
function ownRects(b) {
  return roofGroup(b).map((g) => ({
    x0: g.x - g.w / 2 - b.x, x1: g.x + g.w / 2 - b.x,
    z0: g.z - g.d / 2 - b.z, z1: g.z + g.d / 2 - b.z,
  }));
}

/* その長方形が、建物の外形に丸ごと収まっているか。
   ★ 外形は矩形の重ねなので、外接矩形では判定できない（L字の欠けたところに
     入ってしまう）。x と z の切れ目で碁盤に刻み、桝がすべて中かを見る。 */
export function notchFits(b, n) {
  const rs = ownRects(b);
  if (!rs.length || !n) return false;
  if (n.x1 - n.x0 < NOTCH_MIN - 1e-6 || n.z1 - n.z0 < NOTCH_MIN - 1e-6) return false;
  const cut = (vals, lo, hi) => [...new Set([lo, hi, ...vals])]
    .filter((v) => v > lo - 1e-6 && v < hi + 1e-6).sort((a, b2) => a - b2);
  const xs = cut(rs.flatMap((q) => [q.x0, q.x1]), n.x0, n.x1);
  const zs = cut(rs.flatMap((q) => [q.z0, q.z1]), n.z0, n.z1);
  for (let i = 0; i + 1 < xs.length; i++) {
    for (let j = 0; j + 1 < zs.length; j++) {
      const cx = (xs[i] + xs[i + 1]) / 2, cz = (zs[j] + zs[j + 1]) / 2;
      if (!rs.some((q) => cx > q.x0 && cx < q.x1 && cz > q.z0 && cz < q.z1)) return false;
    }
  }
  return true;
}

/* 置ける場所をさがす。
   ★ まず【隅】に寄せる。まん中に置くと、面の押し引きのつまみと重なって、
     どちらを掴んでいるのか分からなくなる。
   ⚠️ 入る場所が無ければ null。無理に置くと屋根の外へはみ出す。 */
export function notchSpot(b) {
  const h = NOTCH_MIN / 2;
  const at = (x, z) => ({ x0: x - h, x1: x + h, z0: z - h, z1: z + h });
  const rs = ownRects(b);
  // 外形の4隅（矩形ごと）。隅ぴったりに寄せる。
  for (const g of rs) {
    for (const c of [at(g.x0 + h, g.z0 + h), at(g.x1 - h, g.z0 + h),
      at(g.x1 - h, g.z1 - h), at(g.x0 + h, g.z1 - h)]) {
      if (notchFits(b, c)) return c;
    }
  }
  for (const g of ownRects(b)) {
    for (let x = g.x0 + h; x <= g.x1 - h + 1e-6; x += NOTCH_SNAP) {
      for (let z = g.z0 + h; z <= g.z1 - h + 1e-6; z += NOTCH_SNAP) {
        const cand = at(Math.round(x / NOTCH_SNAP) * NOTCH_SNAP,
          Math.round(z / NOTCH_SNAP) * NOTCH_SNAP);
        if (notchFits(b, cand)) return cand;
      }
    }
  }
  // 最後の手段としてまん中。ここも入らないなら置けない。
  const n0 = at(0, 0);
  return notchFits(b, n0) ? n0 : null;
}

/* 多角形を、軸に平行な直線で切る。残すのは片側だけ。 */
function clipHalf(poly, axis, c, keepLess) {
  const val = (q) => (axis === 'x' ? q.x : q.z);
  const inside = (q) => (keepLess ? val(q) <= c + 1e-9 : val(q) >= c - 1e-9);
  const out = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b2 = poly[(i + 1) % poly.length];
    const ia = inside(a), ib = inside(b2);
    if (ia) out.push(a);
    if (ia !== ib) {
      const t = (c - val(a)) / (val(b2) - val(a));
      out.push({ x: a.x + (b2.x - a.x) * t, z: a.z + (b2.z - a.z) * t });
    }
  }
  return out;
}

/* 多角形から長方形を引いた残り。凸な破片の配列で返す。
   ⚠️ 引き算の結果は凹むので、そのままでは扇形に三角形分割できない。外側を
     【左・右・下・上】の4つに切り分ければ、どれも凸のまま扱える。 */
function subtractRect(poly, r) {
  const out = [];
  const push = (q) => { if (q.length >= 3) out.push(q); };
  push(clipHalf(poly, 'x', r.x0, true));
  push(clipHalf(poly, 'x', r.x1, false));
  const mid = clipHalf(clipHalf(poly, 'x', r.x0, false), 'x', r.x1, true);
  if (mid.length >= 3) {
    push(clipHalf(mid, 'z', r.z0, true));
    push(clipHalf(mid, 'z', r.z1, false));
  }
  return out;
}

/* 線分の並び（[ax,ay,az, bx,by,bz, …]）から、長方形の中を通る部分を取り除く。
   ⚠️ 座標も長方形も【場面の単位（mm）】で渡すこと。 */
function cutSegs(pos, r) {
  if (!r) return pos;
  const out = [];
  for (let i = 0; i + 5 < pos.length; i += 6) {
    const ax = pos[i], ay = pos[i + 1], az = pos[i + 2];
    const bx = pos[i + 3], by = pos[i + 4], bz = pos[i + 5];
    const dx = bx - ax, dz = bz - az;
    let t0 = 0, t1 = 1, ok = true;
    const clip = (q, w) => {
      if (Math.abs(q) < 1e-12) { if (w < 0) ok = false; return; }
      const t = w / q;
      if (q < 0) { if (t > t1) ok = false; else if (t > t0) t0 = t; }
      else if (t < t0) ok = false;
      else if (t < t1) t1 = t;
    };
    clip(-dx, ax - r.x0); clip(dx, r.x1 - ax);
    clip(-dz, az - r.z0); clip(dz, r.z1 - az);
    if (!(ok && t1 - t0 > 1e-6)) { out.push(ax, ay, az, bx, by, bz); continue; }
    const at = (t) => [ax + dx * t, ay + (by - ay) * t, az + dz * t];
    if (t0 > 1e-6) out.push(ax, ay, az, ...at(t0));
    if (t1 < 1 - 1e-6) out.push(...at(t1), bx, by, bz);
  }
  return out;
}

/* 屋根の外周の辺から、切り欠きで抜けたところを取り除く（メートル）。
   ★ 切り欠きが外壁まで届いたのに軒先の小口だけが残っていると、穴の口を
     黒い帯が横切る。 */
function cutRims(rims, r) {
  if (!r) return rims;
  const out = [];
  for (const rec of rims) {
    const ax = rec.a.x, az = rec.a.z;
    const dx = rec.b.x - ax, dz = rec.b.z - az;
    let t0 = 0, t1 = 1, ok = true;
    const clip = (q, w) => {
      if (Math.abs(q) < 1e-12) { if (w < 0) ok = false; return; }
      const t = w / q;
      if (q < 0) { if (t > t1) ok = false; else if (t > t0) t0 = t; }
      else if (t < t0) ok = false;
      else if (t < t1) t1 = t;
    };
    clip(-dx, ax - r.x0); clip(dx, r.x1 - ax);
    clip(-dz, az - r.z0); clip(dz, r.z1 - az);
    if (!ok || t1 - t0 < 1e-6) { out.push(rec); continue; }
    const at = (t) => ({ x: ax + dx * t, z: az + dz * t });
    const yAt = (t) => rec.ya + (rec.yb - rec.ya) * t;
    if (t0 > 1e-6) out.push({ a: rec.a, b: at(t0), ya: rec.ya, yb: yAt(t0) });
    if (t1 < 1 - 1e-6) out.push({ a: at(t1), b: rec.b, ya: yAt(t1), yb: rec.yb });
  }
  return out;
}

/* 切り欠きが外壁の面まで届いている辺を調べ、その辺は【屋根の先まで】広げた
   長方形を返す（メートル）。
   ★ 外壁に届いた時点で外へ抜けているので、その先に軒の出は残らない。
   ⚠️ 軒の出がある辺は抜かない。抜くと軒が途中で断ち切られて、屋根に細長い
     切れ込みが入る。 */
function notchCutRect(rsM, result, nM) {
  const outside = (x, z) => !rsM.some(
    (r) => x > r.x0 && x < r.x1 && z > r.z0 && z < r.z1);
  const ers = (result.roofs || []).map((f) => f.r).filter(Boolean);
  const m = 3;                       // 屋根の外まで抜くのに十分な長さ[m]
  const t = 0.01;
  const at = (a, b2) => [a + (b2 - a) * 0.25, (a + b2) / 2, a + (b2 - a) * 0.75];
  const mn = (a, k) => Math.min(...a.map((r) => r[k]));
  const mx = (a, k) => Math.max(...a.map((r) => r[k]));
  const eaveOutAt = ers.length ? {
    w: mn(rsM, 'x0') - mn(ers, 'x0'), e: mx(ers, 'x1') - mx(rsM, 'x1'),
    s: mn(rsM, 'z0') - mn(ers, 'z0'), n: mx(ers, 'z1') - mx(rsM, 'z1'),
  } : { w: 0, e: 0, s: 0, n: 0 };
  const flush = (k) => eaveOutAt[k] < 1e-6;
  const open = {
    w: flush('w') && at(nM.z0, nM.z1).every((z) => outside(nM.x0 - t, z)),
    e: flush('e') && at(nM.z0, nM.z1).every((z) => outside(nM.x1 + t, z)),
    s: flush('s') && at(nM.x0, nM.x1).every((x) => outside(x, nM.z0 - t)),
    n: flush('n') && at(nM.x0, nM.x1).every((x) => outside(x, nM.z1 + t)),
  };
  return {
    open,
    rect: {
      x0: open.w ? nM.x0 - m : nM.x0, x1: open.e ? nM.x1 + m : nM.x1,
      z0: open.s ? nM.z0 - m : nM.z0, z1: open.n ? nM.z1 + m : nM.z1,
    },
  };
}

/* 切り欠きの4辺を、屋根の面ごとに切り分けたもの（メートル）。
   ★ 屋根は破片に割れているので、辺の上でも高さが折れる。面ごとに切ってから
     立てないと、折れ点を無視した平らな壁になる。 */
function notchRims(result, n) {
  const c = [{ x: n.x0, z: n.z0 }, { x: n.x1, z: n.z0 },
    { x: n.x1, z: n.z1 }, { x: n.x0, z: n.z1 }];
  const out = [];
  for (let i = 0; i < 4; i++) {
    const a = c[i], b2 = c[(i + 1) % 4];
    const dx = b2.x - a.x, dz = b2.z - a.z;
    for (const f of result.faces) {
      const cl = clipSegToPoly(a, b2, f.poly);
      if (!cl) continue;
      const [t0, t1] = cl;
      if (t1 - t0 < 1e-6) continue;
      const p0 = { x: a.x + dx * t0, z: a.z + dz * t0 };
      const p1 = { x: a.x + dx * t1, z: a.z + dz * t1 };
      out.push({ a: p0, b: p1, plane: f.plane,
        ya: hAt(f.plane, p0), yb: hAt(f.plane, p1) });
    }
  }
  return out;
}

/* 平面 plane の点 p での高さ[m]。 */
const hAt = (pl, p) => pl.a * p.x + pl.b * p.z + pl.c;
const k3 = (v) => Math.round(v * 1000);

/* 線分 a→b を凸多角形の内側だけに切り詰め、[t0, t1] を返す。外なら null。
   ★ 妻壁は屋根面ごとに切り分けてから立てる。またいだまま両端だけで測ると、
     折れ点を無視した平らな壁になる。 */
function clipSegToPoly(a, b, poly) {
  let area = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    area += p.x * q.z - q.x * p.z;
  }
  const sign = area >= 0 ? 1 : -1;
  let t0 = 0, t1 = 1;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    const ex = q.x - p.x, ez = q.z - p.z;
    const f0 = sign * (ex * (a.z - p.z) - ez * (a.x - p.x));
    const f1 = sign * (ex * (b.z - p.z) - ez * (b.x - p.x));
    const df = f1 - f0;
    if (Math.abs(df) < 1e-12) { if (f0 < -1e-9) return null; continue; }
    const t = -f0 / df;
    if (df > 0) t0 = Math.max(t0, t); else t1 = Math.min(t1, t);
    if (t0 > t1 - 1e-9) return null;
  }
  return [t0, t1];
}

/* 屋根の内側にできる【段差】の辺。入母屋の小さな三角の妻面や、差し掛け屋根の
   棟の垂直面がこれ。
   ★ 同じ辺を2つの面が共有しているのに、そこでの高さが食い違っていれば段差。
   ⚠️ ここを塞がないと、入母屋の破風の三角に穴が開く（実際に開いていた）。 */
function stepEdges(faces) {
  const seen = new Map();
  const keyOf = (a, b) => {
    const ka = `${k3(a.x)},${k3(a.z)}`;
    const kb = `${k3(b.x)},${k3(b.z)}`;
    return ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
  };
  const out = [];
  for (const f of faces) {
    for (let i = 0; i < f.poly.length; i++) {
      const a = f.poly[i], b = f.poly[(i + 1) % f.poly.length];
      const k = keyOf(a, b);
      const prev = seen.get(k);
      if (!prev) { seen.set(k, { a, b, plane: f.plane }); continue; }
      const y1a = hAt(prev.plane, prev.a), y1b = hAt(prev.plane, prev.b);
      const y2a = hAt(f.plane, prev.a), y2b = hAt(f.plane, prev.b);
      // ⚠️ しきい値は【1mm】。0 ちょうどで比べると、丸め誤差ほどの段差にも
      //   妻壁と小口が立って、屋根に細い切れ込みのような線が残る。
      if (Math.abs(y1a - y2a) < 1e-3 && Math.abs(y1b - y2b) < 1e-3) continue;
      out.push({
        a: prev.a, b: prev.b,
        loA: Math.min(y1a, y2a), loB: Math.min(y1b, y2b),
        hiA: Math.max(y1a, y2a), hiB: Math.max(y1b, y2b),
      });
    }
  }
  return out;
}

/* 稜線が折れる点に、屋根の厚みぶんの縦線を引く。
   ★ 小口は上下の横線だけでは板が浮いて見える。角に縦線が入って初めて厚みが読める。
   ⚠️ 辺ごとに縦線を引いてはいけない。屋根は破片に割って作っているので、
     一直線の軒先の途中にも縦線が何本も立つ。【向きが変わる点】だけに引く。
   ⚠️ 同じ点に【複数の高さ】が集まることがある。差し掛け屋根の段差の端がそれで、
     上の屋根の小口と下の屋根の小口が同じ平面位置に上下に並ぶ。高さを1つしか
     覚えていないと、上の屋根の小口だけ縦線が抜ける。高さの数だけ引くこと。 */
function cornerVerticals(edges) {
  const at = new Map();
  const add = (p, y, q) => {
    const k = `${k3(p.x)},${k3(p.z)}`;
    let r = at.get(k);
    if (!r) { r = { p, ys: new Map(), dirs: [] }; at.set(k, r); }
    r.ys.set(y.toFixed(6), y);
    const dx = q.x - p.x, dz = q.z - p.z, L = Math.hypot(dx, dz) || 1;
    r.dirs.push([dx / L, dz / L]);
  };
  for (const e of edges) { add(e.a, e.ya, e.b); add(e.b, e.yb, e.a); }
  const pos = [];
  for (const r of at.values()) {
    let corner = r.dirs.length !== 2;
    if (!corner) {
      const [u, v] = r.dirs;
      corner = (u[0] * v[0] + u[1] * v[1]) > -0.999;   // 一直線に続いていない
    }
    if (!corner) continue;
    for (const y of r.ys.values()) {
      pos.push(r.p.x * S, y * S, r.p.z * S, r.p.x * S, y * S - ROOF_THICK, r.p.z * S);
    }
  }
  return pos;
}

/* 矩形 r の辺 key のうち、【建物の外に面している】区間。
   ★ L字は直方体を並べて作るので、突き合わせた辺は建物の内側になる。
   ⚠️ 内側の辺に軒を出してはいけない。屋根が隣へめり込み、棟どうしの位置が
     ずれて納まらなくなる。壁も立たない（そこは室内）。 */
function exposedIntervals(rects, r, key) {
  const T = 1e-6, D = 10;                    // D は「外側」を探る距離[mm]
  const along = (key === 'w' || key === 'e');
  const coord = (key === 'w') ? r.x0 : (key === 'e') ? r.x1
    : (key === 's') ? r.z0 : r.z1;
  const probe = coord + ((key === 'w' || key === 's') ? -D : D);
  let iv = [[along ? r.z0 : r.x0, along ? r.z1 : r.x1]];
  for (const r2 of rects) {
    if (r2 === r) continue;
    const covers = along ? (r2.x0 - T < probe && probe < r2.x1 + T)
      : (r2.z0 - T < probe && probe < r2.z1 + T);
    if (!covers) continue;
    const c0 = along ? r2.z0 : r2.x0, c1 = along ? r2.z1 : r2.x1;
    const next = [];
    for (const [a, b] of iv) {
      if (c1 <= a + T || c0 >= b - T) { next.push([a, b]); continue; }
      if (c0 > a + T) next.push([a, c0]);
      if (c1 < b - T) next.push([c1, b]);
    }
    iv = next;
  }
  return { along, coord, iv: iv.filter(([a, b]) => b - a > 1e-6) };
}

/* 並べた直方体を、05 と同じ【重なった矩形の重ね】に組み直す。
   ★ 05 の L字は「横棒 10×5」と「縦棒 5×10」の2枚が角で【重なって】いる。
     どちらも短辺が 5 なので軒から棟までの距離が揃い、棟は角で折れた
     【1本】になる。01 では直方体を隙間なく並べるので、そのままでは
     「接しているだけの2枚」になり、棟がそれぞれ別に立ってしまう。
   ★ そこで、各矩形を【外形からはみ出さない範囲でめいっぱい広げる】。
     上の例なら縦棒が横棒の下まで伸びて 5×10 になり、05 と同じ重なりができる。
     広げても外形（＝屋根の掛かる範囲）は1ミリも変わらない。変わるのは
     「どう分けて持つか」だけ。
   ⚠️ 外形の外へ広げてはいけない。建物の無いところに屋根が張り出す。
   ⚠️ 広げたあと、他の矩形に飲み込まれたものは捨てる。残すと同じところに
     屋根が二重に立ち、谷の線が屋根の中に出る。 */
function limbRects(rects) {
  if (rects.length < 2) return rects;
  const T = 1;                                   // 1mm のゆらぎを吸収する
  const xs = [...new Set(rects.flatMap((r) => [r.x0, r.x1]))].sort((a, b) => a - b);
  const zs = [...new Set(rects.flatMap((r) => [r.z0, r.z1]))].sort((a, b) => a - b);
  // 外形を格子のます目に刻み、ます目ごとに「中か外か」を持つ。
  const inside = [];
  for (let i = 0; i + 1 < xs.length; i++) {
    const col = [];
    for (let j = 0; j + 1 < zs.length; j++) {
      const cx = (xs[i] + xs[i + 1]) / 2, cz = (zs[j] + zs[j + 1]) / 2;
      col.push(rects.some((r) => cx > r.x0 + T && cx < r.x1 - T
        && cz > r.z0 + T && cz < r.z1 - T));
    }
    inside.push(col);
  }
  const near = (arr, v) => {
    let k = 0;
    for (let i = 1; i < arr.length; i++) {
      if (Math.abs(arr[i] - v) < Math.abs(arr[k] - v)) k = i;
    }
    return k;
  };
  const grown = rects.map((r) => {
    let i0 = near(xs, r.x0), i1 = near(xs, r.x1);
    let j0 = near(zs, r.z0), j1 = near(zs, r.z1);
    const colIn = (j) => {
      for (let i = i0; i < i1; i++) if (!inside[i][j]) return false;
      return true;
    };
    const rowIn = (i) => {
      for (let j = j0; j < j1; j++) if (!inside[i][j]) return false;
      return true;
    };
    for (let guard = 0; guard < 64; guard++) {
      let moved = false;
      while (j0 > 0 && colIn(j0 - 1)) { j0--; moved = true; }
      while (j1 < zs.length - 1 && colIn(j1)) { j1++; moved = true; }
      while (i0 > 0 && rowIn(i0 - 1)) { i0--; moved = true; }
      while (i1 < xs.length - 1 && rowIn(i1)) { i1++; moved = true; }
      if (!moved) break;
    }
    return { x0: xs[i0], x1: xs[i1], z0: zs[j0], z1: zs[j1] };
  });
  const covers = (a, c) => (a.x0 <= c.x0 + T && a.x1 >= c.x1 - T
    && a.z0 <= c.z0 + T && a.z1 >= c.z1 - T);
  const keep = [];
  for (const g of grown) {
    if (keep.some((k) => covers(k, g))) continue;
    for (let i = keep.length - 1; i >= 0; i--) if (covers(g, keep[i])) keep.splice(i, 1);
    keep.push(g);
  }
  return keep.length ? keep : rects;
}

/* 建物の外形の輪郭を、まっすぐな区間に分けて返す。
   ⚠️ 一直線に続く区間はつなぐ。つながないと、ひと続きの壁の途中に縦線が入る。 */
function footprintSegments(rects) {
  const T = 1e-6;
  const groups = new Map();
  for (const r of rects) {
    for (const key of EDGE_KEYS) {
      const { along, coord, iv } = exposedIntervals(rects, r, key);
      if (!iv.length) continue;
      const k = `${key}:${Math.round(coord)}`;
      if (!groups.has(k)) groups.set(k, { key, coord, along, iv: [] });
      groups.get(k).iv.push(...iv);
    }
  }
  const segs = [];
  for (const g of groups.values()) {
    g.iv.sort((p, q) => p[0] - q[0]);
    const merged = [];
    for (const [a, b] of g.iv) {
      const last = merged[merged.length - 1];
      if (last && a <= last[1] + T) last[1] = Math.max(last[1], b);
      else merged.push([a, b]);
    }
    for (const [a, b] of merged) {
      segs.push(g.along
        ? { key: g.key, a: { x: g.coord, z: a }, b: { x: g.coord, z: b } }
        : { key: g.key, a: { x: a, z: g.coord }, b: { x: b, z: g.coord } });
    }
  }
  return segs;
}

/* この屋根が覆う階の並び。
   ★ L字は【同じ高さで並んだ直方体】として持つ。大屋根はその並び全部に掛かる。
   ⚠️ 屋根のデータは1つの階にしか持たせない。持ち主だけが屋根を描き、残りは
     自分の屋根も上面も描かない。両方が描くと同じ場所に2枚の屋根ができる。 */
export function roofGroup(b) {
  const all = (AppState && AppState.buildingData) || [b];
  const top = (b.y || 0) + b.h;
  // ★ 仲間にするのは【天端の高さが同じ】階だけ。高さが違えば下屋であって、
  //   1枚の大屋根にはならない。
  const cand = all.filter((q) => Math.abs(((q.y || 0) + q.h) - top) < 1 && q.h > 100);
  const box = (q) => ({ x0: q.x - q.w / 2, x1: q.x + q.w / 2,
    z0: q.z - q.d / 2, z1: q.z + q.d / 2 });
  // ★ つながっている＝【辺で接している】か重なっている。
  //   ⚠️ 角が点で触れているだけは数えない。そこには共有する壁が無く、
  //     屋根も繋がらない（別々に掛けるのが正しい）。
  //   ⚠️ 建物の番号（rootBuildingId）では判定しない。並べて描いた2つの箱は
  //     別々の番号を持つので、それを条件にすると永久にひと繋がりにならない。
  const touches = (u, v) => {
    const T = 1;
    const ox = Math.min(u.x1, v.x1) - Math.max(u.x0, v.x0);
    const oz = Math.min(u.z1, v.z1) - Math.max(u.z0, v.z0);
    return ox > -T && oz > -T && (ox > T || oz > T);
  };
  // b から辿れるところまで広げる（L字・コの字はこれで1つにまとまる）。
  const g = [b];
  const rest = cand.filter((q) => q !== b);
  let grew = true;
  while (grew) {
    grew = false;
    for (let i = rest.length - 1; i >= 0; i--) {
      if (!g.some((q) => touches(box(q), box(rest[i])))) continue;
      g.push(rest[i]); rest.splice(i, 1); grew = true;
    }
  }
  return g;
}

/* 並びのうち、大屋根を持っている階。持ち主だけが屋根を描く。 */
export function freeRoofOwner(b) {
  return roofGroup(b).find((q) => q.roof && q.roof.type === '自由屋根') || null;
}

/* この階の屋根の作り方一式。棟の位置を出すのにも使う。
   ★ 座標は【持ち主 b の中心】を原点にした mm。屋根グループの置き場所に合う。 */
function roofArgs(b) {
  const p = { ...FREE_ROOF_DEFAULTS,
    ...((b.roof && b.roof.params && b.roof.params['自由屋根']) || {}) };
  const slope = (p.slope || 0) / 10;
  let rects = roofGroup(b).map((g) => ({
    x0: g.x - g.w / 2 - b.x, x1: g.x + g.w / 2 - b.x,
    z0: g.z - g.d / 2 - b.z, z1: g.z + g.d / 2 - b.z,
  }));
  // ★ 棟をひと続きにするときは、並べた直方体を【重なった矩形の重ね】に
  //   組み直してから屋根を起こす。これが 05 で L字に1枚の大屋根が
  //   掛かっていた仕掛けそのもの。
  if (p.join) rects = limbRects(rects);
  const gables = {};
  rects.forEach((r, ri) => EDGE_KEYS.forEach((k) => {
    gables[`${ri}:${k}`] = gableOf(p, ri, k);
  }));
  // 矩形ごと・辺ごとの軒の出。
  // ⚠️ 建物の内側に隠れた辺には出さない（上の exposedIntervals）。
  const out = rects.map((r, ri) => {
    const o = {};
    EDGE_KEYS.forEach((k) => {
      o[k] = exposedIntervals(rects, r, k).iv.length
        ? Math.max(0, Math.min(EAVE_MAX, outOf(p, ri, k))) : 0;
    });
    return o;
  });
  // 軒の出を足した屋根の輪郭。
  //   ★ 軒の出は【輪郭を広げて屋根を作り直す】ことで表す。出を詰めれば棟まで
  //     の距離が縮み、棟の位置も長さも高さもそれに従って動く。
  // ⚠️ ここで棟高を揃えようとして輪郭を外へ広げてはいけない。屋根が建物の
  //   外へ張り出す。棟をつなぐのは limbRects（矩形の組み直し）の仕事で、
  //   それでも枝の幅が違えば棟は2本になる。それが正しい姿。
  const eaves = rects.map((r, ri) => ({
    x0: r.x0 - out[ri].w, x1: r.x1 + out[ri].e,
    z0: r.z0 - out[ri].s, z1: r.z1 + out[ri].n,
  }));
  // ★ 軒の基準は【いちばん出の大きい辺】で決める。
  //   軒先の高さはどの辺も同じなので、いちばん出た辺の屋根の裏側が壁の天端に
  //   ちょうど載る。出を詰めた辺は棟までの距離が縮むぶん屋根が低くなり、
  //   棟も少し下がる（そのぶん壁の天端を下げて辻褄を合わせる）。
  //   ⚠️ 「軒の出」の設定値そのもので決めてはいけない。4辺とも同じだけ詰めた
  //     ときにも建物が縮んでしまう。基準は【いま出ている量】から採る。
  //   ⚠️ 切妻の辺と、内側に隠れた辺は数えない。そこからは屋根面が立ち上がらない。
  let base = -Infinity;
  rects.forEach((r, ri) => EDGE_KEYS.forEach((k) => {
    if (gables[`${ri}:${k}`] >= 0.999) return;
    if (!exposedIntervals(rects, r, k).iv.length) return;
    base = Math.max(base, out[ri][k]);
  }));
  if (!Number.isFinite(base)) base = Math.max(p.eaves || 0, 0);
  const eaveBase = ROOF_THICK - slope * base;
  // ★ 棟のずれ（招き・片流れ）も矩形ごとに持つ。
  //   ⚠️ ずらせるのは【両端とも切妻】の矩形だけ。そこは roofcalc の
  //     shiftAxisOf が見てくれるので、ここでは全部の矩形に渡してよい。
  const single = rects.length === 1;
  const shifts = {};
  rects.forEach((r, ri) => { shifts[ri] = shiftOf(p, ri); });
  return { p, slope, base, out, rects, eaves, single,
    wall: rects[0], eave: eaves[0], eaveBase, gables, shifts,
    parapet: !!p.parapet,
    flatT: Math.min(1, Math.max(0, p.flatT ?? 1)) };
}

const toM = (r) => ({ x0: r.x0 / S, x1: r.x1 / S, z0: r.z0 / S, z1: r.z1 / S });

/* この階の壁の天端を、直方体の高さからどれだけ下げて描くか[mm]。
   ★ 軒先の高さはどの辺も同じなので、出を詰めた辺では屋根が【壁の天端より下】に
     取り付く。そのままだと直方体が屋根を突き抜けて、上に出てしまう。
     05 は壁の天端そのものを下げて辻褄を合わせている。01 も同じにする。
   ⚠️ 下げるのは【描き方】だけ。階の高さ（b.h）は触らない。触ると、軒をつまんだ
     だけで階の高さが書き換わり、青いつまみで決めた値が消える。
   ⚠️ 切妻の辺は数えない。そこからは屋根面が立ち上がらないので、その辺の
     けらばの出は屋根の取り付く高さと関係がない。 */
export function freeRoofWallDrop(b) {
  // ⚠️ 屋根を持っているのは並びのうち1つだけ。持っていない階も同じだけ
  //   下げないと、そこだけ屋根を突き抜ける。
  const own = freeRoofOwner(b);
  if (!own) return 0;
  const r = roofArgs(own);
  if (r.parapet || r.slope <= 0) return 0;
  let minOut = Infinity;
  r.rects.forEach((q, ri) => EDGE_KEYS.forEach((k) => {
    if (r.gables[`${ri}:${k}`] >= 0.999) return;
    if (!exposedIntervals(r.rects, q, k).iv.length) return;
    minOut = Math.min(minOut, r.out[ri][k]);
  }));
  if (!Number.isFinite(minOut)) return 0;
  // r.base は【いちばん出の大きい辺】。いちばん詰めた辺との差だけ屋根が下がる。
  return Math.max(0, r.slope * (r.base - minOut));
}

/* 平場なしで組んだときの棟の高さ[mm]。平場のつまみの行ける範囲になる。 */
function plainTop(a) {
  return maxRidgeY({ rects: a.eaves.map(toM), slope: a.slope, eaveY: a.eaveBase / S,
    gables: a.gables, shifts: a.shifts }) * S;
}

function runRoof(b) {
  const a = roofArgs(b);
  if (a.slope <= 0) return null;
  if (a.parapet) {
    // ★ 完全な陸屋根。軒の出は無く、壁の内側いっぱいに水平な屋根が張る。
    //   ⚠️ 軒の基準を下げないこと。軒の出が無いので、下げると屋根が軒高より
    //     沈み、周囲に要らない勾配の帯が出る。
    const res = buildRoof({ rects: a.rects.map(toM), slope: a.slope,
      eaveY: ROOF_THICK / S, gables: a.gables, shifts: a.shifts,
      flat: { y: ROOF_THICK / S, d: 0 } });
    return (res && res.faces.length)
      ? { ...a, eave: a.rects[0], eaves: a.rects, res } : null;
  }
  const args = { rects: a.eaves.map(toM), slope: a.slope, eaveY: a.eaveBase / S,
    gables: a.gables, shifts: a.shifts };
  // ★ 平場のふちの位置は【軒先からの水平距離】で決める。
  //   d が軒の出と同じ＝ふちが壁の位置（平場が最大＝陸屋根）
  //   d が軒〜棟の距離と同じ＝ふちが棟の位置（平場は幅0）
  //   ⚠️ 平場ちょうど1のときは【平場そのものを外す】。幅0の平場でも周りは
  //     そこへ向かって下るので、棟が軒高まで落ちた別の形になってしまう。
  let flat = null;
  if (a.flatT < 1 - 1e-9) {
    const hsMax = (plainTop(a) - a.eaveBase) / a.slope;
    const dMin = a.base;
    if (hsMax - dMin > 1) {
      // ★ 計算のうえでは、平場は【屋根の仕上げ面】に置く。勾配屋根はここまで
      //   下りてきて終わる。描くときに屋根厚ぶん下げるので、屋上の床は
      //   直方体の上面とちょうど同じ高さになり、ふちに屋根の小口が出る。
      flat = { y: ROOF_THICK / S, d: (dMin + a.flatT * (hsMax - dMin)) / S };
    }
  }
  const res = buildRoof({ ...args, flat });
  return (res && res.faces.length) ? { ...a, res } : null;
}

/* 棟の両端。屋根グループの原点（＝壁の天端の中心）から見た mm。
   ★ 棟の端の位置と「その辺の切妻の度合い」は【同じものの言い換え】。
       端の位置 = 軒から halfSpan × (1 - 切妻の度合い)
     端を軒へ寄せるほど切妻になり、軒に届いたら完全な切妻。
   ⚠️ 棟をずらしていれば、棟の線もそのぶん横へ寄る。つまみを中央に置いた
     ままにすると、掴んでいる場所と動くものがずれる。 */
export function freeRidges(b) {
  if (!b.roof || b.roof.type !== '自由屋根') return [];
  const r = runRoof(b);
  if (!r) return [];
  // ⚠️ 平場をつくると素の棟はもう無い（周りに低い峰ができるだけ）。球はどこの
  //   面にも載らなくなるので出さない。平場を戻せばまた出る。
  if (r.parapet || r.flatT < 1 - 1e-9) return [];
  const list = [];
  r.rects.forEach((q, ri) => {
    const info = r.res.roofs && r.res.roofs[ri];
    if (!info) return;
    // ⚠️ 他の屋根に負けて【1枚も描かれなかった】矩形には球を出さない。
    //   動かしても見た目が変わらないつまみになる。
    if (r.res.drawnRoofs && !r.res.drawnRoofs.has(ri)) return;
    const ev = r.eaves[ri];
    const hs = info.hs * S;
    const y = info.ridgeY * S;
    if (hs <= 1) return;
    if (y - r.eaveBase < 1) return;              // 勾配 0（陸屋根）には棟が無い
    const g = (k) => r.gables[`${ri}:${k}`];
    const alongX = ridgeAxisOf(toM(ev), ri, r.gables) === 'x';
    const t = info.t || 0, axis = info.axis;
    const cx = (ev.x0 + ev.x1) / 2 + (axis === 'x' ? t * hs : 0);
    const cz = (ev.z0 + ev.z1) / 2 + (axis === 'z' ? t * hs : 0);
    // ★ 棟を左右へずらせるのは【両端とも切妻】のときだけ。
    //   ⚠️ 片側でも立ち上がっていると、ずらした先で隅棟が水平面 45 度でなくなる。
    //     勾配を辺ごとに変えるしかなくなり、屋根として崩れる。
    const canShift = alongX ? (g('w') >= 0.999 && g('e') >= 0.999)
      : (g('s') >= 0.999 && g('n') >= 0.999);
    const ends = alongX ? [
      { x: ev.x0 + hs * (1 - g('w')), z: cz, edge: 'w', base: ev.x0, dir: 1 },
      { x: ev.x1 - hs * (1 - g('e')), z: cz, edge: 'e', base: ev.x1, dir: -1 },
    ] : [
      { x: cx, z: ev.z0 + hs * (1 - g('s')), edge: 's', base: ev.z0, dir: 1 },
      { x: cx, z: ev.z1 - hs * (1 - g('n')), edge: 'n', base: ev.z1, dir: -1 },
    ];
    // ★ 他の屋根の下に潜ってしまった端には球を出さない。
    //   ⚠️ 測るのは【自分以外】。自分の屋根の頂点に載っているので、自分を
    //     含めるとどの球も常に「潜っている」ことになる。
    const up = ends.filter((e) => {
      const hx = r.res.heightExcept(ri, e.x / S, e.z / S);
      return !(hx > (y - 1) / S);
    });
    if (!up.length) return;
    list.push({ ri, single: r.single, alongX, y, hs, t, canShift,
      eave: { ...ev }, ends: up });
  });
  return list;
}

/* 代表の棟。平場のつまみを置く場所に使う（いちばん高いもの）。 */
export function freeRidge(b) {
  const all = freeRidges(b);
  if (!all.length) return null;
  return all.reduce((a, c) => (c.y > a.y ? c : a));
}

/* 棟の端の位置を、その辺の【切妻の度合い】に読み替える。0〜1。 */
export function ridgeGableFromPos(b, ri, edge, v) {
  const r = freeRidges(b).find((q) => q.ri === ri);
  if (!r) return null;
  const e = r.ends.find((q) => q.edge === edge);
  if (!e) return null;
  const d = (v - e.base) * e.dir;
  return Math.min(1, Math.max(0, 1 - d / r.hs));
}

/* 屋上の平場をつくるつまみ。屋根のてっぺんの真上に置く。
   ★ 下げるほど平場が広がり、周りの勾配屋根が輪状に細くなる。さらに下げると
     軒の出なしの陸屋根＋パラペットへ抜ける。
   ⚠️ 平場は屋上レベルに固定。このつまみは【広さ】を決める道具であって、
     平場の高さを決める道具ではない。 */
export function freeRoofFlat(b) {
  if (!b.roof || b.roof.type !== '自由屋根') return null;
  const r = runRoof(b);
  if (!r) return null;
  const span = plainTop(r) - r.eaveBase - r.base * r.slope;
  if (span < 1) return null;              // もともと陸屋根＝つくるものが無い
  // ★ 真ん中からは少しずらして、屋根の上に載せる。
  //   ⚠️ 建物のちょうど真ん中に置くと、上面の押し引きの青いつまみと重なって
  //     掴めなくなる。平場をつくった瞬間に、戻す手が無くなってしまう。
  //   ⚠️ 建物の真ん中は、L字では建物の外に出ることがある。持ち主の矩形の
  //     中で選ぶこと。
  const q = r.rects[0];
  const cx = (q.x0 + q.x1) / 2;
  const z = (q.z0 + q.z1) / 2 + Math.min(q.x1 - q.x0, q.z1 - q.z0) * 0.25;
  const at = r.res.globalAt(cx / S, z / S);
  const y = (at && at.plane) ? at.h * S : ROOF_THICK;
  // 周りに残った勾配屋根の帯の幅[mm]。軒先から平場のふちまでの水平距離。
  const band = r.res.flat ? r.res.flat.d * S : 0;
  return { x: cx, z, y: r.parapet ? PARAPET_H : y, span, band,
    flatT: r.flatT, parapet: r.parapet };
}

/* 軒先のバーを置く場所。辺ごとに1本。
   ★ ホバーしたときだけ光らせるのはやめた。他のつまみと同じく【出しっぱなし】に
     して、見えている辺はいつでも掴めるようにする。
   ⚠️ 辺の端までは引かない。隅棟の線と重なって、どこを掴めるのかが読みにくい。
     真ん中の3分の2だけにする。 */
export function freeEaveBars(b) {
  if (!b.roof || b.roof.type !== '自由屋根') return [];
  const r = roofArgs(b);
  if (r.parapet || r.slope <= 0) return [];   // 陸屋根には出し入れする軒が無い
  const out = [];
  // ⚠️ 矩形ごとに、しかも【外に面した区間だけ】に置く。並べた直方体の
  //   突き合わせ部分にバーを出すと、そこに軒は無いのに掴めてしまう。
  r.rects.forEach((rect, ri) => {
    const e = r.eaves[ri];
    const line = { w: e.x0, e: e.x1, s: e.z0, n: e.z1 };
    for (const k of EDGE_KEYS) {
      const ex = exposedIntervals(r.rects, rect, k);
      if (!ex.iv.length) continue;
      const along = (k === 'w' || k === 'e');   // その辺は z 方向に伸びる
      // 外に面した区間のうち、いちばん長いところに1本。
      let best = null;
      for (const [a, b2] of ex.iv) if (!best || b2 - a > best[1] - best[0]) best = [a, b2];
      // 軒の出のぶん、その区間も外へ伸びる。
      const o = r.out[ri];
      const lo = best[0] - (along ? o.s : o.w);
      const hi = best[1] + (along ? o.n : o.e);
      const m = (lo + hi) / 2, half = (hi - lo) / 3;
      out.push({ ri, key: k, out: o[k], y: r.eaveBase, slope: r.slope,
        a: along ? { x: line[k], z: m - half } : { x: m - half, z: line[k] },
        b: along ? { x: line[k], z: m + half } : { x: m + half, z: line[k] } });
    }
  });
  return out;
}

/* 矩形の重ねが覆う広さ[mm²]。重なりは1回だけ数える。 */
function footprintArea(rects) {
  const T = 1;
  const xs = [...new Set(rects.flatMap((q) => [q.x0, q.x1]))].sort((a, b) => a - b);
  const zs = [...new Set(rects.flatMap((q) => [q.z0, q.z1]))].sort((a, b) => a - b);
  let a = 0;
  for (let i = 0; i + 1 < xs.length; i++) {
    for (let j = 0; j + 1 < zs.length; j++) {
      const cx = (xs[i] + xs[i + 1]) / 2, cz = (zs[j] + zs[j + 1]) / 2;
      if (rects.some((q) => cx > q.x0 + T && cx < q.x1 - T
        && cz > q.z0 + T && cz < q.z1 - T)) {
        a += (xs[i + 1] - xs[i]) * (zs[j + 1] - zs[j]);
      }
    }
  }
  return a;
}

/* 水平面に落とした多角形の面積[㎡]。poly はメートル。 */
function planArea(poly) {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    a += p.x * q.z - q.x * p.z;
  }
  return Math.abs(a) / 2;
}

/* 谷の長さの合計[m]。
   ★ 谷は【両隣が線より高い】折れ目。水がそこへ集まる。
   ⚠️ 平場のふちを数えないこと。外側だけが高く内側は同じ高さなので谷ではない。 */
function valleyLength(faces) {
  const share = new Map();
  for (const f of faces) {
    for (let i = 0; i < f.poly.length; i++) {
      const j = (i + 1) % f.poly.length;
      const a = f.poly[i], b2 = f.poly[j];
      const ka = `${k3(a.x)},${k3(a.z)}`, kb = `${k3(b2.x)},${k3(b2.z)}`;
      const id = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
      const rec = share.get(id);
      if (rec) rec.faces.push(f); else share.set(id, { a, b: b2, faces: [f] });
    }
  }
  let len = 0;
  for (const rec of share.values()) {
    if (rec.faces.length < 2) continue;
    const [f1, f2] = rec.faces;
    const mx = (rec.a.x + rec.b.x) / 2, mz = (rec.a.z + rec.b.z) / 2;
    const dx = rec.b.x - rec.a.x, dz = rec.b.z - rec.a.z;
    const L = Math.hypot(dx, dz) || 1;
    const ox = -dz / L * 0.05, oz = dx / L * 0.05;
    const hm = (hAt(f1.plane, { x: mx, z: mz }) + hAt(f2.plane, { x: mx, z: mz })) / 2;
    const h1 = hAt(f1.plane, { x: mx + ox, z: mz + oz });
    const h2 = hAt(f2.plane, { x: mx - ox, z: mz - oz });
    if (h1 > hm + 1e-4 && h2 > hm + 1e-4) len += L;
  }
  return len;
}

/* いまの形の【読み方】。形を指定する名前ではない。
   ⚠️ 左右の切妻の度合いが違うときは呼び名が無い。無理に付けない。 */
function roofName(r) {
  if (r.parapet) return '陸屋根（パラペット）';
  const info = r.res.roofs && r.res.roofs[0];
  const g = (k) => r.gables[`0:${k}`];
  const alongX = ridgeAxisOf(toM(r.eave), 0, r.gables) === 'x';
  const ga = alongX ? g('w') : g('s');
  const gb = alongX ? g('e') : g('n');
  let base = null;
  if (Math.abs(ga - gb) <= 0.02) {
    const gg = (ga + gb) / 2;
    const t = Math.abs((info && info.t) || 0);
    if (gg >= 0.999) {
      if (t >= 0.999) base = '片流れ';
      else if (t > 1e-6) {
        base = `${info.step ? '差し掛け屋根' : '招き屋根'}`
          + `（ずれ ${Math.round(t * info.hs * S)} mm）`;
      } else base = '切妻';
    } else if (gg <= 1e-6) {
      const sq = r.single
        && Math.abs((r.eave.x1 - r.eave.x0) - (r.eave.z1 - r.eave.z0)) < 1;
      base = sq ? '方形' : '寄棟';
    } else {
      // ★ 妻がどこまで下りているかで呼び分ける。上のほうだけ妻＝はかま腰。
      base = gg >= 0.5 ? '入母屋' : 'はかま腰';
    }
  }
  if (r.flatT <= 1e-3) return '陸屋根';
  if (r.flatT < 1 - 1e-9) {
    const short = base ? base.replace(/（.*$/, '') : null;
    return short ? `勾配パラペット（${short}）` : '勾配パラペット';
  }
  return base;
}

/* 勾配のつまみを置く場所。勾配屋根の【面ごと】に1つ。
   ★ その面の重心に置く。触る面がそのまま変わるので、どの面の勾配かで迷わない。
   ★ 高さから勾配を逆に解けるよう、割る数（den）も返す。
       面の高さ = 屋根厚 − 勾配×基準の軒の出 + 勾配×軒先からの距離
                = 屋根厚 + 勾配 ×（軒先からの距離 − 基準の軒の出）
     なので den = 軒先からの距離 − 基準の軒の出。
   ⚠️ 招き屋根で【寄った側】の面は軒が持ち上がっている。その持ち上がりも勾配に
     比例するので、den に足しておかないと、つまみを動かした量と勾配がずれる。 */
export function freeSlopeHandles(b) {
  if (!b.roof || b.roof.type !== '自由屋根') return [];
  const r = runRoof(b);
  if (!r) return [];
  const info = r.res.roofs && r.res.roofs[0];
  const t = info ? (info.t || 0) : 0;
  const axis = info ? info.axis : null;
  const step = info ? !!info.step : false;
  const nearKey = axis
    ? ((axis === 'z') ? (t > 0 ? 'n' : 's') : (t > 0 ? 'e' : 'w')) : null;
  const riseSpan = (!step && axis && Math.abs(t) > 1e-6)
    ? 2 * info.hs * S * Math.abs(t) : 0;
  // 同じ平面の破片をまとめ、広さで重みを付けて重心を採る。
  const g = new Map();
  for (const f of r.res.faces) {
    if (Math.hypot(f.plane.a, f.plane.b) < 1e-9) continue;   // 平場に勾配は無い
    if (!f.edgeKey) continue;
    // ⚠️ 平場へ【下る】面は外す。軒から遠いほど低くなるので、高さと勾配の
    //   関係が上る面とは逆になり、同じ式では解けない。
    const up = f.edgeKey === 'w' ? f.plane.a > 0
      : f.edgeKey === 'e' ? f.plane.a < 0
        : f.edgeKey === 's' ? f.plane.b > 0 : f.plane.b < 0;
    if (!up) continue;
    const a = planArea(f.poly);
    if (a < 1e-6) continue;
    let cx = 0, cz = 0;
    for (const p of f.poly) { cx += p.x; cz += p.z; }
    cx /= f.poly.length; cz /= f.poly.length;
    const k = `${f.plane.a.toFixed(4)},${f.plane.b.toFixed(4)},${f.plane.c.toFixed(4)}`;
    let rec = g.get(k);
    if (!rec) {
      rec = { a: 0, x: 0, z: 0, plane: f.plane, edge: f.edgeKey, ri: f.ri || 0 };
      g.set(k, rec);
    }
    rec.a += a; rec.x += cx * a; rec.z += cz * a;
  }
  const out = [];
  for (const rec of g.values()) {
    const cx = (rec.x / rec.a) * S, cz = (rec.z / rec.a) * S;
    const y = hAt(rec.plane, { x: cx / S, z: cz / S }) * S;
    // ⚠️ 軒先からの距離は【その面が属する矩形の軒先】から測る。並べた形では
    //   矩形ごとに軒先の位置が違うので、代表の1つで測ると勾配がずれる。
    const ev = r.eaves[rec.ri] || r.eaves[0];
    const u = rec.edge === 'w' ? cx - ev.x0
      : rec.edge === 'e' ? ev.x1 - cx
        : rec.edge === 's' ? cz - ev.z0
          : ev.z1 - cz;
    let den = u - r.base;
    if (rec.edge === nearKey) den += riseSpan;
    // ⚠️ 割る数が小さすぎると、1ピクセルの動きで勾配が飛ぶ。置かない。
    if (den < 300) continue;
    out.push({ x: cx, z: cz, y, den, y0: ROOF_THICK, edge: rec.edge });
  }
  return out;
}

/* 屋根の中身を読み上げる。[項目, 値] の並び。
   ★ 寸法はスライダーで触らせない。形は3Dのつまみで決めて、数字はここで【読む】。
     どこを触ればどの数字が動くのかが、モデルの上で分かるようにするため。 */
export function freeRoofInfo(b) {
  if (!b.roof || b.roof.type !== '自由屋根') return null;
  const r = runRoof(b);
  if (!r) return null;
  const rows = [];
  const add = (k, v) => rows.push([k, v]);
  const M = (mm) => (mm / 1000).toFixed(2);
  const name = roofName(r);
  if (name) add('屋根形', name);
  // ★ 寸法は差し渡し、面積は【実際に建っている広さ】。L字ではこの2つが
  //   一致しない。掛け算に合わない数字が出るのが正しい姿。
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (const q of r.rects) {
    x0 = Math.min(x0, q.x0); z0 = Math.min(z0, q.z0);
    x1 = Math.max(x1, q.x1); z1 = Math.max(z1, q.z1);
  }
  // ⚠️ 矩形の面積を足してはいけない。棟をひと続きにすると矩形は【重なる】ので、
  //   重なりを二重に数えて、建っていない広さが出る。
  const plan = footprintArea(r.rects);
  add('外形', `${((x1 - x0) / 1000).toFixed(1)} × ${((z1 - z0) / 1000).toFixed(1)} m`
    + `（${(plan / 1e6).toFixed(1)} ㎡）`
    + (r.single ? '' : `／${r.rects.length} 棟`));
  add('勾配', `${(r.slope * 10).toFixed(1)} 寸`);
  if (!r.parapet) {
    // ⚠️ 辺ごとに違うときは【全部】並べる。ひとつだけ出すと、他の辺が
    //   その値だと思い込む。
    const lab = { s: '南', n: '北', w: '西', e: '東' };
    const ks = ['s', 'n', 'w', 'e'];
    // ★ 出は矩形ごと・辺ごとに違いうる。同じ向きの軒でも、L字の枝と本体で
    //   別々に詰められる。辺の中でばらけていたら幅で出す。
    const vals = (k) => r.out.map((o, ri) => o[k])
      .filter((v, ri) => exposedIntervals(r.rects, r.rects[ri], k).iv.length);
    const txt = (k) => {
      const v = vals(k);
      if (!v.length) return null;
      const lo = Math.min(...v), hi = Math.max(...v);
      return (hi - lo < 1) ? `${Math.round(lo)}`
        : `${Math.round(lo)}〜${Math.round(hi)}`;
    };
    const shown = ks.map((k) => [k, txt(k)]).filter(([, t]) => t !== null);
    const same = shown.length > 0 && shown.every(([, t]) => t === shown[0][1]);
    add('軒の出', same ? `${shown[0][1]} mm`
      : shown.map(([k, t]) => `${lab[k]} ${t}`).join(' / ') + ' mm');
  }
  const foot = (b.y || 0) + b.h;
  const drop = freeRoofWallDrop(b);
  add('壁の天端', `${M(foot - drop)} m`
    + (drop > 0.5 ? `（軒に合わせて ${Math.round(drop)} mm 下げ）` : ''));
  if (!r.parapet) add('軒高', `${M(foot + r.eaveBase)} m`);
  let topY = r.eaveBase;
  for (const f of r.res.faces) for (const y of f.y) topY = Math.max(topY, y * S);
  if (r.parapet) topY = PARAPET_H;
  add(r.res.flat ? '最高部' : '棟高', `${M(foot + topY)} m`);
  if (r.parapet) add('パラペット', `${PARAPET_H} mm（厚 ${PARAPET_T} mm）`);
  // ⚠️ faces は計算の都合で割れた破片。同じ平面のものをまとめて数える。
  const sloped = r.res.faces.filter((f) => Math.hypot(f.plane.a, f.plane.b) > 1e-9);
  const planes = new Set(sloped.map(
    (f) => `${f.plane.a.toFixed(4)},${f.plane.b.toFixed(4)},${f.plane.c.toFixed(4)}`));
  // ★ 屋根の面積は【勾配なりの斜めの広さ】。水平の広さを √(1+勾配²) 倍する。
  let area = 0;
  for (const f of sloped) {
    const g2 = Math.hypot(f.plane.a, f.plane.b);
    area += planArea(f.poly) * Math.sqrt(1 + g2 * g2);
  }
  if (planes.size) add('屋根面', `${planes.size} 面（合計 ${area.toFixed(1)} ㎡）`);
  let flatArea = 0;
  for (const f of r.res.faces) {
    if (Math.hypot(f.plane.a, f.plane.b) < 1e-9) flatArea += planArea(f.poly);
  }
  if (flatArea > 1e-3) add('平場', `${flatArea.toFixed(1)} ㎡`);
  if (r.res.flat && r.res.flat.d > 0.05) {
    add('屋根の帯', `${r.res.flat.d.toFixed(2)} m（水平投影）`);
  }
  const v = valleyLength(r.res.faces);
  add('谷', v > 0.01 ? `合計 ${v.toFixed(2)} m` : 'なし');
  return rows;
}

/* 自由屋根を組む。b は 01 の階（mm）。
   返す Group の原点は【壁の天端の中心】なので、呼び出し側で
   position.set(b.x, baseY + b.h, b.z) すればよい。 */
export function buildFreeRoof(b, materials) {
  const g = new THREE.Group();
  const r = runRoof(b);
  if (!r) return g;
  const { wallMat, roofMat, edgeMat, gableWallMat } = materials;
  const result = r.res;
  // 建物の外形の輪郭。L字（直方体を並べた形）でも1本の折れ線として拾える。
  const foot = footprintSegments(r.rects);
  // ★追加：切り欠き。屋根に開ける長方形の穴（ブロックの中心が原点・mm）。
  //   ⚠️ 屋根を切り抜くのは【外壁に届いた辺を屋根の先まで伸ばした】長方形。
  //     元の穴のままだと、外へ抜けた先に軒の切れ端が残る。
  const nz = freeNotch(b);
  const nM = nz ? { x0: nz.x0 / S, x1: nz.x1 / S, z0: nz.z0 / S, z1: nz.z1 / S } : null;
  const nc = nM ? notchCutRect(r.rects.map(toM), result, nM) : null;
  const cut = nc ? nc.rect : null;              // メートル

  // --- 屋根面（葺き材の表面・境目・軒裏）---
  //   ★ 屋上の平場は瓦ではなく【防水】。葺き材の黒ではなく、下地と同じ白で塗る。
  //   ⚠️ 高さは下げない。色だけを変える。
  const top = [], flatTop = [], mid = [], bot = [];
  // ★ 高さは【その面の平面から測り直す】。
  //   ⚠️ 面が覚えている頂点の高さをそのまま使ってはいけない。破片に割るときの
  //     丸めでわずかにずれると、表面・境目・軒裏の3層が平行でなくなって互いを
  //     突き抜け、屋根の上に縞模様（深度の取り合い）が出る。
  const fan = (into, poly, plane, drop) => {
    for (let i = 1; i + 1 < poly.length; i++) {
      for (const k of [0, i, i + 1]) {
        const q = poly[k];
        into.push(q.x * S, hAt(plane, q) * S - drop, q.z * S);
      }
    }
  };
  // ★ 平場（水平な面）は【屋根厚ぶん下げて】描く。屋上の床は直方体の上面と
  //   同じ高さになり、勾配屋根はその上でぷつりと終わる。
  //   ⚠️ 計算の高さのまま描いてはいけない。床が屋根の仕上げ面と同じ高さになり、
  //     勾配屋根のふちに厚みが出ない（紙のように見える）。
  const isFlatPlane = (pl) => Math.hypot(pl.a, pl.b) < 1e-9;
  for (const f of result.faces) {
    const isFlat = isFlatPlane(f.plane);
    const dz = isFlat ? ROOF_THICK : 0;
    // ★ 切り欠きがあれば、面から長方形を引いてから三角形に割る。
    for (const pl of (cut ? subtractRect(f.poly, cut) : [f.poly])) {
      fan(isFlat ? flatTop : top, pl, f.plane, dz);
      fan(mid, pl, f.plane, ROOF_FINISH + dz);
      fan(bot, pl, f.plane, ROOF_THICK + dz);
    }
  }

  // --- 小口。外周と、内側の段差の高い側に、葺き材と下地の帯を立てる ---
  const black = top.slice(), white = [...flatTop, ...bot];
  const band = (into, a, b2, ya, yb, d0, d1) => {
    into.push(a.x * S, ya * S - d0, a.z * S, b2.x * S, yb * S - d0, b2.z * S,
      b2.x * S, yb * S - d1, b2.z * S);
    into.push(a.x * S, ya * S - d0, a.z * S, b2.x * S, yb * S - d1, b2.z * S,
      a.x * S, ya * S - d1, a.z * S);
  };
  const steps = stepEdges(result.faces);
  // ⚠️ パラペットのある陸屋根では、屋根の外周はパラペットの内側に隠れる。
  //   小口も外周線も描いてはいけない（パラペットの面と重なってちらつく）。
  let rims = r.parapet ? [] : outlineEdges(result.faces)
    .map((e) => ({ a: e.a, b: e.b, ya: e.ya, yb: e.yb }))
    // ⚠️ 平場がけらばまで届いたところには小口を立てない。そこは屋上の床が
    //   切れているだけで、軒先の見付け（けらばの厚み）は無い。立てると
    //   平場の端に段差のような帯と線が出る。
    .filter((e) => !(result.flat
      && Math.abs(e.ya - result.flat.y) < 1e-6
      && Math.abs(e.yb - result.flat.y) < 1e-6));
  // ★ 段差の【高い側】にも小口が要る。ここが抜けていると、入母屋の妻面の
  //   上端に屋根の厚みぶんの穴が開き、屋根の裏側が見える。
  for (const e of steps) rims.push({ a: e.a, b: e.b, ya: e.hiA, yb: e.hiB });
  // ★ 平場のふち。勾配屋根はここで終わるので、その小口（＝内側の軒先）を立てる。
  //   平場を屋根厚ぶん下げて描いているので、帯の下端がちょうど屋上の床に載る。
  //   ⚠️ 拾うのは【片側だけが平場】の辺。両側とも平場（平場の中の割れ目）や、
  //     両側とも勾配（棟・隅棟）に立てると、屋根の中に帯が林立する。
  if (result.flat) {
    const pair = new Map();
    for (const f of result.faces) {
      for (let i = 0; i < f.poly.length; i++) {
        const a = f.poly[i], b2 = f.poly[(i + 1) % f.poly.length];
        const ka = `${k3(a.x)},${k3(a.z)}`, kb = `${k3(b2.x)},${k3(b2.z)}`;
        const id = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
        const rec = pair.get(id);
        if (rec) rec.push({ f, a, b: b2 }); else pair.set(id, [{ f, a, b: b2 }]);
      }
    }
    for (const recs of pair.values()) {
      if (recs.length !== 2) continue;
      if (isFlatPlane(recs[0].f.plane) === isFlatPlane(recs[1].f.plane)) continue;
      rims.push({ a: recs[0].a, b: recs[0].b,
        ya: result.flat.y, yb: result.flat.y });
    }
  }
  // ⚠️ 切り欠きで抜けたところの小口は残さない。残すと、穴の口を黒い帯が横切る。
  if (cut) rims = cutRims(rims, cut);
  // ★ 穴の口にも小口が要る。屋根の厚みがそこで切れているので、立てないと
  //   紙を切り抜いたように見える。
  const nRims = cut ? notchRims(result, cut) : [];
  for (const rc of [...rims, ...nRims]) {
    band(black, rc.a, rc.b, rc.ya, rc.yb, 0, ROOF_FINISH);
    band(white, rc.a, rc.b, rc.ya, rc.yb, ROOF_FINISH, ROOF_THICK);
  }

  // --- 妻壁 ---
  const gPos = [], gLn = [];
  const quad = (a, b2, ya, yb, y2a, y2b) => {
    gPos.push(a.x * S, ya * S, a.z * S, b2.x * S, yb * S, b2.z * S,
      b2.x * S, y2b * S, b2.z * S);
    gPos.push(a.x * S, ya * S, a.z * S, b2.x * S, y2b * S, b2.z * S,
      a.x * S, y2a * S, a.z * S);
    gLn.push(a.x * S, y2a * S, a.z * S, b2.x * S, y2b * S, b2.z * S);
  };
  const TH = ROOF_THICK / S;
  // 壁の天端。出を詰めた辺があるぶんだけ下がっている（上の freeRoofWallDrop）。
  const wt = -freeRoofWallDrop(b) / S;
  // (1) 壁の天端から屋根の裏側までを塞ぐ（切妻・入母屋の妻面）。
  //   ★ 測るのは【壁の位置】。軒の出があるので屋根の外周とは離れている。
  //   ⚠️ 屋根面ごとに切り分けてから立てること。またいだまま両端だけで測ると、
  //     折れ点を無視した平らな壁になる。
  // ⚠️ パラペットのときは立てない。外壁がそのまま笠木まで立ち上がるので、
  //   この帯を重ねるとちらつき、線も一周ぶん余分に出る。
  const segs = r.parapet ? [] : foot.map((sg) => [
    { x: sg.a.x / S, z: sg.a.z / S }, { x: sg.b.x / S, z: sg.b.z / S }]);
  for (const [a, b2] of segs) {
    const dx = b2.x - a.x, dz = b2.z - a.z;
    for (const f of result.faces) {
      const cl = clipSegToPoly(a, b2, f.poly);
      if (!cl) continue;
      const [t0, t1] = cl;
      const p0 = { x: a.x + dx * t0, z: a.z + dz * t0 };
      const p1 = { x: a.x + dx * t1, z: a.z + dz * t1 };
      // ⚠️ 切り欠きの中には屋根が無い。妻壁も立てない。
      if (cut) {
        const mx2 = (p0.x + p1.x) / 2, mz2 = (p0.z + p1.z) / 2;
        if (mx2 > cut.x0 && mx2 < cut.x1 && mz2 > cut.z0 && mz2 < cut.z1) continue;
      }
      const y0 = hAt(f.plane, p0) - TH, y1 = hAt(f.plane, p1) - TH;
      // 壁の天端より上だけ。下なら屋根がすでに壁の中なので要らない。
      // ⚠️ しきい値は【1mm】。0 ちょうどで比べると、軒側の壁でも丸め誤差で
      //   わずかに上と判定され、軒を一周する厚みゼロの帯と線が残る。
      if (y0 <= wt + 1e-3 && y1 <= wt + 1e-3) continue;
      quad(p0, p1, wt, wt, Math.max(y0, wt), Math.max(y1, wt));
    }
  }
  // --- 切り欠きの側壁と底 ---
  //   ★ 屋根の小口（黒＋白）を立てたあと、その下を壁の色で壁の天端まで下ろす。
  //   ⚠️ 側壁が立つのは【元の切り欠きの範囲】だけ。外へ伸ばした先は屋根を
  //     切り抜いただけで、そこに建物は無い。
  //   ⚠️ 軒に近いところでは屋根の裏側が壁の天端より【低い】。下ろす向きが逆に
  //     なるので、低いところでは立てない。
  if (cut && nM) {
    const nfy = wt;                               // 穴の底＝壁の天端
    const cl = (q) => ({ x: Math.min(Math.max(q.x, nM.x0), nM.x1),
      z: Math.min(Math.max(q.z, nM.z0), nM.z1) });
    for (const rc of nRims) {
      const a = cl(rc.a), b2 = cl(rc.b);
      if (Math.hypot(b2.x - a.x, b2.z - a.z) < 1e-6) continue;
      const ya = Math.max(hAt(rc.plane, a) - TH, nfy);
      const yb = Math.max(hAt(rc.plane, b2) - TH, nfy);
      if (ya > nfy + 1e-6 || yb > nfy + 1e-6) quad(a, b2, nfy, nfy, ya, yb);
      gLn.push(a.x * S, nfy * S, a.z * S, b2.x * S, nfy * S, b2.z * S);
      // 小口の3本（表面・境目・軒裏）。穴の口の厚みが読めるようにする。
      for (const d of [0, ROOF_FINISH, ROOF_THICK]) {
        gLn.push(rc.a.x * S, rc.ya * S - d, rc.a.z * S,
          rc.b.x * S, rc.yb * S - d, rc.b.z * S);
      }
    }
    // ★ 穴の4隅に鉛直の線。これが無いと側壁の面が宙に浮いて見え、深さが読めない。
    //   ⚠️ 外へ抜けた辺の角には引かない。そこに側壁は無い。
    const cs = [[nM.x0, nM.z0, 'w', 's'], [nM.x1, nM.z0, 'e', 's'],
      [nM.x1, nM.z1, 'e', 'n'], [nM.x0, nM.z1, 'w', 'n']];
    for (const [cx, cz, k1, k2] of cs) {
      if (nc.open[k1] || nc.open[k2]) continue;
      const at2 = result.globalAt(cx, cz);
      if (!at2 || at2.h - TH - nfy < 1e-3) continue;
      gLn.push(cx * S, (at2.h - TH) * S, cz * S, cx * S, nfy * S, cz * S);
    }
    // 底（屋上）。軒裏と同じ白で張る。
    const yb2 = nfy * S;
    white.push(nM.x0 * S, yb2, nM.z0 * S, nM.x1 * S, yb2, nM.z0 * S,
      nM.x1 * S, yb2, nM.z1 * S);
    white.push(nM.x0 * S, yb2, nM.z0 * S, nM.x1 * S, yb2, nM.z1 * S,
      nM.x0 * S, yb2, nM.z1 * S);
  }

  // ★ 建物の角に鉛直の線。
  //   ⚠️ 妻壁の【上の辺】だけでは足りない。招き屋根や片流れでは、軒の高い側の
  //     壁が壁の天端から屋根まで四角く立ち上がるので、その左右が切れていないと
  //     壁の面が宙に浮いて見える。切妻では角の高さが 0 なので何も出ない。
  // ⚠️ 角は輪郭の【折れ点】。並べた形では入隅もあるので、辺の端を全部見る。
  const corners = new Map();
  if (!r.parapet) {
    for (const sg of foot) {
      for (const q of [sg.a, sg.b]) {
        corners.set(`${k3(q.x)},${k3(q.z)}`, { x: q.x / S, z: q.z / S });
      }
    }
  }
  for (const c of corners.values()) {
    const at = result.globalAt(c.x, c.z);
    if (!at || !at.plane) continue;
    const y = at.h - TH;
    if (y <= wt + 1e-3) continue;
    gLn.push(c.x * S, wt * S, c.z * S, c.x * S, y * S, c.z * S);
  }

  // (2) 屋根の内側にできる【段差】を塞ぐ（入母屋の小さな三角の妻面、
  //   差し掛け屋根の棟の垂直面）。上下とも屋根の【裏側】どうしをつなぐ。
  // ⚠️ この面には両端に鉛直の辺がある。quad は縦線を引かないので、ここで引く。
  //   引かないと垂直面の左右が切れておらず、面が宙に浮いて見える。
  //   途中の継ぎ目には引かない（段差は破片ごとに細切れになっているため）。
  const stepEnds = new Map();
  const markEnd = (pt, yLo, yHi) => {
    const k = `${k3(pt.x)},${k3(pt.z)}`;
    const r = stepEnds.get(k);
    if (r) r.n++; else stepEnds.set(k, { n: 1, pt, yLo, yHi });
  };
  for (const e of steps) {
    quad(e.a, e.b, e.loA - TH, e.loB - TH, e.hiA - TH, e.hiB - TH);
    markEnd(e.a, e.loA - TH, e.hiA - TH);
    markEnd(e.b, e.loB - TH, e.hiB - TH);
  }
  for (const r of stepEnds.values()) {
    if (r.n !== 1 || r.yHi - r.yLo < 1e-3) continue;
    gLn.push(r.pt.x * S, r.yLo * S, r.pt.z * S, r.pt.x * S, r.yHi * S, r.pt.z * S);
  }

  // --- パラペット。屋根のまわりに立ち上がる、厚みのある環 ---
  //   ★ 外側は【壁の天端から】立ち上げる。屋根の小口がそこに出ているので、
  //     屋上の高さから立てると壁との間に黒い帯が一周見えてしまう。
  if (r.parapet) {
    // ★ 屋上面（＝直方体の上面）から PARAPET_H だけ立ち上げる。
    const y0 = 0, y1 = PARAPET_H;
    // ⚠️ 環は【外形を内側へ縮めた形との差】。矩形ごとに枠を描くと、L字の
    //   入隅で内側の線が建物の中を横切る。縮めるのは外に面した辺だけ。
    const ins = (q, key) => (
      exposedIntervals(r.rects, q, key).iv.length ? PARAPET_T : 0);
    const inner = r.rects.map((q) => ({
      x0: q.x0 + ins(q, 'w'), z0: q.z0 + ins(q, 's'),
      x1: q.x1 - ins(q, 'e'), z1: q.z1 - ins(q, 'n'),
    }));
    const band = (a2, b2, yb, low) => {
      gPos.push(a2.x, yb, a2.z, b2.x, yb, b2.z, b2.x, y1, b2.z);
      gPos.push(a2.x, yb, a2.z, b2.x, y1, b2.z, a2.x, y1, a2.z);
      gLn.push(a2.x, y1, a2.z, b2.x, y1, b2.z);                // 天端の線
      if (low) gLn.push(a2.x, yb, a2.z, b2.x, yb, b2.z);       // 足元の線
      for (const q of [a2, b2]) gLn.push(q.x, yb, q.z, q.x, y1, q.z);  // 角の縦線
    };
    for (const sg of foot) band(sg.a, sg.b, 0, false);
    // ⚠️ 内側は【屋上の仕上げ面から】。軒高から立てると足元に隙間が残り、
    //   屋上を見下ろしたときにそこだけ抜けて見える。
    for (const sg of footprintSegments(inner)) band(sg.a, sg.b, y0, true);
    // 笠木（天端）。外形の中で、内側へ縮めた形に入らない桝だけを張る。
    const xs = [...new Set([...r.rects, ...inner].flatMap((q) => [q.x0, q.x1]))]
      .sort((u, v) => u - v);
    const zs = [...new Set([...r.rects, ...inner].flatMap((q) => [q.z0, q.z1]))]
      .sort((u, v) => u - v);
    const inAny = (rs, x, z) => rs.some(
      (q) => x > q.x0 && x < q.x1 && z > q.z0 && z < q.z1);
    for (let i = 0; i + 1 < xs.length; i++) {
      for (let j = 0; j + 1 < zs.length; j++) {
        const mx = (xs[i] + xs[i + 1]) / 2, mz = (zs[j] + zs[j + 1]) / 2;
        if (!inAny(r.rects, mx, mz) || inAny(inner, mx, mz)) continue;
        gPos.push(xs[i], y1, zs[j], xs[i + 1], y1, zs[j], xs[i + 1], y1, zs[j + 1]);
        gPos.push(xs[i], y1, zs[j], xs[i + 1], y1, zs[j + 1], xs[i], y1, zs[j + 1]);
      }
    }
  }

  // --- 線 ---
  //   ⚠️ EdgesGeometry には任せない。屋根は破片に割って作っているので、割れ目の
  //     座標がわずかにずれた破片どうしが「隣が無い辺」と判定され、屋根の
  //     【真ん中】に短い線のゴミが残る。外周と稜線を自分で拾って引く。
  const ln = [];
  //   ⚠️ 浮かせる向きは表裏で逆。裏側の線を上へ浮かせると屋根に食われて消える。
  const seg = (a, ya, b, yb, drop, lift) => {
    const d = lift ? (drop ? -LINE_LIFT : LINE_LIFT) : 0;
    ln.push(a.x * S, ya * S - drop + d, a.z * S,
      b.x * S, yb * S - drop + d, b.z * S);
  };
  // (1) 外周（軒先・けらば）。表面・葺き材と下地の境目・軒裏の3本。
  for (const rc of rims) {
    for (const d of [0, ROOF_FINISH, ROOF_THICK]) seg(rc.a, rc.ya, rc.b, rc.yb, d, false);
  }
  // (2) 外周が折れる点の縦線。これが無いと屋根が紙のように見える。
  ln.push(...cornerVerticals(rims));
  // (3) 稜線（棟・隅棟・谷）。
  //   ⚠️ 面の辺をぜんぶ引いてはいけない。屋根面は他の面で切り分けられていて、
  //     【同じ平面どうしの継ぎ目】がたくさんある。そこまで引くと、屋根の上に
  //     意味のない対角線が何本も走る。
  const share = new Map();
  for (const f of result.faces) {
    for (let i = 0; i < f.poly.length; i++) {
      const j = (i + 1) % f.poly.length;
      const a = f.poly[i], b2 = f.poly[j];
      const ka = `${k3(a.x)},${k3(a.z)}`, kb = `${k3(b2.x)},${k3(b2.z)}`;
      const id = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
      const rec = share.get(id);
      if (rec) rec.faces.push(f); else share.set(id, { a, b: b2, faces: [f] });
    }
  }
  const samePlane = (p1, p2) => Math.abs(p1.a - p2.a) < 1e-6
    && Math.abs(p1.b - p2.b) < 1e-6 && Math.abs(p1.c - p2.c) < 1e-6;
  for (const rec of share.values()) {
    if (rec.faces.length < 2) continue;            // 外周は (1) で引いた
    const [f1, f2] = rec.faces;
    if (samePlane(f1.plane, f2.plane)) continue;
    // ★ 高さは【両側の面の高い方】で測る。
    //   ⚠️ 面が覚えている高さをそのまま使うと、段差のある辺（入母屋の打ち切り・
    //     差し掛けの棟）で線が段差の【足元】に落ちる。棟なのに屋根の中へ
    //     沈んだ線が走って見える。
    const la = Math.max(hAt(f1.plane, rec.a), hAt(f2.plane, rec.a));
    const lb = Math.max(hAt(f1.plane, rec.b), hAt(f2.plane, rec.b));
    seg(rec.a, la, rec.b, lb, 0, true);
    // 軒裏にも同じ折れ目がある。無いとのっぺりした白い板に見える。
    seg(rec.a, la, rec.b, lb, ROOF_THICK, true);
  }


  const add = (arr, mat, isRoof) => {
    if (!arr.length) return;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3));
    geo.computeVertexNormals();
    const m = new THREE.Mesh(geo, mat);
    if (isRoof) m.userData.isRoof = true;
    g.add(m);
  };
  add(black, roofMat, true);            // 葺き材（表面＋小口の上の帯）
  add(mid, wallMat, false);             // 葺き材と下地の境目
  add(white, wallMat, false);           // 軒裏＋小口の下の帯
  add(gPos, gableWallMat, false);       // 妻壁
  // ⚠️ 稜線も切り欠きの中は通らない。切らないと、穴の上に線だけが宙に残る。
  const cutMM = cut ? { x0: cut.x0 * S, x1: cut.x1 * S,
    z0: cut.z0 * S, z1: cut.z1 * S } : null;
  const all = [...cutSegs(ln, cutMM), ...gLn];
  if (all.length) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(all, 3));
    g.add(new THREE.LineSegments(geo, edgeMat));
  }
  return g;
}
