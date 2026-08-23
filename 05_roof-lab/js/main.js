// =============================================================================
// 屋根ジェネレーター（練習用）
//
//   目的は見た目ではなく【操作感の確認】。
//   ・平面形状を選ぶ
//   ・軒（壁）をクリックして、寄棟⇔切妻をスライダーで連続的に動かす
//   ・矩形が重なるところ（L字・コの字・T字）で谷が自動的に現れるのを見る
//
//   計算そのものは roofcalc.js。ここは three.js での描画と操作だけを持つ。
// =============================================================================
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
// ★ 稜線を太く描くために使う。
//   ⚠️ ふつうの LineBasicMaterial の linewidth は、ほとんどのブラウザで
//     効かない（必ず1px）。太さが要るならこちらで描くしかない。
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import {
  SHAPES, EDGE_KEYS, buildRoof, outlineEdges, findValleyProblem, shiftAxisOf,
  maxRidgeY, edgeInfo, k3,
} from './roofcalc.js';

const el = (id) => document.getElementById(id);

// -----------------------------------------------------------------------------
// 状態
// -----------------------------------------------------------------------------
const state = {
  shapeId: 'rect',
  slope: 0.4,        // 4寸
  eaveY: 3.0,        // 軒の高さ[m]
  eaveOut: 0.6,      // 軒の出[m]（屋根面が立ち上がる辺＝軒先）
  rakeOut: 0.6,      // ケラバの出[m]（切妻にした辺＝妻側）
  gables: {},        // "矩形番号:辺" → 0(寄棟) … 1(切妻)
  // ★ 棟のずれ。矩形番号 → { t, step }。
  //   t … 0(中央＝素の切妻) … ±1(軒まで寄せた＝片流れ)
  //   step … false=招き屋根（寄った側の軒が上がる） / true=差し掛け屋根（段差）
  //   どちらも勾配は変えない。
  shifts: {},
  // ★ 屋上の平場の大きさ。1=平場なし（素の屋根）… 0=平場いっぱい（陸屋根）。
  //   平場は【屋上レベル（軒高）に固定】で、周りの屋根が平場へ向かって下る。
  //   ⚠️ 寸法そのものではなく【割合】で持つ。勾配や外形を変えると軒〜棟の距離が
  //     変わるので、寸法で覚えていると範囲から外れて設定が飛ぶ。
  flatT: 1,
  // ★ 完全な陸屋根（軒の出なし＋パラペット）かどうか。
  //   平場をいっぱいまで広げた先に、もう一段だけある形。
  parapet: false,
  // ★ 辺ごとの軒の出[m]。キーは "矩形番号:辺"。無い辺はスライダーの値を使う。
  //   ⚠️ 矩形の並びが変わると番号の指す辺が変わるので、切妻の指定などと同じく
  //     並べ直しのときに捨てる。
  outs: {},
  // ★ 棟が枝分かれしている端。'w'/'e'（棟が東西のとき）or 's'/'n'（南北のとき）。
  //   ⚠️ パネルのボタンではなく、棟の端をクリックして増減させる。
  //     いずれ平面形状もモデル上の操作で決めたいので、右のパネルには寄せない。
  branches: new Set(),
  // ★ 外形。プッシュプルで動かすので、形の定義から切り離して状態に持つ。
  //   ⚠️ いまは矩形（branchable な形）だけ。他の形は定義のまま動かさない。
  base: null,
  // ★ 壁の一部を押し出してできた矩形。外形は base とこれらの合併になる。
  //   ⚠️ 枝分かれとは同時に使わない（外形が矩形1枚で表せなくなるため）。
  extras: [],
  picked: null,      // いま触っている軒 { ri, key }。表示のためだけに持つ
};

/* 形状を切り替える。切妻の指定は形が変わると意味を失うので捨てる。 */
function setShape(id) {
  const def = SHAPES[id];
  state.shapeId = id;
  state.branches = new Set();
  // 動かせる形なら、外形の控えを取る（以後はこちらを編集する）
  state.base = def.branchable ? { ...def.rects[0] } : null;
  state.extras = [];
  applyLayout();
  rebuild();
  fitCamera();
  syncUI();
}

/* 棟の端で枝分かれさせる／やめる。外形は変えない。 */
function toggleBranch(edge) {
  if (!SHAPES[state.shapeId].branchable) return;
  if (state.branches.has(edge)) state.branches.delete(edge);
  else state.branches.add(edge);
  applyLayout();
  rebuild();
  syncUI();
}

// いまの矩形の並びと、そこに自動で決まる切妻の指定
let layout = { rects: [], gables: {}, meta: [] };

/* 枝分かれの状態から、矩形の並びと切妻の指定を組み立て直す。
   ★ 枝は「外形の短辺の半分」を幅に取る。中央はその半分だけ枝に食い込ませる。
     ⚠️ 食い込ませないと、枝と中央が接するだけで谷ができない。重ねて初めて
       「高い方を採った結果」として谷が現れる。 */
function applyLayout() {
  const def = SHAPES[state.shapeId];
  // 張り出しの矩形につける目印。ei は state.extras の何番目かを指す。
  // ⚠️ 並びから ri-1 で逆算していると、枝分かれで矩形が増えたときに壊れる。
  const extraMeta = () => state.extras.map((_, ei) => ({ role: 'extra', ei }));
  if (!def.branchable || !state.branches.size) {
    const rects = state.base
      ? [{ ...state.base }, ...state.extras.map((r) => ({ ...r }))] : def.rects;
    layout = {
      rects, gables: { ...(def.gables || {}) },
      // 押し出しで足した矩形は、棟の端をクリックしても枝分かれさせない
      // （枝分かれは外形が矩形1枚のときだけ扱える）
      meta: state.base
        ? [{ role: state.extras.length ? 'base' : 'single' }, ...extraMeta()]
        : rects.map(() => ({ role: 'fixed' })),
    };
  } else {
    const r = state.base || def.rects[0];
    // ★ 枝の幅は【外形の短辺】に取る。
    //   ⚠️ こうしないと棟高が揃わない。枝は東西から立ち上がるので
    //     軒から棟まで＝幅の半分。中央は南北から立ち上がるので＝短辺の半分。
    //     枝の幅を短辺に合わせて初めて、両者の「軒から棟まで」が一致する。
    //     （半分にしていたため棟高がずれ、勾配を屋根ごとに変えて誤魔化していた）
    const short = Math.min(r.x1 - r.x0, r.z1 - r.z0);
    // ★ 枝は【外側にだけ】軒が出る（中央と突き合う側は建物の内側で出ない）。
    //   中央は南北の両側に軒が出る。軒から棟までの距離を揃えるには、
    //   枝の幅を軒の出のぶんだけ広げておく必要がある。
    //   ⚠️ ここを短辺そのままにしていると、軒の出を付けた途端に枝の棟だけが
    //     低くなり、中央の妻と高さが合わなくなる。
    const armW = Math.min(short + state.eaveOut, (r.x1 - r.x0) * 0.98);
    const rects = [], gables = {}, meta = [];
    let cx0 = r.x0, cx1 = r.x1;
    const addArm = (edge) => {
      const i = rects.length;
      const isW = edge === 'w';
      rects.push({
        x0: isW ? r.x0 : r.x1 - armW, z0: r.z0,
        x1: isW ? r.x0 + armW : r.x1, z1: r.z1,
      });
      // 南北を切妻にすると、棟は南北へ走る（元の棟と直交する）
      gables[`${i}:s`] = 1; gables[`${i}:n`] = 1;
      meta.push({ role: 'arm', edge });
      // ★ 中央の妻は【枝の棟の真下】で切る。枝の棟は外側の軒から armW/2 ではなく
      //   短辺の半分だけ内側に来る（内側には軒が出ないため）。
      if (isW) cx0 = r.x0 + short / 2; else cx1 = r.x1 - short / 2;
    };
    if (state.branches.has('w')) addArm('w');
    if (state.branches.has('e')) addArm('e');
    const ci = rects.length;
    rects.push({ x0: cx0, z0: r.z0, x1: cx1, z1: r.z1 });
    // 枝が付いた側は、中央の屋根を切妻にして枝と突き合わせる
    if (state.branches.has('w')) gables[`${ci}:w`] = 1;
    if (state.branches.has('e')) gables[`${ci}:e`] = 1;
    meta.push({ role: 'center' });
    // ★ 枝分かれ中でも張り出しは持ち続ける。
    //   ⚠️ ここで捨てていたため、棟を合成した途端に押し出した部分が消えていた。
    for (const r2 of state.extras) { rects.push({ ...r2 }); }
    meta.push(...extraMeta());
    layout = { rects, gables, meta };
  }
  state.gables = { ...layout.gables };
  // ⚠️ 棟のずれも捨てる。矩形の並びが変わると番号の指す屋根が変わるため。
  state.shifts = {};
  state.outs = {};
  state.picked = null;
}

/* 建物が画面に収まるところまでカメラを引く。
   ⚠️ 形ごとに大きさが違うので、決め打ちの距離だと切れたり小さすぎたりする。 */
function fitCamera() {
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (const r of rectsOf()) {
    x0 = Math.min(x0, r.x0); z0 = Math.min(z0, r.z0);
    x1 = Math.max(x1, r.x1); z1 = Math.max(z1, r.z1);
  }
  const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
  const span = Math.max(x1 - x0, z1 - z0, 1);
  const d = span * 1.35 + 6;
  // ★ 見たいのは屋根。狙いは建物の【高さの真ん中】に置く。
  //   ⚠️ 地面の高さを狙うと、屋根が画面の上へはみ出して中央からずれる。
  const midY = (state.eaveY + (lastResult ? lastResult.ridgeY : state.eaveY + 1)) / 2;
  controls.target.set(cx, midY, cz);
  camera.position.set(cx + d * 0.70, midY + d * 0.55, cz + d * 0.70);
  camera.updateProjectionMatrix();
  controls.update();
}

const rectsOf = () => layout.rects;
const gableKey = (ri, key) => `${ri}:${key}`;
const gableOf = (ri, key) => state.gables[gableKey(ri, key)] ?? 0;
const shiftOf = (ri) => {
  const v = state.shifts[ri];
  if (typeof v === 'number') return { t: v, step: false };
  return { t: v ? (v.t ?? 0) : 0, step: !!(v && v.step) };
};
/* その屋根は棟をずらせるか（＝素の切妻か）。計算側の判定をそのまま使う。 */
const shiftAxisOfRoof = (ri) => shiftAxisOf(ri, state.gables);

// -----------------------------------------------------------------------------
// 3D の下ごしらえ
// -----------------------------------------------------------------------------
const scene = new THREE.Scene();
// 01 のモデリングモードと同じ白地。
scene.background = new THREE.Color(0xf5f5f5);

const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 500);
camera.position.set(14, 12, 16);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
el('view').appendChild(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 2, 0);
// ⚠️ 慣性（damping）は切る。手を離しても動き続けると、形を見比べたいときに
//   視点が定まらず落ち着かない。
controls.enableDamping = false;

// ★ 光は置かない。01 は面をすべて MeshBasicMaterial（陰影なし）で塗っている。
//   ⚠️ 陰影を付けると同じ色でも面ごとに明るさが変わり、屋根の勾配を目で比べにくい。
//     図面に近い見え方にするのが 01 の狙いなので、ここも揃える。

// 方眼。01 は 20m を 40 分割（＝0.5m 目）。同じ目のまま範囲だけ広く取る。
const grid = new THREE.GridHelper(40, 80, 0xcccccc, 0xe0e0e0);
// ⚠️ 建物の足元の線（y=0）と近すぎると、下から見上げたときに奥行きの精度が
//   足りず、足元の線が点線のように途切れる。はっきり離しておく。
grid.position.y = -0.03;
scene.add(grid);

// 屋根・壁・稜線は作り直すたびに総取り替えする
const roofGroup = new THREE.Group();
const wallGroup = new THREE.Group();
const lineGroup = new THREE.Group();
const handleGroup = new THREE.Group();
// カーソルを当てた壁の【押し引きされる範囲】を光らせる帯。
//   ★ 掴む位置で範囲が決まる仕組みなので、掴む前に範囲が見えないと博打になる。
const bandGroup = new THREE.Group();
scene.add(roofGroup, wallGroup, lineGroup, handleGroup, bandGroup);

// 01 と同じ配色・同じ材質（陰影なし＋面のちらつき止め）。
//   屋根の葺き材＝黒 0x555555、壁と屋根の下地（軒裏・小口）＝白 0xe8e8e8、稜線＝黒。
const basic = (color) => new THREE.MeshBasicMaterial({
  color, side: THREE.DoubleSide,
  polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
});
const roofMat = basic(0x555555);      // 屋根の仕上げ（葺き材）
const roofBaseMat = basic(0xe8e8e8);  // 屋根の下地・軒裏・小口
const wallMat = basic(0xe8e8e8);
const gableWallMat = basic(0xe8e8e8);
const edgeMat = new THREE.LineBasicMaterial({ color: 0x000000 });

// パラペットの立ち上がり[m]と厚み[m]。01 のパラペット修景と同じ寸法。
const PARAPET_H = 0.3;
const PARAPET_T = 0.15;
// 屋根の厚み[m]。01 の大屋根と同じ 150mm ＋ 150mm の2層。
const ROOF_FINISH = 0.15;   // 上層＝葺き材（黒）
const ROOF_BASE = 0.15;     // 下層＝下地・軒裏（白）
const ROOF_THICK = ROOF_FINISH + ROOF_BASE;
// 壁の天端。屋根の【裏側】までなので、軒高から屋根の厚みを引いた高さ。
//   ⚠️ 軒高まで壁を立てると屋根の小口と壁が重なり、面がちらつく。
/* 壁の天端。屋根の【裏側】までなので、屋根がいちばん低く壁に取り付くところに合わせる。
   ★ 軒の出を辺ごとに詰めると、その辺では屋根が軒高より下がって壁に取り付く
     （軒先の高さは四周で揃っていて、壁までの距離だけが短くなるため）。
     天端を軒高のままにしておくと、そこだけ壁が屋根を突き抜ける。
   ⚠️ 下げすぎても見た目は変わらない。天端から屋根の裏側までは妻壁が白で
     埋めるので、他の辺の見え方はそのまま。 */
function wallTopY() {
  const rects = rectsOf();
  let lo = state.eaveY;
  rects.forEach((r, ri) => {
    for (const key of EDGE_KEYS) {
      if (gableOf(ri, key) >= 0.999) continue;          // 面を持たない辺は関係ない
      if (!exposedIntervals(rects, r, key).iv.length) continue;
      const out = outOf(rects, r, ri, key);
      lo = Math.min(lo, state.eaveY - state.slope * (state.eaveOut - out));
    }
  });
  return lo - ROOF_THICK;
}

/* 矩形 r の辺 key のうち、【建物の外に面している】区間を返す。
   ★ 矩形の重ねで形を持っているので、辺の一部（あるいは全部）が建物の内側に
     隠れていることがある。外に面している部分だけが本当の壁であり、軒でもある。
   ⚠️ 判定は「その面の外側へ 10mm 出た点が、どの矩形にも入っていないか」。
     辺そのものは隣の矩形と接していることが多く、辺の位置で判定すると外と内を
     取り違える。 */
function exposedIntervals(rects, r, key) {
  const T = 1e-6, D = 0.01;
  const along = (key === 'w' || key === 'e');
  const coord = (key === 'w') ? r.x0 : (key === 'e') ? r.x1
    : (key === 's') ? r.z0 : r.z1;
  const probe = coord + ((key === 'w' || key === 's') ? -D : D);
  let iv = [[along ? r.z0 : r.x0, along ? r.z1 : r.x1]];
  for (const r2 of rects) {
    if (r2 === r) continue;
    const covers = along
      ? (r2.x0 - T < probe && probe < r2.x1 + T)
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

/* 軒の出。
   ★ 出し方は「輪郭を外へ広げて屋根を作り直す」。屋根の作り方は一切変えない。
     広げたぶん軒先が下がるので、軒の基準高さも勾配 × 出のぶん下げておくと、
     【壁の位置で】ちょうど軒高になる。棟の高さも変わらない
     （軒から棟までの距離が出のぶん伸び、基準が同じだけ下がって相殺する）。
   ★ 辺ごとに出を変える。屋根面が立ち上がる辺は軒先、切妻にした辺はケラバ。
     ⚠️ 入母屋（途中まで切妻）は軒先として扱う。その辺からは屋根面が
       立ち上がっているので、軒の出が効くのはそちらの寸法。 */
//   ⚠️ 建物の内側に隠れている辺には出さない。棟を合成したときの中央屋根と枝の
//     突き合わせがまさにこれで、そこへ軒を出すと妻が枝の中へめり込み、
//     棟どうしの位置がずれて納まらなくなる。
const outOf = (rects, r, ri, key) => {
  if (!exposedIntervals(rects, r, key).iv.length) return 0;
  // ★ 辺ごとの指定があればそれを使う。無ければスライダーの値。
  const own = state.outs[`${ri}:${key}`];
  if (own !== undefined) return Math.max(0, own);
  return gableOf(ri, key) >= 0.999 ? state.rakeOut : state.eaveOut;
};
const grow = (r, ri, rects) => ({
  x0: r.x0 - outOf(rects, r, ri, 'w'), z0: r.z0 - outOf(rects, r, ri, 's'),
  x1: r.x1 + outOf(rects, r, ri, 'e'), z1: r.z1 + outOf(rects, r, ri, 'n'),
});

// 棟の端をつまむハンドル。棟の線（赤）と見分けたいので別の色にする。
//   ★ クリックで枝分かれできる球（黄）と、伸縮しかできない球（灰）を色で分ける。
//     ⚠️ 同じ見た目にしていると「押しても何も起きない球」を押させることになる。
const handleMat = new THREE.MeshBasicMaterial({ color: 0xf0ad4e, depthTest: false });
const handlePlainMat = new THREE.MeshBasicMaterial({ color: 0x9aa4b2, depthTest: false });
const handleHotMat = new THREE.MeshBasicMaterial({ color: 0x007acc, depthTest: false });
// 屋上の平場をつくるハンドル。棟の球と役目が違うので、色も形も分ける。
const flatMat = new THREE.MeshBasicMaterial({ color: 0x0b8f6a, depthTest: false });
const bandMat = new THREE.MeshBasicMaterial({
  color: 0x007acc, transparent: true, opacity: 0.30, side: THREE.DoubleSide,
});
const bandEdgeMat = new THREE.LineBasicMaterial({ color: 0x007acc });
// つまめる軒先を示す線。屋根の黒にも壁の白にも負けないよう、明るい黄で太く。
const EAVE_PICK_COLOR = 0xffd21e;
const EAVE_PICK_WIDTH = 5;

// ★ 稜線の色。屋根の葺き材（#555555）の上で見分けたいので、明るめに取る。
//   ⚠️ 落ち着いた色にすると黒い屋根に沈む。ここは図面の記号なので、
//     面の色との対比を優先する。
const RIDGE_COLOR = 0xff5b45;   // 棟・隅棟（下り棟）
const VALLEY_COLOR = 0x2fb8ff;  // 谷
const EAVE_COLOR = 0x000000;    // 軒先
// 稜線の太さ[px]。
const RIDGE_WIDTH = 3;

function clearGroup(g) {
  for (const ch of g.children) {
    ch.geometry.dispose();
    if (ch.material && ch.material.dispose && !ch.material.__shared) ch.material.dispose();
  }
  g.clear();
}
for (const m of [roofMat, wallMat, gableWallMat,
  handleMat, handlePlainMat, handleHotMat, flatMat, bandMat, bandEdgeMat,
  roofBaseMat, edgeMat]) {
  m.__shared = true;
}

// -----------------------------------------------------------------------------
// 組み立て
// -----------------------------------------------------------------------------
let lastResult = null;
// 屋根の輪郭（軒の出を足した矩形）。球が潜っていないかの判定でも使う。
let lastEaves = [];
// いちばん高い棟の高さ（へこませる前）。へこみのハンドルの動く範囲になる。
let lastTop = 0;
// 谷の総延長[m]。本数で数えると分割の都合で増減するので、長さで見る。
let valleyLen = 0;
// 屋上の平場の広さ[㎡]と、周りに残った勾配屋根の帯の幅[m]。
let flatArea = 0;
let flatBand = 0;

/* いまの状態から屋根を計算する。描画はしない。
   ★ 触っている最中の【試しの形】を、描く前に確かめられるように分けてある。 */
function computeRoof() {
  const rects = rectsOf();                 // 壁の輪郭
  // 屋根の輪郭（辺ごとの軒の出のぶん外へ）。この輪郭から屋根を作り直すので、
  // 出を変えれば棟の位置も長さも高さもそれに従って動く。
  const eaves = rects.map((r, i) => grow(r, i, rects));
  // ★ 軒先の高さは【どの辺も同じ】。広げたぶん軒先が下がるので、基準を
  //   勾配 × 出のぶん下げておくと、出が既定のままなら壁の位置がちょうど軒高になる。
  const eaveBase = state.eaveY - state.slope * state.eaveOut;
  const args = {
    rects: eaves, slope: state.slope, eaveY: eaveBase,
    gables: state.gables, shifts: state.shifts,
  };
  // ★ 平場のふちの位置を、軒先からの水平距離で出す。
  //   d が軒の出と同じ＝ふちが壁の位置（平場が最大＝陸屋根）
  //   d が軒〜棟の距離と同じ＝ふちが棟の位置（平場は幅0）
  //   ⚠️ 平場ちょうど0のときは【平場そのものを無くす】。幅0の平場でも周りは
  //     そこへ向かって下るので、棟が軒高まで落ちた別の形になってしまう。
  //     素の屋根に戻すには、下り面ごと外すしかない。
  const top = maxRidgeY(args);
  const hsMax = state.slope > 1e-6 ? (top - eaveBase) / state.slope : 0;
  const dMin = state.eaveOut;
  const flat = (state.flatT >= 1 - 1e-9 || hsMax - dMin < 1e-3) ? null
    : { y: state.eaveY, d: dMin + state.flatT * (hsMax - dMin) };
  if (state.parapet) {
    // ★ 完全な陸屋根。軒の出は無く、壁の内側いっぱいに水平な屋根が張る。
    //   ⚠️ 軒の基準を下げないこと。軒の出が無いので、下げると屋根が軒高より
    //     沈み、周囲に要らない勾配の帯が出る。
    const flatE = rects.map((r) => ({ ...r }));
    const result0 = buildRoof({
      rects: flatE, slope: state.slope, eaveY: state.eaveY,
      gables: state.gables, shifts: state.shifts,
      flat: { y: state.eaveY, d: 0 },
    });
    return { rects, eaves: flatE, result: result0, top };
  }
  const result = buildRoof({ ...args, flat });
  return { rects, eaves, result, top };
}

/* 屋根を描き直す。pre に computeRoof() の結果を渡せば計算をやり直さない。 */
function rebuild(pre) {
  clearGroup(roofGroup);
  clearGroup(wallGroup);
  clearGroup(lineGroup);
  clearGroup(handleGroup);

  const { rects, eaves, result, top } = pre || computeRoof();
  lastResult = result;
  lastEaves = eaves;
  lastTop = top;

  buildRoofMesh(result);
  buildWalls(rects, result);
  buildEdgeLines(result);
  buildRidgeHandles(eaves, result);
  buildFlatHandle(rects, eaves, result);
  syncReadout(result);   // ⚠️ 稜線を作ったあとで呼ぶこと（谷の長さがここで決まる）
}

/* 屋根の内側にできる【段差】の辺。
   ★ 入母屋は「妻側の面を途中で打ち切り、その上を垂直に切る」形なので、
     打ち切った線の両側で屋根の高さが不連続になる。外周ではなく面と面の境目。
   ⚠️ ここは屋根の小口（厚み）と妻壁の両方が要る。片方だけだと隙間が開く。
     以前は妻壁しか立てていなかったため、上端に屋根の厚みぶんの穴が残っていた。 */
function stepEdges(faces) {
  const seen = new Map();
  const keyOf = (a, b) => {
    const ka = `${k3(a.x)},${k3(a.z)}`;
    const kb = `${k3(b.x)},${k3(b.z)}`;
    return ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
  };
  const hAt = (pl, p) => pl.a * p.x + pl.b * p.z + pl.c;
  const out = [];
  for (const f of faces) {
    for (let i = 0; i < f.poly.length; i++) {
      const a = f.poly[i], b = f.poly[(i + 1) % f.poly.length];
      const k = keyOf(a, b);
      const prev = seen.get(k);
      if (!prev) { seen.set(k, { a, b, plane: f.plane }); continue; }
      const y1a = hAt(prev.plane, prev.a), y1b = hAt(prev.plane, prev.b);
      const y2a = hAt(f.plane, prev.a), y2b = hAt(f.plane, prev.b);
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
     覚えていないと、先に登録された下側にしか縦線が立たず、上の屋根の小口だけ
     縦線が抜ける。高さの数だけ引くこと。 */
function cornerVerticals(edges) {
  const at = new Map();
  const add = (p, y, q) => {
    const k = `${k3(p.x)},${k3(p.z)}`;
    let r = at.get(k);
    if (!r) { r = { p, ys: new Map(), dirs: [] }; at.set(k, r); }
    r.ys.set(y.toFixed(3), y);
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
      pos.push(r.p.x, y, r.p.z, r.p.x, y - ROOF_THICK, r.p.z);
    }
  }
  return pos;
}

/* 屋根。01 と同じ【2層】で作る。
     上層（黒）… 葺き材。屋根の表面から下へ ROOF_FINISH。
     下層（白）… 下地・軒裏。さらに下へ ROOF_BASE。
   ★ 板ではなく厚みのある層にすると、軒先の小口に黒と白の帯が出る。
     これが 01 の屋根の見え方の芯なので、面の色だけ真似ても揃わない。
   ⚠️ 小口は【外周の辺だけ】。破片どうしの内側の境目に小口を立てると、
     屋根の中に壁が林立する。 */
function buildRoofMesh(result) {
  const top = [], flatTop = [], mid = [], bot = [];
  const fan = (into, f, drop) => {
    for (let i = 1; i + 1 < f.poly.length; i++) {
      const a = f.poly[0], b = f.poly[i], c = f.poly[i + 1];
      into.push(a.x, f.y[0] - drop, a.z, b.x, f.y[i] - drop, b.z,
        c.x, f.y[i + 1] - drop, c.z);
    }
  };
  for (const f of result.faces) {
    // ★ 屋上の平場は瓦ではなく【防水】。葺き材の黒ではなく、下地と同じ白で塗る。
    //   ⚠️ 高さは下げない。平場の上端は周りの屋根の上端と同じ（＝軒高）で、
    //     段差なく繋がっているのが正しい。色だけを変える。
    const isFlat = Math.hypot(f.plane.a, f.plane.b) < 1e-9;
    fan(isFlat ? flatTop : top, f, 0);        // 葺き材の表面（平場は防水の表面）
    fan(mid, f, ROOF_FINISH);                // 葺き材と下地の境目（＝下地の表面）
    fan(bot, f, ROOF_THICK);                 // 軒裏
  }
  // 小口。外周の辺に沿って、黒の帯と白の帯を立てる。
  const black = top.slice(), white = flatTop.slice();
  const band = (into, a, b, ya, yb, d0, d1) => {
    into.push(a.x, ya - d0, a.z, b.x, yb - d0, b.z, b.x, yb - d1, b.z);
    into.push(a.x, ya - d0, a.z, b.x, yb - d1, b.z, a.x, ya - d1, a.z);
  };
  // ⚠️ パラペットのある陸屋根では、屋根の外周はパラペットの内側に隠れる。
  //   小口も外周線も描いてはいけない（パラペットの面と重なってちらつく）。
  const rims = state.parapet ? []
    : outlineEdges(result.faces).map((r) => ({ a: r.a, b: r.b, ya: r.ya, yb: r.yb }));
  // ★ 段差の【高い側】にも小口が要る。ここが抜けていたため、入母屋の妻面の
  //   上端に屋根の厚みぶんの穴が開き、屋根の裏側が見えていた。
  for (const e of stepEdges(result.faces)) {
    rims.push({ a: e.a, b: e.b, ya: e.hiA, yb: e.hiB });
  }
  for (const rec of rims) {
    band(black, rec.a, rec.b, rec.ya, rec.yb, 0, ROOF_FINISH);
    band(white, rec.a, rec.b, rec.ya, rec.yb, ROOF_FINISH, ROOF_THICK);
  }
  white.push(...mid, ...bot);
  const add = (pos, mat) => {
    if (!pos.length) return null;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.computeVertexNormals();
    roofGroup.add(new THREE.Mesh(geo, mat));
    return geo;
  };
  add(black, roofMat);
  add(white, roofBaseMat);
  // 屋根の輪郭を黒い線で回す。表面・葺き材と下地の境目・軒裏の3本。
  //   ⚠️ EdgesGeometry には任せない。屋根は破片に割って作っているので、
  //     割れ目の座標がわずかにずれた破片どうしが「隣が無い辺」と判定され、
  //     屋根の【真ん中】に短い黒線のゴミが残る。外周は roofcalc が
  //     丸めた鍵で正しく拾えているので、そちらから引く。
  const ln = [];
  for (const rec of rims) {
    for (const d of [0, ROOF_FINISH, ROOF_THICK]) {
      ln.push(rec.a.x, rec.ya - d, rec.a.z, rec.b.x, rec.yb - d, rec.b.z);
    }
  }
  ln.push(...cornerVerticals(rims));
  addBlackLines(roofGroup, ln);
}

/* 黒い線をまとめて置く。 */
function addBlackLines(group, pos) {
  if (!pos.length) return;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  group.add(new THREE.LineSegments(geo, edgeMat));
}

/* 線分 a→b を凸多角形の内側だけに切り詰め、[t0, t1] を返す。外なら null。
   ★ 軒の出があると、壁の線は屋根の【内側】を通る。壁の天端を屋根に合わせるには、
     壁の線がどの屋根面の上を通っているかを面ごとに切り分ける必要がある。 */
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

/* 建物の【外形の輪郭】を、一直線に続く区間ごとにまとめて返す。 */
function footprintSegments(rects) {
  const T = 1e-6;
  const groups = new Map();
  for (const r of rects) {
    for (const key of EDGE_KEYS) {
      const { along, coord, iv } = exposedIntervals(rects, r, key);
      if (!iv.length) continue;
      const k = `${key}:${k3(coord)}`;
      if (!groups.has(k)) groups.set(k, { key, coord, along, iv: [] });
      groups.get(k).iv.push(...iv);
    }
  }
  const segs = [];
  for (const g of groups.values()) {
    // 一直線に続く区間はつなぐ（見た目ひと続きの壁の途中に縦線を入れないため）
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

/* 建物の【外形の輪郭】に沿った壁の線。
   ★ 陰影を付けていないので、壁と壁が出会う入隅・出隅は色では分からない。
     角に黒い線を入れて初めて、面の切れ目が読める。
   ⚠️ 矩形ごとに枠を描いてはいけない。矩形の重ねで形を持っているので、
     建物の内側に隠れた枠まで描かれるうえ、見た目ひと続きの壁の途中にも
     縦線が入ってしまう。外形の輪郭だけを取り出し、
     一直線に続く区間はつないでから引く。 */
function buildWallOutline(rects, result) {
  const pos = [];
  const wt = wallTopY();
  // 壁の天端。切妻（ケラバ）の下では妻面が続くので、屋根の裏側の高さを採る。
  const topAt = (x, z) => {
    const g = result.globalAt(x, z);
    return (g && g.plane) ? Math.max(wt, g.h - ROOF_THICK) : wt;
  };
  const hAt = (pl, p) => pl.a * p.x + pl.b * p.z + pl.c;
  for (const seg of footprintSegments(rects)) {
    const { a, b } = seg;
    pos.push(a.x, 0, a.z, b.x, 0, b.z);                     // 足元
    for (const p of [a, b]) pos.push(p.x, 0, p.z, p.x, topAt(p.x, p.z), p.z);  // 角の縦線
    // ★ 軒裏と壁がぶつかる線。壁がどこで屋根に隠れるかは、ここが無いと読めない。
    //   ⚠️ 屋根面ごとに切り分けてから引くこと。屋根が折れているところをまたいで
    //     両端だけで引くと、折れ点を無視した1本の直線になる。
    //   ⚠️ パラペットのある陸屋根には軒裏が無い。壁はそのまま笠木まで立ち上がる
    //     ので、ここに線を引くと壁の途中に意味のない横線が一周する。
    if (state.parapet) continue;
    const dx = b.x - a.x, dz = b.z - a.z;
    for (const f of result.faces) {
      const cl = clipSegToPoly(a, b, f.poly);
      if (!cl) continue;
      const [t0, t1] = cl;
      const p0 = { x: a.x + dx * t0, z: a.z + dz * t0 };
      const p1 = { x: a.x + dx * t1, z: a.z + dz * t1 };
      pos.push(p0.x, hAt(f.plane, p0) - ROOF_THICK, p0.z,
        p1.x, hAt(f.plane, p1) - ROOF_THICK, p1.z);
    }
  }
  addBlackLines(wallGroup, pos);
}

/* 壁。
   ・外周の壁 … 地面から軒高まで。矩形の4面をそのまま立てる
     （矩形どうしが重なる部分は建物の内側に隠れるので、そのままでよい）
   ・妻壁 … 軒高から屋根まで。切妻にした辺の上にできる三角形の壁。
     屋根の外周のうち、軒高より上に浮いている辺の下を埋める。 */
function buildWalls(rects, result) {
  // --- 外周の壁。クリックで辺を選ぶための当たり判定も兼ねる ---
  rects.forEach((r, ri) => {
    for (const key of EDGE_KEYS) {
      const e = edgeInfo(r, key);
      const w = (key === 'w' || key === 'e') ? (r.z1 - r.z0) : (r.x1 - r.x0);
      const geo = new THREE.PlaneGeometry(w, wallTopY());
      const mesh = new THREE.Mesh(geo, wallMat);
      const cx = (key === 'w') ? r.x0 : (key === 'e') ? r.x1 : (r.x0 + r.x1) / 2;
      const cz = (key === 's') ? r.z0 : (key === 'n') ? r.z1 : (r.z0 + r.z1) / 2;
      mesh.position.set(cx, wallTopY() / 2, cz);
      mesh.rotation.y = Math.atan2(e.nx, e.nz);
      mesh.userData = { pickEdge: { ri, key } };
      wallGroup.add(mesh);
    }
  });

  // --- 妻壁 ---
  const pos = [];
  const gLines = [];
  const quad = (a, b, ya, yb, y2a, y2b) => {
    // 下辺 (a,ya)-(b,yb)、上辺 (a,y2a)-(b,y2b) の四角形を三角形2枚で
    pos.push(a.x, ya, a.z, b.x, yb, b.z, b.x, y2b, b.z);
    pos.push(a.x, ya, a.z, b.x, y2b, b.z, a.x, y2a, a.z);
    // 上下の辺だけ線を引く。
    // ⚠️ 縦の辺は引かない。妻壁は破片ごとの細切れなので、縦線を引くと
    //   ひと続きの妻面の途中に線が何本も立つ。
    // ⚠️ 下辺が【壁の天端そのもの】のときは線を引かない。そこは下の壁と
    //   ひと続きの同じ面で、切れ目ではない。招き屋根で軒が上がると、
    //   長い壁の途中に意味のない横線が1本走ってしまう。
    if (Math.abs(ya - wallTopY()) > 1e-6 || Math.abs(yb - wallTopY()) > 1e-6) {
      gLines.push(a.x, ya, a.z, b.x, yb, b.z);
    }
    gLines.push(a.x, y2a, a.z, b.x, y2b, b.z);
  };

  // (1) 壁の天端から屋根の裏側までを塞ぐ（切妻・入母屋の妻面）。
  //   ★ 測るのは【壁の位置】。軒の出があるので屋根の外周とは 0.6m ずれる。
  //     屋根の外周で測ると、妻面が宙に浮いたところに立ってしまう。
  //   ⚠️ 壁の線は屋根面をまたぐので、面ごとに切り分けてから立てること。
  //     またいだまま両端だけで測ると、折れ点を無視した平らな壁になる。
  const wt = wallTopY();
  const hAt = (pl, p) => pl.a * p.x + pl.b * p.z + pl.c;
  // ⚠️ パラペットのある陸屋根では、この帯はパラペットの外側の面とぴったり重なる。
  //   二重に張るとちらつき、線も一周ぶん余分に出る。パラペットに任せる。
  for (const seg of (state.parapet ? [] : footprintSegments(rects))) {
    const dx = seg.b.x - seg.a.x, dz = seg.b.z - seg.a.z;
    for (const f of result.faces) {
      const cl = clipSegToPoly(seg.a, seg.b, f.poly);
      if (!cl) continue;
      const [t0, t1] = cl;
      const p0 = { x: seg.a.x + dx * t0, z: seg.a.z + dz * t0 };
      const p1 = { x: seg.a.x + dx * t1, z: seg.a.z + dz * t1 };
      const y0 = hAt(f.plane, p0) - ROOF_THICK, y1 = hAt(f.plane, p1) - ROOF_THICK;
      if (y0 <= wt + 1e-3 && y1 <= wt + 1e-3) continue;
      quad(p0, p1, wt, wt, Math.max(y0, wt), Math.max(y1, wt));
    }
  }

  // (2) 屋根の内側にできる【段差】を塞ぐ（入母屋の小さな三角の妻面、
  //   差し掛け屋根の棟の垂直面）。
  //   上下とも屋根の【裏側】どうしをつなぐ。裏側から上は屋根の小口が受け持つ。
  // ⚠️ この面には両端に鉛直の辺がある。quad は縦線を引かないので、ここで引く。
  //   引かないと垂直面の左右が切れておらず、面が宙に浮いて見える。
  //   途中の継ぎ目には引かない（段差は破片ごとに細切れになっているため）。
  const stepEnds = new Map();
  const markEnd = (pt, yLo, yHi) => {
    const k = `${k3(pt.x)},${k3(pt.z)}`;
    const r = stepEnds.get(k);
    if (r) r.n++;
    else stepEnds.set(k, { n: 1, pt, yLo, yHi });
  };
  for (const e of stepEdges(result.faces)) {
    quad(e.a, e.b, e.loA - ROOF_THICK, e.loB - ROOF_THICK,
      e.hiA - ROOF_THICK, e.hiB - ROOF_THICK);
    markEnd(e.a, e.loA - ROOF_THICK, e.hiA - ROOF_THICK);
    markEnd(e.b, e.loB - ROOF_THICK, e.hiB - ROOF_THICK);
  }
  for (const r of stepEnds.values()) {
    if (r.n !== 1 || r.yHi - r.yLo < 1e-3) continue;
    gLines.push(r.pt.x, r.yLo, r.pt.z, r.pt.x, r.yHi, r.pt.z);
  }
  if (pos.length) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.computeVertexNormals();
    wallGroup.add(new THREE.Mesh(geo, gableWallMat));
    addBlackLines(wallGroup, gLines);
  }
  buildFloor(rects);
  if (state.parapet) buildParapet(rects);
  buildWallOutline(rects, result);
}

/* パラペット。屋根のまわりに立ち上がる、厚みのある環。
   ⚠️ 環は【外形を内側へ 150mm 縮めた形との差】。矩形ごとに枠を描くと、
     L字の入隅で内側の線が建物の中を横切る。縮めるのは外に面した辺だけ。 */
function buildParapet(rects) {
  const y0 = state.eaveY, y1 = state.eaveY + PARAPET_H;
  const inset = (r, key) => (
    exposedIntervals(rects, r, key).iv.length ? PARAPET_T : 0
  );
  const inner = rects.map((r) => ({
    x0: r.x0 + inset(r, 'w'), z0: r.z0 + inset(r, 's'),
    x1: r.x1 - inset(r, 'e'), z1: r.z1 - inset(r, 'n'),
  }));
  const pos = [], ln = [];
  const band = (a, b, yb, foot) => {
    pos.push(a.x, yb, a.z, b.x, yb, b.z, b.x, y1, b.z);
    pos.push(a.x, yb, a.z, b.x, y1, b.z, a.x, y1, a.z);
    ln.push(a.x, y1, a.z, b.x, y1, b.z);                 // 天端の線
    if (foot) ln.push(a.x, yb, a.z, b.x, yb, b.z);       // 足元の線
    for (const p of [a, b]) ln.push(p.x, yb, p.z, p.x, y1, p.z);   // 角の縦線
  };
  // ★ 外側は【壁の天端から】立ち上げる。屋根の小口（150+150）がそこに出ているので、
  //   軒高から立てると、壁とパラペットの間に黒い帯が一周見えてしまう。
  //   パラペットのある陸屋根では、外壁がそのまま立ち上がって小口を隠すのが正しい。
  for (const seg of footprintSegments(rects)) band(seg.a, seg.b, wallTopY(), false);
  for (const seg of footprintSegments(inner)) band(seg.a, seg.b, y0, true);
  // 笠木（天端）。外形の中で、内側へ縮めた形に入らない桝だけを張る。
  const xs = [...new Set([...rects, ...inner].flatMap((r) => [r.x0, r.x1]))]
    .sort((a, b) => a - b);
  const zs = [...new Set([...rects, ...inner].flatMap((r) => [r.z0, r.z1]))]
    .sort((a, b) => a - b);
  const inAny = (rs, x, z) => rs.some((r) => x > r.x0 && x < r.x1 && z > r.z0 && z < r.z1);
  for (let i = 0; i + 1 < xs.length; i++) {
    for (let j = 0; j + 1 < zs.length; j++) {
      const cx = (xs[i] + xs[i + 1]) / 2, cz = (zs[j] + zs[j + 1]) / 2;
      if (!inAny(rects, cx, cz) || inAny(inner, cx, cz)) continue;
      const [x0, x1, z0, z1] = [xs[i], xs[i + 1], zs[j], zs[j + 1]];
      pos.push(x0, y1, z0, x1, y1, z0, x1, y1, z1);
      pos.push(x0, y1, z0, x1, y1, z1, x0, y1, z1);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.computeVertexNormals();
  wallGroup.add(new THREE.Mesh(geo, wallMat));
  addBlackLines(wallGroup, ln);
}

/* 建物の底。張らないと、下から見たときに中が丸見えになる。
   ⚠️ 矩形ごとに1枚ずつ張ってはいけない。重なったところで同じ高さの面が
     二重になり、ちらつく。x と z の切れ目で碁盤に刻み、
     どれかの矩形に入っている桝だけを張る。 */
function buildFloor(rects) {
  const xs = [...new Set(rects.flatMap((r) => [r.x0, r.x1]))].sort((a, b) => a - b);
  const zs = [...new Set(rects.flatMap((r) => [r.z0, r.z1]))].sort((a, b) => a - b);
  const pos = [];
  for (let i = 0; i + 1 < xs.length; i++) {
    for (let j = 0; j + 1 < zs.length; j++) {
      const cx = (xs[i] + xs[i + 1]) / 2, cz = (zs[j] + zs[j + 1]) / 2;
      if (!rects.some((r) => cx > r.x0 && cx < r.x1 && cz > r.z0 && cz < r.z1)) continue;
      const [x0, x1, z0, z1] = [xs[i], xs[i + 1], zs[j], zs[j + 1]];
      pos.push(x0, 0, z0, x1, 0, z0, x1, 0, z1);
      pos.push(x0, 0, z0, x1, 0, z1, x0, 0, z1);
    }
  }
  if (!pos.length) return;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.computeVertexNormals();
  wallGroup.add(new THREE.Mesh(geo, wallMat));
}

/* 矩形1つぶんの棟。位置も長さも【形から決まる】ので、計算で出す。
   ★ 棟は短辺の中央を、長辺方向に走る。両端は軒から halfSpan だけ内側。
     切妻にするほど端が外へ伸び、建物の端まで届いたら完全な切妻になる。
     ⚠️ つまり「軒ごとの寄棟⇔切妻」と「棟の端の位置」は同じものの言い換え。
       スライダーを触るより、棟の端をつまんで伸ばす方が形と直結する。 */
function ridgeOf(r, ri, result = lastResult) {
  // ⚠️ 棟の向きは「長辺」ではなく【立ち上がる辺】で決まる。南北を切妻にすれば
  //   東西からだけ立ち上がり、正方形でも棟は南北に走る。
  //   高さと勾配も屋根ごとに違いうるので、計算結果から引く。
  const info = result && result.roofs[ri];
  const hs = info ? info.hs : Math.min(r.x1 - r.x0, r.z1 - r.z0) / 2;
  const y = info ? info.ridgeY : state.eaveY;
  const on = (key) => gableOf(ri, key) < 0.999;
  // ⚠️ 棟は「立ち上がる辺」と【直交】する向きに走る。
  //   東西から立ち上がれば棟は南北へ、南北からなら棟は東西へ。
  //   ここを取り違えると、棟の両端のハンドルが同じ場所に重なって掴めなくなる。
  const wx = r.x1 - r.x0, wz = r.z1 - r.z0;
  const onWE = on('w') && on('e');
  const onSN = on('s') && on('n');
  let alongX;
  if (onWE && onSN) alongX = wx >= wz;      // どちらからも立ち上がる＝長辺方向
  else if (onSN) alongX = true;             // 南北から → 棟は東西
  else if (onWE) alongX = false;            // 東西から → 棟は南北
  else alongX = wx >= wz;                   // 片流れなど
  // ★ 棟をずらしていれば、棟の線（＝段差の線）もそのぶん横へ寄る。
  //   ⚠️ 球を中央に置いたままにすると、掴んでいる場所と動くものがずれる。
  const axis = info ? info.axis : null;
  const t = info ? (info.t || 0) : 0;
  const cx = (r.x0 + r.x1) / 2 + (axis === 'x' ? t * hs : 0);
  const cz = (r.z0 + r.z1) / 2 + (axis === 'z' ? t * hs : 0);

  if (alongX) {
    return {
      alongX, y, hs, ri, axis, t,
      a: { x: r.x0 + hs * (1 - gableOf(ri, 'w')), z: cz, edge: 'w', base: r.x0, dir: 1 },
      b: { x: r.x1 - hs * (1 - gableOf(ri, 'e')), z: cz, edge: 'e', base: r.x1, dir: -1 },
    };
  }
  return {
    alongX, y, hs, ri, axis, t,
    a: { x: cx, z: r.z0 + hs * (1 - gableOf(ri, 's')), edge: 's', base: r.z0, dir: 1 },
    b: { x: cx, z: r.z1 - hs * (1 - gableOf(ri, 'n')), edge: 'n', base: r.z1, dir: -1 },
  };
}

/* 棟の向きに直交する2辺（＝つまんで伸ばせる軒）。
   ⚠️ 切妻にしてしまった辺には棟の端が無い。そこにハンドルを出すと、
     掴んでも何も起きない球が浮くことになる。 */
function ridgeEndsUsable(ri) {
  const on = (key) => gableOf(ri, key) < 0.999;
  return on('w') || on('e') || on('s') || on('n');
}

/* 球の半径。建物の大きさに合わせる。 */
const handleRadius = (rects) => {
  const span = Math.max(...rects.map((r) => Math.max(r.x1 - r.x0, r.z1 - r.z0)));
  return Math.max(span * 0.011, 0.08);
};

/* 棟の両端の球を【位置だけ】並べる。
   ★ 描くときと、潜り込んでいないか測るときの両方がここを使う。
     ⚠️ 判定側で位置を作り直してはいけない。描いている球と測っている球がずれると、
       見えていない球のせいで操作が止まる、という説明のつかない挙動になる。
   ★ 出す・出さないの条件は【その球が屋根に潜っているか】だけにする。
     ⚠️ 以前は「その辺の屋根面が1枚も描かれていないなら出さない」としていた。
       理屈は通るが、動かしている途中に、潜ってもいないのに球がふっと消える。
       消えた球は掴み直せないので、操作がそこで途切れてしまう。 */
function ridgeHandles(rects, result) {
  const out = [];
  rects.forEach((r, ri) => {
    // その屋根が1枚も描かれていなければ、棟そのものが無い
    if (result.drawnRoofs && !result.drawnRoofs.has(ri)) return;
    const ridge = ridgeOf(r, ri, result);
    if (ridge.hs < 1e-6) return;
    // ⚠️ 勾配 0（陸屋根）には棟が無い。球を出しても、掴んで動かしたところで
    //   何も起きない。棟のある屋根にだけ出すこと。
    if (ridge.y - result.eaveY < 1e-3) return;
    // ⚠️ 平場をつくると、素の棟はもう無い（周りの帯に低い峰ができるだけ）。
    //   球はどこの面にも載らなくなるので出さない。平場を消せば また出る。
    if (result.flat) return;
    for (const end of ['a', 'b']) {
      const p = ridge[end];
      // ★ クリック（動かさずに離す）で枝分かれさせる／やめる。
      //   元の1本の棟の端 → そこに直交する棟を生やす
      //   枝そのものの端（＝左右に分かれた2つの球）→ その枝をやめる
      //   ⚠️ 中央屋根の端でも戻せるが、枝と突き合うところの球は枝の屋根に
      //     潜っていて出せない。戻す球がどこにも無くなるので、【分かれた側】の
      //     球から戻せるようにしておくこと。
      const m = layout.meta[ri] || {};
      let branch = null, branchOff = false;
      if (SHAPES[state.shapeId].branchable) {
        // ⚠️ 中央屋根の端は、枝がある側もない側も対象。あれば消し、なければ生やす。
        if (m.role === 'single' || m.role === 'center') branch = p.edge;
        // 枝の端は、その枝を消す。棟の端は 's'/'n' だが、消すのは枝の側（'w'/'e'）。
        else if (m.role === 'arm') { branch = m.edge; branchOff = true; }
      }
      out.push({
        ri, edge: p.edge, x: p.x, y: ridge.y, z: p.z,
        hs: ridge.hs, base: p.base, dir: p.dir, alongX: ridge.alongX,
        axis: ridge.axis, t: ridge.t, branch, branchOff,
      });
    }
  });
  return out;
}

/* その球は屋根に潜っているか。
   ★ 測るのは【自分以外の屋根】。棟の球は自分の屋根の頂点に載っているので、
     自分を含めて測るとどの球も常に「潜っている」ことになってしまう。
   ★ 基準は球の【底】。中心が沈むまで待つと、半分めり込んでから止まる。 */
const isBuried = (h, result, rad) => (
  result.heightExcept(h.ri, h.x, h.z) > h.y - rad + 1e-6
);

/* 棟の両端に、つまめる球を置く。 */
function buildRidgeHandles(rects, result) {
  const rad = handleRadius(rects);
  for (const h of ridgeHandles(rects, result)) {
    if (isBuried(h, result, rad)) continue;      // 潜ってしまった球は出さない
    const hot = ridgeDrag && ridgeDrag.ri === h.ri && ridgeDrag.edge === h.edge;
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(rad, 18, 12), handleMat);
    mesh.position.set(h.x, h.y, h.z);
    mesh.renderOrder = 9;
    // ★ クリックで枝分かれできる球（黄）と、伸縮しかできない球（灰）を色で分ける。
    mesh.material = h.branch ? handleMat : handlePlainMat;
    if (hot) mesh.material = handleHotMat;
    mesh.userData = {
      ridgeEnd: {
        ri: h.ri, edge: h.edge, hs: h.hs, base: h.base, dir: h.dir,
        alongX: h.alongX, axis: h.axis, t: h.t,
        branch: h.branch, branchOff: h.branchOff,
      },
    };
    handleGroup.add(mesh);
  }
}

/* 建物の外形の重心。ここが屋根をへこませる場所になる。
   ⚠️ コの字のように重心が建物の外へ出る形では null を返す。載せる屋根が無いので、
     そこにハンドルを出しても掴んだ先が宙になる。 */
function footprintCentroid(rects) {
  const xs = [...new Set(rects.flatMap((r) => [r.x0, r.x1]))].sort((a, b) => a - b);
  const zs = [...new Set(rects.flatMap((r) => [r.z0, r.z1]))].sort((a, b) => a - b);
  let a = 0, sx = 0, sz = 0;
  for (let i = 0; i + 1 < xs.length; i++) {
    for (let j = 0; j + 1 < zs.length; j++) {
      const cx = (xs[i] + xs[i + 1]) / 2, cz = (zs[j] + zs[j + 1]) / 2;
      if (!rects.some((r) => cx > r.x0 && cx < r.x1 && cz > r.z0 && cz < r.z1)) continue;
      const w = (xs[i + 1] - xs[i]) * (zs[j + 1] - zs[j]);
      a += w; sx += cx * w; sz += cz * w;
    }
  }
  if (a <= 0) return null;
  const c = { x: sx / a, z: sz / a };
  const inside = rects.some(
    (r) => c.x > r.x0 && c.x < r.x1 && c.z > r.z0 && c.z < r.z1,
  );
  return inside ? c : null;
}

/* 屋上の平場をつくるハンドル。屋根のてっぺん（重心の真上）に置く。
   ★ 下げるほど平場が広がり、周りの勾配屋根が輪状に細くなる。
     ⚠️ 平場は屋上レベルに固定。ハンドルは【広さ】を決める道具で、
       平場の高さを決める道具ではない。 */
function buildFlatHandle(rects, eaves, result) {
  if (lastTop - state.eaveY < 1e-3) return;      // 陸屋根＝つくるものが無い
  const c = footprintCentroid(rects);
  if (!c) return;
  const g = result.globalAt(c.x, c.z);
  if (!g || !g.plane) return;
  // ★ 球より一回り大きく。八面体は同じ半径だと球より小さく見える。
  const rad = handleRadius(eaves) * 1.9;
  const mesh = new THREE.Mesh(new THREE.OctahedronGeometry(rad), flatMat);
  mesh.position.set(c.x, g.h, c.z);
  mesh.renderOrder = 9;
  mesh.userData = { flatHandle: { x: c.x, z: c.z } };
  handleGroup.add(mesh);
}

/* いま見えている球の名札。ドラッグを始めるときに控える。 */
function visibleHandleKeys() {
  const out = new Set();
  if (!lastResult) return out;
  const rad = handleRadius(lastEaves);
  for (const h of ridgeHandles(lastEaves, lastResult)) {
    if (isBuried(h, lastResult, rad)) continue;
    out.add(`${h.ri}:${h.edge}`);
  }
  return out;
}

/* 控えておいた球のどれかが、この形では潜ってしまうか。
   ★ 見るのは【掴んだ時点で見えていた球】だけ。もともと潜っていた球まで見ると、
     動かせる場面がほとんど無くなる。 */
function watchedBuried(watch, rects, result) {
  if (!watch || !watch.size) return false;
  const rad = handleRadius(rects);
  for (const h of ridgeHandles(rects, result)) {
    if (!watch.has(`${h.ri}:${h.edge}`)) continue;
    if (isBuried(h, result, rad)) return true;
  }
  return false;
}

/* これ以上は動かせない、と伝える。
   ⚠️ 黙って止めてはいけない。ドラッグに追従しなくなった理由が分からないと、
     壊れたのか止められたのか区別がつかない。 */
function showBlocked() {
  showHint('<b>ここで止めています</b>'
    + '<br>これ以上動かすと、既存の球が屋根の中へ潜ります');
}

/* 稜線を色で描き分ける。
   ★ 棟・隅棟（赤）と谷（青）を見分けられるようにするのが狙い。
     判定は「その線の両隣が、線より高いか低いか」だけで足りる。 */
function buildEdgeLines(result) {
  const shared = new Map();
  const keyOf = (a, b) => {
    const ka = `${k3(a.x)},${k3(a.z)}`;
    const kb = `${k3(b.x)},${k3(b.z)}`;
    return ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
  };
  for (const f of result.faces) {
    for (let i = 0; i < f.poly.length; i++) {
      const j = (i + 1) % f.poly.length;
      const a = f.poly[i], b = f.poly[j];
      const k = keyOf(a, b);
      const rec = shared.get(k);
      if (rec) rec.faces.push(f);
      else shared.set(k, { a, b, ya: f.y[i], yb: f.y[j], faces: [f] });
    }
  }

  const ridge = [], valley = [], eave = [];
  valleyLen = 0;
  for (const rec of shared.values()) {
    const { a, b, ya, yb } = rec;
    if (rec.faces.length < 2) {
      // 外周。軒高のところだけ軒先として描く（妻側は妻壁の輪郭になるので描かない）
      if (Math.abs(ya - state.eaveY) < 1e-3 && Math.abs(yb - state.eaveY) < 1e-3) {
        eave.push(a.x, ya, a.z, b.x, yb, b.z);
      }
      continue;
    }
    // 同じ平面どうしの境目は稜線ではない（分割の都合でできた線）
    const [f1, f2] = rec.faces;
    const samePlane = Math.abs(f1.plane.a - f2.plane.a) < 1e-6
      && Math.abs(f1.plane.b - f2.plane.b) < 1e-6
      && Math.abs(f1.plane.c - f2.plane.c) < 1e-6;
    if (samePlane) continue;
    // 線の中点から左右へ少し離れた点の高さを、両側の面で測る
    const mx = (a.x + b.x) / 2, mz = (a.z + b.z) / 2;
    const dx = b.x - a.x, dz = b.z - a.z;
    const len = Math.hypot(dx, dz) || 1;
    const ox = -dz / len * 0.05, oz = dx / len * 0.05;
    const hm = (ya + yb) / 2;
    const h1 = f1.plane.a * (mx + ox) + f1.plane.b * (mz + oz) + f1.plane.c;
    const h2 = f2.plane.a * (mx - ox) + f2.plane.b * (mz - oz) + f2.plane.c;
    // ★ 両隣が線より高ければ谷。
    //   ⚠️ 「高い」だけで見てはいけない。屋上の平場のふちは、外側が高く内側は
    //     【同じ高さ】なので、両方が高いという条件から外れて棟の色になる。
    //     水が集まるのは明らかに谷なので、低い側が無ければ谷として扱う。
    const T2 = 1e-4;
    const isValley = (h1 > hm + T2 || h2 > hm + T2)
      && !(h1 < hm - T2) && !(h2 < hm - T2);
    // ⚠️ 長さに数えるのは【両隣とも高い】本当の谷だけ。平場のふちまで足すと、
    //   平場の周長がまるごと谷として計上され、数字が実感と合わなくなる。
    if (h1 > hm + T2 && h2 > hm + T2) {
      valleyLen += Math.hypot(b.x - a.x, b.z - a.z);
    }
    // ★ 段差（入母屋の打ち切り・招き屋根の棟）では、両側の面で高さが違う。
    //   線は【高い方】に引く。棟なのに段差の足元に赤い線が出るのを防ぐ。
    const hAtP = (pl, p) => pl.a * p.x + pl.b * p.z + pl.c;
    const la = Math.max(hAtP(f1.plane, a), hAtP(f2.plane, a));
    const lb = Math.max(hAtP(f1.plane, b), hAtP(f2.plane, b));
    (isValley ? valley : ridge).push(a.x, la, a.z, b.x, lb, b.z);
  }
  addFatLines(ridge, RIDGE_COLOR);
  addFatLines(valley, VALLEY_COLOR);
  addLines(eave, EAVE_COLOR);
  // ★ 軒裏（屋根の裏側）にも同じ折れ目がある。下から見上げたときにここが無いと、
  //   のっぺりした白い板に見えて、隅棟の位置も屋根の厚みも読めない。
  //   ⚠️ 色は分けない。裏側は仕上げではないので、棟か谷かの区別に意味がない。
  addLines(ridge.concat(valley), EAVE_COLOR, ROOF_THICK);
}

// ⚠️ 稜線は屋根面とまったく同じ高さにある。そのまま描くと深度が拮抗して
//   面に食われ、線が消えたり点線状になったりする。ほんの少し浮かせる。
const LINE_LIFT = 0.008;

/* 太い線の材質。画面の大きさが要るので、作ったものを覚えておいて resize で直す。 */
const fatMats = new Map();
function fatMaterial(color, width = RIDGE_WIDTH) {
  const key = `${color}:${width}`;
  let m = fatMats.get(key);
  if (!m) {
    m = new LineMaterial({ color, linewidth: width, depthTest: false });
    m.__shared = true;
    fatMats.set(key, m);
  }
  const r = renderer.domElement.getBoundingClientRect();
  m.resolution.set(Math.max(r.width, 1), Math.max(r.height, 1));
  return m;
}

/* 太い線をまとめて置く（棟・谷）。 */
function addFatLines(pos, color, group = lineGroup, width = RIDGE_WIDTH) {
  if (!pos.length) return;
  const lifted = pos.slice();
  for (let i = 1; i < lifted.length; i += 3) lifted[i] += LINE_LIFT;
  const geo = new LineSegmentsGeometry();
  geo.setPositions(lifted);
  group.add(new LineSegments2(geo, fatMaterial(color, width)));
}

function addLines(pos, color, drop = 0) {
  if (!pos.length) return;
  const lifted = pos.slice();
  // ⚠️ 浮かせる向きは表裏で逆。裏側の線を上へ浮かせると屋根に食われて消える。
  const lift = drop ? -LINE_LIFT : LINE_LIFT;
  for (let i = 1; i < lifted.length; i += 3) lifted[i] += lift - drop;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(lifted, 3));
  lineGroup.add(new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color })));
}

// -----------------------------------------------------------------------------
// 操作 — 壁をクリックしてその辺を選ぶ
// -----------------------------------------------------------------------------
const _rc = new THREE.Raycaster();
const _ndc = new THREE.Vector2();
let downAt = null;
// 棟の端をつまんでいる間の控え。{ ri, edge, hs, base, dir, x0, y0, g0, vx, vy, len2 }
let ridgeDrag = null;
// 壁を押し引きしている間の控え。{ key, x0, y0, base0, vx, vy, len2 }
let wallDrag = null;
// 屋上の平場を広げ縮めしている間の控え。{ y0, t0, sv }
let flatDrag = null;
// 軒先をつまんで出し入れしている間の控え。
let eaveDrag = null;
// カーソルが乗っている軒先。
let hoverEave = null;
// 建物をこれより小さくはしない[m]
const MIN_SIZE = 2;
// 寸法の刻み[m]。押し引きはこの倍数に丸める。
//   ★ 丸めないと「戻したつもりが 0.07m だけ残る」ことが起きる。見た目には
//     戻っているのに屋根が1枚多く、棟の球も消えない、という分かりにくい状態になる。
//   ⚠️ 表示は小数1桁なので、刻みも 0.5 にして数字と実際をずらさない。
const SNAP = 0.5;
const snapV = (v) => Math.round(v / SNAP) * SNAP;

/* 「ちょうどよい位置」の近くだけ吸い付かせる。それ以外は滑らかに動く。
   ★ 止まりたいのは【形の切り替わり目】だけ。
     寄棟ちょうど（これ以上内へ行かない）／切妻ちょうど（寄棟にも招きにも行ける）
     ／棟が中央／片流れちょうど。
   ⚠️ 刻みで丸めてはいけない。刻みの上でしか止まれないと、その間の位置を
     選べなくなる。棟の位置は意匠で決めるものなので、細かく動けることが要る。 */
const SNAP_HOLD = 0.2;      // 吸い付く幅[m]
// 平場いっぱいから、さらにこの高さぶん引き下げるとパラペットの陸屋根になる。
const PARAPET_DRAG = 0.25;
function snapMarks(v, marks, hold = SNAP_HOLD) {
  for (const m of marks) if (Math.abs(v - m) < hold) return m;
  return v;
}

/* その張り出しが、元の矩形にすっかり呑み込まれているか。
   ★ 呑み込まれていれば外形に何も足していないので、持っていても仕方がない。
     ドラッグを終えたところで捨てる。 */
function isSwallowed(e, b) {
  const t = 1e-6;
  return e.x0 >= b.x0 - t && e.x1 <= b.x1 + t && e.z0 >= b.z0 - t && e.z1 <= b.z1 + t;
}

/* その壁を押し引きすると【何が動くか】を返す。押せないなら null。
   ★ 枝分かれ中でも、外形の輪郭に乗っている壁なら押し引きできる。
     枝の幅も中央の位置も外形から作り直しているので、外形さえ動かせばよい。
     ⚠️ 逆に、枝と中央の間にできる内側の壁は外形ではない。ここを動かすと
       枝の組み方そのものが壊れるので触らせない。
   ★ 範囲は【外形の辺】に沿って測る。枝の壁は外形の壁の一部でしかないので、
     枝の壁の中で測ると「壁ぜんぶ」が枝の幅の意味になってしまう。 */
function pushTarget(ri, key) {
  if (!state.base) return null;
  const m = layout.meta[ri] || {};
  if (m.role === 'fixed') return null;
  // 張り出しの矩形は、その矩形ごと動かす（一部だけ押すと入れ子になって収拾がつかない）
  if (m.role === 'extra') {
    const rect = state.extras[m.ei];
    return rect ? { kind: 'extra', ei: m.ei, rect, key, partial: false } : null;
  }
  const r = layout.rects[ri], b = state.base, t = 1e-6;
  const onOutline = (key === 'w') ? Math.abs(r.x0 - b.x0) < t
    : (key === 'e') ? Math.abs(r.x1 - b.x1) < t
      : (key === 's') ? Math.abs(r.z0 - b.z0) < t : Math.abs(r.z1 - b.z1) < t;
  if (!onOutline) return null;
  return { kind: 'base', rect: b, key, partial: true };
}

/* カーソルが乗っている壁。{ ri, key, u, steps }
   ★ steps はホイールで足し引きした刻み数。カーソルが決めた範囲からの【ずらし量】。
     ⚠️ 範囲そのものを覚えるとカーソルを動かした瞬間に上書きされ、ホイールの
       調整が消える。「カーソルが素の範囲を決め、ホイールがそこからずらす」
       と分けておけば、両方が同時に効く。 */
let hoverWall = null;

/* 押し引きされる範囲を、その壁に沿った座標 [a, b] で返す。
   ★ 掴んだ点から近い方の端まで＝範囲。真ん中あたり（40〜60%）を掴めば壁ぜんぶ。
     そこからホイールで 0.5m ずつ伸び縮みし、壁いっぱいまで広げれば壁ぜんぶ扱い。
   ⚠️ 行き過ぎたぶんの steps は溜めない。溜めると、端で何回も空回しした後に
     戻すのに同じ回数だけ逆回しが要る。 */
function rangeOf(partial, r, key, h) {
  const along = (key === 'w' || key === 'e');
  const lo = along ? r.z0 : r.x0, hi = along ? r.z1 : r.x1;
  const full = hi - lo;
  if (!partial) return { a: lo, b: hi, lo, hi, along, w: full, full, whole: true };
  const nearLo = h.u < 0.5;
  const w0 = (h.u > 0.4 && h.u < 0.6)
    ? full
    : Math.abs(snapV(lo + h.u * full) - (nearLo ? lo : hi));
  const w = Math.max(SNAP, Math.min(full, snapV(w0 + h.steps * SNAP)));
  h.steps = Math.round((w - w0) / SNAP);
  return {
    a: nearLo ? lo : hi - w, b: nearLo ? lo + w : hi,
    lo, hi, along, w, full, whole: w >= full - 1e-6,
  };
}

/* 光らせる帯を引き直す。 */
function drawBand(r, key, rng) {
  clearGroup(bandGroup);
  if (!rng) return;
  const e = edgeInfo(r, key);
  const cx = rng.along ? ((key === 'w') ? r.x0 : r.x1) : (rng.a + rng.b) / 2;
  const cz = rng.along ? (rng.a + rng.b) / 2 : ((key === 's') ? r.z0 : r.z1);
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(rng.w, wallTopY()), bandMat);
  // 壁より少し外側へ。同じ面に置くとちらつく。
  mesh.position.set(cx - e.nx * 0.03, wallTopY() / 2, cz - e.nz * 0.03);
  mesh.rotation.y = Math.atan2(e.nx, e.nz);
  bandGroup.add(mesh);
  // 範囲の切れ目を線でも示す。半透明の面だけでは端がぼやける。
  const g = new THREE.BufferGeometry();
  const hw = rng.w / 2, dx = rng.along ? 0 : hw, dz = rng.along ? hw : 0;
  const x = cx - e.nx * 0.04, z = cz - e.nz * 0.04, ty = wallTopY();
  g.setAttribute('position', new THREE.Float32BufferAttribute([
    x - dx, 0, z - dz, x - dx, ty, z - dz,
    x - dx, ty, z - dz, x + dx, ty, z + dz,
    x + dx, ty, z + dz, x + dx, 0, z + dz,
  ], 3));
  bandGroup.add(new THREE.LineSegments(g, bandEdgeMat));
}

/* 壁のどのあたりを掴んだかを 0〜1 で返す（その壁に沿った位置）。 */
function alongRatio(r, key, pt) {
  if (key === 'w' || key === 'e') return (pt.z - r.z0) / Math.max(r.z1 - r.z0, 1e-6);
  return (pt.x - r.x0) / Math.max(r.x1 - r.x0, 1e-6);
}

/* 一部押し出しで足す矩形を作る。範囲 [a, b] は rangeOf が決めたもの。
   ⚠️ 元の矩形へ食い込ませること。接するだけでは谷ができない。
     谷は「屋根を重ねて高い方を採った」結果としてしか現れない。 */
function makeExtra(r, key, a, b, depth) {
  const along = (key === 'w' || key === 'e');
  const w = Math.max(b - a, SNAP);
  // 食い込みは押し出す幅ぶん。ただし元の矩形からはみ出さない範囲で。
  const bite = Math.min(w, along ? (r.x1 - r.x0) : (r.z1 - r.z0));
  if (key === 'e') return { x0: r.x1 - bite, z0: a, x1: r.x1 + depth, z1: b };
  if (key === 'w') return { x0: r.x0 - depth, z0: a, x1: r.x0 + bite, z1: b };
  if (key === 'n') return { x0: a, z0: r.z1 - bite, x1: b, z1: r.z1 + depth };
  return { x0: a, z0: r.z0 - depth, x1: b, z1: r.z0 + bite };
}

function setRay(ev) {
  const r = renderer.domElement.getBoundingClientRect();
  _ndc.set(((ev.clientX - r.left) / r.width) * 2 - 1,
    -((ev.clientY - r.top) / r.height) * 2 + 1);
  _rc.setFromCamera(_ndc, camera);
  return r;
}

/* 棟の向きに 1m 動かすと、画面上で何ピクセル動くか。
   ⚠️ 「地面との交点」で測ってはいけない。見下ろす角度が浅いと交点が遠くへ飛び、
     わずかな操作で棟が端まで飛んでしまう。画面上の 1m で割れば、
     どの角度から見ても見えている大きさのぶんだけ動く。 */
const _sa = new THREE.Vector3();
const _sb = new THREE.Vector3();
function screenScale(px, py, pz, dx, dz) {
  const r = renderer.domElement.getBoundingClientRect();
  _sa.set(px, py, pz).project(camera);
  _sb.set(px + dx, py, pz + dz).project(camera);
  const vx = (_sb.x - _sa.x) * r.width / 2;
  const vy = -(_sb.y - _sa.y) * r.height / 2;
  return { vx, vy, len2: Math.max(vx * vx + vy * vy, 4) };
}

// 軒先の出っ張り具合を変えられる最大値[m]。スライダーの上限に合わせる。
const OUT_MAX = 1.2;
// 軒の出の刻み[m]。スライダーの 50mm 刻みに合わせる。
const OUT_SNAP = 0.05;
// その辺の外向き。軒先はこの向きへ出る。
const OUT_DIR = { w: [-1, 0], e: [1, 0], s: [0, -1], n: [0, 1] };

/* 指した点が、どの辺の軒先か。遠ければ null。
   ★ 屋根の面を直接つまませる。軒先に専用のハンドルを並べると、辺の数だけ
     球が増えて画面が埋まる。 */
function pickEave(pt) {
  // ⚠️ パラペットの陸屋根には軒の出が無い。掴ませても動かす先が無い。
  if (state.parapet) return null;
  const rects = rectsOf();
  let best = null;
  rects.forEach((r, ri) => {
    for (const key of EDGE_KEYS) {
      const { along, coord, iv } = exposedIntervals(rects, r, key);
      if (!iv.length) continue;
      const out = outOf(rects, r, ri, key);
      const sgn = OUT_DIR[key][along ? 0 : 1];
      const line = coord + sgn * out;              // いまの軒先の位置
      const t = along ? pt.z : pt.x;               // 辺に沿った位置
      const u = along ? pt.x : pt.z;               // 辺と直交する位置
      if (!iv.some(([a, b]) => t > a - 0.3 && t < b + 0.3)) continue;
      const d = Math.abs(u - line);
      if (d > 0.9) continue;                       // 軒先から遠い＝屋根の真ん中
      if (!best || d < best.d) best = { ri, key, d, out, sgn, along, coord, iv };
    }
  });
  return best;
}

/* つまめる軒先を光らせる。 */
function drawEaveBand(e) {
  clearGroup(bandGroup);
  const line = e.coord + e.sgn * e.out;
  // 軒先の高さ。壁の位置が軒高で、そこから出たぶんだけ下がる。
  const y = state.eaveY - state.slope * e.out + 0.02;
  const pos = [];
  for (const [a, b] of e.iv) {
    if (e.along) pos.push(line, y, a, line, y, b);
    else pos.push(a, y, line, b, y, line);
  }
  addFatLines(pos, EAVE_PICK_COLOR, bandGroup, EAVE_PICK_WIDTH);
}

/* 画面の動き (dx, dy) を、地面の上の2つの向きへ【正しく】分ける。
   ★ それぞれに内積を取るだけでは駄目。見下ろした画面では2つの向きは直交して
     いないので、棟に沿って動かしただけで横切る成分まで出てしまう。
     2元の連立として解けば、地面の上で動いた距離そのものになる。 */
function groundDelta(dx, dy, sa, sc) {
  const det = sa.vx * sc.vy - sa.vy * sc.vx;
  if (Math.abs(det) < 1e-6) {
    // 2つの向きが画面上で重なって見える角度。分けられないので沿う向きだけ採る。
    return { mA: (dx * sa.vx + dy * sa.vy) / sa.len2, mC: 0 };
  }
  return {
    mA: (dx * sc.vy - dy * sc.vx) / det,
    mC: (sa.vx * dy - sa.vy * dx) / det,
  };
}

/* 真上へ 1m 動かすと、画面上で何ピクセル動くか。
   ⚠️ 地面の向きと同じ関数は使えない。へこみは高さの操作なので、
     画面上の【垂直方向の見かけの長さ】で割らないと、見下ろす角度によって
     わずかな操作で端まで飛ぶ。 */
function screenScaleY(px, py, pz) {
  const r = renderer.domElement.getBoundingClientRect();
  _sa.set(px, py, pz).project(camera);
  _sb.set(px, py + 1, pz).project(camera);
  const vx = (_sb.x - _sa.x) * r.width / 2;
  const vy = -(_sb.y - _sa.y) * r.height / 2;
  return { vx, vy, len2: Math.max(vx * vx + vy * vy, 4) };
}

renderer.domElement.addEventListener('pointerdown', (ev) => {
  if (ev.button !== 0) return;
  downAt = { x: ev.clientX, y: ev.clientY };
  setRay(ev);
  const hit = _rc.intersectObjects(handleGroup.children, false)[0];
  if (!hit) {
    // 棟の球でなければ、屋根（軒先）と壁のうち【手前にある方】を試す。
    // ⚠️ 奥行きを見ずに壁を拾うと、屋根の上をクリックしたのに向こう側の壁を
    //   掴んでしまう。
    // ⚠️ 線は外すこと。LineSegments の当たり判定には太さ（既定1m）があり、
    //   屋根の輪郭線の【近く】を通っただけで、面より手前に当たったことになる。
    //   壁を指しているのに軒先を掴む、という取り違えが起きる。
    const rh = _rc.intersectObjects(roofGroup.children.filter((c) => c.isMesh), false)[0];
    const wh0 = _rc.intersectObjects(wallGroup.children, false)
      .find((x) => x.object.userData.pickEdge);
    if (rh && (!wh0 || rh.distance < wh0.distance)) {
      const pe = pickEave(rh.point);
      if (!pe) return;
      const [nx, nz] = OUT_DIR[pe.key];
      eaveDrag = {
        ...pe, x0: ev.clientX, y0: ev.clientY,
        ...screenScale(rh.point.x, rh.point.y, rh.point.z, nx, nz),
      };
      clearGroup(bandGroup);
      clearHint();
      controls.enabled = false;
      ev.preventDefault();
      return;
    }
    const wh = wh0;
    if (!wh) return;
    const { ri, key } = wh.object.userData.pickEdge;
    const tgt = pushTarget(ri, key);
    if (!tgt) return;
    const r = tgt.rect;
    const e = edgeInfo(r, key);
    const c = wh.point;
    // ★ 壁の真ん中あたり（40〜60%）を掴んだら壁ぜんぶ、端寄りならその側だけ。
    //   ⚠️ 全体と一部を別の道具に分けると、ハンドルが壁ごとに増えて画面が埋まる。
    //     掴む位置で決まるようにすれば、道具はひとつで足りる。
    const u = alongRatio(r, key, c);
    // カーソルを当てていたときに光っていた範囲を、そのまま引き継ぐ。
    // ⚠️ 掴んだ瞬間に範囲が変わると、見せていたものと違うものを動かすことになる。
    const steps = (hoverWall && hoverWall.ri === ri && hoverWall.key === key)
      ? hoverWall.steps : 0;
    wallDrag = {
      ri, key, u, steps, kind: tgt.kind, ei: tgt.ei, partial: tgt.partial,
      // ⚠️ 見るのは【いま見えている球】だけ。もともと潜っている球まで見ると、
      //   動かせる場面がほとんど無くなる。
      watch: visibleHandleKeys(),
      x0: ev.clientX, y0: ev.clientY, cx: ev.clientX, cy: ev.clientY,
      base0: { ...state.base }, rect0: { ...r },
      extras0: state.extras.map((x) => ({ ...x })),
      ...screenScale(c.x, c.y, c.z, e.nx, e.nz),
    };
    clearGroup(bandGroup);
    clearHint();
    controls.enabled = false;
    ev.preventDefault();
    return;
  }
  if (hit.object.userData.flatHandle) {
    const q = hit.object.position;
    // ★ 控えるのは割合ではなく【軒高からの高さ[m]】。平場をいっぱいまで
    //   広げた先（マイナス側）にパラペットの陸屋根があるので、割合では表せない。
    const span0 = Math.max(lastTop - state.eaveY, 1e-6);
    flatDrag = {
      y0: ev.clientY, x0: ev.clientX,
      t0: state.parapet ? -PARAPET_DRAG : state.flatT * span0,
      sv: screenScaleY(q.x, q.y, q.z),
    };
    controls.enabled = false;
    ev.preventDefault();
    return;
  }
  const h = hit.object.userData.ridgeEnd;
  const p = hit.object.position;
  // ★ 棟に【沿う】向きと【横切る】向きの2つを測る。
  //   沿う＝棟の伸縮（寄棟 ⇔ 切妻）、横切る＝棟のずれ（招き屋根 ⇔ 片流れ）。
  const dirA = h.alongX ? { dx: 1, dz: 0 } : { dx: 0, dz: 1 };
  const dirC = h.alongX ? { dx: 0, dz: 1 } : { dx: 1, dz: 0 };
  ridgeDrag = {
    ...h, x0: ev.clientX, y0: ev.clientY, g0: gableOf(h.ri, h.edge), moved: false,
    t0: shiftOf(h.ri).t, canShift: !!shiftAxisOfRoof(h.ri), mode: null,
    watch: visibleHandleKeys(),
    sa: screenScale(p.x, p.y, p.z, dirA.dx, dirA.dz),
    sc: screenScale(p.x, p.y, p.z, dirC.dx, dirC.dz),
  };
  controls.enabled = false;
  ev.preventDefault();
});

/* 壁の押し引きを、いまのカーソル位置とホイールの刻みから作り直す。
   ⚠️ ホイールでも呼ぶので、カーソルの位置は wallDrag に控えておく。 */
function applyWallDrag() {
  // 壁の法線方向へ、押した／引いた距離[m]。内側向きが正。
  const dx = wallDrag.cx - wallDrag.x0, dy = wallDrag.cy - wallDrag.y0;
  const d = (dx * wallDrag.vx + dy * wallDrag.vy) / wallDrag.len2;
  const { key } = wallDrag;
  const rng = rangeOf(wallDrag.partial, wallDrag.rect0, key, wallDrag);
  wallDrag.rng = rng;
  // ★ 弾かれたときに戻せるよう、いまの外形を控えておく。
  //   ⚠️ extras は配列そのものを書き換えることがあるので、複製して控えること。
  const keepBase = state.base, keepExtras = state.extras.slice();
  if (rng.whole) {
    // 壁ぜんぶを動かす＝その矩形の辺そのものが動く
    const b = { ...wallDrag.rect0 };
    if (key === 'w') b.x0 = Math.min(snapV(b.x0 + d), b.x1 - MIN_SIZE);
    else if (key === 'e') b.x1 = Math.max(snapV(b.x1 - d), b.x0 + MIN_SIZE);
    else if (key === 's') b.z0 = Math.min(snapV(b.z0 + d), b.z1 - MIN_SIZE);
    else b.z1 = Math.max(snapV(b.z1 - d), b.z0 + MIN_SIZE);
    if (wallDrag.kind === 'base') state.base = b;
    else state.extras[wallDrag.ei] = b;
  } else {
    // 壁の一部を押し出す＝矩形を1枚足す（引っ込めるとその矩形は消える）
    // 外へ引いた量（内向きが正なので反転）。刻みに丸めるので、戻せば必ず 0 になる。
    const depth = snapV(-d);
    state.extras = wallDrag.extras0.map((x) => ({ ...x }));
    if (depth >= SNAP) {
      state.extras.push(makeExtra(wallDrag.rect0, key, rng.a, rng.b, depth));
    }
  }
  applyLayout();
  const pre = computeRoof();
  // ★ 既存の球が屋根へ潜り込む手前で止める。壁を動かすと屋根の高さが変わるので、
  //   触っていない球のほうが屋根に呑まれることがある。
  if (watchedBuried(wallDrag.watch, pre.eaves, pre.result)) {
    state.base = keepBase; state.extras = keepExtras;
    applyLayout();          // 控えた外形で並びを戻す（描画は触っていないので現状のまま）
    showBlocked();
    showSizeTag(wallDrag);
    return;
  }
  clearHint();
  rebuild(pre);
  syncUI();
  showSizeTag(wallDrag);
}

renderer.domElement.addEventListener('pointermove', (ev) => {
  if (wallDrag) {
    wallDrag.cx = ev.clientX; wallDrag.cy = ev.clientY;
    applyWallDrag();
    return;
  }
  if (eaveDrag) {
    const dx = ev.clientX - eaveDrag.x0, dy = ev.clientY - eaveDrag.y0;
    const moved = (dx * eaveDrag.vx + dy * eaveDrag.vy) / eaveDrag.len2;
    let out = Math.max(0, Math.min(OUT_MAX, eaveDrag.out + moved));
    out = Math.round(out / OUT_SNAP) * OUT_SNAP;
    state.outs[`${eaveDrag.ri}:${eaveDrag.key}`] = out;
    rebuild();
    syncUI();
    showEaveTag(eaveDrag, out);
    return;
  }
  if (flatDrag) {
    // 画面の動きを高さ[m]に直す。下へ動かすほど平場が広がる。
    const dm = ((ev.clientX - flatDrag.x0) * flatDrag.sv.vx
      + (ev.clientY - flatDrag.y0) * flatDrag.sv.vy) / flatDrag.sv.len2;
    const span = Math.max(lastTop - state.eaveY, 1e-6);
    const y = flatDrag.t0 + dm;
    // ★ 0 より下へさらに引くと、完全な陸屋根（軒の出なし＋パラペット）へ。
    //   ⚠️ すぐには切り替えない。平場いっぱいの状態で止めたい人が、行き過ぎて
    //     勝手にパラペットになってしまう。ひと押しぶんの間を空ける。
    state.parapet = y < -PARAPET_DRAG;
    // 吸い付くのは両端だけ。平場なし（素の屋根）と、平場いっぱい（陸屋根）。
    // ⚠️ 吸い付く幅は狭くする。ここは形が切り替わる境目なので、幅が広いと
    //   「ごく小さい平場」を選べない。
    const yc = snapMarks(Math.max(0, Math.min(span, y)), [0, span], 0.08);
    state.flatT = yc / span;
    rebuild();
    syncUI();
    showFlatTag();
    return;
  }
  if (!ridgeDrag) {
    // つまめる場所ではカーソルを変える（掴めることを形で示す）
    setRay(ev);
    clearHint();
    const hh = _rc.intersectObjects(handleGroup.children, false)[0];
    if (hh && hh.object.userData.flatHandle) {
      renderer.domElement.style.cursor = 'ns-resize';
      setHover(null);
      showHint('<b>屋根のてっぺん</b><br>上下にドラッグ＝屋上の平場をつくる'
        + '<br>下げるほど平場が広がり、周りの屋根は平場へ向かって下ります'
        + '<br>いっぱいまで下げてさらに引くと、パラペットの陸屋根になります');
      return;
    }
    if (hh) {
      if (hoverEave) { hoverEave = null; clearGroup(bandGroup); }
      renderer.domElement.style.cursor = 'ew-resize';
      setHover(null);
      // ★ その球で何ができるかを、右のパネルの下に出す。
      //   ⚠️ モデルのそばに出すと、肝心の屋根が説明文で隠れてしまう。
      const hd = hh.object.userData.ridgeEnd;
      const rows = ['<b>棟の端</b>'];
      if (Math.abs(hd.t || 0) > 1e-6) {
        rows.push('棟を横切ってドラッグ＝棟をずらす（招き屋根 ⇔ 片流れ）');
        rows.push('Shift を押しながら＝差し掛け屋根（軒高はそのまま）');
        rows.push('棟を中央へ戻すと、寄棟に戻せます');
      } else {
        rows.push('棟に沿ってドラッグ＝棟を伸縮（寄棟 ⇔ 切妻）');
        if (hd.axis) {
          rows.push('棟を横切ってドラッグ＝棟をずらす（招き屋根 → 片流れ）');
          rows.push('Shift を押しながら＝差し掛け屋根（軒高はそのまま）');
        }
        if (hd.branch) {
          rows.push(hd.branchOff
            ? 'クリック＝この棟の合成をやめる'
            : 'クリック＝直交する棟を合成');
        }
      }
      showHint(rows.join('<br>'));
      return;
    }
    // 屋根が手前にあるなら、軒先をつまむ操作の方を出す。
    // ⚠️ 線は外すこと。LineSegments の当たり判定には太さ（既定1m）があり、
    //   屋根の輪郭線の【近く】を通っただけで、面より手前に当たったことになる。
    //   壁を指しているのに軒先を掴む、という取り違えが起きる。
    const rh = _rc.intersectObjects(roofGroup.children.filter((c) => c.isMesh), false)[0];
    const wh0 = _rc.intersectObjects(wallGroup.children, false)
      .find((x) => x.object.userData.pickEdge);
    if (rh && (!wh0 || rh.distance < wh0.distance)) {
      setHover(null);
      const pe = pickEave(rh.point);
      hoverEave = pe;
      if (!pe) { clearGroup(bandGroup); renderer.domElement.style.cursor = ''; return; }
      renderer.domElement.style.cursor = 'move';
      drawEaveBand(pe);
      showHint(`<b>軒の出（この辺） ${Math.round(pe.out * 1000)} mm</b>`
        + '<br>ドラッグ＝この辺だけ出し入れ（0 まで詰められます）');
      return;
    }
    if (hoverEave) { hoverEave = null; clearGroup(bandGroup); }
    const wh = wh0;
    const tgt = wh && pushTarget(wh.object.userData.pickEdge.ri,
      wh.object.userData.pickEdge.key);
    renderer.domElement.style.cursor = tgt ? 'move' : '';
    if (!tgt) { setHover(null); return; }
    const { ri, key } = wh.object.userData.pickEdge;
    // 別の壁へ移ったらホイールの調整は捨てる（その壁の話ではなくなるため）
    if (!hoverWall || hoverWall.ri !== ri || hoverWall.key !== key) {
      hoverWall = { ri, key, u: 0, steps: 0 };
    }
    hoverWall.u = alongRatio(tgt.rect, key, wh.point);
    refreshHover();
    return;
  }
  const dx = ev.clientX - ridgeDrag.x0, dy = ev.clientY - ridgeDrag.y0;
  // ⚠️ 少し動いた程度はクリックとして扱う。掴んだ指のぶれで枝分かれが
  //   できなくなるのを防ぐ。
  if (Math.hypot(dx, dy) > 4) ridgeDrag.moved = true;
  if (!ridgeDrag.moved) return;
  // 画面の動きを、棟に沿う向き／横切る向きへ分けて[m]で測る
  const { mA, mC } = groundDelta(dx, dy, ridgeDrag.sa, ridgeDrag.sc);
  // ★ どちらの操作かは【最初に動いた向き】で決めて、ドラッグの間は変えない。
  //   ⚠️ 毎回選び直すと、斜めに動かしたときに2つの形が交互に出て手に負えない。
  if (!ridgeDrag.mode) {
    ridgeDrag.mode = Math.abs(mC) > Math.abs(mA) ? 'shift' : 'gable';
  }
  const keepG = { ...state.gables }, keepT = { ...state.shifts };
  const hs = ridgeDrag.hs;
  if (ridgeDrag.mode === 'shift') {
    // ★ 棟を横へずらす。勾配は変えない。
    //   Shift なし＝招き屋根（寄った側の軒が上がり、棟で1本に合わさる）
    //   Shift あり＝差し掛け屋根（軒高はそのまま。棟に垂直な段差が出る）
    if (!ridgeDrag.canShift) {
      showHint('<b>棟はまだずらせません</b><br>両端を切妻にすると、'
        + '棟を左右へずらせます（招き屋根 → 片流れ）');
      hideSizeTag();          // 断ったのに寸法だけ出ていると、動いたように見える
      return;
    }
    // 吸い付くのは、棟が中央（＝素の切妻）と、軒まで寄せきった（＝片流れ）の3か所。
    const d = snapMarks(
      Math.max(-hs, Math.min(hs, ridgeDrag.t0 * hs + mC)), [0, hs, -hs],
    );
    state.shifts[ridgeDrag.ri] = { t: d / hs, step: ev.shiftKey };
  } else {
    // ⚠️ 棟をずらしたまま寄棟へは戻せない。隅棟が水平面で45度でなくなるか、
    //   勾配を辺ごとに変えるしかなくなる。どちらも屋根として崩れる。
    if (Math.abs(ridgeDrag.t0) > 1e-6) {
      showHint('<b>棟をずらしています</b><br>棟を中央へ戻すと、寄棟に戻せます');
      hideSizeTag();
      return;
    }
    // 端が外へ出るほど切妻に近づく。dir は「内向きが正」なので符号を合わせる。
    const g0 = ridgeDrag.g0 - (mA * ridgeDrag.dir) / hs;
    // ★ 見るのは比ではなく【軒から棟の端までの長さ】。
    //   吸い付くのは 0（切妻ちょうど）と hs（寄棟ちょうど）だけ。
    const p = snapMarks(hs * (1 - Math.max(0, Math.min(1, g0))), [0, hs]);
    state.gables[gableKey(ridgeDrag.ri, ridgeDrag.edge)] = 1 - p / hs;
  }
  const pre = computeRoof();
  // ★ 既存の球が屋根へ潜り込む手前で止める。
  if (watchedBuried(ridgeDrag.watch, pre.eaves, pre.result)) {
    state.gables = keepG;
    state.shifts = keepT;
    showBlocked();
    hideSizeTag();
    return;
  }
  clearHint();
  state.picked = { ri: ridgeDrag.ri, key: ridgeDrag.edge };
  rebuild(pre);
  syncUI();
  showRidgeTag();
});

/* いま掴んでいる球のそばに、寸法と形の名前を出す。
   ★ スナップが効いたことは、数字が止まって初めて分かる。 */
function showRidgeTag() {
  if (!ridgeDrag) return;
  // ⚠️ handleGroup には棟の球以外（へこみのハンドル）も入っている。素通しで
  //   userData.ridgeEnd を見ると、そこで落ちる。
  const mesh = handleGroup.children.find((c) => (
    c.userData.ridgeEnd
      && c.userData.ridgeEnd.ri === ridgeDrag.ri
      && c.userData.ridgeEnd.edge === ridgeDrag.edge
  ));
  if (!mesh) { hideSizeTag(); return; }
  const hs = ridgeDrag.hs;
  let text;
  if (ridgeDrag.mode === 'shift') {
    const sh = shiftOf(ridgeDrag.ri);
    const d = Math.abs(sh.t) * hs;
    text = Math.abs(sh.t) < 1e-6 ? '棟 中央（切妻）'
      : Math.abs(sh.t) >= 1 - 1e-6 ? '片流れ'
        : `棟のずれ ${d.toFixed(1)} m（${sh.step ? '差し掛け' : '招き'}）`;
  } else {
    const p = hs * (1 - gableOf(ridgeDrag.ri, ridgeDrag.edge));
    text = p <= 1e-6 ? '切妻' : p >= hs - 1e-6 ? '寄棟'
      : `隅棟 ${p.toFixed(1)} m`;
  }
  showTagAt(text, mesh.position.x, mesh.position.y + 0.3, mesh.position.z);
}

/* カーソルを当てている壁の表示を作り直す。 */
function refreshHover() {
  if (!hoverWall) return;
  const { ri, key } = hoverWall;
  const tgt = pushTarget(ri, key);
  if (!tgt) { setHover(null); return; }
  const r = tgt.rect;
  const rng = rangeOf(tgt.partial, r, key, hoverWall);
  drawBand(r, key, rng);
  const e = edgeInfo(r, key);
  const cx = rng.along ? ((key === 'w') ? r.x0 : r.x1) : (rng.a + rng.b) / 2;
  const cz = rng.along ? (rng.a + rng.b) / 2 : ((key === 's') ? r.z0 : r.z1);
  showHint(rng.whole
    ? `<b>壁ぜんぶ ${rng.w.toFixed(1)} m</b><br>ドラッグ＝この向きの寸法を変える`
      + (tgt.partial ? '<br>ホイール＝範囲を狭める' : '')
    : `<b>押し出す範囲 ${rng.w.toFixed(1)} m</b><br>ドラッグ＝この部分だけ張り出す`
      + '<br>ホイール＝範囲を増減（0.5m ずつ）');
  // ⚠️ ホイールを範囲の増減に使うので、その間はズームを止める。
  //   両方に効くと、範囲を変えたつもりで視点まで動いて訳が分からなくなる。
  controls.enableZoom = !tgt.partial;
}

/* カーソルが壁から外れたときの後始末。 */
function setHover(h) {
  if (!hoverWall && !h) return;
  hoverWall = h;
  clearGroup(bandGroup);
  clearHint();
  controls.enableZoom = true;
}

/* 右のパネルの下に、いま当てているものの説明を出す。 */
let hintEl = null;
function showHint(html) {
  if (!hintEl) hintEl = el('hint');
  if (!hintEl) return;
  hintEl.innerHTML = html;
  // パネルのすぐ下に付ける。パネルの高さは中身で変わるので毎回測る。
  const p = el('panel').getBoundingClientRect();
  hintEl.style.top = `${p.bottom + 8}px`;
  hintEl.style.display = 'block';
}
function clearHint() {
  if (hintEl) hintEl.style.display = 'none';
}

// ホイールで押し引きの範囲を増減する（カーソルを当てている間／掴んでいる間）。
renderer.domElement.addEventListener('wheel', (ev) => {
  const t = wallDrag || hoverWall;
  const partial = wallDrag ? wallDrag.partial
    : (hoverWall && (pushTarget(hoverWall.ri, hoverWall.key) || {}).partial);
  if (!t || !partial) return;        // 壁ぜんぶしか動かせない壁では効かない
  ev.preventDefault();
  t.steps += (ev.deltaY < 0) ? 1 : -1;
  if (wallDrag) applyWallDrag(); else refreshHover();
}, { passive: false });

const endRidgeDrag = () => {
  if (!ridgeDrag) return;
  const d = ridgeDrag;
  ridgeDrag = null;
  controls.enabled = true;
  clearHint();
  hideSizeTag();
  if (!d.moved && d.branch) { toggleBranch(d.branch); return; }
  rebuild();
};
const endEaveDrag = () => {
  if (!eaveDrag) return;
  eaveDrag = null;
  controls.enabled = true;
  hideSizeTag();
  clearHint();
  clearGroup(bandGroup);
};
const endFlatDrag = () => {
  if (!flatDrag) return;
  flatDrag = null;
  controls.enabled = true;
  hideSizeTag();
  clearHint();
};
const endWallDrag = () => {
  if (!wallDrag) return;
  wallDrag = null;
  controls.enabled = true;
  hideSizeTag();
  clearHint();
  clearGroup(bandGroup);
  hoverWall = null;
  // ★ 後始末。丸めの取りこぼしで残った、外形に効いていない張り出しを捨てる。
  const before = state.extras.length;
  state.extras = state.extras.filter((e) => !isSwallowed(e, state.base));
  if (state.extras.length !== before) { applyLayout(); rebuild(); syncUI(); }
};

/* 押し引きしている辺の寸法を、その壁のそばに出す。
   ★ 右のパネルまで目を動かさずに数値が読めるようにする。
     ⚠️ 出しっぱなしにはしない。触っていない間も浮いていると視界の邪魔になる。 */
let sizeTagEl = null;
const _stV = new THREE.Vector3();
function showSizeTag(drag) {
  if (!sizeTagEl) {
    sizeTagEl = document.createElement('div');
    sizeTagEl.id = 'sizeTag';
    document.body.appendChild(sizeTagEl);
  }
  const { key } = drag;
  const whole = drag.rng ? drag.rng.whole : true;
  // 壁ぜんぶなら「その向きの寸法」、一部なら「押し出した奥行き」を出す
  const b = whole
    ? (drag.kind === 'base' ? state.base : state.extras[drag.ei])
    : (state.extras[state.extras.length - 1] || drag.rect0);
  if (!b) return;
  const along = (key === 'w' || key === 'e');
  const len = whole
    ? (along ? (b.x1 - b.x0) : (b.z1 - b.z0))
    : Math.abs(along
      ? (key === 'e' ? b.x1 - drag.rect0.x1 : drag.rect0.x0 - b.x0)
      : (key === 'n' ? b.z1 - drag.rect0.z1 : drag.rect0.z0 - b.z0));
  // 一部押し出しでは、奥行きだけでなく【範囲の幅】も出す。
  // ⚠️ ホイールで幅を変えている最中に数値が無いと、何刻み動いたか分からない。
  const text = whole ? `${len.toFixed(1)} m`
    : `＋${len.toFixed(1)} m ／ 幅 ${(drag.rng ? drag.rng.w : 0).toFixed(1)} m`;
  // その壁の中央（軒高の少し上）を画面へ投影して、そこに置く
  const cx = (key === 'w') ? b.x0 : (key === 'e') ? b.x1 : (b.x0 + b.x1) / 2;
  const cz = (key === 's') ? b.z0 : (key === 'n') ? b.z1 : (b.z0 + b.z1) / 2;
  showTagAt(text, cx, state.eaveY * 0.6, cz);
}

/* 軒先を出し入れしている間、その辺のそばに寸法を出す。 */
function showEaveTag(e, out) {
  const line = e.coord + e.sgn * out;
  const mid = e.iv.length ? (e.iv[0][0] + e.iv[e.iv.length - 1][1]) / 2 : 0;
  const y = state.eaveY - state.slope * out;
  const [x, z] = e.along ? [line, mid] : [mid, line];
  showTagAt(`軒の出 ${Math.round(out * 1000)} mm`, x, y + 0.3, z);
}

/* 平場を広げ縮めしている間、その場に広さを出す。 */
function showFlatTag() {
  const mesh = handleGroup.children.find((c) => c.userData.flatHandle);
  if (!mesh) { hideSizeTag(); return; }
  const text = state.parapet ? `陸屋根（パラペット ${Math.round(PARAPET_H * 1000)} mm）`
    : state.flatT >= 1 - 1e-9 ? '平場なし（素の屋根）'
      : (flatBand > 0
        ? `平場 ${flatArea.toFixed(1)} ㎡ ／ 帯 ${flatBand.toFixed(2)} m`
        : `平場 ${flatArea.toFixed(1)} ㎡`);
  showTagAt(text, mesh.position.x, mesh.position.y + 0.4, mesh.position.z);
}

/* 三次元の点のところに札を出す。 */
function showTagAt(text, x, y, z) {
  if (!sizeTagEl) {
    sizeTagEl = document.createElement('div');
    sizeTagEl.id = 'sizeTag';
    document.body.appendChild(sizeTagEl);
  }
  sizeTagEl.textContent = text;
  _stV.set(x, y, z).project(camera);
  const r = renderer.domElement.getBoundingClientRect();
  sizeTagEl.style.left = `${r.left + (_stV.x + 1) / 2 * r.width}px`;
  sizeTagEl.style.top = `${r.top + (1 - _stV.y) / 2 * r.height}px`;
  sizeTagEl.style.display = 'block';
}
function hideSizeTag() {
  if (sizeTagEl) sizeTagEl.style.display = 'none';
}
renderer.domElement.addEventListener('pointercancel', () => {
  endRidgeDrag(); endWallDrag(); endFlatDrag(); endEaveDrag();
});
renderer.domElement.addEventListener('pointerup', () => {
  if (eaveDrag) { endEaveDrag(); return; }
  if (flatDrag) { endFlatDrag(); return; }
  if (wallDrag) { endWallDrag(); return; }
  if (ridgeDrag) { endRidgeDrag(); return; }
  downAt = null;
});

// -----------------------------------------------------------------------------
// UI
// -----------------------------------------------------------------------------
(function setupUI() {
  // ★ パネルに残す操作は勾配だけ。形は【モデルの上で】決める。
  //   ⚠️ 平面形状のボタンを外したので、L字・T字は壁の一部押し出しで作る。
  //     コの字は押し出し2か所、I型（3切妻）は棟の端をクリック。
  for (const [id, key] of [['eaveOut', 'eaveOut'], ['rakeOut', 'rakeOut']]) {
    el(id).addEventListener('input', () => {
      state[key] = Number(el(id).value) / 1000;   // mm → m
      applyLayout();   // 枝の幅は軒の出に依るので、並びから組み直す
      rebuild();
      syncUI();
    });
  }

  el('slope').addEventListener('input', () => {
    // ⚠️ つまみは 0〜60 で【0.1寸きざみ】。寸に直すには 10、勾配（比）に直すには
    //   100 で割る。ここを 10 で割っていたため、4寸のつもりが 40寸になっていた。
    state.slope = Number(el('slope').value) / 100;
    rebuild();
    syncUI();
  });

})();

function syncUI() {
  el('slopeVal').textContent = `${(state.slope * 10).toFixed(1)} 寸`;
  el('eaveOutVal').textContent = `${Math.round(state.eaveOut * 1000)} mm`;
  el('rakeOutVal').textContent = `${Math.round(state.rakeOut * 1000)} mm`;
}

/* 水平面上の多角形の面積[㎡]。 */
function planArea(poly) {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    a += p.x * q.z - q.x * p.z;
  }
  return Math.abs(a) / 2;
}

/* 建物の外形の面積[㎡]。
   ⚠️ 矩形の面積を足してはいけない。矩形は重ねて形を持っているので、
     重なりを二重に数えてしまう。x と z の切れ目で碁盤に刻み、
     どれかの矩形に入っている桝だけを足す。 */
function footprintArea(rects) {
  const xs = [...new Set(rects.flatMap((r) => [r.x0, r.x1]))].sort((a, b) => a - b);
  const zs = [...new Set(rects.flatMap((r) => [r.z0, r.z1]))].sort((a, b) => a - b);
  let area = 0;
  for (let i = 0; i + 1 < xs.length; i++) {
    for (let j = 0; j + 1 < zs.length; j++) {
      const cx = (xs[i] + xs[i + 1]) / 2, cz = (zs[j] + zs[j + 1]) / 2;
      const inside = rects.some(
        (r) => cx > r.x0 && cx < r.x1 && cz > r.z0 && cz < r.z1,
      );
      if (inside) area += (xs[i + 1] - xs[i]) * (zs[j + 1] - zs[j]);
    }
  }
  return area;
}

/* いまの屋根の呼び名。名前が付けられないときは null。
   ★ 呼べるのは【屋根が1枚で、棟の両端が同じ状態】のときだけ。
     ⚠️ 枝分かれや張り出しで屋根が複数枚になると、全体を一言で呼ぶ名前は無い。
       無理に付けると嘘になるので、そのときは行ごと出さない。 */
function roofName(result) {
  if (state.parapet) return '陸屋根（パラペット）';
  // ★ 勾配 0 は形が1つしかない。輪郭がどうであれ陸屋根なので、屋根の枚数を問わない。
  if (result.ridgeY - result.eaveY < 1e-3) return '陸屋根';
  // ★ 平場が壁いっぱいまで広がったら、輪郭を問わず陸屋根。
  if (result.flat && state.flatT <= 1e-3) return '陸屋根';
  const flat = !!result.flat;
  const base = baseRoofName(result);
  // へこませているときは「勾配パラペット」。元の形が言えるなら添える。
  // ⚠️ 元の形の括弧書き（ずれ○m）まで抱えると括弧が二重になり、行が折り返す。
  if (flat) {
    const short = base ? base.replace(/（.*$/, '') : null;
    return short ? `勾配パラペット（${short}）` : '勾配パラペット';
  }
  return base;
}

/* へこませる前の、素の屋根の呼び名。 */
function baseRoofName(result) {
  if (layout.rects.length !== 1 || !result.roofs.length) return null;
  const roof = result.roofs[0];
  const ridge = ridgeOf(roof.r, 0, result);
  const ga = gableOf(0, ridge.a.edge), gb = gableOf(0, ridge.b.edge);
  if (Math.abs(ga - gb) > 0.02) return null;       // 左右で違う＝呼び名がない
  const g = (ga + gb) / 2;
  const t = Math.abs(roof.t || 0);
  if (g >= 0.999) {
    if (t >= 0.999) return '片流れ';
    if (t > 1e-6) {
      const d = (t * roof.hs).toFixed(1);
      return `${roof.step ? '差し掛け屋根' : '招き屋根'}（ずれ ${d} m）`;
    }
    return '切妻';
  }
  if (g <= 1e-6) {
    const sq = Math.abs((roof.r.x1 - roof.r.x0) - (roof.r.z1 - roof.r.z0)) < 1e-6;
    return sq ? '方形' : '寄棟';
  }
  // ★ 妻がどこまで下りているかで呼び分ける。上のほうだけ妻＝はかま腰（半切妻）、
  //   下まで妻＝入母屋。g はその面を「どれだけ使わないか」なので、そのまま境になる。
  return g >= 0.5 ? '入母屋' : 'はかま腰';
}

function syncReadout(result) {
  // 「：」の位置を揃えるため、1行を［項目］［：］［値］の3つに分けて出す。
  const cells = [];
  const add = (k, v) => cells.push(
    `<span class="k">${k}</span><span>：</span><span class="v">${v}</span>`,
  );

  const name = roofName(result);
  if (name) add('屋根形', name);

  if (state.base) {
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    for (const r of layout.rects) {
      x0 = Math.min(x0, r.x0); z0 = Math.min(z0, r.z0);
      x1 = Math.max(x1, r.x1); z1 = Math.max(z1, r.z1);
    }
    // ★ 寸法は差し渡し、面積は【実際に建っている広さ】。張り出しがあると
    //   両者は一致しない。掛け算に合わない数字が出るのが正しい姿。
    add('外形', `${(x1 - x0).toFixed(1)} × ${(z1 - z0).toFixed(1)} m`
      + `（${footprintArea(layout.rects).toFixed(1)} ㎡）`);
    if (state.extras.length) add('張り出し', `${state.extras.length} か所`);
  }
  add('軒高', `${state.eaveY.toFixed(1)} m`);
  // ★ 平場をつくると素の棟は無くなり、帯に低い峰が立つだけ。呼び名も変える。
  //   ⚠️ 高さは result.ridgeY（素の棟）ではなく、実際に描かれた面から採ること。
  let topY = result.eaveY;
  for (const f of result.faces) for (const y of f.y) topY = Math.max(topY, y);
  if (state.parapet) topY = state.eaveY + PARAPET_H;   // 笠木の天端がいちばん高い
  add(result.flat ? '最高部' : '棟高', `${topY.toFixed(2)} m`);
  if (state.parapet) {
    add('パラペット', `${Math.round(PARAPET_H * 1000)} mm`
      + `（厚 ${Math.round(PARAPET_T * 1000)} mm）`);
  }
  // ⚠️ faces は計算の都合で細かく割れた破片。枚数として出すと実感と合わないので、
  //   同じ平面に乗っているものをまとめて「屋根面」の数として数える。
  // ⚠️ 平場（水平な面）は数に入れない。別の行で広さを出すので、二重に数えることになる。
  const sloped = result.faces.filter((f) => Math.hypot(f.plane.a, f.plane.b) > 1e-9);
  const planes = new Set(sloped.map(
    (f) => `${f.plane.a.toFixed(4)},${f.plane.b.toFixed(4)},${f.plane.c.toFixed(4)}`,
  ));
  // ★ 屋根の面積は【勾配なりの斜めの広さ】。水平に投影した広さを、
  //   その面の傾き（勾配 g）で √(1+g²) 倍して伸ばす。
  let roofArea = 0;
  for (const f of sloped) {
    const g = Math.hypot(f.plane.a, f.plane.b);
    roofArea += planArea(f.poly) * Math.sqrt(1 + g * g);
  }
  // 勾配0（＝全面が平場）のときは「屋根面 0 面」を出さない。平場の行だけで足りる。
  if (planes.size) add('屋根面', `${planes.size} 面（合計 ${roofArea.toFixed(1)} ㎡）`);
  // ★ 屋上の平場（水平な面）は屋根面と分けて出す。室外機を置く広さそのもの。
  flatArea = 0;
  for (const f of result.faces) {
    if (Math.hypot(f.plane.a, f.plane.b) < 1e-9) flatArea += planArea(f.poly);
  }
  // 周りに残った勾配屋根の帯の幅。軒先から平場の縁までの水平距離。
  // ★ ドーナツ状に残った勾配屋根の幅。【軒先から平場のふちまで】を水平に測る。
  //   ⚠️ 壁からではない。軒の出も屋根なので、屋根の幅と言えば軒先からになる。
  flatBand = result.flat ? result.flat.d : 0;
  // ⚠️ 平場は「ハンドルで作ったとき」だけではない。勾配0でも全面が平場になる。
  //   result.flat の有無で出し分けると、そのとき広さがどこにも出なくなる。
  if (flatArea > 1e-3) add('平場', `${flatArea.toFixed(1)} ㎡`);
  if (flatBand > 0.05) add('屋根の帯', `${flatBand.toFixed(2)} m（水平投影）`);
  add('谷', valleyLen > 0.01 ? `合計 ${valleyLen.toFixed(2)} m` : 'なし');

  const bad = findValleyProblem(result);
  el('warn').style.display = bad === null ? 'none' : '';
  if (bad !== null) {
    el('warn').textContent =
      `⚠ 谷が軒より ${(state.eaveY - bad).toFixed(2)} m 下がっています。`
      + '棟の間隔に対して勾配が緩すぎます（雨仕舞いが成立しません）。';
  }
  el('readout').innerHTML = cells.join('');
}

// -----------------------------------------------------------------------------
// 描画ループ
// -----------------------------------------------------------------------------
function resize() {
  const r = el('view').getBoundingClientRect();
  // ⚠️ 第3引数を false にしてはいけない。canvas の CSS サイズが更新されず、
  //   画素比 2 の画面では canvas が 2 倍の大きさで表示され、モデルが
  //   画面の右下へずれる（中央に置いたつもりが中央に来ない）。
  renderer.setSize(r.width, r.height);
  // ⚠️ 太い線は画面の大きさを材質側に持っている。ここで直さないと、窓を変えた
  //   とたんに太さが狂う。
  for (const m of fatMats.values()) {
    m.resolution.set(Math.max(r.width, 1), Math.max(r.height, 1));
  }
  camera.aspect = r.width / Math.max(r.height, 1);
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();

function tick() {
  controls.update();
  renderer.render(scene, camera);
  requestAnimationFrame(tick);
}

// ⚠️ 画面の大きさが決まってからフィットさせること。先に呼ぶと縦横比が
//   確定しておらず、モデルが中央からずれる。
setShape('rect');
requestAnimationFrame(() => { resize(); fitCamera(); });
tick();

// 動作確認から触れるように出しておく
window.__roof = {
  state, rebuild, applyLayout, buildRoof, scene, camera, renderer,
  computeRoof, ridgeHandles, visibleHandleKeys, watchedBuried, isBuried,
  footprintCentroid, roofName,
  roofGroup, wallGroup, lineGroup, handleGroup, bandGroup,
  get layout() { return layout; },
  get result() { return lastResult; },
};
