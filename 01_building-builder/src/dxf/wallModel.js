// =============================================================================
// wallModel — DXF の【読込用レイヤ】から、立体の元になる模型を組む
//
//   ★ 図面は【見た目】と【読込用】の二重立て。ここが読むのは読込用だけ。
//       W-EXT-200 / W-INT-100 … 壁の芯線（厚みはレイヤ名の数字[mm]）
//       O-DOOR / O-WIN / O-OPEN … 開口の芯線（壁の芯線の上に重ねてある）
//       S-RUN / S-RUN-7 / S-LAND / S-UP … 階段の走り・踊り場・上りの通り道
//   ⚠️ 見た目のレイヤ（二重線・建具の姿）は一切見ない。見た目を読もうとすると
//     図面ごとの流儀に振り回されて必ず破綻する。
//
//   単位は 01 に合わせて【mm】。世界座標へは
//       x = -(図面の x - 原点x)      z = (図面の y - 原点y)
//   で移す（01 は東が -x、北が +z）。
// =============================================================================

// 開口の高さ[mm]。床からの下端・上端。
const OPEN_H = { DOOR: [0, 2000], WIN: [800, 2000], OPEN: [0, 2000] };

/* 折れ線を線分の並びに。閉じていれば最後と最初もつなぐ。 */
function segsOf(p) {
  const out = [];
  for (let i = 0; i + 1 < p.pts.length; i++) out.push([p.pts[i], p.pts[i + 1]]);
  if (p.closed && p.pts.length >= 3) out.push([p.pts[p.pts.length - 1], p.pts[0]]);
  return out;
}

/* 通り芯のレイヤから、X1・Y1 にあたる座標を拾う。無ければ null。
   ⚠️ 通り芯は外形の外まで伸びているので、線の【向き】で縦横を見分けること。
     符号の丸（円）は線ではないので混ざらない。 */
export function gridOrigin(sheet) {
  const nm = sheet.layers.find((l) => /grid|芯/i.test(l));
  if (!nm) return null;
  const xs = [], ys = [];
  for (const p of sheet.polys) {
    if (p.layer !== nm) continue;
    for (let i = 0; i + 1 < p.pts.length; i++) {
      const a = p.pts[i], b = p.pts[i + 1];
      const dx = Math.abs(a.x - b.x), dy = Math.abs(a.y - b.y);
      if (dx < 1 && dy > 100) xs.push((a.x + b.x) / 2);        // 縦の通り芯
      else if (dy < 1 && dx > 100) ys.push((a.y + b.y) / 2);   // 横の通り芯
    }
  }
  if (!xs.length || !ys.length) return null;
  return { x: Math.min(...xs), y: Math.min(...ys) };
}

/* 線分の集まりを、つながっている塊ごとに分けて、それぞれの外接矩形を返す。
   ★ 図面では矩形も「4本の線」でしかない。端点を共有しているものを1つに
     まとめれば、走りが何枚描いてあっても拾える。
   ⚠️ 別々の走りどうしが端点で触れていると1枚に融ける。廻り階段では走りの
     間に必ず中壁か踊り場が入るので、実際には触れない。 */
function rectsOf(segs) {
  const key = (x, z) => Math.round(x) + ':' + Math.round(z);
  const par = segs.map((_, i) => i);
  const find = (i) => { while (par[i] !== i) { par[i] = par[par[i]]; i = par[i]; } return i; };
  const at = new Map();
  segs.forEach((s, i) => {
    for (const k of [key(s.ax, s.az), key(s.bx, s.bz)]) {
      if (at.has(k)) { const a = find(i), b = find(at.get(k)); if (a !== b) par[a] = b; }
      else at.set(k, i);
    }
  });
  const g = new Map();
  segs.forEach((s, i) => {
    const r = find(i);
    const b = g.get(r) || { x0: Infinity, x1: -Infinity, z0: Infinity, z1: -Infinity, steps: 0 };
    b.x0 = Math.min(b.x0, s.ax, s.bx); b.x1 = Math.max(b.x1, s.ax, s.bx);
    b.z0 = Math.min(b.z0, s.az, s.bz); b.z1 = Math.max(b.z1, s.az, s.bz);
    b.steps = Math.max(b.steps, s.steps || 0);
    g.set(r, b);
  });
  return [...g.values()].filter((r) => r.x1 - r.x0 > 1 && r.z1 - r.z0 > 1);
}

/* S-UP の線分を1本の折れ線につなぐ。
   ★ この折れ線1本で「どの部分を何番目に、どちら向きに上がるか」が決まる。
     走りや踊り場の側に番号や向きを持たせない。
   ⚠️ 上と下の別は【形からは分からない】。「最初に描いた線分の描き始めが下」
     と決めてある。サンプル DXF もその順で書き出している。 */
function pathOf(segs) {
  if (!segs.length) return null;
  const key = (x, z) => Math.round(x) + ':' + Math.round(z);
  const nb = new Map(), pos = new Map();
  segs.forEach((s, i) => {
    for (const [x, z] of [[s.ax, s.az], [s.bx, s.bz]]) {
      const k = key(x, z);
      pos.set(k, [x, z]);
      if (!nb.has(k)) nb.set(k, []);
      nb.get(k).push(i);
    }
  });
  const ends = [...nb.entries()].filter(([, v]) => v.length === 1).map(([k]) => k);
  let k = key(segs[0].ax, segs[0].az);
  if (!ends.includes(k)) k = ends.length ? ends[0] : k;
  const used = new Set(), pts = [pos.get(k)];
  for (;;) {
    const i = (nb.get(k) || []).find((j) => !used.has(j));
    if (i === undefined) break;
    used.add(i);
    const s = segs[i];
    const p = (key(s.ax, s.az) === k) ? [s.bx, s.bz] : [s.ax, s.az];
    pts.push(p);
    k = key(p[0], p[1]);
  }
  return pts.length >= 2 ? pts : null;
}

/* 走り・踊り場を、通り道の順に並べて向きを決める。
   ★ 通り道を細かく刻んで、どの部分の中を通ったかを順に見るだけ。交点を
     解かないので、L字でもコの字でも同じ手が通る。
   ⚠️ 境目ちょうどの点は【どちらにも入れない】。両方に当たると順番が乱れる。 */
function stairParts(runs, lands, path) {
  const all = [...runs.map((r) => ({ ...r, kind: 'run' })),
    ...lands.map((r) => ({ ...r, kind: 'land' }))];
  if (!all.length || !path) return null;
  let total = 0;
  for (let i = 0; i + 1 < path.length; i++) {
    total += Math.hypot(path[i + 1][0] - path[i][0], path[i + 1][1] - path[i][1]);
  }
  if (total < 1) return null;
  const at = (u) => {
    let d = u * total;
    for (let i = 0; i + 1 < path.length; i++) {
      const a = path[i], b = path[i + 1];
      const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (d <= L || i === path.length - 2) {
        const t = L < 1e-9 ? 0 : d / L;
        return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
      }
      d -= L;
    }
    return path[path.length - 1];
  };
  const N = 600;
  const seen = new Map();
  const order = [];
  for (let i = 0; i <= N; i++) {
    const p = at(i / N);
    const j = all.findIndex((r) => p[0] > r.x0 + 1e-6 && p[0] < r.x1 - 1e-6
      && p[1] > r.z0 + 1e-6 && p[1] < r.z1 - 1e-6);
    if (j < 0) continue;
    if (!seen.has(j)) { seen.set(j, { j, from: p, to: p }); order.push(seen.get(j)); }
    else seen.get(j).to = p;
  }
  if (!order.length) return null;
  return order.map((o) => {
    const r = all[o.j];
    const alongX = (r.x1 - r.x0) >= (r.z1 - r.z0);
    const d = alongX ? (o.to[0] - o.from[0]) : (o.to[1] - o.from[1]);
    return { ...r, alongX,
      len: alongX ? (r.x1 - r.x0) : (r.z1 - r.z0),
      dir: Math.sign(d) || 1 };
  });
}

/* 芯線がつながっている壁の塊のうち、いちばん長いものだけを返す。
   ★ つながり＝「端点が相手の芯線の上に乗っている」。壁は交点で終わっていて
     端点どうしが一致するとは限らないので、点の一致では拾えない。 */
function keepConnected(walls) {
  const T = 1;
  const on = (x, z, w) => (
    x > Math.min(w.x0, w.x1) - T && x < Math.max(w.x0, w.x1) + T
    && z > Math.min(w.z0, w.z1) - T && z < Math.max(w.z0, w.z1) + T);
  const par = walls.map((_, i) => i);
  const find = (i) => { while (par[i] !== i) { par[i] = par[par[i]]; i = par[i]; } return i; };
  for (let i = 0; i < walls.length; i++) {
    for (let j = i + 1; j < walls.length; j++) {
      const a = walls[i], b = walls[j];
      const hit = [[a.x0, a.z0], [a.x1, a.z1]].some(([x, z]) => on(x, z, b))
        || [[b.x0, b.z0], [b.x1, b.z1]].some(([x, z]) => on(x, z, a));
      if (!hit) continue;
      const ra = find(i), rb = find(j);
      if (ra !== rb) par[ra] = rb;
    }
  }
  const g = new Map();
  walls.forEach((w, i) => {
    const r = find(i);
    const len = Math.abs(w.x1 - w.x0) + Math.abs(w.z1 - w.z0);
    const rec = g.get(r) || { len: 0, ws: [] };
    rec.len += len; rec.ws.push(w);
    g.set(r, rec);
  });
  let best = null;
  for (const rec of g.values()) if (!best || rec.len > best.len) best = rec;
  return best ? best.ws : walls;
}

/* 読込用レイヤから模型を組む。origin は図面座標での原点（通り芯 X1/Y1）。
   返すのは 01 の世界座標（mm）。読めなければ null。 */
export function buildWallModel(polys, origin) {
  const P = (p) => [-(p.x - origin.x), (p.y - origin.y)];
  const walls = [], opens = [];
  const run = [], land = [], up = [];
  for (const p of polys) {
    const L = (p.layer || '').toUpperCase();
    const mw = /^W-(EXT|INT)-(\d+)$/.exec(L);
    const mo = /^O-(DOOR|WIN|OPEN)$/.exec(L);
    // 走りは S-RUN でも S-RUN-7 でもよい。数字は【その走りの段数】。
    const ms = /^S-RUN(?:-(\d+))?$/.exec(L);
    for (const [a, b] of segsOf(p)) {
      const pa = P(a), pb = P(b);
      if (mw || mo) {
        // 壁と開口は向きが要らないので、小さい順にそろえておく
        const s = { x0: Math.min(pa[0], pb[0]), x1: Math.max(pa[0], pb[0]),
          z0: Math.min(pa[1], pb[1]), z1: Math.max(pa[1], pb[1]) };
        if (mw) walls.push({ ...s, t: Number(mw[2]), ext: mw[1] === 'EXT' });
        // ⚠️ 種別も持ち帰る。高さだけでは窓と扉を見分けられない。
        else opens.push({ ...s, kind: mo[1], lo: OPEN_H[mo[1]][0], hi: OPEN_H[mo[1]][1] });
      } else if (ms || L === 'S-LAND' || L === 'S-UP') {
        // ⚠️ 階段は【描いた向き】が要る。生の端点で持つ。
        const e = { ax: pa[0], az: pa[1], bx: pb[0], bz: pb[1] };
        if (ms) { e.steps = Number(ms[1] || 0); run.push(e); }
        else (L === 'S-LAND' ? land : up).push(e);
      }
    }
  }
  if (!walls.length) return null;

  // ★ つながっている壁だけを残す。
  //   ⚠️ 囲みが少しでも大きいと、隣に並べて描いてある階の壁が1本混ざる。
  //     混ざると外形が一気に倍ほどになり、建物が壊れる。囲みの精度に頼らず、
  //     【芯線がつながっている塊】でいちばん大きいものを採る。
  const main = keepConnected(walls);
  const foot0 = main.length ? main : walls;

  // 外形（屋根・箱の外接寸法用）。外壁芯の外接矩形を、厚みの半分だけ外へ広げる。
  //   ⚠️ L字などでは外接矩形では足りない。まずは矩形の外形で通す。
  const ext = foot0.filter((w) => w.ext);
  const src = ext.length ? ext : foot0;
  const t = Math.max(...src.map((w) => w.t)) / 2;
  const foot = {
    x0: Math.min(...src.map((w) => w.x0)) - t,
    x1: Math.max(...src.map((w) => w.x1)) + t,
    z0: Math.min(...src.map((w) => w.z0)) - t,
    z1: Math.max(...src.map((w) => w.z1)) + t,
  };

  // 階段は【走り＋踊り場】の並び。まっすぐ1本のときも、同じ形で持つ。
  //   x0..z1 は全体の外接矩形。上階の床に開ける穴はこれを使う。
  let stair = null;
  const parts = stairParts(rectsOf(run), rectsOf(land), pathOf(up));
  if (parts && parts.length) {
    stair = { parts,
      x0: Math.min(...parts.map((p) => p.x0)), x1: Math.max(...parts.map((p) => p.x1)),
      z0: Math.min(...parts.map((p) => p.z0)), z1: Math.max(...parts.map((p) => p.z1)) };
  }
  // 外形の外に出たものは、隣の階の描き込みが紛れ込んだもの。落とす。
  const inFoot = (r) => r.x0 > foot.x0 - 1 && r.x1 < foot.x1 + 1
    && r.z0 > foot.z0 - 1 && r.z1 < foot.z1 + 1;
  if (stair && !stair.parts.every(inFoot)) stair = null;
  return { walls: foot0, opens: opens.filter(inFoot), stair, foot };
}
