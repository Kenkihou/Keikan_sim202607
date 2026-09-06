// interactionHandler.js
import * as THREE from 'three';
import { AppState } from './appState.js';
import { ridgeGableFromPos, freeRidge, freeRidges, freeRoofFlat, roofGroup,
    freeRoofOwner, OUT_DIR, EAVE_MAX, EAVE_SNAP } from './roof/roofMesh.js';
import { geyaArgs, GEYA_OUT_DIR, GEYA_LABEL, GEYA_MAX, GEYA_SNAP }
    from './roof/geya.js';
import { freeNotch, notchFits, NOTCH_MIN, NOTCH_SNAP } from './roof/roofMesh.js';
import { markTool } from './subcam.js';
import { PARA_OUT_DIR, PARA_SNAP, PARA_MAX_OUT, PARA_H_MIN, PARA_H_MAX }
    from './roof/para.js';

// パラペット修景屋根のつまみの呼び名と、動かせる幅。
const PARA_ROLE = {
    out_px: '外への出', in_px: '内への寸法', ridge_dist: '棟の位置',
};

/* 屋根のパラメータの中に、矩形ごとの器を作って返す。
   ⚠️ 既定値の器を使い回してはいけない。FREE_ROOF_DEFAULTS を展開して作った
     オブジェクトと参照を共有していると、書き込みが他の建物へ移る。 */
function ownMap(pr, name) {
    if (!pr[name] || typeof pr[name] !== 'object') pr[name] = {};
    return pr[name];
}
import { UIController } from './uiController.js';
import { ModelingEngine } from './modelingEngine.js';
import { dxfWindows } from './dxf/dxfEngine.js';

let camera, scene, controls, hoverMesh, activeMat;
let getInteractiveMeshes = () => [];
let getPullHandles = () => [];
// つまみを掴んだときの当たり。掴んでいなければ null。
let grabbedPull = null;
// つまみを掴む前のモード。離したら必ずここへ戻す。
let toolBeforePull = null;
// 棟の端を掴んでいるとき。{ id, edge, alongX, y }
let grabbedRidge = null;
const ridgePlane = new THREE.Plane();
// 軒先をつまんで出し入れしている最中。{ id, key, out0, u0 }
let eaveDrag = null;
// ★追加：屋根の切り欠きを動かしている／辺を伸ばしている最中。
//   { id, role, base, u0, v0 }
let notchDrag = null;
// 下屋の軒先・ケラバのバーと、勾配の定規。
let geyaEaveDrag = null;
let geyaSlopeDrag = null;
// パラペット修景屋根。水平に引くもの／上下に引くもの／勾配。
let paraDrag = null;
let paraHDrag = null;
let paraSlopeDrag = null;
const eavePlane = new THREE.Plane();
// 屋上の平場を広げ縮めしている最中。{ id, t0, span, y0 }
let flatDrag = null;
const flatPlane = new THREE.Plane();
// 勾配を変えている最中。{ id, lift }
let slopeDrag = null;
// ★ 平場をいっぱいに広げた先へ、ひと押しぶんの間を空けてからパラペットへ抜ける。
//   ⚠️ すぐ切り替えると、平場いっぱいで止めたい人が行き過ぎて陸屋根になる。
const PARAPET_DRAG = 250;   // [mm]

let rebuildMeshes = () => {};
let saveState = () => {};

let currentTool = null;
// ★追加：外構作図モードの間は、建物側の作図・押し出し・編集操作をすべて止める
//   （キャンバス上のクリックは外構モジュールが受け取る）
let isLocked = false;
const pointer = new THREE.Vector2();
const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
let activePlane = new THREE.Plane(); 
const raycaster = new THREE.Raycaster();
// ⚠️ つまみ類は【道具レイヤー】へ移してある（小窓に写さないため）。
//   レイキャスターは既定でレイヤー0しか見ないので、全部見るようにしておく。
//   これを外すと、つまみが掴めなくなる。
raycaster.layers.enableAll();

// ★追加：修景要素（窓・玄関・そで壁・垂れ壁）をつまんで動かしている最中。
//   ★ 大きさも位置も【モデルの上で】決める。スライダーは置かない。
let partDrag = null;
const partPlane = new THREE.Plane();
const OPEN_MIN_W = 600;      // 開口の最小の幅[mm]
const OPEN_MIN_H = 500;      // 開口の最小の高さ[mm]
const OPEN_EDGE = 100;       // 壁の縁からの空き[mm]。これ以上は寄せない
const STEP = 10;             // 動かす刻み[mm]
const SODE_MIN_D = 200, SODE_MAX_D = 3000;   // そで壁の奥行
// 庇の寸法の範囲[mm]。
const VISOR_MIN_E = 150, VISOR_MAX_E = 3000, VISOR_MAX_K = 2000;
// ★ 庇の寸法の刻み[mm]。屋根の軒の出と同じ 50mm 固定。
//   ⚠️ 画面のスナップ幅（500/100/10）には従わせない。庇は 600 や 900 の
//     ような半端でない数字に止めたいので、細かめの一定刻みがよい。
const VISOR_SNAP = 50;
const R50 = (v) => Math.round(v / VISOR_SNAP) * VISOR_SNAP;
const SODE_MIN_H = 300;                      // そで壁の高さ
const TARE_MIN_H = 100, TARE_MAX_H = 2000;   // 垂れ壁の下がり幅
const BALC_MIN_D = 600, BALC_MAX_D = 3000;   // バルコニーの奥行
const BALC_MIN_H = 700, BALC_MAX_H = 2000;   // 手すり・側面壁の高さ
const TARE_MIN_W = 300;                      // 垂れ壁の最小の長さ

// 立体の【札】から、選んでいる要素の呼び名へ。
const PART_OF_DECO = { window: 'window', door: 'door', sodeWall: 'sode',
    tareWall: 'tare', balcony: 'balc', dxfwin: 'dxfwin',
    visor: 'visor', flatVisor: 'flat' };
const DXF_MIN_W = 400, DXF_MIN_H = 400;   // 図面の窓の最小の幅・高さ[mm]
const DXF_EDGE = 50;                       // 壁の端からの空き[mm]
/* 当たった立体が修景要素なら、その要素をあらわす札を返す。 */
function partSelOf(ud, faceDir) {
    const kind = PART_OF_DECO[ud && ud.type];
    if (!kind) return null;
    return { kind, dir: ud.dir || faceDir,
        i: (kind === 'dxfwin' ? (ud.index || 0) : (ud.openIndex || 0)),
        side: ud.partSide || null };
}
/* いま選んでいる要素と同じものか。 */
function sameSel(a, b) {
    return !!a && !!b && a.kind === b.kind && a.dir === b.dir
        && (a.i || 0) === (b.i || 0) && (a.side || null) === (b.side || null);
}

/* 面に沿った座標のとり方。
   ⚠️ 図面から起こした窓は、外形（箱）の面ではなく【その窓が乗っている壁】で
     測る。壁は外形より内側にあることがあり、箱の面で測ると手とずれる。 */
function basisOf(b, sel) {
    if (sel.kind !== 'dxfwin') return ModelingEngine.faceBasis(b, sel.dir);
    const q = dxfWindows(b.plan).find((w) => w.src === (sel.i || 0));
    if (!q) return null;
    return q.alongX
        ? { u: [1, 0], n: [0, q.sgn], half: q.sgn * q.c + q.h, len: q.wb - q.wa }
        : { u: [0, 1], n: [q.sgn, 0], half: q.sgn * q.c + q.h, len: q.wb - q.wa };
}

/* 要素のパラメータの入れ物。 */
function partParams(b, sel) {
    if (!b || !sel) return null;
    if (sel.kind === 'window' || sel.kind === 'door') {
        return ModelingEngine.openList(b, sel.dir, sel.kind)[sel.i || 0] || null;
    }
    if (sel.kind === 'sode') {
        const p = b.sodeParams && b.sodeParams[sel.dir];
        return (p && p[sel.side]) || null;
    }
    if (sel.kind === 'tare') return (b.tareParams && b.tareParams[sel.dir]) || null;
    if (sel.kind === 'visor') return (b.visorParams && b.visorParams[sel.dir]) || null;
    if (sel.kind === 'flat') {
        return (b.flatVisorParams && b.flatVisorParams[sel.dir]) || null;
    }
    if (sel.kind === 'balc') return (b.balcParams && b.balcParams[sel.dir]) || null;
    if (sel.kind === 'dxfwin') {
        return (b.plan && b.plan.opens && b.plan.opens[sel.i || 0]) || null;
    }
    return null;
}

/* 要素のいまの姿（面に沿った位置と高さ）。つまみもドラッグもこれを見る。 */
function partRect(b, sel) {
    const baseY = b.y || 0;
    if (sel.kind === 'window' || sel.kind === 'door') {
        return ModelingEngine.openingRect(b, baseY, sel.dir, sel.kind, sel.i || 0);
    }
    if (sel.kind === 'sode') return ModelingEngine.sodeRect(b, baseY, sel.dir, sel.side);
    if (sel.kind === 'tare') return ModelingEngine.tareRect(b, baseY, sel.dir);
    if (sel.kind === 'balc') return ModelingEngine.balcRect(b, baseY, sel.dir);
    if (sel.kind === 'visor') return ModelingEngine.visorRect(b, baseY, sel.dir);
    if (sel.kind === 'flat') return ModelingEngine.flatRect(b, baseY, sel.dir);
    if (sel.kind === 'dxfwin') {
        return dxfWindows(b.plan).find((w) => w.src === (sel.i || 0)) || null;
    }
    return null;
}

/* 掴んだ瞬間の状態を控える。
   ★ 面に沿って動かすものは【壁の面】へ、面から外へ出すものは【水平面】へ
     落として測る。斜めから見ていても、動かした量がそのまま読める。 */
function startPartDrag(b, sel, role, point) {
    const f = basisOf(b, sel);
    const P = partParams(b, sel);
    const q = (f && P) ? partRect(b, sel) : null;
    if (!q) return false;
    AppState.selectedPart = { ...sel };
    // ★ 外へ出す量を決めるつまみは【水平面】で測る。上下に決めるものは壁の面。
    if (HORIZ_ROLES.has(role)) {
        partPlane.setFromNormalAndCoplanarPoint(new THREE.Vector3(0, 1, 0), point);
    } else {
        partPlane.setFromNormalAndCoplanarPoint(
            new THREE.Vector3(f.n[0], 0, f.n[1]),
            new THREE.Vector3(b.x + f.n[0] * f.half, point.y, b.z + f.n[1] * f.half));
    }
    // ★ 掴んだところは【測る面の上】で取り直す。
    //   ⚠️ つまみは面から離れて浮いている（バルコニーの手すりなら奥行のぶん）。
    //     つまみに当たった点をそのまま基準にすると、面の上の同じ画素は別の高さを
    //     指すので、掴んだ瞬間に跳ぶ。
    const ref = new THREE.Vector3();
    if (!raycaster.ray.intersectPlane(partPlane, ref)) ref.copy(point);
    partDrag = { id: b.id, sel: { ...sel }, role, q0: q, p0: { ...P }, moved: false,
        u0: (ref.x - b.x) * f.u[0] + (ref.z - b.z) * f.u[1],
        y0: ref.y,
        d0: (ref.x - b.x) * f.n[0] + (ref.z - b.z) * f.n[1] - f.half };
    controls.enabled = false;
    return true;
}

const HORIZ_ROLES = new Set(['depth', 'eaves', 'fdepth']);

/* ★追加：引いているあいだ、いまの寸法を数字で見せる文言。
   ★ つまみは「どちらへ動くか」は分かっても【いくつになったか】は分からない。
     手を動かしている場所に数字が出れば、狙った寸法で止められる。 */
function partDragLabel(b, dg) {
    const P = partParams(b, dg.sel) || {};
    const q = partRect(b, dg.sel);
    const mm = (v) => `${Math.round(v || 0)} mm`;
    switch (dg.role) {
        case 'eaves': return `軒の出　${mm(P.eaves)}`;
        case 'slope': return `勾配　${Number(P.slope).toFixed(1)} 寸`;
        case 'kL': case 'kR': return `ケラバ　${mm(P.keraba)}`;
        case 'fdepth': return `庇の出　${mm(P.depth)}`;
        case 'lift': return `取付高さ（床から）　${mm(b.h + (P.offsetY || 0))}`;
        case 'mL': case 'mR': return `端の空き　${mm(P.margin)}`;
        case 'depth': return `奥行　${mm(P.depth)}`;
        case 'rail': return `手すりの高さ　${mm(P.h_handrail)}`;
        case 'side': return `側面壁の高さ　${q ? mm(q.hSide) : mm(P.h_side)}`;
        case 'top': return `高さ　${q ? mm(q.h) : ''}`;
        case 'u0': case 'u1':
            return q ? `幅　${mm(q.w !== undefined ? q.w : (q.u1 - q.u0))}` : null;
        case 'v0': case 'v1':
            return q ? `高さ　${mm(q.h !== undefined ? q.h : (q.y1 - q.y0))}` : null;
        case 'move': return `横位置　${mm(P.offsetX)}`;
        default: return null;
    }
}
const R10 = (v) => Math.round(v / STEP) * STEP;
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

/* 建具（窓・玄関）。掴んだところからの動きぶんを矩形にする。
   ⚠️ 端をつまんだときは【向かいの辺を動かさない】。中心と幅の両方を同時に
     書き換えると、掴んでいない側の辺までついてきて、狙った大きさにならない。 */
function openRectFrom(b, dg, du, dy) {
    const q = dg.q0;
    const fixedBottom = (dg.sel.kind === 'door');   // 玄関は土間に載っている
    let left = q.u - q.w / 2, right = q.u + q.w / 2, y0 = q.y0, y1 = q.y1;
    if (dg.role === 'move') {
        left += du; right += du;
        if (!fixedBottom) { y0 += dy; y1 += dy; }
    } else if (dg.role === 'u0') left += du;
    else if (dg.role === 'u1') right += du;
    else if (dg.role === 'v0') y0 += dy;
    else if (dg.role === 'v1') y1 += dy;
    left = R10(left); right = R10(right); y0 = R10(y0); y1 = R10(y1);
    const f = ModelingEngine.faceBasis(b, dg.sel.dir);
    const baseY = b.y || 0;
    const uLo = -f.len / 2 + OPEN_EDGE, uHi = f.len / 2 - OPEN_EDGE;
    const yLo = baseY + (fixedBottom ? 0 : OPEN_EDGE), yHi = baseY + b.h - OPEN_EDGE;
    if (dg.role === 'move') {
        const w = right - left, h = y1 - y0;
        left = clamp(left, uLo, uHi - w); right = left + w;
        if (!fixedBottom) { y0 = clamp(y0, yLo, yHi - h); y1 = y0 + h; }
    } else {
        if (right - left < OPEN_MIN_W) {
            if (dg.role === 'u0') left = right - OPEN_MIN_W; else right = left + OPEN_MIN_W;
        }
        left = Math.max(left, uLo); right = Math.min(right, uHi);
        if (y1 - y0 < OPEN_MIN_H) {
            if (dg.role === 'v0') y0 = y1 - OPEN_MIN_H; else y1 = y0 + OPEN_MIN_H;
        }
        y0 = Math.max(y0, yLo); y1 = Math.min(y1, yHi);
    }
    return { left, right, y0, y1 };
}

/* 動かしたぶんを、要素のパラメータへ書き戻す。
   ⚠️ どれも【掴んだ瞬間の値】から測ること。前の値に足し続けると、戻したはずの
     位置がじりじりずれていく。 */
function applyPartDrag(b, dg, du, dy, dd) {
    const P = partParams(b, dg.sel);
    if (!P) return;
    const f = basisOf(b, dg.sel);
    const q = dg.q0;
    if (dg.sel.kind === 'window' || dg.sel.kind === 'door') {
        const rc = openRectFrom(b, dg, du, dy);
        P.offsetX = Math.round((rc.left + rc.right) / 2);
        P.width = Math.round(rc.right - rc.left);
        P.height = Math.round(rc.y1 - rc.y0);
        if (dg.sel.kind === 'window') {
            P.offsetY = Math.round((dg.p0.offsetY || 0) + (rc.y1 - q.y1));
        }
        return;
    }
    if (dg.sel.kind === 'sode') {
        const sign = (dg.sel.side === 'left') ? -1 : 1;
        if (dg.role === 'depth') {
            P.depth = clamp(R10((dg.p0.depth || 0) + dd), SODE_MIN_D, SODE_MAX_D);
        } else if (dg.role === 'top') {
            const h = clamp(R10(q.h + dy), SODE_MIN_H, b.h);
            P.topGap = Math.max(0, Math.round(b.h - h));
        } else {                                   // move＝縁からの位置
            const lim = Math.max(0, f.len / 2 - q.t);
            P.inset = clamp(R10((dg.p0.inset || 0) - sign * du), 0, lim);
        }
        return;
    }
    if (dg.sel.kind === 'visor') {
        // ★ 軒庇。先端＝軒の出、端＝ケラバ、上下＝勾配。
        //   ⚠️ 勾配は「先端の高さ」から解く。下がり＝軒の出×勾配/10 なので、
        //     軒の出で割れば勾配がそのまま出る（大屋根の勾配定規と同じ考え）。
        if (dg.role === 'eaves') {
            P.eaves = clamp(R50((dg.p0.eaves !== undefined ? dg.p0.eaves : 600) + dd),
                VISOR_MIN_E, VISOR_MAX_E);
        } else if (dg.role === 'slope') {
            // ★ 勾配は 0.5寸 刻み。大屋根の勾配定規と同じ。
            //   ⚠️ 細かすぎると 4寸ちょうどに止められない。
            const e = Math.max(150, dg.p0.eaves !== undefined ? dg.p0.eaves : 600);
            const drop = Math.max(0, q.yTop - (q.yOut + dy));
            P.slope = Math.min(10, Math.max(0, Math.round(drop / e * 10 * 2) / 2));
        } else {                                   // kL / kR
            const sign = (dg.role === 'kL') ? -1 : 1;
            P.keraba = clamp(R50((dg.p0.keraba !== undefined ? dg.p0.keraba : 300)
                + sign * du), 0, VISOR_MAX_K);
        }
        return;
    }
    if (dg.sel.kind === 'flat') {
        // ★ 水平庇。先端＝出、上下＝取り付く高さ、端＝両端の空き。
        if (dg.role === 'fdepth') {
            P.depth = clamp(R50((dg.p0.depth !== undefined ? dg.p0.depth : 300) + dd),
                VISOR_MIN_E, VISOR_MAX_E);
        } else if (dg.role === 'lift') {
            P.offsetY = clamp(R50((dg.p0.offsetY || 0) + dy), -b.h + 300, 0);
        } else {                                   // mL / mR
            const sign = (dg.role === 'mL') ? 1 : -1;
            const lim = Math.max(0, f.len / 2 - 200);
            P.margin = clamp(R50((dg.p0.margin || 0) + sign * du), 0, lim);
        }
        return;
    }
    if (dg.sel.kind === 'dxfwin') {
        // ★ 書き戻す先は図面の開口そのもの。壁の切り欠きも建具も、ここから
        //   組み直される。
        const q = dg.q0;
        let a = q.a, e = q.b, lo = q.lo, hi = q.hi;
        if (dg.role === 'move') { a += du; e += du; lo += dy; hi += dy; }
        else if (dg.role === 'u0') a += du;
        else if (dg.role === 'u1') e += du;
        else if (dg.role === 'v0') lo += dy;
        else if (dg.role === 'v1') hi += dy;
        a = R10(a); e = R10(e); lo = R10(lo); hi = R10(hi);
        const uLo = q.wa + DXF_EDGE, uHi = q.wb - DXF_EDGE;
        // ⚠️ 上端は【壁の天端まで】。図面の窓は天井いっぱいのこともあるので、
        //   余白を取ると、掴んだとたんに窓が下がる。
        const yHi = Math.max(DXF_MIN_H, b.h);
        if (dg.role === 'move') {
            const w = e - a, ht = hi - lo;
            a = clamp(a, uLo, Math.max(uLo, uHi - w)); e = a + w;
            lo = clamp(lo, 0, Math.max(0, yHi - ht)); hi = lo + ht;
        } else {
            if (e - a < DXF_MIN_W) {
                if (dg.role === 'u0') a = e - DXF_MIN_W; else e = a + DXF_MIN_W;
            }
            a = Math.max(a, uLo); e = Math.min(e, uHi);
            if (hi - lo < DXF_MIN_H) {
                if (dg.role === 'v0') lo = hi - DXF_MIN_H; else hi = lo + DXF_MIN_H;
            }
            lo = Math.max(lo, 0); hi = Math.min(hi, yHi);
        }
        if (q.alongX) { P.x0 = a; P.x1 = e; } else { P.z0 = a; P.z1 = e; }
        P.lo = Math.round(lo); P.hi = Math.round(hi);
        return;
    }
    if (dg.sel.kind === 'balc') {
        if (dg.role === 'depth') {
            P.depth = clamp(R10((dg.p0.depth || 0) + dd), BALC_MIN_D, BALC_MAX_D);
        } else if (dg.role === 'rail') {
            const h = clamp(R10((dg.p0.h_handrail || 0) + dy), BALC_MIN_H,
                Math.max(BALC_MIN_H, Math.min(BALC_MAX_H, b.h - 200)));
            // ★ 手すりと側面壁の高さが揃っていたら、揃えたまま動かす。
            //   ⚠️ 別々に動くと、手すりだけ上げたときに側面壁との段差が残る。
            if ((dg.p0.h_side || 0) === (dg.p0.h_handrail || 0)) P.h_side = h;
            P.h_handrail = h;
        } else if (dg.role === 'side') {
            // ★ 側面壁は【階の天端まで】。手すりより高くしてよい。
            const hi = Math.max(BALC_MIN_H, b.h - 200);
            P.h_side = clamp(R10((q.hSide || 0) + dy), BALC_MIN_H, hi);
        }
        return;
    }
    if (dg.sel.kind === 'tare') {
        const L = f.len;
        const gL = dg.p0.left || 0, gR = dg.p0.right || 0;
        if (dg.role === 'v0') {
            P.height = clamp(R10(q.h - dy), TARE_MIN_H, TARE_MAX_H);
        } else if (dg.role === 'u0') {
            P.left = clamp(R10(gL + du), 0, Math.max(0, L - gR - TARE_MIN_W));
        } else if (dg.role === 'u1') {
            P.right = clamp(R10(gR - du), 0, Math.max(0, L - gL - TARE_MIN_W));
        } else {                                   // move＝長さを変えずに横へ
            const d = clamp(R10(du), -gL, gR);
            P.left = gL + d; P.right = gR - d;
        }
    }
}

// ★追加：図面から起こした階は、当たったところが【側面の外側】かどうかだけを見る。
//   ★ 中（部屋の中・間仕切り・階段・窓の内側・壁の小口）は、どこを押しても
//     【上面】。上から覗いて建物の内側にあたるところは、押せば必ず階高の
//     つまみとパネルが出る。
//   ⚠️ 面の向きだけで振り分けてはいけない。間仕切りの立ち面や壁の小口まで
//     側面に取られるので、当たりが細く、狙って押さないと上面に戻れない。
const DXF_SIDE_T = 150;      // 外形の縁から内側へこの幅までを【外壁の外側】とみなす[mm]
function dxfFaceDir(b, point, normal) {
    if (!b || !point) return 'top';
    // 天端の面は、外壁の真上まで含めてぜんぶ上面。
    if (normal && normal.y > 0.5 && point.y > (b.y || 0) + b.h - 1) return 'top';
    // ★ 向きではなく【外形の縁からの距離】で決める。窓の枠や障子のように
    //   外壁の面から少し引っ込んだり出っ張ったりしているものも、外壁の外側と
    //   ひとつづきに扱える。
    const d = {
        px: b.x + b.w / 2 - point.x, nx: point.x - (b.x - b.w / 2),
        pz: b.z + b.d / 2 - point.z, nz: point.z - (b.z - b.d / 2),
    };
    let dir = null, best = DXF_SIDE_T;
    for (const k of ['px', 'nx', 'pz', 'nz']) if (d[k] < best) { best = d[k]; dir = k; }
    return dir || 'top';
}

let isDrawing = false;
const drawStartPt = new THREE.Vector3();
let currentDrawObj = null; 

let isExtruding = false;
let extrudeTargetId = null;
const extrudeNormal = new THREE.Vector3();
let connectedBlocks = []; 
const extrudeStartPt = new THREE.Vector3(); 

const downPointer = new THREE.Vector2(); 
const tooltip = document.getElementById('tooltip');
/* 印に吸い付かせる。
   ★ 止まってほしいのは、寄棟ちょうど・切妻ちょうど・棟が中央・片流れちょうど。
   ⚠️ 刻みで丸めてはいけない。刻みの上でしか止まれないと、その間の位置を
     選べなくなる。棟の位置は意匠で決めるものなので、細かく動けることが要る。
   ⚠️ 吸い付く幅は【長さ】で持つ。比で持つと、建物が大きいほど広く吸い付いて、
     端のすぐ手前が選べなくなる。 */
const SNAP_HOLD = 250;      // 吸い付く幅[mm]
function snapMarks(v, marks, hold = SNAP_HOLD) {
    for (const m of marks) if (Math.abs(v - m) < hold) return m;
    return v;
}
// 辺の呼び名。吹き出しに出す。
const EDGE_LABEL = { s: '南', n: '北', w: '西', e: '東' };
// ★ つまみの吹き出し。触れているあいだは【役割】、引いているあいだは【数値】。
//   ⚠️ 出しっぱなしにしないこと。自分が出したときだけ畳む（押し引きの寸法など、
//     他の場所も同じ吹き出しを使っている）。
let tipOwned = false;
function showTip(e, text) {
    if (!tooltip) return;
    tooltip.style.display = 'block';
    tooltip.style.left = (e.clientX + 16) + 'px';
    tooltip.style.top = (e.clientY + 18) + 'px';
    tooltip.innerText = text;
    tipOwned = true;
}
function hideTip() {
    if (tipOwned && tooltip) tooltip.style.display = 'none';
    tipOwned = false;
}
/* そのつまみは何をするものか。 */
function handleRole(u) {
    if (u.pullDir) {
        // ★ 押し引きのボタンは置いていない。入口はこのつまみ1つ。
        return u.pullDir === 'top'
            ? '引くと階の高さ'
            : '引くとこの面が動く';
    }
    // ★追加：修景要素のつまみ。何の寸法を動かすのかを出す。
    //   ⚠️ 出さないと、球が並んでいるだけでどれが何なのか分からない。
    if (u.partRole) {
        const P = {
            u0: '幅（この辺）\n引くと動く', u1: '幅（この辺）\n引くと動く',
            v0: '下端\n上下に引く', v1: '上端\n上下に引く',
            top: '高さ\n上下に引く', depth: '奥行\n引くと出し入れ',
            rail: '手すりの高さ\n上下に引く', side: '側面壁の高さ\n上下に引く',
            eaves: '軒の出\n引くと出し入れ', slope: '庇の勾配\n上下に引く',
            kL: 'ケラバ\n引くと出し入れ', kR: 'ケラバ\n引くと出し入れ',
            fdepth: '庇の出\n引くと出し入れ', lift: '取り付く高さ\n上下に引く',
            mL: '端の空き\n引くと動く', mR: '端の空き\n引くと動く',
        };
        return P[u.partRole] || '引くと大きさが変わる';
    }
    if (u.notchRole) {
        return (u.notchRole === 'move')
            ? '切り欠きを動かす'
            : '切り欠きのこの辺を動かす（一辺は最小 ' + (NOTCH_MIN / 1000) + ' m）';
    }
    if (u.ridgeEdge) {
        return '棟の端\n棟に沿って引く：寄棟⇔切妻\n横へ引く：招き・片流れ（Shiftで差し掛け）';
    }
    if (u.eaveEdge) {
        return `軒の出（${EDGE_LABEL[u.eaveEdge]}） ${Math.round(u.out)} mm\n`
            + '引くと出し入れ';
    }
    if (u.geyaEdge) {
        const nm = u.geyaRole === 'keraba' ? 'ケラバ' : '軒の出';
        return `下屋の${nm}（${GEYA_LABEL[u.geyaEdge]}） ${Math.round(u.out)} mm\n`
            + '引くと出し入れ';
    }
    if (u.geyaSlope) return '下屋の勾配\n上下に引く';
    if (u.paraBar) {
        return `${PARA_ROLE[u.paraParam]} ${Math.round(u.value)} mm\n引くと動く`;
    }
    if (u.paraSlope) return '笠木の勾配\n上下に引く';
    if (u.paraHeight) {
        return `パラペットの高さ ${Math.round(u.value)} mm\n上下に引く`;
    }
    if (u.flatHandle) return '屋上の平場\n下げる：平場が広がる → パラペット';
    if (u.slopeHandle) return '屋根勾配\n上下に引く';
    return null;
}

let currentSnap = 500; // 現在のスナップ量
function snap(val) { return Math.round(val / currentSnap) * currentSnap; }
// ==========================================
// ★変更：ダブルクリック＆トリプルクリック編集モード用変数
// ==========================================
let isEditing = false; 
let isGroupEditing = false; // ★追加：建物全体移動モードかどうかのフラグ
let editingBlock = null; 
let editingGroupBlocks = []; // ★追加：一緒に動かす建物パーツのリスト
let isDraggingBlock = false; 
const dragStartMouse = new THREE.Vector3(); 
const dragStartBlockPos = new THREE.Vector3();
let moveGizmo = null;
// ★ 移動のつまみを掴んでいる最中。{ axis, blocks:[{block,x0,z0}], sx, sz }
let gizmoDrag = null;
// 軸ごとの材質。触れている軸だけ濃くする。
let gizmoMats = null;
const GIZMO_DIM = 0.35;      // ふだんの濃さ
const GIZMO_LIT = 0.95;      // 触れているときの濃さ
// 触れたときに出す説明。動くのは【建物ぜんぶ】であることを言う。
const GIZMO_ROLE = {
    x: '建物ごと東西に動かす',
    z: '建物ごと南北に動かす',
    xz: '建物ごと自由に動かす',
};
// ==========================================
// ★追加：編集ハイライト用の青色マテリアル（使い回し用）
// ==========================================
const editBlueMat = new THREE.MeshBasicMaterial({ 
    color: 0xcceeff, 
    polygonOffset: true, 
    polygonOffsetFactor: 1, 
    polygonOffsetUnits: 1, 
    side: THREE.DoubleSide 
});
// ==========================================


function getMainPointer(e) {
    // 全画面描画に伴い、左側サブ画面の除外判定や幅調整を廃止し、画面全体を基準に正規化座標計算を行います
    const x = (e.clientX / window.innerWidth) * 2 - 1;
    const y = -(e.clientY / window.innerHeight) * 2 + 1;
    return { x, y };
}

function getGroundIntersect(e) {
    const p = getMainPointer(e);
    if (!p) return null;
    pointer.x = p.x;
    pointer.y = p.y;
    raycaster.setFromCamera(pointer, camera);
    const target = new THREE.Vector3();
    
    const intersect = raycaster.ray.intersectPlane(groundPlane, target);
    if(intersect) {
        target.x = snap(target.x);
        target.z = snap(target.z);
        return target;
    }
    return null;
}

function updateHoverMesh(b, normal) {
    const baseY = b.y || 0;
    if (normal.y > 0.5) { 
        hoverMesh.scale.set(b.w, b.d, 1);
        hoverMesh.rotation.set(-Math.PI/2, 0, 0);
        hoverMesh.position.set(b.x, baseY + b.h + 2, b.z);
    } else if (normal.x > 0.5) { 
        hoverMesh.scale.set(b.d, b.h, 1);
        hoverMesh.rotation.set(0, Math.PI/2, 0);
        hoverMesh.position.set(b.x + b.w/2 + 2, baseY + b.h/2, b.z);
    } else if (normal.x < -0.5) { 
        hoverMesh.scale.set(b.d, b.h, 1);
        hoverMesh.rotation.set(0, -Math.PI/2, 0);
        hoverMesh.position.set(b.x - b.w/2 - 2, baseY + b.h/2, b.z);
    } else if (normal.z > 0.5) { 
        hoverMesh.scale.set(b.w, b.h, 1);
        hoverMesh.rotation.set(0, 0, 0);
        hoverMesh.position.set(b.x, baseY + b.h/2, b.z + b.d/2 + 2);
    } else if (normal.z < -0.5) { 
        hoverMesh.scale.set(b.w, b.h, 1);
        hoverMesh.rotation.set(0, Math.PI, 0);
        hoverMesh.position.set(b.x, baseY + b.h/2, b.z - b.d/2 - 2);
    }
    hoverMesh.visible = true;
}

// ==========================================
// ★追加：ギズモの作成・更新・削除関数
// ==========================================
function createGizmo() {
    if (moveGizmo) return;
    // ★ 地面に寝かせた【タテヨコの矢印】。掴んだ軸に沿って建物ごと動かす。
    //   ★ 真ん中の四角を掴めば、軸にとらわれず自由に動かせる。
    //   ⚠️ 当たり判定に使うので、線ではなく【面のある立体】で作ること。線は
    //     細すぎて掴めない。
    moveGizmo = new THREE.Group();
    const L = 2600;          // 矢印の長さ[mm]（中心から先端まで）
    const R = 70;            // 軸の太さ
    const HEAD = 420, HEAD_R = 190;
    // ★ 色は薄く。いつも出ているものなので、濃いと形より先に目に入る。
    //   ⚠️ 触れているあいだだけ濃くする（掴めることが分かるように）。
    const mat = (c) => new THREE.MeshBasicMaterial({
        color: c, depthTest: false, depthWrite: false,
        transparent: true, opacity: GIZMO_DIM });
    const matX = mat(0xd83a3a), matZ = mat(0x2f6fd0), matC = mat(0x8a8f98);
    gizmoMats = { x: matX, z: matZ, xz: matC };
    const add = (m, axis) => {
        m.renderOrder = 1005;
        m.userData = { moveAxis: axis };
        moveGizmo.add(m);
    };
    for (const sgn of [1, -1]) {
        // X（東西）
        const sx = new THREE.Mesh(new THREE.CylinderGeometry(R, R, L - HEAD, 10), matX);
        sx.rotation.z = Math.PI / 2;
        sx.position.x = sgn * (L - HEAD) / 2;
        add(sx, 'x');
        const hx = new THREE.Mesh(new THREE.ConeGeometry(HEAD_R, HEAD, 14), matX);
        hx.rotation.z = -sgn * Math.PI / 2;
        hx.position.x = sgn * (L - HEAD / 2);
        add(hx, 'x');
        // Z（南北）
        const sz = new THREE.Mesh(new THREE.CylinderGeometry(R, R, L - HEAD, 10), matZ);
        sz.rotation.x = Math.PI / 2;
        sz.position.z = sgn * (L - HEAD) / 2;
        add(sz, 'z');
        const hz = new THREE.Mesh(new THREE.ConeGeometry(HEAD_R, HEAD, 14), matZ);
        hz.rotation.x = sgn * Math.PI / 2;
        hz.position.z = sgn * (L - HEAD / 2);
        add(hz, 'z');
    }
    // 真ん中＝自由に動かす
    const c = new THREE.Mesh(new THREE.BoxGeometry(520, 60, 520), matC);
    add(c, 'xz');
    moveGizmo.position.y = 30;   // 地面に埋もれないように少し浮かせる
    moveGizmo.visible = false;
    // ★ 地面の移動矢印も【道具】。小窓には写さない。
    markTool(moveGizmo);
    scene.add(moveGizmo);
}

/* この建物（同じ rootBuildingId のまとまり）のブロック。 */
function buildingGroupOf(id) {
    const b = AppState.buildingData.find((d) => d.id === id);
    if (!b) return [];
    const root = b.rootBuildingId || b.id;
    return AppState.buildingData.filter((d) => (d.rootBuildingId || d.id) === root);
}

function updateGizmo() {
    if (!moveGizmo) return;
    // ★ 出すのは【ブロックを選んでいるとき】だけ。修景要素を選んでいるあいだは
    //   出さない（つまみが増えて、どれが何のつまみか分からなくなる）。
    let grp = (AppState.selectedId && !AppState.selectedPart)
        ? buildingGroupOf(AppState.selectedId) : [];
    // ★ まだ平面（板）のうちは出さない。やることは【引き上げる】だけで、
    //   ⚠️ 板の押し引きのつまみは足元の真ん中に出るので、必ず重なる。
    if (grp.length && Math.max(...grp.map((b) => (b.y || 0) + b.h)) <= 100) grp = [];
    if (!grp.length) {
        if (moveGizmo.visible) { moveGizmo.visible = false; window.renderAllViews?.(); }
        return;
    }
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const b of grp) {
        x0 = Math.min(x0, b.x - b.w / 2); x1 = Math.max(x1, b.x + b.w / 2);
        z0 = Math.min(z0, b.z - b.d / 2); z1 = Math.max(z1, b.z + b.d / 2);
    }
    moveGizmo.position.x = (x0 + x1) / 2;
    moveGizmo.position.z = (z0 + z1) / 2;
    // カメラ距離に応じて大きさを一定に保つ
    const dist = camera.position.distanceTo(moveGizmo.position);
    moveGizmo.scale.setScalar(Math.max(0.35, dist / 26000));
    // ⚠️ 出したり消したりしたときは【描き直しを頼む】。この画面は動きがある
    //   ときだけ描くので、頼まないと次に画面が動くまで出てこない。
    if (!moveGizmo.visible) { moveGizmo.visible = true; window.renderAllViews?.(); }
}

function removeGizmo() {
    if (moveGizmo) moveGizmo.visible = false;
}

// 【重要】現在のアクティブなIDを判定する関数を追加
function isBlockHighlighted(blockId) {
    if (!isEditing) return false;
    return isGroupEditing 
        ? editingGroupBlocks.some(b => b.id === blockId)
        : (editingBlock && editingBlock.id === blockId);
}

// ==========================================
// ★差し替え：編集中のオブジェクトを青くハイライトする関数
// ==========================================
function highlightEditingBlocks() {
    if (!scene) return;
    const houseGroup = window.getHouseGroup?.() || scene;
    
    // 現在のハイライト対象IDリストを作成
    let targetIds = [];
    if (isEditing && editingBlock) {
        targetIds = isGroupEditing ? editingGroupBlocks.map(b => b.id) : [editingBlock.id];
    }
    
    houseGroup.traverse((child) => {
        // メッシュであり、IDを持っているものだけを対象とする
        if (!child.isMesh || !child.userData || !child.userData.id) return;
        
        const isTarget = targetIds.includes(child.userData.id);
        
        if (isTarget) {
            // 【ターゲットの場合：使い回し用の青マテリアルを直接適用する】
            if (Array.isArray(child.material)) {
                child.material = [editBlueMat, editBlueMat, editBlueMat, editBlueMat, editBlueMat, editBlueMat];
            } else {
                child.material = editBlueMat;
            }
        }
        // ※ターゲット以外の場合は、再構築時に元の色が自動的に割り当てられているため何もしなくてOKです
    });

    // ★ココが最重要！ 色を塗り替えた後に強制的に画面を再描画する
    if (window.renderAllViews) {
        window.renderAllViews();
    }
}
window.triggerHighlightSync = highlightEditingBlocks;

// 編集モードを完全に終了する共通関数
function exitEditMode() {
    isEditing = false;
    isGroupEditing = false;
    editingBlock = null;
    editingGroupBlocks = [];
    isDraggingBlock = false;
    
    removeGizmo();
    rebuildMeshes(); // ★再構築を呼ぶだけで、自動的に元の色に戻ります
    document.body.style.cursor = 'default';
}

export const InteractionHandler = {
toggleSnap() {
        // ★ 01 の吸い付きは【このボタン1つ】で決まる。500 → 100 → 10 と回る。
        //   ⚠️ 方眼の目も一緒に変える。目盛りと吸い付きが食い違うと、いまどの
        //     刻みで動いているのかが画面から読めない。
        currentSnap = currentSnap === 500 ? 100 : (currentSnap === 100 ? 10 : 500);
        window.setSnapGrid?.(currentSnap);
        
        // HTMLのUI表示を更新する
        const btn = document.getElementById('btn-snap-toggle');
        const span = document.getElementById('snap-val');
        if (btn) btn.setAttribute('data-tooltip', `📏 スナップ: ${currentSnap}mm`);
        if (span) span.innerText = currentSnap;
        
        return currentSnap;
    },    
// init(params) の末尾までを以下に置き換え
init(params) {
        camera = params.camera;
        scene = params.scene;
        controls = params.controls;
        getInteractiveMeshes = params.getInteractiveMeshes;
        getPullHandles = params.getPullHandles || (() => []);
        hoverMesh = params.hoverMesh;
        activeMat = params.activeMat;
        
        // ★修正：再構築の直後に、必ず色を塗る処理を連動させる
        const originalRebuildMeshes = params.rebuildMeshes;
        rebuildMeshes = () => {
            // ⚠️ つまみの置き直しは【描き直しより先】。あとに回すと、次に画面が
            //   動くまで前のフレームのままで、選んだのにつまみが出ない。
            updateGizmo();          // 選び直しのたびに、移動のつまみも置き直す
            originalRebuildMeshes();
            highlightEditingBlocks();
            // ★ 建物のあらまし（階数・幅・奥行・高さ）も、引いている最中に追う。
            if (AppState.selectedId && !AppState.selectedPart) {
                UIController.showBlockInfo(
                    AppState.buildingData.find(d => d.id === AppState.selectedId));
            }
        };
        
        saveState = params.saveState;
        
        createGizmo();
        this.setupEventListeners();

        // 外部からツールを切り替える用
        window.setTool = (toolName) => this.setTool(toolName);
    },

    getCurrentTool() {
        return currentTool;
    },

    // ★追加：現在のスナップ量（mm）。外構作図モードでも同じ刻みで点を拾うために使う
    getSnap() {
        return currentSnap;
    },

    // ★追加：外構作図モードの出入りで、建物側の操作をまるごとロック／解除する
    setLocked(v) {
        isLocked = !!v;
        if (isLocked) {
            this.setTool(null);          // 作図・押し出し中なら解除（編集モードもここで抜ける）
            hoverMesh.visible = false;
            document.body.style.cursor = 'default';
            if (tooltip) tooltip.style.display = 'none';
            UIController.clearGUI();
            UIController.hideFloatingMenu();
        }
    },

    isLocked() {
        return isLocked;
    },

    setTool(toolName) {
        currentTool = toolName;
        // ★追加：別のツールが選ばれたら編集・移動モードを解除
        if (isEditing) {
            exitEditMode(); // これ一行にまとめます
        }

        // ★追加：ツールを切り替えた時に、作図中の仮平面があれば強制的に消去する
        if (currentDrawObj) {
            scene.remove(currentDrawObj.mesh, currentDrawObj.line);
            if (currentDrawObj.mesh.geometry) currentDrawObj.mesh.geometry.dispose();
            currentDrawObj = null;
            isDrawing = false;
        }

        const btnDraw = document.getElementById('btn-draw');
        const btnExtrude = document.getElementById('btn-extrude');
        const modeText = document.getElementById('mode-text');
        const modeDesc = document.getElementById('mode-desc');

        if (btnDraw) btnDraw.classList.toggle('active', toolName === 'DRAW');
        if (btnExtrude) btnExtrude.classList.toggle('active', toolName === 'EXTRUDE');

        if (tooltip) tooltip.style.display = 'none';
        hoverMesh.visible = false;
        document.body.style.cursor = 'default';           
        if (toolName !== 'EXTRUDE') {
            AppState.selectedId = null;
            AppState.selectedFaceDir = null;
        }
        rebuildMeshes();

        UIController.hideFloatingMenu(); 
        UIController.updateStatusDisplay(currentTool); 
    },

    setupEventListeners() {
        window.addEventListener('pointerdown', (e) => {
            if (isLocked) return;                 // ★外構作図モード中
            if (e.target.closest('#floating-menu')) return;
            UIController.hideFloatingMenu();
            if (e.button !== 0) return; 
            if (e.target.tagName !== 'CANVAS') return; 

            downPointer.set(e.clientX, e.clientY);

            const p = getMainPointer(e);
            if (!p) return; 
            pointer.x = p.x;
            pointer.y = p.y;
            raycaster.setFromCamera(pointer, camera);

            // ==========================================
            // ★追加：編集モード時のブロックドラッグ開始
            // ==========================================
            if (isEditing && editingBlock && currentTool === null) {
                const houseGroup = window.getHouseGroup?.() || scene;
                const intersects = raycaster.intersectObject(houseGroup, true);
                if (intersects.length > 0) {
                    const hit = intersects[0];
                    const hitId = hit.object.userData.id;
                    
                    // ★追加：グループ移動中なら「グループ内のどれか」をクリックしていればOKとする
                    const isTargetHit = isGroupEditing 
                        ? editingGroupBlocks.some(b => b.id === hitId)
                        : hitId === editingBlock.id;

                    if (isTargetHit) {
                        const pt = getGroundIntersect(e);
                        if (pt) {
                            isDraggingBlock = true;
                            dragStartMouse.copy(pt);
                            dragStartBlockPos.set(editingBlock.x, 0, editingBlock.z);
                            
                            // ★追加：グループ全体の移動開始時の座標を記憶する
                            if (isGroupEditing) {
                                editingGroupBlocks.forEach(b => {
                                    b.startX = b.x;
                                    b.startZ = b.z;
                                });
                            }
                            controls.enabled = false; 
                            return; 
                        }
                    } else {
                        exitEditMode();
                    }
                } else {
                    exitEditMode(); // これ一行にまとめます
                }
            }

            // ★追加：つまみを掴んだら、その場で押し引きを始める。
            //   ★ 「押し出しモードに切り替えてから面を引く」を覚えないと使えない
            //     のが、いちばん分かりにくいところだった。つまみは【モードの外】に
            //     置いて、掴んだ瞬間に押し引きへ入る。
            // ★追加：地面の【移動のつまみ】。掴んだ軸に沿って建物ごと動かす。
            //   ⚠️ 何よりも先に見ること。建物に重なって出ているので、あとから
            //     見ると壁の面を掴んだことになってしまう。
            if (moveGizmo && moveGizmo.visible) {
                const gh = raycaster.intersectObjects(moveGizmo.children, false)[0];
                if (gh && gh.object.userData.moveAxis) {
                    const pt = getGroundIntersect(e);
                    if (pt) {
                        gizmoDrag = { axis: gh.object.userData.moveAxis,
                            sx: pt.x, sz: pt.z,
                            blocks: buildingGroupOf(AppState.selectedId)
                                .map((bb) => ({ block: bb, x0: bb.x, z0: bb.z })),
                            moved: false };
                        controls.enabled = false;
                        document.body.style.cursor = 'move';
                        return;
                    }
                }
            }

            grabbedPull = null;
            if (!isEditing) {
                const hp = raycaster.intersectObjects(getPullHandles(), false)[0];
                // ★ 棟の端のつまみ。押し引きとは別のドラッグに入る。
                if (hp && hp.object.userData.ridgeEdge) {
                    const bb = AppState.buildingData.find(d => d.id === hp.object.userData.id);
                    // ★ 並べた形では棟が何本もある。掴んだ球が【どの棟のもの】かを
                    //   矩形番号で引く。
                    const ri = hp.object.userData.ri || 0;
                    const rr = bb && freeRidges(bb).find((q) => q.ri === ri);
                    if (bb && rr) {
                        const ax = hp.object.userData.ridgeAlongX;
                        grabbedRidge = { id: bb.id, ri, single: rr.single,
                            edge: hp.object.userData.ridgeEdge,
                            alongX: ax, hs: rr.hs, t0: rr.t, canShift: rr.canShift,
                            // ★ 掴んだ瞬間には【どちらの操作か】をまだ決めない。
                            //   最初に動いた向きで決める（棟に沿う＝切妻、横切る＝棟をずらす）。
                            mode: null,
                            a0: ax ? (hp.point.x - bb.x) : (hp.point.z - bb.z),
                            c0: ax ? (hp.point.z - bb.z) : (hp.point.x - bb.x) };
                        // 棟の高さの水平面へ落として測る。斜めから見ていても、
                        // 棟に沿った位置がそのまま読める。
                        ridgePlane.setFromNormalAndCoplanarPoint(
                            new THREE.Vector3(0, 1, 0), hp.point);
                        controls.enabled = false;
                        return;
                    }
                }
                // ★ 勾配のつまみ。棟の真ん中を上下に引く。
                if (hp && hp.object.userData.slopeHandle) {
                    // ⚠️ 屋根の裏に回った面の定規は【描いていない】。描いていない
                    //   ものを掴めてしまうと、見えない場所で勾配が変わる。
                    //   建物の方が手前にあるなら、掴ませずに素通しする。
                    const hidden = raycaster.intersectObjects(getInteractiveMeshes(), false)
                        .some((x) => x.distance < hp.distance - 1);
                    const bb = hidden ? null
                        : AppState.buildingData.find(d => d.id === hp.object.userData.id);
                    if (bb && bb.roof && bb.roof.params['自由屋根']) {
                        slopeDrag = { id: bb.id, y0: hp.object.userData.y0,
                            den: hp.object.userData.den,
                            // 掴んだ高さと面の高さのずれ。これを引いて測ると、
                            // 定規のどこを掴んでも跳ねない。
                            off: hp.point.y - hp.object.userData.refY };
                        // 上下に測るので、カメラに正対する【鉛直な面】へ落とす。
                        const nrm = new THREE.Vector3();
                        camera.getWorldDirection(nrm);
                        nrm.y = 0;
                        if (nrm.lengthSq() < 1e-9) nrm.set(0, 0, 1);
                        nrm.normalize();
                        flatPlane.setFromNormalAndCoplanarPoint(nrm, hp.point);
                        controls.enabled = false;
                        return;
                    }
                }
                // ★ 屋根の切り欠きのつまみ。真ん中は穴ごと、4辺はその辺だけ動く。
                if (hp && hp.object.userData.notchRole) {
                    const bb = AppState.buildingData.find(
                        d => d.id === hp.object.userData.id);
                    const n0 = bb && freeNotch(bb);
                    if (bb && n0) {
                        notchDrag = { id: bb.id, role: hp.object.userData.notchRole,
                            base: { ...n0 }, u0: hp.point.x - bb.x, v0: hp.point.z - bb.z };
                        // 穴の底の高さの水平面へ落として測る。斜めから見ていても、
                        // 屋根の上での動きがそのまま読める。
                        eavePlane.setFromNormalAndCoplanarPoint(
                            new THREE.Vector3(0, 1, 0), hp.point);
                        controls.enabled = false;
                        return;
                    }
                }
                // ★ 軒先のバー。掴んで引くと、その辺の軒の出が変わる。
                //   ⚠️ 屋根の裏に回ったバーは描いていないので掴ませない。
                if (hp && hp.object.userData.eaveEdge) {
                    const hidden = raycaster.intersectObjects(getInteractiveMeshes(), false)
                        .some((x) => x.distance < hp.distance - 1);
                    const bb = hidden ? null
                        : AppState.buildingData.find(d => d.id === hp.object.userData.id);
                    if (bb) {
                        const key = hp.object.userData.eaveEdge;
                        const [dx, dz] = OUT_DIR[key];
                        eaveDrag = { id: bb.id, ri: hp.object.userData.ri || 0,
                            key, out0: hp.object.userData.out,
                            u0: (hp.point.x - bb.x) * dx + (hp.point.z - bb.z) * dz };
                        // 軒先の高さの水平面へ落として測る。斜めから見ていても、
                        // 外向きへ動かした量がそのまま読める。
                        eavePlane.setFromNormalAndCoplanarPoint(
                            new THREE.Vector3(0, 1, 0), hp.point);
                        controls.enabled = false;
                        return;
                    }
                }
                // ★ 下屋の軒先・ケラバのバー。掴んで外へ引くと出が変わる。
                if (hp && hp.object.userData.geyaEdge) {
                    const hidden = raycaster.intersectObjects(getInteractiveMeshes(), false)
                        .some((x) => x.distance < hp.distance - 1);
                    const bb = hidden ? null
                        : AppState.buildingData.find(d => d.id === hp.object.userData.id);
                    if (bb && bb.lowerRoof) {
                        const u = hp.object.userData;
                        const [dx, dz] = GEYA_OUT_DIR[u.geyaEdge];
                        geyaEaveDrag = { id: bb.id, dir: u.geyaEdge, role: u.geyaRole,
                            param: u.geyaParam, out0: u.out,
                            u0: (hp.point.x - bb.x) * dx + (hp.point.z - bb.z) * dz };
                        eavePlane.setFromNormalAndCoplanarPoint(
                            new THREE.Vector3(0, 1, 0), hp.point);
                        controls.enabled = false;
                        return;
                    }
                }
                // ★ 下屋の勾配の定規。
                if (hp && hp.object.userData.geyaSlope) {
                    const hidden = raycaster.intersectObjects(getInteractiveMeshes(), false)
                        .some((x) => x.distance < hp.distance - 1);
                    const bb = hidden ? null
                        : AppState.buildingData.find(d => d.id === hp.object.userData.id);
                    if (bb && bb.lowerRoof) {
                        geyaSlopeDrag = { id: bb.id, den: hp.object.userData.den,
                            off: hp.point.y - hp.object.userData.refY };
                        const nrm = new THREE.Vector3();
                        camera.getWorldDirection(nrm);
                        nrm.y = 0;
                        if (nrm.lengthSq() < 1e-9) nrm.set(0, 0, 1);
                        nrm.normalize();
                        flatPlane.setFromNormalAndCoplanarPoint(nrm, hp.point);
                        controls.enabled = false;
                        return;
                    }
                }
                // ★ パラペット修景屋根の帯・棟。水平に引いて寸法を決める。
                if (hp && hp.object.userData.paraBar) {
                    const u = hp.object.userData;
                    const hidden = u.paraBar !== 'ridge'
                        && raycaster.intersectObjects(getInteractiveMeshes(), false)
                            .some((x) => x.distance < hp.distance - 1);
                    const bb = hidden ? null
                        : AppState.buildingData.find(d => d.id === u.id);
                    if (bb) {
                        const [dx, dz] = PARA_OUT_DIR[u.paraDir];
                        paraDrag = { id: bb.id, param: u.paraParam, sign: u.sign,
                            v0: u.value,
                            u0: (hp.point.x - bb.x) * dx + (hp.point.z - bb.z) * dz,
                            dx, dz,
                            // 内へ引くものは建物の半分まで。外へ出るものは別の上限。
                            max: u.paraParam === 'out_px' ? PARA_MAX_OUT
                                : Math.min(bb.w / 2, bb.d / 2) };
                        eavePlane.setFromNormalAndCoplanarPoint(
                            new THREE.Vector3(0, 1, 0), hp.point);
                        controls.enabled = false;
                        return;
                    }
                }
                // ★ パラペットの立ち上がり。上下に引く。
                if (hp && hp.object.userData.paraHeight) {
                    const bb = AppState.buildingData.find(
                        d => d.id === hp.object.userData.id);
                    if (bb) {
                        paraHDrag = { id: bb.id, v0: hp.object.userData.value,
                            y0: hp.point.y };
                        const nrm = new THREE.Vector3();
                        camera.getWorldDirection(nrm);
                        nrm.y = 0;
                        if (nrm.lengthSq() < 1e-9) nrm.set(0, 0, 1);
                        nrm.normalize();
                        flatPlane.setFromNormalAndCoplanarPoint(nrm, hp.point);
                        controls.enabled = false;
                        return;
                    }
                }
                // ★ 笠木の勾配の定規。
                if (hp && hp.object.userData.paraSlope) {
                    const hidden = raycaster.intersectObjects(getInteractiveMeshes(), false)
                        .some((x) => x.distance < hp.distance - 1);
                    const bb = hidden ? null
                        : AppState.buildingData.find(d => d.id === hp.object.userData.id);
                    if (bb) {
                        paraSlopeDrag = { id: bb.id, y0: hp.object.userData.y0,
                            den: hp.object.userData.den,
                            off: hp.point.y - hp.object.userData.refY };
                        const nrm = new THREE.Vector3();
                        camera.getWorldDirection(nrm);
                        nrm.y = 0;
                        if (nrm.lengthSq() < 1e-9) nrm.set(0, 0, 1);
                        nrm.normalize();
                        flatPlane.setFromNormalAndCoplanarPoint(nrm, hp.point);
                        controls.enabled = false;
                        return;
                    }
                }
                // ★ 屋上の平場のつまみ。下げるほど平場が広がる。
                if (hp && hp.object.userData.flatHandle) {
                    const bb = AppState.buildingData.find(d => d.id === hp.object.userData.id);
                    const fl = bb && freeRoofFlat(bb);
                    if (bb && fl) {
                        // ★ 控えるのは割合ではなく【軒高からの高さ】。平場を
                        //   いっぱいまで広げた先（マイナス側）にパラペットの
                        //   陸屋根があるので、割合では表せない。
                        flatDrag = { id: bb.id, span: fl.span, y0: hp.point.y,
                            t0: fl.parapet ? -PARAPET_DRAG : fl.flatT * fl.span };
                        // 上下に測るので、カメラに正対する【鉛直な面】へ落とす。
                        const nrm = new THREE.Vector3();
                        camera.getWorldDirection(nrm);
                        nrm.y = 0;
                        if (nrm.lengthSq() < 1e-9) nrm.set(0, 0, 1);
                        nrm.normalize();
                        flatPlane.setFromNormalAndCoplanarPoint(nrm, hp.point);
                        controls.enabled = false;
                        return;
                    }
                }
                // ★ 修景要素のつまみ。掴んで引くと、その辺（その寸法）だけが動く。
                if (hp && hp.object.userData.partRole) {
                    const u = hp.object.userData;
                    const bb = AppState.buildingData.find(d => d.id === u.id);
                    const sel = { kind: u.partKind, dir: u.partDir,
                        i: u.partIndex || 0, side: u.partSide || null };
                    if (bb && startPartDrag(bb, sel, u.partRole, hp.point)) return;
                }
                // ⚠️ 押し引きの札が無いものはここで拾わない。隠れていて見送った
                //   勾配の定規が、向きの無い押し引きとして掴まれてしまう。
                // ★ 【選んでいる】修景要素そのものを掴んだら、その場で動かす。
                //   ⚠️ 選ぶ前から動かせてはいけない。置いてある窓に触れるたびに
                //     位置が変わってしまう。1回めのクリックで選び、次から動かす。
                //   ⚠️ 押し引きのつまみより【要素が先】。窓は面の中ほどに置かれる
                //     ので、つまみと必ず重なる。
                if ((!hp || hp.object.userData.pullDir) && AppState.selectedId
                    && AppState.selectedPart) {
                    const hg = window.getHouseGroup?.() || scene;
                    const dh = raycaster.intersectObject(hg, true)
                        .find((x) => x.object.userData && x.object.userData.isDeco);
                    const ud = dh && dh.object.userData;
                    const sel = (ud && ud.id === AppState.selectedId)
                        ? partSelOf(ud, AppState.selectedFaceDir) : null;
                    // ⚠️ バルコニーは面いっぱいに架かっていて、動かす先が無い。
                    //   掴んでも何も起きないと故障に見えるので、掴ませない。
                    if (sel && sel.kind !== 'balc' && sameSel(sel, AppState.selectedPart)) {
                        const bb = AppState.buildingData.find(d => d.id === ud.id);
                        if (bb && startPartDrag(bb, sel, 'move', dh.point)) return;
                    }
                }
                if (hp && hp.object.userData.pullDir) {
                    grabbedPull = { id: hp.object.userData.id,
                        dir: hp.object.userData.pullDir, point: hp.point };
                    // ⚠️ 借りたモードは【必ず返す】。押し出しのまま残ると、以降
                    //   どこをクリックしても選択に入らず、屋根も掴めなくなる。
                    toolBeforePull = currentTool;
                    currentTool = 'EXTRUDE';
                }
            }

            if (currentTool === 'DRAW') {
                const pt = getGroundIntersect(e);
                if (!pt) return;
                isDrawing = true;
                drawStartPt.copy(pt);
                controls.enabled = false;

            } else if (currentTool === 'EXTRUDE') {
                const interactiveMeshes = getInteractiveMeshes();
                const intersects = grabbedPull ? [] : raycaster.intersectObjects(interactiveMeshes);
                if (grabbedPull || intersects.length > 0) {
                    const hit = grabbedPull ? { point: grabbedPull.point } : intersects[0];
                    const hitId = grabbedPull ? grabbedPull.id : hit.object.userData.id;

                    if (!AppState.selectedId || AppState.selectedId !== hitId) return;

                    const normal = grabbedPull ? null
                        : hit.face.normal.clone().transformDirection(hit.object.matrixWorld).normalize();
                    
                    let hitFaceDir = grabbedPull ? grabbedPull.dir : null;
                    // ★追加：図面の階は、外壁の外側以外を押したら【上面】。
                    if (!hitFaceDir && !hit.object.userData.isRoof) {
                        const bb = AppState.buildingData.find(d => d.id === hitId);
                        if (bb && bb.kind === 'dxf') hitFaceDir = dxfFaceDir(bb, hit.point, normal);
                    }
                    if (!hitFaceDir) {
                        if (hit.object.userData.isRoof || normal.y > 0.5) hitFaceDir = 'top';
                        else if (normal.y < -0.5) hitFaceDir = 'bottom';
                        else if (normal.z > 0.5) hitFaceDir = 'pz';
                        else if (normal.z < -0.5) hitFaceDir = 'nz';
                        else if (normal.x > 0.5) hitFaceDir = 'px';
                        else if (normal.x < -0.5) hitFaceDir = 'nx';
                    }

                    if (!AppState.selectedFaceDir || AppState.selectedFaceDir !== hitFaceDir) return;

                    const baseBlock = AppState.buildingData.find(d => d.id === hitId);
                    // ★追加：DXF から起こした階は【側面を押し引きしない】。
                    //   平面の形は図面が決めているので、3D で引くと図面と食い違う。
                    //   高さ（上面）だけは今までどおり引ける。
                    if (baseBlock && baseBlock.kind === 'dxf' && hitFaceDir !== 'top') return;

                    extrudeNormal.set(0,0,0);
                    if (hitFaceDir === 'top') extrudeNormal.set(0,1,0); 
                    else if (hitFaceDir === 'bottom') return; 
                    else if (hitFaceDir === 'px') extrudeNormal.set(1,0,0); 
                    else if (hitFaceDir === 'nx') extrudeNormal.set(-1,0,0); 
                    else if (hitFaceDir === 'pz') extrudeNormal.set(0,0,1); 
                    else if (hitFaceDir === 'nz') extrudeNormal.set(0,0,-1); 
                    else return;

                    isExtruding = true;
                    connectedBlocks = [];

                    const camDir = camera.getWorldDirection(new THREE.Vector3()).negate();
                    const axis = extrudeNormal.clone();
                    
                    const cross1 = new THREE.Vector3().crossVectors(axis, camDir);
                    let planeNormal = new THREE.Vector3().crossVectors(cross1, axis).normalize();
                    
                    if (planeNormal.lengthSq() < 0.001) {
                        planeNormal = axis.y === 0 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
                    }
                    
                    activePlane.setFromNormalAndCoplanarPoint(planeNormal, hit.point);
                    extrudeStartPt.copy(hit.point);

                    if (extrudeNormal.y > 0) {
                        // ★ 上面の Shift ＋引く（上階を足す）はやめた。
                        //   ⚠️ 隠れた操作は、知らない人には無いのと同じで、知って
                        //     いる人には暴発の種でしかない。上階はパネルの
                        //     【上階を足す】から足す。
                        {
                            extrudeTargetId = hitId;
                            // ★ 大屋根を掛けた並びは【ひとかたまり】。階の高さは
                            //   まとめて動かす。
                            //   ⚠️ 1つだけ動かすと天端が食い違い、その瞬間に並びが
                            //     ばらけて（roofGroup は天端の一致で見ている）
                            //     大屋根が割れる。掴んだ面だけ持ち上がって見える。
                            const grp = freeRoofOwner(baseBlock)
                                ? roofGroup(baseBlock) : [baseBlock];
                            const order = [baseBlock,
                                ...grp.filter(g => g.id !== baseBlock.id)];
                            const seen = new Set();
                            order.forEach(gb => {
                                AppState.getStackedBlocks([gb]).forEach(ob => {
                                    if (seen.has(ob.id)) return;
                                    seen.add(ob.id);
                                    const box = { ...ob };
                                    if (ob.id === baseBlock.id) {
                                        connectedBlocks.push({ block: ob, startBox: box, type: 'resize' });
                                    } else if (grp.some(g => g.id === ob.id)) {
                                        // 並びの相棒。高さが違っても【同じだけ】伸ばす。
                                        connectedBlocks.push({ block: ob, startBox: box, type: 'resizeSib' });
                                    } else {
                                        connectedBlocks.push({ block: ob, startBox: box, type: 'translate' });
                                    }
                                });
                            });
                            rebuildMeshes();
                            connectedBlocks.forEach(cb => window.setMeshActiveMaterial?.(cb.block.id));
                        }
                    } 
                    else {
                        if (e.shiftKey) {
                            const newId = Date.now().toString();
                            const newBlock = {
                                id: newId, // ★変更
                                rootBuildingId: baseBlock.rootBuildingId || baseBlock.id, // ★追加：親のルーツを受け継ぐ
                                x: baseBlock.x, y: baseBlock.y || 0, z: baseBlock.z,
                                w: baseBlock.w, d: baseBlock.d, h: baseBlock.h 
                            };
                            if (extrudeNormal.x !== 0) {
                                newBlock.w = 500;
                                newBlock.x = baseBlock.x + (baseBlock.w / 2 + 250) * extrudeNormal.x;
                            } else if (extrudeNormal.z !== 0) {
                                newBlock.d = 500;
                                newBlock.z = baseBlock.z + (baseBlock.d / 2 + 250) * extrudeNormal.z;
                            }
                            AppState.buildingData.push(newBlock);
                            extrudeTargetId = newBlock.id;
                            connectedBlocks.push({ block: newBlock, startBox: { ...newBlock }, type: 'resize', normal: extrudeNormal.clone() });
                            
                            rebuildMeshes(); 
                            window.setMeshActiveMaterial?.(newBlock.id);
                        } else {
                            extrudeTargetId = hitId;
                            
                            AppState.buildingData.forEach(ob => {
                                if (ob.id === baseBlock.id) return;
                                
                                let isTouchingOpposite = false;
                                if (extrudeNormal.x !== 0) {
                                    const targetEdge = baseBlock.x + (baseBlock.w/2) * extrudeNormal.x;
                                    const obOppositeEdge = ob.x - (ob.w/2) * extrudeNormal.x; 
                                    
                                    if (Math.abs(obOppositeEdge - targetEdge) < 1) { 
                                        const overlapZ = Math.abs(ob.z - baseBlock.z) * 2 < (ob.d + baseBlock.d) - 1;
                                        const overlapY = Math.max((ob.y||0), (baseBlock.y||0)) < Math.min((ob.y||0)+ob.h, (baseBlock.y||0)+baseBlock.h) - 1;
                                        if (overlapZ && overlapY) isTouchingOpposite = true;
                                    }
                                } else if (extrudeNormal.z !== 0) {
                                    const targetEdge = baseBlock.z + (baseBlock.d/2) * extrudeNormal.z;
                                    const obOppositeEdge = ob.z - (ob.d/2) * extrudeNormal.z;
                                    
                                    if (Math.abs(obOppositeEdge - targetEdge) < 1) { 
                                        const overlapX = Math.abs(ob.x - baseBlock.x) * 2 < (ob.w + baseBlock.w) - 1;
                                        const overlapY = Math.max((ob.y||0), (baseBlock.y||0)) < Math.min((ob.y||0)+ob.h, (baseBlock.y||0)+baseBlock.h) - 1;
                                        if (overlapX && overlapY) isTouchingOpposite = true;
                                    }
                                }
                                
                                if (isTouchingOpposite) {
                                    connectedBlocks.push({ block: ob, startBox: { ...ob }, type: 'resize', normal: extrudeNormal.clone().negate() });
                                }
                            });
                            connectedBlocks.push({ block: baseBlock, startBox: { ...baseBlock }, type: 'resize', normal: extrudeNormal.clone() });
                            
                            rebuildMeshes();
                            connectedBlocks.forEach(cb => window.setMeshActiveMaterial?.(cb.block.id));
                        }
                    }
                    controls.enabled = false;
                }
            }
        });

        window.addEventListener('pointermove', (e) => {
            if (isLocked) return;                 // ★外構作図モード中
            const p = getMainPointer(e);
            if (!p) {
                document.body.style.cursor = 'default';
                return; 
            }
            pointer.x = p.x;
            pointer.y = p.y;

            // ★追加：建物ごと動かしているあいだ。地面の上で測る。
            if (gizmoDrag) {
                const pt = getGroundIntersect(e);
                if (pt) {
                    const dx = (gizmoDrag.axis === 'z') ? 0 : snap(pt.x - gizmoDrag.sx);
                    const dz = (gizmoDrag.axis === 'x') ? 0 : snap(pt.z - gizmoDrag.sz);
                    if (dx || dz) gizmoDrag.moved = true;
                    for (const it of gizmoDrag.blocks) {
                        it.block.x = it.x0 + dx;
                        it.block.z = it.z0 + dz;
                    }
                    rebuildMeshes();
                }
                document.body.style.cursor = 'move';
                return;
            }

            // ★追加：修景要素を動かしているあいだ。壁の面に沿って測る。
            //   ⚠️ 奥行（そで壁）は面から外へ出る向きなので、水平面へ落として測る。
            if (partDrag) {
                raycaster.setFromCamera(pointer, camera);
                const hitPt = new THREE.Vector3();
                const b = AppState.buildingData.find(d => d.id === partDrag.id);
                if (b && raycaster.ray.intersectPlane(partPlane, hitPt)) {
                    const f = basisOf(b, partDrag.sel);
                    const u = (hitPt.x - b.x) * f.u[0] + (hitPt.z - b.z) * f.u[1];
                    const d = (hitPt.x - b.x) * f.n[0] + (hitPt.z - b.z) * f.n[1] - f.half;
                    const du = u - partDrag.u0, dy = hitPt.y - partDrag.y0;
                    const dd = d - partDrag.d0;
                    if (Math.abs(du) > 15 || Math.abs(dy) > 15 || Math.abs(dd) > 15) {
                        partDrag.moved = true;
                    }
                    applyPartDrag(b, partDrag, du, dy, dd);
                    rebuildMeshes();
                    UIController.showPartInfo(b, partDrag.sel, true);
                    // ★ 手のそばにも数字を出す。右上まで目を往復させずに済む。
                    const lab = partDragLabel(b, partDrag);
                    if (lab) showTip(e, lab); else hideTip();
                }
                document.body.style.cursor = (partDrag.role === 'move') ? 'move'
                    : ((partDrag.role === 'depth' || partDrag.role[0] === 'u')
                        ? 'ew-resize' : 'ns-resize');
                return;
            }

            // ★追加：屋根の切り欠きを動かしているあいだ。
            //   ⚠️ 入らない形にはしない。外形からはみ出した穴は、屋根の外に
            //     ぽっかり口が開いて見える。入らないときは動かさない。
            if (notchDrag) {
                raycaster.setFromCamera(pointer, camera);
                const hitPt = new THREE.Vector3();
                const b = AppState.buildingData.find(d => d.id === notchDrag.id);
                if (b && raycaster.ray.intersectPlane(eavePlane, hitPt)) {
                    const sn = (v) => Math.round(v / NOTCH_SNAP) * NOTCH_SNAP;
                    const mx = sn(hitPt.x - b.x - notchDrag.u0);
                    const mz = sn(hitPt.z - b.z - notchDrag.v0);
                    const d = notchDrag, o = d.base;
                    const n = { ...o };
                    if (d.role === 'move') {
                        n.x0 = o.x0 + mx; n.x1 = o.x1 + mx;
                        n.z0 = o.z0 + mz; n.z1 = o.z1 + mz;
                    } else if (d.role === 'w') n.x0 = Math.min(o.x0 + mx, o.x1 - NOTCH_MIN);
                    else if (d.role === 'e') n.x1 = Math.max(o.x1 + mx, o.x0 + NOTCH_MIN);
                    else if (d.role === 's') n.z0 = Math.min(o.z0 + mz, o.z1 - NOTCH_MIN);
                    else if (d.role === 'n') n.z1 = Math.max(o.z1 + mz, o.z0 + NOTCH_MIN);
                    const pr = b.roof && b.roof.params && b.roof.params['自由屋根'];
                    if (pr && notchFits(b, n)) {
                        pr.notch = n;
                        notchDrag.moved = true;
                        rebuildMeshes();
                    }
                }
                document.body.style.cursor = 'move';
                return;
            }

            // ★追加：軒先を引いているあいだ。軒の出・けらばの出を辺ごとに変える。
            if (eaveDrag) {
                raycaster.setFromCamera(pointer, camera);
                const hitPt = new THREE.Vector3();
                if (raycaster.ray.intersectPlane(eavePlane, hitPt)) {
                    const b = AppState.buildingData.find(d => d.id === eaveDrag.id);
                    if (b && b.roof && b.roof.params['自由屋根']) {
                        const [dx, dz] = OUT_DIR[eaveDrag.key];
                        // 外向きへ動いた量。そのぶん軒が出る。
                        const u = (hitPt.x - b.x) * dx + (hitPt.z - b.z) * dz;
                        let out = eaveDrag.out0 + (u - eaveDrag.u0);
                        out = Math.max(0, Math.min(EAVE_MAX, out));
                        out = Math.round(out / EAVE_SNAP) * EAVE_SNAP;
                        const pr = b.roof.params['自由屋根'];
                        // ★ 動かすのは【掴んだバーの軒】だけ。矩形ごと・辺ごとに
                        //   持つ。⚠️ 辺ごと（o西 など）に書くと、同じ向きの軒が
                        //   ぜんぶ一緒に動いて、片方だけ詰められない。
                        const outs = ownMap(pr, 'outs');
                        const key = `${eaveDrag.ri}:${eaveDrag.key}`;
                        if (outs[key] !== out) {
                            outs[key] = out;
                            rebuildMeshes();
                        }
                        showTip(e, `軒の出（${EDGE_LABEL[eaveDrag.key]}） `
                            + `${Math.round(out)} mm`);
                    }
                }
                document.body.style.cursor = 'grabbing';
                return;
            }

            // ★追加：勾配を変えているあいだ。棟の高さを勾配に読み替える。
            if (slopeDrag) {
                raycaster.setFromCamera(pointer, camera);
                const hitPt = new THREE.Vector3();
                if (raycaster.ray.intersectPlane(flatPlane, hitPt)) {
                    const b = AppState.buildingData.find(d => d.id === slopeDrag.id);
                    if (b && b.roof && b.roof.params['自由屋根']) {
                        // その面の高さから勾配を逆に解く（den は roofMesh 側で用意）。
                        const sun = ((hitPt.y - slopeDrag.off - slopeDrag.y0)
                            / slopeDrag.den) * 10;
                        {
                            // 0.5寸 刻み。細かすぎると 4寸ちょうどに止められない。
                            const q = Math.min(10, Math.max(0.5,
                                Math.round(sun * 2) / 2));
                            const pr = b.roof.params['自由屋根'];
                            if (pr.slope !== q) { pr.slope = q; rebuildMeshes(); }
                            showTip(e, `勾配 ${q.toFixed(1)} 寸`);
                        }
                    }
                }
                document.body.style.cursor = 'ns-resize';
                return;
            }

            // ★追加：屋上の平場を広げ縮めしているあいだ。
            if (flatDrag) {
                raycaster.setFromCamera(pointer, camera);
                const hitPt = new THREE.Vector3();
                if (raycaster.ray.intersectPlane(flatPlane, hitPt)) {
                    const b = AppState.buildingData.find(d => d.id === flatDrag.id);
                    if (b && b.roof && b.roof.params['自由屋根']) {
                        const pr = b.roof.params['自由屋根'];
                        const span = flatDrag.span;
                        const y = flatDrag.t0 + (hitPt.y - flatDrag.y0);
                        // ★ 0 より下へさらに引くと、軒の出なしの陸屋根＋パラペットへ。
                        const para = y < -PARAPET_DRAG;
                        // ★ 吸い付かせるのは【平場いっぱい（陸屋根）】だけ。
                        //   ⚠️ 上にも吸い付かせてはいけない。2つの山がぴったり
                        //     合わさる手前の【細い平場】に手が届かなくなる。
                        //     そこがいちばん使いたい形。
                        //   てっぺんまで押し上げれば頭打ちでちょうど「平場なし」に
                        //   なるので、上に吸い付かせる必要がそもそも無い。
                        const yc = snapMarks(Math.max(0, Math.min(span, y)), [0]);
                        const t = para ? 0 : yc / span;
                        if (pr.flatT !== t || !!pr.parapet !== para) {
                            pr.flatT = t; pr.parapet = para;
                            rebuildMeshes();
                        }
                        // ★ 割合だけでは広さが読めない。周りに残る勾配屋根の
                        //   帯の幅（軒先から平場のふちまで）も一緒に出す。
                        const fl = freeRoofFlat(b);
                        const w = (fl && fl.band > 0)
                            ? `　屋根の幅 ${(fl.band / 1000).toFixed(2)} m` : '';
                        showTip(e, para ? 'パラペット（陸屋根）'
                            : (t >= 1 - 1e-9 ? '平場なし'
                                : `平場 ${Math.round((1 - t) * 100)}%${w}`));
                    }
                }
                document.body.style.cursor = 'ns-resize';
                return;
            }

            // ★追加：パラペット修景屋根の帯・棟を引いているあいだ。
            if (paraDrag) {
                raycaster.setFromCamera(pointer, camera);
                const hitPt = new THREE.Vector3();
                if (raycaster.ray.intersectPlane(eavePlane, hitPt)) {
                    const b = AppState.buildingData.find(d => d.id === paraDrag.id);
                    const pr = b && b.roof && b.roof.params
                        && b.roof.params['パラペット修景'];
                    if (pr) {
                        const pd = paraDrag;
                        const u = (hitPt.x - b.x) * pd.dx + (hitPt.z - b.z) * pd.dz;
                        let v = pd.v0 + pd.sign * (u - pd.u0);
                        v = Math.max(0, Math.min(pd.max, v));
                        v = Math.round(v / PARA_SNAP) * PARA_SNAP;
                        if (pr[pd.param] !== v) {
                            pr[pd.param] = v;
                            // ⚠️ 棟は内への寸法の内側にしか置けない。外へ出すと
                            //   屋根が裏返る。逆に内への寸法を詰めたら棟も連れて戻す。
                            if (pd.param === 'in_px' && pr.ridge_dist > v) pr.ridge_dist = v;
                            if (pd.param === 'ridge_dist' && v > (pr.in_px || 0)) {
                                pr.ridge_dist = pr.in_px || 0;
                            }
                            rebuildMeshes();
                        }
                        showTip(e, `${PARA_ROLE[pd.param]} ${Math.round(v)} mm`);
                    }
                }
                document.body.style.cursor = 'grabbing';
                return;
            }

            // ★追加：パラペットの立ち上がりを引いているあいだ。
            if (paraHDrag) {
                raycaster.setFromCamera(pointer, camera);
                const hitPt = new THREE.Vector3();
                if (raycaster.ray.intersectPlane(flatPlane, hitPt)) {
                    const b = AppState.buildingData.find(d => d.id === paraHDrag.id);
                    const pr = b && b.roof && b.roof.params
                        && b.roof.params['パラペット修景'];
                    if (pr) {
                        let v = paraHDrag.v0 + (hitPt.y - paraHDrag.y0);
                        v = Math.max(PARA_H_MIN, Math.min(PARA_H_MAX, v));
                        v = Math.round(v / PARA_SNAP) * PARA_SNAP;
                        if (pr.pHeight !== v) { pr.pHeight = v; rebuildMeshes(); }
                        showTip(e, `パラペットの高さ ${Math.round(v)} mm`);
                    }
                }
                document.body.style.cursor = 'ns-resize';
                return;
            }

            // ★追加：笠木の勾配を引いているあいだ。
            if (paraSlopeDrag) {
                raycaster.setFromCamera(pointer, camera);
                const hitPt = new THREE.Vector3();
                if (raycaster.ray.intersectPlane(flatPlane, hitPt)) {
                    const b = AppState.buildingData.find(d => d.id === paraSlopeDrag.id);
                    const pr = b && b.roof && b.roof.params
                        && b.roof.params['パラペット修景'];
                    if (pr) {
                        const sun = ((hitPt.y - paraSlopeDrag.off - paraSlopeDrag.y0)
                            / paraSlopeDrag.den) * 10;
                        const q = Math.min(10, Math.max(0, Math.round(sun * 2) / 2));
                        if (pr.slope !== q) { pr.slope = q; rebuildMeshes(); }
                        showTip(e, `笠木の勾配 ${q.toFixed(1)} 寸`);
                    }
                }
                document.body.style.cursor = 'ns-resize';
                return;
            }

            // ★追加：下屋の軒先・ケラバを引いているあいだ。
            if (geyaEaveDrag) {
                raycaster.setFromCamera(pointer, camera);
                const hitPt = new THREE.Vector3();
                if (raycaster.ray.intersectPlane(eavePlane, hitPt)) {
                    const b = AppState.buildingData.find(d => d.id === geyaEaveDrag.id);
                    if (b && b.lowerRoof) {
                        const gd = geyaEaveDrag;
                        const [dx, dz] = GEYA_OUT_DIR[gd.dir];
                        const u = (hitPt.x - b.x) * dx + (hitPt.z - b.z) * dz;
                        let out = gd.out0 + (u - gd.u0);
                        out = Math.max(0, Math.min(GEYA_MAX, out));
                        out = Math.round(out / GEYA_SNAP) * GEYA_SNAP;
                        // ★ 寄棟の下屋は、軒の出が【掛かり幅の比】で縮む。
                        //   引いた辺の出がこの値になるよう、元の値に直して書く。
                        //   ⚠️ そのまま eaves に入れると、掛かりの狭い辺を引いた
                        //     ときに他の辺が跳ね上がる。
                        const a = geyaArgs(b);
                        let val = out;
                        if (a && !a.gable && gd.role === 'eave' && a.out[gd.dir] > 0) {
                            val = out * a.maxOut / a.out[gd.dir];
                        }
                        val = Math.max(0, Math.min(GEYA_MAX, Math.round(val)));
                        if (b.lowerRoof[gd.param] !== val) {
                            b.lowerRoof[gd.param] = val;
                            rebuildMeshes();
                        }
                        const nm = gd.role === 'keraba' ? 'ケラバ' : '軒の出';
                        showTip(e, `下屋の${nm}（${GEYA_LABEL[gd.dir]}） `
                            + `${Math.round(out)} mm`);
                    }
                }
                document.body.style.cursor = 'grabbing';
                return;
            }

            // ★追加：下屋の勾配を引いているあいだ。
            if (geyaSlopeDrag) {
                raycaster.setFromCamera(pointer, camera);
                const hitPt = new THREE.Vector3();
                if (raycaster.ray.intersectPlane(flatPlane, hitPt)) {
                    const b = AppState.buildingData.find(d => d.id === geyaSlopeDrag.id);
                    if (b && b.lowerRoof) {
                        const foot = (b.y || 0) + b.h;
                        // 屋根の厚み（200mm）を引いてから解く。定規は面の上に立つ。
                        const sun = ((hitPt.y - geyaSlopeDrag.off - foot - 200)
                            / geyaSlopeDrag.den) * 10;
                        const q = Math.min(10, Math.max(0.5, Math.round(sun * 2) / 2));
                        if (b.lowerRoof.slope !== q) {
                            b.lowerRoof.slope = q; rebuildMeshes();
                        }
                        showTip(e, `下屋の勾配 ${q.toFixed(1)} 寸`);
                    }
                }
                document.body.style.cursor = 'ns-resize';
                return;
            }

            // ★追加：棟の端を引いているあいだ。棟に沿った位置を、その辺の
            //   【切妻の度合い】に読み替える。軒に届いたら切妻、内へ引けば寄棟。
            if (grabbedRidge) {
                raycaster.setFromCamera(pointer, camera);
                const hitPt = new THREE.Vector3();
                if (raycaster.ray.intersectPlane(ridgePlane, hitPt)) {
                    const b = AppState.buildingData.find(d => d.id === grabbedRidge.id);
                    const gr = grabbedRidge;
                    if (b && b.roof && b.roof.params['自由屋根']) {
                        const pr = b.roof.params['自由屋根'];
                        // 棟に沿った量と、棟を横切る量。建物の中心から見て測る。
                        const a = gr.alongX ? (hitPt.x - b.x) : (hitPt.z - b.z);
                        const c = gr.alongX ? (hitPt.z - b.z) : (hitPt.x - b.x);
                        const mA = a - gr.a0, mC = c - gr.c0;
                        // ★ 同じつまみに2つの意味を持たせる。最初に動いた向きで
                        //   どちらかに決め、そのドラッグのあいだは切り替えない。
                        //   ⚠️ 毎フレーム決め直すと、斜めに動かしたとき2つの操作が
                        //     交互に効いて、形が跳ねる。
                        //   ⚠️ しきい値を小さくしすぎないこと。画面の1ピクセルが
                        //     数十mmに相当するので、40mm では最初の1ピクセルの
                        //     ぶれで向きが決まってしまい、切妻をつまんだ瞬間に
                        //     棟が横へ飛ぶ（招き屋根になる）ことがある。
                        if (!gr.mode && Math.max(Math.abs(mA), Math.abs(mC)) > 300) {
                            gr.mode = Math.abs(mC) > Math.abs(mA) ? 'shift' : 'gable';
                        }
                        if (gr.mode === 'shift') {
                            // ★ 棟を横へずらす。招き屋根、寄せきれば片流れ。
                            //   ⚠️ ずらせるのは【両端とも切妻】のときだけ。
                            if (gr.canShift) {
                                // 中央（素の切妻）と、軒まで寄せきった（片流れ）に吸い付く。
                                const d = snapMarks(
                                    Math.max(-gr.hs, Math.min(gr.hs, gr.t0 * gr.hs + mC)),
                                    [0, gr.hs, -gr.hs]);
                                const t = d / gr.hs;
                                // SHIFT を押しながらなら差し掛け（棟に段差が出る）。
                                const shf = ownMap(pr, 'shf');
                                const cur = shf[gr.ri] || {};
                                if (cur.t !== t || !!cur.step !== !!e.shiftKey) {
                                    shf[gr.ri] = { t, step: !!e.shiftKey };
                                    // ⚠️ 古い1本ぶんの持ち方も揃えておく。読む側は
                                    //   矩形0だけ st を見に行くので、食い違うと戻る。
                                    if (gr.single) { pr.st = t; pr.step = !!e.shiftKey; }
                                    rebuildMeshes();
                                }
                                showTip(e, `棟のずれ ${Math.round(Math.abs(d))} mm`
                                    + `（${Math.abs(t) >= 0.999 ? '片流れ'
                                        : (e.shiftKey ? '差し掛け' : '招き屋根')}）`);
                            }
                        } else if (gr.mode === 'gable') {
                            // ⚠️ 棟をずらしたあとに切妻の度合いを変えると、隅棟が
                            //   45度でなくなって屋根が破綻する。ずれていれば触らない。
                            if (Math.abs(gr.t0) < 1e-6) {
                                const g = ridgeGableFromPos(b, gr.ri, gr.edge, a);
                                if (g !== null) {
                                    const gbl = ownMap(pr, 'gbl');
                                    const key = `${gr.ri}:${gr.edge}`;
                                    // ★ 見るのは比ではなく【軒から棟の端までの長さ】。
                                    //   吸い付くのは 0（切妻ちょうど）と
                                    //   halfSpan（寄棟ちょうど）だけ。
                                    //   ⚠️ 比を刻みで丸めていたときは、端のすぐ手前
                                    //     （度合い 0.05 など）で止まってしまい、
                                    //     屋根に細い切れ込みと余分な線が残った。
                                    const q = 1 - snapMarks(gr.hs * (1 - g),
                                        [0, gr.hs]) / gr.hs;
                                    showTip(e, `切妻の度合い（${EDGE_LABEL[gr.edge]}） `
                                        + `${q.toFixed(2)}`
                                        + `（0=寄棟 / 1=切妻）`);
                                    if (gbl[key] !== q) {
                                        // ⚠️ 立ち上げすぎると【棟の向きが90度変わる】。掴んでいる端は
                                        //   もう棟の端ではなくなり、以降のドラッグが別の辺を動かして、
                                        //   屋根に見慣れない線が走る。向きが変わる手前で止める。
                                        const prev = gbl[key];
                                        gbl[key] = q;
                                        // ⚠️ 直方体1つのときは、屋根形のアイコンが
                                        //   g辺 を見て光る。合わせておかないと、
                                        //   切妻にしたのに寄棟が選ばれたままになる。
                                        //   並べた形では写さない（他の矩形の
                                        //   拠りどころが書き換わってしまう）。
                                        if (gr.single) pr['g' + gr.edge] = q;
                                        const chk = freeRidges(b).find((x) => x.ri === gr.ri);
                                        if (chk && chk.alongX === gr.alongX) rebuildMeshes();
                                        else if (prev === undefined) delete gbl[key];
                                        else gbl[key] = prev;
                                    }
                                }
                            }
                        }
                    }
                }
                document.body.style.cursor = 'grabbing';
                return;
            }

            // ★追加：つまめる軒先を光らせる。
            //   ⚠️ 出すのは【いま選んでいる屋根】だけ。どの屋根でも光らせると、
            //     奥の建物の軒まで反応して画面がちらつく。
            {
                // ★追加：つまみに触れているあいだは【何をするものか】を出す。
                //   ⚠️ 隠れている勾配定規は掴めないので、吹き出しも出さない。
                let over = null;
                if (!isEditing && !grabbedPull && !isExtruding && !isDrawing) {
                    raycaster.setFromCamera(pointer, camera);
                    const hh = raycaster.intersectObjects(getPullHandles(), false)[0];
                    if (hh) {
                        const u = hh.object.userData;
                        const blocked = (u.slopeHandle || u.eaveEdge
                            || u.geyaEdge || u.geyaSlope || u.paraSlope
                            || (u.paraBar && u.paraBar !== 'ridge'))
                            && raycaster.intersectObjects(getInteractiveMeshes(), false)
                                .some((x) => x.distance < hh.distance - 1);
                        if (!blocked) over = handleRole(u);
                    }
                }
                // ★追加：移動のつまみ。触れたら【その軸だけ】濃くして、何を
                //   するものかを出す。薄いままだと掴めるものに見えない。
                let gizAxis = null;
                if (!over && moveGizmo && moveGizmo.visible && !gizmoDrag
                    && !isExtruding && !isDrawing && !grabbedPull) {
                    raycaster.setFromCamera(pointer, camera);
                    const gh = raycaster.intersectObjects(moveGizmo.children, false)[0];
                    if (gh) gizAxis = gh.object.userData.moveAxis;
                }
                if (gizmoMats) {
                    for (const k of ['x', 'z', 'xz']) {
                        const want = (k === gizAxis) ? GIZMO_LIT : GIZMO_DIM;
                        if (gizmoMats[k].opacity !== want) {
                            gizmoMats[k].opacity = want;
                            window.renderAllViews?.();
                        }
                    }
                }
                if (gizAxis) {
                    showTip(e, GIZMO_ROLE[gizAxis]);
                    document.body.style.cursor = 'move';
                } else if (over) { showTip(e, over); document.body.style.cursor = 'grab'; }
                else {
                    hideTip();
                    // ⚠️ つまみから外れたら【カーソルも戻す】。戻さないと、いちど
                    //   つまみに触れたあと画面じゅうが掴めるように見えたままになる。
                    if (document.body.style.cursor === 'grab'
                        || document.body.style.cursor === 'move') {
                        document.body.style.cursor = 'default';
                    }
                }
            }

            updateGizmo(); // ★追加：ギズモの表示位置を更新

            // ==========================================
            // ★追加：編集モード時のカーソル変更 (ホバー判定)
            // ==========================================
            if (isEditing && editingBlock && currentTool === null && !isDraggingBlock) {
                raycaster.setFromCamera(pointer, camera);
                const houseGroup = window.getHouseGroup?.() || scene;
                const intersects = raycaster.intersectObject(houseGroup, true);
                
                let isHoveringEditingBlock = false;
                if (intersects.length > 0) {
                    const hitId = intersects[0].object.userData.id;
                    // ★グループ編集時は、グループ内のどのブロックに乗っても十字カーソルにする
                    if (isGroupEditing) {
                        if (editingGroupBlocks.some(b => b.id === hitId)) isHoveringEditingBlock = true;
                    } else {
                        if (hitId === editingBlock.id) isHoveringEditingBlock = true;
                    }
                }
                
                document.body.style.cursor = isHoveringEditingBlock ? 'move' : 'default';
            }

            // ==========================================
            // ★追加：ドラッグ移動 ＆ 頂点マグネットスナップ
            // ==========================================
            if (isDraggingBlock && editingBlock) {
                document.body.style.cursor = 'move'; 
                
                const pt = getGroundIntersect(e);
                if (!pt) return;

                const deltaX = pt.x - dragStartMouse.x;
                const deltaZ = pt.z - dragStartMouse.z;
                
                let newX = dragStartBlockPos.x + deltaX;
                let newZ = dragStartBlockPos.z + deltaZ;

                const SNAP_DIST = 200; 
                let snapedX = newX;
                let snapedZ = newZ;
                let minSqDist = SNAP_DIST * SNAP_DIST;

                const w2 = editingBlock.w / 2;
                const d2 = editingBlock.d / 2;
                const myCorners = [
                    { x: -w2, z: -d2 }, { x: w2, z: -d2 },
                    { x: -w2, z: d2 }, { x: w2, z: d2 }
                ];

                for (let ob of AppState.buildingData) {
                    // ★追加：全体移動時は、同じ家（グループ内）のブロック同士のマグネット干渉を無視する
                    if (isGroupEditing && editingGroupBlocks.some(gb => gb.id === ob.id)) continue;
                    if (!isGroupEditing && ob.id === editingBlock.id) continue;
                    
                    const obW2 = ob.w / 2;
                    const obD2 = ob.d / 2;
                    const obCorners = [
                        { x: ob.x - obW2, z: ob.z - obD2 },
                        { x: ob.x + obW2, z: ob.z - obD2 },
                        { x: ob.x - obW2, z: ob.z + obD2 },
                        { x: ob.x + obW2, z: ob.z + obD2 }
                    ];

                    for (let myC of myCorners) {
                        const myWorldX = newX + myC.x;
                        const myWorldZ = newZ + myC.z;

                        for (let obC of obCorners) {
                            const dx = obC.x - myWorldX;
                            const dz = obC.z - myWorldZ;
                            const sqDist = dx * dx + dz * dz;

                            if (sqDist < minSqDist) {
                                minSqDist = sqDist;
                                snapedX = newX + dx;
                                snapedZ = newZ + dz;
                            }
                        }
                    }
                }

                // ★追加：実際の移動量に基づいて全体を動かす
                const actualMoveX = snapedX - dragStartBlockPos.x;
                const actualMoveZ = snapedZ - dragStartBlockPos.z;

                if (isGroupEditing) {
                    editingGroupBlocks.forEach(b => {
                        b.x = b.startX + actualMoveX;
                        b.z = b.startZ + actualMoveZ;
                    });
                } else {
                    editingBlock.x = snapedX;
                    editingBlock.z = snapedZ;
                }
                
                updateGizmo(); 
                AppState.updateAllLowerRoofs();
                rebuildMeshes();
                return;
            }

            if (isDrawing) {
                const pt = getGroundIntersect(e);
                if (!pt) return;

                const w = Math.abs(pt.x - drawStartPt.x);
                const d = Math.abs(pt.z - drawStartPt.z);
                const cx = (pt.x + drawStartPt.x) / 2;
                const cz = (pt.z + drawStartPt.z) / 2;
                const h = 100; 

                if (currentDrawObj) {
                    scene.remove(currentDrawObj.mesh, currentDrawObj.line);
                    currentDrawObj.mesh.geometry.dispose();
                }

                if (w > 0 && d > 0) {
                    const geo = new THREE.BoxGeometry(w, h, d);
                    const mesh = new THREE.Mesh(geo, activeMat);
                    mesh.position.set(cx, h / 2, cz);
                    const line = new THREE.LineSegments(new THREE.EdgesGeometry(geo), window.getEdgeMat?.() || activeMat);
                    line.position.copy(mesh.position);
                    scene.add(mesh, line);
                    currentDrawObj = { mesh, line, x: cx, z: cz, w: w, d: d, h: h };
                    
                    if (tooltip) {
                        tooltip.style.display = 'block';
                        tooltip.style.left = (e.clientX + 15) + 'px';
                        tooltip.style.top = (e.clientY + 15) + 'px';
                        tooltip.innerText = `間口: ${(w / 1000).toFixed(1)} m\n奥行: ${(d / 1000).toFixed(1)} m`;
                    }
                } else {
                    if (tooltip) tooltip.style.display = 'none';
                }
                window.renderAllViews?.();

            } else if (isExtruding) {
                let tooltipText = "";

                raycaster.setFromCamera(pointer, camera);
                const target = new THREE.Vector3();              
                const intersect = raycaster.ray.intersectPlane(activePlane, target);

                if (intersect) {
                    if (extrudeNormal.y > 0) {
                        const deltaY = target.y - extrudeStartPt.y; 
                        const mainCb = connectedBlocks.find(cb => cb.type === 'resize');
                        
                        let newH = snap(mainCb.startBox.h + deltaY);
                        if (newH < 500) newH = 500;
                        
                        const actualDeltaY = newH - mainCb.startBox.h;

                        connectedBlocks.forEach(cb => {
                            if (cb.type === 'resize') {
                                cb.block.h = newH;
                            } else if (cb.type === 'resizeSib') {
                                cb.block.h = Math.max(500, cb.startBox.h + actualDeltaY);
                            } else if (cb.type === 'translate') {
                                cb.block.y = cb.startBox.y + actualDeltaY;
                            }
                        });
                        tooltipText = `階高: ${(newH / 1000).toFixed(1)} m`;

                    } else if (extrudeNormal.x !== 0) {
                        const deltaX = target.x - extrudeStartPt.x;
                        let validDeltaX = Math.round(deltaX / currentSnap) * currentSnap;
                        let minDeltaX = -Infinity;
                        let maxDeltaX = Infinity;

                        for (let cb of connectedBlocks) {
                            if (cb.type !== 'resize') continue;
                            const startMovingEdge = cb.startBox.x + (cb.startBox.w/2) * cb.normal.x;
                            const fixedEdge = cb.startBox.x - (cb.startBox.w/2) * cb.normal.x;

                            if (cb.normal.x > 0) {
                                const limit = fixedEdge + 100 - startMovingEdge;
                                if (limit > minDeltaX) minDeltaX = limit;
                            } else if (cb.normal.x < 0) {
                                const limit = fixedEdge - 100 - startMovingEdge;
                                if (limit < maxDeltaX) maxDeltaX = limit;
                            }
                        }

                        if (validDeltaX < minDeltaX) validDeltaX = minDeltaX;
                        if (validDeltaX > maxDeltaX) validDeltaX = maxDeltaX;

                        connectedBlocks.forEach(cb => {
                            if (cb.type !== 'resize') return;
                            const startMovingEdge = cb.startBox.x + (cb.startBox.w/2) * cb.normal.x;
                            const fixedEdge = cb.startBox.x - (cb.startBox.w/2) * cb.normal.x;
                            const movingEdge = startMovingEdge + validDeltaX;
                            
                            cb.block.w = Math.abs(movingEdge - fixedEdge);
                            cb.block.x = (movingEdge + fixedEdge) / 2;
                            if (cb.block.id === extrudeTargetId) tooltipText = `間口: ${(cb.block.w / 1000).toFixed(2)} m`; 
                        });

                    } else if (extrudeNormal.z !== 0) {
                        const deltaZ = target.z - extrudeStartPt.z;
                        let validDeltaZ = Math.round(deltaZ / currentSnap) * currentSnap; // ★変更
                        let minDeltaZ = -Infinity;
                        let maxDeltaZ = Infinity;

                        for (let cb of connectedBlocks) {
                            if (cb.type !== 'resize') continue;
                            const startMovingEdge = cb.startBox.z + (cb.startBox.d/2) * cb.normal.z;
                            const fixedEdge = cb.startBox.z - (cb.startBox.d/2) * cb.normal.z;

                            if (cb.normal.z > 0) {
                                const limit = fixedEdge + 100 - startMovingEdge;
                                if (limit > minDeltaZ) minDeltaZ = limit;
                            } else if (cb.normal.z < 0) {
                                const limit = fixedEdge - 100 - startMovingEdge;
                                if (limit < maxDeltaZ) maxDeltaZ = limit;
                            }
                        }

                        if (validDeltaZ < minDeltaZ) validDeltaZ = minDeltaZ;
                        if (validDeltaZ > maxDeltaZ) validDeltaZ = maxDeltaZ;

                        connectedBlocks.forEach(cb => {
                            if (cb.type !== 'resize') return;
                            const startMovingEdge = cb.startBox.z + (cb.startBox.d/2) * cb.normal.z;
                            const fixedEdge = cb.startBox.z - (cb.startBox.d/2) * cb.normal.z;
                            const movingEdge = startMovingEdge + validDeltaZ;
                            
                            cb.block.d = Math.abs(movingEdge - fixedEdge);
                            cb.block.z = (movingEdge + fixedEdge) / 2;
                            if (cb.block.id === extrudeTargetId) tooltipText = `奥行: ${(cb.block.d / 1000).toFixed(2)} m`; 
                        });
                    }
                }
                
                AppState.updateAllLowerRoofs(); 
                rebuildMeshes(); 
                connectedBlocks.forEach(cb => window.setMeshActiveMaterial?.(cb.block.id));
                
                const mainB = AppState.buildingData.find(d => d.id === extrudeTargetId);
                if (mainB) updateHoverMesh(mainB, extrudeNormal);
                
                if (tooltip) {
                    tooltip.style.display = 'block';
                    tooltip.style.left = (e.clientX + 15) + 'px';
                    tooltip.style.top = (e.clientY + 15) + 'px';
                    tooltip.innerText = tooltipText;
                }

            } else if (currentTool === 'EXTRUDE' && !isExtruding) {
                raycaster.setFromCamera(pointer, camera);
                const interactiveMeshes = getInteractiveMeshes();
                const intersects = raycaster.intersectObjects(interactiveMeshes);
                
                let isHoverValid = false; 

                if (intersects.length > 0) {
                    const hit = intersects[0];
                    const hitId = hit.object.userData.id;
                    
                    if (AppState.selectedId && AppState.selectedId === hitId) {
                        const normal = hit.face.normal.clone().transformDirection(hit.object.matrixWorld).normalize();
                        
                        let hitFaceDir = null;
                        // ★追加：図面の階は、外壁の外側以外を指したら【上面】。
                        const hb = AppState.buildingData.find(d => d.id === hitId);
                        if (hb && hb.kind === 'dxf' && !hit.object.userData.isRoof) {
                            hitFaceDir = dxfFaceDir(hb, hit.point, normal);
                        }
                        else if (hit.object.userData.isRoof || normal.y > 0.5) hitFaceDir = 'top';
                        else if (normal.y < -0.5) hitFaceDir = 'bottom';
                        else if (normal.z > 0.5) hitFaceDir = 'pz';
                        else if (normal.z < -0.5) hitFaceDir = 'nz';
                        else if (normal.x > 0.5) hitFaceDir = 'px';
                        else if (normal.x < -0.5) hitFaceDir = 'nx';

                        if (AppState.selectedFaceDir && AppState.selectedFaceDir === hitFaceDir) {
                            isHoverValid = true;
                            const b = AppState.buildingData.find(d => d.id === hitId);
                            if (b) {
                                let nDir = new THREE.Vector3();
                                if (hitFaceDir === 'top') nDir.set(0,1,0);
                                else if (hitFaceDir === 'bottom') nDir.set(0,-1,0);
                                else if (hitFaceDir === 'px') nDir.set(1,0,0);
                                else if (hitFaceDir === 'nx') nDir.set(-1,0,0);
                                else if (hitFaceDir === 'pz') nDir.set(0,0,1);
                                else if (hitFaceDir === 'nz') nDir.set(0,0,-1);

                                if (nDir.y > 0) {
                                    if (b.roof) {
                                        hoverMesh.visible = false; 
                                    } else {
                                        updateHoverMesh(b, nDir);  
                                    }
                                    // 上面に複製は無い（上階はパネルから）。
                                    document.body.style.cursor = 'ns-resize';
                                } else if (nDir.x !== 0) {
                                    updateHoverMesh(b, nDir);
                                    document.body.style.cursor = e.shiftKey ? 'copy' : 'ew-resize';
                                } else if (nDir.z !== 0) {
                                    updateHoverMesh(b, nDir);
                                    document.body.style.cursor = e.shiftKey ? 'copy' : 'ns-resize'; 
                                }
                            }
                        }
                    }
                }

                if (!isHoverValid) {
                    hoverMesh.visible = false;
                    document.body.style.cursor = 'default';
                }
                window.renderAllViews?.();
            }
        });

        window.addEventListener('keydown', (e) => {
            if (isLocked) return;                 // ★外構作図モード中（Delete等は外構側が受け取る）
            if (currentTool === 'EXTRUDE' && !isExtruding && hoverMesh.visible && e.key === 'Shift') {
                document.body.style.cursor = 'copy'; 
            }
            // ★追加：修景要素を選んでいるときは、その要素だけを消す。
            //   ⚠️ 窓は同じ面に何枚も置ける。そで壁も左右で別もの。面ごと消すと、
            //     狙っていないものまで巻き添えになる。
            if ((e.key === 'Delete' || e.key === 'Backspace')
                && AppState.selectedPart && AppState.selectedId !== null) {
                const b = AppState.buildingData.find(d => d.id === AppState.selectedId);
                const { kind, dir, i, side } = AppState.selectedPart;
                const drop = (box, params) => {
                    if (b[box]) { delete b[box][dir]; if (!Object.keys(b[box]).length) delete b[box]; }
                    if (b[params]) { delete b[params][dir]; if (!Object.keys(b[params]).length) delete b[params]; }
                };
                if (b) {
                    if (kind === 'window') {
                        const list = ModelingEngine.openList(b, dir, 'window');
                        list.splice(i, 1);
                        if (!list.length) drop('windows', 'windowParams');
                    } else if (kind === 'door') {
                        drop('doors', 'doorParams');
                    } else if (kind === 'sode') {
                        // 左右のうち、掴んでいるほうだけ消す。残った側は立てたまま。
                        const mode = b.sodeWalls[dir];
                        const rest = (mode === 'both') ? (side === 'left' ? 'right' : 'left') : null;
                        if (rest) b.sodeWalls[dir] = rest;
                        else drop('sodeWalls', 'sodeParams');
                    } else if (kind === 'tare') {
                        drop('tareWalls', 'tareParams');
                    } else if (kind === 'balc') {
                        drop('balconies', 'balcParams');
                    } else if (kind === 'visor' || kind === 'flat') {
                        // ★ 庇は面ごとに1つ。配列と入れ物の両方から外す。
                        const box = (kind === 'visor') ? 'visors' : 'flatVisors';
                        const par = (kind === 'visor') ? 'visorParams' : 'flatVisorParams';
                        if (Array.isArray(b[box])) {
                            const ix = b[box].indexOf(dir);
                            if (ix > -1) b[box].splice(ix, 1);
                            if (!b[box].length) delete b[box];
                        }
                        if (b[par]) {
                            delete b[par][dir];
                            if (!Object.keys(b[par]).length) delete b[par];
                        }
                    } else if (kind === 'dxfwin') {
                        // ⚠️ 番号で持っているので、消したら後ろがずれる。選択は外す。
                        if (b.plan && b.plan.opens) b.plan.opens.splice(i, 1);
                    }
                }
                AppState.selectedPart = null;
                saveState();
                rebuildMeshes();
                UIController.hideFloatingMenu();
                UIController.clearGUI();
                UIController.updateStatusDisplay(currentTool);
                return;
            }
            if ((e.key === 'Delete' || e.key === 'Backspace') && AppState.selectedId !== null) {
                // ★追加：図面から起こした階は【床の板＋壁】でひとかたまり。
                //   ⚠️ 壁だけ消すと、床板が宙に1枚だけ残る。板を掴んで消した
                //     ときも同じで、壁だけが宙に浮く。
                const gone = new Set([AppState.selectedId]);
                const sel = AppState.buildingData.find(b => b.id === AppState.selectedId);
                if (sel) {
                    const root = (sel.kind === 'slab') ? (sel.rootBuildingId || sel.id) : sel.id;
                    for (const b of AppState.buildingData) {
                        // ⚠️ 上に積んだ階は rootBuildingId を受け継いでいる。
                        //   まとめて消すのは【この階の床板】と、その相方だけ。
                        if (b.rootBuildingId === root && (b.kind === 'slab' || b.id === root)) {
                            gone.add(b.id);
                        }
                    }
                }
                // ★追加：取り込んだモデルは、組み上げた中身を控えてある。
                //   消すときは控えも捨てる（残すと使われないまま場所を取る）。
                for (const id of gone) window.dropModel?.(id);
                AppState.buildingData = AppState.buildingData.filter(b => !gone.has(b.id));
                AppState.selectedId = null;
                saveState(); 
                rebuildMeshes();
                UIController.hideFloatingMenu();    
                UIController.updateStatusDisplay(currentTool); 
                hoverMesh.visible = false;

                exitEditMode();
                UIController.clearGUI();
            }
        });

        window.addEventListener('keyup', (e) => {
            if (isLocked) return;                 // ★外構作図モード中
            if (currentTool === 'EXTRUDE' && !isExtruding && e.key === 'Shift' && hoverMesh.visible) {
                if (hoverMesh.rotation.x === -Math.PI/2) document.body.style.cursor = 'ns-resize'; 
                else if (hoverMesh.rotation.y === Math.PI/2 || hoverMesh.rotation.y === -Math.PI/2) document.body.style.cursor = 'ew-resize';
                else document.body.style.cursor = 'ns-resize';
            }
        });

        window.addEventListener('pointerup', (e) => {
            if (isLocked) return;                 // ★外構作図モード中
            const upPointer = new THREE.Vector2(e.clientX, e.clientY);
            const isClick = downPointer.distanceTo(upPointer) < 5;
            
            // ==========================================
            // ★追加：ドラッグ移動の終了と履歴保存
            // ==========================================
            // ★追加：修景要素の移動・大きさ変えの終了。
            //   ⚠️ 動かしていないときは【選択のふつうの道】へ返すこと。掴んだだけで
            //     終わると、窓をクリックしても何も選ばれない。
            if (notchDrag) {
                const moved = notchDrag.moved;
                notchDrag = null;
                controls.enabled = true;
                document.body.style.cursor = 'default';
                if (moved) { saveState(); return; }
            }

            if (gizmoDrag) {
                const moved = gizmoDrag.moved;
                gizmoDrag = null;
                controls.enabled = true;
                document.body.style.cursor = 'default';
                if (moved) { saveState(); return; }
            }

            if (partDrag) {
                const moved = partDrag.moved;
                partDrag = null;
                hideTip();
                controls.enabled = true;
                document.body.style.cursor = 'default';
                if (moved) { saveState(); return; }
            }

            if (isDraggingBlock) {
                isDraggingBlock = false;
                controls.enabled = true;
                if (!isClick) {
                    saveState(); // 位置を確定して履歴（戻るボタン）に保存
                    return; // ドラッグした場合はここで終了
                }
            }

            if (isClick && e.target.tagName === 'CANVAS') {
                if (currentTool === null) {
                    const p = getMainPointer(e);
                    if (!p) return;
                    pointer.x = p.x;
                    pointer.y = p.y;
                    raycaster.setFromCamera(pointer, camera);
                    
                    const houseGroup = window.getHouseGroup?.() || scene;
                    const intersects = raycaster.intersectObject(houseGroup, true);

                    if (intersects.length > 0) {
                        const hit = intersects[0];
                        const hitId = hit.object.userData.id;
                        const targetBlock = AppState.buildingData.find(d => d.id === hitId);

                        if (targetBlock && targetBlock.h >= 100) {
                            AppState.selectedId = hitId;
                            // ⚠️ 修景要素を押していないなら【要素の選択は外す】。
                            //   外さないと、壁を選んだつもりで Delete が窓を消す。
                            AppState.selectedPart = null;

                            // ★追加：取り込んだ 3D モデル。できるのは【動かす・
                            //   単位を直す・消す】だけ。面も修景も持たないので、
                            //   面の札は出さず、地面の矢印とあらましだけを出す。
                            if (targetBlock.kind === 'model') {
                                AppState.selectedFaceDir = null;
                                UIController.clearGUI();
                                UIController.showFloatingMenu(e.clientX, e.clientY,
                                    targetBlock, 'model', null);
                                UIController.showBlockInfo(targetBlock);
                                rebuildMeshes();
                                UIController.updateStatusDisplay(currentTool);
                                return;
                            }

                            let faceType = null;
                            let faceDir = null;
                            let clickedDecoType = null;

                            if (hit.object.userData.isRoof) {
                                faceType = 'top';
                                AppState.selectedFaceDir = 'top';
                            } else if (hit.object.userData.isDeco) {
                                clickedDecoType = hit.object.userData.type; 
                                
                                if (clickedDecoType === 'lowerRoof') {
                                    faceType = 'top';
                                    AppState.selectedFaceDir = 'top';
                                } else {
                                    faceType = 'side';
                                    faceDir = hit.object.userData.dir;
                                    
                                    if (!faceDir && hit.point) {
                                        const dx = hit.point.x - targetBlock.x;
                                        const dz = hit.point.z - targetBlock.z;
                                        if (Math.abs(dz) / targetBlock.d > Math.abs(dx) / targetBlock.w) {
                                            faceDir = dz > 0 ? 'pz' : 'nz';
                                        } else {
                                            faceDir = dx > 0 ? 'px' : 'nx';
                                        }
                                    }
                                    AppState.selectedFaceDir = faceDir;
                                }
                                // ★ 窓・玄関・そで壁・垂れ壁は【その1つ】を選ぶ。
                                AppState.selectedPart = partSelOf(hit.object.userData, faceDir);
                            } else if (targetBlock.kind === 'dxf') {
                                // ★追加：図面の階は【外壁の外側】だけが側面。中はぜんぶ上面。
                                const normal = hit.face
                                    ? hit.face.normal.clone().transformDirection(hit.object.matrixWorld).normalize()
                                    : null;
                                const dir = dxfFaceDir(targetBlock, hit.point, normal);
                                if (dir === 'top') { faceType = 'top'; AppState.selectedFaceDir = 'top'; }
                                else { faceType = 'side'; faceDir = dir; AppState.selectedFaceDir = dir; }
                            } else {
                                const normal = hit.face.normal.clone().transformDirection(hit.object.matrixWorld).normalize();
                                if (normal.y > 0.5) { faceType = 'top'; AppState.selectedFaceDir = 'top'; }
                                else if (normal.y < -0.5) { faceType = 'bottom'; AppState.selectedFaceDir = 'bottom'; }
                                else {
                                    faceType = 'side';
                                    if (normal.z > 0.5) faceDir = 'pz';
                                    else if (normal.z < -0.5) faceDir = 'nz';
                                    else if (normal.x > 0.5) faceDir = 'px';
                                    else if (normal.x < -0.5) faceDir = 'nx';
                                    AppState.selectedFaceDir = faceDir;
                                }
                            }

                            // ★ 修景要素を選んだときは、パネルを出さない。
                            //   ★ 壁の【何も無いところ】を押したときだけ、プッシュプルと
                            //     修景の札を出す。要素を押したのに、その要素と関係のない
                            //     ボタンが並ぶのは筋が通らない。
                            if (AppState.selectedPart) {
                                // ★ 種類を選べる要素（窓・バルコニー）は、モデルのそばに
                                //   その札を出す。無い要素では何も出さない。
                                UIController.showPartMenu(e.clientX, e.clientY,
                                    targetBlock, AppState.selectedPart);
                                UIController.showPartInfo(targetBlock, AppState.selectedPart, true);
                                rebuildMeshes();
                                UIController.updateStatusDisplay(currentTool);
                                return;
                            }

                            UIController.showFloatingMenu(e.clientX, e.clientY, targetBlock, faceType, faceDir);

                            if (faceType === 'top') {
                                if (targetBlock.roof) UIController.updateGUI(targetBlock, 'roof');
                                else if (targetBlock.lowerRoof) UIController.updateGUI(targetBlock, 'lowerRoof');
                                else UIController.clearGUI();
                            } else if (faceType === 'side') {
                                // ⚠️ ここへ来るのは【要素の無いところ】を押したときだけ。
                                //   要素の数値は、その要素を選んだときに出す。
                                if (clickedDecoType === 'visor' || clickedDecoType === 'flatVisor') {
                                    UIController.updateGUI(targetBlock, 'side', faceDir);
                                } else if (targetBlock.pilasters && targetBlock.pilasters[faceDir]) { 
                                    UIController.updateGUI(targetBlock, 'pilaster', faceDir);
                                } else {
                                    UIController.updateGUI(targetBlock, 'side', faceDir);
                                }
                            } else {
                                UIController.clearGUI();
                            }
                            // ★ ほかにパネルが出ていなければ、建物のあらましを出す。
                            UIController.showBlockInfo(targetBlock);
                        } else {
                            AppState.selectedId = null; AppState.selectedFaceDir = null; AppState.selectedPart = null; UIController.hideFloatingMenu(); UIController.clearGUI(); 
                        }
                    } else {
                        AppState.selectedId = null; AppState.selectedFaceDir = null; UIController.hideFloatingMenu(); UIController.clearGUI(); 
                    }
                    
                    rebuildMeshes();
                    UIController.updateStatusDisplay(currentTool);
                }
                else {
                    if (!isDrawing && !isExtruding) {
                        this.setTool(null); 
                    }
                }
            }

            if (isDrawing) {
                isDrawing = false;
                controls.enabled = true;
                if (tooltip) tooltip.style.display = 'none'; 
                
                if (currentDrawObj && currentDrawObj.w > 0 && currentDrawObj.d > 0) {
                    const newId = Date.now().toString();
                    AppState.buildingData.push({
                        id: newId,
                        rootBuildingId: newId,
                        x: currentDrawObj.x,
                        y: 0, 
                        z: currentDrawObj.z,
                        w: currentDrawObj.w,
                        d: currentDrawObj.d,
                        h: currentDrawObj.h
                    });
                    saveState(); 
                    // ★追記：「作図が完了したよ」とチュートリアルマネージャーに通知
                    if (window.TutorialManager) {
                        window.TutorialManager.notifyTrigger("draw_complete");
                    }
                }

                // ==========================================
                // ★追加：作図が終わったら、一時的な平面（ゴースト）をシーンから完全に消去する
                if (currentDrawObj) {
                    scene.remove(currentDrawObj.mesh, currentDrawObj.line);
                    if (currentDrawObj.mesh.geometry) currentDrawObj.mesh.geometry.dispose();
                }
                // ==========================================

                currentDrawObj = null;
                rebuildMeshes();
                this.setTool(null); 
            }

            // ★追加：軒先・平場・勾配を離したところで確定する。
            hideTip();
            if (eaveDrag || flatDrag || slopeDrag || geyaEaveDrag || geyaSlopeDrag
                || paraDrag || paraHDrag || paraSlopeDrag) {
                const fb = AppState.buildingData.find(
                    d => d.id === (eaveDrag || flatDrag || slopeDrag
                        || geyaEaveDrag || geyaSlopeDrag
                        || paraDrag || paraHDrag || paraSlopeDrag).id);
                eaveDrag = null; flatDrag = null; slopeDrag = null;
                geyaEaveDrag = null; geyaSlopeDrag = null;
                paraDrag = null; paraHDrag = null; paraSlopeDrag = null;
                controls.enabled = true;
                document.body.style.cursor = 'default';
                saveState();
                if (fb && fb.roof) UIController.updateGUI(fb, 'roof');
                return;
            }

            // ★追加：棟の端を離したところで確定する。
            if (grabbedRidge) {
                hideTip();
                const rb = AppState.buildingData.find(d => d.id === grabbedRidge.id);
                grabbedRidge = null;
                controls.enabled = true;
                document.body.style.cursor = 'default';
                saveState();
                // ⚠️ つまみで変えた値を数値欄にも返すこと。返さないと、形は
                //   切妻になっているのに「切妻の度合い 0」と出て食い違う。
                if (rb && rb.roof) UIController.updateGUI(rb, 'roof');
                return;
            }

            if (isExtruding) {
                isExtruding = false;
                // ★ つまみで始めた押し引きなら、モードを元に戻す。
                if (grabbedPull) { currentTool = toolBeforePull; toolBeforePull = null; }
                grabbedPull = null;
                controls.enabled = true;
                if (tooltip) tooltip.style.display = 'none'; 
                hoverMesh.visible = false;   
                document.body.style.cursor = 'default';

                extrudeTargetId = null;
                connectedBlocks = [];
                saveState(); 
                rebuildMeshes();
                this.setTool(null); 
                // ★追記：「押し出しが完了したよ」とチュートリアルマネージャーに通知
                if (window.TutorialManager) {
                        window.TutorialManager.notifyTrigger("extrude_complete");
                    }

                const currentGUI = window.currentGUI; 
                if (currentGUI && AppState.selectedId) {
                    const b = AppState.buildingData.find(d => d.id === AppState.selectedId);
                    if (currentGUI._title.includes('つけ柱')) {
                        UIController.updateGUI(b, 'pilaster', AppState.selectedFaceDir);
                    } else if (currentGUI._title.includes('バルコニー')) {
                        UIController.updateGUI(b, 'balcony', AppState.selectedFaceDir);
                    }
                }
            }
        });

        // =========================================
        // ★前回のダブルクリック処理を更新（フラグ追加）
        // =========================================
        // ★ ダブルクリック（1階層の移動）とトリプルクリック（建物ごとの移動）は
        //   やめた。
        //   ⚠️ クリックの回数で意味が変わる操作は、押した人に何も返さないので
        //     気づけない。移動は【地面のつまみ】ひとつに寄せてある。

    }   
};