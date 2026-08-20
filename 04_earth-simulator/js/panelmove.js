// =============================================================================
// panelmove — 画面に浮いているパネルを、見出しをつまんで動かせるようにする。
//
//   建物の編集パネルと床面積のパネルはどちらも画面右に出るので、中身が増えると
//   重なってしまう。どちらを上にするか・どこに置くかは作業内容しだいなので、
//   決め打ちの配置ではなく利用者が動かせるようにする。
//
//   ★ 対象パネルは CSS で right / top を指定して置かれている。ドラッグを始めた
//     時点で、その見た目の位置をそのまま left / top に置き換えてから動かす
//     （right 指定のまま left を足すと、両端が固定されて幅が潰れる）。
// =============================================================================
import { el } from './core.js';

// 画面の縁から空ける余白[px]。パネルは【全体が画面の中】に収める。
//   ⚠️ 以前は「60px だけ残す」方式で、外枠が大半はみ出した位置にも置けた。
//     置けてしまうと、そのままウィンドウを小さくしたときに完全に見えなくなる。
const EDGE_MARGIN = 8;

/* パネル全体が画面に収まる left/top へ丸める。
   パネルが画面より大きいときは左上に寄せる（縮める側は max-height が受け持つ）。 */
function clampPos(x, y, w, h) {
  const maxX = Math.max(EDGE_MARGIN, window.innerWidth - w - EDGE_MARGIN);
  const maxY = Math.max(EDGE_MARGIN, window.innerHeight - h - EDGE_MARGIN);
  return {
    x: Math.min(Math.max(x, EDGE_MARGIN), maxX),
    y: Math.min(Math.max(y, EDGE_MARGIN), maxY),
  };
}

// つまんでいる最中かどうか。引き戻しはドラッグ中に走らせない
//   （毎フレーム位置を測り直すことになるうえ、掴んでいる手と喧嘩する）。
let dragging = 0;

/* いま画面からはみ出しているパネルを、中へ引き戻す。
   ★ 解像度の高いモニタで置いた位置は、狭いモニタへ移すと画面の外になる。
     ウィンドウの大きさが変わったときと、パネルが出てきたときに呼ぶ。
   ⚠️ 高さは【残りの画面】に合わせて詰める。上端だけ画面内に戻しても、
     背の高いパネルは下がはみ出したままになる。 */
function clampIntoView(panel) {
  if (!panel || dragging) return;
  const cs = getComputedStyle(panel);
  if (cs.display === 'none' || cs.visibility === 'hidden') return;
  const r = panel.getBoundingClientRect();
  if (!r.width || !r.height) return;
  const room = window.innerHeight - EDGE_MARGIN * 2;
  const h = Math.min(r.height, room);
  const p = clampPos(r.left, r.top, r.width, h);
  const moved = Math.abs(p.x - r.left) > 0.5 || Math.abs(p.y - r.top) > 0.5;
  const tall = r.height > room;
  if (!moved && !tall) return;
  panel.style.left = `${p.x}px`;
  panel.style.top = `${p.y}px`;
  panel.style.right = 'auto';
  panel.style.bottom = 'auto';
  if (tall) panel.style.maxHeight = `${room}px`;
}

function makeDraggable(panel, handle) {
  if (!panel || !handle) return;
  handle.classList.add('panel-drag-handle');
  let drag = null;

  handle.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0) return;
    // ⚠️ つまみの上に乗っているボタン（畳むなど）を押したときは動かさない。
    //   ここで弾かないと、押した瞬間にパネルが1pxずれて「押せていない」ように見える。
    if (ev.target.closest('button, input, select, a')) return;
    const r = panel.getBoundingClientRect();
    // ここから先は left/top で位置を決める（right/bottom の指定は捨てる）
    panel.style.left = `${r.left}px`;
    panel.style.top = `${r.top}px`;
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
    drag = { dx: ev.clientX - r.left, dy: ev.clientY - r.top };
    dragging++;
    // ⚠️ 捕捉は「取れなくても操作は成立する」おまけ。失敗しても例外にしない
    //   （捕捉できなかった pointerId で release すると NotFoundError が飛ぶ）。
    try { handle.setPointerCapture?.(ev.pointerId); } catch (e) { /* 無くても動く */ }
    ev.preventDefault();
  });

  handle.addEventListener('pointermove', (ev) => {
    if (!drag) return;
    const p = clampPos(ev.clientX - drag.dx, ev.clientY - drag.dy,
      panel.offsetWidth, panel.offsetHeight);
    panel.style.left = `${p.x}px`;
    panel.style.top = `${p.y}px`;
  });

  const end = (ev) => {
    if (!drag) return;
    drag = null;
    dragging = Math.max(0, dragging - 1);
    try { handle.releasePointerCapture?.(ev.pointerId); } catch (e) { /* 上と同じ */ }
  };
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);
}

// パネルごとに「どこをつまませるか」を決める。
//   ⚠️ blocksPanel は建物編集パネルの中へ畳んだので、つまみは付けない。
const MOVABLE = [['editPanel', 'h2'], ['floorAreaPanel', 'h2'], ['hud', '#hudBar']];
const panels = [];
for (const [id, sel] of MOVABLE) {
  const panel = el(id);
  if (!panel) continue;
  panels.push(panel);
  makeDraggable(panel, panel.querySelector(sel));
}

// ★ ウィンドウの大きさが変わったら、画面の外へ出たパネルを引き戻す。
//   広いモニタで置いた位置は、狭いモニタへ移すとそのまま画面の外になる。
window.addEventListener('resize', () => {
  for (const p of panels) clampIntoView(p);
});

// ★ パネルが出てきた瞬間にも見張る。隠れている間は大きさが測れないので、
//   表示に切り替わったところで初めて「はみ出しているか」が分かる。
//   ⚠️ 監視するのは class と style だけ。中身の変化まで拾うと、
//     文字を書き換えるたびに走って重くなる。
if (window.MutationObserver) {
  const obs = new MutationObserver((recs) => {
    for (const rec of recs) clampIntoView(rec.target);
  });
  for (const p of panels) {
    obs.observe(p, { attributes: true, attributeFilter: ['class', 'style'] });
  }
}

// 左上パネルの畳み開き。街や地図を広く見たいときに、バーだけ残して退かせる。
(function setupHudFold() {
  const hud = el('hud'), btn = el('hudFold'), body = el('hudBody');
  if (!hud || !btn || !body) return;
  btn.addEventListener('click', () => {
    const folded = hud.classList.toggle('folded');
    body.style.display = folded ? 'none' : '';
    btn.textContent = folded ? '▸' : '▾';
    btn.title = folded ? '開く' : '畳む';
    btn.setAttribute('aria-expanded', String(!folded));
  });
})();

export { makeDraggable, clampIntoView };
