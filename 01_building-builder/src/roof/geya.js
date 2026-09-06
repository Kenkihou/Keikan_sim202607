// =============================================================================
// geya — 下屋（したや）を、大屋根と同じ流儀のつまみで触れるようにする道具
//
//   ★ 下屋の【形そのもの】は modelingEngine が作る。ここは触らない。
//     この本は「いま出来ている下屋の、どこを掴めばどの寸法が動くか」を
//     取り出すだけの本。形の作り方を二重に持つと、必ず食い違う。
//
//   【座標】
//     すべて b の【上面の中心】を原点にした mm。modelingEngine の skirtGroup
//     （position = 階の天端）と同じ原点なので、そのまま重ねられる。
//
//   【高さ】
//     下屋の面の高さは、どこを測っても【勾配に比例】する。
//       平入り/寄棟 … 軒先 -軒の出×勾配 → 内側 max_out×勾配 の直線
//       切妻       … getRY が全部 slope 倍
//     だから「勾配 1 のときの高さ K」を出しておけば、実際の高さは K×勾配、
//     逆に高さから勾配を解くのも 勾配 = 高さ / K で済む。大屋根の定規と
//     同じ仕掛けが、そのまま使える。
// =============================================================================

export const GEYA_MAX = 2000;   // 軒の出・ケラバの上限[mm]
export const GEYA_SNAP = 50;    // 刻み[mm]

// 下屋が出る向き。modelingEngine の out_nx/px/nz/pz と同じ並び。
export const GEYA_DIRS = ['nx', 'px', 'nz', 'pz'];
// その向きの外向き（x, z）。
export const GEYA_OUT_DIR = { nx: [-1, 0], px: [1, 0], nz: [0, -1], pz: [0, 1] };
export const GEYA_LABEL = { nx: '左', px: '右', nz: '奥', pz: '手前' };

// modelingEngine が使っている定数。⚠️ 向こうと同じ値でなければならない。
const BACK_DIST = 300;          // ケラバの折り返しが内側へ入る距離[mm]
const T_ROOF = 200;             // 屋根の厚み（下層100＋上層100）[mm]

const isGableType = (t) => (t === '妻入り/切妻1' || t === '切妻2');

/* いまの下屋の「読み方」一式。無ければ null。 */
export function geyaArgs(b) {
  const lr = b && b.lowerRoof;
  if (!lr) return null;
  const out = {
    nx: lr.out_nx || 0, px: lr.out_px || 0,
    nz: lr.out_nz || 0, pz: lr.out_pz || 0,
  };
  const maxOut = Math.max(out.nx, out.px, out.nz, out.pz);
  if (maxOut <= 0) return null;              // 上に載る階が無い＝下屋は出ない
  const type = lr.type || '平入り/寄棟';
  const gable = isGableType(type);
  const isCorner = (out.nx > 0 || out.px > 0) && (out.nz > 0 || out.pz > 0);
  // ⚠️ 棟の向きの決め方は modelingEngine と【同じ順番】で書くこと。
  let isGableX = false;
  if (gable) {
    if (type === '切妻2') isGableX = false;
    else if (isCorner) isGableX = true;
    else if (out.nz > 0 || out.pz > 0) isGableX = false;
    else isGableX = true;
  }
  const s = (lr.slope !== undefined ? lr.slope : 4) / 10;
  const e = lr.eaves !== undefined ? lr.eaves : 600;
  const k = lr.keraba !== undefined ? lr.keraba : 300;
  const w2 = b.w / 2, d2 = b.d / 2;

  // 辺ごとの「外へ出る量」と、それがどのパラメータか。
  const ov = {}, pname = {}, role = {};
  if (gable) {
    const el = lr.eaves_l !== undefined ? lr.eaves_l : e;
    const er = lr.eaves_r !== undefined ? lr.eaves_r : e;
    const kl = lr.keraba_l !== undefined ? lr.keraba_l : k;
    const kr = lr.keraba_r !== undefined ? lr.keraba_r : k;
    if (isGableX) {
      ov.nz = el; ov.pz = er; ov.nx = kl; ov.px = kr;
      pname.nz = 'eaves_l'; pname.pz = 'eaves_r';
      pname.nx = 'keraba_l'; pname.px = 'keraba_r';
      role.nz = role.pz = 'eave'; role.nx = role.px = 'keraba';
    } else {
      ov.nx = el; ov.px = er; ov.nz = kl; ov.pz = kr;
      pname.nx = 'eaves_l'; pname.px = 'eaves_r';
      pname.nz = 'keraba_l'; pname.pz = 'keraba_r';
      role.nx = role.px = 'eave'; role.nz = role.pz = 'keraba';
    }
  } else {
    // ★ 寄棟の下屋は、軒の出が【その辺の掛かり幅の比】で縮む。
    //   ⚠️ ここを一定にしてはいけない。modelingEngine がそう描いている。
    for (const d of GEYA_DIRS) {
      // ★ ケラバは辺ごとに持つ。指定が無ければ従来の1つの値に従う。
      //   ⚠️ 1つの値のままだと、片側のバーを引いたときに反対側まで動く。
      const kd = lr['keraba_' + d];
      ov[d] = out[d] > 0 ? e * (out[d] / maxOut)
        : ((typeof kd === 'number') ? Math.max(0, kd) : k);
      pname[d] = out[d] > 0 ? 'eaves' : ('keraba_' + d);
      role[d] = out[d] > 0 ? 'eave' : 'keraba';
    }
  }

  const rOffset = lr.ridgeOffset || 0;
  /* 勾配 1 のときの屋根面の高さ。切妻のときだけ使う（getRY の写し）。 */
  const gableK = (x, z) => {
    if (isGableX) {
      const peak = d2 + Math.abs(rOffset);
      const dist = z - rOffset;
      if (rOffset >= d2 - 0.01 && dist > 0) return peak + dist;
      if (rOffset <= -d2 + 0.01 && dist < 0) return peak + Math.abs(dist);
      return peak - Math.abs(dist);
    }
    const peak = w2 + Math.abs(rOffset);
    const dist = x - rOffset;
    if (rOffset >= w2 - 0.01 && dist > 0) return peak + dist;
    if (rOffset <= -w2 + 0.01 && dist < 0) return peak + Math.abs(dist);
    return peak - Math.abs(dist);
  };

  return { b, lr, type, gable, isGableX, isCorner, out, maxOut, s, e, k,
    ov, pname, role, rOffset, w2, d2, gableK };
}

/* 辺 d の壁の位置（外向きに正）。 */
const wallOf = (a, d) => (d === 'nx' ? -a.w2 : d === 'px' ? a.w2
  : d === 'nz' ? -a.d2 : a.d2);
const along = (d) => (d === 'nx' || d === 'px') ? 'z' : 'x';

/* その辺の外側の線（軒先／ケラバ先）の位置。 */
const lineOf = (a, d) => {
  const s = (d === 'nx' || d === 'nz') ? -1 : 1;
  return wallOf(a, d) + s * a.ov[d];
};

/* 平入り/寄棟のとき、辺 d の面の「軒先から u だけ内側」の高さ（勾配 1）。 */
function hipK(a, d, u) {
  const L = a.out[d] + a.ov[d];
  if (L <= 1e-6) return 0;
  return -a.e + u * (a.maxOut + a.e) / L;
}

/* その点の屋根面の高さ（勾配 1）。掴む場所を決めるのに使う。 */
function kAt(a, d, u, cross) {
  if (a.gable) {
    const s = (d === 'nx' || d === 'nz') ? -1 : 1;
    const p = lineOf(a, d) - s * u;
    return (along(d) === 'z') ? a.gableK(p, cross) : a.gableK(cross, p);
  }
  return hipK(a, d, u);
}

/* 軒先・ケラバのバーを置く場所。辺ごとに1本。
   ★ 大屋根と同じ見た目・同じ操作にする。掴んで外へ引けば出る。
   ⚠️ 屋根が届いていない辺には置かない。掴めるのに何も起きないバーになる。 */
export function geyaBars(b) {
  const a = geyaArgs(b);
  if (!a || a.s <= 0) return [];
  const W = 260;                      // 帯の幅[mm]（大屋根と同じ）
  const bars = [];
  for (const d of GEYA_DIRS) {
    const isEave = a.out[d] > 0;
    // ケラバ側は、直交する下屋の折り返しがあるところにだけ出る。
    let span = null, pSel = null;
    if (isEave) {
      // 辺いっぱい。両端は直交する辺の出のぶんまで伸びる。
      const [p0, p1] = (along(d) === 'z') ? ['nz', 'pz'] : ['nx', 'px'];
      span = [lineOf(a, p0), lineOf(a, p1)];
    } else {
      // いちばん長い折り返しを選ぶ。
      const [p0, p1] = (along(d) === 'z') ? ['nz', 'pz'] : ['nx', 'px'];
      let best = null;
      for (const p of [p0, p1]) {
        if (a.out[p] <= 0) continue;
        const sg = (p === 'nx' || p === 'nz') ? -1 : 1;
        const inner = wallOf(a, p) - sg * (a.out[p] + BACK_DIST);
        const outer = lineOf(a, p);
        const iv = [Math.min(inner, outer), Math.max(inner, outer)];
        if (!best || iv[1] - iv[0] > best[1] - best[0]) { best = iv; pSel = p; }
      }
      if (!best) continue;
      span = best;
    }
    // その辺のバーの高さ。
    //   ★ 軒先は【その辺の面】が決める。内側へ入るほど勾配なりに上がる。
    //   ★ ケラバは【直交する面】が決める。ケラバを横切っても高さは変わらず、
    //     ケラバに沿って（＝直交する面の流れに沿って）上下する。
    //     ⚠️ ここを軒先と同じ式で測ると、その辺の掛かり幅が 0 なので勾配が
    //       跳ね上がり、バーが屋根からはるか上へ飛び出す。
    const hOf = a.gable ? ((u, c) => kAt(a, d, u, c))
      : (isEave ? ((u) => hipK(a, d, u))
        : ((u, c) => {
          const sg = (pSel === 'nx' || pSel === 'nz') ? -1 : 1;
          return hipK(a, pSel, (lineOf(a, pSel) - c) * sg);
        }));
    const lo = Math.min(span[0], span[1]), hi = Math.max(span[0], span[1]);
    if (hi - lo < 200) continue;
    const m = (lo + hi) / 2, half = (hi - lo) / 3;   // 真ん中の3分の2
    const c0 = m - half, c1 = m + half;
    const line = lineOf(a, d);
    const [dx, dz] = GEYA_OUT_DIR[d];
    const pt = (cross, u) => {
      const x = (along(d) === 'z') ? line - dx * u : cross;
      const z = (along(d) === 'z') ? cross : line - dz * u;
      return { x, z, y: hOf(u, cross) * a.s + T_ROOF };
    };
    bars.push({ dir: d, role: a.role[d], param: a.pname[d], out: a.ov[d],
      a: pt(c0, 0), b: pt(c1, 0), ia: pt(c0, W), ib: pt(c1, W) });
  }
  return bars;
}

/* 勾配の定規を置く場所。いちばん広く掛かっている面に1つ。
   ★ 高さ = 勾配 × den なので、掴んだ高さから勾配をそのまま解ける。 */
export function geyaSlopeHandle(b) {
  const a = geyaArgs(b);
  if (!a || a.s <= 0) return null;
  // ★ 定規を立てるのは【屋根が流れている向き】の辺。
  //   ⚠️ ケラバ（棟と平行な辺）に立てると、屋根が下っていない向きへ定規が
  //     傾いて、面から浮いて見える。切妻では軒先の辺だけを選ぶこと。
  let cand = GEYA_DIRS.filter((q) => a.role[q] === 'eave');
  if (!cand.length) cand = GEYA_DIRS.slice();
  let d = null, bestOut = -1;
  for (const q of cand) if (a.out[q] > bestOut) { bestOut = a.out[q]; d = q; }
  if (!d) return null;
  const line = lineOf(a, d);
  const [dx, dz] = GEYA_OUT_DIR[d];
  const [p0, p1] = (along(d) === 'z') ? ['nz', 'pz'] : ['nx', 'px'];
  // 定規を置く「横の位置」。
  //   その辺に下屋が掛かっていれば辺の真ん中。掛かっていなければ、直交する
  //   下屋の帯の真ん中（そこにしか屋根が無い）。
  let cross = (lineOf(a, p0) + lineOf(a, p1)) / 2;
  if (a.out[d] <= 0) {
    let best = null;
    for (const p of [p0, p1]) {
      if (a.out[p] <= 0) continue;
      const sg = (p === 'nx' || p === 'nz') ? -1 : 1;
      const inner = wallOf(a, p) - sg * a.out[p];
      const outer = lineOf(a, p);
      const iv = [Math.min(inner, outer), Math.max(inner, outer)];
      if (!best || iv[1] - iv[0] > best[1] - best[0]) best = iv;
    }
    if (!best) return null;
    cross = (best[0] + best[1]) / 2;
  }
  // 軒先から内側へどこまで屋根があるか。
  //   掛かっていれば上の階の壁まで。掛かっていなければ建物の反対側まで。
  const halfSpan = (along(d) === 'z') ? a.w2 : a.d2;
  const L = a.out[d] > 0 ? (a.out[d] + a.ov[d])
    : (2 * halfSpan + a.ov[d] + a.ov[d === p0 ? p1 : p0]);
  // ★ 置くのは【軒先寄りではなく、そこそこ高いところ】。
  //   ⚠️ 軒先の近くは高さがほとんど無いので、そこで勾配を解くと画面 1mm の
  //     動きで勾配が何寸も飛ぶ。高さ（＝割る数）が十分に取れる場所を選ぶ。
  const want = Math.max(300, a.maxOut * 0.4);
  let u = L * 0.9, den = kAt(a, d, u, cross);
  for (const f of [0.5, 0.6, 0.7, 0.8, 0.9]) {
    const k = kAt(a, d, L * f, cross);
    if (k >= want) { u = L * f; den = k; break; }
  }
  if (den < 200) return null;            // ここで解くと勾配が跳ねる
  const x = (along(d) === 'z') ? line - dx * u : cross;
  const z = (along(d) === 'z') ? cross : line - dz * u;
  return { x, z, y: den * a.s + T_ROOF, den, dir: d, slope: a.s };
}

/* 下屋の中身を読み上げる。[項目, 値] の並び。大屋根の情報パネルと同じ形。 */
export function geyaInfo(b) {
  const a = geyaArgs(b);
  if (!a) return null;
  const rows = [];
  const add = (k, v) => rows.push([k, v]);
  const M = (mm) => (mm / 1000).toFixed(2);
  add('屋根形', a.gable
    ? `切妻（棟：${a.isGableX ? '東西' : '南北'}）` : '寄棟（平入り）');
  const sides = GEYA_DIRS.filter((d) => a.out[d] > 0)
    .map((d) => `${GEYA_LABEL[d]} ${Math.round(a.out[d])}`);
  add('掛かる幅', sides.join(' / ') + ' mm');
  add('勾配', `${(a.s * 10).toFixed(1)} 寸`);
  const grp = (r) => GEYA_DIRS.filter((d) => a.role[d] === r)
    .map((d) => `${GEYA_LABEL[d]} ${Math.round(a.ov[d])}`);
  const ge = grp('eave'), gk = grp('keraba');
  if (ge.length) add('軒の出', ge.join(' / ') + ' mm');
  if (gk.length) add('ケラバ', gk.join(' / ') + ' mm');
  if (a.gable) add('棟の位置', `${a.rOffset === 0 ? '中央'
    : `${a.rOffset > 0 ? '＋' : '−'}${Math.abs(Math.round(a.rOffset))} mm`}`);
  // 高さは【この階の天端】から測る。屋根の厚みも足して、見えている面で読む。
  const foot = (b.y || 0) + b.h;
  add('階の天端', `${M(foot)} m`);
  add('軒先', `${M(foot - a.e * a.s + T_ROOF)} m`);
  add('いちばん高いところ', `${M(foot + a.maxOut * a.s + T_ROOF)} m`);
  return rows;
}
