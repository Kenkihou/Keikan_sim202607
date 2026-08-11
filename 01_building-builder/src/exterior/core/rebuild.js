/* ============================================================
   作り直しの間引き（スライダー・ギズモの即時反映）

   本体アプリは「必要なときだけ描く」作り（planner.html のように毎フレーム
   描き続けてはいない）。そのため作り直したあとは必ず render() を呼ぶこと。
   ※ これを忘れると、形は変わっているのに画面が更新されず、
     カメラを動かした瞬間にようやく反映される＝強烈なラグとして体感される。

   そのうえで、作り直しの重さに応じて2通りに分ける。

     ・軽い地物（カーポート・門柱・フェンス・小さな芝など）
         → その場で作り直す。スライダーと完全に同時に変形する
     ・重い地物（葉が数万インスタンスある広い芝生など）
         → 1フレームに1回、葉を間引いた粗い形で追従し、
           手を離したところで本来の細かさに戻す
   ============================================================ */
import * as store from './store.js';
import { render } from './viewer.js';
import { setDetail } from '../util/quality.js';

/* この時間（ms）以内で作り直せる地物は、間引きも先送りもせずその場で作る */
const FAST_MS = 16;

/* ドラッグ中に残すインスタンスの割合。0.12 なら 60,000枚 → 7,200枚 */
const DRAFT_DETAIL = 0.12;

let pendingRec = null;
let pendingAfter = null;
let rafId = 0;

const isFast = rec => (rec.buildMs || 0) <= FAST_MS;

function buildNow(rec, detail, after){
  setDetail(detail);
  try { store.build(rec); } finally { setDetail(1); }
  render();
  if (after) after();
}

/* ドラッグ中の作り直し */
export function scheduleRebuild(rec, after){
  if (!rec) return;

  /* 軽い地物はその場で（＝スライダーの動きと同時に）作り直す */
  if (isFast(rec)){
    if (rafId){ cancelAnimationFrame(rafId); rafId = 0; pendingRec = null; pendingAfter = null; }
    buildNow(rec, 1, after);
    return;
  }

  /* 重い地物は1フレームに1回・粗い形で */
  pendingRec = rec;
  pendingAfter = after;
  if (rafId) return;                       // このフレームの分は予約済み
  rafId = requestAnimationFrame(() => {
    rafId = 0;
    const r = pendingRec, cb = pendingAfter;
    pendingRec = null; pendingAfter = null;
    if (!r) return;
    buildNow(r, DRAFT_DETAIL, cb);
  });
}

/* 手を離したときの作り直し（本来の細かさ。予約中の粗い作り直しは捨てる） */
export function finishRebuild(rec, after){
  if (rafId){ cancelAnimationFrame(rafId); rafId = 0; }
  const cb = after || pendingAfter;
  const target = rec || pendingRec;
  pendingRec = null; pendingAfter = null;
  if (!target) return;
  buildNow(target, 1, cb);
}
