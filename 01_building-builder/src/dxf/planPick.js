// =============================================================================
// planPick — DXF を開いて、使う平面図を【囲って】選んでもらう
//
//   ★ 図面の中のどれが平面図かは、アプリには決められない。1枚の紙に1階と2階が
//     並んでいるのがふつうで、表題も枠も図面ごとに違う。囲ってもらうのが
//     いちばん確実で、説明も要らない。
//   ⚠️ 囲みの判定は【線の端点がすべて内側】。かすっただけの線を拾うと、
//     隣の階の壁が混ざる。
//
//   画面は自前で作る（index.html には手を入れない）。
// =============================================================================
import { decodeDXF, parseDXF, bboxOf } from './dxfParse.js';

let host = null, bar = null, cv = null;
let ctx = null;      // { sheet, onDone, drag, tf }

function ensureDom() {
  if (host) return;
  const css = document.createElement('style');
  css.textContent = `
#dxf-pick { position: fixed; inset: 0; z-index: 4000; background: #fff; display: none; }
#dxf-pick-bar { position: absolute; left: 0; right: 0; top: 0; height: 40px;
  display: flex; align-items: center; gap: 12px; padding: 0 14px;
  background: #f8f9fa; border-bottom: 1px solid #ddd;
  font: 13px/1.4 system-ui, sans-serif; color: #333; }
#dxf-pick-bar button { margin-left: auto; padding: 4px 12px; font-size: 12px;
  border: 1px solid #ccc; border-radius: 4px; background: #fff; cursor: pointer; }
#dxf-pick-cv { position: absolute; left: 0; right: 0; top: 40px; bottom: 0;
  width: 100%; height: calc(100% - 40px); cursor: crosshair; touch-action: none; }`;
  document.head.appendChild(css);
  host = document.createElement('div');
  host.id = 'dxf-pick';
  host.innerHTML = '<div id="dxf-pick-bar"></div><canvas id="dxf-pick-cv"></canvas>';
  document.body.appendChild(host);
  bar = host.querySelector('#dxf-pick-bar');
  cv = host.querySelector('#dxf-pick-cv');
}

/* 図面ぜんぶが画面に収まる倍率と、図面座標⇔画面座標の変換。 */
function pickView(sheet) {
  const dpr = window.devicePixelRatio || 1;
  const W = cv.clientWidth, H = cv.clientHeight;
  cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
  const b = bboxOf(sheet.polys) || { x0: 0, y0: 0, x1: 1, y1: 1 };
  const pad = 24;
  const k = Math.min((W - pad * 2) / Math.max(b.x1 - b.x0, 1),
    (H - pad * 2) / Math.max(b.y1 - b.y0, 1));
  const ox = (W - (b.x1 - b.x0) * k) / 2, oy = (H - (b.y1 - b.y0) * k) / 2;
  return {
    k, W, H, dpr,
    X: (x) => ox + (x - b.x0) * k,
    Y: (y) => H - oy - (y - b.y0) * k,       // 図面の y は上向き
    ix: (sx) => b.x0 + (sx - ox) / k,
    iy: (sy) => b.y0 + (H - oy - sy) / k,
  };
}

function draw() {
  const t = pickView(ctx.sheet); ctx.tf = t;
  const g = cv.getContext('2d');
  g.setTransform(t.dpr, 0, 0, t.dpr, 0, 0);
  g.clearRect(0, 0, t.W, t.H);
  g.strokeStyle = '#555'; g.lineWidth = 1;
  g.beginPath();
  for (const p of ctx.sheet.polys) {
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
  for (const s of (ctx.sheet.texts || [])) g.fillText(s.value, t.X(s.x), t.Y(s.y));
  if (ctx.drag) {
    const { x0, y0, x1, y1 } = ctx.drag;
    g.fillStyle = 'rgba(0,122,204,0.10)';
    g.fillRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
    g.strokeStyle = '#007acc'; g.lineWidth = 1.5; g.setLineDash([5, 3]);
    g.strokeRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
    g.setLineDash([]);
  }
}

function close() { host.style.display = 'none'; ctx = null; }

/* 図面を出して、矩形をひとつ囲ってもらう。囲みの中の線を onDone に渡す。 */
function askRect(sheet, note, onDone) {
  ensureDom();
  ctx = { sheet, onDone, drag: null, tf: null };
  host.style.display = 'block';
  bar.innerHTML = `<span>${note}</span>`;
  const btn = document.createElement('button');
  btn.type = 'button'; btn.textContent = 'やめる';
  btn.addEventListener('click', close);
  bar.appendChild(btn);

  const at = (ev) => {
    const r = cv.getBoundingClientRect();
    return { x: ev.clientX - r.left, y: ev.clientY - r.top };
  };
  cv.onpointerdown = (ev) => {
    const p = at(ev); ctx.drag = { x0: p.x, y0: p.y, x1: p.x, y1: p.y };
    cv.setPointerCapture(ev.pointerId);
  };
  cv.onpointermove = (ev) => {
    if (!ctx || !ctx.drag) return;
    const p = at(ev); ctx.drag.x1 = p.x; ctx.drag.y1 = p.y; draw();
  };
  cv.onpointerup = () => {
    if (!ctx) return;
    const dg = ctx.drag; ctx.drag = null;
    if (!dg || Math.abs(dg.x1 - dg.x0) < 5 || Math.abs(dg.y1 - dg.y0) < 5) { draw(); return; }
    const t = ctx.tf;
    const r = {
      x0: t.ix(Math.min(dg.x0, dg.x1)), x1: t.ix(Math.max(dg.x0, dg.x1)),
      y0: t.iy(Math.max(dg.y0, dg.y1)), y1: t.iy(Math.min(dg.y0, dg.y1)),
    };
    // ⚠️ 端点がすべて内側の線だけ。かすった線を拾うと隣の階が混ざる。
    const inside = sheet.polys.filter((p) => p.pts.every((q) =>
      q.x >= r.x0 && q.x <= r.x1 && q.y >= r.y0 && q.y <= r.y1));
    const cb = ctx.onDone;
    close();
    cb(inside);
  };
  draw();
}

/* ファイルを選ばせて、囲ってもらうところまで。
   onDone には { polys, layers, texts } を渡す（囲みの中だけ）。 */
export function askDxfPlan(onDone) {
  const inp = document.createElement('input');
  inp.type = 'file'; inp.accept = '.dxf';
  inp.addEventListener('change', async () => {
    const f = inp.files[0];
    if (!f) return;
    const { polys, texts } = parseDXF(decodeDXF(await f.arrayBuffer()));
    if (!polys.length) { alert(`${f.name} から線が読めませんでした`); return; }
    const layers = [...new Set(polys.map((p) => p.layer))].sort();
    askRect({ polys, texts, layers }, '取り込む平面図を囲んでください（通り芯まで含めて）',
      (inside) => {
        if (!inside.length) { alert('その範囲に線がありません'); return; }
        onDone({ polys: inside, texts,
          layers: [...new Set(inside.map((p) => p.layer))].sort() });
      });
  });
  inp.click();
}
