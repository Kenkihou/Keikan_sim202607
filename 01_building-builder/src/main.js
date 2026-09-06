// main.js
import * as THREE from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { ModelingEngine, sashMat, windowGlassMat } from './modelingEngine.js';
// ★追加：DXF の平面図から起こした階。平面の形は図面が決め、高さだけ 3D で決める。
import { buildDxfFloor, buildSlabWithHole, dxfWindows } from './dxf/dxfEngine.js';
import { freeRidge, freeRidges, freeRoofFlat, freeRoofWallDrop, freeNotch, freeSlopeHandles,
    freeEaveBars, freeRoofOwner, OUT_DIR } from './roof/roofMesh.js';
import { geyaBars, geyaSlopeHandle, GEYA_OUT_DIR } from './roof/geya.js';
import { paraParts, PARA_OUT_DIR } from './roof/para.js';

/* いま選んでいる、パラペット修景屋根の階。上面を選んでいるときだけ。 */
function selectedPara() {
    const b = AppState.buildingData.find(d => d.id === AppState.selectedId);
    if (!b || AppState.selectedFaceDir !== 'top') return null;
    return (b.roof && b.roof.type === 'パラペット修景') ? b : null;
}

/* いま選んでいる、下屋を持つ階。上面を選んでいるときだけ。 */
function selectedGeya() {
    const b = AppState.buildingData.find(d => d.id === AppState.selectedId);
    if (!b || AppState.selectedFaceDir !== 'top') return null;
    return b.lowerRoof ? b : null;
}

/* いま選んでいる階に掛かっている大屋根の【持ち主】。
   ★ L字は直方体を並べて作る。屋根はそのうち1つが持っているので、どちらを
     選んでも同じ屋根のつまみが出るように、持ち主へ読み替える。 */
function selectedRoofOwner() {
    const b = AppState.buildingData.find(d => d.id === AppState.selectedId);
    if (!b || AppState.selectedFaceDir !== 'top') return null;
    return freeRoofOwner(b);
}
import { askDxfFloor } from './dxf/index.js';
// ★追加：外のファイルとのやりとり（取り込み／書き出し）。
import { askModelImport, modelObject, dropModel, dropAllModels, rescaleModel,
    modelsPending } from './io/modelIo.js';
import { openIoMenu } from './io/ioMenu.js';
import { freezeSkinned } from './io/bakeSkin.js';
import { SubCam, markTool } from './subcam.js';
import { AppState } from './appState.js';
import { UIController } from './uiController.js';
import { InteractionHandler } from './interactionHandler.js';
import { ViewManager } from './viewManager.js';
import { AppInit } from './init.js';
import { TutorialManager } from './tutorialManager.js';
import { setOnTextureAssetsReady, SUGI_BOARD_WIDTH_M, SUGI_BOARD_HEIGHT_M } from './materialTextureFactory.js';
import { setupEarthPrefetchTriggers } from './earthPrefetch.js';
// ★追加：外構作図モード（tree/planner.html から移植した地面・囲い・外構・樹木の作図機能）
import { initExterior, toggleExterior, exitExterior, isExteriorActive,
         applyGhost as applyExteriorGhost, serializeExterior, restoreExterior,
         clearExterior, exteriorWorld,
         nameExteriorMaterials, mergeExteriorColors, restoreExteriorColors,
         getExteriorColors, EXT_MAT_PREFIX } from './exterior/index.js';

// --- UI・操作状態（画面固有のもの） ---
let interactiveMeshes = [];
let meshMap = {};
// ★追加：選んでいる面に出す「つまみ」。
//   ★ 押し引きは【面が引ける】と知っている人しか使えない。掴めるものが目に
//     見えていれば説明が要らない。つまみと面のどちらを引いても結果は同じ。
//   ⚠️ つまみは【選んでいる面だけ】に出す。全部の面に出すと、どれを掴んで
//     いるのか分からなくなる。
let pullHandles = [];
// ★ 矢印は【濃い赤】。選んでいる面のピンクと明るさで離しておく。
//   ⚠️ 面と近い色にすると、面の一部なのか操作の印なのかが分からなくなる。
const pullHandleMat = new THREE.MeshBasicMaterial({
    color: 0xb0121a, depthTest: false,
});
// ★追加：棟の端のつまみ。押し引きの青とは色も形も分ける。
//   ⚠️ 同じ見た目にすると「どちらに動くのか」が分からなくなる。
const ridgeHandleMat = new THREE.MeshBasicMaterial({
    color: 0xf0ad4e, depthTest: false, transparent: true, opacity: 0.95,
});
// ★追加：押される面をあらわす板と、その輪郭。
//   ⚠️ 面そのものと同じ色にしない。どこまでが建物で、どこからが操作の印なのかが
//     分からなくなる。板は薄く透かして、輪郭で厚みを見せる。
// ⚠️ 透かさない。透けると線だけが見えて、板ではなく針金の枠に見える。
const pullFaceMat = new THREE.MeshBasicMaterial({
    color: 0x9fd4f2, depthTest: false, side: THREE.DoubleSide,
});
const pullEdgeMat = new THREE.LineBasicMaterial({
    color: 0x0b5f96, depthTest: false, transparent: true, opacity: 0.9,
});
// ★追加：屋根の切り欠きのつまみ。屋根の形を変えるつまみとは役目が違う。
const notchHandleMat = new THREE.MeshBasicMaterial({
    color: 0x00a8a8, depthTest: false,
});
// ★追加：屋上の平場をつくるつまみ。棟の球と役目が違うので色も形も分ける。
const flatHandleMat = new THREE.MeshBasicMaterial({
    color: 0x2fae62, depthTest: false, side: THREE.DoubleSide,
});
// ★追加：勾配のつまみ。勾配屋根の【面ごと】に、その重心へ勾配定規を立てる。
//   ★ 触った面がそのまま起き上がる／寝るので、どの面の勾配かで迷わない。
//   ⚠️ これだけは深度を見る（depthTest: true）。屋根の裏側に回った面の定規まで
//     透けて見えると、どれが手前の面のものか分からなくなる。隠れたら消す。
const slopeHandleMat = new THREE.MeshBasicMaterial({
    color: 0xd21f2a, side: THREE.DoubleSide, transparent: true, opacity: 0.85,
});
const slopeEdgeMat = new THREE.LineBasicMaterial({ color: 0x7a0d14 });

// ★追加：描かない面。自由屋根を載せた階の上面に使う。
//   ★ 屋上（平場）は屋根の側が【直方体の上面とちょうど同じ高さ】に張る。
//     二重に張ると深度が拮抗して、屋上いっぱいに縞模様が出る。
//   ⚠️ 消すのは【描画だけ】。当たり判定には残す（上面を選んで押し引きする）。
// ★追加：取り込んだモデルがまだ読めていないあいだ、場所だけ示す箱。
const ghostModelMat = new THREE.MeshBasicMaterial({
    color: 0x7f8c99, transparent: true, opacity: 0.25,
});
const hiddenFaceMat = new THREE.MeshBasicMaterial({
    colorWrite: false, depthWrite: false,
});
// ★追加：軒先のバー。他のつまみと同じく出しっぱなしにする。
//   ⚠️ これも深度を見る（depthTest: true）。屋根の裏に回った辺のバーまで透けると、
//     どれが手前の辺のものか分からなくなる。隠れたら消す。
const eaveBarMat = new THREE.MeshBasicMaterial({
    color: 0xffd21e, side: THREE.DoubleSide, transparent: true, opacity: 0.9,
});

/* 軒先のバー。辺ごとに1本、屋根面の上へ薄く敷く。
   ★ 掴んで引くと、その辺の軒の出・けらばの出が変わる。 */
function buildEaveBars(b, baseY) {
    const W = 260;                       // 帯の幅[mm]
    const LIFT = 60;                     // 屋根に食われないよう浮かせる[mm]
    const out = [];
    for (const e of freeEaveBars(b)) {
        const [dx, dz] = OUT_DIR[e.key];
        const ix = -dx * W, iz = -dz * W;   // 内側（棟の側）へ
        const ya = baseY + e.y + LIFT;
        const yb = baseY + e.y + e.slope * W + LIFT;
        const p = [];
        const push = (q, y, o) => p.push(b.x + q.x + (o ? ix : 0), y,
            b.z + q.z + (o ? iz : 0));
        push(e.a, ya, 0); push(e.b, ya, 0); push(e.b, yb, 1);
        push(e.a, ya, 0); push(e.b, yb, 1); push(e.a, yb, 1);
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
        const m = new THREE.Mesh(geo, eaveBarMat);
        m.userData = { id: b.id, ri: e.ri, eaveEdge: e.key, out: e.out };
        out.push(m);
    }
    return out;
}

// ==========================================
// 1. 環境の初期セットアップ (init.jsへ委譲)
// ==========================================
const { scene, camera, renderer, controls, materials, hoverMesh, houseGroup } = AppInit.run();
const { wallMat, activeMat, selectedMat, roofMat, edgeMat } = materials;
// ★追加：杉板調の目地線専用マテリアル（共有インスタンス、edgeMatと同様に使い回す）
const sugiJointMat = new THREE.LineBasicMaterial({ color: 0x2a2018 });

// ==========================================
// 2. UI・履歴・ステータスの連携
// ==========================================
function saveState() {
    AppState.saveState();
    UIController.updateActionButtons();
}

function undo() {
    if (AppState.undo()) {
        UIController.clearGUI();
        rebuildMeshes();
        UIController.updateActionButtons();
        UIController.updateStatusDisplay(InteractionHandler.getCurrentTool());
    }
}

function redo() {
    if (AppState.redo()) {
        UIController.clearGUI();
        rebuildMeshes();
        UIController.updateActionButtons();
        UIController.updateStatusDisplay(InteractionHandler.getCurrentTool());
    }
}

// ==========================================================================
// ★追加：壁材質が「杉板調」のとき、板1枚分の実寸幅ごとに目地線を描く。
// テクスチャに焼き込んだ線は縮小表示で潰れて見えなくなるため、
// このアプリの黒い輪郭線と同じ「線分ジオメトリ」として描画することで、
// どの距離・繰り返し数でもクッキリ見えるようにする。
// ==========================================================================
function buildWallJointLines(b, baseY) {
    const group = new THREE.Group();
    if (!b.materialTextures || b.materialTextures.wall !== 'sugi') return group;

    const boardWidthMM = SUGI_BOARD_WIDTH_M * 1000;   // 0.2m -> 200mm
    const boardHeightMM = SUGI_BOARD_HEIGHT_M * 1000; // 2.0m -> 2000mm
    const w2 = b.w / 2, d2 = b.d / 2;
    const yBot = baseY, yTop = baseY + b.h;
    const positions = [];

    // faceLength: 対象面の幅(mm)、toWorld: 面内オフセット(mm)からブロック中心基準の(x,z)を返す関数
    const addVerticalJoints = (faceLength, toWorld) => {
        const boardCount = Math.max(1, Math.round(faceLength / boardWidthMM));
        const actualWidth = faceLength / boardCount;
        for (let i = 1; i < boardCount; i++) {
            const offset = -faceLength / 2 + i * actualWidth;
            const { x, z } = toWorld(offset);
            positions.push(b.x + x, yBot, b.z + z, b.x + x, yTop, b.z + z);
        }
    };

    // ★追加：板の高さ(2mごと)に対応する横方向の目地線
    const addHorizontalJoints = (faceLength, toWorld) => {
        const rowCount = Math.max(1, Math.round(b.h / boardHeightMM));
        const actualHeight = b.h / rowCount;
        for (let i = 1; i < rowCount; i++) {
            const y = yBot + i * actualHeight;
            const start = toWorld(-faceLength / 2);
            const end = toWorld(faceLength / 2);
            positions.push(b.x + start.x, y, b.z + start.z, b.x + end.x, y, b.z + end.z);
        }
    };

    // pz(手前)・nz(奥)：X方向に沿って板が並ぶ
    addVerticalJoints(b.w, (off) => ({ x: off, z: d2 }));
    addVerticalJoints(b.w, (off) => ({ x: off, z: -d2 }));
    // px(右)・nx(左)：Z方向に沿って板が並ぶ
    addVerticalJoints(b.d, (off) => ({ x: w2, z: off }));
    addVerticalJoints(b.d, (off) => ({ x: -w2, z: off }));

    addHorizontalJoints(b.w, (off) => ({ x: off, z: d2 }));
    addHorizontalJoints(b.w, (off) => ({ x: off, z: -d2 }));
    addHorizontalJoints(b.d, (off) => ({ x: w2, z: off }));
    addHorizontalJoints(b.d, (off) => ({ x: -w2, z: off }));

    if (positions.length > 0) {
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
        group.add(new THREE.LineSegments(geo, sugiJointMat));
    }
    return group;
}

/* 選んでいる面の中心につまみを置く。面の外へ少し浮かせて、面と重ならないように。
   ⚠️ DXF から起こした階は側面を押し引きしないので、上面にしか出さない。 */
function buildPullHandle() {
    const b = AppState.buildingData.find(d => d.id === AppState.selectedId);
    const dir = AppState.selectedFaceDir;
    if (!b || !dir || dir === 'bottom') return;
    // ★ 修景要素を選んでいるあいだは出さない。要素のつまみと重なって、
    //   どちらを掴んでいるのか分からなくなる。
    if (AppState.selectedPart) return;
    if (b.kind === 'dxf' && dir !== 'top') return;
    const baseY = b.y || 0;
    // 建物の大きさに合わせた大きさ。小さすぎると掴めず、大きすぎると形を隠す。
    const r = Math.max(150, Math.min(b.w, b.d, 2000) * 0.09);
    const n = { top: [0, 1, 0], px: [1, 0, 0], nx: [-1, 0, 0],
        pz: [0, 0, 1], nz: [0, 0, -1] }[dir];
    if (!n) return;
    // ⚠️ 上面のつまみは【描いてある天端】に置く。b.h のままだと、軒を詰めて
    //   壁を下げたときにつまみだけ宙に浮く。
    const drop = dir === 'top' ? freeRoofWallDrop(b) : 0;
    const c = new THREE.Vector3(b.x, baseY + b.h / 2, b.z);
    if (dir === 'top') c.y = baseY + b.h - drop;
    else if (dir === 'px') c.x = b.x + b.w / 2;
    else if (dir === 'nx') c.x = b.x - b.w / 2;
    else if (dir === 'pz') c.z = b.z + b.d / 2;
    else if (dir === 'nz') c.z = b.z - b.d / 2;
    // ★ 面に【直角に立つ矢印】。軸・矢じりとも面の法線に沿うので、上面なら
    //   上下、側面なら横向きに出る。どちらへ押し引きするのかが形で読める。
    //   ⚠️ 立方体では向きが読めなかった。どの面のつまみかは位置でしか分からず、
    //     斜めから見ると隣の面のものと見分けがつかない。
    //   ⚠️ Group にしてはいけない。当たり判定は配列を【素通しなし】で見るので、
    //     子は拾われない。軸と矢じりを別々に配列へ入れて、同じ札を付ける。
    const PAD = r * 5, PAD_T = r * 0.45;           // 押される面をあらわす板
    const HEAD = r * 1.7, HEAD_R = r * 0.85;      // 矢じり
    // ⚠️ 竿は短めに太く。長いと棟の上の平場のつまみ（緑の球）と重なって、
    //   どちらを掴んでいるのか分からなくなる。
    const SHAFT = r * 1.6, SHAFT_R = r * 0.30;    // 軸
    const nv = new THREE.Vector3(n[0], n[1], n[2]);
    // 円錐・円柱・箱は Y 軸向きに作られる。面の法線へ倒す。
    const quat = new THREE.Quaternion()
        .setFromUnitVectors(new THREE.Vector3(0, 1, 0), nv);
    const at = (d) => new THREE.Vector3(
        c.x + n[0] * d, c.y + n[1] * d, c.z + n[2] * d);
    const parts = [];
    // ★ 押される面をあらわす板。矢印だけだと「どの面が動くのか」は位置から
    //   推し量るしかない。動く面そのものを厚みのある板で見せる。
    const padGeo = new THREE.BoxGeometry(PAD, PAD_T, PAD);
    const pad = new THREE.Mesh(padGeo, pullFaceMat);
    pad.quaternion.copy(quat);
    pad.position.copy(at(PAD_T / 2));
    parts.push(pad);
    // ⚠️ 矢印より【後ろ】に描くこと。どちらも深度を見ないので、描く順だけで
    //   前後が決まる。同じ順にすると板が矢印を消してしまう。
    pad.userData.order = 996;
    // 板の輪郭。面だけだと厚みが読めず、板に見えない。
    const padLine = new THREE.LineSegments(
        new THREE.EdgesGeometry(padGeo), pullEdgeMat);
    padLine.quaternion.copy(quat);
    padLine.position.copy(pad.position);
    padLine.renderOrder = 997;
    // ⚠️ 線は当たり判定に入れない。線の判定には太さがあるので、板の【外】を
    //   通っただけで掴んだことになる。
    padLine.userData = { decor: true };
    // 矢じり。先端が板に触れ、板を指す向き（＝軸とは逆を向く）。
    const head = new THREE.Mesh(
        new THREE.ConeGeometry(HEAD_R, HEAD, 20), pullHandleMat);
    head.quaternion.copy(quat);
    head.rotateX(Math.PI);                        // 先端を面の側へ
    head.position.copy(at(PAD_T + HEAD / 2));
    parts.push(head);
    // 軸。矢じりの根元から外へ伸ばす。
    const shaft = new THREE.Mesh(
        new THREE.CylinderGeometry(SHAFT_R, SHAFT_R, SHAFT, 12), pullHandleMat);
    shaft.quaternion.copy(quat);
    shaft.position.copy(at(PAD_T + HEAD + SHAFT / 2));
    parts.push(shaft);
    for (const m of parts) {
        m.renderOrder = m.userData.order || 1001;
        // ★ 板は【建具に譲る】。窓は面の中ほどに置かれることが多く、板と重なる。
        //   矢じりと軸はそのまま押し引きの入口。
        m.userData = { id: b.id, pullDir: dir, pullPad: m === pad };
    }
    parts.push(padLine);
    return parts;
}

/* ★追加：選んでいる修景要素のつまみ。
   ★ 大きさは【つまみ】、位置は【その要素そのものを掴んで動かす】。
     スライダーを並べるより、動かすものの上で決めるほうが早い。
   ★ 出すのは【選んでいる1つ】だけ。面にあるもの全部に出すと、つまみだらけで
     どれがどれの端なのか読めなくなる。
   ⚠️ 壁の面より少し外へ出すこと。面に埋めると壁に隠れて掴めない。 */
function buildPartHandles() {
    const out = [];
    const sel = AppState.selectedPart;
    const b = AppState.buildingData.find(d => d.id === AppState.selectedId);
    if (!sel || !b) return out;
    // 図面から起こした階で触れるのは【図面の窓】だけ。ほかの修景は持たない。
    if (b.kind === 'dxf' && sel.kind !== 'dxfwin') return out;
    const dir = sel.dir;
    const f = ModelingEngine.faceBasis(b, dir);
    if (!f) return out;
    const baseY = b.y || 0;
    const OUT = 90;                                   // 壁の面から外へ出す量[mm]
    // つまみ（球）を1つ。u は面に沿った位置、y は世界の高さ、d は面から外への出。
    const put = (role, u, y, r, d = OUT) => {
        const m = new THREE.Mesh(new THREE.SphereGeometry(r, 16, 12), pullHandleMat);
        m.position.set(b.x + f.n[0] * (f.half + d) + f.u[0] * u, y,
            b.z + f.n[1] * (f.half + d) + f.u[1] * u);
        m.renderOrder = 1002;
        m.userData = { id: b.id, partDir: dir, partKind: sel.kind, partRole: role,
            partIndex: sel.i || 0, partSide: sel.side || null };
        out.push(m);
    };
    const size = (a, bb) => Math.min(Math.max(Math.min(a, bb) * 0.08, 120), 240);

    if (sel.kind === 'window' || sel.kind === 'door') {
        const q = ModelingEngine.openingRect(b, baseY, dir, sel.kind, sel.i || 0);
        if (!q) return out;
        const r = size(q.w, q.h);
        // 玄関は土間に載っているので、下の辺は動かさない。
        put('u0', q.u - q.w / 2, q.yc, r);
        put('u1', q.u + q.w / 2, q.yc, r);
        if (sel.kind !== 'door') put('v0', q.u, q.y0, r);
        put('v1', q.u, q.y1, r);
        return out;
    }
    if (sel.kind === 'sode') {
        const q = ModelingEngine.sodeRect(b, baseY, dir, sel.side);
        if (!q) return out;
        const r = size(q.depth, q.h);
        // 天端＝高さ（上面隙間）、先端＝奥行。位置はそで壁そのものを掴んで動かす。
        put('top', q.u, q.y1, r);
        put('depth', q.u, (q.y0 + q.y1) / 2, r, q.depth + OUT);
        return out;
    }
    if (sel.kind === 'dxfwin') {
        // ★ 図面から起こした窓。つまみは【その窓が乗っている壁】の外面に置く。
        //   ⚠️ 外形（箱）の面ではない。壁は外形より内側にあることがある。
        const q = dxfWindows(b.plan).find((w) => w.src === (sel.i || 0));
        if (!q) return out;
        const r = size(q.b - q.a, q.hi - q.lo);
        const cOut = q.c + q.sgn * (q.h + OUT);
        const put2 = (role, u, y) => {
            const m = new THREE.Mesh(new THREE.SphereGeometry(r, 16, 12), pullHandleMat);
            m.position.set(b.x + (q.alongX ? u : cOut), y, b.z + (q.alongX ? cOut : u));
            m.renderOrder = 1002;
            m.userData = { id: b.id, partDir: q.dir, partKind: 'dxfwin',
                partRole: role, partIndex: sel.i || 0 };
            out.push(m);
        };
        const yc = baseY + (q.lo + q.hi) / 2, uc = (q.a + q.b) / 2;
        put2('u0', q.a, yc); put2('u1', q.b, yc);
        put2('v0', uc, baseY + q.lo); put2('v1', uc, baseY + q.hi);
        return out;
    }
    if (sel.kind === 'balc') {
        const q = ModelingEngine.balcRect(b, baseY, dir);
        if (!q) return out;
        const r = size(q.depth, Math.max(q.hRail, 900));
        // 先端＝奥行、手すりの天端＝手すり高、側面壁の天端＝側面壁高。
        put('depth', 0, q.floorTop, r, q.depth + OUT);
        put('rail', 0, q.railY, r, q.depth);
        put('side', q.uSide, q.sideY, r, q.depth / 2);
        return out;
    }
    if (sel.kind === 'visor') {
        // ★ 軒庇。先端で【軒の出】、その脇で【勾配】、両端で【ケラバ】。
        //   ⚠️ 同じ場所につまみを2つ置かないこと。どちらを掴んでいるのか
        //     分からなくなる。勾配のつまみは先端の少し脇へずらす。
        const q = ModelingEngine.visorRect(b, baseY, dir);
        if (!q) return out;
        const r = size(q.eaves, 600);
        put('eaves', 0, q.yOut, r, q.eaves + OUT);
        put('slope', Math.min(q.len / 4, 2000), q.yOut, r, q.eaves + OUT);
        put('kL', -(q.len / 2 + q.keraba), q.yTop, r, 0);
        put('kR', q.len / 2 + q.keraba, q.yTop, r, 0);
        return out;
    }
    if (sel.kind === 'flat') {
        // ★ 水平庇。先端で【出】、その脇で【取り付く高さ】、両端で【空き】。
        const q = ModelingEngine.flatRect(b, baseY, dir);
        if (!q) return out;
        const r = size(q.depth, 600);
        put('fdepth', 0, q.y, r, q.depth + OUT);
        put('lift', Math.min(q.len / 4, 2000), q.y, r, q.depth / 2);
        put('mL', -(q.len / 2 - q.margin), q.y, r, q.depth / 2);
        put('mR', q.len / 2 - q.margin, q.y, r, q.depth / 2);
        return out;
    }
    if (sel.kind === 'tare') {
        const q = ModelingEngine.tareRect(b, baseY, dir);
        if (!q) return out;
        const r = size(q.w, Math.max(q.h, 400));
        const yc = (q.y0 + q.y1) / 2;
        put('u0', q.u0, yc, r);
        put('u1', q.u1, yc, r);
        put('v0', (q.u0 + q.u1) / 2, q.y0, r);
        return out;
    }
    return out;
}

/* ★追加：屋根の切り欠きのつまみ。
   ★ 真ん中＝穴ごと動かす、4辺＝その辺だけ動かす（05 と同じ作法）。
   ⚠️ 置くのは【穴の底（壁の天端）】の少し上。屋根の上に置くと、穴の底が
     見えているのにつまみだけ屋根の高さに浮いて見える。 */
function buildNotchHandles() {
    const out = [];
    const b0 = selectedRoofOwner();
    if (!b0 || AppState.selectedPart) return out;
    const n = freeNotch(b0);
    if (!n) return out;
    const y = (b0.y || 0) + b0.h - freeRoofWallDrop(b0) + 150;
    const r = Math.min(Math.max(Math.min(n.x1 - n.x0, n.z1 - n.z0) * 0.08, 140), 260);
    const put = (role, x, z) => {
        const m = new THREE.Mesh(new THREE.SphereGeometry(r, 16, 12), notchHandleMat);
        m.position.set(b0.x + x, y, b0.z + z);
        m.renderOrder = 1003;
        m.userData = { id: b0.id, notchRole: role };
        out.push(m);
    };
    const cx = (n.x0 + n.x1) / 2, cz = (n.z0 + n.z1) / 2;
    put('move', cx, cz);
    put('w', n.x0, cz); put('e', n.x1, cz);
    put('s', cx, n.z0); put('n', cx, n.z1);
    return out;
}

/* 棟の端のつまみ。屋根を選んでいるときだけ、棟の両端に出す。
   ★ 棟の端の位置と「その辺の切妻の度合い」は同じもの。端を軒へ寄せれば
     切妻、内へ引けば寄棟。型を選ぶのではなく、引いて決める。 */
function buildRidgeHandles() {
    const out = [];
    const b = selectedRoofOwner();
    if (!b) return out;
    const baseY = (b.y || 0) + b.h;
    const rad = Math.max(180, Math.min(b.w, b.d, 2400) * 0.07);
    // ⚠️ 棟の球は出ないことがある（平場・パラペット・勾配 0）。そこで打ち切って
    //   はいけない。勾配のつまみまで一緒に消えてしまう。
    // ★ 並べた形では棟が何本もある。05 と同じく【棟ごと】に両端の球を出す。
    for (const r of freeRidges(b)) {
        for (const e of r.ends) {
            const m = new THREE.Mesh(new THREE.SphereGeometry(rad, 16, 12), ridgeHandleMat);
            m.position.set(b.x + e.x, baseY + r.y, b.z + e.z);
            m.renderOrder = 999;
            m.userData = { id: b.id, ri: r.ri, ridgeEdge: e.edge, ridgeAlongX: r.alongX };
            out.push(m);
        }
    }
    out.push(...buildSlopeHandles(b, baseY));
    return out;
}

/* 勾配のつまみ。勾配屋根の面ごとに、その面に立つ【勾配定規】を置く。
   ★ 斜辺が屋根面に載り、下端に垂直の辺、上に水平の辺。三角形の形がそのまま
     その面の勾配になっている。
   ⚠️ 勾配が緩いと三角形が潰れて掴めない。角度は正しいまま【三角形ごと大きく】
     して逃がす。倍率には上限を置く（青天井にすると屋根からはみ出す）。 */
function buildSlopeHandles(b, baseY) {
    const out = [];
    const hs = freeSlopeHandles(b);
    if (!hs.length) return out;
    const sl = (b.roof.params['自由屋根'].slope || 0) / 10;
    const L0 = Math.max(900, Math.min(Math.min(b.w, b.d) * 0.16, 2000));
    const HMIN = L0 * 0.30;                       // これより低いと読めない
    let base = L0;
    // ⚠️ 倍率の上限は控えめに。上げすぎると、緩勾配のとき定規が隅棟をまたいで
    //   屋根からはみ出す。ごく緩い勾配では薄い三角のまま我慢する。
    if (L0 * sl < HMIN) base = L0 * Math.min(HMIN / Math.max(L0 * sl, 1e-6), 2.2);
    for (const h of hs) {
        const [ox, oz] = OUT_DIR[h.edge];
        const dx = -ox, dz = -oz;                 // 軒から棟へ向かう向き
        const cx = b.x + h.x, cy = baseY + h.y, cz = b.z + h.z;
        const half = base / 2;
        // 斜辺の両端（どちらも屋根面の上）。
        const p1 = [cx - dx * half, cy - half * sl, cz - dz * half];
        const p2 = [cx + dx * half, cy + half * sl, cz + dz * half];
        const p3 = [p1[0], p2[1], p1[2]];         // 下端の真上＝直角の頂点
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(
            [...p1, ...p2, ...p3], 3));
        const m = new THREE.Mesh(geo, slopeHandleMat);
        // 高さから勾配を逆に解くのに要るものだけ持たせる。
        //   refY は「この面の高さ」。掴んだ場所とのずれを打ち消すのに使う。
        m.userData = { id: b.id, slopeHandle: true,
            y0: baseY + h.y0, den: h.den, refY: cy };
        out.push(m);
        const lg = new THREE.BufferGeometry();
        lg.setAttribute('position', new THREE.Float32BufferAttribute(
            [...p1, ...p2, ...p2, ...p3, ...p3, ...p1], 3));
        const lm = new THREE.LineSegments(lg, slopeEdgeMat);
        lm.userData = { decor: true };
        out.push(lm);
    }
    return out;
}

/* 4つ角を与えて、黄色い帯を1枚作る。下屋・パラペット修景で使い回す。 */
function makeBar(b, baseY, e, userData) {
    const p = [];
    const push = (q) => p.push(b.x + q.x, baseY + q.y + 60, b.z + q.z);
    push(e.a); push(e.b); push(e.ib);
    push(e.a); push(e.ib); push(e.ia);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
    const m = new THREE.Mesh(geo, eaveBarMat);
    m.userData = userData;
    return m;
}

/* 下屋の軒先・ケラバのバー。大屋根のバーと同じ見た目・同じ触り心地にする。
   ⚠️ 形そのものは modelingEngine が作る。ここは【掴む場所】を置くだけ。 */
function buildGeyaBars(b, baseY) {
    return geyaBars(b).map((e) => makeBar(b, baseY, e,
        { id: b.id, geyaEdge: e.dir, geyaRole: e.role,
            geyaParam: e.param, out: e.out }));
}

/* パラペット修景屋根のつまみ一式。
     黄色い帯 … 外への出／内への寸法
     橙の球   … 棟の水平位置
     赤い定規 … 笠木勾配
     緑の球   … パラペットの立ち上がり */
function buildParaHandles(b, baseY) {
    const parts = paraParts(b);
    if (!parts) return [];
    const out = [];
    for (const e of parts.bars) {
        out.push(makeBar(b, baseY, e, { id: b.id, paraBar: e.kind, paraDir: e.dir,
            paraParam: e.param, value: e.value, sign: e.sign }));
    }
    const rad = Math.max(180, Math.min(b.w, b.d, 2400) * 0.07);
    {
        const r = parts.ridge;
        const m = new THREE.Mesh(new THREE.SphereGeometry(rad, 16, 12), ridgeHandleMat);
        m.position.set(b.x + r.x, baseY + r.y, b.z + r.z);
        m.renderOrder = 999;
        m.userData = { id: b.id, paraBar: 'ridge', paraDir: r.dir,
            paraParam: r.param, value: r.value, sign: r.sign };
        out.push(m);
    }
    if (parts.slope) {
        const h = parts.slope;
        const [ox, oz] = PARA_OUT_DIR[h.dir];
        const dx = -ox, dz = -oz;
        const L0 = Math.max(900, Math.min(Math.min(b.w, b.d) * 0.16, 2000));
        const HMIN = L0 * 0.30;
        let base = L0;
        if (L0 * h.slope < HMIN) {
            base = L0 * Math.min(HMIN / Math.max(L0 * h.slope, 1e-6), 2.2);
        }
        const cx = b.x + h.x, cy = baseY + h.y, cz = b.z + h.z;
        const half = base / 2;
        const p1 = [cx - dx * half, cy - half * h.slope, cz - dz * half];
        const p2 = [cx + dx * half, cy + half * h.slope, cz + dz * half];
        const p3 = [p1[0], p2[1], p1[2]];
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(
            [...p1, ...p2, ...p3], 3));
        const m = new THREE.Mesh(geo, slopeHandleMat);
        m.userData = { id: b.id, paraSlope: true, y0: baseY + h.y0,
            den: h.den, refY: cy };
        out.push(m);
        const lg = new THREE.BufferGeometry();
        lg.setAttribute('position', new THREE.Float32BufferAttribute(
            [...p1, ...p2, ...p2, ...p3, ...p3, ...p1], 3));
        const lm = new THREE.LineSegments(lg, slopeEdgeMat);
        lm.userData = { decor: true };
        out.push(lm);
    }
    {
        const h = parts.height;
        const m = new THREE.Mesh(new THREE.SphereGeometry(rad, 18, 14), flatHandleMat);
        m.position.set(b.x + h.x, baseY + h.y, b.z + h.z);
        m.renderOrder = 1000;
        m.userData = { id: b.id, paraHeight: true, value: h.value };
        out.push(m);
    }
    return out;
}

/* 下屋の勾配の定規。大屋根と同じ三角形。 */
function buildGeyaSlopeHandle(b, baseY) {
    const h = geyaSlopeHandle(b);
    if (!h) return [];
    const out = [];
    const [ox, oz] = GEYA_OUT_DIR[h.dir];
    const dx = -ox, dz = -oz;                  // 軒から内側へ向かう向き
    const L0 = Math.max(900, Math.min(Math.min(b.w, b.d) * 0.16, 2000));
    const HMIN = L0 * 0.30;
    let base = L0;
    if (L0 * h.slope < HMIN) {
        base = L0 * Math.min(HMIN / Math.max(L0 * h.slope, 1e-6), 2.2);
    }
    const cx = b.x + h.x, cy = baseY + h.y, cz = b.z + h.z;
    const half = base / 2;
    const p1 = [cx - dx * half, cy - half * h.slope, cz - dz * half];
    const p2 = [cx + dx * half, cy + half * h.slope, cz + dz * half];
    const p3 = [p1[0], p2[1], p1[2]];
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(
        [...p1, ...p2, ...p3], 3));
    const m = new THREE.Mesh(geo, slopeHandleMat);
    m.userData = { id: b.id, geyaSlope: true, den: h.den, refY: cy };
    out.push(m);
    const lg = new THREE.BufferGeometry();
    lg.setAttribute('position', new THREE.Float32BufferAttribute(
        [...p1, ...p2, ...p2, ...p3, ...p3, ...p1], 3));
    const lm = new THREE.LineSegments(lg, slopeEdgeMat);
    lm.userData = { decor: true };
    out.push(lm);
    return out;
}

/* 屋上の平場をつくるつまみ。屋根のてっぺんの真上に置く。
   ★ 下げるほど平場が広がり、いっぱいまで下げるとパラペットの陸屋根になる。 */
function buildFlatHandle() {
    const b = selectedRoofOwner();
    if (!b) return null;
    const f = freeRoofFlat(b);
    if (!f) return null;
    // ★ 棟の中央に置く丸。上下に引くと平場が広がる。
    //   ⚠️ 平場をつくると棟は無くなるので、そのときは屋根のてっぺんへ逃がす
    //     （そこは押し引きの青い板と重なるので、少しずらした位置を使う）。
    // ⚠️ 棟の端は【片方だけ】のことがある（もう一方が他の屋根に潜っている）。
    //   端が2つある前提で書くと、そこで落ちる。あるぶんで平均を取る。
    const r = freeRidge(b);
    const ends = r ? r.ends : [];
    const avg = (k) => ends.reduce((a, e) => a + e[k], 0) / ends.length;
    const px = ends.length ? avg('x') : f.x;
    const pz = ends.length ? avg('z') : f.z;
    const py = ends.length ? r.y : f.y;
    const rad = Math.max(200, Math.min(b.w, b.d, 2400) * 0.075);
    const m = new THREE.Mesh(new THREE.SphereGeometry(rad, 18, 14), flatHandleMat);
    m.position.set(b.x + px, (b.y || 0) + b.h + py, b.z + pz);
    m.renderOrder = 1000;
    m.userData = { id: b.id, flatHandle: true };
    return [m];
}

/* 図面の階の階段が【どこまで上がるか】と、手すり壁の頭打ち。05 と同じ見方。
   ★ 階段は上階の【床面】まで上がる。壁の天端で止めると、床板の厚みぶんだけ
     足りない段差が最上段に残る。
   ★ 手すり壁は吹抜けの手すりとして上階まで続く。上に何か載っていれば、
     その天端まで立ち上がってよい。
   ⚠️ 上に何も無いときは伸ばさない。壁だけが宙へ伸びる。 */
function stairReach(b) {
    const out = {};
    const topY = (b.y || 0) + b.h;
    const rectOf = (q) => ({ x0: q.x - q.w / 2, x1: q.x + q.w / 2,
        z0: q.z - q.d / 2, z1: q.z + q.d / 2 });
    const over = (p, q) => Math.min(p.x1, q.x1) - Math.max(p.x0, q.x0) > 50
        && Math.min(p.z1, q.z1) - Math.max(p.z0, q.z0) > 50;
    const foot = rectOf(b);
    const s = b.plan && b.plan.stair;
    const st = s ? { x0: b.x + s.x0, x1: b.x + s.x1, z0: b.z + s.z0, z1: b.z + s.z1 } : null;
    let slabT = 0, cap = 0;
    for (const q of AppState.buildingData) {
        if (q === b || (q.y || 0) < topY - 1) continue;
        const r = rectOf(q);
        // すぐ上に載っている床板。階段はその天端（＝上階の床）まで上がる
        if (q.kind === 'slab' && Math.abs((q.y || 0) - topY) < 1 && over(foot, r)) {
            slabT = Math.max(slabT, q.h);
        }
        // 階段の真上に載っているものの天端。手すり壁はここで頭打ち
        if (st && over(st, r)) cap = Math.max(cap, (q.y || 0) + q.h - (b.y || 0));
    }
    // ★ 上に床板が載っている階は、天端の横線を引かない。板の天端の1本で仕切る。
    if (slabT > 0) { out.stacked = true; if (s) out.upperH = b.h + slabT; }
    if (cap > 0) out.railCap = cap;
    return out;
}

function rebuildMeshes() {
    while(houseGroup.children.length > 0){
        const child = houseGroup.children[0];
        houseGroup.remove(child);

        child.traverse((obj) => {
            if (obj.geometry) {
                obj.geometry.dispose();
            }
            // ★追加：建物ごと・階ごと・部位ごとに個別クローンされたマテリアルは
            // 使い回しの共有マテリアル（selectedMat/activeMat/edgeMat/ガラス類など）とは異なり、
            // 毎回新規生成されるためGPUリソースのリークを防ぐために破棄する
            if (obj.material) {
                const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
                mats.forEach(m => {
                    if (m && m.userData && m.userData.isClonedPartMaterial) m.dispose();
                });
            }
        });
    }
    meshMap = {};
    interactiveMeshes = [];
    pullHandles = [];
    // ★ 小窓では選択色を出さない。素に見せる色は、選んでいる建物の壁色。
    SubCam.clearMasks();

    // ★追加：rebuild1回につき1回、部位ごとのマテリアルキャッシュを完全リセット
    ModelingEngine.resetMaterialCache();

    AppState.buildingData.forEach(b => {
        // ★追加：このブロック（階）専用の壁色・屋根色・軒裏色マテリアルを解決（他の階・他の建物とは独立）
        const wallMatB = ModelingEngine.getMaterial(b, 'wall', wallMat);
        const roofMatB = ModelingEngine.getMaterial(b, 'roof', roofMat);
        // ★追加：大屋根・下屋・庇の「白層（軒裏・破風の水平面）」を壁面とは別に着色できるようにする
        const roofEaveMatB = ModelingEngine.getMaterial(b, 'roofEave', wallMat);
        // ★追加：ボックス自体の上面（屋上）は、大屋根・下屋・庇・バルコニー枠の屋根色(roof)とは
        // 別のマテリアルにして、両者が同じ色に連動してしまわないようにする
        // ★ 直方体の上面（屋上・平場）は【白】。屋根の葺き材の黒ではない。
        //   ⚠️ 屋根色に連動させると、屋上を歩ける面として見えなくなる。
        const roofTopMatB = ModelingEngine.getMaterial(b, 'roofTop', wallMat);

        const baseY = b.y || 0;

        // ★追加：取り込んだ 3D モデル。中身は外で作られたものなので、
        //   こちらでは【置く・当たり判定を付ける】だけ。屋根も修景も通さない。
        //   ⚠️ 読み込みには少し時間がかかる。読めるまでは箱で場所だけ示し、
        //     読めた合図で組み直す。何も出ないと、取り込めたのかが分からない。
        if (b.kind === 'model') {
            const grp = new THREE.Group();
            grp.position.set(b.x, baseY, b.z);
            const obj = modelObject(b, () => rebuildMeshes());
            if (obj) {
                grp.add(obj);
            } else {
                const box = new THREE.Mesh(
                    new THREE.BoxGeometry(b.w, b.h, b.d), ghostModelMat);
                box.position.y = b.h / 2;
                grp.add(box);
            }
            let first = null;
            grp.traverse((o) => {
                if (!o.isMesh) return;
                o.userData.id = b.id;
                interactiveMeshes.push(o);
                if (!first) first = o;
            });
            houseGroup.add(grp);
            if (first) meshMap[b.id] = { mesh: first, line: null };
            return;
        }

        // ★追加：DXF から起こした階は、直方体ではなく【図面どおりの壁】を建てる。
        //   ⚠️ 直方体の本体は作らない。二重になるうえ、中の間取りが見えなくなる。
        //   屋根・修景はこのあと共通の道を通るので、ここで作るのは躯体だけ。
        if (b.kind === 'dxf' && b.plan) {
            const grp = buildDxfFloor(b.plan, b.h,
                { wallMat: wallMatB, sashMat, glassMat: windowGlassMat, edgeMat },
                { deck: !!b.roof, ...stairReach(b) });
            grp.position.set(b.x, baseY, b.z);
            let first = null;
            grp.traverse((o) => {
                if (!o.isMesh && !o.isLineSegments) return;
                // ⚠️ 線にも建物の id を入れる。窓の稜線を掴んだときに、どの建物の
                //   ものか分からないと選択に入れない。当たり判定には入れない。
                o.userData.id = b.id;
                if (!o.isMesh) return;
                interactiveMeshes.push(o);
                if (!first) first = o;
            });
            // ★追加：図面の階の【天端に、見えない一枚の面】を張る。
            //   ⚠️ 図面の階には直方体の上面が無い。壁の天端は線のように細く、
            //     部屋の中は素通しなので、上から押しても「側面を選んだ」ことに
            //     なってしまい、階高の押し引きハンドルに戻る道が無かった。
            //     この面があれば、部屋の中をふつうに押すだけで上面が選べる。
            //   ⚠️ 色は書かない（見た目は何も変わらない）。当たり判定だけの面。
            {
                const topGeo = new THREE.PlaneGeometry(b.w, b.d);
                topGeo.rotateX(-Math.PI / 2);          // 法線を真上へ
                const topHit = new THREE.Mesh(topGeo, hiddenFaceMat);
                topHit.position.set(0, b.h, 0);
                topHit.renderOrder = -1;
                topHit.userData.id = b.id;
                grp.add(topHit);
                interactiveMeshes.push(topHit);
                if (!first) first = topHit;
            }
            houseGroup.add(grp);
            if (first) meshMap[b.id] = { mesh: first, line: null };
            const roofMaterialsD = { wallMat: roofEaveMatB, roofMat: roofMatB, edgeMat: edgeMat, gableWallMat: wallMatB };
            const roofsGroupD = ModelingEngine.buildRoofs(b, baseY, AppState.buildingData, roofMaterialsD);
            roofsGroupD.traverse(child => {
                if (child.isMesh && child.userData.isRoof) interactiveMeshes.push(child);
            });
            houseGroup.add(roofsGroupD);
            return;
        }

        // ★追加：階と階の間の床板。階段が上がってくるところには穴を開ける。
        //   ⚠️ 直方体のままだと、上り口を床が塞いで階段が床に突き刺さり、
        //     外では板の上下の縁が【二重線】になる。
        //   ⚠️ 1階の床（地盤面の板）はここを通さない。足元の線が要る。
        if (b.kind === 'slab' && baseY > 0) {
            if (b.id === AppState.selectedId) {
                SubCam.addMask(selectedMat, wallMatB.color.getHex());
            }
            const grp = buildSlabWithHole(b.w, b.d, b.h, b.hole,
                { wallMat: b.id === AppState.selectedId ? selectedMat : wallMatB, edgeMat });
            grp.position.set(b.x, baseY, b.z);
            let first = null;
            grp.traverse((o) => {
                if (!o.isMesh) return;
                o.userData.id = b.id;
                interactiveMeshes.push(o);
                if (!first) first = o;
            });
            houseGroup.add(grp);
            if (first) meshMap[b.id] = { mesh: first, line: null };
            return;
        }

        // ★変更：窓・玄関の位置に実際の開口をくり抜いた本体ジオメトリを使う
        //   （建具を壁に貼り付けるのをやめ、開口に落とし込む納まりにしたため）
        //   グループ順・法線は BoxGeometry と同じなので、下の面別マテリアルと面選択はそのまま効く。
        // ★ 自由屋根が壁の天端より下に取り付くときは、その高さまで壁を
        //   下げて描く。下げないと直方体が屋根を突き抜けて上に出る。
        //   ⚠️ 下げるのは【描き方】だけ。b.h（階の高さ）は書き換えない。
        const wallDrop = freeRoofWallDrop(b);
        const bDraw = wallDrop > 0.5
            ? { ...b, h: Math.max(100, b.h - wallDrop) } : b;
        const geo = ModelingEngine.buildBodyGeometry(bDraw, baseY);

        // ★変更：側面(px/nx/pz/nz)は壁色、上面(top)は屋上専用色を使い、外壁と屋上を別々に着色できるようにする
        // ★ 自由屋根を載せた階の上面は屋根が覆うので描かない（上を参照）。
        // ⚠️ 屋根を持っていない相方の階も上面を描かない。大屋根はそちらまで
        //   覆っているので、描くと屋根の下に床が二重に出る。
        const freeRoofed = !!freeRoofOwner(b);
        const mats = [wallMatB, wallMatB, freeRoofed ? hiddenFaceMat : roofTopMatB,
            wallMatB, wallMatB, wallMatB];
        if (b.id === AppState.selectedId && AppState.selectedFaceDir) {
            const fmap = { 'px':0, 'nx':1, 'top':2, 'bottom':3, 'pz':4, 'nz':5 };
            const idx = fmap[AppState.selectedFaceDir];
            // ⚠️ 描かない上面には選択色も塗らない。塗ると縞模様が戻る。
            if (idx !== undefined && mats[idx] !== hiddenFaceMat) {
                // 小窓では、この面も素の壁色で見せる。
                SubCam.addMask(selectedMat, wallMatB.color.getHex());
                SubCam.addMask(activeMat, wallMatB.color.getHex());
                mats[idx] = selectedMat;
            }
        }

        const mesh = new THREE.Mesh(geo, mats);
        mesh.position.set(b.x, baseY + bDraw.h / 2, b.z);
        mesh.userData.id = b.id; 

        const edges = new THREE.EdgesGeometry(geo);
        const line = new THREE.LineSegments(edges, edgeMat);
        line.position.copy(mesh.position);

        houseGroup.add(mesh, line);
        interactiveMeshes.push(mesh);
        meshMap[b.id] = { mesh, line };

        // ★追加：壁が杉板調テクスチャのとき、板幅ごとの目地線を描く
        houseGroup.add(buildWallJointLines(b, baseY));

        if (baseY === 0 && b.h > 100) {
            const kisoY = 100;
            const pts = [
                new THREE.Vector3(-b.w/2, kisoY, b.d/2),
                new THREE.Vector3(b.w/2, kisoY, b.d/2),
                new THREE.Vector3(b.w/2, kisoY, -b.d/2),
                new THREE.Vector3(-b.w/2, kisoY, -b.d/2),
                new THREE.Vector3(-b.w/2, kisoY, b.d/2)
            ];
            const kisoGeo = new THREE.BufferGeometry().setFromPoints(pts);
            const kisoLine = new THREE.Line(kisoGeo, edgeMat);
            kisoLine.position.set(b.x, baseY, b.z);
            kisoLine.userData = { id: b.id };
            houseGroup.add(kisoLine);
        }

        const roofMaterials = { wallMat: roofEaveMatB, roofMat: roofMatB, edgeMat: edgeMat, gableWallMat: wallMatB };
        const roofsGroup = ModelingEngine.buildRoofs(b, baseY, AppState.buildingData, roofMaterials);

        roofsGroup.traverse(child => {
            if (child.isMesh && child.userData.isRoof) {
                interactiveMeshes.push(child);
            }
        });
        houseGroup.add(roofsGroup);

        const visorMaterials = { roofMat: roofMatB, wallMat: roofEaveMatB, edgeMat: edgeMat, gableWallMat: wallMatB };
        const visorsGroup = ModelingEngine.buildVisorsAndSkirts(b, baseY, visorMaterials);
        houseGroup.add(visorsGroup);

        const balcMaterials = { roofMat: roofMatB, edgeMat: edgeMat };
        const balconiesGroup = ModelingEngine.buildBalconies(b, baseY, balcMaterials);
        houseGroup.add(balconiesGroup);

        const pilasterMaterials = { edgeMat: edgeMat };
        const pilastersGroup = ModelingEngine.buildPilasters(b, baseY, pilasterMaterials);
        houseGroup.add(pilastersGroup);

        // ★変更：開口の見込み面（内側の筒）を壁と同じ色で仕上げるため wallMat を渡す
        const windowMaterials = { edgeMat: edgeMat, wallMat: wallMatB };
        const windowsGroup = ModelingEngine.buildWindows(b, baseY, windowMaterials);
        houseGroup.add(windowsGroup);

        const doorMaterials = { edgeMat: edgeMat, wallMat: wallMatB };
        const doorsGroup = ModelingEngine.buildDoors(b, baseY, doorMaterials);
        houseGroup.add(doorsGroup);

        // ★変更：そで壁・垂れ壁は本体の壁色とは独立した専用パーツとして着色できるようにする
        const sodeMaterials = { wallMat: ModelingEngine.getMaterial(b, 'sodeWall', wallMat), edgeMat: edgeMat };
        const sodeWallsGroup = ModelingEngine.buildSodeWalls(b, baseY, sodeMaterials);
        houseGroup.add(sodeWallsGroup);

        const tareMaterials = { wallMat: ModelingEngine.getMaterial(b, 'tareWall', wallMat), edgeMat: edgeMat };
        const tareWallsGroup = ModelingEngine.buildTareWalls(b, baseY, tareMaterials);
        houseGroup.add(tareWallsGroup);

    });

    // ★追加：つまみ類は【操作の道具】。サブカメラの小窓には写さない
    //   （道具レイヤーへ移す）。掴む側のレイキャスターは全レイヤーを見ている。
    const addTool = (o) => { markTool(o); houseGroup.add(o); };
    // ★追加：選んでいる面につまみを出す。押し引きの入口を目に見えるようにする。
    for (const ph of (buildPullHandle() || [])) {
        addTool(ph);
        if (!ph.userData.decor) pullHandles.push(ph);
    }
    // ★追加：選んでいる修景要素のつまみ。つまんで大きさを変える。
    for (const oh of buildPartHandles()) {
        addTool(oh);
        pullHandles.push(oh);
    }
    // ★追加：屋根の切り欠きのつまみ。穴の大きさと位置を引いて決める。
    for (const nh of buildNotchHandles()) {
        addTool(nh);
        pullHandles.push(nh);
    }
    // ★追加：棟の端のつまみ。屋根の形を引いて変えるための入口。
    for (const rh of buildRidgeHandles()) {
        addTool(rh);
        if (!rh.userData.decor) pullHandles.push(rh);
    }
    // ★追加：軒先のバー。屋根を選んでいるあいだ、辺ごとに出しっぱなし。
    {
        const sb = selectedRoofOwner();
        if (sb) {
            for (const eb of buildEaveBars(sb, (sb.y || 0) + sb.h)) {
                addTool(eb); pullHandles.push(eb);
            }
        }
    }
    // ★追加：下屋のつまみ。大屋根とまったく同じ道具立てにする。
    {
        const gb = selectedGeya();
        if (gb) {
            const y0 = (gb.y || 0) + gb.h;
            for (const eb of buildGeyaBars(gb, y0)) {
                addTool(eb); pullHandles.push(eb);
            }
            for (const sh of buildGeyaSlopeHandle(gb, y0)) {
                addTool(sh);
                if (!sh.userData.decor) pullHandles.push(sh);
            }
        }
    }
    // ★追加：パラペット修景屋根のつまみ。ここもスライダーではなくモデルの上で。
    {
        const pb = selectedPara();
        if (pb) {
            for (const ph of buildParaHandles(pb, (pb.y || 0) + pb.h)) {
                addTool(ph);
                if (!ph.userData.decor) pullHandles.push(ph);
            }
        }
    }
    // ★追加：屋上の平場のつまみ。棟の球とは別の役目なので形も色も分ける。
    for (const fh of (buildFlatHandle() || [])) {
        addTool(fh);
        if (!fh.userData.decor) pullHandles.push(fh);
    }

    // ★追加：外構作図モード中に建物を作り直したときは、半透明ゴーストを塗り直す
    //   （メッシュ・マテリアルは rebuild のたびに作り直されるため）
    applyExteriorGhost();

    if (window.renderAllViews) window.renderAllViews();
    // ★追加：メッシュを再構築した直後に、編集中の水色ハイライト状態を復元する
    if (window.triggerHighlightSync) window.triggerHighlightSync();
}

// ★追加：質感用の画像（砂壁調・杉板調の合成テクスチャ）の読み込みが完了したら再描画する
// （初回はまだ画像が読み込み中のため、テクスチャなしの状態で一度描画されることがある）
setOnTextureAssetsReady(() => rebuildMeshes());

// ==========================================
// ★追加：子アプリ（マンセル値シミュレーター）から返ってきた色・質感マップを
// 「建物ごと・階ごと・部位ごと」のマテリアル名（`${blockId}__${partKey}`）から解析し、
// AppState.buildingData に永続化する（保存・undo/redo・再描画のすべてで正しく維持されるようにする）
// ==========================================
function applyReturnedMunsellColors(colorMap, textureMap) {
    if (!colorMap && !textureMap) return;
    let changed = false;

    const applyMap = (map, targetField) => {
        if (!map) return;
        for (const matName in map) {
            // ★外構は建物とは別に持つ（下の applyExteriorMap で拾う）。ここでは飛ばす。
            if (matName.startsWith(EXT_MAT_PREFIX)) continue;

            const idx = matName.lastIndexOf('__');
            if (idx === -1) continue;
            const blockId = matName.slice(0, idx);
            const partKey = matName.slice(idx + 2);

            const b = AppState.buildingData.find(x => x.id === blockId);
            if (!b) continue;

            if (!b[targetField]) b[targetField] = {};
            b[targetField][partKey] = map[matName];
            changed = true;
        }
    };

    applyMap(colorMap, 'materialColors');
    applyMap(textureMap, 'materialTextures');

    // ★追加：外構（芝生・囲い・カーポート・樹木）の色。
    //   建物は「ブロックごと」に色を持つが、外構のマテリアルは地物の種類ごとの共有
    //   インスタンスなので、それを持っている exterior 側にまとめて覚えさせる
    //   （保存時は getExteriorColors で取り出す）。塗り直しも向こうがやる。
    const exteriorChanged = mergeExteriorColors(colorMap);

    if (changed) {
        AppState.saveState();
        UIController.updateActionButtons();
        rebuildMeshes();
    }
    if (changed || exteriorChanged) UIController.updateActionButtons();
}

// 履歴初期保存
AppState.saveState();

// ==========================================
// 3. インタラクションブリッジ ＆ ハンドラー初期化
// ==========================================
window.setMeshActiveMaterial = function(id) {
    if (meshMap[id]) meshMap[id].mesh.material = activeMat;
};
window.getHouseGroup = function() { return houseGroup; };
// ★追加：外構（芝生・囲い・カーポートなど）の入れ物。子アプリ（夜間景観）が
//   「モデリング画面に中身があるか」を判定するのに使う
window.getExteriorWorld = function() { return exteriorWorld; };
window.getEdgeMat = function() { return edgeMat; };

// ViewManagerの初期化
ViewManager.init({ scene, camera, renderer, houseGroup });
// ★追加：サブカメラ（決めた画角を1つ残す）。小窓は同じキャンバスの隅に描く。
SubCam.init({ scene, camera, renderer, controls,
    render: () => { if (window.renderAllViews) window.renderAllViews(); } });
// 面をなぞったときの橙色の板も【道具】。小窓には写さない。
markTool(hoverMesh);
window.toggleSubCam = function() {
    // ★ ボタンは【いまの画面を写し取る】。すでにあれば、その場で入れ替える。
    SubCam.capture();
};
window.renderAllViews = () => ViewManager.renderAllViews();

// InteractionHandlerの初期化
InteractionHandler.init({
    camera, scene, controls, hoverMesh, activeMat, rebuildMeshes, saveState,
    getInteractiveMeshes: () => interactiveMeshes,
    getPullHandles: () => pullHandles
});

// ==========================================
// ★追加：外構作図モードの初期化
//   本体アプリのシーン・カメラ・レンダラーをそのまま貸して、その上に
//   外構専用のレイヤー（照明・作図用の目印・地物の入れ物）を足す。
//   ・単位は本体が mm、外構の地物は m。境界は src/exterior/core/viewer.js
//   ・スナップ量はツールバーの「📏」と共有する
// ==========================================
initExterior({
    scene, camera, renderer, controls, houseGroup,
    render: () => { if (window.renderAllViews) window.renderAllViews(); },
    getSnapMM: () => InteractionHandler.getSnap(),
    setBuildingLocked: (v) => InteractionHandler.setLocked(v),
});
window.toggleExterior = toggleExterior;

// ==========================================================================
// ★追加：子アプリ（夜間景観・マンセル値・地球モード）へ渡す GLB の書き出し対象。
//   建物（houseGroup）に加えて、外構（芝生・囲い・カーポート・樹木）も一緒に渡す。
//   GLTFExporter は Object3D の配列を受け取れるので、シーングラフを組み替えずに済む。
// ==========================================================================
function getExportRoots() {
    // 外構作図モード中は建物が半透明ゴーストのままなので、書き出す前にモードを閉じて
    // 元のマテリアルへ戻す（透けた建物が子アプリへ渡ってしまうのを防ぐ）
    if (isExteriorActive()) exitExterior();

    const hasExterior = exteriorWorld && exteriorWorld.children.length > 0;
    if (!hasExterior) return houseGroup;

    // 子アプリ側は「マテリアル名」で色を扱うので、外構にも名前を付ける。
    // ※ 建物側の `${ブロックID}__${部位}` 形式とは別物とわかるよう ext__ を頭に付ける
    //   （マンセル側から戻ってきた色を、建物用と外構用に振り分けるのに使う）
    // ⚠️ 以前はここで `ext_<uuidの先頭8桁>` を付けていたが、uuid はページを開き直すたびに
    //   変わるので、02 で塗った色を保存しても次に開いたとき対応先が分からなくなっていた。
    //   読み込み直しても同じになる名前の付け方は exterior/core/paint.js を参照。
    nameExteriorMaterials();

    return [houseGroup, exteriorWorld];
}

// ==========================================
// ★追加：チュートリアルマネージャーの初期化と登録
// ==========================================
TutorialManager.init({
    camera: camera,
    controls: controls,
    scene: scene,
    rebuildMeshes: rebuildMeshes,
    activeMat: activeMat,
    edgeMat: edgeMat
});
window.TutorialManager = TutorialManager;

// (※不要になった裏側でのクリック連動処理はすべて綺麗に削除しました)

// ==========================================
// ★修正：画面サイズの追従
//   以前はカメラ操作（controls の change）でしか setSize していなかったため、
//   ウィンドウの大きさを変えてもキャンバスが古い寸法のままで、
//   画面の右端と下端が描画されない（切れて見える）状態になっていた。
//   → resize イベントで確実に合わせる。カメラ操作では再描画だけ行う。
//   ※ setMainAppVisibility はポータルから戻るときに resize を投げているので、
//     モードを行き来したあとのズレもこれで解消される。
// ==========================================
function handleResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    if (window.renderAllViews) window.renderAllViews();
}
window.addEventListener('resize', handleResize);
handleResize();   // 起動直後の食い違いもここで解消しておく

controls.addEventListener('change', () => {
    if (window.renderAllViews) window.renderAllViews();
});

// ツールバーボタン（HTML）用グローバルバインド
// ★追加：DXF の平面図を読み込んで、階として積む。
//   長方形を描くのと並ぶ【もうひとつの作図の仕方】であって、モードではない。
window.addDxfFloor = function() {
    window.setTool(null);
    askDxfFloor(() => { saveState(); rebuildMeshes(); });
};

// ★追加：取り込み／書き出しの入口。中身は src/io/ioMenu.js。
window.openIoMenu = function(btn) {
    window.setTool(null);
    openIoMenu(btn, {
        dxf: () => window.addDxfFloor(),
        model: () => askModelImport(() => {
            saveState();
            rebuildMeshes();
            UIController.updateActionButtons();
        }),
        glbBuilding: () => window.exportGlb('building'),
        glbAll: () => window.exportGlb('all'),
        copyImage: () => window.copyViewImage(),
    });
};

// ★追加：取り込んだモデルの後始末。控えも一緒に捨てないと、同じ id を
//   使い回したときに古い中身が出てくる。
window.dropModel = dropModel;

// ★追加：取り込んだモデルを消す（札のボタンから）。Delete と同じことをする。
window.deleteModel = function(id) {
    const b = AppState.buildingData.find((d) => d.id === id);
    if (!b || b.kind !== 'model') return;
    dropModel(id);
    AppState.buildingData = AppState.buildingData.filter((d) => d.id !== id);
    AppState.selectedId = null;
    AppState.selectedFaceDir = null;
    AppState.selectedPart = null;
    saveState();
    rebuildMeshes();
    UIController.hideFloatingMenu();
    UIController.clearGUI();
};

// ★追加：取り込んだモデルの大きさの読み替え（m と mm の取り違え）。
window.rescaleModel = function(id, k) {
    const b = AppState.buildingData.find((d) => d.id === id);
    if (!b || b.kind !== 'model') return;
    rescaleModel(b, k);
    saveState();
    rebuildMeshes();
    UIController.showBlockInfo(b);
};

/* ★追加：短い知らせ。コピーのように【画面が何も変わらない操作】は、
   これが無いと成功したのかどうか分からない。 */
function flashNote(text) {
    const el = document.createElement('div');
    el.style.cssText = 'position:fixed;left:50%;bottom:170px;transform:translateX(-50%);'
        + 'z-index:2000;background:rgba(33,37,41,.92);color:#fff;padding:8px 16px;'
        + 'border-radius:999px;font:12px/1.5 system-ui,sans-serif;pointer-events:none;'
        + 'opacity:0;transition:opacity .15s;';
    el.textContent = text;
    document.body.appendChild(el);
    requestAnimationFrame(() => { el.style.opacity = '1'; });
    setTimeout(() => {
        el.style.opacity = '0';
        setTimeout(() => el.remove(), 250);
    }, 1600);
}

// ★追加：いまの画面を絵にして、クリップボードへ入れる。
//   ★ PowerPoint や Word、メールにそのまま貼れる。
//   ⚠️ ブラウザから【3Dモデルとして】クリップボードに入れることはできない
//     （クリップボードに載せられるのは文字と絵だけ）。3D のまま渡したいときは
//     GLB で書き出して、PowerPoint の「挿入 ▸ 3D モデル」から読ませる。
//   ⚠️ 絵を取り出すには、描いた直後の画面が残っている必要がある
//     （init.js の preserveDrawingBuffer）。
window.copyViewImage = async function() {
    const keep = { id: AppState.selectedId, face: AppState.selectedFaceDir,
        part: AppState.selectedPart };
    // つまみや矢印が写り込まないよう、選択を外してから撮る。
    AppState.selectedId = null;
    AppState.selectedFaceDir = null;
    AppState.selectedPart = null;
    UIController.hideFloatingMenu();
    UIController.clearGUI();
    // ★ 小窓と四角錐は【道具】。資料に写ると建物の一部に見える。
    SubCam.beginPlainRender();
    rebuildMeshes();
    if (window.renderAllViews) window.renderAllViews();

    const shot = () => new Promise((res, rej) => {
        renderer.domElement.toBlob(
            (b) => (b ? res(b) : rej(new Error('画面を絵にできませんでした'))),
            'image/png');
    });
    try {
        // ⚠️ 撮り終わるのを待ってから write を呼ぶと「操作の直後ではない」と
        //   断られることがある。約束（Promise）のまま渡すのが作法。
        await navigator.clipboard.write([
            new ClipboardItem({ 'image/png': shot() })]);
        flashNote('画面を画像でコピーしました');
    } catch (e) {
        // ⚠️ クリップボードは、画面が前に出ていないと使えないことがある。
        //   そのときに何も起きないと、押した意味が分からない。絵はもう
        //   出来ているので、ファイルとして受け取れるようにする。
        console.warn(e);
        if (confirm('クリップボードに入れられませんでした。\n'
            + '（ほかの窓が前に出ているときなど）\n\n'
            + '画像ファイルとして保存しますか？')) {
            try {
                const blob = await shot();
                const a = document.createElement('a');
                a.download = 'view_' + new Date().toISOString()
                    .split('T')[0].replace(/-/g, '') + '.png';
                a.href = URL.createObjectURL(blob);
                a.click();
                URL.revokeObjectURL(a.href);
            } catch (e2) {
                console.warn(e2);
                alert('画面を絵にできませんでした。');
            }
        }
    }
    SubCam.endPlainRender();
    AppState.selectedId = keep.id;
    AppState.selectedFaceDir = keep.face;
    AppState.selectedPart = keep.part;
    rebuildMeshes();
};

// ★追加：GLB で書き出す。mode は 'building'（建物だけ）／'all'（外構も）。
//   ⚠️ 選んでいるものは【一度外してから】書き出す。外さないと、赤いつまみや
//     地面の矢印まで一緒に書き出されてしまう。
function glbFileName(mode) {
    const dateStr = new Date().toISOString().split('T')[0].replace(/-/g, '');
    return (mode === 'all' ? 'model_ext_' : 'model_') + dateStr + '.glb';
}

/* 取り込んだモデルが読み終わるのを待つ。
   ⚠️ 待たずに書き出すと、読み込み中のモデルは【代用の薄い箱】のまま
     ファイルに入る。大きいモデルほど起きやすい。 */
async function waitForModels(limitMs = 20000) {
    const t0 = Date.now();
    while (modelsPending() > 0 && Date.now() - t0 < limitMs) {
        await new Promise((r) => setTimeout(r, 100));
    }
}

/* GLB を作って Blob で返す。書き出しにも、画像のコピーにも使う。 */
async function buildGlbBlob(mode) {
    await waitForModels();
    return new Promise((resolve, reject) => {
        const keep = { id: AppState.selectedId, face: AppState.selectedFaceDir,
            part: AppState.selectedPart };
        AppState.selectedId = null;
        AppState.selectedFaceDir = null;
        AppState.selectedPart = null;
        UIController.hideFloatingMenu();
        UIController.clearGUI();
        rebuildMeshes();

        // 外構を含めるかどうかで、書き出す元を変える。
        if (isExteriorActive()) exitExterior();
        const roots = (mode === 'all') ? getExportRoots() : houseGroup;

        // ⚠️ 組み直した直後は、置き場所（position）は入っていても【行列】がまだ
        //   単位行列のまま。行列は画面を描くときに計算されるが、この画面は
        //   動きがあるときだけ描くので、組み直しただけでは計算されない。
        //   書き出しは行列を見るので、そのまま渡すと屋根も取り込んだモデルも
        //   【原点に潰れた】ファイルになる。ここで先に計算させておく。
        for (const r of (Array.isArray(roots) ? roots : [roots])) {
            r.updateMatrixWorld(true);
        }

        // ★ ボーン入りのモデルは、いまの姿のまま【ただのメッシュ】に固めてから
        //   書き出す。骨組みのまま渡すと、受け取るソフトによって位置がずれる。
        const unfreeze = freezeSkinned(roots);

        const restore = () => {
            unfreeze();
            AppState.selectedId = keep.id;
            AppState.selectedFaceDir = keep.face;
            AppState.selectedPart = keep.part;
            rebuildMeshes();
        };
        new GLTFExporter().parse(roots, (glb) => {
            restore();
            resolve(new Blob([glb], { type: 'model/gltf-binary' }));
        }, (err) => { restore(); reject(err); }, { binary: true });
    });
}

window.exportGlb = function(mode) {
    buildGlbBlob(mode).then((blob) => {
        const a = document.createElement('a');
        a.download = glbFileName(mode);
        a.href = URL.createObjectURL(blob);
        a.click();
        URL.revokeObjectURL(a.href);
    }).catch((err) => {
        console.error(err);
        alert('書き出せませんでした。');
    });
};

window.undo = undo;
window.redo = redo;
window.toggleSnap = function() {
    InteractionHandler.toggleSnap();
};

window.clearAll = function() {
    if(confirm('すべてのオブジェクトを消去しますか？')) {
        // ★ 取り込んだモデルの控えも捨てる（使われないまま場所を取り続ける）。
        dropAllModels();
        SubCam.remove();
        AppState.clearAll();
        clearExterior();          // ★追加：外構（芝生・フェンス・カーポートなど）も一緒に消す
        window.setTool(null);
        rebuildMeshes();
        UIController.hideFloatingMenu(); 
        UIController.updateStatusDisplay(InteractionHandler.getCurrentTool());
        UIController.updateActionButtons();
    }
};

// ---- PLATEAU 建物の編集（04 側の buildingedit.js）----------------------
//   ボタンの見た目だけこちらが持ち、実体は 04。👣（ストリートビュー）と同じ作法。
let isBuildingEditOn = false;
function applyBuildingEditButtonState() {
    const btn = document.getElementById('app1-buildingedit-toggle');
    if (!btn) return;
    btn.classList.toggle('active', isBuildingEditOn);
    btn.setAttribute('data-tooltip',
        isBuildingEditOn ? '🏢 建物の編集を終わる' : '🏢 PLATEAU 建物を編集する');
}
(function setupApp1BuildingEditToggle() {
    const btn = document.getElementById('app1-buildingedit-toggle');
    if (!btn) return;
    btn.addEventListener('click', () => {
        if (!isEarthModeActive) return;   // 地球モード以外では意味がない
        const iframe = document.getElementById('earth-sim-iframe');
        const win = iframe && iframe.contentWindow;
        if (!win || typeof win.toggleEarthBuildingEdit !== 'function') return;
        // ★ 先に他を終わらせる。あとから止めると、こちらのパネルまで
        //   一緒に畳まれてしまう場合がある。
        if (!isBuildingEditOn) stopOtherEarthModes('buildingedit');
        isBuildingEditOn = !!win.toggleEarthBuildingEdit();
        applyBuildingEditButtonState();
        updateBottomBar();
    });
    applyBuildingEditButtonState();
})();

// ==========================================
// 4. 地球モード（04_earth-simulator）への受け渡し
// ==========================================
// 既定の配置地点。京都駅前は高層の駅ビルに埋もれて自作モデルが見えないので、
// 開けていて分かりやすい市役所前広場を初期値にしている。
// （市役所の建物と重ならないよう、広場の中心から約30m南＝緯度 -0.00027°）
const DEFAULT_PLACE_LOCATION = { lat: 35.01129, lng: 135.76812 }; // 京都市役所前広場
window.lastPlacedLocation = { ...DEFAULT_PLACE_LOCATION };
window.lastPlacedHeading = 0; // ★追加：回転角度（ラジアン）の記憶用初期値

// ※ 地球モードの入口はツールバーのボタンから、下部パネルの「切り抜き」スライダーへ移した
//   （0 から動かすと起動する）。起動処理は openEarthSimulator。


// UIController初期化 ＆ 初回描画
UIController.init(rebuildMeshes, window.setTool);
if (window.renderAllViews) window.renderAllViews();

// ==========================================
// ★追加：JSONセーブ・ロード機能の実装
// ==========================================

// 地球モード（04）の検討内容を iframe から受け取る。
//   04 と 01 は同一オリジンなので、あちらが用意した window.getEarthEditState() を
//   そのまま呼べる（postMessage を待つ必要がない＝セーブを同期処理のままにできる）。
//   ⚠️ 地球モードを一度も開いていない／古い 04 が入っている場合もあるので、
//     取れなければ黙って null にする。ここでセーブ自体を失敗させてはいけない。
function readEarthState() {
    try {
        const frame = document.getElementById('earth-sim-iframe');
        if (!frame) return null;   // 地球モードを一度も開いていない＝残すものが無い
        const fn = frame.contentWindow && frame.contentWindow.getEarthEditState;
        if (typeof fn !== 'function') {
            // ⚠️ ここに来るのは、受け渡し口ができる前に作られた iframe が生き残っている場合。
            //   地球モードは「閉じても iframe を捨てずに隠すだけ」なので（タイルの読み直しを
            //   避けるため）、04 を更新しても開きっぱなしの iframe は古いままになる。
            //   黙って null にすると「何も保存されない」ようにしか見えないので、必ず知らせる。
            console.warn('地球モード側に受け渡し口（getEarthEditState）がありません。'
                + 'ページを再読み込みしてから地球モードを開き直してください。');
            return null;
        }
        return fn() || null;
    } catch (e) {
        console.warn('地球モードの検討内容を取得できませんでした', e);
        return null;
    }
}

// ロードで読み込んだ地球モードの検討内容の控え。
//   ⚠️ ロード時点では地球モードがまだ開かれていないことの方が多く、開いていても
//     タイルの読み込みが終わっていない。すぐ送っても当てる先が無いので、ここへ
//     預けておき「地球側の準備ができた」合図（showEarthSimulator）で送る。
let pendingEarthState = null;
// 送り済みかどうか。開き直すたびに送り直さないための目印。
let earthStateApplied = true;

// 控えてある検討内容を地球モードへ送る。まだ開いていなければ何もしない。
function pushEarthState() {
    if (earthStateApplied) return;
    const frame = document.getElementById('earth-sim-iframe');
    const fn = frame && frame.contentWindow && frame.contentWindow.applyEarthEditState;
    if (typeof fn !== 'function') return;   // まだ準備できていない。次の機会に送る
    try {
        fn(pendingEarthState);
        earthStateApplied = true;
    } catch (e) {
        console.warn('地球モードへ検討内容を反映できませんでした', e);
    }
}

// ■ セーブ処理
document.getElementById('btn-save-json').addEventListener('click', () => {
    // セーブ中、一時的にGUIやメニューを隠してクリーンな状態にする
    UIController.clearGUI();
    UIController.hideFloatingMenu();

    // 保存するJSONデータ全体のパッケージング
    const saveData = {
        version: "1.0", // 将来のマイグレーション用バージョン
        savedAt: new Date().toISOString(),
        appState: {
            buildingData: AppState.buildingData
        },
        // ※ キー名 cesiumState は旧・地球モード（Cesium）時代のもの。中身は今の地球モードでも
        //   そのまま使う（配置地点と向き）ので、既存のセーブデータを読めるよう名前は変えない。
        cesiumState: {
            lastPlacedLocation: window.lastPlacedLocation,
            lastPlacedHeading: window.lastPlacedHeading // 地球上でのモデルの回転角度
        },
        // ★追加：外構（地面・囲い・外構・樹木）の配置。地物の種類・位置(m)・寸法パラメータだけを持つ
        exteriorState: {
            items: serializeExterior(),
            // ★追加：02 で塗った外構の色（マテリアル名 → #rrggbb）。
            //   地物ごとではなく種類ごとの共有マテリアルなので、配置とは別に1つのマップで持つ。
            colors: getExteriorColors()
        },
        // ★追加：地球モード（04）での検討内容。
        //   PLATEAU 建物の高さ変更・壁面後退・置いた箱を、緯度経度付きで残す。
        //   地球モードを開いていなければ null（キーは残す＝あとから読む側の分岐が減る）。
        earthState: readEarthState(),
        // ★追加：サブカメラ（1台）。位置・注視点・焦点距離だけの軽い中身。
        subCamera: SubCam.serialize()
    };

    // Blobオブジェクトを作成し、ローカルへファイルとしてダウンロード
    const blob = new Blob([JSON.stringify(saveData, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    
    // ファイル名に今日の日付を付与 (例: modeling_state_20260523.json)
    const dateStr = new Date().toISOString().split('T')[0].replace(/-/g, '');
    a.download = `modeling_state_${dateStr}.json`;
    a.href = url;
    a.click();
    
    URL.revokeObjectURL(url);
});

// ■ ロード処理
const btnLoadJson = document.getElementById('btn-load-json');
const inputLoadJson = document.getElementById('input-load-json');

btnLoadJson.addEventListener('click', () => {
    // 地球モードの表示中は誤動作を防ぐため実行させない
    if (isEarthModeActive) {
        alert('ロード処理はモデリング画面でのみ実行可能です。一度戻ってからロードしてください。');
        return;
    }

    if (confirm('現在の作業内容は上書き消去されます。JSONファイルをロードしますか？')) {
        inputLoadJson.click(); // 隠されている <input type="file"> を発火
    }
});

inputLoadJson.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
        try {
            const json = JSON.parse(event.target.result);
            
            // 最低限必要なモデリングデータの器が存在するかチェック
            if (!json.appState || !json.appState.buildingData) {
                throw new Error('不適切なファイル形式か、データが破損しています。');
            }

            // 1. AppStateへデータを流し込み（マイグレーション含む）
            AppState.loadState(json.appState.buildingData, json.version || "1.0");

            // 2. 地球上での配置・回転設定の復元
            if (json.cesiumState) {
                if (json.cesiumState.lastPlacedLocation) {
                    window.lastPlacedLocation = json.cesiumState.lastPlacedLocation;
                }
                if (json.cesiumState.lastPlacedHeading !== undefined) {
                    window.lastPlacedHeading = json.cesiumState.lastPlacedHeading;
                }
            } else {
                // 地球モードの設定が含まれない古いデータの場合は安全に初期化
                window.lastPlacedLocation = { ...DEFAULT_PLACE_LOCATION };
                window.lastPlacedHeading = 0;
            }

            // ★追加：3. 外構の復元（含まれない古いデータなら空にする）
            restoreExterior(json.exteriorState && json.exteriorState.items);
            // ★追加：外構の色も戻す。地物を組み立て終わってから当てること
            //   （マテリアルは地物を作った時点で生まれるため、順序を逆にすると当たらない）。
            restoreExteriorColors(json.exteriorState && json.exteriorState.colors);

            // ★追加：5. 地球モード（04）の検討内容。
            //   含まれない古いデータなら null＝地球モード側もまっさらに戻す。
            // ★追加：サブカメラ。持っていない古いデータなら「無し」に戻す。
            SubCam.restore(json.subCamera || null);

            pendingEarthState = json.earthState || null;
            earthStateApplied = false;
            pushEarthState();   // すでに地球モードが立ち上がっていればその場で当たる

            // 4. 各種3DメッシュとUIパネルの同期・再描画
            UIController.clearGUI();
            UIController.hideFloatingMenu();
            rebuildMeshes(); // Three.jsシーンを完全再構築
            
            // ボタンの活性・非活性状態やステータス表示の更新
            UIController.updateActionButtons();
            UIController.updateStatusDisplay(InteractionHandler.getCurrentTool());

            alert('作業状態を正常にロードしました。');
        } catch (err) {
            alert('ロードに失敗しました:\n' + err.message);
        }
        
        // 連続で同じファイルを読み込めるように選択内容をクリア
        inputLoadJson.value = '';
    };
    reader.readAsText(file);
});

// ==========================================
// ★変更：夜間シミュレーター起動処理（main.js側は起動制限を解除するだけ）
// ==========================================
let isNightModeActive = false;

// 時刻スライダーで 09:00 に当たる位置[%]（この位置から夜間シミュレーターが動き出す）
const NIGHT_START_PCT = 13.636;

// スライダーを 0（＝そのモードの終了）まで下げてよいか。単独起動中だけ false になる。
//   ⚠️ 下のスライダー初期化（updateSliderUI）が読むので、必ずそれより前で宣言すること。
let clipSliderZeroAllowed = true;
let timeSliderZeroAllowed = true;

function openNightSimulation(initialSliderPct = NIGHT_START_PCT, fromPortal = false) {
    if (isNightModeActive) return; 
    
    // アプリ2起動時に「チュートリアルを開始」ボタンを隠す
    const tutorialBtn = document.getElementById('btn-start-tutorial');
    if (tutorialBtn) tutorialBtn.style.display = 'none';

    // ★修正：「着色モードへ」ボタンの正しいIDを指定し、確実にクリックを無効化する
    const munsellBtn = document.getElementById('app1-munsell-btn');
    if (munsellBtn) {
        munsellBtn.style.pointerEvents = 'none'; // 物理的にクリック不能にする
        munsellBtn.style.opacity = '0.4';
    }

    isNightModeActive = true;
    document.body.classList.add('night-mode');
    updateBottomBar();   // 地球モードの切り抜きスライダーを止める

    // スライダー位置を保存
    sessionStorage.setItem('sharedSliderValue', initialSliderPct.toString());
    
    // マテリアルに名前をつけて保持（夜間側で個別に色を扱うため）
    houseGroup.traverse(child => {
        if (child.isMesh && child.material) {
            const mat = Array.isArray(child.material) ? child.material[0] : child.material;
            if (!mat.name) mat.name = 'mat_' + mat.uuid.substring(0, 8);
        }
    });

    if (fromPortal) {
        // ★ポータルから起動時は現在のモデルのGLBパッキングをスキップ
        sessionStorage.removeItem('night_custom_glb');
        proceedOpenNightIframe(initialSliderPct, true);
    } else {
        // ★通常（モデリング画面）から起動時は現在のモデルをパッキング（外構も含む）
        const exporter = new GLTFExporter();
        exporter.parse(getExportRoots(), (glb) => {
            const blob = new Blob([glb], { type: 'application/octet-stream' });
            const glbUrl = URL.createObjectURL(blob);
            sessionStorage.setItem('night_custom_glb', glbUrl);
            
            // パッキング完了後に実際のiframe立ち上げに移行
            proceedOpenNightIframe(initialSliderPct, false);
        }, (err) => console.error(err), { binary: true });
    }
}

// iframe生成とカメラスナップの後半処理を分離
// --- [main.js 内の proceedOpenNightIframe を以下に丸ごと差し替えてください] ---
function proceedOpenNightIframe(initialSliderPct, fromPortal = false) {
    const cameraState = {
        position: camera.position.toArray(),
        target: controls.target.toArray(),
        fov: camera.fov 
    };
    sessionStorage.setItem('sharedCameraState', JSON.stringify(cameraState));
    
    const app1Slider = document.getElementById('app1-time-slider-container');
    if (app1Slider) app1Slider.style.zIndex = '10000';

    let iframe = document.getElementById('night-sim-iframe');
    if (!iframe) {
        iframe = document.createElement('iframe');
        iframe.id = 'night-sim-iframe';
        iframe.style.position = 'absolute';
        iframe.style.top = '0';
        // 以下は下の条件分岐で動的に設定するため、ここでは最低限のスタイルのみ記述
        iframe.style.height = '100%';
        iframe.style.border = 'none';
        iframe.style.zIndex = '5000';
        iframe.style.opacity = '0';
        iframe.style.transition = 'opacity 0.3s ease-out';
        document.body.appendChild(iframe);
    }
    
    // ★追加：全画面描画に伴い、モデリング画面からの連携時も画面いっぱいに iframe を広げるように統一します
    iframe.style.left = '0';
    iframe.style.width = '100%';
    /* 以前のサブ画面回避用の処理は不要になったため廃止
    if (fromPortal) {
        iframe.style.left = '0';
        iframe.style.width = '100%';
    } else {
        iframe.style.left = '37.5vh';
        iframe.style.width = 'calc(100% - 37.5vh)';
    }
    */
    
    iframe.style.opacity = '0'; 
    // 起動元に応じて、夜間側の画面にパラメータを付与してロード
    const urlParam = fromPortal ? '?from=portal' : '?from=modeling';
    iframe.src = `./night-api/${urlParam}`;
    iframe.style.display = 'block';
}
// ★追加：アプリ2から「描画完了」の合図を受け取って透明化を解除する
window.showNightSimulation = function() {
    const iframe = document.getElementById('night-sim-iframe');
    if (iframe) {
        iframe.style.opacity = '1'; // フワッと表示させる
    }
};

// 夜間シミュレーター側から安全に閉じるためのグローバル関数
window.closeNightSimulation = function() {
    isNightModeActive = false;
    document.body.classList.remove('night-mode');
    updateBottomBar();

    // アプリ2起動時に「チュートリアルを開始」ボタンを隠す
    const tutorialBtn = document.getElementById('btn-start-tutorial');
    if (tutorialBtn) tutorialBtn.style.display = '';

    // ★修正：正しいIDを指定し、ロックと半透明を解除する
    const munsellBtn = document.getElementById('app1-munsell-btn');
    if (munsellBtn) {
        munsellBtn.style.pointerEvents = '';
        munsellBtn.style.opacity = '';
    }

    const iframe = document.getElementById('night-sim-iframe');
    if (iframe) {
        if (iframe.contentWindow && iframe.contentWindow.camera && iframe.contentWindow.controls) {
            const cam2 = iframe.contentWindow.camera;
            const ctrl2 = iframe.contentWindow.controls;
            const updatedCameraState = {
                position: [cam2.position.x * 1000, cam2.position.y * 1000, cam2.position.z * 1000],
                target: [ctrl2.target.x * 1000, ctrl2.target.y * 1000, ctrl2.target.z * 1000]
            };
            sessionStorage.setItem('sharedCameraState', JSON.stringify(updatedCameraState));
        }

        iframe.style.opacity = '0'; 
        setTimeout(() => {
            iframe.style.display = 'none';
            iframe.src = 'about:blank'; 
        }, 300);
    }
    
    // カメラ位置の復元
    const sharedCameraState = sessionStorage.getItem('sharedCameraState');
    if (sharedCameraState) {
        try {
            const camData = JSON.parse(sharedCameraState);
            camera.position.fromArray(camData.position);
            controls.target.fromArray(camData.target);
            controls.update();
        } catch (e) {
            console.error('カメラデータの復元に失敗しました', e);
        }
    }

    // アプリ1のスライダーを「陰影なし(0)」の位置にリセット
    const timeSlider = document.getElementById('app1-time-slider');
    const timeDisplay = document.getElementById('app1-time-display');
    if (timeSlider) timeSlider.value = 0;
    if (timeDisplay) timeDisplay.textContent = "陰影なし";
    setNightLamp(false);   // 🌃ランプも消す（ここは input を発火させないので手で戻す）
};

// ==========================================
// ★追加：アプリ1 時刻スライダーのダミー制御ロジック (アプリ2完全準拠)
// ==========================================
(function setupApp1TimeSlider() {
    const timeSlider = document.getElementById('app1-time-slider');
    const timeDisplay = document.getElementById('app1-time-display');
    const ticksContainer = document.getElementById('app1-slider-ticks');

    if (!timeSlider) return;

    // アプリ2と同じ比率の目盛り位置
    const tickPercentages = [
        0, 13.636, 13.636 + 9.091 * 1, 13.636 + 9.091 * 2, 13.636 + 9.091 * 3, 13.636 + 9.091 * 4, 13.636 + 9.091 * 5, 13.636 + 9.091 * 6, 13.636 + 9.091 * 7, 13.636 + 9.091 * 8, 100                                                 
    ];

    // 目盛りの生成
    tickPercentages.forEach(pct => {
        const tick = document.createElement('div');
        tick.className = 'tick';
        tick.style.left = `${pct}%`; 
        ticksContainer.appendChild(tick);
    });

    // スライダーの％から時刻(数値)へ変換するロジック（アプリ2完全同期）
    function convertSliderPctToTime(pct) {
        if (pct <= tickPercentages[0]) return 8.0;
        if (pct >= tickPercentages[10]) return 18.0; 
        
        if (pct < tickPercentages[1]) {
            return 8.0 + (pct - tickPercentages[0]) / (tickPercentages[1] - tickPercentages[0]);
        }
        if (pct > tickPercentages[9]) {
            return 17.0 + (pct - tickPercentages[9]) / (tickPercentages[10] - tickPercentages[9]);
        }
        
        for (let i = 1; i <= 8; i++) {
            if (pct >= tickPercentages[i] && pct <= tickPercentages[i+1]) {
                const baseHour = 8.0 + i; 
                const segmentProgress = (pct - tickPercentages[i]) / (tickPercentages[i+1] - tickPercentages[i]);
                return baseHour + segmentProgress;
            }
        }
        return 18.0;
    }

    // スライダー更新時の表示反映
    function updateSliderUI() {
        let pct = parseFloat(timeSlider.value);
        
        // ★夜間シミュレーターの単独起動中は「陰影なし(0)」に戻せない（終了させないため）。
        //   0 の側へ寄せても 09:00 の位置に吸い付かせる。
        if (!timeSliderZeroAllowed && pct < NIGHT_START_PCT) {
            pct = NIGHT_START_PCT;
            timeSlider.value = pct;
        }
        // ★アプリ2と同様のスナップ処理（カクっと動かす）
        else if (pct > 0 && pct < 13.636) {
            pct = pct < 6.818 ? 0 : 13.636;
            timeSlider.value = pct;
        }
        else if (pct > 86.364 && pct < 100) {
            pct = pct < 93.182 ? 86.364 : 100;
            timeSlider.value = pct;
        }

        // 左端の🌃ランプ：スライダーが 0 から動いている＝夜間シミュレーターが動いている
        setNightLamp(pct > 0);

        // 09:00 (13.636%) 以上になったら自動的にアプリ2を起動、または時間を送る
        if (pct >= 13.636) {
            if (!isNightModeActive) {
                openNightSimulation(pct); // 起動
            } else {
                // 起動済みなら、裏側のiframeにリアルタイムに時間を送る
                const iframe = document.getElementById('night-sim-iframe');
                if (iframe && iframe.contentWindow && typeof iframe.contentWindow.setSimulationTime === 'function') {
                    iframe.contentWindow.setSimulationTime(pct);
                }
            }
        } else if (pct === 0) {
            // 陰影なし(0)に戻ったらアプリ1へ戻る（閉じる）処理もここで一元管理
            if (isNightModeActive) {
                window.closeNightSimulation();
            }
        }

        const calculatedTime = convertSliderPctToTime(pct);

        // 時刻テキストの更新
        if (timeDisplay) {
            if (calculatedTime < 8.5) {
                timeDisplay.textContent = "陰影なし";
            } else if (calculatedTime > 17.5) {
                timeDisplay.textContent = "夜間照明";
            } else {
                const h = Math.floor(calculatedTime);
                const m = Math.floor((calculatedTime % 1) * 60);
                timeDisplay.textContent = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
            }
        }
    }

    // イベントリスナーの登録
    timeSlider.addEventListener('input', updateSliderUI);

    // ★左端の🌃ボタンでオンオフする（スライダーの近道）。
    //   起動・終了・ランプ・時刻表示の判定はすべて updateSliderUI が持っているので、
    //   ここではスライダーの値を動かして同じ処理へ流すだけにする（判定を二重に書かない）。
    //   ・オフ（0）→ 09:00 の位置（＝夜間シミュレーターが起動する最初の位置）へ
    //   ・オン（0より右）→ 0（陰影なし）へ戻して終了
    //   ※ 夜間シミュレーターの単独起動中は 0 に戻せない決まりだが、その差し戻しも
    //     updateSliderUI が行うので、ここで気にする必要はない。
    const nightBtn = document.getElementById('app1-night-lamp');
    if (nightBtn) {
        nightBtn.addEventListener('click', () => {
            timeSlider.value = parseFloat(timeSlider.value) > 0 ? 0 : NIGHT_START_PCT;
            updateSliderUI();
        });
    }

    // 初期化 (アプリ2に合わせて 0% 陰影なしスタート)
    timeSlider.value = 0;
    updateSliderUI();
})();

// 切り抜きスライダーの上限（500＝04側の CLIP_SIZE_MAX）を超えた1段分＝「全体表示」を表す値。
//   04 側（js/ui.js の setClipSizeFromParent）も、箱の上限を超える値が来たら
//   同じ意味（全体表示＝切り抜きなし）に解釈するようにしてある。変えるなら両方直すこと。
const APP1_CLIP_MAX_SIZE = 500, APP1_CLIP_FULL_SIZE = 550;
// 切り抜きの下限（＝地球モードをオンにしたときの最初の大きさ）。🌐ボタンでオンにするときも
// スライダーをここへ動かす。
const APP1_CLIP_MIN_SIZE = 50;

// ==========================================
// ★追加：地球モードの「切り抜き」スライダー（時刻スライダーの右隣）
//   0＝地球モードなし。50m以上に動かすと地球モードが起動し、その大きさで中心を切り抜く。
//   起動中に動かせば、そのまま地球側へ大きさを送る（時刻スライダーと同じ作法）。
// ==========================================
(function setupApp1ClipSlider() {
    const slider = document.getElementById('app1-clip-slider');
    const display = document.getElementById('app1-clip-display');
    const ticks = document.getElementById('app1-clip-ticks');
    if (!slider) return;

    // 04 側の切り抜き（50〜500m・10m刻み）に合わせる。0 だけが「地球モードなし」。
    const MIN_SIZE = APP1_CLIP_MIN_SIZE, MAX_SIZE = APP1_CLIP_MAX_SIZE, FULL_SIZE = APP1_CLIP_FULL_SIZE, TICK_STEP = 50;

    // 目盛り（0・50・…・500）＋ 最後にもう1つ、全体表示の目印（太い目盛り）
    if (ticks) {
        for (let v = 0; v <= MAX_SIZE; v += TICK_STEP) {
            const tick = document.createElement('div');
            tick.className = 'tick';
            tick.style.left = `${(v / FULL_SIZE) * 100}%`;
            ticks.appendChild(tick);
        }
        const fullTick = document.createElement('div');
        fullTick.className = 'tick full';
        fullTick.style.left = '100%';
        ticks.appendChild(fullTick);
    }

    function sendSizeToEarth(size) {
        const iframe = document.getElementById('earth-sim-iframe');
        const win = iframe && iframe.contentWindow;
        if (win && typeof win.setEarthClipSize === 'function') win.setEarthClipSize(size);
    }

    function onSliderInput() {
        let raw = Number(slider.value);
        // 500 を超えたところを触った瞬間に、中間値を作らず最後（全体表示）へカクッと
        // 吸い付かせる。50刻みの続きのような曖昧な位置を作らないための処置。
        if (raw > MAX_SIZE) {
            raw = FULL_SIZE;
            slider.value = String(raw);
        }
        let size = raw;
        // 0 の次は 50m（04 の切り抜きの下限）。間の値はつまみごと 50 に吸い付かせて、
        // 目盛りの位置と実際の大きさが食い違わないようにする。
        // ★地球モードの単独起動中は 0（終了）も許さないので、0 まで下げても 50 に戻す。
        const floor = clipSliderZeroAllowed ? 0 : MIN_SIZE;
        if (size < MIN_SIZE && (size > 0 || floor === MIN_SIZE)) {
            size = MIN_SIZE;
            slider.value = String(size);
        }
        updateClipPanelDisplay(size);

        if (size === 0) {
            // 0 に戻したら地球モードを終了（時刻スライダーを「陰影なし」に戻すのと同じ）
            if (isEarthModeActive && typeof window.closeEarthSimulator === 'function') {
                window.closeEarthSimulator();
            }
            return;
        }

        if (!isEarthModeActive) {
            pendingEarthClipSize = size;   // 準備ができ次第送る
            openEarthSimulator(false);
        } else {
            sendSizeToEarth(size);
        }
    }

    slider.addEventListener('input', onSliderInput);

    // ★左端の🌐ボタンでオンオフする（時刻パネルの🌃と同じ作法）。
    //   起動・終了・大きさの送信はすべて onSliderInput が持っているので、ここでは
    //   スライダーの値を動かして同じ処理へ流すだけにする。
    //   ・オフ（0）→ 50m（切り抜きの下限＝地球モードが起動する最初の大きさ）へ
    //   ・オン（0より右）→ 0（地球なし）へ戻して終了
    //   ※ 地球モードの単独起動中は 0 に戻せない決まりだが、その差し戻しは onSliderInput が行う。
    const earthBtn = document.getElementById('app1-earth-lamp');
    if (earthBtn) {
        earthBtn.addEventListener('click', () => {
            slider.value = Number(slider.value) > 0 ? '0' : String(MIN_SIZE);
            onSliderInput();
        });
    }

    slider.value = '0';
    updateClipPanelDisplay(0);
})();

// ==========================================
// ★追加：東西30km断面のオン・オフ（切り抜きスライダーの右のボタン）
//   地球モード中だけ押せる。地球側の表示状態を持ち主とし、こちらはボタンの見た目を
//   合わせるだけ（地球側が実際に開いたときに getEarthProfileOn() で現在値を取りに行く）。
// ==========================================
let isProfileOn = false;
// 地球側で断面を閉じたとき（パネルの「×」など、こちらのボタンを経由しない操作）に
// ボタンの見た目だけ合わせる。window.syncEarthClipSize と同じ作法。
window.syncEarthProfileOn = function(on) {
    isProfileOn = !!on;
    applyProfileButtonState();
};
function applyProfileButtonState() {
    const btn = document.getElementById('app1-profile-toggle');
    if (!btn) return;
    btn.classList.toggle('active', isProfileOn);
    btn.setAttribute('data-tooltip', isProfileOn ? '断面を非表示にする' : '東西断面を表示する');
}
// ⛰ 地形断面 / 👣 ストリートビュー / 🏢 建物編集 は【同時には使わない】。
//   どれかを始めたら、他は終わらせる。
//   ⚠️ 3つとも「地球モードの上に別の見せ方を重ねる」道具で、重ねると
//     どのモードにいるのか分からなくなる（断面を見ながら建物を選ぼうとして
//     選べない、といった行き違いが起きる）。
//   except に「これから始めるもの」を渡す。
function stopOtherEarthModes(except) {
    const iframe = document.getElementById('earth-sim-iframe');
    const win = iframe && iframe.contentWindow;
    if (!win) return;
    if (except !== 'profile' && isProfileOn && typeof win.setEarthProfileOn === 'function') {
        isProfileOn = false;
        win.setEarthProfileOn(false);
        applyProfileButtonState();
    }
    if (except !== 'buildingedit' && isBuildingEditOn
        && typeof win.toggleEarthBuildingEdit === 'function') {
        win.toggleEarthBuildingEdit();          // ON のときに呼べば OFF になる
        isBuildingEditOn = false;
        applyBuildingEditButtonState();
    }
    if (except !== 'streetview' && isStreetViewOn
        && typeof win.toggleEarthStreetView === 'function') {
        isStreetViewOn = !!win.toggleEarthStreetView();
        if (!isStreetViewOn) restoreClipSizeAfterStreetView();
        applyStreetViewButtonState();
    }
    updateBottomBar();
}

(function setupApp1ProfileToggle() {
    const btn = document.getElementById('app1-profile-toggle');
    if (!btn) return;
    btn.addEventListener('click', () => {
        if (!isEarthModeActive) return;   // 地球モード以外では意味がない（膜で押せなくもしてある）
        const iframe = document.getElementById('earth-sim-iframe');
        const win = iframe && iframe.contentWindow;
        if (!win || typeof win.setEarthProfileOn !== 'function') return;
        isProfileOn = !isProfileOn;
        if (isProfileOn) stopOtherEarthModes('profile');
        win.setEarthProfileOn(isProfileOn);
        applyProfileButtonState();
        updateBottomBar();
    });
    applyProfileButtonState();
})();

// ==========================================
// ★追加：ストリートビュー（道路に降りて歩く）のボタン。地形断面ボタンの右隣。
//   実体は 04 側の js/streetview.js。こちらはボタンの見た目と呼び出しだけを持つ
//   （地形断面の app1-profile-toggle と同じ作法）。
// ==========================================
let isStreetViewOn = false;
// ストリートビューに入る直前の切り抜きの大きさ（抜けるときに戻す）
let clipSizeBeforeStreetView = null;
function restoreClipSizeAfterStreetView() {
    const cs = document.getElementById('app1-clip-slider');
    if (!cs || clipSizeBeforeStreetView === null) return;
    if (cs.value !== clipSizeBeforeStreetView) {
        cs.value = clipSizeBeforeStreetView;
        cs.dispatchEvent(new Event('input', { bubbles: true }));
    }
    clipSizeBeforeStreetView = null;
}
// 04 側で Esc で抜けたとき（こちらのボタンを経由しない操作）に見た目だけ合わせる
window.syncEarthStreetView = function(on) {
    isStreetViewOn = !!on;
    if (!isStreetViewOn) restoreClipSizeAfterStreetView();
    applyStreetViewButtonState();
    updateBottomBar();
};
function applyStreetViewButtonState() {
    const btn = document.getElementById('app1-streetview-toggle');
    if (!btn) return;
    btn.classList.toggle('active', isStreetViewOn);
    btn.setAttribute('data-tooltip', isStreetViewOn ? '👣 ストリートビューを終わる' : '👣 道路に降りて歩く');
}
(function setupApp1StreetViewToggle() {
    const btn = document.getElementById('app1-streetview-toggle');
    if (!btn) return;
    btn.addEventListener('click', () => {
        if (!isEarthModeActive) return;   // 地球モード以外では意味がない
        const iframe = document.getElementById('earth-sim-iframe');
        const win = iframe && iframe.contentWindow;
        if (!win || typeof win.toggleEarthStreetView !== 'function') return;
        // ★入るときは箱庭をやめて全体表示にする。
        //   切り抜きの箱が小さいと、その外の道路には降りられず歩いても壁で止まるため。
        //   入る前の大きさを覚えておいて、抜けるときに戻す。
        if (!isStreetViewOn) {
            stopOtherEarthModes('streetview');
            const cs = document.getElementById('app1-clip-slider');
            if (cs) {
                clipSizeBeforeStreetView = cs.value;
                if (Number(cs.value) !== APP1_CLIP_FULL_SIZE) {
                    cs.value = String(APP1_CLIP_FULL_SIZE);
                    cs.dispatchEvent(new Event('input', { bubbles: true }));
                }
            }
        }
        isStreetViewOn = !!win.toggleEarthStreetView();
        if (!isStreetViewOn) restoreClipSizeAfterStreetView();
        applyStreetViewButtonState();
        updateBottomBar();   // スライダーと断面ボタンの膜を掛け外しする
    });
    applyStreetViewButtonState();
})();

// ==========================================
// ★変更：マンセル値シミュレーターのデータ連携付き起動
// ==========================================
let isMunsellModeActive = false;

function openMunsellIframe(fromPortal = false) {
    // 起動時にメインアプリ側の各UIを隠す
    const tutorialBtn = document.getElementById('btn-start-tutorial');
    if (tutorialBtn) tutorialBtn.style.display = 'none';

    // ★修正：スライダーコンテナごと隠すのをやめ、スライダー部分だけをグレーアウト（無効化）します
    const sliderInner = document.querySelector('#app1-time-slider-container .slider-ui-inner');
    if (sliderInner) sliderInner.classList.add('slider-disabled');

    // ★追加：🎨ボタンを「へこみ状態（ON）」にします
    const munsellBtn = document.getElementById('app1-munsell-btn');
    if (munsellBtn) {
        munsellBtn.classList.add('active');
        // マンセル起動中（着色モードON）なので、次はモデリングに戻る案内を出す
        munsellBtn.setAttribute('data-tooltip', '✏️ モデリングモードへ');
    }

    // ==========================================
    // ★追加：メイン画面のカメラ状態をセッションに保存（マンセル画面へ渡す用）
    // ==========================================
    const cameraState = {
        position: camera.position.toArray(),
        target: controls.target.toArray()
    };
    sessionStorage.setItem('munsellCameraState', JSON.stringify(cameraState));

    let iframe = document.getElementById('munsell-sim-iframe');
    // 送信処理はここから削除し、子画面からの応答待ち（下のイベントリスナー）に移譲します
    if (!iframe) {
        iframe = document.createElement('iframe');
        iframe.id = 'munsell-sim-iframe';
        iframe.style.position = 'absolute';
        iframe.style.top = '0';
        iframe.style.left = '0';
        iframe.style.width = '100%';
        iframe.style.height = '100%';
        iframe.style.border = 'none';
        iframe.style.zIndex = '5000';
        iframe.style.opacity = '0';
        iframe.style.transition = 'opacity 0.3s ease-out';
        document.body.appendChild(iframe);
    }
    
    // 起動元に応じて、マンセル側の画面にパラメータを付与してロード
    const urlParam = fromPortal ? '?from=portal' : '?from=modeling';
    iframe.src = `./munsell-api/${urlParam}`;
    iframe.style.display = 'block';
    setTimeout(() => { iframe.style.opacity = '1'; }, 50);
}

// ==========================================================================
// ★追加：子アプリ（マンセル値シミュレーター）へエクスポートする直前に、
// このアプリ側の簡易テクスチャ（.map）を一時的に取り外す。
// 理由：ここで焼き込んだ簡易テクスチャをそのままGLBに含めてしまうと、
// マンセル側で再度読み込んだ際に本来のシェーダー質感より優先されて表示されてしまうため。
// マンセル側へは「どの部位がどの質感か」だけを別途 sessionStorage で伝え、
// マンセル側自身の質感描画で正しく再構築してもらう。
// ==========================================================================
function stripPartTexturesForExport(root) {
    const restoreList = [];
    root.traverse(obj => {
        if (obj.isMesh && obj.material) {
            const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
            mats.forEach(m => {
                if (m && m.userData && m.userData.isClonedPartMaterial && m.map) {
                    restoreList.push({ mat: m, map: m.map });
                    m.map = null;
                    m.needsUpdate = true;
                }
            });
        }
    });
    return () => {
        restoreList.forEach(({ mat, map }) => { mat.map = map; mat.needsUpdate = true; });
    };
}

function collectMaterialTextureHints() {
    const hints = {};
    AppState.buildingData.forEach(b => {
        if (!b.materialTextures) return;
        for (const partKey in b.materialTextures) {
            const texType = b.materialTextures[partKey];
            if (texType && texType !== 'none') {
                hints[`${b.id}__${partKey}`] = texType;
            }
        }
    });
    return hints;
}

function toggleMunsellSimulator(fromPortal = false) {
    if (isEarthModeActive) return;   // 地球モード表示中は着色モードへ入らせない

    if (!isMunsellModeActive) {
        isMunsellModeActive = true;
        updateBottomBar();

        if (fromPortal) {
            // ★ ポータルからの起動時：現在のモデルのパッキングをスキップ
            sessionStorage.removeItem('munsell_custom_glb');
            sessionStorage.removeItem('munsell_initial_textures');
            openMunsellIframe(true);
        // ★変更：建物が無くても外構だけ置かれていれば書き出す
        } else if (AppState.buildingData.length > 0 || exteriorWorld.children.length > 0) {
            houseGroup.traverse(child => {
                if (child.isMesh && child.material) {
                    const mat = Array.isArray(child.material) ? child.material[0] : child.material;
                    if (!mat.name) mat.name = 'mat_' + mat.uuid.substring(0, 8);
                }
            });

            // ★追加：質感ヒントをマンセル側へ引き継ぐ（GLB本体には焼き込まない）
            sessionStorage.setItem('munsell_initial_textures', JSON.stringify(collectMaterialTextureHints()));

            const restoreTextures = stripPartTexturesForExport(houseGroup);
            const exporter = new GLTFExporter();
            exporter.parse(getExportRoots(), (glb) => {
                restoreTextures(); // ★このアプリ自身の表示には簡易テクスチャを戻す
                const blob = new Blob([glb], { type: 'application/octet-stream' });
                const glbUrl = URL.createObjectURL(blob);
                sessionStorage.setItem('munsell_custom_glb', glbUrl);
                openMunsellIframe(false);
            }, (err) => { restoreTextures(); console.error(err); }, { binary: true });
        } else {
            sessionStorage.removeItem('munsell_custom_glb');
            sessionStorage.removeItem('munsell_initial_textures');
            openMunsellIframe(false);
        }
    } else {
        window.closeMunsellSimulator();
    }
}

window.closeMunsellSimulator = function() {
    isMunsellModeActive = false;
    updateBottomBar();
    const iframe = document.getElementById('munsell-sim-iframe');
    
    // チュートリアルボタンを再表示
    const tutorialBtn = document.getElementById('btn-start-tutorial');
    if (tutorialBtn) tutorialBtn.style.display = '';

    // ★修正：スライダーのグレーアウト（無効化）を解除して操作できるように戻します
    const sliderInner = document.querySelector('#app1-time-slider-container .slider-ui-inner');
    if (sliderInner) sliderInner.classList.remove('slider-disabled');

    const munsellBtn = document.getElementById('app1-munsell-btn');
    if (munsellBtn) {
        munsellBtn.classList.remove('active');
        // マンセル終了（モデリングモード）なので、次は着色モードへ行く案内を出す
        munsellBtn.setAttribute('data-tooltip', '🎨 着色モードへ');
    }
    
    if (iframe) {
        // ==========================================
        // ★追加：iframe内のカメラ状態を直接取得して、メインカメラに反映（帰りの同期）
        // ==========================================
        try {
            if (iframe.contentWindow && iframe.contentWindow.camera && iframe.contentWindow.controls) {
                const mCam = iframe.contentWindow.camera;
                const mCtrl = iframe.contentWindow.controls;
                // ★修正：子アプリ(m)から親アプリ(mm)への変換のため、1000倍にしてコピーします
                camera.position.copy(mCam.position).multiplyScalar(1000);
                controls.target.copy(mCtrl.target).multiplyScalar(1000);
                controls.update(); // 変更を適用
            }
        } catch (e) {
            console.warn('マンセル画面からのカメラ状態の復元に失敗しました', e);
        }

        const savedColors = sessionStorage.getItem('munsell_returned_colors');
        const savedTextures = sessionStorage.getItem('munsell_returned_textures');
        if (savedColors || savedTextures) {
            applyReturnedMunsellColors(
                savedColors ? JSON.parse(savedColors) : null,
                savedTextures ? JSON.parse(savedTextures) : null
            );
        }

        iframe.style.opacity = '0'; 
        setTimeout(() => {
            iframe.style.display = 'none';
            iframe.src = 'about:blank'; 
        }, 300);
    }
};

// ==========================================
// ★追加：地球シミュレーター（04_earth-simulator）連携
//   PLATEAUの街並み・地形の上に、このアプリで作った建物を置いて確認する。
//   マンセル・夜間と同じく全画面 iframe で重ねる方式。GLBの受け渡しも同じ流儀
//   （sessionStorage に blob URL を入れる）。
//   ※ 置く場所は地球側の地図で選ぶ。選んだ地点と向きは戻ってきたときに引き継ぐ。
// ==========================================
let isEarthModeActive = false;
// 切り抜きスライダーから起動したときに、地球側の準備ができ次第この大きさを送る
let pendingEarthClipSize = null;

function openEarthSimulator(fromPortal = false) {
    if (isEarthModeActive) return;
    isEarthModeActive = true;
    updateBottomBar();

    // 起動中はモデリング画面側のUIを隠す。時刻スライダーは iframe より前面に出るので、
    // 中身を無効化するだけでは足りず、コンテナごと隠す（CSSの body.earth-mode）。
    const tutorialBtn = document.getElementById('btn-start-tutorial');
    if (tutorialBtn) tutorialBtn.style.display = 'none';
    document.body.classList.add('earth-mode');

    // 前回の向き・配置地点を地球側へ引き継ぐ
    sessionStorage.setItem('earth_model_heading', String(window.lastPlacedHeading || 0));
    if (window.lastPlacedLocation) {
        sessionStorage.setItem('earth_focus_latlon', JSON.stringify(window.lastPlacedLocation));
    }

    // 前回渡したGLBを解放する（地球画面を閉じずに残す作りなので、切り替えのたびに溜まる）
    const prevGlb = sessionStorage.getItem('earth_custom_glb');
    if (prevGlb && prevGlb.startsWith('blob:')) URL.revokeObjectURL(prevGlb);

    // ★変更：建物が無くても外構だけ置かれていれば、それを持って地球へ行く
    if (fromPortal || (AppState.buildingData.length === 0 && exteriorWorld.children.length === 0)) {
        // ポータルからの単独起動（またはモデルが無いとき）は街並みだけを表示する
        sessionStorage.removeItem('earth_custom_glb');
        sessionStorage.removeItem('earth_camera_state');
        proceedOpenEarthIframe(fromPortal);
    } else {
        // ★モデリング画面の見え方をそのまま引き継ぐためのカメラ状態（mm・モデル原点基準）。
        //   地球側でモデルを置いた位置・向きに合わせて変換される（02/03 と同じ考え方）。
        sessionStorage.setItem('earth_camera_state', JSON.stringify({
            position: camera.position.toArray(),
            target: controls.target.toArray(),
            fov: camera.fov,
        }));
        houseGroup.traverse(child => {
            if (child.isMesh && child.material) {
                const mat = Array.isArray(child.material) ? child.material[0] : child.material;
                if (!mat.name) mat.name = 'mat_' + mat.uuid.substring(0, 8);
            }
        });
        const exporter = new GLTFExporter();
        exporter.parse(getExportRoots(), (glb) => {
            const blob = new Blob([glb], { type: 'application/octet-stream' });
            sessionStorage.setItem('earth_custom_glb', URL.createObjectURL(blob));
            proceedOpenEarthIframe(fromPortal);
        }, (err) => {
            console.error(err);
            sessionStorage.removeItem('earth_custom_glb');
            proceedOpenEarthIframe(fromPortal);
        }, { binary: true });
    }
}

let earthRevealTimer = null;

function proceedOpenEarthIframe(fromPortal) {
    let iframe = document.getElementById('earth-sim-iframe');
    if (!iframe) {
        iframe = document.createElement('iframe');
        iframe.id = 'earth-sim-iframe';
        iframe.style.position = 'absolute';
        iframe.style.top = '0';
        iframe.style.left = '0';
        iframe.style.width = '100%';
        iframe.style.height = '100%';
        iframe.style.border = 'none';
        iframe.style.zIndex = '5000';
        iframe.style.opacity = '0';
        iframe.style.transition = 'opacity 0.3s ease-out';
        document.body.appendChild(iframe);
    }

    iframe.style.visibility = 'visible';
    iframe.style.pointerEvents = '';
    iframe.style.display = 'block';
    iframe.style.opacity = '0';

    // ★ 2回目以降：前回の地球画面をそのまま生かしてある（タイルも地形も読み込み済み）。
    //   ページを読み直さず、待機を解除してモデルだけ入れ替える＝街並みの再読み込みが起きない。
    const win = iframe.contentWindow;
    if (win && typeof win.resumeEarthSimulator === 'function') {
        win.resumeEarthSimulator({ from: fromPortal ? 'portal' : 'modeling' });
        clearTimeout(earthRevealTimer);
        earthRevealTimer = setTimeout(() => window.showEarthSimulator(), 5000);
        return;
    }

    const urlParam = fromPortal ? '?from=portal' : '?from=modeling';
    iframe.src = `./earth-api/${urlParam}`;

    // ★すぐには出さない。地球側が「モデルを置いてカメラを合わせた」と知らせてきてから
    //   フェードインする（夜間シミュレーターの showNightSimulation と同じ作法）。
    //   こうするとモデリング画面の絵から地続きで切り替わり、暗いだけの画面が挟まらない。
    //   万一あちらが知らせてこなくても取り残されないよう、保険のタイマーも仕掛ける。
    clearTimeout(earthRevealTimer);
    earthRevealTimer = setTimeout(() => window.showEarthSimulator(), 5000);
}

// 地球側から「描画準備ができた」合図を受け取って表示する
window.showEarthSimulator = function() {
    clearTimeout(earthRevealTimer);
    const iframe = document.getElementById('earth-sim-iframe');
    if (!iframe || !isEarthModeActive) return;
    iframe.style.opacity = '1';

    // ★追加：ロードで読み込んだ検討内容が控えてあれば、ここで当てる
    pushEarthState();

    // 切り抜きの大きさを合わせる。スライダーから起動したならその値を送り、
    // それ以外（🌍ボタンやポータル）なら地球側の現在値をこちらのスライダーに映す。
    const win = iframe.contentWindow;
    if (pendingEarthClipSize && win && typeof win.setEarthClipSize === 'function') {
        win.setEarthClipSize(pendingEarthClipSize);
        window.syncEarthClipSize(pendingEarthClipSize);
    } else if (win && typeof win.getEarthClipSize === 'function') {
        window.syncEarthClipSize(win.getEarthClipSize());
    }
    pendingEarthClipSize = null;

    // 断面（30km東西縦断図）のオン・オフも、地球側の現在値にボタンを合わせる
    // （前回開いたときの状態を隠して待機させているだけなので、消えているとは限らない）。
    if (win && typeof win.getEarthProfileOn === 'function') {
        isProfileOn = !!win.getEarthProfileOn();
        applyProfileButtonState();
    }
};

// パネル左端の表示灯を点けたり消したりする。
// ランプの点灯＝そのモードが動いている状態。ホバー時の説明も状態に合わせて入れ替える
// （🎨ボタンが「着色モードへ」⇄「モデリングモードへ」と変わるのと同じ考え方）。
function setPanelLamp(id, on, offText, onText) {
    const lamp = document.getElementById(id);
    if (!lamp) return;
    lamp.classList.toggle('active', on);
    lamp.setAttribute('data-tooltip', on ? onText : offText);
}

function setNightLamp(on) {
    setPanelLamp('app1-night-lamp', on,
        '🌃 夜間景観モードにする',
        '🌃 夜間景観モードを終了する');
}

// 切り抜きパネルの表示（大きさのラベルと、左端の🌐ランプ）をまとめて更新する。
function updateClipPanelDisplay(size) {
    const display = document.getElementById('app1-clip-display');
    const v = Number(size) || 0;
    // ★中央の表示は短くする（「250 m 四方」だと左の「地球なし」と重なるため）。
    //   0 のときは何も出さない（左端の「地球なし」が状態を示している）。
    //   全体表示（550）のときも同じ理由で「全体」とだけ出す（右端の固定ラベルと同じ表記）。
    if (display) display.textContent = v === 0 ? '' : (v > APP1_CLIP_MAX_SIZE ? '全体' : `${v}m`);
    setPanelLamp('app1-earth-lamp', v > 0,
        '🌐 地球モードにする',
        '🌐 地球モードを終了する');
}

// 地球側のHUDで切り抜きが変わったときに、こちらのスライダーの位置だけ合わせる
// （input を発火させない＝ここから起動・終了の判定は走らせない）
window.syncEarthClipSize = function(size) {
    const slider = document.getElementById('app1-clip-slider');
    if (!slider) return;
    const v = Number(size) || 0;
    slider.value = String(v);
    updateClipPanelDisplay(v);
};

// 地球側の「モデリング画面に戻る」ボタンから呼ばれる（同一オリジンなので直接呼べる）
window.closeEarthSimulator = function() {
    isEarthModeActive = false;
    updateBottomBar();
    applyProfileButtonState();   // ボタンの表示（active/tooltip）を非地球モードの状態に戻す
    isStreetViewOn = false;
    applyStreetViewButtonState();
    isBuildingEditOn = false;
    applyBuildingEditButtonState();

    // 地球側で決めた向き・配置地点を受け取り、セーブデータに残るようにする
    const heading = parseFloat(sessionStorage.getItem('earth_model_heading'));
    if (Number.isFinite(heading)) window.lastPlacedHeading = heading;
    try {
        const loc = JSON.parse(sessionStorage.getItem('earth_focus_latlon') || 'null');
        if (loc && Number.isFinite(loc.lat) && Number.isFinite(loc.lng)) {
            window.lastPlacedLocation = loc;
        }
    } catch (e) {
        console.warn('地球側から配置地点を受け取れませんでした', e);
    }

    // ★地球側で見ていたアングルを引き継ぐ（あちらが mm・モデル原点基準に戻して預けている）
    try {
        const camState = JSON.parse(sessionStorage.getItem('earth_camera_state') || 'null');
        if (camState && Array.isArray(camState.position) && Array.isArray(camState.target)) {
            camera.position.fromArray(camState.position);
            controls.target.fromArray(camState.target);
            controls.update();
            if (window.renderAllViews) window.renderAllViews();
        }
    } catch (e) {
        console.warn('地球側からカメラ状態を受け取れませんでした', e);
    }

    const tutorialBtn = document.getElementById('btn-start-tutorial');
    if (tutorialBtn) tutorialBtn.style.display = '';
    document.body.classList.remove('earth-mode');

    // 切り抜きスライダーを 0（地球なし）に戻す。時刻スライダーの戻し方と同じ考え方。
    pendingEarthClipSize = null;
    window.syncEarthClipSize(0);

    // ★ 破棄せずに隠すだけにする。読み込み済みのPLATEAUタイル・地形を抱えたまま
    //   待機させておけば、次に開いたときは一瞬で戻る（src を捨てると全部やり直しになる）。
    //   ・visibility:hidden … 見えず触れず、それでいて iframe の大きさは保たれる
    //     （display:none にすると中の画面サイズが 0 になり、再開時にカメラの比率が崩れる）
    //   ・描画ループは地球側の pauseEarthSimulator() で止めてもらう（CPUを食わせない）
    const iframe = document.getElementById('earth-sim-iframe');
    if (iframe) {
        iframe.style.opacity = '0';
        iframe.style.pointerEvents = 'none';
        setTimeout(() => {
            if (isEarthModeActive) return;   // 待っている間に開き直されたら何もしない
            iframe.style.visibility = 'hidden';
            const win = iframe.contentWindow;
            if (win && typeof win.pauseEarthSimulator === 'function') win.pauseEarthSimulator();
        }, 300);
    }
};

// サブアプリ(iframe)からのメッセージ送信を安全に受信するリスナー
window.addEventListener('message', (event) => {
    if (!event.data) return;

    // マンセル側から戻りデータが送られてきた時
    if (event.data.type === 'MUNSELL_RETURN') {
        const colorMap = event.data.colors;
        
        // 色情報がある場合はメイン側のマテリアルに反映
        if (colorMap) {
            applyReturnedMunsellColors(colorMap);
        }
        
        // 連携用関数を実行してiframeを安全に閉じる
        if (typeof window.closeMunsellSimulator === 'function') {
            window.closeMunsellSimulator();
        }
    }
});

/* ==========================================================================
   ★追加：下部の操作バー（時刻スライダー／🎨／地球の切り抜きスライダー）の共通制御

   このバーは【01〜04 のどれを開いていても同じ位置に居る】。サブアプリ（02〜04）は
   全画面 iframe で上に重なるだけなので、バーを親が出しっぱなしにしておけば
   位置は自動的に完全一致する（各アプリに複製を置くと必ずズレるので置かない）。

   そのうえで「今のモードでは使えない操作」を半透明の膜で塞ぐ（.locked）。

     モデリング   … 全部使える
     マンセル     … 時刻・切り抜きを塞ぐ（🎨はモデリングへ戻る操作なので生かす。
                    ただしポータルから単独で開いたときは戻り先が無いので塞ぐ）
     夜間         … 🎨・切り抜きを塞ぐ（時刻スライダーが操作子）
     地球         … 時刻・🎨を塞ぐ（切り抜きスライダーが操作子）
   ========================================================================== */
function setBottomBarVisible(visible) {
    ['app1-time-slider-container', 'app1-clip-slider-container'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.style.display = visible ? 'flex' : 'none';
    });
}

function updateBottomBar() {
    // variant は膜の大きさの指定（'locked-slider' / 'locked-btn' / 省略＝要素そのまま）
    const lock = (id, on, variant) => {
        const el = document.getElementById(id);
        if (!el) return;
        el.classList.toggle('locked', on);
        if (variant) el.classList.toggle(variant, on);
    };
    const timeLocked = isEarthModeActive || isMunsellModeActive;
    const clipLocked = isNightModeActive || isMunsellModeActive;
    // 🎨はマンセルの入り口／出口。モデリングから開いたときだけ「戻る」操作として生かす。
    const munsellLocked = isEarthModeActive || isNightModeActive ||
                          (isMunsellModeActive && isPortalLaunch);

    lock('app1-time-slider-group', timeLocked, 'locked-slider');
    // 🌃表示灯（夜間シミュレーターへの入口の案内）もスライダーと同じ条件で塞ぐ。
    //   ★ これが無いと、時刻スライダーが塞がっている間（マンセルモード中など）でも
    //     表示灯だけはホバーできてしまい、「動かすと夜間モードへ」というツールチップが
    //     出てしまう（実際には動かせないのに、という食い違いになる）。
    //     .locked は pointer-events:none も兼ねるので、これを付けるだけでツールチップも
    //     自然に出なくなる（ホバー自体が起きないため）。
    lock('app1-night-lamp', timeLocked, 'locked-btn');
    lock('app1-munsell-btn', munsellLocked, 'locked-btn');
    lock('app1-clip-slider-container', clipLocked);   // こちらはパネルごと塞ぐ
    // 断面ボタンは「地球モードが動いていない間」も塞ぐ（切り抜きスライダー自体は
    // 塞がれていなくても、地球モードに入る前は断面を開いても意味がないため）。
    // ★ストリートビュー中は切り抜きスライダーと断面ボタンを塞ぐ。
    //   歩いている間に箱庭へ戻されると、道路が箱の外に出て動けなくなるため。
    //   👣だけは塞がない（これが唯一の出口になる）。
    lock('app1-clip-slider-group', isStreetViewOn, 'locked-slider');
    // 🌐（地球モードの入口／出口）を塞ぐ条件。
    //   ・ストリートビュー中 … 先にストビューを抜けさせる（歩いている最中に地球モードごと
    //     畳まれると、キャラクターも道路も消えたまま操作だけ残る）。
    //   ・ポータルから地球モードを単独起動したとき … 戻る先が無いので終了させない
    //     （切り抜きスライダーを 0 に戻せない clipSliderZeroAllowed と対になる扱い）。
    lock('app1-earth-lamp',
         clipLocked || isStreetViewOn || (isEarthModeActive && isPortalLaunch),
         'locked-btn');
    lock('app1-profile-toggle', !isEarthModeActive || clipLocked || isStreetViewOn, 'locked-btn');
    lock('app1-streetview-toggle', !isEarthModeActive || clipLocked, 'locked-btn');
    lock('app1-buildingedit-toggle',
         !isEarthModeActive || clipLocked || isStreetViewOn, 'locked-btn');

    // ★単独起動（ポータルのタイルから直接開いた）中は、スライダーを 0 まで下げて
    //   そのシミュレーターを終了できないようにする。モデリング画面から開いたときは
    //   0 に戻せばモデリングへ帰れるが、単独起動では帰り先が無く、
    //   何も無い画面が残ってしまうため（終了は「ポータルに戻る」ボタン）。
    clipSliderZeroAllowed = !(isEarthModeActive && isPortalLaunch);
    timeSliderZeroAllowed = !(isNightModeActive && isPortalLaunch);
}

// ポータルのタイルから直接サブアプリを起動したか（＝モデリング画面を経由していないか）
let isPortalLaunch = false;

/* ==========================================================================
   ★追加：ポータル画面・アプリ切り替え＆親「戻る」ボタン制御ロジック
   ========================================================================== */

/**
 * 3Dモデリング画面内の全表示オブジェクト（Canvas、UI、ViewManagerパーツ）の表示/非表示を切り替える
 */
function setMainAppVisibility(visible) {
    const displayVal = visible ? 'block' : 'none';
    const flexVal = visible ? 'flex' : 'none';

    // ★追加：他のシミュレーターやポータルへ移る前に外構作図モードを閉じる
    //   （建物のゴースト表示と外構パネルを出しっぱなしにしないため）
    if (!visible && isExteriorActive()) exitExterior();

    // 1. Three.js Canvasの表示切り替え
    if (renderer && renderer.domElement) {
        renderer.domElement.style.display = displayVal;
    }
    
    // 2. モデリング画面の各種UIパネルを切り替え（要素が統合されたためスッキリします）
    //    ※ 下部の操作バー（時刻・🎨・切り抜き）はここでは扱わない。
    //      あれはサブアプリを開いている間も出しっぱなしにするので、
    //      setBottomBarVisible / updateBottomBar が別に面倒を見る。
    const mainUiIds = [
        'status-panel',
        'main-toolbar'
    ];
    mainUiIds.forEach(id => {
        const el = document.getElementById(id);
        if (el) {
            // スライダーコンテナも display: flex になったため flexVal で統一します
            el.style.display = visible ? flexVal : 'none';
        }
    });
    
    // 3. 画面上に散らばる lil-gui パネルをすべて隠す
    document.querySelectorAll('.lil-gui').forEach(gui => {
        gui.style.display = displayVal;
    });
    
    // 4. ViewManagerの分割線や方向表示用ラベルを一括切り替え
    if (ViewManager) {
        if (ViewManager.vLine) ViewManager.vLine.style.display = displayVal;
        if (ViewManager.hLines) {
            ViewManager.hLines.forEach(hl => hl.style.display = displayVal);
        }
        if (ViewManager.labels) {
            ViewManager.labels.forEach(lb => lb.style.display = displayVal);
        }
    }
    
    // 5. 画面が表示された瞬間にビューをフィットさせて再描画
    if (visible) {
        window.dispatchEvent(new Event('resize'));
        if (window.renderAllViews) window.renderAllViews();
    }
}

// ポータル用イベントの設定
document.addEventListener('DOMContentLoaded', () => {
    const portalScreen = document.getElementById('portal-screen');
    const btnBackToPortal = document.getElementById('btn-back-to-portal');
    const munsellBtn = document.getElementById('app1-munsell-btn');

    // パレットボタンからの起動（Eventオブジェクトの混入を防ぐためラップする）
    if (munsellBtn) {
        munsellBtn.addEventListener('click', () => {
            toggleMunsellSimulator(false);
        });
    }

    // ■ [3Dモデリング] タイル起動
    const portalBtnModeling = document.getElementById('portal-btn-modeling');
    if (portalBtnModeling) {
        portalBtnModeling.addEventListener('click', () => {
            portalScreen.style.display = 'none';
            btnBackToPortal.style.display = 'flex';
            isPortalLaunch = false;
            setMainAppVisibility(true);
            setBottomBarVisible(true);
            updateBottomBar();
        });
    }

    // ■ [マンセル値] タイル単独起動
    const portalBtnMunsell = document.getElementById('portal-btn-munsell');
    if (portalBtnMunsell) {
        portalBtnMunsell.addEventListener('click', () => {
            portalScreen.style.display = 'none';
            btnBackToPortal.style.display = 'flex';
            
            isPortalLaunch = true;
            setBottomBarVisible(true);
            sessionStorage.removeItem('munsell_custom_glb');
            toggleMunsellSimulator(true);
        });
    }

    // ■ [夜間景観] タイル単独起動
    const portalBtnNight = document.getElementById('portal-btn-night');
    if (portalBtnNight) {
        portalBtnNight.addEventListener('click', () => {
            portalScreen.style.display = 'none';
            btnBackToPortal.style.display = 'flex';
            
            isPortalLaunch = true;
            setBottomBarVisible(true);

            // ★単独起動は毎回まっさらな状態から始める。
            //   前回の続き（持ち込んだモデル、前回いじった時刻）が残っていると
            //   「単独で開いたのに前回の続きが出る」ことになるので、必ずリセットする。
            //   ※ カメラ状態(sharedCameraState)は openNightSimulation の中で
            //     今の視点から書き直されるので、ここで消す必要はない。
            sessionStorage.removeItem('night_custom_glb');
            openNightSimulation(NIGHT_START_PCT, true);   // 時刻は常に 09:00 から

            // 親アプリ側のスライダーも 09:00 の位置に合わせる
            const timeSlider = document.getElementById('app1-time-slider');
            if (timeSlider) {
                timeSlider.value = NIGHT_START_PCT;
                timeSlider.dispatchEvent(new Event('input'));
            }
        });
    }

    // ■ [地球モード] タイル単独起動
    const portalBtnEarth = document.getElementById('portal-btn-earth');
    if (portalBtnEarth) {
        portalBtnEarth.addEventListener('click', () => {
            portalScreen.style.display = 'none';
            btnBackToPortal.style.display = 'flex';

            isPortalLaunch = true;
            setBottomBarVisible(true);
            sessionStorage.removeItem('earth_custom_glb');
            openEarthSimulator(true);
        });
    }

    // ■ 親画面で一括管理する「ポータルに戻る」ボタン
    if (btnBackToPortal) {
        btnBackToPortal.addEventListener('click', () => {
            if (isMunsellModeActive) {
                if (typeof window.closeMunsellSimulator === 'function') window.closeMunsellSimulator();
            }
            if (isNightModeActive) {
                if (typeof window.closeNightSimulation === 'function') window.closeNightSimulation();
            }
            if (isEarthModeActive) {
                if (typeof window.closeEarthSimulator === 'function') window.closeEarthSimulator();
            }

            // ★地球モードのカメラを初期アングルへ戻す。
            //   地球画面は破棄せず隠して待機させてある（タイルを抱えたまま次に備えるため）ので、
            //   何もしないと「01→地球でぐるぐる回した視点」のままポータルから単独起動されてしまう。
            //   ※ closeEarthSimulator は上で済ませてある＝あちらのアングルは既に 01 側へ取り込み済み。
            const earthFrame = document.getElementById('earth-sim-iframe');
            const earthWin = earthFrame && earthFrame.contentWindow;
            if (earthWin && typeof earthWin.resetEarthCamera === 'function') earthWin.resetEarthCamera();
            sessionStorage.removeItem('earth_camera_state');   // 預けてあるアングルも捨てる

            setMainAppVisibility(false);
            setBottomBarVisible(false);   // ポータル画面では下部バーも引っ込める
            isPortalLaunch = false;
            UIController.clearGUI();
            UIController.hideFloatingMenu();

            AppState.selectedId = null;
            AppState.selectedFaceDir = null;
            rebuildMeshes();

            portalScreen.style.display = 'flex';
            btnBackToPortal.style.display = 'none';
        });
    }

    // ★地球モードのデータを先にキャッシュへ入れておく。
    //   入口（ポータルのタイル／ツールバーの🌍）にホバーした時点＝開くつもりが見えた時点と、
    //   手が空いたとき（アイドル）に温める。切り替えた瞬間の待ち時間がここで消える。
    setupEarthPrefetchTriggers(['portal-btn-earth', 'app1-clip-slider-container']);

    // 初期起動時：メイン3D画面を非表示にしてポータル画面のみを表示した状態にする
    setMainAppVisibility(false);
    setBottomBarVisible(false);
});
