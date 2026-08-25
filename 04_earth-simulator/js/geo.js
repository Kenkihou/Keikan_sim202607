// =============================================================================
// geo — 緯度経度 ⇄ ワールド座標（原点まわりの局所ENU）を、地球楕円体（WGS84）の
//   曲率半径を使って正確に行う。
//
//   【なぜ要るのか】
//     アプリの多くの場所は「地球＝半径 EARTH_R の球」とみなした簡易式を使っている:
//         north[m] = (lat - ORIGIN_LAT) * EARTH_R
//         east[m]  = (lon - ORIGIN_LON) * EARTH_R * cos(lat)
//     ところが地形・建物（3D Tiles）は ReorientationPlugin(lat, lon, height) で
//     【本物の ECEF 由来の ENU 座標系】に載っている。両者は一致しない。
//
//     WGS84 の子午線曲率半径は原点（京都駅）付近で 6,356,412m しかないのに、
//     簡易式は 6,378,137m を使う＝【南北を 0.34% 長く見積もる】。
//     京都駅から 3km 北では約 10m のずれになる。
//
//     ★ このずれは【東西の通りでだけ目に見える】。
//       南北の通りではずれが道に沿う向きなので気づかないが、東西の通りでは
//       道幅を越えて真横にずれる。実際、押小路通（駅から2.9km北）で路面ラベルが
//       9.4m 北へ寄り、隣の街区に乗っていた（楕円体で計算すると 0.5m に収まる）。
//
//   【精度】
//     曲率半径を原点の緯度で1回だけ求めて線形に使う。二次の項は市内スケール
//     （±30km）で 1cm 未満なので、ECEF を経由する厳密計算と実用上同じ。
//
//   ⚠️ 移行は道半ば。savestate / tiles(setFocusLatLon) / mountains / profile などは
//     まだ球の簡易式のまま（保存済みデータとの互換や、10m が問題にならない用途）。
//     新しく緯度経度を扱うときはこちらを使うこと。
// =============================================================================
import { ORIGIN_LAT, ORIGIN_LON, DEG2RAD } from './config.js';

const A = 6378137;                     // WGS84 長半径[m]
const F = 1 / 298.257223563;           // 扁平率
const E2 = F * (2 - F);
const RAD2DEG = 180 / Math.PI;

const _sin = Math.sin(ORIGIN_LAT);
const _w = 1 - E2 * _sin * _sin;
export const MERIDIAN_R = A * (1 - E2) / Math.pow(_w, 1.5);   // 子午線曲率半径（南北）
export const NORMAL_R = A / Math.sqrt(_w);                    // 卯酉線曲率半径（東西）

/* 緯度経度[rad] → ワールド座標。scene は +Z=北 / +X=西。 */
export function lonLatRadToLocal(lonRad, latRad) {
  return {
    x: -((lonRad - ORIGIN_LON) * NORMAL_R * Math.cos(latRad)),
    z: (latRad - ORIGIN_LAT) * MERIDIAN_R,
  };
}

/* ワールド座標 → 緯度経度[rad]。 */
export function localToLonLatRad(x, z) {
  const lat = ORIGIN_LAT + z / MERIDIAN_R;
  const lon = ORIGIN_LON + (-x) / (NORMAL_R * Math.cos(lat));
  return { lat, lon };
}

/* 度で扱いたいとき用の同じもの。 */
export function lonLatToLocal(lonDeg, latDeg) {
  return lonLatRadToLocal(lonDeg * DEG2RAD, latDeg * DEG2RAD);
}
export function localToLonLat(x, z) {
  const { lat, lon } = localToLonLatRad(x, z);
  return { lat: lat * RAD2DEG, lon: lon * RAD2DEG };
}
