// =============================================================================
// para — パラペット修景屋根を、大屋根・下屋と同じつまみで触れるようにする道具
//
//   ★ 形そのものは modelingEngine が作る。ここは「どこを掴めばどの寸法が
//     動くか」を取り出すだけ。⚠️ 形の作り方を二重に持たないこと。
//
//   【断面】（原点はこの階の天端。y=0 が屋上の床）
//     外へ e_out 出た軒先から、勾配なりに上がって棟（壁から max_ridge 内側）へ。
//     そこから内側へ下って、in_px のところで切れて中庭になる。
//     パラペットの立ち上がりは pHeight。屋根の帯はその上に載る。
//
//       高さ h(u) = pHeight + (u − e_out)×勾配        （u は軒先からの距離）
//     ⚠️ 勾配に比例していない（pHeight のぶん下駄を履いている）ので、
//       勾配を解くときは pHeight を引いてから割ること。
// =============================================================================

export const PARA_MAX_OUT = 2000;    // 外方向の出の上限[mm]
export const PARA_SNAP = 50;         // 刻み[mm]
export const PARA_H_MIN = 150;       // パラペットの立ち上がりの下限[mm]
export const PARA_H_MAX = 1000;      // 同・上限[mm]

export const PARA_DIRS = ['nx', 'px', 'nz', 'pz'];
export const PARA_OUT_DIR = { nx: [-1, 0], px: [1, 0], nz: [0, -1], pz: [0, 1] };
export const PARA_LABEL = { nx: '左', px: '右', nz: '奥', pz: '手前' };

const T_ROOF = 250;      // 帯の厚み（白100＋黒150）[mm]。modelingEngine と同じ。

const along = (d) => (d === 'nx' || d === 'px') ? 'z' : 'x';
const sgnOf = (d) => (d === 'nx' || d === 'nz') ? -1 : 1;

/* いまのパラペット修景屋根の読み方一式。無ければ null。 */
export function paraArgs(b) {
  if (!b.roof || b.roof.type !== 'パラペット修景') return null;
  const p = b.roof.params && b.roof.params['パラペット修景'];
  if (!p) return null;
  const w2 = b.w / 2, d2 = b.d / 2;
  const s = (p.slope || 0) / 10;
  const pH = p.pHeight !== undefined ? p.pHeight : 300;
  const out = Math.max(0, p.out_px || 0);
  const maxIn = Math.min(p.in_px || 0, w2, d2);
  const ridgeT = p.ridge_dist !== undefined ? p.ridge_dist : maxIn / 2;
  const ridge = Math.min(ridgeT, maxIn);
  const yOT = pH - out * s + T_ROOF;
  const yPT = pH + ridge * s + T_ROOF;
  let endDist = maxIn - ridge;
  let yEB = (pH + ridge * s) - endDist * s;
  if (yEB < 0 && s > 1e-9) { yEB = 0; endDist = (pH + ridge * s) / s; }
  const yET = yEB + T_ROOF;
  return { b, p, w2, d2, s, pH, out, maxIn, ridge, endDist,
    yOT, yPT, yET,
    // 外側の軒先／棟／内側の端の位置（壁からの符号つき距離ではなく実座標）
    lineOut: { nx: -(w2 + out), px: w2 + out, nz: -(d2 + out), pz: d2 + out },
    linePeak: { nx: -(w2 - ridge), px: w2 - ridge,
      nz: -(d2 - ridge), pz: d2 - ridge },
    lineEnd: { nx: -(w2 - ridge - endDist), px: w2 - ridge - endDist,
      nz: -(d2 - ridge - endDist), pz: d2 - ridge - endDist } };
}

/* つまみを置く場所。大屋根・下屋と同じ道具立てに揃える。
     bars   … 黄色い帯。外側＝外方向の出、内側＝内方向の総寸法。
     ridge  … 橙の球。棟の水平位置。
     slope  … 赤い定規。笠木勾配。
     height … 緑の球。パラペットの立ち上がり。 */
export function paraParts(b) {
  const a = paraArgs(b);
  if (!a) return null;
  const W = 260;
  const bars = [];
  for (const d of PARA_DIRS) {
    const sg = sgnOf(d);
    const az = along(d) === 'z';
    const [p0, p1] = az ? ['nz', 'pz'] : ['nx', 'px'];
    // --- 外側の軒先 ---
    {
      const lo = a.lineOut[p0], hi = a.lineOut[p1];
      const m = (lo + hi) / 2, half = (hi - lo) / 3;
      const pt = (c, u) => ({
        x: az ? a.lineOut[d] - sg * u : c,
        z: az ? c : a.lineOut[d] - sg * u,
        y: a.yOT + u * a.s,
      });
      bars.push({ kind: 'out', dir: d, param: 'out_px', value: a.out, sign: 1,
        a: pt(m - half, 0), b: pt(m + half, 0),
        ia: pt(m - half, W), ib: pt(m + half, W) });
    }
    // --- 内側の端（中庭のふち） ---
    //   ⚠️ 内へ引くほど帯が広がる。外向きと符号が逆。
    if (a.maxIn > 1) {
      const lo = a.lineEnd[p0], hi = a.lineEnd[p1];
      if (hi - lo > 400) {
        const m = (lo + hi) / 2, half = (hi - lo) / 3;
        const pt = (c, u) => ({
          x: az ? a.lineEnd[d] + sg * u : c,
          z: az ? c : a.lineEnd[d] + sg * u,
          y: a.yET + u * a.s,
        });
        bars.push({ kind: 'in', dir: d, param: 'in_px', value: a.maxIn, sign: -1,
          a: pt(m - half, 0), b: pt(m + half, 0),
          ia: pt(m - half, W), ib: pt(m + half, W) });
      }
    }
  }
  // --- 棟の位置。手前の辺の真ん中に1つ。
  const ridge = { x: 0, z: a.linePeak.pz, y: a.yPT,
    dir: 'pz', param: 'ridge_dist', value: a.ridge, sign: -1 };
  // --- 笠木勾配。外側の下り面の上に立てる。
  //   高さ = (pHeight + 厚み) + (u − 出)×勾配 なので、y0 と den はこの形。
  //   ⚠️ この屋根は流れが短い。高さの差が取れないところで勾配を解くと、
  //     画面 1mm の動きで何寸も飛ぶ。壁を境に【外へ出た側】と【棟までの側】の
  //     長いほうへ定規を置く。
  //     ・棟側が長い … 棟のところ。上へ引くと急になる。
  //     ・外側が長い … 軒先のところ。勾配が急になるほど軒先は【下がる】ので、
  //       割る数を負に取る。下へ引くと急になり、これはこれで理にかなっている。
  let slope = null;
  {
    const useRidge = a.ridge >= a.out;
    const den = useRidge ? a.ridge : -a.out;
    if (Math.abs(den) >= 250) {
      const u = useRidge ? (a.out + a.ridge) : 0;
      slope = { x: 0, z: a.lineOut.pz - u, y: a.pH + T_ROOF + den * a.s,
        y0: a.pH + T_ROOF, den, dir: 'pz', slope: a.s };
    }
  }
  // --- パラペットの立ち上がり。屋上の真ん中より少しずらして、笠木の高さに。
  //   ⚠️ ちょうど真ん中は押し引きの青い板と重なって掴めない。
  const height = { x: 0, z: Math.min(a.w2, a.d2) * 0.3, y: a.pH, value: a.pH };
  return { bars, ridge, slope, height, args: a };
}

/* パラペット修景屋根の中身を読み上げる。[項目, 値] の並び。 */
export function paraInfo(b) {
  const a = paraArgs(b);
  if (!a) return null;
  const rows = [];
  const add = (k, v) => rows.push([k, v]);
  const M = (mm) => (mm / 1000).toFixed(2);
  add('屋根形', 'パラペット修景');
  add('外形', `${(a.b.w / 1000).toFixed(1)} × ${(a.b.d / 1000).toFixed(1)} m`);
  add('パラペット高', `${Math.round(a.pH)} mm`);
  add('笠木勾配', `${(a.s * 10).toFixed(1)} 寸`);
  add('外への出', `${Math.round(a.out)} mm`);
  add('内への寸法', `${Math.round(a.maxIn)} mm`);
  add('棟の位置', `壁から ${Math.round(a.ridge)} mm`);
  add('軒裏', a.p.flatEaves ? '水平' : '勾配なり');
  const foot = (b.y || 0) + b.h;
  add('階の天端', `${M(foot)} m`);
  add('軒先', `${M(foot + a.yOT)} m`);
  add('棟', `${M(foot + a.yPT)} m`);
  return rows;
}
