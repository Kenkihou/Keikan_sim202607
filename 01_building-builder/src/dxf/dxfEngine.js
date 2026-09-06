// =============================================================================
// dxfEngine — 壁の模型（wallModel の出力）を立体にする
//
//   組み立てるもの
//     ・壁 … 芯線と厚みから直方体。開口のところは腰壁と垂れ壁に切る
//     ・引き違い窓 … 外壁の O-WIN に、枠と障子2枚とガラス
//     ・階段 … 走りは段板、踊り場は1段ぶんの平らな面
//     ・手すり壁 … 走りと走りに挟まれた壁は、段鼻の線に沿って天端が傾く
//     ・屋上面 … 屋根をかけた階は、天端に厚みのない面を1枚
//
//   ★ 線は引きっぱなしでよい。外郭にならない線は【包絡】が落とすので、
//     残るのは形の輪郭だけになる。手で「ここは引く／引かない」を分けない。
//
//   単位は 01 に合わせて mm。この中では建物の足元を y=0 とした相対で組み、
//   呼び出し側が position でずらす。
// =============================================================================
import * as THREE from 'three';

const MAX_RISE = 200;         // 蹴上の上限[mm]。図面に段数が無いときだけ使う
const RAIL_H = 1100;          // 手すり壁の高さ[mm]。段鼻から測る
// 引き違い窓の納まり。01 のモデリング（modelingEngine.js）と同じ値。
const WIN = { M: 40, PR: 20, SD: 40, SI: 20, FW: 30, GT: 20 };

/* 直方体を1つ積む。面（三角形12枚）と、稜線12本。
   ⚠️ ln に null を渡すと面だけ。 */
function pushBox(pos, ln, x0, y0, z0, x1, y1, z1) {
  const P = [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1],
    [x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]];
  const face = (a, b, c, d) => {
    pos.push(...P[a], ...P[b], ...P[c]);
    pos.push(...P[a], ...P[c], ...P[d]);
  };
  face(0, 3, 2, 1); face(4, 5, 6, 7);          // 下・上
  face(0, 1, 5, 4); face(2, 3, 7, 6);          // 手前・奥
  face(1, 2, 6, 5); face(3, 0, 4, 7);          // 右・左
  if (!ln) return;
  const e = (a, b) => ln.push(...P[a], ...P[b]);
  e(0, 1); e(1, 2); e(2, 3); e(3, 0);
  e(4, 5); e(5, 6); e(6, 7); e(7, 4);
  e(0, 4); e(1, 5); e(2, 6); e(3, 7);
}

/* 直方体の集まりから、外郭の稜線だけを残す。
   ★ 稜線のまわりを（稜線に直交する面で）4つに割り、いくつが中身で埋まって
     いるかを見る。4つとも埋まっている＝内部、隣り合う2つだけ＝平らな面の
     途中。どちらも稜線ではない。
   ⚠️ 1本の稜線でも、途中で状態が変わる。箱の切れ目で刻んでから区間ごとに
     見ること。まとめて1回だけ判定すると、交差部の手前まで消えてしまう。 */
function envelopeLines(ln, boxes) {
  const E = 3;                       // mm。壁の厚み(100)より十分小さく
  const inside = (bs, x, y, z) => bs.some((b) => (
    x > b[0] && x < b[3] && y > b[1] && y < b[4] && z > b[2] && z < b[5]));
  const out = [];
  // ⚠️ 同じ線分が二度入ってくる（箱の稜線と穴の縁など）。入口で落としておく。
  const seen = new Set();
  const key = (v) => Math.round(v * 10);
  for (let k = 0; k + 5 < ln.length; k += 6) {
    const p = [ln[k], ln[k + 1], ln[k + 2]];
    const q = [ln[k + 3], ln[k + 4], ln[k + 5]];
    const a6 = [...p.map(key), ...q.map(key)];
    const b6 = [...q.map(key), ...p.map(key)];
    const id = (a6 < b6 ? a6 : b6).join(',');
    if (seen.has(id)) continue;
    seen.add(id);
    // 軸に沿った線分だけを扱う（壁も階段も軸に沿っている）
    let ax = -1;
    for (let i = 0; i < 3; i++) if (Math.abs(q[i] - p[i]) > 1e-6) ax = (ax < 0 ? i : -2);
    if (ax < 0) { out.push(...p, ...q); continue; }
    // ⚠️ 箱の数は建物ぜんぶぶん。線1本ごとに全部の箱を見ると重くなるので、
    //   その線の近くにある箱だけに絞ってから調べる。
    const cand = boxes.filter((b) => (
      b[0] <= Math.max(p[0], q[0]) + E && b[3] >= Math.min(p[0], q[0]) - E
      && b[1] <= Math.max(p[1], q[1]) + E && b[4] >= Math.min(p[1], q[1]) - E
      && b[2] <= Math.max(p[2], q[2]) + E && b[5] >= Math.min(p[2], q[2]) - E));
    const lo = Math.min(p[ax], q[ax]), hi = Math.max(p[ax], q[ax]);
    const cut = [lo, hi];
    for (const b of cand) {
      for (const v of [b[ax], b[ax + 3]]) if (v > lo + 1e-6 && v < hi - 1e-6) cut.push(v);
    }
    cut.sort((a, b) => a - b);
    const P = (ax + 1) % 3, Q = (ax + 2) % 3;
    for (let i = 0; i + 1 < cut.length; i++) {
      if (cut[i + 1] - cut[i] < 1e-6) continue;
      const m = [...p];
      m[ax] = (cut[i] + cut[i + 1]) / 2;
      const qs = [];
      for (const sp of [-1, 1]) {
        for (const sq of [-1, 1]) {
          const t = [...m];
          t[P] += sp * E; t[Q] += sq * E;
          if (inside(cand, t[0], t[1], t[2])) qs.push([sp, sq]);
        }
      }
      const n = qs.length;
      if (n === 0 || n === 4) continue;                 // 空 or 内部
      // 隣り合う2つだけ＝平らな面の途中。符号が片方しか違わない組み合わせ。
      if (n === 2) {
        const [u, v] = qs;
        if ((u[0] === v[0]) !== (u[1] === v[1])) continue;
      }
      const a = [...m], b = [...m];
      a[ax] = cut[i]; b[ax] = cut[i + 1];
      out.push(...a, ...b);
    }
  }
  return out;
}

/* 壁ごとの向き・芯・端。
   ★ 芯線は交点で終わっているので、そのまま箱にすると出隅で【厚みの半分ぶん
     四角く欠ける】。相手の壁に突き当たっている端だけ、厚みの半分だけ伸ばす。
     どの端も伸ばすと、行き止まりの壁が長くなる。
   ⚠️ 立体を組むところと、窓のつまみを置くところで【同じ並び】を見ること。
     別々に出すと、つまみと実際の窓がずれる。 */
function wallsOf(model) {
  const ws = model.walls.map((w) => {
    const alongX = (w.x1 - w.x0) >= (w.z1 - w.z0);
    return { w, alongX, h: w.t / 2,
      a: alongX ? w.x0 : w.z0, b: alongX ? w.x1 : w.z1,
      c: alongX ? (w.z0 + w.z1) / 2 : (w.x0 + w.x1) / 2 };
  });
  const T = 1;
  const onWall = (x, z, o) => (o.alongX
    ? (Math.abs(z - o.c) < T && x > o.a - T && x < o.b + T)
    : (Math.abs(x - o.c) < T && z > o.a - T && z < o.b + T));
  for (const u of ws) {
    for (const [end, v] of [['a', u.a], ['b', u.b]]) {
      const x = u.alongX ? v : u.c, z = u.alongX ? u.c : v;
      if (ws.some((o) => o !== u && onWall(x, z, o))) u[end] += (end === 'a' ? -u.h : u.h);
    }
  }
  return ws;
}

/* その壁の芯線に乗っている開口。src は model.opens の番号。
   ⚠️ 向きと芯の位置の両方を見ること。位置だけだと、交差する壁の開口まで拾う。 */
function opensOn(model, u) {
  const { alongX, a, b, c } = u;
  const T = 1;
  const os = [];
  for (let i = 0; i < model.opens.length; i++) {
    const o = model.opens[i];
    const oX = (o.x1 - o.x0) >= (o.z1 - o.z0);
    if (oX !== alongX) continue;
    const oc = alongX ? (o.z0 + o.z1) / 2 : (o.x0 + o.x1) / 2;
    if (Math.abs(oc - c) > T) continue;
    const oa = alongX ? o.x0 : o.z0;
    const ob = alongX ? o.x1 : o.z1;
    if (ob <= a + 1e-6 || oa >= b - 1e-6) continue;
    os.push({ src: i, a: Math.max(oa, a), b: Math.min(ob, b),
      lo: o.lo, hi: o.hi, kind: o.kind });
  }
  os.sort((p, q) => p.a - q.a);
  return os;
}

/* ★追加：外壁の窓の一覧。図面から起こした階でも、窓を1つずつ選んで
   位置・大きさ・種類を変えられるようにするための入口。
     src … model.opens の番号。書き換えるときはこの番号を使う
     a,b … 壁に沿った窓の両端（wa,wb はその壁の端）
     c,h … 壁の芯と厚みの半分、sgn … 外を向く向き（+1/-1）
   ⚠️ 内壁の窓は入れない。厚 100 では障子が裏へ突き抜ける。 */
export function dxfWindows(model) {
  if (!model || !model.walls || !model.opens) return [];
  const fcx = (model.foot.x0 + model.foot.x1) / 2;
  const fcz = (model.foot.z0 + model.foot.z1) / 2;
  const out = [];
  for (const u of wallsOf(model)) {
    if (!u.w.ext) continue;
    const sgn = Math.sign(u.alongX ? (u.c - fcz) : (u.c - fcx)) || 1;
    for (const o of opensOn(model, u)) {
      if (o.kind !== 'WIN') continue;
      out.push({ src: o.src, alongX: u.alongX, a: o.a, b: o.b,
        wa: u.a, wb: u.b, c: u.c, h: u.h, sgn, lo: o.lo, hi: o.hi,
        type: model.opens[o.src].type || 'sliding',
        dir: u.alongX ? (sgn > 0 ? 'pz' : 'nz') : (sgn > 0 ? 'px' : 'nx') });
    }
  }
  return out;
}

/* 矩形から矩形を抜き、残りを最大4枚の矩形で返す（階段の上り口のぶん）。 */
function rectMinus(r, n) {
  if (!n) return [r];
  const x0 = Math.max(r.x0, n.x0), x1 = Math.min(r.x1, n.x1);
  const z0 = Math.max(r.z0, n.z0), z1 = Math.min(r.z1, n.z1);
  if (x1 - x0 < 1 || z1 - z0 < 1) return [r];
  const out = [];
  if (z0 > r.z0) out.push({ x0: r.x0, x1: r.x1, z0: r.z0, z1: z0 });
  if (z1 < r.z1) out.push({ x0: r.x0, x1: r.x1, z0: z1, z1: r.z1 });
  if (x0 > r.x0) out.push({ x0: r.x0, x1: x0, z0, z1 });
  if (x1 < r.x1) out.push({ x0: x1, x1: r.x1, z0, z1 });
  return out;
}

/* 床板。階段の上り口には穴を開ける。
   ★ 上の階の床板は、下の階の階段が上がってくるところだけ抜く。抜かないと
     階段が床に突き刺さり、上り口が塞がる（05 と同じ考え方）。
   ⚠️ 稜線は【外形と穴の口だけ】。穴のために分けた矩形どうしの継ぎ目に線を
     引くと、床板の途中に意味のない線が走る。
   板の中心を原点、足元を y=0 とした立体を返す。 */
export function buildSlabWithHole(w, d, h, hole, mats) {
  const g = new THREE.Group();
  const full = { x0: -w / 2, x1: w / 2, z0: -d / 2, z1: d / 2 };
  const rs = rectMinus(full, hole);
  const pos = [], ln = [];
  for (const r of rs) pushBox(pos, null, r.x0, 0, r.z0, r.x1, h, r.z1);
  const ring = (r, y) => {
    const P = [[r.x0, r.z0], [r.x1, r.z0], [r.x1, r.z1], [r.x0, r.z1]];
    for (let i = 0; i < 4; i++) {
      const a = P[i], b = P[(i + 1) % 4];
      ln.push(a[0], y, a[1], b[0], y, b[1]);
    }
  };
  const posts = (r) => {
    for (const [x, z] of [[r.x0, r.z0], [r.x1, r.z0], [r.x1, r.z1], [r.x0, r.z1]]) {
      ln.push(x, 0, z, x, h, z);
    }
  };
  // ⚠️ 横線は【天端の1本だけ】。下端にも引くと、1階と2階の境目が板の厚みぶん
  //   離れた2本になって見える（05 と同じ扱い）。縦線は上下の階の隅の線と
  //   ひと続きなので、引かないと隅が板のぶんだけ途切れる。
  ring(full, h); posts(full);
  if (rs.length > 1) {
    const n = { x0: Math.max(hole.x0, full.x0), x1: Math.min(hole.x1, full.x1),
      z0: Math.max(hole.z0, full.z0), z1: Math.min(hole.z1, full.z1) };
    ring(n, h); posts(n);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.computeVertexNormals();
  g.add(new THREE.Mesh(geo, mats.wallMat));
  const lg = new THREE.BufferGeometry();
  lg.setAttribute('position', new THREE.Float32BufferAttribute(ln, 3));
  g.add(new THREE.LineSegments(lg, mats.edgeMat));
  return g;
}

/* 模型を立体にする。
     model  … wallModel の出力（mm・世界座標）
     H      … この階の高さ[mm]。壁が立つ高さ
     opts.deck   … true なら天端に屋上面を1枚張る（屋根をかけた階）
     opts.upperH … 上階の床までの高さ[mm]。階段はここまで上がる（既定は H）
   返り値は THREE.Group。原点は【模型の座標そのまま・足元 y=0】。 */
export function buildDxfFloor(model, H, mats, opts = {}) {
  const g = new THREE.Group();
  if (!model || H <= 0) return g;
  const y0 = 0;
  const deck = !!opts.deck;
  const HW = H;                       // 壁が立つ高さ
  const SH = Math.max(opts.upperH || H, 1);   // 階段が上がる高さ

  const pos = [], ln = [], bxs = [];
  // 窓は1枚ずつ別の塊。{ src, pos, ln, glass, dir } の並び。
  const winParts = [];
  const keep = (x0, ya, z0, x1, yb, z1) => bxs.push([x0, ya, z0, x1, yb, z1]);

  // ---------------------------------------------------------------- 段割り
  // ★ 段割りは【壁より先に】決める。走りに挟まれた壁は手すり壁になり、
  //   その天端が段鼻の線で決まるので、段の高さが要る。
  const sp = (model.stair && model.stair.parts) ? model.stair.parts : [];
  const runs = sp.filter((p) => p.kind === 'run');
  const lands = sp.length - runs.length;
  // ★ 段数は【図面で決まっていればそれを使う】（レイヤ名 S-RUN-7 の数字）。
  //   階高を変えても段数は変わらず、蹴上だけが伸び縮みする。
  const cnt = runs.map((p) => Math.max(0, Math.round(p.steps || 0)));
  const free = cnt.reduce((a, k) => a + (k ? 0 : 1), 0);
  if (free) {
    const fixed = cnt.reduce((a, b) => a + b, 0);
    const nFree = Math.max(free, Math.max(2, Math.ceil(SH / MAX_RISE)) - lands - fixed);
    const tot = runs.reduce((a, p, i) => a + (cnt[i] ? 0 : p.len), 0) || 1;
    const idx = [];
    runs.forEach((p, i) => {
      if (!cnt[i]) { cnt[i] = Math.max(1, Math.floor(nFree * p.len / tot)); idx.push(i); }
    });
    let rest = nFree - idx.reduce((a, i) => a + cnt[i], 0);
    for (let j = 0; rest > 0; j = (j + 1) % idx.length) { cnt[idx[j]]++; rest--; }
  }
  const nRun = cnt.reduce((a, b) => a + b, 0);
  // ⚠️ 蹴上は【実際に積む段数】で割り戻すこと。上限から出した段数で割ると、
  //   端数を配ったぶんだけ最上段が上階の床とずれる。
  const rise = (nRun + lands) ? SH / (nRun + lands) : 0;
  const lvOf = new Map();
  {
    let lv = 0;
    for (const p of sp) { lvOf.set(p, lv); lv += (p.kind === 'run') ? cnt[runs.indexOf(p)] : 1; }
  }
  /* 走りの段鼻の線。走りに沿う座標 t での高さ。 */
  const noseAt = (r, t) => {
    const s0 = r.alongX ? r.x0 : r.z0, s1 = r.alongX ? r.x1 : r.z1;
    const go = r.len / cnt[runs.indexOf(r)];
    const q = Math.min(Math.max(t, s0), s1);
    const n = r.dir > 0 ? (q - s0) / go : (s1 - q) / go;
    return y0 + rise * (lvOf.get(r) + n);
  };

  // ---------------------------------------------------------------- 壁
  // ★ 壁ごとの向き・芯・端。芯線は交点で終わっているので、そのまま箱にすると
  //   出隅で【厚みの半分ぶん四角く欠ける】。相手の壁に突き当たっている端だけ、
  //   厚みの半分だけ伸ばす。どの端も伸ばすと、行き止まりの壁が長くなる。
  const ws = wallsOf(model);
  const T = 1;                       // mm。同じ位置とみなす幅

  // ★ 外壁の窓には【引き違い障子2枚】を入れる。01 のモデリングと同じ納まり。
  //   ⚠️ 内壁には入れない。厚 100 では見込み 100 の障子が裏へ突き抜ける。
  const fcx = (model.foot.x0 + model.foot.x1) / 2;
  const fcz = (model.foot.z0 + model.foot.z1) / 2;
  const sashes = (u, o) => {
    const { alongX, h, c } = u;
    const hi = Math.min(o.hi, HW);
    const wid = o.b - o.a, hgt = hi - o.lo;
    if (wid < 400 || hgt < 400) return;
    const sgn = Math.sign(alongX ? (c - fcz) : (c - fcx)) || 1;   // 外向き
    const cOut = c + sgn * h;
    // ★ 窓は【1枚ずつ別の塊】にする。1つを選んで、位置・大きさ・種類を
    //   変えられるようにするため。まとめて1つの塊にすると、どれを掴んでも
    //   同じものになってしまう。
    const winPos = [], winLn = [], glassPos = [];
    const type = (model.opens[o.src] && model.opens[o.src].type) || 'sliding';
    winParts.push({ src: o.src, pos: winPos, ln: winLn, glass: glassPos,
      dir: alongX ? (sgn > 0 ? 'pz' : 'nz') : (sgn > 0 ? 'px' : 'nx') });
    // 断面の座標：長手 t、外面からの奥行き d、高さ y。d が増えるほど室内側。
    const put = (dst, lns, tA, tB, dA, dB, yA, yB) => {
      const p = cOut - sgn * dA, q = cOut - sgn * dB;
      const lo2 = Math.min(p, q), hi2 = Math.max(p, q);
      if (alongX) pushBox(dst, lns, tA, yA, lo2, tB, yB, hi2);
      else pushBox(dst, lns, lo2, yA, tA, hi2, yB, tB);
    };
    const { M, PR, SD, SI, FW, GT } = WIN;
    const y1 = y0 + o.lo, y2 = y0 + hi;
    put(winPos, winLn, o.a, o.b, -PR, 0, y1, y1 + M);            // 下枠
    put(winPos, winLn, o.a, o.b, -PR, 0, y2 - M, y2);            // 上枠
    put(winPos, winLn, o.a, o.a + M, -PR, 0, y1 + M, y2 - M);    // 縦枠
    put(winPos, winLn, o.b - M, o.b, -PR, 0, y1 + M, y2 - M);
    const wAsm = wid - M * 2;
    const a0 = o.a + M, b0 = o.b - M, yb = y1 + M, yt = y2 - M;
    // ★ FIX は障子が無い。枠の内側にガラスを1枚はめるだけ。
    if (type === 'fix') {
      const dg = SI + SD / 2;
      put(glassPos, null, a0, b0, dg - GT / 2, dg + GT / 2, yb, yt);
      return;
    }
    const wS = (wAsm + FW) / 2;
    // 右が外、左が内（日本の引き違いのふつうの建て方）
    for (const lf of [{ x: b0 - wS, d: SI }, { x: a0, d: SI + SD }]) {
      const L = lf.x, R = lf.x + wS, d0 = lf.d, d1 = lf.d + SD;
      put(winPos, winLn, L, R, d0, d1, yb, yb + FW);             // 下框
      put(winPos, winLn, L, R, d0, d1, yt - FW, yt);             // 上框
      put(winPos, winLn, L, L + FW, d0, d1, yb + FW, yt - FW);   // 縦框
      put(winPos, winLn, R - FW, R, d0, d1, yb + FW, yt - FW);
      const dg = (d0 + d1) / 2;
      put(glassPos, null, L + FW, R - FW, dg - GT / 2, dg + GT / 2, yb + FW, yt - FW);
    }
  };

  /* 走りと走りに挟まれた壁を探す。折り返し階段の中壁がこれにあたる。
     ★ 両側に走りがある壁は、そのまま全高で立てると階段が箱に埋もれて見えない。
       段鼻の線に沿って切り、手すり壁にする。
     ⚠️ 高さは【上の走り】の段鼻から。下の走りで測ると、上の走りを歩く人の
       足元より壁が低くなる。 */
  const railRun = (u) => {
    const side = runs.filter((r) => {
      if (r.alongX !== u.alongX) return false;
      const c0 = u.alongX ? r.z0 : r.x0, c1 = u.alongX ? r.z1 : r.x1;
      if (Math.abs(c1 - (u.c - u.h)) > T && Math.abs(c0 - (u.c + u.h)) > T) return false;
      const a0 = u.alongX ? r.x0 : r.z0, a1 = u.alongX ? r.x1 : r.z1;
      return Math.min(a1, u.b) - Math.max(a0, u.a) > 50;
    });
    if (side.length < 2) return null;
    return side.reduce((p, q) => (lvOf.get(q) > lvOf.get(p) ? q : p));
  };

  for (const u of ws) {
    const { w, alongX, h, a, b, c } = u;
    // ★ この壁の芯線に乗っている開口だけを拾う。
    //   ⚠️ 向きと芯の位置の両方を見ること。位置だけだと、交差する壁の開口まで
    //     拾ってしまう。
    const os = opensOn(model, u);
    const box = (a0, a1, lo, hi) => {
      if (a1 - a0 < 1e-6 || hi - lo < 1e-6) return;
      if (alongX) {
        pushBox(pos, ln, a0, y0 + lo, c - h, a1, y0 + hi, c + h);
        keep(a0, y0 + lo, c - h, a1, y0 + hi, c + h);
      } else {
        pushBox(pos, ln, c - h, y0 + lo, a0, c + h, y0 + hi, a1);
        keep(c - h, y0 + lo, a0, c + h, y0 + hi, a1);
      }
    };

    const rail = os.length ? null : railRun(u);
    if (rail) {
      // --- 手すり壁。天端は段鼻の線に沿って傾く ---
      const s0 = alongX ? rail.x0 : rail.z0, s1 = alongX ? rail.x1 : rail.z1;
      const lo = Math.max(a, s0), hi = Math.min(b, s1);
      if (lo > a + 1e-6) box(a, lo, 0, HW);
      if (hi < b - 1e-6) box(hi, b, 0, HW);
      // ⚠️ 天端は頭打ちにする。段鼻の線をそのまま伸ばすと、最上段の先で
      //   どこまでも高くなる。
      const capY = y0 + Math.max(HW, opts.railCap || 0);
      const topAt = (t) => Math.min(noseAt(rail, t) + RAIL_H, capY);
      const yA = topAt(lo), yB = topAt(hi);
      if (hi - lo > 1e-6) {
        const V = (t, cc, y) => (alongX ? [t, y, cc] : [cc, y, t]);
        const Pv = [V(lo, c - h, y0), V(hi, c - h, y0), V(hi, c + h, y0), V(lo, c + h, y0),
          V(lo, c - h, yA), V(hi, c - h, yB), V(hi, c + h, yB), V(lo, c + h, yA)];
        const face = (i, j, k2, l) => {
          pos.push(...Pv[i], ...Pv[j], ...Pv[k2], ...Pv[i], ...Pv[k2], ...Pv[l]);
        };
        face(0, 3, 2, 1); face(4, 5, 6, 7);
        face(0, 1, 5, 4); face(2, 3, 7, 6);
        face(1, 2, 6, 5); face(3, 0, 4, 7);
        const e = (i, j) => ln.push(...Pv[i], ...Pv[j]);
        e(0, 1); e(1, 2); e(2, 3); e(3, 0);
        e(4, 5); e(5, 6); e(6, 7); e(7, 4);
        e(0, 4); e(1, 5); e(2, 6); e(3, 7);
        // 包絡には段ごとの箱で近似して渡す（傾いた面はそのまま扱えない）
        const kk = cnt[runs.indexOf(rail)];
        for (let i = 0; i < kk; i++) {
          const t0 = lo + (hi - lo) * i / kk, t1 = lo + (hi - lo) * (i + 1) / kk;
          const yt = Math.max(topAt(t0), topAt(t1));
          if (alongX) keep(t0, y0, c - h, t1, yt, c + h);
          else keep(c - h, y0, t0, c + h, yt, t1);
        }
      }
      continue;
    }

    let cur = a;
    for (const o of os) {
      if (w.ext && o.kind === 'WIN') sashes(u, o);
      box(cur, o.a, 0, HW);                          // 開口の手前まで、まるごと
      box(o.a, o.b, 0, Math.min(o.lo, HW));          // 腰壁（窓の下）
      box(o.a, o.b, Math.min(o.hi, HW), HW);         // 垂れ壁
      cur = o.b;
    }
    box(cur, b, 0, HW);
  }

  // ---------------------------------------------------------------- 階段
  if (sp.length && runs.length) {
    const sbox = (x0, z0, x1, z1, yt) => {
      pushBox(pos, ln, x0, y0, z0, x1, yt, z1);
      keep(x0, y0, z0, x1, yt, z1);
    };
    for (const p of sp) {
      const lv = lvOf.get(p);
      if (p.kind !== 'run') {         // 踊り場：まるごと1つの箱
        sbox(p.x0, p.z0, p.x1, p.z1, y0 + rise * (lv + 1));
        continue;
      }
      const k = cnt[runs.indexOf(p)];
      const go = p.len / k;
      for (let i = 1; i <= k; i++) {
        // ⚠️ 上り方向が逆なら、段の並びも逆から積む。
        const u0 = p.dir > 0 ? (i - 1) * go : p.len - i * go;
        const u1 = u0 + go;
        const yt = y0 + rise * (lv + i);
        if (p.alongX) sbox(p.x0 + u0, p.z0, p.x0 + u1, p.z1, yt);
        else sbox(p.x0, p.z0 + u0, p.x1, p.z0 + u1, yt);
      }
    }
  }

  // ---------------------------------------------------------------- 屋上面
  // ★ 屋根をかけた階には、天端に厚みのない面を1枚張る。屋根はこの上に載る。
  let outLn = ln;
  const dy = y0 + HW;
  if (deck) {
    const f = model.foot;
    pos.push(f.x0, dy, f.z0, f.x1, dy, f.z0, f.x1, dy, f.z1);
    pos.push(f.x0, dy, f.z0, f.x1, dy, f.z1, f.x0, dy, f.z1);
  }
  // ⚠️ 天端と同じ高さの横線は落とす。
  //   ・屋根をかけた階 … 落とさないと、間仕切りの【壁の小口】が屋上いっぱいに
  //     割り付けられて見える。縦線は屋上面の下に隠れる。
  //   ・上に階が載る階 … 壁の天端と床板の下端で【同じところに線が2本】になる。
  //     1階と2階の境目は、床板の天端の1本だけで仕切る（05 と同じ）。
  if (deck || opts.stacked) {
    outLn = [];
    for (let i = 0; i + 5 < ln.length; i += 6) {
      if (Math.abs(ln[i + 1] - dy) < 1e-6 && Math.abs(ln[i + 4] - dy) < 1e-6) continue;
      for (let k = 0; k < 6; k++) outLn.push(ln[i + k]);
    }
  }

  // ---------------------------------------------------------------- 束ねる
  const addMesh = (arr, mat) => {
    if (!arr.length) return;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3));
    geo.computeVertexNormals();
    g.add(new THREE.Mesh(geo, mat));
  };
  addMesh(pos, mats.wallMat);
  // ★ 窓は1枚ずつ、選べる塊として置く。札（userData）で「どの窓か」が分かる。
  //   ⚠️ 建物の id は呼び出し側（main.js）が付ける。ここでは番号と向きだけ。
  for (const wp of winParts) {
    const tag = { isDeco: true, type: 'dxfwin', index: wp.src, dir: wp.dir };
    const put = (arr, mat, isLine) => {
      if (!arr.length) return;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3));
      if (!isLine) geo.computeVertexNormals();
      const m = isLine ? new THREE.LineSegments(geo, mat) : new THREE.Mesh(geo, mat);
      m.userData = { ...tag };
      g.add(m);
    };
    put(wp.pos, mats.sashMat, false);
    put(wp.glass, mats.glassMat, false);
    // 窓の稜線は包絡に掛けない（枠も障子も稜線がすべて要る）。
    put(wp.ln, mats.edgeMat, true);
  }
  const lines = envelopeLines(outLn, bxs);
  if (lines.length) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(lines, 3));
    g.add(new THREE.LineSegments(geo, mats.edgeMat));
  }
  return g;
}
