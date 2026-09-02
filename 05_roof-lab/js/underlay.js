// =============================================================================
// underlay — DXF を「下絵」として3D空間に敷く
//
//   【手順】
//     ① シートの DXF を落とし、そこから【平面図だけ】を切り出して地面に敷く
//     ② ユーザーが壁を押し引きして高さを与える（1層でも複数層でも）
//     ③ モデルの面をクリックして選び、そこへ立面図を囲って貼る
//        （最上部は軒の出などが写り込むので、使う高さまでを囲みで決める）
//     ④ 屋根は DXF に頼らず、ユーザーが作図する
//
//   ⚠️ 立面図に「南」「東」といった方角を割り当てるのはやめた。方角を取り違えると
//     幅を合わせようとして縦横まとめて拡縮され、高さまで狂う（実際に起きた）。
//     【どの面に貼るか】を目で選ばせれば、取り違えようがない。
// =============================================================================
import * as THREE from 'three';
import { decodeDXF, parseDXF, bboxOf, clusterPolys, stitchLoops, aciColor } from './dxf.js';

const el = (id) => document.getElementById(id);

let sheet = null;        // { name, polys, texts, clusters }
let gapRatio = 0.008;    // かたまりに割るときの間隔（シートの長辺に対する割合）
let plan = null;         // { polys, layers, bbox, off, hidden }
const pastes = [];       // 面に貼った立面図
let group = null;
let scale = 0.001;       // 図面の単位 → m
let onTop = true;
let snapOn = true;
let snapX = [], snapZ = [];
let pickFaces = null;    // main.js が入れる「面を選ばせる」関数
let setFootprint = null; // main.js が入れる「外形をこの矩形にする」関数
let setWalls = null;     // main.js が入れる「壁の模型を渡す」関数
let floorY = () => 0;    // main.js が入れる「いまの階の床の高さ」
// ★ 階ごとに貼り付けた平面図。各階の床の高さに敷く。
//   ⚠️ 平面図を1枚しか持たないと、2階の図面を読んだ瞬間に1階の下絵が消える。
//     階を積むには、階の数だけ下絵が要る。
const applied = [];      // [{ polys, bbox, off, hidden, hiddenC, y }]
let fitted = false;      // 読み込み後に一度だけ外形を平面へ合わせたか

const PLAN_COLOR = 0x2f6fb5;
const PLAN_DONE = 0x9ec3e8;   // 貼り付け済みの階（いま触っていない）
const ELEV_COLOR = 0x555555;

const mats = new Map();
function matOf(color) {
  const k = `${color}:${onTop}`;
  if (!mats.has(k)) {
    mats.set(k, new THREE.LineBasicMaterial({
      color, transparent: true, opacity: onTop ? 0.85 : 1, depthTest: !onTop,
    }));
  }
  return mats.get(k);
}

// -----------------------------------------------------------------------------
// 平面図
// -----------------------------------------------------------------------------
/* 位置合わせの基準にする線。外形レイヤがあればそれだけを使う。
   ⚠️ 図面ぜんぶの外接矩形で合わせてはいけない。寸法線や室名が外へはみ出して
     いるだけで中心がずれ、下絵が建物ごと横にずれる。 */
/* いま見えている線だけを返す。レイヤでも線色でも絞れる。
   ★ Jw_cad から来た図面は全部が同じレイヤということが多い。そのときは
     「外壁だけ線色を変える」だけで絞れるようにしておく。 */
function shown(d) {
  return d.polys.filter((q) => !d.hidden.has(q.layer) && !d.hiddenC.has(q.color));
}
function anchorPolys(d) {
  const nm = d.layers.find((l) => /outline|外形/i.test(l));
  const src = nm ? d.polys.filter((q) => q.layer === nm && !d.hiddenC.has(q.color))
    : shown(d);
  return src.length ? src : d.polys;
}

/* 平面図の点を世界座標へ。
   ★ 図面の +Y は北。世界では +z が北、そして【東は −x】。
     ⚠️ three.js は右手系で、画面の右は cross(前方, 上) で決まる。北を画面上にして
       真上から見ると +x は画面左に出る。ここを +x＝東と取り違えると、
       平面も立面もまとめて左右が反転する。 */
/* その平面図を置くときの原点。
   ★ 通り芯があれば【いちばん小さい通り芯（X1・Y1）】を原点にする。
     階ごとに外形が違っても通り芯は同じ位置なので、これだけで階が揃う。
   ⚠️ 外接矩形の中心で揃えてはいけない。1階と2階で外形が違うと中心もずれ、
     階が横にずれて積み上がる（実際にそうなっていた）。 */
function planOrigin(d) {
  if (d.origin) return d.origin;
  return { x: d.bbox.cx, y: d.bbox.cy };
}

function planPointOf(d, p, y) {
  const o0 = planOrigin(d), o = d.off;
  return [-(p.x - o0.x) * scale + o.x, y + 0.003, (p.y - o0.y) * scale + o.y];
}
function planPoint(p) { return planPointOf(plan, p, floorY()); }

/* 平面図の【外周の輪郭】を世界座標で返す。閉じた輪が取れなければ null。
   ★ 外接矩形では L字も凹みも消えてしまう。線をつないで輪にし、
     いちばん面積の大きいものを外周として採る（内側の間仕切りは面積で負ける）。 */
function planOutline() {
  if (!plan) return null;
  const { loops } = stitchLoops(anchorPolys(plan), 1);
  if (!loops.length) return null;
  let best = null, ba = -1;
  for (const lp of loops) {
    let s = 0;
    for (let i = 0; i < lp.length; i++) {
      const a = lp[i], b = lp[(i + 1) % lp.length];
      s += a.x * b.y - b.x * a.y;
    }
    const ar = Math.abs(s) / 2;
    if (ar > ba) { ba = ar; best = lp; }
  }
  if (!best) return null;
  return best.map((p) => { const w = planPoint(p); return { x: w[0], z: w[2] }; });
}

// 直角に揃えるときに「同じ通り」とみなす幅[m]。図面の描き誤差を吸収する。
//   ⚠️ 大きくしすぎると、本当に 50mm ずれている壁まで揃ってしまう。
const SQUARE_TOL = 0.03;

/* 多角形を直角に揃える。
   ① 辺ごとに、縦か横かを長いほうの向きで決め、短いほうの座標を両端で揃える
   ② 近い座標どうしをまとめて、同じ通りに乗せる */
function squarePoly(poly, tol) {
  const n = poly.length;
  const p = poly.map((q) => ({ ...q }));
  for (let i = 0; i < n; i++) {
    const a = p[i], b = p[(i + 1) % n];
    if (Math.abs(a.x - b.x) <= Math.abs(a.z - b.z)) {
      const m = (a.x + b.x) / 2; a.x = m; b.x = m;          // 縦の辺
    } else {
      const m = (a.z + b.z) / 2; a.z = m; b.z = m;          // 横の辺
    }
  }
  const align = (get, set) => {
    const vals = p.map(get).slice().sort((u, v) => u - v);
    const groups = [];
    for (const v of vals) {
      const g = groups[groups.length - 1];
      if (g && v - g[g.length - 1] <= tol) g.push(v); else groups.push([v]);
    }
    const rep2 = groups.map((g) => g.reduce((sum, v) => sum + v, 0) / g.length);
    for (const q of p) {
      const v = get(q);
      let bi = -1, bd = tol;
      rep2.forEach((r, i) => { const d = Math.abs(v - r); if (d <= bd) { bd = d; bi = i; } });
      if (bi >= 0) set(q, rep2[bi]);
    }
  };
  align((q) => q.x, (q, v) => { q.x = v; });
  align((q) => q.z, (q, v) => { q.z = v; });
  return p;
}

/* 直交する多角形を、縦の帯に切って矩形の集まりに直す。
   ★ 屋根の計算は矩形の重ねを食べるので、輪郭のままでは渡せない。
   ⚠️ 斜めの辺があると帯に切れない。そのときは諦めて外接矩形に戻す
     （05 の屋根はもともと直交前提なので、ここで無理をしない）。 */
function polyToRects(poly0) {
  // ★ まず【直角に揃える】。実務の図面はミリ以下の誤差で描かれていて、
  //   2.4m の壁が横に 0.9mm ずれている、といったことがふつうにある。
  //   ⚠️ 厳密に直交かどうかで判定すると、そういう図面を全部「斜め」と切り捨てて
  //     しまい、外接矩形に落ちる。実際にこれで L 字が作れなかった。
  const poly = squarePoly(poly0, SQUARE_TOL);
  const T = 1e-3;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    if (Math.abs(a.x - b.x) > T && Math.abs(a.z - b.z) > T) return null;   // 本当に斜め
  }
  const xs = [...new Set(poly.map((p) => Math.round(p.x / T) * T))].sort((a, b) => a - b);
  const rects = [];
  for (let i = 0; i + 1 < xs.length; i++) {
    const x0 = xs[i], x1 = xs[i + 1];
    if (x1 - x0 < T) continue;
    const mid = (x0 + x1) / 2;
    // ★ 横向きの辺だけが、z 方向へ延ばした線と交わる。その交点で内外が入れ替わる。
    const zs = [];
    for (let k = 0; k < poly.length; k++) {
      const a = poly[k], b = poly[(k + 1) % poly.length];
      if (Math.abs(a.z - b.z) > T) continue;              // 縦の辺は交わらない
      const lo = Math.min(a.x, b.x), hi = Math.max(a.x, b.x);
      if (mid > lo && mid < hi) zs.push(a.z);
    }
    zs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < zs.length; k += 2) {
      if (zs[k + 1] - zs[k] < T) continue;
      rects.push({ x0, z0: zs[k], x1, z1: zs[k + 1] });
    }
  }
  // 隣り合う帯で z の範囲が同じものはつなぐ（矩形の数を減らす）
  rects.sort((a, b) => (a.z0 - b.z0) || (a.x0 - b.x0));
  const out = [];
  for (const r of rects) {
    const last = out[out.length - 1];
    if (last && Math.abs(last.z0 - r.z0) < T && Math.abs(last.z1 - r.z1) < T
      && Math.abs(last.x1 - r.x0) < T) { last.x1 = r.x1; continue; }
    out.push({ ...r });
  }
  return out.length ? out : null;
}

/* 拾った輪郭が、外形として使えるものかを確かめる。
   ★ 線をつないで輪を探す方法は、T字の交点でどちらへ進むか決められない。
     実際の平面図は外壁も間仕切りも家具も同じ線の海なので、間仕切りの根元へ
     入り込んで、外周とは似ても似つかない小さな輪ができる。
   ⚠️ 黙って変な形を建てるくらいなら、外接矩形のままのほうがまだよい。
     採用しない理由を言葉で返して、レイヤを絞るなどの手を打ってもらう。 */
function judgeOutline(poly) {
  const b = plan.bbox;
  const bw = (b.x1 - b.x0) * scale, bh = (b.y1 - b.y0) * scale;
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity, a2 = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x);
    z0 = Math.min(z0, p.z); z1 = Math.max(z1, p.z);
    a2 += p.x * q.z - q.x * p.z;
  }
  const area = Math.abs(a2) / 2;
  const cover = (bw * bh > 1e-9) ? area / (bw * bh) : 0;
  const fitW = Math.min((x1 - x0) / Math.max(bw, 1e-9), 1);
  const fitH = Math.min((z1 - z0) / Math.max(bh, 1e-9), 1);
  // 外形の 1/3 も覆っていない、または縦横どちらかが半分にも届かない → 外周ではない
  const ok = cover > 0.33 && fitW > 0.5 && fitH > 0.5;
  return { ok, cover, area };
}

/* 平面図の外接矩形を世界座標で返す。 */
export function planBounds() {
  if (!plan) return null;
  const b = plan.bbox, o = plan.off;
  return {
    x0: -(b.x1 - b.cx) * scale + o.x, x1: -(b.x0 - b.cx) * scale + o.x,
    z0: (b.y0 - b.cy) * scale + o.y, z1: (b.y1 - b.cy) * scale + o.y,
  };
}

/* いまの平面図を、いまの階に貼り付ける。
   ★ 階ごとに下絵を控える。こうしないと、2階の図面を読んだ瞬間に1階の下絵が
     消えて、積んだ形を見比べられなくなる。 */
function applyToFloor(keepShape) {
  // ⚠️ 壁の模型を載せたあとに外形を作り直してはいけない。板を作り直す処理は
  //   模型を捨てるので、せっかく起こした壁が消える（実際にそうなっていた）。
  if (!keepShape) setFootprint(footprintRects().rects);
  const y = floorY();
  // ⚠️ origin を写し忘れると、貼り付け済みの階だけが外接矩形の中心で描かれ、
  //   通り芯で揃えたはずの階が横にずれる（実際にそうなっていた）。
  const rec = {
    polys: plan.polys, bbox: plan.bbox, origin: plan.origin, off: { ...plan.off },
    hidden: new Set(plan.hidden), hiddenC: new Set(plan.hiddenC), y,
  };
  const i = applied.findIndex((a) => Math.abs(a.y - y) < 1e-6);
  if (i >= 0) applied[i] = rec; else applied.push(rec);
  refreshUnderlay();
  renderPanel();
}

/* 建物の外形にする矩形と、その説明。輪郭が信用できなければ外接矩形に戻す。 */
function footprintRects() {
  const bb = planBounds();
  const poly = planOutline();
  if (!poly) return { rects: bb, note: '輪郭が閉じません（外接矩形で代用）' };
  const j = judgeOutline(poly);
  if (!j.ok) {
    return { rects: bb,
      note: `輪郭が外形の ${Math.round(j.cover * 100)}% しかありません`
        + '（外接矩形で代用）。レイヤを絞るか「囲って指定」で壁だけにしてください' };
  }
  const rects = polyToRects(poly);
  if (!rects) return { rects: bb, note: '斜めの辺があります（外接矩形で代用）' };
  return { rects, note: `輪郭 ${poly.length} 点 → 矩形 ${rects.length} 枚` };
}

function setPlan(polys) {
  const bbox = bboxOf(polys);
  if (!bbox) return;
  const layers = [...new Set(polys.map((p) => p.layer))].sort();
  const colors = [...new Set(polys.map((p) => p.color))].sort((a, b) => a - b);
  plan = { polys, layers, colors, bbox, off: { x: 0, y: 0 },
    hidden: new Set(), hiddenC: new Set() };
  plan.bbox = bboxOf(anchorPolys(plan)) || bbox;
  plan.origin = gridOrigin(plan);
}

/* 通り芯のレイヤから、X1・Y1 にあたる座標を拾う。無ければ null。
   ⚠️ 通り芯は外形の外まで伸びているので、線の【向き】で縦横を見分けること。
     短い符号の丸（円）は線ではないので混ざらない。 */
function gridOrigin(d) {
  const nm = d.layers.find((l) => /grid|芯/i.test(l));
  if (!nm) return null;
  const xs = [], ys = [];
  for (const p of d.polys) {
    if (p.layer !== nm) continue;
    for (let i = 0; i + 1 < p.pts.length; i++) {
      const a = p.pts[i], b = p.pts[i + 1];
      const dx = Math.abs(a.x - b.x), dy = Math.abs(a.y - b.y);
      if (dx < 1 && dy > 100) xs.push((a.x + b.x) / 2);        // 縦の通り芯
      else if (dy < 1 && dx > 100) ys.push((a.y + b.y) / 2);   // 横の通り芯
    }
  }
  if (!xs.length || !ys.length) return null;
  return { x: Math.min(...xs), y: Math.min(...ys), grid: true };
}

// -----------------------------------------------------------------------------
// 立面図の貼り付け
// -----------------------------------------------------------------------------
/* その面を外から見たときの「右」が、世界のどちらを向くか。
   右 = cross(前方, 上)。前方はその面の【外から中へ】向かう向き。 */
function rightOf(key) {
  if (key === 's') return -1;   // 南の面（外は −z）を見る → 右は −x
  if (key === 'n') return 1;    // 北の面（外は +z）を見る → 右は +x
  if (key === 'e') return -1;   // +x の面を見る → 右は −z
  return 1;                     // −x の面を見る → 右は +z
}

/* 線分を矩形で切る（Liang–Barsky）。外なら null。
   ★ 囲んだ範囲の外は捨てる。最上部の軒の出や寸法線を持ち込まないための要。 */
function clipSeg(a, b, r) {
  let t0 = 0, t1 = 1;
  const dx = b.x - a.x, dy = b.y - a.y;
  const test = (p, q) => {
    if (Math.abs(p) < 1e-12) return q >= 0;
    const t = q / p;
    if (p < 0) { if (t > t1) return false; if (t > t0) t0 = t; }
    else { if (t < t0) return false; if (t < t1) t1 = t; }
    return true;
  };
  if (!test(-dx, a.x - r.x0) || !test(dx, r.x1 - a.x)
    || !test(-dy, a.y - r.y0) || !test(dy, r.y1 - a.y)) return null;
  return [
    { x: a.x + dx * t0, y: a.y + dy * t0 },
    { x: a.x + dx * t1, y: a.y + dy * t1 },
  ];
}

/* 選んだ面ぜんぶを合わせた、面に沿った範囲。 */
function pasteSpan(ps) {
  let a = Infinity, b = -Infinity;
  for (const f of ps.faces) { a = Math.min(a, f.a); b = Math.max(b, f.b); }
  return { a, b, c: (a + b) / 2 };
}

/* 貼った立面の倍率。既定は図面の実寸のまま。
   ⚠️ 既定で面の幅に合わせない。合わせると、面の選び間違いや囲み間違いを
     黙って吸収してしまい、高さだけが狂った状態に気づけない。 */
function pasteScale(ps) {
  if (!ps.fit) return scale;
  const w = ps.rect.x1 - ps.rect.x0;
  const sp = pasteSpan(ps);
  const span = sp.b - sp.a;
  return (w > 1e-9 && span > 1e-9) ? span / w : scale;
}

/* 立面図の1点を、その面の上の世界座標へ。囲みの下辺を GL(y=0) に合わせる。 */
function pastePoint(ps, f, p) {
  const r = ps.rect, s = pasteScale(ps), sp = pasteSpan(ps);
  const dir = rightOf(f.key);
  const u = sp.c + (p.x - (r.x0 + r.x1) / 2) * s * dir + ps.off.x;
  const v = (p.y - r.y0) * s + ps.off.y;
  return (f.key === 's' || f.key === 'n')
    ? [u, v, f.plane] : [f.plane, v, u];
}

/* その面が受け持つ、図面の上での範囲。
   ★ 1枚の立面図を、面ごとに切り分ける。これが「投影図を面に載せる」の中身。
   ⚠️ 面の位置と高さの【両方】で切ること。横だけ切ると、1階の面に2階の窓まで
     写ってしまう。 */
function faceRect(ps, f) {
  const r = ps.rect, s = pasteScale(ps), sp = pasteSpan(ps);
  const dir = rightOf(f.key), rc = (r.x0 + r.x1) / 2;
  const toX = (u) => rc + (u - ps.off.x - sp.c) / (s * dir);
  const xs = [toX(f.a), toX(f.b)].sort((p, q) => p - q);
  return {
    x0: Math.max(r.x0, xs[0]), x1: Math.min(r.x1, xs[1]),
    y0: Math.max(r.y0, r.y0 + (f.y0 - ps.off.y) / s),
    y1: Math.min(r.y1, r.y0 + (f.y1 - ps.off.y) / s),
  };
}

// -----------------------------------------------------------------------------
// 平面図を動かすギズモ
// -----------------------------------------------------------------------------
//   ★ 数値の「ずらす」より、掴んで動かすほうが figure と合わせやすい。
//     動かしている間は【角どうし】を吸い付かせる。階の角が合えば通りも合う。
const gizMat = new THREE.MeshBasicMaterial({ color: 0x007acc, depthTest: false });
let gizmoGroup = null;
const CORNER_SNAP = 0.35;      // 角が吸い付く距離[m]

/* いまの平面図の角（世界座標）。 */
function planCorners(d, y, off) {
  const o0 = planOrigin(d);
  const b = d.bbox;
  const pts = [[b.x0, b.y0], [b.x1, b.y0], [b.x1, b.y1], [b.x0, b.y1]];
  return pts.map(([x, z]) => ({
    x: -(x - o0.x) * scale + off.x, z: (z - o0.y) * scale + off.y, y,
  }));
}

/* 吸い付く先の角。ほかの階に貼った平面図の角を集める。 */
function targetCorners() {
  const out = [];
  for (const a of applied) {
    if (Math.abs(a.y - floorY()) < 1e-6) continue;
    for (const c of planCorners(a, a.y, a.off)) out.push(c);
  }
  return out;
}

/* ギズモを引き直す。 */
function drawGizmo() {
  if (!gizmoGroup) return;
  for (const ch of gizmoGroup.children) ch.geometry.dispose();
  gizmoGroup.clear();
  // ★ 下絵を動かす円盤は置かない。動かしたいのは【建物】のほうなので、
  //   高さの青い箱を横へ引いたときに建物が動く、に一本化した。
  if (true) return;
  if (!plan) return;
  const y = floorY() + 0.02;
  const cs = planCorners(plan, y, plan.off);
  const cx = (cs[0].x + cs[2].x) / 2, cz = (cs[0].z + cs[2].z) / 2;
  const span = Math.max(Math.abs(cs[2].x - cs[0].x), Math.abs(cs[2].z - cs[0].z));
  const r = Math.max(span * 0.05, 0.25);
  const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, 0.05, 20), gizMat);
  m.position.set(cx, y, cz);
  m.renderOrder = 31;
  m.userData = { planMove: true };
  gizmoGroup.add(m);
}

/* main.js から呼ぶ：ギズモに当たったか。 */
export function gizmoPick(rc) {
  if (!gizmoGroup || !gizmoGroup.children.length) return null;
  return rc.intersectObjects(gizmoGroup.children, false)[0] || null;
}
export function planMoveBase() { return plan ? { ...plan.off } : null; }

/* 他の階の下絵の角（世界座標）。建物を動かすときの吸い付き先。 */
export function otherFloorCorners() {
  return targetCorners();
}
export function planMoveY() { return floorY(); }

/* 平面図を動かす。角どうしが近ければ吸い付かせる。 */
export function planMoveTo(x, y) {
  if (!plan) return null;
  const cand = { x, y };
  const mine = planCorners(plan, 0, cand);
  const targets = targetCorners();
  let best = null, bd = CORNER_SNAP;
  for (const c of mine) {
    for (const t of targets) {
      const d = Math.hypot(c.x - t.x, c.z - t.z);
      if (d < bd) { bd = d; best = { dx: t.x - c.x, dz: t.z - c.z }; }
    }
  }
  if (best) { cand.x += best.dx; cand.y += best.dz; }
  plan.off = cand;
  refreshUnderlay();
  return { snapped: !!best };
}

// -----------------------------------------------------------------------------
// 描き直し
// -----------------------------------------------------------------------------
/* main.js の「DXF 平面を描く」から呼ぶ。
   ★ ファイルを選ぶ → そのまま囲って指定 → 板が立つ、の一本道。
     途中にパネルを挟まない。挟むと、どのボタンが本筋なのか分からなくなる。 */
export function askPlanFile() {
  const inp = document.createElement('input');
  inp.type = 'file'; inp.accept = '.dxf';
  inp.addEventListener('change', () => {
    if (inp.files[0]) loadSheet(inp.files[0], true);
  });
  inp.click();
}

// -----------------------------------------------------------------------------
// 読込用レイヤ（壁芯・開口・階段）から、立体の元になる模型を組む
// -----------------------------------------------------------------------------
//   ★ 見た目のレイヤ（二重線・建具の姿）は一切見ない。読むのは
//     W-EXT-200 / W-INT-100 … 壁の芯線（厚みはレイヤ名の数字[mm]）
//     O-DOOR / O-WIN / O-OPEN … 開口の芯線（壁の芯線の上に重ねてある）
//     S-RUN / S-UP … 階段の走りと上り方向
//   ⚠️ レイヤ名で読む。名前が合わなければ何も出ないので、拾えた本数を必ず返す。
const OPEN_H = { DOOR: [0, 2.0], WIN: [0.8, 2.0], OPEN: [0, 2.0] };

function segsOf(p) {
  const out = [];
  for (let i = 0; i + 1 < p.pts.length; i++) out.push([p.pts[i], p.pts[i + 1]]);
  if (p.closed && p.pts.length >= 3) out.push([p.pts[p.pts.length - 1], p.pts[0]]);
  return out;
}

/* 図面座標の線分を、世界座標の軸に沿った線分に直す。 */
function segWorld(a, b) {
  const pa = planPoint(a), pb = planPoint(b);
  return { x0: Math.min(pa[0], pb[0]), x1: Math.max(pa[0], pb[0]),
    z0: Math.min(pa[2], pb[2]), z1: Math.max(pa[2], pb[2]) };
}

function wallModel(polys) {
  const walls = [], opens = [];
  const run = [];
  let up = null;
  for (const p of polys) {
    const L = (p.layer || '').toUpperCase();
    const mw = /^W-(EXT|INT)-(\d+)$/.exec(L);
    const mo = /^O-(DOOR|WIN|OPEN)$/.exec(L);
    for (const [a, b] of segsOf(p)) {
      const s = segWorld(a, b);
      if (mw) walls.push({ ...s, t: Number(mw[2]) / 1000, ext: mw[1] === 'EXT' });
      else if (mo) opens.push({ ...s, lo: OPEN_H[mo[1]][0], hi: OPEN_H[mo[1]][1] });
      else if (L === 'S-RUN') run.push(s);
      else if (L === 'S-UP' && !up) {
        const pa = planPoint(a), pb = planPoint(b);
        up = { ax: pa[0], az: pa[2], bx: pb[0], bz: pb[2] };
      }
    }
  }
  if (!walls.length) return null;
  // 外形（屋根用）。外壁芯の外接矩形を、厚みの半分だけ外へ広げる。
  //   ⚠️ L字などでは外接矩形では足りない。まずは矩形の外形で通す。
  const ext = walls.filter((w) => w.ext);
  const src = ext.length ? ext : walls;
  const t = Math.max(...src.map((w) => w.t)) / 2;
  const foot = {
    x0: Math.min(...src.map((w) => w.x0)) - t,
    x1: Math.max(...src.map((w) => w.x1)) + t,
    z0: Math.min(...src.map((w) => w.z0)) - t,
    z1: Math.max(...src.map((w) => w.z1)) + t,
  };
  let stair = null;
  if (run.length && up) {
    const r = {
      x0: Math.min(...run.map((s) => s.x0)), x1: Math.max(...run.map((s) => s.x1)),
      z0: Math.min(...run.map((s) => s.z0)), z1: Math.max(...run.map((s) => s.z1)),
    };
    // 上り方向は矢印の【向き】から。長さは使わない。
    const dx = up.bx - up.ax, dz = up.bz - up.az;
    stair = { ...r, alongX: Math.abs(dx) >= Math.abs(dz),
      dir: (Math.abs(dx) >= Math.abs(dz) ? Math.sign(dx) : Math.sign(dz)) || 1 };
  }
  return { walls, opens, stair, foot };
}

/* 図面を囲って、その中の線から平面を起こす。 */
function pickPlanRect() {
  askRect('平面図を囲んでください', (r) => {
    const inside = sheet.polys.filter((p) => p.pts.every((q) =>
      q.x >= r.x0 && q.x <= r.x1 && q.y >= r.y0 && q.y <= r.y1));
    if (!inside.length) { alert('その範囲に線がありません'); return; }
    setPlan(inside);
    // ★ 読込用レイヤ（壁芯）があれば壁を立てる。無ければ外形の板だけ。
    //   ⚠️ ボタンを2つに分けない。図面に何が入っているかは、開くまで
    //     ユーザーにも分からない。中身を見てこちらで決める。
    const m = wallModel(inside);
    if (m && setWalls) { setWalls(m); applyToFloor(true); }
    else applyToFloor();
  });
}

export function refreshUnderlay() {
  if (!group) return;
  drawGizmo();
  for (const ch of group.children) ch.geometry.dispose();
  group.clear();
  snapX = []; snapZ = [];

  // 貼り付け済みの階の下絵（薄い色）。いま触っていない階の位置を見せる。
  for (const a of applied) {
    if (plan && Math.abs(a.y - floorY()) < 1e-6) continue;   // いまの階は下で描く
    const pos = [];
    for (const p of a.polys) {
      if (a.hidden.has(p.layer) || a.hiddenC.has(p.color)) continue;
      const w = p.pts.map((q) => planPointOf(a, q, a.y));
      for (let i = 0; i + 1 < w.length; i++) pos.push(...w[i], ...w[i + 1]);
      if (p.closed && w.length >= 3) pos.push(...w[w.length - 1], ...w[0]);
    }
    addLines(pos, PLAN_DONE);
  }
  if (plan) {
    const pos = [];
    for (const p of shown(plan)) {
      const w = p.pts.map(planPoint);
      for (let i = 0; i + 1 < w.length; i++) pos.push(...w[i], ...w[i + 1]);
      if (p.closed && w.length >= 3) pos.push(...w[w.length - 1], ...w[0]);
      for (const q of w) { snapX.push(q[0]); snapZ.push(q[2]); }
    }
    addLines(pos, PLAN_COLOR);
    snapX = dedup(snapX); snapZ = dedup(snapZ);
  }

  for (const ps of pastes) {
    const pos = [];
    for (const f of ps.faces) {
      const fr = faceRect(ps, f);
      if (fr.x1 - fr.x0 < 1e-6 || fr.y1 - fr.y0 < 1e-6) continue;
      for (const p of sheet.polys) {
        const n = p.pts.length;
        const seg = (a, b) => {
          const c = clipSeg(a, b, fr);
          if (!c) return;
          pos.push(...pastePoint(ps, f, c[0]), ...pastePoint(ps, f, c[1]));
        };
        for (let i = 0; i + 1 < n; i++) seg(p.pts[i], p.pts[i + 1]);
        if (p.closed && n >= 3) seg(p.pts[n - 1], p.pts[0]);
      }
    }
    addLines(pos, ELEV_COLOR);
  }
}

function addLines(pos, color) {
  if (!pos.length) return;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  const line = new THREE.LineSegments(geo, matOf(color));
  line.renderOrder = onTop ? 30 : 0;
  group.add(line);
}

function dedup(a) {
  a.sort((p, q) => p - q);
  const out = [];
  for (const v of a) if (!out.length || v - out[out.length - 1] > 1e-4) out.push(v);
  return out;
}

// -----------------------------------------------------------------------------
// スナップ
// -----------------------------------------------------------------------------
/* 下絵の線に吸い付く座標を返す。近くに線が無ければ null。
   ⚠️ 吸い付く距離は画面ではなく実寸で見る。ズームで挙動が変わると、
     寄って微調整しているときに勝手に飛ぶ。 */
export function underlaySnap(axis, v, tol = 0.25) {
  if (!snapOn) return null;
  const list = (axis === 'x') ? snapX : snapZ;
  if (!list.length) return null;
  let best = null, bd = tol;
  for (const c of list) {
    const d = Math.abs(c - v);
    if (d < bd) { bd = d; best = c; }
  }
  return best;
}

// -----------------------------------------------------------------------------
// シートの読み込み
// -----------------------------------------------------------------------------
async function loadSheet(file, thenPick) {
  const buf = await file.arrayBuffer();
  const { polys, texts } = parseDXF(decodeDXF(buf));
  if (!polys.length) { alert(`${file.name} から線が読めませんでした`); return; }
  // ⚠️ applied（階ごとに貼り付けた下絵）は消さない。2階の図面を読んでも
  //   1階の下絵は残っていてほしい。
  sheet = { name: file.name, polys, texts, clusters: [] };
  plan = null; pastes.length = 0;
  // ⚠️ 囲って指定へ入るときは、当て推量の自動あてはめをしない。
  //   先に別の平面で板が立つと、囲った結果に差し替わるまで一瞬ちらつく。
  fitted = !!thenPick;
  splitSheet();
  if (thenPick) pickPlanRect();
}

function splitSheet() {
  if (!sheet) return;
  sheet.clusters = clusterPolys(sheet.polys, gapRatio);
  const sb = bboxOf(sheet.polys);
  const floor = Math.max(sb.x1 - sb.x0, sb.y1 - sb.y0) * 0.05;
  const titles = sheet.texts.filter((t) => /図|平面|立面|伏/.test(t.value));
  for (const c of sheet.clusters) {
    const b = c.bbox;
    const m = Math.max((b.x1 - b.x0) * 0.35, (b.y1 - b.y0) * 0.35, floor);
    let best = null, bd = Infinity;
    for (const t of titles) {
      if (t.x < b.x0 - m || t.x > b.x1 + m || t.y < b.y0 - m || t.y > b.y1 + m) continue;
      const d = Math.hypot(Math.max(b.x0 - t.x, 0, t.x - b.x1),
        Math.max(b.y0 - t.y, 0, t.y - b.y1));
      if (d < bd) { bd = d; best = t.value; }
    }
    c.label = best || '';
  }
  // ★ 平面図の見当。見出しがあればそれ、無ければ【いちばん大きいかたまり】。
  const guess = sheet.clusters.find((c) => /平面/.test(c.label)) || sheet.clusters[0];
  if (guess) setPlan(guess.polys);
  // ★ 読み込んだ直後に、外形を平面図へ重ねてしまう。
  //   ⚠️ 既定の 10×6m の箱が平面図と食い違ったまま残ると、下絵とモデルが
  //     二重に見えて何を触っているのか分からなくなる（実際に起きた）。
  //   ⚠️ 合わせるのは【最初の1回だけ】。分け方を動かすたびに合わせ直すと、
  //     せっかく押し引きしてなぞった形が消える。
  if (plan && setFootprint && !fitted) { fitted = true; applyToFloor(); }
  refreshUnderlay();
  renderPanel();
}

// -----------------------------------------------------------------------------
// 2D で囲む画面
// -----------------------------------------------------------------------------
//   ★ シートは真上から見た1枚の紙。2Dのまま見せて囲わせるのが確実で、
//     3D の視点操作とも喧嘩しない。
let pickCtx = null;

function pickView() {
  const cv = el('dxfPickCv');
  const dpr = Math.min(devicePixelRatio, 2);
  const W = cv.clientWidth, H = cv.clientHeight;
  cv.width = W * dpr; cv.height = H * dpr;
  const bb = bboxOf(sheet.polys);
  const m = 24;
  const k = Math.min((W - m * 2) / (bb.x1 - bb.x0), (H - m * 2) / (bb.y1 - bb.y0));
  const ox = (W - (bb.x1 - bb.x0) * k) / 2, oy = (H - (bb.y1 - bb.y0) * k) / 2;
  return { cv, dpr, W, H, bb, k,
    X: (x) => (x - bb.x0) * k + ox,
    Y: (y) => H - ((y - bb.y0) * k + oy),
    ix: (X) => bb.x0 + (X - ox) / k,
    iy: (Y) => bb.y0 + (H - Y - oy) / k };
}

function drawPicker() {
  const t = pickView(); pickCtx.tf = t;
  const g = t.cv.getContext('2d');
  g.setTransform(t.dpr, 0, 0, t.dpr, 0, 0);
  g.clearRect(0, 0, t.W, t.H);
  const shade = (r, color, label) => {
    g.fillStyle = `${color}22`;
    g.fillRect(t.X(r.x0), t.Y(r.y1), (r.x1 - r.x0) * t.k, (r.y1 - r.y0) * t.k);
    g.fillStyle = color; g.font = '12px sans-serif';
    g.fillText(label, t.X(r.x0) + 4, t.Y(r.y1) + 14);
  };
  if (plan) shade(plan.bbox, '#2f6fb5', '平面図');
  pastes.forEach((ps, i) => shade(ps.rect, '#c05a1e', `立面${i + 1}`));
  g.strokeStyle = '#555'; g.lineWidth = 1;
  g.beginPath();
  for (const p of sheet.polys) {
    const n = p.pts.length;
    for (let i = 0; i + 1 < n; i++) {
      g.moveTo(t.X(p.pts[i].x), t.Y(p.pts[i].y));
      g.lineTo(t.X(p.pts[i + 1].x), t.Y(p.pts[i + 1].y));
    }
    if (p.closed && n >= 3) {
      g.moveTo(t.X(p.pts[n - 1].x), t.Y(p.pts[n - 1].y));
      g.lineTo(t.X(p.pts[0].x), t.Y(p.pts[0].y));
    }
  }
  g.stroke();
  g.fillStyle = '#0a0'; g.font = '11px sans-serif';
  for (const s of (sheet.texts || [])) g.fillText(s.value, t.X(s.x), t.Y(s.y));
  if (pickCtx.drag) {
    const { x0, y0, x1, y1 } = pickCtx.drag;
    g.strokeStyle = '#007acc'; g.lineWidth = 1.5; g.setLineDash([5, 3]);
    g.strokeRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
    g.setLineDash([]);
  }
}

/* 2D画面を開いて、矩形をひとつ囲ってもらう。 */
function askRect(note, onDone) {
  if (!sheet) return;
  const host = el('dxfPick'), bar = el('dxfPickBar'), cv = el('dxfPickCv');
  pickCtx = { onDone, drag: null, tf: null };
  host.style.display = 'block';
  bar.innerHTML = `<span>${note}</span>`;
  const close = document.createElement('button');
  close.type = 'button'; close.textContent = 'やめる'; close.className = 'sp';
  close.addEventListener('click', () => { host.style.display = 'none'; pickCtx = null; });
  bar.appendChild(close);

  const at = (ev) => {
    const r = cv.getBoundingClientRect();
    return { x: ev.clientX - r.left, y: ev.clientY - r.top };
  };
  cv.onpointerdown = (ev) => {
    const p = at(ev); pickCtx.drag = { x0: p.x, y0: p.y, x1: p.x, y1: p.y };
  };
  cv.onpointermove = (ev) => {
    if (!pickCtx || !pickCtx.drag) return;
    const p = at(ev); pickCtx.drag.x1 = p.x; pickCtx.drag.y1 = p.y; drawPicker();
  };
  cv.onpointerup = () => {
    if (!pickCtx) return;
    const dg = pickCtx.drag; pickCtx.drag = null;
    if (!dg || Math.abs(dg.x1 - dg.x0) < 5 || Math.abs(dg.y1 - dg.y0) < 5) { drawPicker(); return; }
    const t = pickCtx.tf;
    const r = {
      x0: t.ix(Math.min(dg.x0, dg.x1)), x1: t.ix(Math.max(dg.x0, dg.x1)),
      y0: t.iy(Math.max(dg.y0, dg.y1)), y1: t.iy(Math.min(dg.y0, dg.y1)),
    };
    host.style.display = 'none';
    const cb = pickCtx.onDone; pickCtx = null;
    cb(r);
  };
  drawPicker();
}

/* ③ 面を選んでから、図面の使う範囲を囲む。 */
function startPaste() {
  if (!sheet) { alert('先に DXF を読み込んでください'); return; }
  if (!pickFaces) return;
  pickFaces((face) => {
    if (!face) return;
    askRect('貼る立面図を囲んでください（軒の出などは囲みの外へ／GL を下辺に）', (rect) => {
      pastes.push({ faces: face.faces, key: face.key, rect, off: { x: 0, y: 0 }, fit: false });
      refreshUnderlay(); renderPanel();
    });
  });
}

// -----------------------------------------------------------------------------
// パネル
// -----------------------------------------------------------------------------
function wireDrop(box, onFile) {
  box.addEventListener('dragover', (ev) => { ev.preventDefault(); box.classList.add('on'); });
  box.addEventListener('dragleave', () => box.classList.remove('on'));
  box.addEventListener('drop', (ev) => {
    ev.preventDefault(); box.classList.remove('on');
    const f = ev.dataTransfer.files[0];
    if (f) onFile(f);
  });
}

function offsetRow(target, onChange) {
  const off = document.createElement('div');
  off.className = 'off';
  off.innerHTML = '<span>ずらす</span>'
    + `<input type="number" step="50" value="${Math.round(target.x * 1000)}">`
    + `<input type="number" step="50" value="${Math.round(target.y * 1000)}">`;
  const [ix, iy] = off.querySelectorAll('input');
  const upd = () => {
    target.x = Number(ix.value) / 1000; target.y = Number(iy.value) / 1000; onChange();
  };
  ix.addEventListener('input', upd); iy.addEventListener('input', upd);
  return off;
}

function renderPanel() {
  const host = el('dxfBody');
  if (!host) return;
  host.innerHTML = '';

  const box = document.createElement('div');
  box.className = 'drop' + (sheet ? ' has' : '');
  box.innerHTML = sheet
    ? `<b>DXF</b> <span class="nm">${sheet.name}</span> <a href="#" data-del="1">×</a>`
    : '<b>DXF</b> をここへ（平面図と立面図が1枚に入ったもの）';
  wireDrop(box, loadSheet);
  box.addEventListener('click', (ev) => {
    if (ev.target.getAttribute && ev.target.getAttribute('data-del')) {
      ev.preventDefault(); sheet = null; plan = null; pastes.length = 0;
      refreshUnderlay(); renderPanel(); return;
    }
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = '.dxf';
    inp.addEventListener('change', () => { if (inp.files[0]) loadSheet(inp.files[0]); });
    inp.click();
  });
  host.appendChild(box);
  if (!sheet) return;

  // --- ① 平面図 ---
  const s1 = document.createElement('div');
  s1.className = 'sec';
  s1.innerHTML = '<div class="cap">かたまりを選ぶ／囲って指定する</div>';
  const sel = document.createElement('select');
  sel.style.width = '100%';
  sel.innerHTML = sheet.clusters.map((c, i) =>
    `<option value="${i}">${c.label || `かたまり${i + 1}`}`
    + ` ${((c.bbox.x1 - c.bbox.x0) * scale).toFixed(1)}`
    + `×${((c.bbox.y1 - c.bbox.y0) * scale).toFixed(1)}m</option>`).join('');
  sel.addEventListener('change', () => {
    setPlan(sheet.clusters[Number(sel.value)].polys);
    refreshUnderlay(); renderPanel();
  });
  s1.appendChild(sel);
  const bPlan = document.createElement('button');
  bPlan.type = 'button'; bPlan.textContent = '囲って指定';
  bPlan.style.marginTop = '4px';
  bPlan.addEventListener('click', pickPlanRect);
  s1.appendChild(bPlan);
  if (plan) {
    const b = plan.bbox;
    const f = footprintRects();
    s1.insertAdjacentHTML('beforeend',
      `<div class="rep">外形 ${((b.x1 - b.x0) * scale).toFixed(2)}`
      + ` × ${((b.y1 - b.y0) * scale).toFixed(2)} m／${f.note}</div>`);
    // レイヤの表示切替。★ 実際の平面図では、家具や寸法線を外して【壁だけ】に
    //   すると輪郭が素直に拾える。ここが自動抽出のいちばんの効き所。
    const filter = (items, set, label) => {
      if (items.length < 2) return;
      const box = document.createElement('div');
      box.className = 'lays';
      box.innerHTML = `<div class="cap">${label}</div>`;
      for (const v of items) {
        const row = document.createElement('label');
        row.className = 'lay';
        const swatch = (label === '線色')
          ? `<span class="sw" style="background:${aciColor(v)}"></span>` : '';
        row.innerHTML = `<input type="checkbox" ${set.has(v) ? '' : 'checked'}>`
          + swatch + `<span>${label === '線色' ? `色 ${v}` : v}</span>`;
        row.querySelector('input').addEventListener('change', (ev) => {
          if (ev.target.checked) set.delete(v); else set.add(v);
          plan.bbox = bboxOf(anchorPolys(plan)) || plan.bbox;
          refreshUnderlay(); renderPanel();
        });
        box.appendChild(row);
      }
      s1.appendChild(box);
    };
    filter(plan.layers, plan.hidden, 'レイヤ');
    filter(plan.colors, plan.hiddenC, '線色');
    s1.insertAdjacentHTML('beforeend',
      '<div class="muted">'
      + (plan.origin && plan.origin.grid
        ? '通り芯があるので、階どうしは自動で揃います。'
        : '通り芯が見つかりません。<b style="color:#007acc">青い箱</b>を'
          + '<b>横へ</b>ドラッグして階の位置を合わせてください（角が吸い付きます）。')
      + '</div>');
  }
  if (plan && setFootprint) {
    const bFit = document.createElement('button');
    bFit.type = 'button'; bFit.textContent = 'この外形で建物をつくる';
    bFit.style.marginTop = '4px';
    bFit.addEventListener('click', () => applyToFloor());
    s1.appendChild(bFit);
  }
  if (applied.length) {
    s1.insertAdjacentHTML('beforeend',
      `<div class="rep">貼り付け済み：${applied.map((a) => `${a.y.toFixed(1)}m`).join('、')}`
      + `（いまの階の床 ${floorY().toFixed(1)}m）</div>`);
  }
  const gap = document.createElement('div');
  gap.className = 'off';
  gap.innerHTML = '<span>分け方</span>'
    + `<input type="range" min="2" max="40" step="1" value="${Math.round(gapRatio * 1000)}" style="width:78px">`
    + `<span class="sz">${(gapRatio * 100).toFixed(1)}%</span>`;
  gap.querySelector('input').addEventListener('input', (ev) => {
    gapRatio = Number(ev.target.value) / 1000; splitSheet();
  });
  s1.appendChild(gap);
  host.appendChild(s1);

  // ⚠️ ここには以前「面を選んで立面図を貼る」があった。いったん外している。
  //   コード（startPaste／pastePoint など）はそのまま残してあるので、
  //   戻すときは、この下にボタンを1つ足すだけでよい。
}

// -----------------------------------------------------------------------------
// 組み込み
// -----------------------------------------------------------------------------
export function initUnderlay(opts) {
  pickFaces = opts.pickFaces;
  setFootprint = opts.setFootprint;
  setWalls = opts.setWalls;
  floorY = opts.floorY || (() => 0);
  group = new THREE.Group();
  gizmoGroup = new THREE.Group();
  opts.scene.add(group, gizmoGroup);

  // ⚠️ 単位・表示・吸い付きの切替は、パネルごと畳んだので存在しないことがある。
  //   図面は実寸 mm・下絵は手前・吸い付きは入り、を既定にしてある。
  if (el('dxfUnit')) {
    el('dxfUnit').addEventListener('change', () => {
      scale = Number(el('dxfUnit').value);
      refreshUnderlay(); renderPanel();
    });
  }
  if (el('dxfOnTop')) {
    el('dxfOnTop').addEventListener('change', () => {
      onTop = el('dxfOnTop').checked; refreshUnderlay();
    });
  }
  if (el('dxfSnap')) {
    el('dxfSnap').addEventListener('change', () => { snapOn = el('dxfSnap').checked; });
  }
  renderPanel();
}
