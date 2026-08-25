// =============================================================================
// roads — PLATEAU の道路データ（tran, MVT）を地形に投影して光らせる。
//
//   【なぜ 3D Tiles ではなく MVT か】
//     PLATEAU の道路（tran）を 3D Tiles で配信しているのは LOD3 だけで、しかも
//     建物LOD3と同じくごく一部の地区に限られる（京都市では先斗町・木屋町のみ）。
//     一方 LOD1 は市域全体をカバーするが、配信形式が MVT（2Dのベクタータイル）しかない。
//     「どこが道路か市内全域で分かる」ことを優先し、地形（Quantized Mesh。既に高低差を
//     持つ）の上に道路ポリゴンを投影する方式にした。将来のストリートビュー機能で
//     「今どこにいるか」の下敷きにする想定なので、範囲が限られる3Dモデルより
//     全域を薄く覆えるこちらの方が土台として使いやすい。
//
//   【仕組み】
//     3d-tiles-renderer に MVTOverlay というこの用途そのもののプラグインがあり、
//     航空写真／地理院地図と全く同じ ImageOverlayPlugin の合成の仕組みで動く
//     （道路ポリゴンをその場でラスタライズしてタイルのテクスチャに焼き込む）。
//     地形は Quantized Mesh で起伏を持つので、貼り付けた道路は自動的にその起伏に沿う。
//     MVTデコードに @mapbox/vector-tile と pbf を使う（動的import。index.html の
//     importmap に esm.sh 経由で登録済み）。
//
//   【地形との結線】
//     道路を貼る先の overlayPlugin は地形と一緒に作り直される（reloadAllTiles）ので、
//     tiles.js の setRoadOverlayHook で「作り直すたびに新しい plugin を受け取る」形にして
//     ある（建物編集・屋根テキストと同じフック方式）。MVTOverlay のインスタンス自体は
//     使い回し、plugin の差し替えのたびに addOverlay し直すだけ（読み込み済みタイルの
//     キャッシュを無駄にしない）。
// =============================================================================
import { MVTOverlay } from '3d-tiles-renderer/plugins';
import { el, requestRender, focusLocal, EARTH_R } from './core.js';
import {
  ROAD_MVT, PLATEAU_CATALOG_GRAPHQL, ROAD_CATALOG_TIMEOUT_MS,
  ROAD_HIGHLIGHT_FILL, ROAD_HIGHLIGHT_OPACITY, ROAD_HIGHLIGHT_OPACITY_PICKING,
  ROAD_WALK_FILL,
  ROAD_LOAD_WIDTH, ROAD_MAX_TILE_SPAN, ROAD_RASTER_RESOLUTION, ORIGIN_LAT, ORIGIN_LON,
} from './config.js';
import { setRoadOverlayHook, getOverlayPlugin } from './tiles.js';
import { localToLonLatRad, MERIDIAN_R, NORMAL_R } from './geo.js';

const roadState = {
  enabled: false,
  overlay: null,     // MVTOverlay（terrain の作り直しをまたいで使い回す）
  plugin: null,       // 今の overlayPlugin（terrain が作り直されるたびに差し替わる）
  url: null,
  year: null,
  source: null,       // 'catalog' / 'fallback'
  resolving: false,
};

// -----------------------------------------------------------------------------
// 最新の MVT URL を PLATEAU データカタログから引く。
//   フォールバックと同じ LOD（=1）を優先して選ぶ（属性スキーマが確認済みのため）。
//   ※ 建物・道路3Dモデルと同じカタログ問い合わせ方式（datasets(input:{...})）。
// -----------------------------------------------------------------------------
const CATALOG_QUERY =
  'query($i:DatasetsInput){ datasets(input:$i){ year type{code} '
  + '... on PlateauDataset { items { lod format url } } } }';

async function resolveRoadMvt(cfg) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ROAD_CATALOG_TIMEOUT_MS);
  try {
    const res = await fetch(PLATEAU_CATALOG_GRAPHQL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: ctrl.signal,
      body: JSON.stringify({
        query: CATALOG_QUERY,
        variables: { i: { areaCodes: [cfg.areaCode], includeTypes: ['tran'] } },
      }),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const json = await res.json();
    if (json.errors) throw new Error(json.errors[0]?.message || 'GraphQL error');
    let best = null, bestAnyMvt = null;
    for (const ds of json.data?.datasets || []) {
      if (ds.type?.code !== 'tran') continue;
      for (const it of ds.items || []) {
        if (it.format !== 'MVT' || !it.url) continue;
        const cand = { url: it.url, year: ds.year || 0, lod: it.lod || 0 };
        if (cand.lod === 1 && (!best || cand.year > best.year)) best = cand;
        if (!bestAnyMvt || cand.year > bestAnyMvt.year
            || (cand.year === bestAnyMvt.year && cand.lod < bestAnyMvt.lod)) bestAnyMvt = cand;
      }
    }
    const picked = best || bestAnyMvt;
    if (!picked) throw new Error('MVT の道路データがカタログに見つかりません');
    return { ...picked, source: 'catalog' };
  } finally {
    clearTimeout(timer);
  }
}

// -----------------------------------------------------------------------------
// 道路の見せ方（黄色っぽく光らせる）。
//   layer 名は実測で 'Road'（ポリゴン＝道路面）のみを確認済み。それ以外は無視する。
// -----------------------------------------------------------------------------
// 道路の見せ方。'picking'＝着地点をさがしている（濃く）／'walking'＝歩いている（薄く）。
// 既定は地球モードで眺めているときの見え方。
//
// ★ 縁の線（stroke）は描かない。道路面の塗りだけで示す。
//   ポリゴンの縁を線で強調すると、隣り合う道路面の継ぎ目や、同じ道路が複数の
//   ポリゴンに分かれている箇所でも線が引かれてしまい、実際の道路の形とは違う
//   格子状の模様が浮いて見える。塗りだけなら面の広がりがそのまま出る。
let roadStyleMode = 'walking';

function getStyle(layerName, properties) {
  if (layerName !== 'Road') return null;
  if (properties === null) return { order: 0 }; // レイヤー順を聞かれただけの呼び出し
  // 見せ方は場面で切り替わる（roadStyleMode）。塗りは canvas に焼くので、
  // 変えたあとは overlay.redraw() で描き直しが要る。
  return { fill: roadStyleMode === 'walking' ? ROAD_WALK_FILL : ROAD_HIGHLIGHT_FILL };
}

// ⚠️ 市域の外側のタイルは 404（XMLのエラーボディ）が返る。PLATEAU のMVTは市域ぶんしか
//   存在しないので、地形が広く読まれるほどこれは【正常に起こる】。
//   ところが MVTOverlay は素の fetch 結果をそのまま protobuf に食わせるため、404のXMLで
//   「Unimplemented type: 4」を投げ、その region のテクスチャが丸ごと failed になる
//   （＝道路が1枚も出ない。実測でこれが起きた）。
//   404 を「空のタイル＝道路なし」に読み替えて渡す。MVTContentCache は byteLength===0 を
//   null と扱い、描画側はそれを素通しするので、欠損域は正しく「何も描かない」になる。
//   ※ 画像オーバーレイ（航空写真）が同じ404を無害にやり過ごせるのは、画像デコードの
//     失敗が単に「そのタイルを貼らない」で済むから。MVT は例外になる点が違う。
// -----------------------------------------------------------------------------
// 読み込む範囲を注目地点まわりに絞る
//   道路オーバーレイは【地形タイル】に貼るので、放っておくと「地形が読まれた範囲すべて」で
//   MVTを取りに行く。地形は建物と違って距離制限なしに広く読むため、遠方の粗い地形タイルの
//   ために低ズームのMVT（＝市域全体が1枚に入った重いタイル）まで取ってしまう。
//   注目地点まわりの矩形（ROAD_LOAD_WIDTH 四方）と交差する range だけ通す。
//
//   range は「正規化した Web メルカトル座標」[minX, minY, maxX, maxY]（0..1、北が大）。
//   注目地点はワールド座標(focusLocal)でしか持っていないので、緯度経度に戻してから同じ系へ写す。
// -----------------------------------------------------------------------------
const DEG = 180 / Math.PI;
function focusMercatorBox() {
  // tiles.js の setFocusLatLon と逆の変換（geo.js の局所ENU）
  const { lat, lon } = localToLonLatRad(focusLocal.x, focusLocal.z);
  const half = ROAD_LOAD_WIDTH / 2;
  const dLat = half / MERIDIAN_R;
  const dLon = half / (NORMAL_R * Math.cos(lat));
  const toX = (lonRad) => (lonRad * DEG + 180) / 360;
  const toY = (latRad) => {
    const s = Math.min(Math.max(Math.sin(latRad), -0.9999), 0.9999);
    return 0.5 + Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
  };
  return {
    minX: toX(lon - dLon), maxX: toX(lon + dLon),
    minY: toY(lat - dLat), maxY: toY(lat + dLat),
  };
}
// 正規化メルカトルでの幅 → おおよその実距離[m]（緯度は注目地点のもので足りる）
//   ★ こちらの EARTH_R は Web メルカトルの定義そのもの（球体・半径6378137）なので、
//     楕円体の曲率半径に置き換えてはいけない。
const MERC_CIRCUM = 2 * Math.PI * EARTH_R;
function rangeSpanMeters(range) {
  const { lat } = localToLonLatRad(focusLocal.x, focusLocal.z);
  return (range[2] - range[0]) * MERC_CIRCUM * Math.cos(lat);
}

// 緯度経度[度] → 正規化メルカトル(0..1、北が大)。上の focusMercatorBox と同じ式。
function lonLatToMercator(latDeg, lonDeg) {
  const s = Math.min(Math.max(Math.sin(latDeg / DEG), -0.9999), 0.9999);
  return {
    x: (lonDeg + 180) / 360,
    y: 0.5 + Math.log((1 + s) / (1 - s)) / (4 * Math.PI),
  };
}

// -----------------------------------------------------------------------------
// その緯度経度が「道路の上か」を返す（ストリートビューの着地判定に使う）。
//   ★判定は【実際に描かれた絵】を読む。MVT は canvas にラスタライズしてから
//     テクスチャにしているので（MVTImageSource.fetchItem）、その canvas の画素の
//     不透明度を見れば「そこが黄色く光っているか」がそのまま分かる。
//     ベクタのポリゴンを自前で内外判定するより確実で、見た目と絶対に食い違わない。
//   道路が読み込まれていない場所・範囲外は false。
// -----------------------------------------------------------------------------
const _sampleCtx = new WeakMap();   // canvas → 2Dコンテキスト（getImageData のたびに取り直さない）
function isRoadAt(latDeg, lonDeg) {
  const { overlay, plugin, enabled } = roadState;
  if (!enabled || !overlay || !plugin) return false;
  const info = plugin.overlayInfo.get(overlay);
  if (!info) return false;
  const p = lonLatToMercator(latDeg, lonDeg);

  // ★その点を含むタイルのうち【いちばん細かい1枚】だけを見る。
  //   ⚠️ 「どれか1枚でも道路と言えば道路」にしてはいけない。同じ場所を粗さの違う
  //     タイルが何枚も覆っていて（実測で 0.03〜3.91 m/画素の28枚）、粗いタイルでは
  //     1画素が約4mある。粗い側を採ると道路が4mほど太って判定され、
  //     見た目の道路の外まで歩けてしまう。細かい1枚なら画面の見た目と一致する。
  let best = null, bestSpan = Infinity;
  info.tileInfo.forEach((v) => {
    if (!v.target || !v.range) return;
    const [minX, minY, maxX, maxY] = v.range;
    if (p.x < minX || p.x > maxX || p.y < minY || p.y > maxY) return;
    const span = maxX - minX;
    if (span < bestSpan) { bestSpan = span; best = v; }
  });
  if (!best) return false;

  const [minX, minY, maxX, maxY] = best.range;
  const canvas = best.target.image;
  if (!canvas || !canvas.width) return false;
  // range は「上端が maxY」で描かれている（TiledTextureComposer / setFrame と同じ向き）
  const px = Math.floor((p.x - minX) / (maxX - minX) * canvas.width);
  const py = Math.floor((maxY - p.y) / (maxY - minY) * canvas.height);
  if (px < 0 || py < 0 || px >= canvas.width || py >= canvas.height) return false;
  let ctx = _sampleCtx.get(canvas);
  if (!ctx) {
    try { ctx = canvas.getContext('2d', { willReadFrequently: true }); } catch (e) { return false; }
    if (!ctx) return false;
    _sampleCtx.set(canvas, ctx);
  }
  try {
    // 道路は透明な canvas の上に塗られているので、不透明なら道路
    return ctx.getImageData(px, py, 1, 1).data[3] > 8;
  } catch (e) { return false; }
}

function rangeInFocus(range) {
  // ① 粗すぎる段は貼らない。地形タイルは階層で、注目地点を含む祖先タイルが全段に居るので、
  //    これが無いと矩形判定をすり抜けて低ズームの重いMVTを取りに行く（ROAD_MAX_TILE_SPAN 参照）。
  if (rangeSpanMeters(range) > ROAD_MAX_TILE_SPAN) return false;
  // ② 注目地点まわりの矩形と交差するものだけ
  const b = focusMercatorBox();
  return !(range[2] < b.minX || range[0] > b.maxX || range[3] < b.minY || range[1] > b.maxY);
}

class RoadMvtOverlay extends MVTOverlay {
  constructor(options) {
    super(options);
    patchTileExtent(this.imageSource);
    // lock した range を数えておく。範囲外は lock しないので、対応する release も
    // 呼んではいけない（DataCache は未 lock の release で例外を投げる）。
    this._lockCounts = new Map();
  }

  async fetch(url, options) {
    const res = await super.fetch(url, options);
    if (res.ok) return res;
    return new Response(new ArrayBuffer(0), { status: 200 });
  }

  // プラグインは addOverlay のたびに自分の解像度を押し付けてくるので、こちらの値で固定する
  // （どのズームのMVTを選ぶかがこれで決まる。詳しくは ROAD_RASTER_RESOLUTION のコメント）。
  setResolution() { /* プラグインの指定は無視し、コンストラクタで決めた値を保つ */ }

  // ここが実際の「読まない」判断。false を返すとプラグインはテクスチャを取りに行かない。
  hasContent(range) {
    if (!rangeInFocus(range)) return false;
    return super.hasContent(range);
  }

  // ⚠️ hasContent だけでは足りない。プラグインは _initTileOverlayInfo で
  //   hasContent を見ずに lockTexture を呼び、その中で MVT の取得が始まる。
  //   ここでも同じ判定をしないと通信は減らない（実測でここが主因だった）。
  lockTexture(range) {
    if (!rangeInFocus(range)) return null;
    const k = range.join('_');
    this._lockCounts.set(k, (this._lockCounts.get(k) || 0) + 1);
    return super.lockTexture(range);
  }

  releaseTexture(range) {
    const k = range.join('_');
    const n = this._lockCounts.get(k) || 0;
    if (n === 0) return;              // lock していない＝範囲外だったもの
    if (n === 1) this._lockCounts.delete(k); else this._lockCounts.set(k, n - 1);
    super.releaseTexture(range);
  }
}

// ⚠️ もう一つの落とし穴: MVT の「タイル内座標の分解能」(layer.extent) は仕様上タイルごとに
//   異なってよい。ところがライブラリは VectorShapeCanvasRenderer を tileExtent:4096
//   （仕様の既定値）固定で作ってしまう。
//   PLATEAU の道路MVTは extent が一定ではなく、実測で高ズーム=65536・低ズーム=128 だった。
//   4096固定のままだと座標が16倍に拡大され、道路が画面いっぱいの巨大な黄色い帯になる
//   （地理院地図と並べて確認したところ、道路の形をなしていなかった）。
//   「最後に読んだタイルの値」を使い回すのも誤りで、ズームが混在すると別のタイルのextentで
//   描いてしまう。タイル1枚ごとに、そのタイル自身の extent を設定してから setFrame する必要がある。
//
//   そのため _drawToCanvas を差し替える。元の実装との違いは
//   「vectorTile を setFrame より【先に】取り出し、その extent を反映してから setFrame する」点だけ。
//   ライブラリ内部の forEachTileInBounds は import できないので、同じ列挙を tiling から行う
//   （元実装と同一のロジック。1e-8 の内側への詰めも含めて合わせてある）。
function patchTileExtent(src) {
  const cache = src._contentCache;
  const cr = src._canvasRenderer;
  src._drawToCanvas = (canvas, regionBounds, level) => {
    const ctx = canvas.getContext('2d');
    const tiling = cache.tiling;
    const [minLon, minLat, maxLon, maxLat] = regionBounds;
    const lv = Math.max(Math.min(level, tiling.maxLevel), tiling.minLevel);
    const [minX, minY, maxX, maxY] = tiling.getTilesInRange(
      minLon + 1e-8, minLat + 1e-8, maxLon - 1e-8, maxLat - 1e-8, lv, true,
    );
    for (let x = minX; x <= maxX; x++) {
      for (let y = minY; y <= maxY; y++) {
        const vectorTile = cache.get(x, y, lv);
        if (vectorTile) {
          for (const name in vectorTile.layers) {
            const ext = vectorTile.layers[name].extent;
            if (ext) { cr.tileExtent = ext; break; }
          }
        }
        cr.setFrame(ctx, tiling.getTileBounds(x, y, lv, true, false), regionBounds);
        if (vectorTile) src._renderVectorTile(vectorTile);
      }
    }
  };
}

function makeOverlay(urlTemplate, levels) {
  return new RoadMvtOverlay({
    url: urlTemplate,
    levels,
    resolution: ROAD_RASTER_RESOLUTION,
    opacity: ROAD_HIGHLIGHT_OPACITY,
    getStyle,
  });
}

// -----------------------------------------------------------------------------
// terrain（overlayPlugin）が作り直されるたびに呼ばれる。
//   plugin === null は地形が破棄された直後（＝いったん外れる。次の作成で戻る）。
// -----------------------------------------------------------------------------
// -----------------------------------------------------------------------------
// 注目地点が動いたときに、新しく範囲に入った地形タイルへ道路を取りに行かせる。
//   タイルごとの初期化（hasContent / lockTexture の判定）はタイル読込時に一度きりなので、
//   注目地点だけが動いた場合は「前は範囲外だったので道路が無いタイル」がそのまま残る。
//
//   ⚠️ deleteOverlay → addOverlay で作り直すのは【不可】。プラグインは addOverlay のたびに
//     overlay.fetch を downloadQueue でラップし直すので、繰り返すとラップが入れ子になり、
//     キューに入れたジョブの中でさらにキューへ積むことになる（maxJobs 到達時に停止しうる）。
//   そこで「範囲に入ったのにテクスチャが無いタイル」に failed 印を付け、
//   公開APIの resetFailedOverlays() に取得し直させる。内部状態を触らずに済む。
function refreshRoadRange() {
  const { plugin, overlay, enabled } = roadState;
  if (!enabled || !plugin || !overlay) return;
  const info = plugin.overlayInfo.get(overlay);
  if (!info) return;
  let n = 0;
  info.tileInfo.forEach((v) => {
    if (!v.target && !v.failed && v.range && rangeInFocus(v.range)) { v.failed = true; n++; }
  });
  if (n === 0) return;
  // ※ 他のオーバーレイ（航空写真）の失敗も一緒に再試行されるが、注目地点の移動時しか
  //   呼ばないので実害は無い。
  plugin.resetFailedOverlays();
  requestRender();   // resetFailedOverlays は rAF 内で動くので描画ループを起こしておく
}

function onOverlayPluginChanged(plugin) {
  roadState.plugin = plugin;
  if (!roadState.enabled || !plugin || !roadState.overlay) return;
  plugin.addOverlay(roadState.overlay, 1); // order=1固定（0=航空写真／地図。tiles.js 参照）
}
setRoadOverlayHook(onOverlayPluginChanged);
roadState.plugin = getOverlayPlugin();   // 起動時点で既に作られている分を直接拾う（上のコメント参照）

async function setRoadsEnabled(on) {
  roadState.enabled = !!on;
  if (ui.body) ui.body.style.display = roadState.enabled ? '' : 'none';
  if (!roadState.enabled) {
    if (roadState.plugin && roadState.overlay) {
      try { roadState.plugin.deleteOverlay(roadState.overlay); } catch (err) { /* ignore */ }
    }
    updateStatus();
    requestRender();
    return;
  }
  if (roadState.overlay) {
    if (roadState.plugin) roadState.plugin.addOverlay(roadState.overlay, 1);
    updateStatus();
    requestRender();
    return;
  }
  if (!ROAD_MVT) { updateStatus(); return; }
  // 初回：最新URLをカタログに聞いてから作る
  roadState.resolving = true;
  updateStatus();
  requestRender();
  let picked;
  try {
    picked = await resolveRoadMvt(ROAD_MVT);
  } catch (err) {
    console.warn('道路データの最新版の取得に失敗（配信済みの既定URLで続行）:', err);
    picked = {
      url: ROAD_MVT.fallbackUrl, year: ROAD_MVT.fallbackYear, lod: 1, source: 'fallback',
    };
  }
  roadState.resolving = false;
  if (!roadState.enabled) return;   // 待っている間にOFFにされた
  Object.assign(roadState, picked);
  roadState.overlay = makeOverlay(picked.url, ROAD_MVT.fallbackLevels + 1);
  if (roadState.plugin) roadState.plugin.addOverlay(roadState.overlay, 1);
  updateStatus();
  requestRender();
}

// -----------------------------------------------------------------------------
// UI
// -----------------------------------------------------------------------------
let ui = { body: null, status: null };

function updateStatus() {
  if (!ui.status) return;
  if (!ROAD_MVT) {
    ui.status.textContent = 'この都市には道路データが配信されていません。';
    return;
  }
  if (roadState.resolving) { ui.status.textContent = '最新版を問い合わせ中…'; return; }
  if (!roadState.enabled) { ui.status.textContent = ''; return; }
  const src = roadState.source === 'catalog' ? 'カタログの最新' : '同梱の既定';
  ui.status.textContent = `${roadState.year}年版（${src}）`;
}

function initRoadUi() {
  const onCb = el('roadOn');
  if (!onCb) return;
  ui = { body: el('roadBody'), status: el('roadStatus') };
  onCb.addEventListener('change', () => { setRoadsEnabled(onCb.checked); });
  updateStatus();
}

// 読み込み中かどうか（オンデマンド描画の継続判定に使う）。
//   MVTタイル自体の取得は ImageOverlayPlugin 内部のキューで進むため、
//   ここではカタログ問い合わせ中かどうかだけを見る。
function roadsBusy() {
  return roadState.resolving;
}

// 道路の濃さを場面で切り替える。
//   ・'picking' … 着地点をさがしている間。濃くしてどこに降りられるかをはっきり見せる。
//   ・'normal'  … それ以外。航空写真を潰さないよう薄くする。
//   ★濃さはマテリアル側の opacity だけで変える。塗り（canvas）は触らないので、
//     その画素で道路かどうかを見ている isRoadAt の判定はこれに影響されない。
function setRoadHighlightStrength(mode) {
  const ov = roadState.overlay;
  // 'picking' 以外（'normal' / 'walking' / 未指定）はすべて歩行時の見え方にする
  const next = (mode === 'picking') ? 'picking' : 'walking';
  roadStyleMode = next;
  if (!ov) return;
  ov.opacity = (next === 'picking') ? ROAD_HIGHLIGHT_OPACITY_PICKING : ROAD_HIGHLIGHT_OPACITY;
  // 塗りと縁取りは canvas に焼き込んであるので、色を変えたら描き直す
  try { ov.redraw(); } catch (e) { /* まだ用意ができていないときは次の更新に任せる */ }
  requestRender();
}

export {
  roadState, setRoadsEnabled, roadsBusy, initRoadUi, refreshRoadRange,
  isRoadAt, setRoadHighlightStrength,
};
