// =============================================================================
// 地球モードでの検討内容を、01（モデリング画面）のセーブJSONへ持ち出す
//
//   01 の「JSONセーブ」は同一オリジンの iframe 越しに
//   window.getEarthEditState() を呼ぶだけで中身を受け取れる。
//   （01 と 04 は postMessage ではなく window.parent.〜 の直呼びで連携している）
//
//   【なぜローカル座標そのままで保存しないのか】
//     04 のローカル座標は「その都市の原点まわりの局所ENU近似」で、原点は
//     config.js の CITY.origin に依存する。都市を切り替えたり原点を直したりすると
//     同じ数値が別の場所を指してしまう。緯度経度で残しておけば、その心配がない。
//     復元しやすいように、ローカル座標も参考値として併記する。
// =============================================================================
import { EARTH_R } from './core.js';
import { ORIGIN_LAT, ORIGIN_LON, DEG2RAD, CITY_ID, CITY_LABEL } from './config.js';
import { edits, applyEditsEverywhere, defaultEdit, resetAll } from './buildingedit.js';
import {
  setbackState, targets, faceState, setbackDistance,
  setSetbackLine, setSetbackOffset, applySetback, clearSetback,
} from './buildingsetback.js';
import {
  blocksState, addBlockAt, regroundBlocks, removeAllBlocks, setBlocksEnabled,
} from './blocks.js';

const RAD2DEG = 1 / DEG2RAD;

/* ローカル座標(x,z)[m] → 緯度経度[度]。
   scene は +Z=北 / +X=西 なので、東向き成分は -x になる。 */
function localToLatLng(x, z) {
  const lat = ORIGIN_LAT + z / EARTH_R;
  const lng = ORIGIN_LON + (-x) / (EARTH_R * Math.cos(lat));
  return { lat: +(lat * RAD2DEG).toFixed(8), lng: +(lng * RAD2DEG).toFixed(8) };
}

/* 緯度経度[度] → ローカル座標(x,z)[m]。localToLatLng の逆。 */
function latLngToLocal(latDeg, lngDeg) {
  const lat = latDeg * DEG2RAD, lng = lngDeg * DEG2RAD;
  const z = (lat - ORIGIN_LAT) * EARTH_R;
  const x = -((lng - ORIGIN_LON) * EARTH_R * Math.cos(lat));
  return { x, z };
}

const r2 = (v) => (Number.isFinite(v) ? +v.toFixed(2) : null);
const r3 = (v) => (Number.isFinite(v) ? +v.toFixed(3) : null);

/* PLATEAU 建物の高さ変更。手つかずの建物は edits に残らないので、そのまま全部出す。 */
function collectBuildingEdits() {
  const out = [];
  for (const [gmlId, e] of edits) {
    if (!e || (e.dy === 0 && !e.hidden)) continue;
    const base = Number.isFinite(e.height) ? e.height
      : (Number.isFinite(e.measuredHeight) ? e.measuredHeight : null);
    out.push({
      gmlId,
      元の高さ: r2(base),
      変更量: r2(e.dy),
      変更後の高さ: base === null ? null : r2(base + e.dy),
      階数: Number.isFinite(e.storeys) ? e.storeys : null,
      底面積: r2(e.footprint),
      非表示: !!e.hidden,
    });
  }
  return out;
}

/* 壁面後退。
   ⚠️ 削りは【シェーダへ渡す平面を1枚だけ共有する】作りなので、同時に有効な
     後退は1組だけ。過去に確定した後退の履歴は持っていないため、ここでも
     「いま効いている1組」しか出せない。 */
function collectSetback() {
  if (!setbackState.active || !setbackState.line) return null;
  const { ax, az, bx, bz } = setbackState.line;
  // 確定時の控え（setbackState）を優先し、調整中なら今の値を使う
  const base = setbackState.baseline || faceState.baseline;
  const dist = Number.isFinite(setbackState.distance) ? setbackState.distance : setbackDistance();
  return {
    対象: [...targets],
    後退面: {
      始点: { ...localToLatLng(ax, az), x: r2(ax), z: r2(az) },
      終点: { ...localToLatLng(bx, bz), x: r2(bx), z: r2(bz) },
      ずらし量: r2(setbackState.offset),
      削る側: setbackState.side,
    },
    基準線: base ? {
      ...localToLatLng(base.x, base.z),
      x: r2(base.x), z: r2(base.z),
      法線: { nx: r3(base.nx), nz: r3(base.nz) },
    } : null,
    後退距離: Number.isFinite(dist) ? r2(dist) : null,
  };
}

/* 置いた箱。寸法は scale を掛けた実寸[m]で出す。 */
function collectBlocks() {
  return blocksState.list.map((m) => {
    const p = m.geometry.parameters;
    const gy = m.position.y - (p.height * m.scale.y) / 2;
    return {
      ...localToLatLng(m.position.x, m.position.z),
      x: r2(m.position.x), z: r2(m.position.z),
      接地高さ: r2(gy),
      幅: r2(p.width * m.scale.x),
      高さ: r2(p.height * m.scale.y),
      奥行: r2(p.depth * m.scale.z),
      向き: r2(m.rotation.y * RAD2DEG),
      色: '#' + m.material.color.getHexString(),
    };
  });
}

/* 01 のセーブJSONへ入れる塊を作る。中身が何も無ければ null を返し、
   まっさらな地球モードで無駄にキーが増えないようにする。 */
function collectEarthState() {
  const 建物の高さ変更 = collectBuildingEdits();
  const 壁面後退 = collectSetback();
  const 置いた箱 = collectBlocks();
  if (!建物の高さ変更.length && !壁面後退 && !置いた箱.length) return null;
  return {
    version: '1.0',
    都市: { id: CITY_ID, label: CITY_LABEL },
    原点: { lat: +(ORIGIN_LAT * RAD2DEG).toFixed(8), lng: +(ORIGIN_LON * RAD2DEG).toFixed(8) },
    建物の高さ変更,
    壁面後退,
    置いた箱,
  };
}

// =============================================================================
// 復元（01 でロードしたセーブJSONを地球モードへ戻す）
// =============================================================================
/* 保存されている位置は緯度経度が正、ローカル座標は参考値。
   ⚠️ ローカル座標の方を使ってはいけない。都市の原点が変われば同じ数値が
     別の場所を指す。緯度経度から毎回ひき直す。 */
function toLocal(rec) {
  if (Number.isFinite(rec.lat) && Number.isFinite(rec.lng)) return latLngToLocal(rec.lat, rec.lng);
  if (Number.isFinite(rec.x) && Number.isFinite(rec.z)) return { x: rec.x, z: rec.z };
  return null;
}

function restoreBuildingEdits(list) {
  if (!Array.isArray(list) || !list.length) return 0;
  const ids = [];
  for (const rec of list) {
    if (!rec || !rec.gmlId) continue;
    const e = edits.get(rec.gmlId) || defaultEdit();
    e.dy = Number.isFinite(rec.変更量) ? rec.変更量 : 0;
    e.hidden = !!rec.非表示;
    if (Number.isFinite(rec.元の高さ)) e.height = rec.元の高さ;
    if (Number.isFinite(rec.階数)) e.storeys = rec.階数;
    if (Number.isFinite(rec.底面積)) e.footprint = rec.底面積;
    edits.set(rec.gmlId, e);
    ids.push(rec.gmlId);
  }
  // 読み込み済みのタイルへ今すぐ当てる。まだ来ていないタイルには、
  // タイル読み込み時のフックが同じ edits を見て当ててくれる。
  applyEditsEverywhere(ids);
  return ids.length;
}

function restoreSetback(sb) {
  if (!sb || !sb.後退面) return false;
  const a = toLocal(sb.後退面.始点 || {});
  const b = toLocal(sb.後退面.終点 || {});
  if (!a || !b) return false;
  targets.clear();
  for (const id of (sb.対象 || [])) targets.add(id);
  if (!targets.size) return false;
  setSetbackLine(a.x, a.z, b.x, b.z);
  if (Number.isFinite(sb.削る側)) setbackState.side = sb.削る側;
  setSetbackOffset(Number.isFinite(sb.後退面.ずらし量) ? sb.後退面.ずらし量 : 0);
  const base = sb.基準線 ? toLocal(sb.基準線) : null;
  setbackState.baseline = base
    ? { x: base.x, z: base.z, nx: sb.基準線.法線 ? sb.基準線.法線.nx : 0,
        nz: sb.基準線.法線 ? sb.基準線.法線.nz : 0 }
    : null;
  setbackState.distance = Number.isFinite(sb.後退距離) ? sb.後退距離 : NaN;
  // targets は上で自分で入れたので、選択から取り直させない
  const r = applySetback({ keepTargets: true });
  return !!(r && r.ok);
}

function restoreBlocks(list) {
  if (!Array.isArray(list)) return 0;
  let n = 0;
  for (const rec of list) {
    const p = toLocal(rec || {});
    if (!p) continue;
    if (addBlockAt({ x: p.x, z: p.z, 幅: rec.幅, 高さ: rec.高さ, 奥行: rec.奥行,
      向き: rec.向き, 色: rec.色 })) n++;
  }
  if (n) {
    setBlocksEnabled(true);   // 置いた箱が見えないと戻ったことが分からない
    waitForGround();
  }
  return n;
}

/* 地形が届くまで、箱の接地をやり直し続ける。
   ⚠️ 復元は「地球側の準備ができた」時点で走るが、そのとき届いているのは
     ごく粗い地形で、箱を置く場所の高さはまだ測れないことが多い。
     1回きりで諦めると箱が宙に浮いたり地面に潜ったままになる。 */
const REGROUND_INTERVAL_MS = 700;
const REGROUND_TRIES = 40;   // 約28秒ぶん
let regroundTimer = null;
function waitForGround() {
  clearInterval(regroundTimer);
  let n = REGROUND_TRIES;
  regroundTimer = setInterval(() => {
    if (regroundBlocks() === 0 || --n <= 0) clearInterval(regroundTimer);
  }, REGROUND_INTERVAL_MS);
}

/* 01 のロードから呼ばれる入口。state が無いときは【まっさらに戻す】。
   ⚠️ 追記ではなく置き換え。ロードは「今の作業を上書きする」操作なので、
     前の検討内容が混ざって残ると、どれが読み込んだ内容か分からなくなる。 */
function applyEarthState(state) {
  resetAll();
  clearSetback();
  removeAllBlocks();
  if (!state) return { ok: true, 建物: 0, 壁面後退: false, 箱: 0 };
  const 建物 = restoreBuildingEdits(state.建物の高さ変更);
  const 壁面後退 = restoreSetback(state.壁面後退);
  const 箱 = restoreBlocks(state.置いた箱);
  return { ok: true, 建物, 壁面後退, 箱 };
}

// 01 から iframe 越しに呼ばれる入口。
window.getEarthEditState = collectEarthState;
window.applyEarthEditState = applyEarthState;

export { collectEarthState, applyEarthState, localToLatLng, latLngToLocal };
