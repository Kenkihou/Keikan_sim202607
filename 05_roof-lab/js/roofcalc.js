// =============================================================================
// roofcalc — 平面形状から屋根の形を起こす
//
//   【考え方】
//     屋根は「屋根型」を選んで作るものではない。各軒線から内側へ勾配なりに
//     立ち上がる【傾いた平面】を並べ、その下側包絡（いちばん低いところ）を採る。
//     棟・隅棟は平面同士の交線として勝手に現れる。
//
//       h(p) = min（各辺から立ち上がる平面の高さ）
//
//     4辺すべてから立ち上げれば寄棟。妻側2辺を除けば切妻。途中まで立ち上げて
//     そこから上を垂直に切れば入母屋。【全部おなじ仕組み】で出る。
//
//   【谷はどこから出るか】
//     1枚の屋根（凸な輪郭）からは谷が絶対に出ない。下側包絡は必ず上に凸だから。
//     谷が出るのは【屋根を複数枚重ねて、高い方を採った】とき。
//
//       H(p) = max（各屋根の h(p)）
//
//     L字は矩形2枚、コの字は3枚。重なったところに谷が現れる。
//
//   【勾配と標高を揃える前提】
//     勾配は全屋根で共通。棟高は輪郭の幅から決まる（幅の広い矩形ほど高い棟）。
//     ⚠️ この前提だと「棟の位置」は選べない。軒から等距離の中央に決まる。
//       代わりに谷は水平面上で必ず45度の直線になり、いちばん素直な形になる。
// =============================================================================

// 数値のゆらぎを吸収する幅。座標は m なので 1mm 相当。
const EPS = 1e-3;

/* 座標を「同じ点かどうか」を照合するための鍵に直す。
   ⚠️ ただ toFixed(3) してはいけない。ごく小さな負の値は "-0.000" になり、
     "0.000" と別物として扱われる。座標が 0 をまたぐ建物では、同じ点のはずの
     頂点が一致せず、屋根の内側の辺が【外周】と誤判定されて黒線のゴミが残る。 */
const k3 = (v) => (Math.abs(v) < 5e-4 ? 0 : v).toFixed(3);
// これより小さい破片は捨てる[m²]。分割の副産物として出る髭を残さないため。
const MIN_AREA = 1e-4;

// -----------------------------------------------------------------------------
// 平面形状 — 重なりを許した矩形の集まりとして持つ
// -----------------------------------------------------------------------------
//   ⚠️ L字を「凹んだ1つの多角形」ではなく【矩形2枚の重ね】として持つのが要点。
//     凹多角形のままだと、遠くの辺の平面が届いてしまい高さが壊れる
//     （L字の縦棒の中で、横棒の上辺から立ち上がる平面が負の高さを与える）。
//     矩形に分けておけば各屋根は凸のまま扱え、重なりの max が谷を作る。
const SHAPES = {
  rect: {
    label: '矩形',
    rects: [{ x0: -5, z0: -3, x1: 5, z1: 3 }],     // 短辺6m × 長辺10m
    // ★ 棟の端をクリックすると、そこに直交する棟が生える（枝分かれ）。
    //   外形は矩形のまま。屋根の組み方だけが変わる。
    //   ⚠️ 平面形状の選択肢に「I型」として並べない。同じ建物なのに
    //     別物として選ばせると、行き来しているつもりになれない。
    branchable: true,
  },
  L: {
    label: 'L字',
    rects: [
      { x0: -5, z0: -5, x1: 5, z1: 0 },    // 横棒
      { x0: -5, z0: -5, x1: 0, z1: 5 },    // 縦棒（横棒と重なる）
    ],
  },
  U: {
    label: 'コの字',
    rects: [
      { x0: -6, z0: -5, x1: 6, z1: 0 },    // 底
      { x0: -6, z0: -5, x1: -1, z1: 5 },   // 左腕
      { x0: 1, z0: -5, x1: 6, z1: 5 },     // 右腕
    ],
  },
  // ★ 端部が平入り（短辺側が軒）、中央だけ棟が直交する形。
  //   ⚠️ 実務でよく見るこの形は【平面が凹んでいる（H字）】ときにしか成立しない。
  //     矩形の平面に棟の向きが違う屋根を混ぜて、なおかつ棟高を揃えようとすると、
  //     勾配を屋根ごとに変えるしかなくなる（いただいた .obj がまさにそれだった）。
  //     勾配を揃える前提では、平面をこの形にするのが素直な答えになる。
  H: {
    label: 'H字',
    rects: [
      { x0: -6, z0: -4, x1: -2, z1: 4 },   // 左（棟は南北）
      { x0: 2, z0: -4, x1: 6, z1: 4 },     // 右（棟は南北）
      { x0: -6, z0: -2, x1: 6, z1: 2 },    // 中央（棟は東西＝直交）
    ],
  },
  T: {
    label: 'T字',
    rects: [
      { x0: -6, z0: -5, x1: 6, z1: 0 },    // 横棒
      { x0: -2.5, z0: -5, x1: 2.5, z1: 5 },// 縦棒
    ],
  },
};

// 矩形の4辺。内側を向く向きで並べる（西・東・南・北）。
const EDGE_KEYS = ['w', 'e', 's', 'n'];
const EDGE_LABEL = { w: '西', e: '東', s: '南', n: '北' };

/* 矩形 r の辺 key から、その辺を含む鉛直面の「内側向き法線」と位置を返す。 */
function edgeInfo(r, key) {
  if (key === 'w') return { nx: 1, nz: 0, px: r.x0, pz: 0 };   // x = x0、内側は x>x0
  if (key === 'e') return { nx: -1, nz: 0, px: r.x1, pz: 0 };  // x = x1、内側は x<x1
  if (key === 's') return { nx: 0, nz: 1, px: 0, pz: r.z0 };   // z = z0、内側は z>z0
  return { nx: 0, nz: -1, px: 0, pz: r.z1 };                   // z = z1、内側は z<z1
}

/* 軒から棟までの水平距離。＝棟の高さを決める値。
   ★ 切妻にした辺は屋根面を持たないので、棟の位置に効かない。
     南北を切妻にすれば東西からだけ立ち上がり、棟は南北方向に走る。
     ⚠️ ここを「短辺の半分」で固定していると、切妻で棟の向きを変えたときに
       棟高が合わなくなる。立ち上がる辺だけを見て測ること。 */
function halfSpanOf(r, ri, gables) {
  const on = (key) => (gables[`${ri}:${key}`] ?? 0) < 1 - EPS;   // 立ち上がる辺か
  const wx = r.x1 - r.x0, wz = r.z1 - r.z0;
  const cands = [];
  if (on('w') && on('e')) cands.push(wx / 2);
  else if (on('w') || on('e')) cands.push(wx);      // 片側だけ＝片流れ
  if (on('s') && on('n')) cands.push(wz / 2);
  else if (on('s') || on('n')) cands.push(wz);
  return cands.length ? Math.min(...cands) : 0;
}

/* 棟をどちらへずらせるか。'x'（東西へずらす）/ 'z'（南北へずらす）/ null。
   ★ ずらせるのは【向かい合う2辺が屋根面を持ち、もう一方の対が2辺とも切妻】のとき、
     つまり素の切妻だけ。寄棟のまま棟をずらすと、隅棟が45度でなくなるか、
     勾配を辺ごとに変えるしかなくなる。どちらも屋根として崩れるので許さない。 */
function shiftAxisOf(ri, gables) {
  const on = (key) => (gables[`${ri}:${key}`] ?? 0) < 1 - EPS;
  if (on('s') && on('n') && !on('w') && !on('e')) return 'z';
  if (on('w') && on('e') && !on('s') && !on('n')) return 'x';
  return null;
}

/* 切妻の指定を見ない、素の短辺の半分（互換のため残す）。 */
function halfSpan(r) {
  return Math.min(r.x1 - r.x0, r.z1 - r.z0) / 2;
}

// -----------------------------------------------------------------------------
// 平面と直線 — どちらも「a·x + b·z + c」の形で持つ
// -----------------------------------------------------------------------------
//   平面: h = a·x + b·z + c（高さ）
//   直線: a·x + b·z + c = 0（境界。正の側／負の側で分ける）
const evalAt = (f, x, z) => f.a * x + f.b * z + f.c;

/* 辺から立ち上がる平面を作る。軒高から、内側へ距離 × 勾配で上がる。 */
function edgePlane(r, key, slope, eaveY) {
  const e = edgeInfo(r, key);
  // 内側距離 d = nx·(x - px) + nz·(z - pz)。h = eaveY + slope·d
  return {
    a: slope * e.nx,
    b: slope * e.nz,
    c: eaveY - slope * (e.nx * e.px + e.nz * e.pz),
  };
}

/* 2つの平面が同じ高さになる直線。平行なら null。 */
function planeCross(p, q) {
  const a = p.a - q.a, b = p.b - q.b, c = p.c - q.c;
  if (Math.abs(a) < 1e-9 && Math.abs(b) < 1e-9) return null;
  return { a, b, c };
}

// -----------------------------------------------------------------------------
// 多角形の道具
// -----------------------------------------------------------------------------
function rectPoly(r) {
  return [
    { x: r.x0, z: r.z0 }, { x: r.x1, z: r.z0 },
    { x: r.x1, z: r.z1 }, { x: r.x0, z: r.z1 },
  ];
}

function polyArea(poly) {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    s += a.x * b.z - b.x * a.z;
  }
  return Math.abs(s) / 2;
}

function polyCentroid(poly) {
  let s = 0, cx = 0, cz = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const w = a.x * b.z - b.x * a.z;
    s += w; cx += (a.x + b.x) * w; cz += (a.z + b.z) * w;
  }
  if (Math.abs(s) < 1e-12) {
    // 面積ゼロに近い破片は頂点の平均で代用する
    let ax = 0, az = 0;
    for (const p of poly) { ax += p.x; az += p.z; }
    return { x: ax / poly.length, z: az / poly.length };
  }
  return { x: cx / (3 * s), z: cz / (3 * s) };
}

/* 凸多角形を直線の片側だけに切り取る（Sutherland–Hodgman）。
   sign = +1 で「a·x+b·z+c ≧ 0」の側、-1 でその反対。 */
function clipHalf(poly, line, sign) {
  const out = [];
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const a = poly[i], b = poly[(i + 1) % n];
    const da = sign * evalAt(line, a.x, a.z);
    const db = sign * evalAt(line, b.x, b.z);
    if (da >= -EPS) out.push(a);
    if ((da > EPS && db < -EPS) || (da < -EPS && db > EPS)) {
      const t = da / (da - db);
      out.push({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t });
    }
  }
  return out.length >= 3 ? out : null;
}

// -----------------------------------------------------------------------------
// 本体
// -----------------------------------------------------------------------------
/* 屋根を組み立てる。
     rects  … 屋根の輪郭（矩形の配列）。壁の外形を軒の出のぶん外へ広げたもの。
              ★ 軒の出は【輪郭を広げて屋根を作り直す】ことで表す。辺ごとに
                出が違えば輪郭の形が変わり、棟の位置も長さも高さもそれに従う。
                ⚠️ 出来上がった屋根を切り取ってはいけない。切り取ると隅棟が
                  輪郭の角へ向かわなくなり、寄棟の形が崩れる。
     slope  … 勾配（0.4 なら4寸）
     eaveY  … 軒の高さ[m]
     gables … 辺ごとの切妻の度合い。キーは "矩形番号:辺" で 0=寄棟 … 1=切妻
     flat   … 屋上の平場 { y, d }。null なら平場なし（素の屋根）。
              y … 平場の高さ[m]（＝屋上レベル。ふつうは軒高）
              d … 軒先から平場のふちまでの水平距離[m]
              ★ 平場そのものは【屋上レベルに固定】で、周りの屋根が
                【平場へ向かって下って】くる。軒先から上がって峰を越え、
                平場へ下りる＝01 のパラペット修景と同じ断面。
                高さは、軒からの水平距離 u を使って
                  h = 軒高 + 勾配 × min( u, max(0, d − u) )
                の1本で書ける。前半が上り、後半が下り、d を越えたら平場。
     shifts … 矩形番号 → { t, step }。t は棟のずれで 0=中央 … ±1=軒まで寄せた。
              step=false … 招き屋根（寄った側の軒を上げて、棟で1本に合わせる）
              step=true  … 差し掛け屋根（軒高はそのまま。棟に垂直な段差が出る）
   戻り値の faces は { poly, plane, y[] } の配列。poly は水平面上の多角形で、
   その各頂点の高さが y に入っている。 */
function buildRoof({ rects, slope, eaveY, gables, shifts = {}, flat = null }) {
  // --- 各矩形の棟高と、辺ごとの平面・打ち切り高さを用意する ---
  //   ★ 勾配はすべての屋根で共通。棟高は「軒から棟までの距離 × 勾配」で決まる。
  //     棟高も揃えたければ、その距離を揃えればよい（＝枝の幅を外形の短辺に取る）。
  //     こうすると山も谷も水平面上で必ず45度になり、いちばん素直な形になる。
  const roofs = rects.map((r, ri) => {
    const hs = halfSpanOf(r, ri, gables);
    const s = slope;
    const ridgeY0 = eaveY + s * hs;                  // 棟を中央に置いたときの高さ
    // ★ 棟のずれ。勾配は変えずに棟だけ横へ動かす。行き先は2通りある。
    //
    //   招き屋根 … 棟が【寄っていく側の軒を上げて】、棟で1本に合わせる。
    //     段差は出ない。短くなった屋根面が、そのぶん高い位置から始まる。
    //   差し掛け屋根 … 軒高は動かさない。両面が違う高さで終わり、棟に垂直な
    //     段差が出る。
    //
    //   ⚠️ 差し掛けで打ち切り高さを片側だけ動かしてはいけない。もう片側も同じ
    //     位置で打ち切らないと、両方の面が効かない帯ができて屋根に穴が開く。
    const axis = shiftAxisOf(ri, gables);
    const raw = shifts[ri];
    const sh = (typeof raw === 'number') ? { t: raw } : (raw || {});
    const t = axis ? Math.max(-1, Math.min(1, sh.t ?? 0)) : 0;
    const step = !!sh.step;
    const moved = Math.abs(t) > EPS;
    // 棟が【寄っていく】側と、【離れていく】側
    const nearKey = (axis === 'z') ? (t > 0 ? 'n' : 's') : (t > 0 ? 'e' : 'w');
    const farKey = (axis === 'z') ? (t > 0 ? 's' : 'n') : (t > 0 ? 'w' : 'e');
    const ridgeY = eaveY + s * hs * (1 + Math.abs(t));
    // 招き屋根で、寄った側の軒を持ち上げる量。
    //   ★ 棟までの水平距離が hs(1-|t|) に縮むので、勾配なりに届かなくなった分
    //     ＝ 2·s·hs·|t| だけ軒を上げると、ちょうど棟で出会う。
    const rise = 2 * s * hs * Math.abs(t);
    const edges = EDGE_KEYS.map((key) => {
      const g = gables[`${ri}:${key}`] ?? 0;
      // ★ 切妻の度合いを「その面をどの高さまで使うか」に読み替える。
      //   g=0 … 棟まで使う（寄棟）
      //   g=1 … まったく使わない（切妻。妻壁で垂直に切る）
      //   中間 … 途中まで斜めに上がって、そこから垂直（入母屋・はかま腰）
      let base = eaveY;                              // その辺の軒の高さ
      let limitY = eaveY + (1 - g) * (ridgeY0 - eaveY);
      if (axis && moved && (key === nearKey || key === farKey)) {
        if (step) {
          limitY = eaveY + s * hs * (key === farKey ? 1 + Math.abs(t) : 1 - Math.abs(t));
        } else {
          if (key === nearKey) base = eaveY + rise;
          limitY = ridgeY;                           // 棟で出会うので打ち切らない
        }
      }
      return { key, plane: edgePlane(r, key, s, base), limitY, gable: g, base };
    });
    return { r, ri, ridgeY, ridgeY0, edges, slope: s, hs, axis, t, step };
  });

  // --- 屋上の平場と、そこへ下りる面 ---
  //   ★ ある辺から立ち上がる面 h_e に対して、平場へ下りる面は
  //       crater_e = (平場の高さ + 勾配×d + その辺の軒高) − h_e
  //     という【上下を裏返した】平面になる。傾きは同じで向きだけ逆。
  //   ⚠️ 下りる面がどの辺のものになるかは、上る面の勝者とかならず一致する
  //     （裏返しただけなので、最小が最大に入れ替わるだけ）。だから面の割り方は
  //     素の屋根と同じままでよく、増えるのは「峰」と「平場のふち」の2本だけ。
  const flatPlane = flat ? { a: 0, b: 0, c: flat.y } : null;
  const downPlane = (p, base) => ({
    a: -p.a, b: -p.b, c: (flat.y + slope * flat.d + base) - p.c,
  });

  // ⚠️ 上の宣言は【線を集めるより前】に置くこと。境目の線を出すのに使う。
  // --- 領域を分ける直線を集める ---
  //   ⚠️ どの矩形でも【同じ直線の集まり】で切ること。矩形ごとに違う切り方をすると、
  //     重なった部分で破片の境目がずれ、屋根に隙間や重なりが出る。
  // ⚠️ 同じ直線が何度も出てくる（対称な形ほど多い）。そのまま全部で切ると
  //   破片が指数的に増えて重くなるので、正規化して重複を落とす。
  const lines = [];
  const lineSeen = new Set();
  const pushLine = (l) => {
    if (!l) return;
    const len = Math.hypot(l.a, l.b);
    if (len < 1e-9) return;
    // 向きを揃える（a>0、a=0 なら b>0）。裏返しの同じ線を1本と数えるため。
    const s = (l.a < -1e-12 || (Math.abs(l.a) <= 1e-12 && l.b < 0)) ? -1 : 1;
    const n = { a: s * l.a / len, b: s * l.b / len, c: s * l.c / len };
    const key = `${n.a.toFixed(5)},${n.b.toFixed(5)},${n.c.toFixed(4)}`;
    if (lineSeen.has(key)) return;
    lineSeen.add(key);
    lines.push(n);
  };
  for (const A of roofs) {
    for (let i = 0; i < A.edges.length; i++) {
      // 同じ屋根の中：どの面がいちばん低いかの境目（棟・隅棟になる）
      for (let j = i + 1; j < A.edges.length; j++) {
        pushLine(planeCross(A.edges[i].plane, A.edges[j].plane));
      }
      // 打ち切り高さの境目（入母屋の斜め→垂直、招き屋根の棟の段差）
      //   ⚠️ 入母屋（0<g<1）だけを見ていてはいけない。棟をずらした面は g=0 のまま
      //     棟より低いところで終わるので、その線が拾えず段差が出ない。
      if (A.edges[i].limitY > eaveY + EPS
          && A.edges[i].limitY < A.ridgeY - EPS
          && A.edges[i].gable < 1 - EPS) {
        const p = A.edges[i].plane;
        pushLine({ a: p.a, b: p.b, c: p.c - A.edges[i].limitY });
      }
      // 平場へ下りる面が作る境目。2本だけ。
      //   ・上る面と下る面が入れ替わるところ＝帯の峰
      //   ・下る面が平場の高さに達するところ＝平場のふち
      if (flat && A.edges[i].gable < 1 - EPS) {
        const p = A.edges[i].plane;
        const dp = downPlane(p, A.edges[i].base);
        pushLine(planeCross(dp, p));
        pushLine({ a: dp.a, b: dp.b, c: dp.c - flat.y });
      }
      // 別の屋根との境目（高い方が勝つ。谷になる）
      for (const B of roofs) {
        if (B === A) continue;
        for (const be of B.edges) pushLine(planeCross(A.edges[i].plane, be.plane));
      }
    }
  }
  // 矩形の縁そのものも境目になる（屋根の掛かる範囲の端）
  for (const { r } of roofs) {
    pushLine({ a: 1, b: 0, c: -r.x0 }); pushLine({ a: 1, b: 0, c: -r.x1 });
    pushLine({ a: 0, b: 1, c: -r.z0 }); pushLine({ a: 0, b: 1, c: -r.z1 });
  }

  // --- ある点における屋根の高さ ---
  //   その矩形の中で最も低い面（＝下側包絡）を採り、矩形どうしでは高い方を採る。
  const heightOfRoof = (roof, x, z) => {
    let best = Infinity, bestPlane = null, bestEdge = null;
    for (const e of roof.edges) {
      if (e.gable >= 1 - EPS) continue;              // 完全な切妻＝この面は無い
      // 棟を軒まで寄せた（＝片流れの、消えるほうの面）
      // ⚠️ 勾配 0 を巻き込まないこと。勾配 0 では棟高＝軒高なので、どの面も
      //   この条件に当てはまり、屋根が1枚も残らない（陸屋根が消える）。
      //   （roof.ridgeY を見ること。外側の ridgeY はこのあとで宣言される別物）
      if (e.limitY <= eaveY + EPS && roof.ridgeY > eaveY + EPS) continue;
      const h = evalAt(e.plane, x, z);
      if (h > e.limitY + EPS) continue;              // 打ち切りより上では効かない
      if (h < best) { best = h; bestPlane = e.plane; bestEdge = e; }
    }
    return { h: best, plane: bestPlane, edge: bestEdge };
  };
  const inRect = (r, x, z) => (
    x > r.x0 - EPS && x < r.x1 + EPS && z > r.z0 - EPS && z < r.z1 + EPS
  );
  const globalAt = (x, z) => {
    let best = -Infinity, bestPlane = null, bestRoof = null, bestEdge = null;
    for (const roof of roofs) {
      if (!inRect(roof.r, x, z)) continue;
      const got = heightOfRoof(roof, x, z);
      if (!got.plane) continue;
      if (got.h > best) {
        best = got.h; bestPlane = got.plane; bestRoof = roof; bestEdge = got.edge;
      }
    }
    // ★ 平場へ下る面は【屋根どうしの勝負がついた後】に掛ける。
    //   ⚠️ 矩形ごとに掛けてはいけない。L字は矩形の重ねで持っているので、
    //     建物の内部にある「その矩形だけの縁」から下り面が生えてしまう。
    //     軒からの距離は合併した外形で測るべきで、それは max を取った後の高さ。
    if (flat && bestPlane && bestEdge) {
      const dp = downPlane(bestPlane, bestEdge.base);
      const hd = Math.max(flat.y, evalAt(dp, x, z));
      if (hd < best) {
        best = hd;
        bestPlane = (hd > flat.y + EPS) ? dp : flatPlane;
        bestEdge = null;
      }
    }
    return { h: best, plane: bestPlane, roof: bestRoof, edge: bestEdge };
  };

  /* その点で【ri 以外の屋根】がどこまで来ているか。届いていなければ -Infinity。
     ★ 棟の球が屋根に潜っていないかを測るのに使う。
       ⚠️ globalAt では測れない。棟の球は自分の屋根の頂点に載っているので、
         自分を含めて測ると常に「潜っている」ことになってしまう。 */
  const heightExcept = (skipRi, x, z) => {
    let best = -Infinity;
    for (const roof of roofs) {
      if (roof.ri === skipRi) continue;
      if (!inRect(roof.r, x, z)) continue;
      const got = heightOfRoof(roof, x, z);
      if (got.plane && got.h > best) best = got.h;
    }
    return best;
  };

  // --- 各矩形を直線で刻み、破片ごとに勝者を決める ---
  const faces = [];
  const seen = new Set();
  for (const roof of roofs) {
    let pieces = [rectPoly(roof.r)];
    for (const line of lines) {
      const next = [];
      for (const p of pieces) {
        const a = clipHalf(p, line, 1);
        const b = clipHalf(p, line, -1);
        if (a && b) {
          if (polyArea(a) > MIN_AREA) next.push(a);
          if (polyArea(b) > MIN_AREA) next.push(b);
        } else {
          next.push(p);   // この直線とは交わらなかった
        }
      }
      pieces = next;
    }
    for (const poly of pieces) {
      if (polyArea(poly) <= MIN_AREA) continue;
      const c = polyCentroid(poly);
      const win = globalAt(c.x, c.z);
      if (!win.plane || win.roof !== roof) continue;   // 別の屋根に負けた破片
      // ⚠️ 重なった矩形は同じ場所に同じ破片を持つ。二重に描くと z ファイトするので、
      //   代表点で一意な鍵を作って1枚だけ残す。
      const key = `${k3(c.x)},${k3(c.z)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      faces.push({
        poly,
        plane: win.plane,
        ri: win.roof.ri,
        edgeKey: win.edge ? win.edge.key : null,
        y: poly.map((p) => evalAt(win.plane, p.x, p.z)),
      });
    }
  }

  // --- 統計（UI に出す） ---
  const ridgeY = Math.max(...roofs.map((r) => r.ridgeY));
  // ★ 【実際に描かれた面】の一覧を返す。"矩形番号:辺" と、矩形番号だけの2つ。
  //   ⚠️ 矩形を重ねると、負けた側の辺の面は1枚も描かれないことがある。
  //     その辺の寄棟⇔切妻をいくら動かしても見た目は変わらない。
  //     そこにハンドルを出すと「動くのに何も起きない」つまみになる。
  //     何が描かれたかは、勝敗を決めたここでしか分からないので、ここで集める。
  const drawn = new Set(), drawnRoofs = new Set();
  for (const f of faces) {
    drawnRoofs.add(f.ri);
    if (f.edgeKey) drawn.add(`${f.ri}:${f.edgeKey}`);
  }
  return {
    faces, roofs, ridgeY, eaveY, slope, flat,
    globalAt, heightExcept, drawn, drawnRoofs,
  };
}

/* いちばん高い棟の高さだけを、屋根を組み立てずに出す。
   ★ 「頂部をどこで切るか」を棟高からの割合で持ちたいので、切る前に棟高が要る。
     破片への分割をやらないので軽い。 */
function maxRidgeY({ rects, slope, eaveY, gables = {}, shifts = {} }) {
  let best = eaveY;
  rects.forEach((r, ri) => {
    const hs = halfSpanOf(r, ri, gables);
    const axis = shiftAxisOf(ri, gables);
    const raw = shifts[ri];
    const sh = (typeof raw === 'number') ? { t: raw } : (raw || {});
    const t = axis ? Math.max(-1, Math.min(1, sh.t ?? 0)) : 0;
    best = Math.max(best, eaveY + slope * hs * (1 + Math.abs(t)));
  });
  return best;
}

/* 屋根の外周（軒線）を拾う。壁を立てるのに使う。
   ⚠️ 破片の辺のうち【他の破片と共有していないもの】が外周。
     共有の判定は端点を丸めた鍵で行う（浮動小数のままでは一致しない）。 */
function outlineEdges(faces) {
  const count = new Map();
  const keyOf = (a, b) => {
    const ka = `${k3(a.x)},${k3(a.z)}`;
    const kb = `${k3(b.x)},${k3(b.z)}`;
    return ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
  };
  for (const f of faces) {
    for (let i = 0; i < f.poly.length; i++) {
      const a = f.poly[i], b = f.poly[(i + 1) % f.poly.length];
      const k = keyOf(a, b);
      const rec = count.get(k);
      if (rec) rec.n++;
      else count.set(k, { n: 1, a, b, ya: f.y[i], yb: f.y[(i + 1) % f.poly.length] });
    }
  }
  const out = [];
  for (const rec of count.values()) if (rec.n === 1) out.push(rec);
  return out;
}

/* 谷が軒より下に潜っていないか調べる。
   ★ 棟の間隔が広すぎて勾配が緩いと、谷が軒高を割り込む。図面上は描けても
     雨仕舞いが成立しないので、触っている最中に気づけるようにする。 */
function findValleyProblem(result) {
  let worst = Infinity;
  for (const f of result.faces) {
    for (const y of f.y) worst = Math.min(worst, y);
  }
  // 軒そのものは軒高なので、それより【明らかに】下がったときだけ拾う
  return worst < result.eaveY - 0.01 ? worst : null;
}

export {
  SHAPES, EDGE_KEYS, EDGE_LABEL, buildRoof, outlineEdges, findValleyProblem,
  halfSpan, halfSpanOf, shiftAxisOf, maxRidgeY, edgeInfo, k3,
};
