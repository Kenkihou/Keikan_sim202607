/* ============================================================
   UI：左＝地物パレット／右＝選択中の地物の編集
   ============================================================ */
import { GROUPS, PLACE_HINT, itemsOfGroup } from '../catalog.js';
import * as store from './store.js';
import { attachGizmo, setMode, getMode } from './gizmo.js';

let onPick = () => {};          // 地物を選んだとき（作図モードに入る）
let onEdit = () => {};          // 値を変えたとき
let currentGroup = GROUPS[0].group;
let currentDef = null;

const $ = id => document.getElementById(id);

export function initUI(handlers){
  onPick = handlers.onPick; onEdit = handlers.onEdit;
  buildPalette();
  store.onChange(refreshEdit);
  $('btn-clear').onclick = () => { if (confirm('すべて削除しますか？')) store.clearAll(); };
  $('btn-cancel').onclick = () => setActive(null);
  refreshEdit();
}

/* ---------- 左：パレット ---------- */
function buildPalette(){
  const tabs = $('groups'), list = $('items');
  tabs.innerHTML = '';
  for (const g of GROUPS){
    const b = document.createElement('button');
    b.className = 'tab' + (g.group === currentGroup ? ' on' : '');
    b.textContent = g.group;
    b.onclick = () => { currentGroup = g.group; buildPalette(); };
    tabs.appendChild(b);
  }
  list.innerHTML = '';
  for (const it of itemsOfGroup(currentGroup)){
    const b = document.createElement('button');
    b.className = 'item' + (currentDef === it ? ' on' : '');
    const kind = { point:'点', line:'線', rect:'範囲', poly:'折れ線' }[it.place] || '';
    b.innerHTML = `<span>${it.name}</span><em>${kind}</em>`;
    b.onclick = () => setActive(currentDef === it ? null : it);
    list.appendChild(b);
  }
}

export function setActive(def){
  currentDef = def;
  buildPalette();
  $('hint').textContent = def
    ? `【${def.name}】${PLACE_HINT[def.place]}　／　Esc で中止`
    : 'ドラッグ:回転　ホイール:ズーム　右ドラッグ:平行移動　／　地物をクリックで編集';
  $('btn-cancel').style.display = def ? '' : 'none';
  onPick(def);
}
export const getActive = () => currentDef;

/* ---------- 右：編集 ---------- */
function row(label, valueText){
  const d = document.createElement('div');
  d.className = 'row';
  d.innerHTML = `<div class="lbl"><span>${label}</span><span class="val">${valueText ?? ''}</span></div>`;
  return d;
}

const posText = rec => rec.pts.length === 1
  ? `X ${rec.pts[0].x.toFixed(1)} ／ Z ${rec.pts[0].z.toFixed(1)}　${rec.rot}°`
  : rec.pts.map(p => `(${p.x.toFixed(1)}, ${p.z.toFixed(1)})`).join(' → ');

/* ギズモ操作中に呼ばれる：パネルを作り直さず数値だけ更新する */
let readout = null;
export function refreshReadouts(){
  if (!readout || readout.rec !== store.getSelected()) return;
  const rec = readout.rec;
  if (readout.dim && rec.def.info) readout.dim.textContent = rec.def.info(rec.params, store.placementOf(rec));
  if (readout.pos) readout.pos.textContent = posText(rec);
  if (readout.rotInp){ readout.rotInp.value = rec.rot; readout.rotVal.textContent = rec.rot + '°'; }
  $('status').textContent = `配置 ${store.items.length} 個 ／ 三角形 ${Math.round(store.totalTris()).toLocaleString()} 枚`;
}

function refreshEdit(){
  const panel = $('edit'), rec = store.getSelected();
  panel.innerHTML = '';
  $('status').textContent = `配置 ${store.items.length} 個 ／ 三角形 ${Math.round(store.totalTris()).toLocaleString()} 枚`;
  /* 編集パネルは地物を選んでいるときだけ出す */
  $('inspector').style.display = rec ? '' : 'none';
  attachGizmo(rec);
  if (!rec) return;

  const def = rec.def, pl = store.placementOf(rec);

  /* 見出し＋種類の差し替え */
  const head = document.createElement('div');
  head.className = 'ehead';
  head.innerHTML = `<b>${def.name}</b><span>${def.group}</span>`;
  panel.appendChild(head);

  /* ギズモの切替（範囲ものは軸に沿うので移動のみ） */
  const gz = document.createElement('div');
  gz.className = 'seg';
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

  const sw = document.createElement('div');
  sw.className = 'row';
  sw.innerHTML = `<div class="lbl"><span>種類を変更</span></div><select></select>`;
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
    readout.dim = r.querySelector('.val');
    panel.appendChild(r);
  }

  /* 向き（点で置くもの） */
  if (def.rotatable){
    const r = document.createElement('div');
    r.className = 'row';
    r.innerHTML = `<div class="lbl"><span>向き</span><span class="val">${rec.rot}°</span></div>
      <input type="range" min="0" max="345" step="15" value="${rec.rot}">`;
    const inp = r.querySelector('input'), val = r.querySelector('.val');
    inp.oninput = () => { rec.rot = +inp.value; val.textContent = rec.rot + '°'; store.build(rec); onEdit(); };
    readout.rotInp = inp; readout.rotVal = val;
    panel.appendChild(r);
  }

  /* スライダー */
  for (const c of def.params || []){
    const r = document.createElement('div');
    r.className = 'row';
    const fmt = v => c.fmt ? c.fmt(v, rec.params) : v;
    r.innerHTML = `<div class="lbl"><span>${c.l}</span><span class="val">${fmt(rec.params[c.k])}</span></div>
      <input type="range" min="${c.min}" max="${c.max}" step="${c.step}" value="${rec.params[c.k]}">`;
    const inp = r.querySelector('input'), val = r.querySelector('.val');
    inp.oninput = () => {
      rec.params[c.k] = parseFloat(inp.value);
      val.textContent = fmt(rec.params[c.k]);
      store.build(rec);
      if (def.info) panel.querySelectorAll('.row')[1]?.querySelector('.val')
        ?.replaceChildren(document.createTextNode(def.info(rec.params, store.placementOf(rec))));
      onEdit();
    };
    panel.appendChild(r);
  }

  /* 選択・チェック */
  for (const o of def.options || []){
    if (o.type === 'check'){
      const l = document.createElement('label');
      l.className = 'chk';
      l.innerHTML = `<input type="checkbox"${rec.params[o.k] ? ' checked' : ''}><span>${o.l}</span>`;
      const inp = l.querySelector('input');
      inp.onchange = () => { rec.params[o.k] = inp.checked; store.build(rec); onEdit(); };
      panel.appendChild(l);
    } else {
      const r = document.createElement('div');
      r.className = 'row';
      r.innerHTML = `<div class="lbl"><span>${o.l}</span></div><select>` +
        o.values.map(v => `<option${v === rec.params[o.k] ? ' selected' : ''}>${v}</option>`).join('') + '</select>';
      const s = r.querySelector('select');
      s.onchange = () => { rec.params[o.k] = s.value; store.build(rec); onEdit(); };
      panel.appendChild(r);
    }
  }

  /* 位置 */
  const pr = row('位置', posText(rec));
  readout.pos = pr.querySelector('.val');
  panel.appendChild(pr);

  const btns = document.createElement('div');
  btns.className = 'btns';
  btns.innerHTML = `<button class="act" id="btn-reset">初期値</button>
                    <button class="act danger" id="btn-del">削除</button>`;
  panel.appendChild(btns);
  btns.querySelector('#btn-reset').onclick = () => {
    rec.params = store.defaultParams(def); store.build(rec); refreshEdit(); onEdit();
  };
  btns.querySelector('#btn-del').onclick = () => store.removeItem(rec);
}
