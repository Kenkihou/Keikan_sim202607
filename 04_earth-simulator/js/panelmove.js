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

// つまんだあと、パネルが画面外へ行ききってしまわないように残す余白[px]。
//   これだけ画面内に残っていれば、掴み直して戻せる。
const KEEP_VISIBLE = 60;

function makeDraggable(panel, handle) {
  if (!panel || !handle) return;
  handle.classList.add('panel-drag-handle');
  let drag = null;

  handle.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0) return;
    const r = panel.getBoundingClientRect();
    // ここから先は left/top で位置を決める（right/bottom の指定は捨てる）
    panel.style.left = `${r.left}px`;
    panel.style.top = `${r.top}px`;
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
    drag = { dx: ev.clientX - r.left, dy: ev.clientY - r.top };
    // ⚠️ 捕捉は「取れなくても操作は成立する」おまけ。失敗しても例外にしない
    //   （捕捉できなかった pointerId で release すると NotFoundError が飛ぶ）。
    try { handle.setPointerCapture?.(ev.pointerId); } catch (e) { /* 無くても動く */ }
    ev.preventDefault();
  });

  handle.addEventListener('pointermove', (ev) => {
    if (!drag) return;
    const w = panel.offsetWidth, h = panel.offsetHeight;
    const x = Math.min(
      Math.max(ev.clientX - drag.dx, KEEP_VISIBLE - w),
      window.innerWidth - KEEP_VISIBLE,
    );
    const y = Math.min(Math.max(ev.clientY - drag.dy, 0), window.innerHeight - 32);
    panel.style.left = `${x}px`;
    panel.style.top = `${y}px`;
  });

  const end = (ev) => {
    if (!drag) return;
    drag = null;
    try { handle.releasePointerCapture?.(ev.pointerId); } catch (e) { /* 上と同じ */ }
  };
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);
}

// 見出し（h2）をつまみにする。パネルが無い画面構成でも動くよう、素通りさせる。
for (const id of ['editPanel', 'floorAreaPanel']) {
  const panel = el(id);
  if (panel) makeDraggable(panel, panel.querySelector('h2'));
}

export { makeDraggable };
