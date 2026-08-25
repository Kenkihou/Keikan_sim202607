// =============================================================================
// roadnames — 名前つきの線データ（OpenStreetMap）を1回だけ読み込んで配る。
//   ・道路（通り名）… roads-<city>.json
//   ・河川（川名）  … rivers-<city>.json
//   どちらも同じ形（[{name, pts:[[lon,lat],…]}]）で、使う側も同じ扱いができる。
//
//   中身は roads-kyoto.json / roads-osaka.json（config.js の CITY_ROADS_URL）。
//   Overpass API から highway=motorway/trunk/primary/secondary/tertiary/
//   unclassified/residential/living_street/pedestrian の【名前があるものだけ】を
//   取り出し、15m で間引いてコミットしてあるファイル。作り直しは fetch_roads.py。
//   ライブでは取得しない（理由は config.js の CITY_ROADS_URL の解説を参照）。
//   ★ 幹線（tertiary 以上）だけでは、御幸町通・麩屋町通のような京都の南北の
//     細い通りや、寺町通の商店街区間が丸ごと抜ける（OSM ではそれらは
//     residential / living_street / pedestrian）。
//
//   ⚠️ PLATEAU の道路（roads.js の MVT）とは別物。あちらは「どこが道路か」を示す
//     【面】で、名前を持たない。通り名が要るときはこちらを使う。
//
//   使う側:
//     profile.js   … 東西断面と交わる通り・川の名前と断面を描く
//     streetnames.js … 路面の通り名（歩行中）と、着地点を選ぶ間の3D空間ラベル
//   どれも同じ数百KBのファイルを見るので、二重に読まないようここへ寄せた
//   （読み込みは最初に呼ばれた1回だけ。以降は同じ Promise を返す）。
// =============================================================================
import { CITY_ROADS_URL, CITY_RIVERS_URL } from './config.js';

// [{name, highway, pts:[[lon,lat],...]}]（lon/lat は度）
export const roadNames = { loaded: false, error: null, ways: [] };

let loading = null;

// [{name, waterway, width, pts}]（lon/lat は度）
export const riverNames = { loaded: false, error: null, rivers: [] };
let loadingRivers = null;

export function loadRiverNames() {
  if (loadingRivers) return loadingRivers;
  loadingRivers = (async () => {
    if (!CITY_RIVERS_URL) return riverNames;
    try {
      const res = await fetch(CITY_RIVERS_URL);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const json = await res.json();
      riverNames.rivers = json.features || [];
      riverNames.loaded = true;
    } catch (e) {
      riverNames.error = String(e.message || e);
      console.warn('河川データの読み込みに失敗:', e);
    }
    return riverNames;
  })();
  return loadingRivers;
}

export function loadRoadNames() {
  if (loading) return loading;
  loading = (async () => {
    if (!CITY_ROADS_URL) return roadNames;   // この都市には通り名データが無い
    try {
      const res = await fetch(CITY_ROADS_URL);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const json = await res.json();
      roadNames.ways = (json.features || [])
        .map((f) => ({ name: f.name, highway: f.highway, pts: f.pts }));
      roadNames.loaded = true;
    } catch (e) {
      roadNames.error = String(e.message || e);
      console.warn('通り名データの読み込みに失敗:', e);
    }
    return roadNames;
  })();
  return loading;
}
