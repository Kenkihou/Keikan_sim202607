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
import { localToLonLat, lonLatToLocal } from './geo.js';
import { ORIGIN_LAT, ORIGIN_LON, DEG2RAD, CITY_ID, CITY_LABEL } from './config.js';
import { edits, applyEditsEverywhere, defaultEdit, resetAll } from './buildingedit.js';
import {
  setbackSets, MAX_SETBACKS, makeSetbackSet, refreshSetbacks, clearSetback,
} from './buildingsetback.js';
import {
  blocksState, addBlockAt, regroundBlocks, removeAllBlocks, setBlocksEnabled,
} from './blocks.js';

const RAD2DEG = 1 / DEG2RAD;

/* ローカル座標(x,z)[m] → 緯度経度[度]。変換は geo.js（楕円体の局所ENU）。 */
function localToLatLng(x, z) {
  const { lat, lon } = localToLonLat(x, z);
  return { lat: +lat.toFixed(8), lng: +lon.toFixed(8) };
}

/* 緯度経度[度] → ローカル座標(x,z)[m]。localToLatLng の逆。 */
function latLngToLocal(latDeg, lngDeg) {
  return lonLatToLocal(lngDeg, latDeg);
}

/* 旧形式（version 1.0 以前）のセーブを読むための、球体近似版の逆変換。
   ⚠️ 消さないこと。1.0 の緯度経度は【球体近似で書き出された値】なので、
     楕円体で読み直すと保存時と違う場所（原点から3kmで約10m）に復元されてしまう。
     書き出した式で読み戻すのが正しい。 */
function latLngToLocalLegacySphere(latDeg, lngDeg) {
  const lat = latDeg * DEG2RAD, lng = lngDeg * DEG2RAD;
  return {
    z: (lat - ORIGIN_LAT) * EARTH_R,
    x: -((lng - ORIGIN_LON) * EARTH_R * Math.cos(lat)),
  };
}
// 今読み込んでいるセーブの形式（applyEarthState が設定する）
let loadedVersion = null;

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

/* 壁面後退。街の何か所かを並行して検討できるので、配列で出す。
   ⚠️ 以前は1組しか持てず、オブジェクト1つで書き出していた。読む側は
     配列でないデータも受け取れるようにしてある（restoreSetbacks を参照）。 */
function collectSetbacks() {
  const out = [];
  for (const set of setbackSets) {
    if (!set.line || !set.targets.size) continue;
    const { ax, az, bx, bz } = set.line;
    out.push({
      対象: [...set.targets],
      後退面: {
        始点: { ...localToLatLng(ax, az), x: r2(ax), z: r2(az) },
        終点: { ...localToLatLng(bx, bz), x: r2(bx), z: r2(bz) },
        ずらし量: r2(set.offset),
        削る側: set.side,
      },
      基準線: set.baseline ? {
        ...localToLatLng(set.baseline.x, set.baseline.z),
        x: r2(set.baseline.x), z: r2(set.baseline.z),
        法線: { nx: r3(set.baseline.nx), nz: r3(set.baseline.nz) },
      } : null,
      後退距離: Number.isFinite(set.distance) ? r2(set.distance) : null,
      // 階数・高さの控え。確定後は選択が外れていて属性を引けないため。
      建物属性: [...set.info].map(([gmlId, v]) => ({
        gmlId, 階数: v.storeys ?? null,
        高さ: r2(v.height), 実測高さ: r2(v.measuredHeight),
      })),
    });
  }
  return out;
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
  const 壁面後退 = collectSetbacks();
  const 置いた箱 = collectBlocks();
  if (!建物の高さ変更.length && !壁面後退.length && !置いた箱.length) return null;
  return {
    // 1.1 で座標変換を楕円体（geo.js）へ変更。1.0 の値は球体近似で書かれている。
    version: '1.1',
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
  const conv = (loadedVersion === null || loadedVersion === '1.0')
    ? latLngToLocalLegacySphere : latLngToLocal;
  if (Number.isFinite(rec.lat) && Number.isFinite(rec.lng)) return conv(rec.lat, rec.lng);
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

function restoreSetbacks(data) {
  // ★ 古いセーブデータは1組ぶんのオブジェクト。配列に均してから読む。
  const list = Array.isArray(data) ? data : (data ? [data] : []);
  let n = 0;
  for (const sb of list) {
    if (n >= MAX_SETBACKS) break;
    if (!sb || !sb.後退面) continue;
    const a = toLocal(sb.後退面.始点 || {});
    const b = toLocal(sb.後退面.終点 || {});
    if (!a || !b) continue;
    const ids = sb.対象 || [];
    if (!ids.length) continue;
    const set = makeSetbackSet(ids);
    set.line = { ax: a.x, az: a.z, bx: b.x, bz: b.z };
    // ⚠️ 「削る側」は 後退面 の中にある。ここを sb.削る側 と書いていたため
    //   常に undefined で、側が既定の +1 に戻っていた。1組しか持てなかった頃は
    //   側がほぼ +1 だったので露見せず、複数持てるようにして初めて
    //   「読み込むと一部の建物が丸ごと削れる」形で表に出た。
    if (Number.isFinite(sb.後退面.削る側)) set.side = sb.後退面.削る側;
    set.offset = Number.isFinite(sb.後退面.ずらし量) ? sb.後退面.ずらし量 : 0;
    const base = sb.基準線 ? toLocal(sb.基準線) : null;
    set.baseline = base
      ? { x: base.x, z: base.z, nx: sb.基準線.法線 ? sb.基準線.法線.nx : 0,
          nz: sb.基準線.法線 ? sb.基準線.法線.nz : 0 }
      : null;
    set.distance = Number.isFinite(sb.後退距離) ? sb.後退距離 : NaN;
    for (const rec of (sb.建物属性 || [])) {
      if (!rec || !rec.gmlId) continue;
      set.info.set(rec.gmlId, {
        storeys: rec.階数, height: rec.高さ, measuredHeight: rec.実測高さ,
      });
    }
    setbackSets.push(set);
    n++;
  }
  if (n) refreshSetbacks();
  return n;
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
  loadedVersion = state && typeof state.version === 'string' ? state.version : null;
  resetAll();
  clearSetback();
  removeAllBlocks();
  if (!state) return { ok: true, 建物: 0, 壁面後退: 0, 箱: 0 };
  const 建物 = restoreBuildingEdits(state.建物の高さ変更);
  const 壁面後退 = restoreSetbacks(state.壁面後退);
  const 箱 = restoreBlocks(state.置いた箱);
  return { ok: true, 建物, 壁面後退, 箱 };
}

// 01 から iframe 越しに呼ばれる入口。
window.getEarthEditState = collectEarthState;
window.applyEarthEditState = applyEarthState;

export { collectEarthState, applyEarthState, localToLatLng, latLngToLocal };
