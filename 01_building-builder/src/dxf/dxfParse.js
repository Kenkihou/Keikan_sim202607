// =============================================================================
// dxf — DXF(ASCII) を読んで「線の集まり」に直す
//
//   下絵として敷くのが目的なので、意味づけ（これは窓、これは寸法線）は一切しない。
//   レイヤ名だけ保って、あとは折れ線の配列にする。
//
//   ⚠️ ここで欲張って図面を解釈しようとすると、図面ごとの流儀に振り回されて
//     必ず破綻する。解釈はユーザーに任せ、このファイルは【正確に読む】だけに徹する。
// =============================================================================

// 円・円弧を折れ線に直すときの分割数。下絵なのでこれで足りる。
const CURVE_SEG = 32;

/* バイト列を文字列に。
   ⚠️ DXF は UTF-8 とは限らない。Jw_cad や古い AutoCAD は Shift_JIS で書く。
     UTF-8 として厳密に読んでみて、失敗したら Shift_JIS に切り替える。
     （レイヤ名が化けると指定レイヤを掴めなくなるので、ここは手を抜けない） */
export function decodeDXF(buf) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch (e) {
    return new TextDecoder('shift_jis').decode(buf);
  }
}

/* DXF は「コードの行」「値の行」の繰り返し。組にして返す。
   ⚠️ 数字として読めない行が混ざっても、そこで組がずれないように1行だけ捨てる。 */
function readPairs(text) {
  const lines = text.split(/\r\n|\r|\n/);
  const out = [];
  for (let i = 0; i + 1 < lines.length;) {
    const c = parseInt(lines[i].trim(), 10);
    if (Number.isNaN(c)) { i++; continue; }
    out.push([c, lines[i + 1]]);
    i += 2;
  }
  return out;
}

/* ENTITIES を読んで折れ線にする。
   戻り値 … { polys: [{ layer, pts: [{x,y}], closed }], layers: [名前] } */
export function parseDXF(text) {
  const pr = readPairs(text);
  const polys = [];
  const texts = [];      // ★ 見出し。「南立面図」などから図面の役割を当てるのに使う
  const layers = new Set();
  // ★ 線色も拾う。Jw_cad から来た図面は全部が同じレイヤに入っていることが多く、
  //   その場合はレイヤでは絞れない。色なら「外壁だけ色を変える」で分けられる。
  //   ⚠️ 62 が 256（ByLayer）のときは、レイヤに設定された色を使う。
  //     ここを見落とすと、ほとんどの線が「色 256」の一塊になって役に立たない。
  const layerColor = new Map();
  const colors = new Set();

  let section = null;
  let e = null;          // 組み立て中のエンティティ
  let poly = null;       // POLYLINE（旧形式）を組み立て中の入れ物

  const num = (v) => parseFloat(v);

  /* 組み立て中のものを確定して polys に移す。 */
  const flush = () => {
    if (!e) return;
    const layer = e.layer || '0';
    const add = (pts, closed) => {
      if (pts.length < 2) return;
      polys.push({ layer, pts, closed: !!closed, color: col });
      layers.add(layer); colors.add(col);
    };
    const col = (e.color === undefined || e.color === 256 || e.color === 0)
      ? (layerColor.get(layer) ?? 7) : e.color;
    if (e.type === 'LINE') {
      add([{ x: e.x1, y: e.y1 }, { x: e.x2, y: e.y2 }], false);
    } else if (e.type === 'LWPOLYLINE') {
      add(e.pts, (e.flags & 1) === 1);
    } else if (e.type === 'CIRCLE') {
      const pts = [];
      for (let i = 0; i <= CURVE_SEG; i++) {
        const t = (i / CURVE_SEG) * Math.PI * 2;
        pts.push({ x: e.cx + e.r * Math.cos(t), y: e.cy + e.r * Math.sin(t) });
      }
      add(pts, true);
    } else if (e.type === 'ARC') {
      const a0 = (e.a0 * Math.PI) / 180;
      let a1 = (e.a1 * Math.PI) / 180;
      if (a1 <= a0) a1 += Math.PI * 2;      // DXF の円弧は常に反時計回り
      const pts = [];
      for (let i = 0; i <= CURVE_SEG; i++) {
        const t = a0 + ((a1 - a0) * i) / CURVE_SEG;
        pts.push({ x: e.cx + e.r * Math.cos(t), y: e.cy + e.r * Math.sin(t) });
      }
      add(pts, false);
    } else if (e.type === 'TEXT' || e.type === 'MTEXT') {
      const v = ((e.chunks || []).join('') + (e.value || '')).trim();
      if (v) texts.push({ x: e.cx, y: e.cy, value: v, layer });
    } else if (e.type === 'SOLID') {
      // 塗り。輪郭だけ拾っておく（4点目が3点目と同じことが多い）
      const p = e.pts.filter((q, i, a) => i === 0
        || Math.hypot(q.x - a[i - 1].x, q.y - a[i - 1].y) > 1e-9);
      add(p, true);
    }
    e = null;
  };

  for (let i = 0; i < pr.length; i++) {
    const [code, raw] = pr[i];
    const val = raw.trim();

    if (code === 0) {
      // 旧形式の POLYLINE は VERTEX が続き SEQEND で終わる。まとめ役はここ。
      if (poly) {
        if (val === 'VERTEX') { flush(); e = { type: 'VERTEX', layer: poly.layer }; continue; }
        if (val === 'SEQEND') {
          flush();
          if (poly.pts.length >= 2) {
            polys.push({ layer: poly.layer, pts: poly.pts, closed: (poly.flags & 1) === 1 });
            layers.add(poly.layer);
          }
          poly = null;
          continue;
        }
      }
      flush();
      if (val === 'SECTION') { section = '?'; continue; }
      if (val === 'ENDSEC') { section = null; continue; }
      if (section === 'TABLES') {
        if (val === 'LAYER') { e = { type: 'LAYERDEF' }; continue; }
        e = null; continue;
      }
      if (section !== 'ENTITIES') continue;

      if (val === 'LINE') e = { type: 'LINE' };
      else if (val === 'LWPOLYLINE') e = { type: 'LWPOLYLINE', pts: [], flags: 0 };
      else if (val === 'POLYLINE') { poly = { pts: [], flags: 0, layer: '0' }; e = { type: 'POLYHEAD' }; }
      else if (val === 'CIRCLE') e = { type: 'CIRCLE' };
      else if (val === 'ARC') e = { type: 'ARC' };
      else if (val === 'SOLID') e = { type: 'SOLID', pts: [] };
      else if (val === 'TEXT' || val === 'MTEXT') e = { type: val, chunks: [] };
      continue;
    }

    // セクション名（0/SECTION の直後の 2 コード）
    if (code === 2 && section === '?') { section = val; continue; }
    if (!e) continue;

    if (e.type === 'LAYERDEF') {
      if (code === 2) e.name = val;
      if (code === 62) layerColor.set(e.name, Math.abs(parseInt(val, 10)) || 7);
      continue;
    }
    if (code === 8) {
      if (e.type === 'POLYHEAD' && poly) poly.layer = val;
      e.layer = val;
      continue;
    }
    if (code === 62) { e.color = parseInt(val, 10); continue; }
    if (e.type === 'POLYHEAD' && code === 70 && poly) { poly.flags = parseInt(val, 10) || 0; continue; }
    if (e.type === 'VERTEX') {
      if (code === 10) e.vx = num(val);
      if (code === 20 && poly) poly.pts.push({ x: e.vx, y: num(val) });
      continue;
    }
    if (e.type === 'LINE') {
      if (code === 10) e.x1 = num(val);
      if (code === 20) e.y1 = num(val);
      if (code === 11) e.x2 = num(val);
      if (code === 21) e.y2 = num(val);
      continue;
    }
    if (e.type === 'LWPOLYLINE' || e.type === 'SOLID') {
      if (code === 70) e.flags = parseInt(val, 10) || 0;
      if (code === 10) e.px = num(val);
      if (code === 20) e.pts.push({ x: e.px, y: num(val) });
      continue;
    }
    if (e.type === 'TEXT' || e.type === 'MTEXT') {
      // ⚠️ MTEXT は長い文字列を 3 コードで分割し、最後の断片だけ 1 コードで送る。
      if (code === 1) e.value = val;
      if (code === 3) e.chunks.push(val);
      if (code === 10) e.cx = num(val);
      if (code === 20) e.cy = num(val);
      continue;
    }
    if (e.type === 'CIRCLE' || e.type === 'ARC') {
      if (code === 10) e.cx = num(val);
      if (code === 20) e.cy = num(val);
      if (code === 40) e.r = num(val);
      if (code === 50) e.a0 = num(val);
      if (code === 51) e.a1 = num(val);
      continue;
    }
  }
  flush();
  return { polys, texts, layers: [...layers].sort(),
    colors: [...colors].sort((a, b) => a - b) };
}

/* AutoCAD の色番号を、画面に出す色へ。1〜9 だけ分かれば足りる。 */
export function aciColor(n) {
  const t = { 1: '#ff0000', 2: '#ffff00', 3: '#00ff00', 4: '#00ffff',
    5: '#0000ff', 6: '#ff00ff', 7: '#333333', 8: '#808080', 9: '#c0c0c0' };
  return t[n] || '#666666';
}

/* 1枚のシートに並んだ図面を、離れ具合で【かたまり】に分ける。
   ★ 実務の DXF は平面図も立面図も1ファイルに並んでいる。図面ごとに切り出す
     必要があるが、矩形で囲わせるより【自動で塊に割ってから役割を選ばせる】ほうが
     速いし、囲み損ねもない。
   ⚠️ 線の外接矩形で塊を判定してはいけない。図面枠の矩形1本で全部が
     つながってしまう。線が【実際に通っている】ところだけを印にする。 */
export function clusterPolys(polys, ratio = 0.008) {
  const bb = bboxOf(polys);
  if (!bb) return [];
  // ★ 分け方の細かさはシートによって違う。図面の間隔が狭ければ細かく、
  //   図面が飛び飛びの線でできていれば粗く。既定を置きつつ外から変えられるようにする。
  const cell = Math.max(bb.x1 - bb.x0, bb.y1 - bb.y0) * ratio || 1;
  const parent = polys.map((_, i) => i);
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const uni = (a, b) => { a = find(a); b = find(b); if (a !== b) parent[b] = a; };

  const map = new Map();
  const mark = (i, x, y) => {
    const k = `${Math.floor(x / cell)},${Math.floor(y / cell)}`;
    let a = map.get(k);
    if (!a) { a = []; map.set(k, a); }
    if (a[a.length - 1] !== i) a.push(i);
  };
  polys.forEach((p, i) => {
    const n = p.pts.length;
    const seg = (a, b) => {
      const L = Math.hypot(b.x - a.x, b.y - a.y);
      const k = Math.max(1, Math.ceil(L / (cell / 2)));
      for (let t = 0; t <= k; t++) mark(i, a.x + (b.x - a.x) * t / k, a.y + (b.y - a.y) * t / k);
    };
    for (let s = 0; s + 1 < n; s++) seg(p.pts[s], p.pts[s + 1]);
    if (p.closed && n >= 3) seg(p.pts[n - 1], p.pts[0]);
    if (n === 1) mark(i, p.pts[0].x, p.pts[0].y);
  });
  for (const [k, list] of map) {
    for (let i = 1; i < list.length; i++) uni(list[0], list[i]);
    const [cx, cy] = k.split(',').map(Number);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        if (!dx && !dy) continue;
        const o = map.get(`${cx + dx},${cy + dy}`);
        if (o) uni(list[0], o[0]);
      }
    }
  }
  const groups = new Map();
  polys.forEach((p, i) => {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(p);
  });
  return [...groups.values()]
    .map((g) => ({ polys: g, bbox: bboxOf(g) }))
    .filter((g) => g.bbox)
    .sort((a, b) => (b.bbox.x1 - b.bbox.x0) * (b.bbox.y1 - b.bbox.y0)
      - (a.bbox.x1 - a.bbox.x0) * (a.bbox.y1 - a.bbox.y0));
}

/* 折れ線の集まりの外接矩形。 */
export function bboxOf(polys) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of polys) {
    for (const q of p.pts) {
      x0 = Math.min(x0, q.x); y0 = Math.min(y0, q.y);
      x1 = Math.max(x1, q.x); y1 = Math.max(y1, q.y);
    }
  }
  if (!Number.isFinite(x0)) return null;
  return { x0, y0, x1, y1, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 };
}

/* バラバラの線分を端点でつないで、輪になっているか調べる。
   ★ 実務の図面は「閉じたポリライン」ではなく矩形や線分の集まりで描かれる。
     外形として使えるかどうかは、つないでみて初めて分かる。
   ⚠️ 端点は完全一致しないので、丸めた鍵で照合する（tol は図面の単位）。
     行き過ぎ（オーバーシュート）は繋がらない端点として現れるので、
     ここで数えて「この図面は使える／直しが要る」を伝える材料にする。 */
export function stitchLoops(polys, tol = 1) {
  // 折れ線を線分にばらす
  const segs = [];
  for (const p of polys) {
    const n = p.pts.length;
    for (let i = 0; i + 1 < n; i++) segs.push([p.pts[i], p.pts[i + 1]]);
    if (p.closed && n >= 3) segs.push([p.pts[n - 1], p.pts[0]]);
  }
  const key = (q) => `${Math.round(q.x / tol)},${Math.round(q.y / tol)}`;
  const at = new Map();
  segs.forEach((s, i) => {
    for (const q of s) {
      const k = key(q);
      if (!at.has(k)) at.set(k, []);
      at.get(k).push(i);
    }
  });

  const used = new Array(segs.length).fill(false);
  const loops = [], opens = [];
  for (let i = 0; i < segs.length; i++) {
    if (used[i]) continue;
    used[i] = true;
    const chain = [segs[i][0], segs[i][1]];
    // 端から順に、まだ使っていない線分をつないでいく
    for (const dir of [1, 0]) {
      for (;;) {
        const tip = dir ? chain[chain.length - 1] : chain[0];
        const cand = (at.get(key(tip)) || []).filter((j) => !used[j]);
        if (!cand.length) break;
        const j = cand[0];
        used[j] = true;
        const [a, b] = segs[j];
        const next = (key(a) === key(tip)) ? b : a;
        if (dir) chain.push(next); else chain.unshift(next);
      }
    }
    const closed = chain.length > 3 && key(chain[0]) === key(chain[chain.length - 1]);
    if (closed) { chain.pop(); loops.push(chain); } else opens.push(chain);
  }
  // つながらなかった端点（＝1本しか集まっていない点）の数
  let loose = 0;
  for (const [, list] of at) if (list.length === 1) loose++;
  return { loops, opens, loose };
}
