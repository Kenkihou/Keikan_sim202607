/* ============================================================
   外構モードの UI：左＝地物パレット／右＝選択中の地物の編集

   tree/planner.html の js/core/ui.js を移植したもの。
   要素の id は本体アプリの既存 UI とぶつからないよう ext- を付け、
   見た目は本体アプリの白いパネルに合わせてある（planner は黒パネル）。
   ============================================================ */
import { GROUPS, PLACE_HINT, itemsOfGroup } from '../catalog.js';
import * as store from './store.js';
import { attachGizmo, setMode, getMode } from './gizmo.js';
import { scheduleRebuild, finishRebuild } from './rebuild.js';

let onPick = () => {};          // 地物を選んだとき（作図モードに入る）
let onEdit = () => {};          // 値を変えたとき
let onExit = () => {};          // 「外構作図を終了」
let currentGroup = GROUPS[0].group;
let currentDef = null;

const $ = id => document.getElementById(id);

const HINT_IDLE = 'ドラッグ:回転　ホイール:ズーム　右ドラッグ:平行移動　／　外構の地物をクリックで編集';

export function initUI(handlers){
  onPick = handlers.onPick; onEdit = handlers.onEdit; onExit = handlers.onExit;
  buildPalette();
  store.onChange(refreshEdit);
  $('ext-btn-clear').onclick = () => { if (confirm('外構をすべて削除しますか？')) store.clearAll(); };
  $('ext-btn-cancel').onclick = () => setActive(null);
  $('ext-btn-exit').onclick = () => onExit();

  /* パネルの開閉 */
  for (const id of ['ext-palette', 'ext-inspector']){
    const el = $(id);
    el.querySelector('.ext-toggle').onclick = () => {
      el.classList.toggle('collapsed');
      el.querySelector('.ext-toggle').textContent = el.classList.contains('collapsed') ? '＋' : '−';
    };
  }
  refreshEdit();
}

/* 外構モードの表示・非表示 */
export function showUI(v){
  for (const id of ['ext-palette', 'ext-hint', 'ext-status']){
    const el = $(id);
    if (el) el.style.display = v ? '' : 'none';
  }
  if (!v) $('ext-inspector').style.display = 'none';
  else refreshEdit();
}

/* ---------- 左：パレット ---------- */
function buildPalette(){
  const tabs = $('ext-groups'), list = $('ext-items');
  if (!tabs || !list) return;
  tabs.innerHTML = '';
  for (const g of GROUPS){
    const b = document.createElement('button');
    b.className = 'ext-tab' + (g.group === currentGroup ? ' on' : '');
    b.textContent = g.group;
    b.onclick = () => { currentGroup = g.group; buildPalette(); };
    tabs.appendChild(b);
  }
  list.innerHTML = '';
  for (const it of itemsOfGroup(currentGroup)){
    const b = document.createElement('button');
    b.className = 'ext-item' + (currentDef === it ? ' on' : '');
    const kind = { point:'点', line:'線', rect:'範囲', poly:'折れ線' }[it.place] || '';
    b.innerHTML = `<span>${it.name}</span><em>${kind}</em>`;
    b.onclick = () => setActive(currentDef === it ? null : it);
    list.appendChild(b);
  }
}

export function setActive(def){
  currentDef = def;
  buildPalette();
  $('ext-hint').textContent = def
    ? `【${def.name}】${PLACE_HINT[def.place]}　／　Esc で中止`
    : HINT_IDLE;
  $('ext-btn-cancel').style.display = def ? '' : 'none';
  onPick(def);
}
export const getActive = () => currentDef;

/* ---------- 右：編集 ---------- */
function row(label, valueText){
  const d = document.createElement('div');
  d.className = 'ext-row';
  d.innerHTML = `<div class="ext-lbl"><span>${label}</span><span class="ext-val">${valueText ?? ''}</span></div>`;
  return d;
}

const posText = rec => rec.pts.length === 1
  ? `X ${rec.pts[0].x.toFixed(1)} ／ Z ${rec.pts[0].z.toFixed(1)}　${rec.rot}°`
  : rec.pts.map(p => `(${p.x.toFixed(1)}, ${p.z.toFixed(1)})`).join(' → ');

/* ギズモ操作中に呼ばれる：パネルを作り直さず数値だけ更新する */
let readout = null;
export function refreshReadouts(){
  updateStatus();
  if (!readout || readout.rec !== store.getSelected()) return;
  const rec = readout.rec;
  if (readout.dim && rec.def.info) readout.dim.textContent = rec.def.info(rec.params, store.placementOf(rec));
  if (readout.pos) readout.pos.textContent = posText(rec);
  if (readout.rotInp){ readout.rotInp.value = rec.rot; readout.rotVal.textContent = rec.rot + '°'; }
}

function updateStatus(){
  const el = $('ext-status');
  if (el) el.textContent = `外構 ${store.items.length} 個 ／ 三角形 ${Math.round(store.totalTris()).toLocaleString()} 枚`;
}

function refreshEdit(){
  const panel = $('ext-edit'), rec = store.getSelected();
  if (!panel) return;
  panel.innerHTML = '';
  updateStatus();
  /* 編集パネルは地物を選んでいるときだけ出す */
  $('ext-inspector').style.display = rec ? '' : 'none';
  attachGizmo(rec);
  if (!rec) return;

  const def = rec.def, pl = store.placementOf(rec);

  /* 見出し */
  const head = document.createElement('div');
  head.className = 'ext-ehead';
  head.innerHTML = `<b>${def.name}</b><span>${def.group}</span>`;
  panel.appendChild(head);

  /* ギズモの切替（範囲ものは軸に沿うので移動のみ） */
  const gz = document.createElement('div');
  gz.className = 'ext-seg';
  const modes = def.place === 'rect' ? [['translate','移動']] : [['translate','移動'],['rotate','回転']];
  for (const [m, label] of modes){
    const b = document.createElement('button');
    b.textContent = label;
    b.className = getMode() === m ? 'on' : '';
    b.onclick = () => { setMode(m); refreshEdit(); };
    gz.appendChild(b);
  }
  const tip = document.createElement('span');
  tip.textContent = rec.pts.length > 1 ? '●を引くと形を変更' : '';
  gz.appendChild(tip);
  panel.appendChild(gz);

  /* 種類の差し替え */
  const sw = document.createElement('div');
  sw.className = 'ext-row';
  sw.innerHTML = `<div class="ext-lbl"><span>種類を変更</span></div><select></select>`;
  const sel = sw.querySelector('select');
  for (const it of itemsOfGroup(def.group)){
    if (it.place !== def.place) continue;            // 置き方が同じものだけ差し替え可
    const o = document.createElement('option');
    o.value = it.id; o.textContent = it.name;
    if (it === def) o.selected = true;
    sel.appendChild(o);
  }
  sel.onchange = () => {
    const next = itemsOfGroup(def.group).find(i => i.id === sel.value);
    if (next) store.swapDef(rec, next);
  };
  panel.appendChild(sw);

  /* 情報（ギズモ操作中もここだけ書き換える） */
  readout = { rec, dim: null, pos: null };
  if (def.info){
    const r = row('寸法', def.info(rec.params, pl));
    readout.dim = r.querySelector('.ext-val');
    panel.appendChild(r);
  }

  /* 向き（点で置くもの） */
  if (def.rotatable){
    const r = document.createElement('div');
    r.className = 'ext-row';
    r.innerHTML = `<div class="ext-lbl"><span>向き</span><span class="ext-val">${rec.rot}°</span></div>
      <input type="range" min="0" max="345" step="15" value="${rec.rot}">`;
    const inp = r.querySelector('input'), val = r.querySelector('.ext-val');
    inp.oninput = () => {
      rec.rot = +inp.value; val.textContent = rec.rot + '°';
      scheduleRebuild(rec, onEdit);
    };
    inp.onchange = () => { rec.rot = +inp.value; finishRebuild(rec, onEdit); };
    readout.rotInp = inp; readout.rotVal = val;
    panel.appendChild(r);
  }

  /* スライダー
     ★数値と寸法の表示はその場で書き換え、形の作り直しだけ 1フレームに1回へ間引く。
       手を離した（change）ところで、本来の細かさに戻して作り直す。 */
  for (const c of def.params || []){
    const r = document.createElement('div');
    r.className = 'ext-row';
    const fmt = v => c.fmt ? c.fmt(v, rec.params) : v;
    r.innerHTML = `<div class="ext-lbl"><span>${c.l}</span><span class="ext-val">${fmt(rec.params[c.k])}</span></div>
      <input type="range" min="${c.min}" max="${c.max}" step="${c.step}" value="${rec.params[c.k]}">`;
    const inp = r.querySelector('input'), val = r.querySelector('.ext-val');
    const showValues = () => {
      val.textContent = fmt(rec.params[c.k]);
      if (readout.dim && def.info) readout.dim.textContent = def.info(rec.params, store.placementOf(rec));
    };
    inp.oninput = () => {
      rec.params[c.k] = parseFloat(inp.value);
      showValues();
      scheduleRebuild(rec, () => { showValues(); onEdit(); });
    };
    inp.onchange = () => {
      rec.params[c.k] = parseFloat(inp.value);
      finishRebuild(rec, () => { showValues(); onEdit(); });
    };
    panel.appendChild(r);
  }

  /* 選択・チェック */
  for (const o of def.options || []){
    if (o.type === 'check'){
      const l = document.createElement('label');
      l.className = 'ext-chk';
      l.innerHTML = `<input type="checkbox"${rec.params[o.k] ? ' checked' : ''}><span>${o.l}</span>`;
      const inp = l.querySelector('input');
      inp.onchange = () => { rec.params[o.k] = inp.checked; finishRebuild(rec, onEdit); };
      panel.appendChild(l);
    } else {
      const r = document.createElement('div');
      r.className = 'ext-row';
      r.innerHTML = `<div class="ext-lbl"><span>${o.l}</span></div><select>` +
        o.values.map(v => `<option${v === rec.params[o.k] ? ' selected' : ''}>${v}</option>`).join('') + '</select>';
      const s = r.querySelector('select');
      s.onchange = () => { rec.params[o.k] = s.value; finishRebuild(rec, onEdit); };
      panel.appendChild(r);
    }
  }

  /* 位置 */
  const pr = row('位置（m）', posText(rec));
  readout.pos = pr.querySelector('.ext-val');
  panel.appendChild(pr);

  const btns = document.createElement('div');
  btns.className = 'ext-btns';
  btns.innerHTML = `<button class="ext-act" id="ext-btn-reset">初期値</button>
                    <button class="ext-act danger" id="ext-btn-del">削除</button>`;
  panel.appendChild(btns);
  btns.querySelector('#ext-btn-reset').onclick = () => {
    rec.params = store.defaultParams(def); finishRebuild(rec, () => { refreshEdit(); onEdit(); });
  };
  btns.querySelector('#ext-btn-del').onclick = () => store.removeItem(rec);
}
