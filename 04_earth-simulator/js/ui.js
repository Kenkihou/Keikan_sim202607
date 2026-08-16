// =============================================================================
// ui — 画面まわり。
//   ・左上パネル（切り抜きの操作・読み込み状況の表示）
//   ・右下の国土地理院地図（クリックで拡大 → 選んだ地点へ注目地点を移す）
// =============================================================================
import { el, markSectionDirty, recenterOnFocus } from './core.js';
import {
  DEG2RAD, ORIGIN_LAT, ORIGIN_LON, HEIGHT_BANDS,
  ELEVATION_TINT_STOPS, ELEVATION_TINT_STEPS,
  CITIES, CITY_ID, CITY_WARD_LABEL, CITY_LOD_LABEL,
  CITY_BOUNDARY_URL, BOUNDARY_DIM, BOUNDARY_LINE_COLOR,
} from './config.js';
import { CLIP_SIZE_MIN, CLIP_SIZE_MAX, clipState } from './section.js';
import {
  wardTiles, getLoadPhase, getTerrainTiles, setFocusLatLon,
  setBuildingColorMode, buildingColorState, isTerrainReady, reloadAllTiles,
  terrainTintState, setTerrainTintStep, setImageryChangeHandler,
} from './tiles.js';
import {
  profileState, setSectionLat, profileLonRange, setEnabledChangeHandler,
} from './profile.js';

// 親アプリ（01）の下部パネルにも同じ切り抜きスライダーが並んでいる。
//   ・親から動かされたとき  … setClipSizeFromParent()
//   ・こちらの HUD で動いたとき … 親の syncEarthClipSize() へ通知
//   どちらの目盛りを見ても同じ値になるように、両方向でつないでおく。
//   ※ 切り抜きOFF は親には 0 として伝える（親のスライダーの 0 と意味が揃う）。
let setClipSizeFromParent = () => {};
let getClipSize = () => 0;

// ---- 都市の選択（PLATEAU配信サービスの都市から選ぶ）--------------------------
//   ★ ORIGIN_LAT/TILESET_URLS など config.js の値は都市ごとに固定の const として
//     一度だけ計算される（モジュール初期化時）ので、既存のタイル読み込み・座標変換の
//     コードを一切変えずに都市を切り替えるには「ページを開き直す」のが最も確実。
//     選択は URL の ?city=<id> に持たせる（config.js の CITY_ID がそこから決まる）。
(function setupCityUI() {
  const sel = el('citySelect');
  if (!sel) return;
  for (const c of CITIES) {
    const opt = document.createElement('option');
    opt.value = c.id;
    opt.textContent = c.label;
    if (c.id === CITY_ID) opt.selected = true;
    sel.appendChild(opt);
  }
  sel.addEventListener('change', () => {
    const url = new URL(location.href);
    if (sel.value === 'kyoto') url.searchParams.delete('city'); // 既定値は付けない
    else url.searchParams.set('city', sel.value);
    location.href = url.toString();
  });
  const infoEl = el('cityWardInfo');
  if (infoEl) infoEl.textContent = `${CITY_WARD_LABEL} / ${CITY_LOD_LABEL}`;
})();

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
//   ★ 左上パネルにボタンは置かない。親アプリ（01）下部バーの切り抜きスライダー
//     【だけ】が操作口になった（setEarthClipSize で送ってくる。単独で開いたときは
//     既定の 300m の箱庭表示のまま）。地形を切るかどうかも箱庭表示に含める
//     （建物だけ切って地形が残ると宙に浮いて見えるため）。
//   ★ 全体表示への切替も同じチャンネルに乗せてある：スライダーの箱サイズの上限
//     （CLIP_SIZE_MAX=500）を【超える】値が来たら「全体表示にして」の合図として扱う。
//     親側は 500m の目盛りより右へカクッと1段動かすとこの値を送ってくる
//     （01/src/main.js の setupApp1ClipSlider 参照）。
(function setupClipUI() {
  clipState.terrain = true;   // 箱庭表示では地形も一緒に切る（地盤ラインを出す）

  setClipSizeFromParent = (m) => {
    const v = Number(m);
    if (!Number.isFinite(v)) return;
    if (v > CLIP_SIZE_MAX) {
      clipState.enabled = false;   // 全体表示（切り抜きなし）
    } else {
      clipState.enabled = true;
      clipState.size = Math.min(CLIP_SIZE_MAX, Math.max(CLIP_SIZE_MIN, v));
    }
    markSectionDirty();
  };
  // 親が起動直後にこちらの現在値を尋ねてくる（スライダーの初期位置合わせ用）。
  //   全体表示中は「500mの先」を意味する値を返し、親側のスライダーもその一段先に
  //   置いてもらう（0 は「地球モードなし」で別の意味を持つので、混同を避けるため
  //   全体表示は必ず CLIP_SIZE_MAX 超の値で表す）。
  getClipSize = () => (clipState.enabled ? clipState.size : CLIP_SIZE_MAX + 50);
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
    // 拡大時の大きさ。ユーザーがつまみでドラッグして変えるまでは null（既定の自動サイズ）。
    expandedW: null, expandedH: null,
    // 拡大時の位置。ユーザーが案内行をつかんで動かすまでは null（既定は中央寄せ、
    // ただし断面パネルとは重ならない範囲に収める。render() 側で計算する）。
    expandedLeft: null, expandedTop: null,
  };

  // DOM 構築
  const wrap = document.createElement('div');
  wrap.id = 'pickerWrap';
  wrap.innerHTML = `
    <div id="pickerHint"></div>
    <div id="pickerTiles"></div>
    <canvas id="pickerMask"></canvas>
    <div id="pickerSection"><div class="grab"></div><div class="tag">断面</div></div>
    <div id="pickerCross"></div>
    <div id="pickerOrigin" title="自作モデル位置"></div>
    <div id="pickerBtns"></div>
    <div id="pickerResize" title="ドラッグでサイズ変更"></div>
    <div id="pickerResizeBL" title="ドラッグでサイズ変更"></div>`;
  document.body.appendChild(wrap);
  const tilesEl = wrap.querySelector('#pickerTiles');
  const resizeEl = wrap.querySelector('#pickerResize');
  const resizeBlEl = wrap.querySelector('#pickerResizeBL');
  const crossEl = wrap.querySelector('#pickerCross');
  const originEl = wrap.querySelector('#pickerOrigin');
  const hintEl = wrap.querySelector('#pickerHint');
  const btnsEl = wrap.querySelector('#pickerBtns');
  const sectionEl = wrap.querySelector('#pickerSection');
  const sectionGrab = sectionEl.querySelector('.grab');
  const maskEl = wrap.querySelector('#pickerMask');

  // ---- 市域のくりぬき --------------------------------------------------------
  //   選んでいる都市の市域だけを見せ、外側は暗い覆いを掛ける。
  //   ★ 地図タイルは <img> のままにして、覆いだけを1枚の canvas で重ねる方式にした。
  //     CSS の clip-path に数千点のポリゴンを毎フレーム流し込むより軽く、
  //     タイルの読み込み・差し替えの仕組みに一切手を入れずに済む。
  //   ★ 「塗ってから destination-out で市域を抜く」ので、市域の内側は素通し（＝元の地図）。
  let boundaryRings = null;   // [[ [lon,lat], ... ], ... ]（外環＋穴をまとめて持つ）
  if (CITY_BOUNDARY_URL) {
    fetch(CITY_BOUNDARY_URL)
      .then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then((j) => {
        const rings = [];
        for (const f of j.features || []) {
          for (const r of f.rings || []) rings.push(r);
          for (const h of f.holes || []) rings.push(h);
        }
        boundaryRings = rings;
        render();
      })
      .catch((e) => console.warn('市域の境界を読み込めませんでした:', e));
  }

  function drawMask(w, h, z, tlx, tly) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (maskEl.width !== Math.round(w * dpr) || maskEl.height !== Math.round(h * dpr)) {
      maskEl.width = Math.round(w * dpr);
      maskEl.height = Math.round(h * dpr);
    }
    maskEl.style.width = w + 'px';
    maskEl.style.height = h + 'px';
    const g = maskEl.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    if (!boundaryRings) return;

    const path = new Path2D();
    for (const ring of boundaryRings) {
      for (let i = 0; i < ring.length; i++) {
        const x = lonToWX(ring[i][0], z) - tlx, y = latToWY(ring[i][1], z) - tly;
        if (i === 0) path.moveTo(x, y); else path.lineTo(x, y);
      }
      path.closePath();
    }
    // 外側を暗くする → 市域を抜く（穴は evenodd で自動的に覆いが残る）
    g.fillStyle = `rgba(11,18,32,${BOUNDARY_DIM})`;
    g.fillRect(0, 0, w, h);
    g.globalCompositeOperation = 'destination-out';
    // ⚠️ destination-out で消える量は【そのとき塗る色のアルファ】で決まる。
    //   覆いの色（半透明）のまま fill すると、その割合しか抜けず市域が薄暗く残る
    //   （実測: 覆いのアルファ 184 が 51 にしか下がらなかった）。必ず不透明で抜くこと。
    g.fillStyle = '#000';
    g.fill(path, 'evenodd');
    g.globalCompositeOperation = 'source-over';
    // 市域の輪郭（どこが境界かを読めるように）
    g.strokeStyle = BOUNDARY_LINE_COLOR;
    g.lineWidth = 1.2;
    g.stroke(path);
  }

  const EXPANDED_MIN_W = 240, EXPANDED_MIN_H = 200;
  const EDGE_MARGIN = 8;   // 画面端から最低限あける余白（ドラッグ・自動配置とも共通）

  // 断面パネルの【上端】の画面y座標。非表示なら画面の下端（＝制約なし）を返す。
  //   ★ パネルの高さ（--profile-h）だけでなく、パネル自身の下端の余白（通常は
  //     bottom:12px、親アプリに埋め込み中は下部バーを避けて bottom:94px）も
  //     効いてくる。値をどこかに複製して持つより、実際のDOMを直接測った方が
  //     常に正しく、CSS 側の余白が変わっても追従できる。
  function profilePanelTopPx() {
    const panel = document.getElementById('profilePanel');
    if (!panel || getComputedStyle(panel).display === 'none') return window.innerHeight;
    return panel.getBoundingClientRect().top;
  }

  function size() {
    if (!map.expanded) return { w: 220, h: 160 };
    const maxW = window.innerWidth - EDGE_MARGIN * 2;
    const maxH = window.innerHeight - EDGE_MARGIN * 2;
    if (map.expandedW != null && map.expandedH != null) {
      return {
        w: Math.min(maxW, Math.max(EXPANDED_MIN_W, map.expandedW)),
        h: Math.min(maxH, Math.max(EXPANDED_MIN_H, map.expandedH)),
      };
    }
    // 既定（未調整）の大きさ。断面パネルを出しているときは、その上の空きに
    // 収まるところまで高さを削る（下端がパネルに掛からないように）。
    const availH = Math.max(EXPANDED_MIN_H, profilePanelTopPx() - EDGE_MARGIN * 2);
    const w = Math.min(window.innerWidth * 0.7, 720, maxW);
    const h = Math.min(window.innerHeight * 0.7, 560, availH);
    return { w, h };
  }

  // 拡大時の位置を決めて wrap に反映する。CSS の .expanded（中央寄せの right/bottom/
  // transform）は初回ペイント用のフォールバックに過ぎず、拡大中は常にここで
  // left/top を明示指定して上書きする（センタリングの計算とドラッグ後の位置を
  // 同じ土俵で扱えるようにするため）。
  function layoutExpanded(w, h) {
    let left, top;
    if (map.expandedLeft != null && map.expandedTop != null) {
      left = map.expandedLeft; top = map.expandedTop;
    } else {
      // 既定は画面中央。ただし断面パネルを出しているときは、その上の余白の中で
      // 中央に寄せる（＝下端がパネルに掛からない）。
      const bandTop = EDGE_MARGIN, bandBottom = profilePanelTopPx() - EDGE_MARGIN;
      left = (window.innerWidth - w) / 2;
      top = bandTop + Math.max(0, (bandBottom - bandTop - h) / 2);
    }
    // 手動でドラッグした位置・断面パネルの開閉やウィンドウのリサイズで前提が変わった
    // 場合も含めて、常に「画面の外にはみ出さない」ことだけは最後に強制する。
    left = Math.min(Math.max(left, EDGE_MARGIN), Math.max(EDGE_MARGIN, window.innerWidth - w - EDGE_MARGIN));
    top = Math.min(Math.max(top, EDGE_MARGIN), Math.max(EDGE_MARGIN, window.innerHeight - h - EDGE_MARGIN));
    wrap.style.left = left + 'px';
    wrap.style.top = top + 'px';
    wrap.style.right = 'auto';
    wrap.style.bottom = 'auto';
    wrap.style.transform = 'none';
  }

  // 指定した緯度経度(度)を地図中心に、タイルを敷き詰めて描画する。
  function render() {
    const { w, h } = size();
    wrap.classList.toggle('expanded', map.expanded);
    wrap.style.width = w + 'px'; wrap.style.height = h + 'px';
    if (map.expanded) layoutExpanded(w, h);
    else { wrap.style.left = ''; wrap.style.top = ''; wrap.style.right = ''; wrap.style.bottom = ''; wrap.style.transform = ''; }
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
    drawMask(w, h, z, tlx, tly);   // 市域だけを見せる覆い（タイルの上・断面線の下）
    // 中心の十字（＝現在の注目地点）と、原点マーカー
    crossEl.style.left = (w / 2) + 'px'; crossEl.style.top = (h / 2) + 'px';
    originEl.style.left = (originWX - tlx) + 'px'; originEl.style.top = (originWY - tly) + 'px';
    // ---- 断面線のキープラン（どこを切っているかを地図上に示す）----
    //   東西の直線なので、緯度だけで縦位置が決まる。左右の端は断面の実際の東西端に合わせる
    //   （＝地図をパンすると線の長さが変わり、20km の範囲がそのまま読める）。
    sectionEl.classList.toggle('on', profileState.enabled);
    if (profileState.enabled) {
      sectionEl.style.top = (latToWY(profileState.latDeg, z) - tly) + 'px';
      const [lonW, lonE] = profileLonRange();
      const lx = lonToWX(lonW, z) - tlx, rx = lonToWX(lonE, z) - tlx;
      sectionEl.style.left = lx + 'px';
      sectionEl.style.right = (w - rx) + 'px';
    }
    hintEl.textContent = map.expanded
      ? '地図をクリック→建物を移動／ドラッグ→表示範囲移動／ホイール→拡縮（この行をドラッグ→ウィンドウ移動）'
      : '地図（クリックで拡大）';
    // ウィンドウ移動のドラッグハンドルは【拡大表示のときだけ】有効にする。
    //   小窓のときは案内文どおり「クリックで拡大」に使いたいので、この行を
    //   ドラッグ対象にすると誤ってクリックを吸ってしまい拡大できなくなる。
    hintEl.style.pointerEvents = map.expanded ? 'auto' : 'none';
    hintEl.style.cursor = map.expanded ? 'move' : '';
    btnsEl.style.display = map.expanded ? 'flex' : 'none';
  }
  // 断面パネルの開閉に合わせてキープランも出し入れする
  setEnabledChangeHandler(() => render());

  // ピクセル(要素内)→ 緯度経度
  function pxToLatLon(px, py) {
    const { w, h } = size(), z = map.zoom;
    const wx = lonToWX(map.centerLon, z) - w / 2 + px;
    const wy = latToWY(map.centerLat, z) - h / 2 + py;
    return { lat: wyToLat(wy, z), lon: wxToLon(wx, z) };
  }

  // --- 操作 ---
  let dragging = false, moved = false, lastX = 0, lastY = 0;
  // 断面線を掴んでいるか。掴んでいる間は地図のパンをせず、線の緯度だけを動かす。
  let draggingSection = false;
  // ★ 断面線を掴んだドラッグの直後は【クリック扱いさせない】。
  //   pointerup の後に click が飛ぶので、抑止しないと「線を動かしただけ」なのに
  //   その地点へ注目地点まで移動してしまう（＝街並みが読み直される）。
  let suppressClick = false;

  // ---- ウィンドウ自体の位置移動（上部の案内行＝#pickerHint をつかんでドラッグ）------
  //   断面パネルを出しているときなど、拡大した地図が既定の中央位置だと邪魔になる場面が
  //   あるための機能。★ 拡大表示のときだけ有効（理由は render() 側のコメント参照）。
  //   位置は wrap の style.left/top で持つ。CSS の .expanded は right/bottom/transform で
  //   中央寄せしているが、インラインスタイルの方が優先されるので、一度ドラッグすれば
  //   以降は「動かした位置」が小窓⇄拡大の切り替えをまたいで保持される。
  let draggingWindow = false;
  let winStartMouseX = 0, winStartMouseY = 0, winStartLeft = 0, winStartTop = 0;

  // ---- 拡大時のサイズ変更（右下・左下のつまみをドラッグ）------------------------
  //   ★ どちらの角も「反対側の角は動かさない」のが自然な挙動。位置がまだ既定（中央寄せ、
  //     expandedLeft/Top が null）のままリサイズを始めると、サイズが変わるたびに
  //     layoutExpanded の中央寄せ計算が効いて反対側の角まで動いてしまう。
  //     それを防ぐため、ドラッグ開始時に【今の実際の位置】を expandedLeft/Top へ
  //     固定してから幅・高さだけを動かす。
  let resizing = null;   // 'br' | 'bl' | null
  let rzStartX = 0, rzStartY = 0, rzStartW = 0, rzStartH = 0, rzStartLeft = 0, rzStartRight = 0;
  function beginResize(corner, e, el) {
    resizing = corner;
    suppressClick = true;
    const r = wrap.getBoundingClientRect();
    rzStartX = e.clientX; rzStartY = e.clientY;
    rzStartW = r.width; rzStartH = r.height;
    rzStartLeft = r.left; rzStartRight = r.left + r.width;
    map.expandedTop = r.top;   // 上端は両方の角で共通に固定
    if (corner === 'br') map.expandedLeft = r.left;   // 右下: 左端を固定
    e.stopPropagation();
    try { el.setPointerCapture(e.pointerId); } catch (err) { /* 無視 */ }
  }
  resizeEl.addEventListener('pointerdown', (e) => beginResize('br', e, resizeEl));
  resizeEl.addEventListener('pointermove', (e) => {
    if (resizing !== 'br') return;
    map.expandedW = rzStartW + (e.clientX - rzStartX);
    map.expandedH = rzStartH + (e.clientY - rzStartY);
    render();
  });
  resizeEl.addEventListener('pointerup', () => { if (resizing === 'br') resizing = null; });

  resizeBlEl.addEventListener('pointerdown', (e) => beginResize('bl', e, resizeBlEl));
  resizeBlEl.addEventListener('pointermove', (e) => {
    if (resizing !== 'bl') return;
    // 左下をドラッグ＝右端は固定したまま、左へ引っ張るほど幅が増える。
    const newW = Math.max(EXPANDED_MIN_W, rzStartW - (e.clientX - rzStartX));
    map.expandedW = newW;
    map.expandedH = rzStartH + (e.clientY - rzStartY);
    map.expandedLeft = rzStartRight - newW;
    render();
  });
  resizeBlEl.addEventListener('pointerup', () => { if (resizing === 'bl') resizing = null; });
  hintEl.addEventListener('pointerdown', (e) => {
    if (!map.expanded) return;
    draggingWindow = true;
    suppressClick = true;
    const r = wrap.getBoundingClientRect();
    winStartLeft = r.left; winStartTop = r.top;
    winStartMouseX = e.clientX; winStartMouseY = e.clientY;
    e.stopPropagation();   // 地図のパン（wrap の pointerdown）を始めさせない
    try { wrap.setPointerCapture(e.pointerId); } catch (err) { /* 無視 */ }
  });

  sectionGrab.addEventListener('pointerdown', (e) => {
    if (!map.expanded) return;
    draggingSection = true;
    suppressClick = true;
    e.stopPropagation();          // 地図のパンを始めさせない
    // ポインタが既に離れている等で InvalidPointerId になることがある。
    // 捕捉できなくてもドラッグ自体は成立する（wrap 上で pointermove を拾う）ので握りつぶす。
    try { wrap.setPointerCapture(e.pointerId); } catch (err) { /* 無視 */ }
  });
  wrap.addEventListener('pointerdown', (e) => {
    if (e.target.closest('#pickerBtns')) return;
    if (draggingSection) return;
    if (!map.expanded) return; // 小窓時はクリックで拡大（下の click で処理）
    dragging = true; moved = false; lastX = e.clientX; lastY = e.clientY;
    wrap.setPointerCapture(e.pointerId);
  });
  wrap.addEventListener('pointermove', (e) => {
    if (draggingWindow) {
      const dx = e.clientX - winStartMouseX, dy = e.clientY - winStartMouseY;
      // ここでは希望位置をそのまま覚えるだけ。画面外に出さないクランプは
      // layoutExpanded 側で一括して行う（ドラッグ中も自動配置時も同じ規則にするため）。
      map.expandedLeft = winStartLeft + dx;
      map.expandedTop = winStartTop + dy;
      render();
      return;
    }
    if (draggingSection) {
      // 掴んだ位置の緯度をそのまま断面線の緯度にする（上下ドラッグで断面が移動）
      const r = wrap.getBoundingClientRect();
      const { lat } = pxToLatLon(e.clientX - r.left, e.clientY - r.top);
      setSectionLat(lat);
      render();
      return;
    }
    if (!dragging) return;
    const dx = e.clientX - lastX, dy = e.clientY - lastY;
    if (Math.abs(dx) + Math.abs(dy) > 3) moved = true;
    lastX = e.clientX; lastY = e.clientY;
    const z = map.zoom;
    map.centerLon = wxToLon(lonToWX(map.centerLon, z) - dx, z);
    map.centerLat = wyToLat(latToWY(map.centerLat, z) - dy, z);
    render();
  });
  wrap.addEventListener('pointerup', () => { dragging = false; draggingSection = false; draggingWindow = false; });
  wrap.addEventListener('click', (e) => {
    if (e.target.closest('#pickerBtns')) return;
    if (suppressClick) { suppressClick = false; return; }  // 断面線を動かしただけ
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
  btnsEl.appendChild(mkBtn('閉じる', () => {
    map.expanded = false;
    // ドラッグで動かしていた位置・大きさをリセットし、小窓を既定の右下へ戻す
    // （次に拡大したときは常に画面中央・既定サイズから始まるようにする＝毎回探さずに済む）。
    map.expandedW = null; map.expandedH = null;
    map.expandedLeft = null; map.expandedTop = null;
    render();
  }));

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
