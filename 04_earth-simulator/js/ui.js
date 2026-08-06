// =============================================================================
// ui — 画面まわり。
//   ・左上パネル（切り抜きの操作・読み込み状況の表示）
//   ・右下の国土地理院地図（クリックで拡大 → 選んだ地点へ注目地点を移す）
// =============================================================================
import { el, markSectionDirty, recenterOnFocus } from './core.js';
import {
  DEG2RAD, ORIGIN_LAT, ORIGIN_LON, HEIGHT_BANDS,
  ELEVATION_TINT_STOPS, ELEVATION_TINT_STEPS,
} from './config.js';
import { CLIP_SIZE_MIN, CLIP_SIZE_MAX, clipState } from './section.js';
import {
  wardTiles, getLoadPhase, getTerrainTiles, setFocusLatLon,
  setBuildingColorMode, buildingColorState, isTerrainReady, reloadAllTiles,
  terrainTintState, setTerrainTintStep, setImageryChangeHandler,
} from './tiles.js';

// 親アプリ（01）の下部パネルにも同じ切り抜きスライダーが並んでいる。
//   ・親から動かされたとき  … setClipSizeFromParent()
//   ・こちらの HUD で動いたとき … 親の syncEarthClipSize() へ通知
//   どちらの目盛りを見ても同じ値になるように、両方向でつないでおく。
//   ※ 切り抜きOFF は親には 0 として伝える（親のスライダーの 0 と意味が揃う）。
let setClipSizeFromParent = () => {};
let getClipSize = () => 0;

// 折りたたみ（地形／建物／景観・眺望規制）の開閉。
//   見出しに class="disclosure" と aria-controls="中身のid" を付けるだけで増やせる。
(function setupDisclosures() {
  for (const head of document.querySelectorAll('.disclosure[aria-controls]')) {
    const body = el(head.getAttribute('aria-controls'));
    if (!body) continue;
    head.addEventListener('click', () => {
      const open = !head.classList.contains('open');
      head.classList.toggle('open', open);
      body.classList.toggle('open', open);
      head.setAttribute('aria-expanded', String(open));
    });
  }
})();

// 「地形」の見せ方：箱庭表示（中心を四角く切り抜くカットモデル）／全体表示 の2択。
//   ★ 切り抜きの【大きさ】はここでは持たない。親アプリ（01）の下部バーのスライダーが
//     決めて setEarthClipSize で送ってくる（単独で開いたときは既定の 300m のまま）。
//     地形を切るかどうかも箱庭表示に含める（建物だけ切って地形が残ると宙に浮いて見えるため）。
(function setupClipUI() {
  const boxBtn = el('clipModeBox'), allBtn = el('clipModeAll');
  if (!boxBtn || !allBtn) return;
  clipState.terrain = true;   // 箱庭表示では地形も一緒に切る（地盤ラインを出す）

  const reportToParent = () => {
    if (window.parent === window) return;
    const fn = window.parent.syncEarthClipSize;
    if (typeof fn === 'function') fn(clipState.enabled ? clipState.size : 0);
  };

  const syncClipMode = () => {
    boxBtn.classList.toggle('active', clipState.enabled);
    allBtn.classList.toggle('active', !clipState.enabled);
  };
  const setClipMode = (on) => {
    if (clipState.enabled === on) return;
    clipState.enabled = on;
    syncClipMode();
    markSectionDirty();
    reportToParent();
  };
  boxBtn.addEventListener('click', () => setClipMode(true));
  allBtn.addEventListener('click', () => setClipMode(false));
  syncClipMode();

  setClipSizeFromParent = (m) => {
    const size = Math.min(CLIP_SIZE_MAX, Math.max(CLIP_SIZE_MIN, Number(m)));
    if (!Number.isFinite(size)) return;
    clipState.enabled = true;      // 親のスライダーを動かした＝箱庭表示にしたい、とみなす
    clipState.size = size;
    syncClipMode();
    markSectionDirty();
  };
  getClipSize = () => (clipState.enabled ? clipState.size : 0);
})();

// ---- 「標高段彩」を選んだときだけ出る操作（刻みの切り替え＋色見本）----------------
//   地形画像の選択が段彩に変わったかどうかは tiles.js から知らせてもらう
//   （ボタン自体は tiles.js が IMAGERY から生成しているため）。
(function setupElevationTintUI() {
  const box = el('elevTintUi'), stepRow = el('elevStepSwitch'), legend = el('elevLegend');
  if (!box || !stepRow || !legend) return;

  const stepBtns = ELEVATION_TINT_STEPS.map((m) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = m + 'm';
    b.dataset.step = String(m);
    stepRow.appendChild(b);
    return b;
  });
  const syncSteps = () => {
    for (const b of stepBtns) {
      b.classList.toggle('active', Number(b.dataset.step) === terrainTintState.step);
    }
  };
  for (const b of stepBtns) {
    b.addEventListener('click', () => {
      setTerrainTintStep(Number(b.dataset.step));
      syncSteps();
    });
  }
  syncSteps();

  // 色見本。config の色そのものを並べる（標高の低い順＝画面の下から上の順）。
  for (const s of [...ELEVATION_TINT_STOPS].reverse()) {
    const row = document.createElement('div');
    const sw = document.createElement('i');
    sw.style.background = '#' + s.color.toString(16).padStart(6, '0');
    row.appendChild(sw);
    row.appendChild(document.createTextNode(`${s.ele} m`));
    legend.appendChild(row);
  }

  setImageryChangeHandler(() => { box.style.display = terrainTintState.on ? 'flex' : 'none'; });
  box.style.display = terrainTintState.on ? 'flex' : 'none';   // 起動時の状態に合わせる
})();

// 建物の「内側の面（裏面）」を赤く塗るシェーダ改造。
//   建物は底面の無い開いたシェルなので、クリップで切ると内側の壁面が見える。
//   その裏面だけを赤にすることで、切り口が赤いカットモデル風の見た目になる。
//   diffuseColor を差し替えるので通常のライティング・フォグがそのまま効く

// 全区の stats を合算して表示（視界内の区だけが数字を持つ）。
function updateHud() {
  let visible = 0, loaded = 0, downloading = 0, parsing = 0;
  for (const t of wardTiles) {
    const s = t.stats; if (!s) continue;
    visible += s.visible ?? 0;
    loaded += s.loaded ?? 0;
    downloading += s.downloading ?? 0;
    parsing += s.parsing ?? 0;
  }
  // 第1段（指定地点の1枚）か第2段（500m四方）かが分かるように表示する
  el('statVisible').textContent = visible + (getLoadPhase() === 0 ? '（中心1枚を優先中）' : '');
  el('statLoaded').textContent = String(loaded);
  el('statDl').textContent = String(downloading);
  el('statParse').textContent = String(parsing);
  const tt = getTerrainTiles();
  if (tt && tt.stats) {
    el('statTerrain').textContent = String(tt.stats.visible ?? 0);
  }

  // 左下の「読み込み中…」。まだ地形が十分細かくなっていないか、
  // 建物・地形のどこかが取得中／解析中のあいだ出しておく。
  //   ※ 全画面の #loading は自作モデルを出した時点で外している（切り替えを待たせないため）。
  //     こちらは「周りの世界がまだ揃っていない」ことを邪魔せずに伝えるための表示。
  const tStats = tt && tt.stats ? tt.stats : null;
  const busy = downloading + parsing
    + (tStats ? (tStats.downloading ?? 0) + (tStats.parsing ?? 0) : 0);
  const loadingEl = el('tileLoading');
  if (loadingEl) loadingEl.classList.toggle('on', busy > 0 || !isTerrainReady());

  return visible;
}

// =========================================================================
// 小窓の地図（国土地理院）— クリックで拡大、地図上をクリックした地点に9タイルを移す
// =========================================================================
// 小窓の中心（＝十字＝注目地点）を外から動かすための口。
//   親アプリから「前回この場所に置いた」と渡されたとき、注目地点だけ動かすと
//   十字の位置が食い違うので、地図の中心も一緒に合わせる（usermodel.js が呼ぶ）。
let setPickerCenter = () => {};

(function setupLocationPicker() {
  const RAD2DEG = 180 / Math.PI;
  const ORIGIN_LAT_DEG = ORIGIN_LAT * RAD2DEG;
  const ORIGIN_LON_DEG = ORIGIN_LON * RAD2DEG;
  const TILE = 256;
  const MAP_LAYER = 'https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png'; // 地理院地図(標準)

  // --- Web メルカトルの座標変換 ---
  const lonToWX = (lonDeg, z) => (lonDeg + 180) / 360 * Math.pow(2, z) * TILE;
  const latToWY = (latDeg, z) => {
    const s = Math.sin(latDeg * Math.PI / 180);
    return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * Math.pow(2, z) * TILE;
  };
  const wxToLon = (wx, z) => wx / (Math.pow(2, z) * TILE) * 360 - 180;
  const wyToLat = (wy, z) => {
    const n = Math.PI - 2 * Math.PI * wy / (Math.pow(2, z) * TILE);
    return RAD2DEG * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
  };

  // 地図の状態（中心＝現在の注目地点。既定は原点）。
  const map = {
    centerLat: ORIGIN_LAT_DEG, centerLon: ORIGIN_LON_DEG, zoom: 15, expanded: false,
  };

  // DOM 構築
  const wrap = document.createElement('div');
  wrap.id = 'pickerWrap';
  wrap.innerHTML = `
    <div id="pickerHint"></div>
    <div id="pickerTiles"></div>
    <div id="pickerCross"></div>
    <div id="pickerOrigin" title="自作モデル位置"></div>
    <div id="pickerBtns"></div>`;
  document.body.appendChild(wrap);
  const tilesEl = wrap.querySelector('#pickerTiles');
  const crossEl = wrap.querySelector('#pickerCross');
  const originEl = wrap.querySelector('#pickerOrigin');
  const hintEl = wrap.querySelector('#pickerHint');
  const btnsEl = wrap.querySelector('#pickerBtns');

  function size() { return map.expanded
    ? { w: Math.min(window.innerWidth * 0.7, 720), h: Math.min(window.innerHeight * 0.7, 560) }
    : { w: 220, h: 160 }; }

  // 指定した緯度経度(度)を地図中心に、タイルを敷き詰めて描画する。
  function render() {
    const { w, h } = size();
    wrap.classList.toggle('expanded', map.expanded);
    wrap.style.width = w + 'px'; wrap.style.height = h + 'px';
    const z = map.zoom, n = Math.pow(2, z);
    const cwx = lonToWX(map.centerLon, z), cwy = latToWY(map.centerLat, z);
    const originWX = lonToWX(ORIGIN_LON_DEG, z), originWY = latToWY(ORIGIN_LAT_DEG, z);
    const tlx = cwx - w / 2, tly = cwy - h / 2; // 左上のワールドピクセル
    // 敷き詰めるタイル範囲
    const x0 = Math.floor(tlx / TILE), x1 = Math.floor((tlx + w) / TILE);
    const y0 = Math.floor(tly / TILE), y1 = Math.floor((tly + h) / TILE);
    let html = '';
    for (let ty = y0; ty <= y1; ty++) {
      for (let tx = x0; tx <= x1; tx++) {
        const wx = ((tx % n) + n) % n; // 経度方向はラップ
        if (ty < 0 || ty >= n) continue;
        const url = MAP_LAYER.replace('{z}', z).replace('{x}', wx).replace('{y}', ty);
        const left = tx * TILE - tlx, top = ty * TILE - tly;
        html += `<img src="${url}" style="left:${left}px;top:${top}px" draggable="false" />`;
      }
    }
    tilesEl.innerHTML = html;
    // 中心の十字（＝現在の注目地点）と、原点マーカー
    crossEl.style.left = (w / 2) + 'px'; crossEl.style.top = (h / 2) + 'px';
    originEl.style.left = (originWX - tlx) + 'px'; originEl.style.top = (originWY - tly) + 'px';
    hintEl.textContent = map.expanded ? '地図をクリック → その地点に建物を移動（ドラッグ=移動 / ホイール=拡縮）' : '地図（クリックで拡大）';
    btnsEl.style.display = map.expanded ? 'flex' : 'none';
  }

  // ピクセル(要素内)→ 緯度経度
  function pxToLatLon(px, py) {
    const { w, h } = size(), z = map.zoom;
    const wx = lonToWX(map.centerLon, z) - w / 2 + px;
    const wy = latToWY(map.centerLat, z) - h / 2 + py;
    return { lat: wyToLat(wy, z), lon: wxToLon(wx, z) };
  }

  // --- 操作 ---
  let dragging = false, moved = false, lastX = 0, lastY = 0;
  wrap.addEventListener('pointerdown', (e) => {
    if (e.target.closest('#pickerBtns')) return;
    if (!map.expanded) return; // 小窓時はクリックで拡大（下の click で処理）
    dragging = true; moved = false; lastX = e.clientX; lastY = e.clientY;
    wrap.setPointerCapture(e.pointerId);
  });
  wrap.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const dx = e.clientX - lastX, dy = e.clientY - lastY;
    if (Math.abs(dx) + Math.abs(dy) > 3) moved = true;
    lastX = e.clientX; lastY = e.clientY;
    const z = map.zoom;
    map.centerLon = wxToLon(lonToWX(map.centerLon, z) - dx, z);
    map.centerLat = wyToLat(latToWY(map.centerLat, z) - dy, z);
    render();
  });
  wrap.addEventListener('pointerup', (e) => { dragging = false; });
  wrap.addEventListener('click', (e) => {
    if (e.target.closest('#pickerBtns')) return;
    if (!map.expanded) { map.expanded = true; render(); return; } // 小窓→拡大
    if (moved) return; // ドラッグはピック扱いしない
    const r = wrap.getBoundingClientRect();
    const { lat, lon } = pxToLatLon(e.clientX - r.left, e.clientY - r.top);
    map.centerLat = lat; map.centerLon = lon;
    setFocusLatLon(lat / RAD2DEG, lon / RAD2DEG, true); // 9タイルをそこへ移す＆カメラ追従
    render();
  });
  wrap.addEventListener('wheel', (e) => {
    if (!map.expanded) return;
    e.preventDefault();
    map.zoom = Math.max(10, Math.min(18, map.zoom + (e.deltaY < 0 ? 1 : -1)));
    render();
  }, { passive: false });

  // ボタン（閉じる / この中心へ移動）
  const mkBtn = (label, fn) => { const b = document.createElement('button'); b.textContent = label; b.addEventListener('click', fn); return b; };
  btnsEl.appendChild(mkBtn('この中心へ', () => {
    setFocusLatLon(map.centerLat / RAD2DEG, map.centerLon / RAD2DEG, true);
  }));
  btnsEl.appendChild(mkBtn('閉じる', () => { map.expanded = false; render(); }));

  setPickerCenter = (latDeg, lonDeg) => {
    map.centerLat = latDeg;
    map.centerLon = lonDeg;
    render();
  };

  window.addEventListener('resize', render);
  render();
})();

// ---- 「建物」の見せ方：PLATEAUデフォルト／白モデル／高さで色分け と、その凡例 ------
(function setupBuildingStyleUI() {
  const legendEl = el('heightLegend');
  const btns = [...document.querySelectorAll('#buildingStyleSwitch button[data-bldg-mode]')];
  if (!btns.length || !legendEl) return;
  // 凡例は HEIGHT_BANDS からそのまま組み立てる（色や区分を変えても勝手に追従する）
  for (const b of HEIGHT_BANDS) {
    const row = document.createElement('div');
    const sw = document.createElement('i');
    sw.style.background = '#' + b.color.toString(16).padStart(6, '0');
    row.appendChild(sw);
    row.appendChild(document.createTextNode(b.label));
    legendEl.appendChild(row);
  }
  const sync = () => {
    for (const b of btns) {
      b.classList.toggle('active', b.dataset.bldgMode === buildingColorState.mode);
    }
    legendEl.classList.toggle('on', buildingColorState.mode === 'height'); // 凡例は色分けのときだけ
  };
  for (const b of btns) {
    b.addEventListener('click', () => {
      if (buildingColorState.mode === b.dataset.bldgMode) return;
      setBuildingColorMode(b.dataset.bldgMode);
      sync();
    });
  }
  sync();
})();

// パンで注視点が離れたとき、注目地点へ戻すボタン
(function setupRecenterUI() {
  const b = el('recenterBtn');
  if (b) b.addEventListener('click', () => recenterOnFocus());
})();

// ---- パネル最下部の「データを再読み込み」-------------------------------------
//   何らかの不具合（通信失敗・キューの詰まり）で地形や建物が出てこなくなったときの立て直し。
//   押しっぱなしの連打で余計に詰まらないよう、実行中は少しのあいだ押せなくする。
(function setupReloadUI() {
  const b = el('reloadBtn');
  if (!b) return;
  b.addEventListener('click', () => {
    b.disabled = true;
    const label = b.textContent;
    b.textContent = '再読み込み中…';
    try {
      reloadAllTiles();
    } catch (e) {
      console.warn('再読み込みに失敗:', e);
    }
    setTimeout(() => { b.disabled = false; b.textContent = label; }, 1500);
  });
})();

export { updateHud, setPickerCenter, setClipSizeFromParent, getClipSize };
