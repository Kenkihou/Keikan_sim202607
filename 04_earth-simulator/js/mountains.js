// =============================================================================
// mountains — 京都市内の山名を、山頂のあたりに浮かべて表示する。
//
//   元データ: mountain.geojson（OpenStreetMap の natural=peak を書き出したもの）。
//     228地点／名前あり185／名前と標高(ele)の両方あり166。
//
//   ★ 高さは【データの ele をそのまま使う】。PLATEAU の地形は山頂を丸めてしまうので、
//     実際の山頂標高を持っているこのデータの方が「頂上」に合う。
//     ele が無い地点だけ、読み込み済みの地形から高さを拾って補う
//     （拾えるまでは出さず、地形が増えたら拾い直す＝自作モデルの接地と同じ作法）。
//
//   ★ ラベルは【常にカメラを向く・画面上の大きさが一定】のスプライトにする。
//     山は遠いので、遠近で縮むと読めなくなるため（sizeAttenuation: false）。
//     奥行きの判定は有効にしてあるので、手前の山に隠れる山名は自然に見えなくなる。
// =============================================================================
import { THREE, scene, el, focusLocal, camera, renderer } from './core.js';
import {
  MOUNTAIN_URL, MOUNTAIN_LABEL_LIFT, MOUNTAIN_LABEL_SCREEN, MOUNTAIN_MAX_DIST,
  MOUNTAIN_VISIBLE_DIST, MOUNTAIN_SHOW_ELEVATION,
  MOUNTAIN_GRID_CELL, MOUNTAIN_GRID_MARGIN, MOUNTAIN_TERRAIN_TOL, SEA_LEVEL_Y,
} from './config.js';
import { lonLatToLocal, buildTerrainHeightGrid, sampleGrid } from './viewareas.js';
import { clipState } from './section.js';

const mountainGroup = new THREE.Group();
mountainGroup.name = 'mountain-labels';
scene.add(mountainGroup);

const mountainState = {
  enabled: true,
  loaded: false,
  error: null,
  peaks: [],      // { name, ele, x, z, y, sprite }（y は決まるまで NaN）
  ready: 0,       // ラベルを用意できた山の数
  shown: -1,      // いま描いている数（カメラが近い山だけ。-1 は未計算）
  pending: 0,     // 地形待ち（ele が無くて高さを拾えていない）
};

// =========================================================================
// ラベルの絵（キャンバス→テクスチャ）
//   空にも山肌にも重なるので、白フチ＋黒文字で読めるようにする（断面の標高ラベルと同じ手）。
// =========================================================================
const PAD = 12, NAME_PX = 44, ELE_PX = 28, TEXT_GAP = 10;
// ★ ラベルは【1行】にする。山名の下に標高を置く2行組みだと、
//   下の行が地形に埋まって読めないことがあった（山の斜面に食い込む）。
//   1行なので全ラベルのキャンバス高さが揃い、文字の大きさも自動的に揃う。
//   山名と標高の【文字サイズの差】（44px / 28px）はそのまま残す。
const BASE_CANVAS_H = PAD * 2 + NAME_PX;

function makeLabelTexture(name, eleText) {
  const cvs = document.createElement('canvas');
  const ctx = cvs.getContext('2d');

  // 先に文字幅を測ってからキャンバスの大きさを決める（余白が間延びしないように）
  ctx.font = `bold ${NAME_PX}px system-ui, sans-serif`;
  const nameW = ctx.measureText(name).width;
  ctx.font = `${ELE_PX}px system-ui, sans-serif`;
  const eleW = eleText ? ctx.measureText(eleText).width : 0;
  const gap = eleText ? TEXT_GAP : 0;

  cvs.width = Math.ceil(nameW + gap + eleW) + PAD * 2;
  cvs.height = BASE_CANVAS_H;

  // 左から「山名」「標高」を横に並べる。上下は中央に揃える。
  const midY = cvs.height / 2;
  const draw = (text, px, bold, x, fill) => {
    ctx.font = `${bold ? 'bold ' : ''}${px}px system-ui, sans-serif`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = Math.max(4, px * 0.18);
    ctx.strokeStyle = 'rgba(255,255,255,0.95)';
    ctx.strokeText(text, x, midY);
    ctx.fillStyle = fill;
    ctx.fillText(text, x, midY);
  };

  draw(name, NAME_PX, true, PAD, '#151a24');
  if (eleText) draw(eleText, ELE_PX, false, PAD + nameW + gap, '#3d4657');

  const tex = new THREE.CanvasTexture(cvs);
  tex.colorSpace = THREE.SRGBColorSpace;

  // ⚠️⚠️ ここで【今すぐ】GPU へ送っておくこと。放っておくと three は「最初に描く
  //   ときに」送るが、その瞬間の WebGL の状態しだいで【上下逆さまに焼き付く】。
  //
  //   仕組み: キャンバスは左上原点、WebGL のテクスチャは左下原点なので、three は
  //   アップロード時に gl.pixelStorei(UNPACK_FLIP_Y_WEBGL, true) を掛けて上下を
  //   合わせている。ところがこの設定は【WebGLコンテキスト全体の共有状態】で、
  //   three は「前回設定した値」を自分でキャッシュし、同じなら pixelStorei を
  //   省略する。そのため、three 以外の描画（点群の Spark や 3D Tiles など）が
  //   この値を false にしたまま返すと、three は気づかずに省略し、
  //   そのとき送られたテクスチャだけが上下反転で焼き付く。
  //
  //   ★ 症状の特徴（実測で確認）:
  //     ・反転するのは【一部のラベルだけ】。どれが当たるかは読み込みのたびに変わる
  //       （送られる瞬間に他所が状態を寝かせていたかどうかの運）。
  //     ・カメラを動かしても直らない。テクスチャに焼き付いているため。
  //     ・needsUpdate で送り直すと直る。
  //   ★ 機序の確定実験: 外から gl.pixelStorei(UNPACK_FLIP_Y_WEBGL, false) を実行して
  //     1枚だけ送り直したところ、そのラベルだけが上下反転し、他は無傷だった。
  //     さらに描画後も値が false のままで、three が pixelStorei を省いたことも確認した。
  //
  //   直し方: resetState() で「three が覚えている状態」を捨てさせ（次の設定を必ず
  //   実行させ）、initTexture() でこの場で送る。キャンバスは以後変化しないので、
  //   一度正しく送れば二度と反転しない。
  renderer.resetState();
  renderer.initTexture(tex);
  return tex;
}

function makeLabelSprite(peak) {
  const eleText = (MOUNTAIN_SHOW_ELEVATION && Number.isFinite(peak.ele))
    ? `${Math.round(peak.ele)}m` : '';
  const tex = makeLabelTexture(peak.name, eleText);
  const mat = new THREE.SpriteMaterial({
    map: tex,
    transparent: true,
    depthTest: true,    // 手前の山に隠れる山名は見えなくなる（そのほうが位置関係が分かる）
    fog: false,         // 遠くの山名が霧に溶けて読めなくなるのを防ぐ
  });
  const sprite = new THREE.Sprite(mat);
  // sizeAttenuation は既定 true なので明示的に切る（＝画面上の大きさを一定にする）
  mat.sizeAttenuation = false;
  // ★ キャンバス1pxあたりの画面上の大きさを固定する。こうすると
  //   1行（山名だけ）でも2行（山名＋標高）でも山名の文字が同じ大きさになる。
  const pxToScreen = MOUNTAIN_LABEL_SCREEN / BASE_CANVAS_H;
  sprite.scale.set(tex.image.width * pxToScreen, tex.image.height * pxToScreen, 1);
  sprite.renderOrder = 10;
  return sprite;
}

// =========================================================================
// 読み込み
// =========================================================================
async function loadMountains() {
  if (!MOUNTAIN_URL) return; // 京都市以外は対象データが無い
  try {
    const res = await fetch(MOUNTAIN_URL);
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    const gj = await res.json();
    for (const f of gj.features || []) {
      const p = f.properties || {};
      const g = f.geometry || {};
      if (!p.name || g.type !== 'Point' || !Array.isArray(g.coordinates)) continue;
      const [lon, lat] = g.coordinates;
      const [x, z] = lonLatToLocal(lon, lat);   // 戻りは [x, z]（+X=西 / +Z=北）
      const ele = p.ele !== undefined ? parseFloat(p.ele) : NaN;
      mountainState.peaks.push({
        name: p.name,
        ele,
        x, z,
        // 標高が分かっていれば即座に高さが決まる（ローカルYは 標高 + SEA_LEVEL_Y）
        y: Number.isFinite(ele) ? ele + SEA_LEVEL_Y : NaN,
        sprite: null,
      });
    }
    mountainState.loaded = true;
    buildMountains();
  } catch (e) {
    mountainState.error = String(e.message || e);
    console.warn('山名データを読み込めませんでした:', e);
  }
}

// =========================================================================
// 配置
//   ★ ラベルは【描かれている地形の面の少し上】に置く。そのために毎回、注目地点まわりの
//     高さグリッドを1枚だけ作って全山の高さを引く（山ごとに作ると重い）。
//   ★ 地形は後から細かくなるので、一度置いて終わりにはしない（毎回引き直す）。
//     起動直後の粗い地形は盆地と山を1枚の三角形でまたぐので、そこで拾った高さのまま
//     固定すると【ラベルが空中に浮いたまま直らない】（実際にそうなっていた）。
//   ★ 粗い地形の値は当てにならないので、標高データがある山では
//     食い違いが MOUNTAIN_TERRAIN_TOL を超えたらデータの標高を採る。
// =========================================================================
function buildMountains() {
  if (!mountainState.loaded) return;
  mountainGroup.visible = mountainState.enabled;

  // 見える範囲＋カメラが動ける余裕のぶんだけを覆うグリッド（1枚だけ作って使い回す）
  const gridRadius = MOUNTAIN_VISIBLE_DIST + MOUNTAIN_GRID_MARGIN;
  const grid = buildTerrainHeightGrid(
    focusLocal.x, focusLocal.z, gridRadius, MOUNTAIN_GRID_CELL);

  let shown = 0, pending = 0;
  for (const peak of mountainState.peaks) {
    // 遠すぎるものは出さない（注目地点から MOUNTAIN_MAX_DIST 以内）
    const far = Math.hypot(peak.x - focusLocal.x, peak.z - focusLocal.z) > MOUNTAIN_MAX_DIST;

    if (!far) {
      const eleY = Number.isFinite(peak.ele) ? peak.ele + SEA_LEVEL_Y : NaN;
      const groundY = sampleGrid(grid, peak.x, peak.z);
      if (Number.isFinite(groundY) &&
          (!Number.isFinite(eleY) || Math.abs(groundY - eleY) <= MOUNTAIN_TERRAIN_TOL)) {
        peak.y = groundY;          // 地形が引けた＝その面の少し上に置く
      } else if (Number.isFinite(eleY)) {
        peak.y = eleY;             // 地形が無い／粗くて信用できない＝データの標高で置く
      }
    }

    const ready = !far && Number.isFinite(peak.y);
    if (ready && !peak.sprite) {
      peak.sprite = makeLabelSprite(peak);
      mountainGroup.add(peak.sprite);
    }
    if (peak.sprite) {
      peak.sprite.position.set(peak.x, peak.y + MOUNTAIN_LABEL_LIFT, peak.z);
      peak.sprite.visible = false;   // 実際に出すかは毎フレームのカメラ距離で決める
    }
    if (ready) shown++;
    else if (!far) pending++;
  }
  mountainState.ready = shown;
  mountainState.pending = pending;
  updateMountainVisibility();
}

// =========================================================================
// カメラが近づいた山名だけを描く（毎フレーム）
//   遠くの山名まで出すと地平線に文字が積み重なって読めなくなる。
//   文字の大きさは距離によらず一定なので、近づいた山だけが出れば十分に読める。
//   ※ スプライトの位置は動かないので、距離の比較だけで済む（確保も計算も軽い）。
//
//   ★ 箱庭表示（clipState.enabled）のときは【切り抜き箱の外の山名は出さない】。
//     建物や地形が箱の外は消えているのに山名だけ地平線の外から見えるのは不自然なため。
//     箱は注目地点(focusLocal)を中心とした一辺 clipState.size の正方形（水平方向のみ）。
//
//   ⚠️ 距離だけで判定してはいけない。【カメラの後ろにある山も必ず外すこと】。
//     後ろの山名は「見えないはず」ではなく【左右反転した文字】として画面に描かれる。
//     理由は three.js のスプライトの実装にある。sizeAttenuation=false のとき
//     頂点シェーダは画面上の大きさを一定に保つために
//         scale *= -mvPosition.z
//     を掛けるが、カメラの後ろでは mvPosition.z が正なので【スケールが負】になる。
//     負のスケールは板を裏返すので、文字が鏡像になったまま、しかも後ろの点が
//     画面の反対側へ写るため「もっともらしい位置と大きさ」で出てしまう。
//     （実測: 市街を俯瞰した構図で、表示20件のうち6件がカメラ背面にあり反転していた）
// =========================================================================
const _camFwd = new THREE.Vector3();
function updateMountainVisibility() {
  if (!mountainState.loaded) return;
  mountainGroup.visible = mountainState.enabled;
  if (!mountainState.enabled) {
    mountainState.shown = 0;
    return;
  }
  const cx = camera.position.x, cy = camera.position.y, cz = camera.position.z;
  const maxSq = MOUNTAIN_VISIBLE_DIST * MOUNTAIN_VISIBLE_DIST;
  camera.getWorldDirection(_camFwd);   // 前後の判定用（上のコメントを参照）
  const boxed = clipState.enabled;
  const half = clipState.size / 2;
  const bx0 = focusLocal.x - half, bx1 = focusLocal.x + half;
  const bz0 = focusLocal.z - half, bz1 = focusLocal.z + half;
  let shown = 0;
  for (const peak of mountainState.peaks) {
    const s = peak.sprite;
    if (!s) continue;
    if (boxed && (s.position.x < bx0 || s.position.x > bx1 ||
                  s.position.z < bz0 || s.position.z > bz1)) {
      s.visible = false;
      continue;
    }
    const dx = s.position.x - cx, dy = s.position.y - cy, dz = s.position.z - cz;
    // カメラの向きとの内積が正＝前方。後ろの山は反転文字になるので必ず外す。
    const inFront = dx * _camFwd.x + dy * _camFwd.y + dz * _camFwd.z > 0;
    const near = inFront && dx * dx + dy * dy + dz * dz <= maxSq;
    s.visible = near;
    if (near) shown++;
  }
  mountainState.shown = shown;   // 件数は __dbg での確認用に持っておく（HUDには出さない）
}

// =========================================================================
// HUD（表示するかどうかのチェックだけ。件数などは出さない）
// =========================================================================
(function setupMountainUI() {
  const cb = el('mountainOn');
  if (!cb) return;
  if (!MOUNTAIN_URL) { // 京都市以外は対象データが無いので行ごと隠す
    mountainState.enabled = false;
    const label = cb.closest('label');
    if (label) label.style.display = 'none';
    return;
  }
  cb.checked = mountainState.enabled;
  cb.addEventListener('change', () => {
    mountainState.enabled = cb.checked;
    updateMountainVisibility();
  });
})();

loadMountains();

export { mountainGroup, mountainState, buildMountains, updateMountainVisibility };
