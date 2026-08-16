// modelingEngine.js
import * as THREE from 'three';
import { applyPartTexture } from './materialTextureFactory.js';

// ==========================================
// 装飾専用マテリアル（エンジン内で1回だけ生成して使い回す）
// ==========================================
const balcWallMat = new THREE.MeshBasicMaterial({ 
    color: 0x999999, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1, side: THREE.DoubleSide 
});
const balcGlassMat = new THREE.MeshBasicMaterial({ 
    color: 0x88ccff, transparent: true, opacity: 0.5, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1, side: THREE.DoubleSide 
});
const woodMat = new THREE.MeshBasicMaterial({ 
    color: 0x4a2e1b, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1, side: THREE.DoubleSide 
});
const sashMat = new THREE.MeshBasicMaterial({ 
    color: 0x444444, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1, side: THREE.DoubleSide 
});
const createGlassTexture = () => {
    const canvas = document.createElement('canvas');
    canvas.width = 2;    
    canvas.height = 256;
    const ctx = canvas.getContext('2d');
    const grad = ctx.createLinearGradient(0, 0, 0, 256);
    grad.addColorStop(0, '#8ab8e6');   
    grad.addColorStop(0.5, '#d4e8fc'); 
    grad.addColorStop(1, '#5c8fbf');   
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 2, 256);
    return new THREE.CanvasTexture(canvas);
};
const windowGlassMat = new THREE.MeshBasicMaterial({ 
    name: 'window_glass',
    map: createGlassTexture(), color: 0xffffff, transparent: true, opacity: 0.85, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1, side: THREE.DoubleSide 
});
const doorMat = new THREE.MeshBasicMaterial({ 
    color: 0x4a3b32, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1, side: THREE.DoubleSide 
});
const porchMat = new THREE.MeshBasicMaterial({
    color: 0xbbbbbb, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1, side: THREE.DoubleSide
});

// ==========================================
// ★追加：建物ごと・階（ブロック）ごと・部位ごとに独立して着色できるようにするための
// マテリアルインスタンスキャッシュ機構
// ==========================================
let materialCache = {};

function getCachedMaterial(b, partKey, templateMat) {
    const key = `${b.id}__${partKey}`;
    const cached = materialCache[key];
    if (cached) return cached;

    const mat = templateMat.clone();
    mat.name = key;
    mat.userData.isClonedPartMaterial = true;

    const savedHex = b.materialColors && b.materialColors[partKey];
    if (savedHex) mat.color.set(savedHex);

    // ★追加：マンセル値シミュレーターで選ばれた質感（砂壁調・杉板調など）を簡易的に反映する
    const savedTex = b.materialTextures && b.materialTextures[partKey];
    if (savedTex && savedTex !== 'none') applyPartTexture(mat, savedTex, b);

    materialCache[key] = mat;
    return mat;
}

// ==========================================
// 建具の納まり寸法
//   02_munsell-simulator/public/normal_house.glb を実測して決めた値。
//   （あのモデルの窓は「壁に開けた穴」＋「奥に引っ込んだ引き違い障子2枚」でできている）
//     ・壁の開口 1700×1000 に対して障子2枚の外形 1650×950 ＝ 四周 25mm の見込み
//     ・障子1枚 845×950×見込40mm。2枚は 40mm 重なる（召し合わせ）
//     ・外障子の外面は壁面から 20mm 引っ込み、内障子はさらに 40mm 奥
//       （＝開口の内側は合計 100mm の見込みがある）
//     ・右の障子が外側（日本の引き違いの通常の建て方）
// ==========================================
const WIN_W = 1970;          // 窓の開口幅。従来の障子外形と同じ値にして見た目の大きさを変えない
const WIN_HEAD_Y = 2100;     // 窓上端の高さ（従来どおり）
const DOOR_W = 900, DOOR_H = 2000, PORCH_H = 100;
const FRAME_MITSUKE = 40;    // 窓・玄関の枠の見付幅（開口の縁から内側に見える枠の幅）
const FRAME_PROTRUDE = 20;   // 枠が壁面から外側（手前）へ出る寸法
const SASH_D = 40;           // 障子1枚の見込み
const SASH_INSET = 20;       // 外障子の外面が壁面から引っ込む量
const JAMB_D = SASH_INSET + SASH_D * 2;   // = 100。開口の内側（見込み面）の深さ
const FRAME_W = 30;          // 障子の框（ガラスまわりの見付）。窓枠(FRAME_MITSUKE)とは別物
const GLASS_T = 20;

// 頂点配列に平面クワッドを1枚追加する共通ヘルパー（buildRevealTunnelGeometry / buildFrameGeometry で共用）。
function pushQuad(pos, nrm, uvs, a, bb, c, dd, n) {
    for (const p of [a, bb, c, a, c, dd]) { pos.push(p[0], p[1], p[2]); nrm.push(n[0], n[1], n[2]); }
    for (const t of [[0,0],[1,0],[1,1],[0,0],[1,1],[0,1]]) uvs.push(t[0], t[1]);
}

// 開口の内側（室内側）を塞ぐ筒。壁に穴を開けた以上、その厚みの面が要る。壁色で仕上げる。
//   内寸(iw×ih)のまま z=0（壁面）から z=-depth（室内側）へ伸ばすだけ。法線は内向き
//   （筒の中を見上げる向き）。見え掛かりの枠（サッシ／ドアと同色）は buildFrameGeometry が
//   壁の外側に別体で作るので、ここには含めない。
function buildRevealTunnelGeometry(iw2, ih2, depth) {
    const iw = iw2 / 2, ih = ih2 / 2;
    const pos = [], nrm = [], uvs = [];
    const q = (a, bb, c, dd, n) => pushQuad(pos, nrm, uvs, a, bb, c, dd, n);
    q([-iw, ih, 0], [-iw, ih, -depth], [iw, ih, -depth], [iw, ih, 0], [0, -1, 0]);   // 上（下向き）
    q([-iw, -ih, 0], [iw, -ih, 0], [iw, -ih, -depth], [-iw, -ih, -depth], [0, 1, 0]); // 下（上向き）
    q([-iw, -ih, 0], [-iw, -ih, -depth], [-iw, ih, -depth], [-iw, ih, 0], [1, 0, 0]); // 左（右向き）
    q([iw, -ih, 0], [iw, ih, 0], [iw, ih, -depth], [iw, -ih, -depth], [-1, 0, 0]);    // 右（左向き）
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    return g;
}

// 窓・玄関の枠（見え掛かり）。壁の穴のフチにぴたり合わせた「額縁の箱」で、
// 壁面(z=0)から z=+protrude だけ手前（外側）に飛び出す。サッシ／ドアと同色で塗る。
//   ・外側の側面（外周サイズ一定、z:0→+protrude）… 額縁の外側の返り。法線は外向き。
//   ・正面リング（z=+protrude、外周→内周）… 見え掛かりの面そのもの（幅 mitsuke）。法線は+z。
//   ・内側の側面（内周サイズ一定、z:+protrude→0）… 額縁の内側の返り（ガラス側）。法線は内向き。
//   外周は開口(w×h)と同寸にしてあるので、壁の穴のフチとの間に隙間ができない。
function buildFrameGeometry(w, h, mitsuke, protrude) {
    const hw = w / 2, hh = h / 2;                    // 開口（＝枠の外周）
    const iw = w / 2 - mitsuke, ih = h / 2 - mitsuke; // 枠の内周（＝サッシ／扉本体の外形）
    const pos = [], nrm = [], uvs = [];
    const q = (a, bb, c, dd, n) => pushQuad(pos, nrm, uvs, a, bb, c, dd, n);
    // --- 外側の返り（外周、z:0→+protrude、外向き）---
    //   ⚠️ 頂点順序は buildRevealTunnelGeometry の対応する面から「-depth を +protrude に
    //     置き換えただけ」の形にすること。そうすると外積の符号が自動的に反転し、
    //     内向き（トンネル）から外向き（返り）に正しく変わる。手で符号を作ろうとすると
    //     巻き順を誤りやすい（実測で外側4面すべて法線と巻き順が逆になった）。
    q([-hw, hh, 0], [-hw, hh, protrude], [hw, hh, protrude], [hw, hh, 0], [0, 1, 0]);    // 上
    q([-hw, -hh, 0], [hw, -hh, 0], [hw, -hh, protrude], [-hw, -hh, protrude], [0, -1, 0]); // 下
    q([-hw, -hh, 0], [-hw, -hh, protrude], [-hw, hh, protrude], [-hw, hh, 0], [-1, 0, 0]); // 左
    q([hw, -hh, 0], [hw, hh, 0], [hw, hh, protrude], [hw, -hh, protrude], [1, 0, 0]);     // 右
    // --- 正面リング（z=+protrude、外周→内周）---
    //   ⚠️ 4枚のクワッドをつなげて作らないこと。継ぎ目が EdgesGeometry に稜線として
    //     拾われ、枠の面に余計な線が出る（実測で本来8本のところ18本になった）。
    //     穴あきの Shape 1枚として三角形分割すれば、内部の辺は同一平面どうしで打ち消される。
    {
        const shape = new THREE.Shape();
        shape.moveTo(-hw, -hh); shape.lineTo(hw, -hh); shape.lineTo(hw, hh); shape.lineTo(-hw, hh);
        shape.closePath();
        const hole = new THREE.Path();      // 外形と逆回り
        hole.moveTo(-iw, -ih); hole.lineTo(-iw, ih); hole.lineTo(iw, ih); hole.lineTo(iw, -ih);
        hole.closePath();
        shape.holes.push(hole);
        const ring = new THREE.ShapeGeometry(shape);
        const rp = ring.attributes.position.array;
        const ridx = ring.index ? ring.index.array : null;
        const rn = ridx ? ridx.length : ring.attributes.position.count;
        for (let i = 0; i < rn; i++) {
            const vi = ridx ? ridx[i] : i;
            pos.push(rp[vi * 3], rp[vi * 3 + 1], protrude);
            nrm.push(0, 0, 1);
            uvs.push((rp[vi * 3] + hw) / w, (rp[vi * 3 + 1] + hh) / h);
        }
        ring.dispose();
    }
    // --- 内側の返り（内周、z:+protrude→0、内向き）---
    q([-iw, ih, protrude], [-iw, ih, 0], [iw, ih, 0], [iw, ih, protrude], [0, -1, 0]);    // 上
    q([-iw, -ih, protrude], [iw, -ih, protrude], [iw, -ih, 0], [-iw, -ih, 0], [0, 1, 0]); // 下
    q([-iw, -ih, protrude], [-iw, -ih, 0], [-iw, ih, 0], [-iw, ih, protrude], [1, 0, 0]); // 左
    q([iw, -ih, protrude], [iw, ih, protrude], [iw, ih, 0], [iw, -ih, 0], [-1, 0, 0]);    // 右
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    return g;
}

// 面ごとの開口を、その面のローカル2D座標(u,v)で返す。
//   u = 建具の offsetX が動く向き、v = ワールドY（本体ボックスの中心を原点とする）
//   ★ ここで返す矩形が、そのまま壁に開ける穴になる。buildWindows / buildDoors は
//     同じ計算で建具を置くので、両者がずれないようこの関数に一本化してある。
function getWallOpenings(b, baseY) {
    const res = { px: [], nx: [], pz: [], nz: [] };
    const cy = baseY + b.h / 2;   // 本体ボックスの中心Y（ワールド）
    if (b.windows) {
        for (const dir in b.windows) {
            if (!res[dir]) continue;
            const p = (b.windowParams && b.windowParams[dir]) || { height: 2000, offsetX: 0, offsetY: 0 };
            const h = p.height;
            const topY = baseY + WIN_HEAD_Y + (p.offsetY || 0);
            res[dir].push({ kind: 'window', u: p.offsetX || 0, v: topY - h / 2 - cy, w: WIN_W, h });
        }
    }
    // 玄関は1階（baseY=0）のみ。buildDoors の条件と揃えること。
    if (b.doors && baseY === 0) {
        for (const dir in b.doors) {
            if (!res[dir]) continue;
            const p = (b.doorParams && b.doorParams[dir]) || { offsetX: 0 };
            res[dir].push({ kind: 'door', u: p.offsetX || 0, v: (PORCH_H + DOOR_H / 2) - cy, w: DOOR_W, h: DOOR_H });
        }
    }
    return res;
}

// 開口をくり抜いた本体ボックスのジオメトリ。
//   ⚠️ BoxGeometry の差し替えなので、次の2つを必ず保つこと。
//     ① グループ（マテリアル）の順序 px, nx, top, bottom, pz, nz
//        … main.js が selectedFaceDir → materialIndex の対応でハイライトしている。
//     ② 面の法線
//        … interactionHandler.js の面判定が materialIndex ではなく【法線】を見ている。
function buildBodyGeometryFor(b, baseY) {
    const w = b.w, h = b.h, d = b.d;
    const openings = getWallOpenings(b, baseY);
    // map(u,v) は BoxGeometry と同じ向き・同じ法線になるよう組んである（外側から見て反時計回り）
    const faces = [
        { dir: 'px',     W: d, H: h, n: [1, 0, 0],  map: (u, v) => [w / 2, v, -u] },
        { dir: 'nx',     W: d, H: h, n: [-1, 0, 0], map: (u, v) => [-w / 2, v, u] },
        { dir: 'top',    W: w, H: d, n: [0, 1, 0],  map: (u, v) => [u, h / 2, -v] },
        { dir: 'bottom', W: w, H: d, n: [0, -1, 0], map: (u, v) => [u, -h / 2, v] },
        { dir: 'pz',     W: w, H: h, n: [0, 0, 1],  map: (u, v) => [u, v, d / 2] },
        { dir: 'nz',     W: w, H: h, n: [0, 0, -1], map: (u, v) => [-u, v, -d / 2] },
    ];
    const positions = [], normals = [], uvs = [], groups = [];
    let start = 0;
    for (const f of faces) {
        const hw = f.W / 2, hh = f.H / 2;
        const shape = new THREE.Shape();
        shape.moveTo(-hw, -hh); shape.lineTo(hw, -hh); shape.lineTo(hw, hh); shape.lineTo(-hw, hh);
        shape.closePath();
        for (const o of (openings[f.dir] || [])) {
            // 開口が面からはみ出す指定のときは穴を開けない（三角形分割が壊れるため）
            if (o.u - o.w / 2 <= -hw || o.u + o.w / 2 >= hw) continue;
            if (o.v - o.h / 2 <= -hh || o.v + o.h / 2 >= hh) continue;
            const x0 = o.u - o.w / 2, x1 = o.u + o.w / 2, y0 = o.v - o.h / 2, y1 = o.v + o.h / 2;
            const p = new THREE.Path();            // 外形と逆回り（時計回り）にして穴として扱わせる
            p.moveTo(x0, y0); p.lineTo(x0, y1); p.lineTo(x1, y1); p.lineTo(x1, y0);
            p.closePath();
            shape.holes.push(p);
        }
        const g = new THREE.ShapeGeometry(shape);
        const pa = g.attributes.position.array;
        const idx = g.index ? g.index.array : null;
        const n = idx ? idx.length : g.attributes.position.count;
        for (let i = 0; i < n; i++) {
            const vi = idx ? idx[i] : i;
            const u = pa[vi * 3], v = pa[vi * 3 + 1];
            const P = f.map(u, v);
            positions.push(P[0], P[1], P[2]);
            normals.push(f.n[0], f.n[1], f.n[2]);
            uvs.push((u + hw) / f.W, (v + hh) / f.H);
        }
        g.dispose();
        groups.push({ start, count: n });
        start += n;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    groups.forEach((gr, i) => geo.addGroup(gr.start, gr.count, i));
    return geo;
}

// 面の向き → 回転角と、中心から壁面までの距離。buildWindows / buildDoors で共用。
function faceTransform(b, dir) {
    if (dir === 'pz') return { rotY: 0, offsetZ: b.d / 2 };
    if (dir === 'nz') return { rotY: Math.PI, offsetZ: b.d / 2 };
    if (dir === 'px') return { rotY: Math.PI / 2, offsetZ: b.w / 2 };
    if (dir === 'nx') return { rotY: -Math.PI / 2, offsetZ: b.w / 2 };
    return null;
}

export const ModelingEngine = {
    /**
     * rebuild1回につき1回呼び出し、マテリアルキャッシュを完全にリセットする
     */
    resetMaterialCache() {
        materialCache = {};
    },

    /**
     * ブロック＋部位キーに対応する、着色可能な専用マテリアルインスタンスを取得する
     * （main.js側からwall/roof/sodeWall/tareWall用に呼び出される）
     */
    getMaterial(b, partKey, templateMat) {
        return getCachedMaterial(b, partKey, templateMat);
    },

    /**
     * 本体ボックスのジオメトリ（窓・玄関の開口をくり抜いたもの）。
     * BoxGeometry の差し替えなので、グループ順（px,nx,top,bottom,pz,nz）と法線を保っている。
     */
    buildBodyGeometry(b, baseY) {
        return buildBodyGeometryFor(b, baseY);
    },

    /**
     * 玄関扉・ポーチの生成
     * @param {Object} b - ブロックのデータ
     * @param {Number} baseY - Y座標の基準値
     * @param {Object} materials - 使用するマテリアルのセット
     * @returns {THREE.Group} 生成した玄関グループ
     */
    buildDoors: function(b, baseY, materials) {
        const group = new THREE.Group();
        const { edgeMat } = materials; // ★ doorMat, porchMat の受け取りを削除

        // 1階(baseY=0)かつドアデータが存在する場合のみ生成
        if (b.doors && baseY === 0) {
            for (let dir in b.doors) {
                const doorGroup = new THREE.Group();
                const p = b.doorParams && b.doorParams[dir] ? b.doorParams[dir] : { offsetX: 0 };
                
                // 寸法設定。開口は DOOR_W×DOOR_H で、扉本体は四周 FRAME_MITSUKE ぶん小さい（枠の見え掛かり）。
                const h_door = DOOR_H - FRAME_MITSUKE * 2;
                const w_door = DOOR_W - FRAME_MITSUKE * 2;
                const d_door = SASH_D;
                const doorMatB = getCachedMaterial(b, 'door', doorMat);
                const w_porch = 1500, h_porch = PORCH_H, d_porch = 900;

                // 面の方向に応じた回転とオフセット（壁表面のZ位置）
                const ft = faceTransform(b, dir);
                if (!ft) continue;
                const { rotY, offsetZ } = ft;

                // --- 1. 玄関ポーチ (Porch) ---
                const porchGeo = new THREE.BoxGeometry(w_porch, h_porch, d_porch);
                const porchPos = new THREE.Vector3(0, h_porch / 2, offsetZ + d_porch / 2);
                const porchMesh = new THREE.Mesh(porchGeo, getCachedMaterial(b, 'porch', porchMat));
                porchMesh.position.copy(porchPos);
                const porchLine = new THREE.LineSegments(new THREE.EdgesGeometry(porchGeo), edgeMat);
                porchLine.position.copy(porchPos);
                doorGroup.add(porchMesh, porchLine);

                // --- 2. 見込み面（開口の内側の筒。室内側）---
                //   窓と同じ考え方。壁に開けた穴の厚みを見せる。枠の正面と同じくドアと同色で塗る
                //   （壁色にすると、枠の内側だけ色が違って見えてしまうため）。
                const dTunnelGeo = buildRevealTunnelGeometry(
                    DOOR_W - FRAME_MITSUKE * 2, DOOR_H - FRAME_MITSUKE * 2, JAMB_D);
                const dTunnel = new THREE.Mesh(dTunnelGeo, doorMatB);
                dTunnel.position.set(0, PORCH_H + DOOR_H / 2, offsetZ);
                const dTunnelLine = new THREE.LineSegments(new THREE.EdgesGeometry(dTunnelGeo), edgeMat);
                dTunnelLine.position.copy(dTunnel.position);
                doorGroup.add(dTunnel, dTunnelLine);

                // --- 3. 玄関の枠（見え掛かり。壁面から外側へ FRAME_PROTRUDE 飛び出す。扉と同色）---
                const dFrameGeo = buildFrameGeometry(DOOR_W, DOOR_H, FRAME_MITSUKE, FRAME_PROTRUDE);
                const dFrame = new THREE.Mesh(dFrameGeo, doorMatB);
                dFrame.position.set(0, PORCH_H + DOOR_H / 2, offsetZ);
                const dFrameLine = new THREE.LineSegments(new THREE.EdgesGeometry(dFrameGeo), edgeMat);
                dFrameLine.position.copy(dFrame.position);
                doorGroup.add(dFrame, dFrameLine);

                // --- 4. 玄関扉 (Door) ---
                //   扉は開口の中に落とし込み、外面を壁面から SASH_INSET だけ引っ込ませる。
                const doorGeo = new THREE.BoxGeometry(w_door, h_door, d_door);
                const doorPos = new THREE.Vector3(0, h_porch + DOOR_H / 2, offsetZ - SASH_INSET - d_door / 2);
                const doorMesh = new THREE.Mesh(doorGeo, doorMatB);
                doorMesh.position.copy(doorPos);
                const doorLine = new THREE.LineSegments(new THREE.EdgesGeometry(doorGeo), edgeMat);
                doorLine.position.copy(doorPos);
                doorGroup.add(doorMesh, doorLine);

                // 基準位置の設定と回転・スライド
                doorGroup.position.set(b.x, baseY, b.z);
                doorGroup.rotation.y = rotY;
                doorGroup.translateX(p.offsetX); 

                // タグ付け
                doorGroup.traverse(child => {
                    if (child.isMesh || child.isLineSegments) {
                        child.userData = { isDeco: true, type: 'door', dir: dir, id: b.id };
                    }
                });
                
                group.add(doorGroup);
            }
        }
        return group;
    },
/**
     * 掃き出し窓の生成
     */
    buildWindows: function(b, baseY, materials) {
        const group = new THREE.Group();
        const { edgeMat } = materials; // ★ sashMat, windowGlassMat の受け取りを削除

        if (b.windows) {
            for (let dir in b.windows) {
                const windowGroup = new THREE.Group();
                const p = b.windowParams && b.windowParams[dir] ? b.windowParams[dir] : { height: 2000, offsetX: 0, offsetY: 0 };

                // 開口（＝壁に開いている穴）の寸法。buildBodyGeometryFor と同じ計算にすること。
                const h_open = p.height;
                const w_open = WIN_W;

                const topY = baseY + WIN_HEAD_Y + (p.offsetY || 0);
                windowGroup.position.set(b.x, topY - h_open / 2, b.z);

                const ft = faceTransform(b, dir);
                if (!ft) continue;
                const { rotY, offsetZ } = ft;
                const sashMatB = getCachedMaterial(b, 'windowSash', sashMat);

                // --- 1. 見込み面（開口の内側の筒。室内側）---
                //   壁は板ではなく箱なので、穴を開けたらその内側の面が要る。枠の正面と同じく
                //   サッシと同色で塗る（壁色にすると、枠の内側だけ色が違って見えてしまうため）。
                const tunnelGeo = buildRevealTunnelGeometry(
                    w_open - FRAME_MITSUKE * 2, h_open - FRAME_MITSUKE * 2, JAMB_D);
                const tunnelMesh = new THREE.Mesh(tunnelGeo, sashMatB);
                tunnelMesh.position.set(0, 0, offsetZ);
                const tunnelLine = new THREE.LineSegments(new THREE.EdgesGeometry(tunnelGeo), edgeMat);
                tunnelLine.position.set(0, 0, offsetZ);
                windowGroup.add(tunnelMesh, tunnelLine);

                // --- 2. 窓枠（見え掛かり。壁面から外側へ FRAME_PROTRUDE 飛び出す。サッシと同色）---
                //   ★枠はドーナツ型の角柱なので、正面からは「穴の縁に沿った二重の四角」、
                //     斜めからはそれをつなぐ厚み方向の線が見える。稜線を引いて形を出す。
                const frameGeo = buildFrameGeometry(w_open, h_open, FRAME_MITSUKE, FRAME_PROTRUDE);
                const frameMesh = new THREE.Mesh(frameGeo, sashMatB);
                frameMesh.position.set(0, 0, offsetZ);
                const frameLine = new THREE.LineSegments(new THREE.EdgesGeometry(frameGeo), edgeMat);
                frameLine.position.set(0, 0, offsetZ);
                windowGroup.add(frameMesh, frameLine);

                // --- 3. 引き違い障子 2枚 ---
                //   障子2枚の外形は開口より四周 FRAME_MITSUKE だけ小さい（枠の見え掛かり）。
                //   2枚は框の見付ぶん（FRAME_W）重なる＝召し合わせ。
                const w_asm = w_open - FRAME_MITSUKE * 2;
                const h_sash = h_open - FRAME_MITSUKE * 2;
                const w_sash = (w_asm + FRAME_W) / 2;

                // 障子1枚ぶんのジオメトリ（框＝外形から内側をくり抜いた枠）
                const makeSashGeo = () => {
                    const s = new THREE.Shape();
                    s.moveTo(-w_sash/2, -h_sash/2); s.lineTo(w_sash/2, -h_sash/2);
                    s.lineTo(w_sash/2, h_sash/2);   s.lineTo(-w_sash/2, h_sash/2);
                    s.closePath();
                    const hole = new THREE.Path();
                    hole.moveTo(-w_sash/2 + FRAME_W, -h_sash/2 + FRAME_W);
                    hole.lineTo(-w_sash/2 + FRAME_W, h_sash/2 - FRAME_W);
                    hole.lineTo(w_sash/2 - FRAME_W, h_sash/2 - FRAME_W);
                    hole.lineTo(w_sash/2 - FRAME_W, -h_sash/2 + FRAME_W);
                    hole.closePath();
                    s.holes.push(hole);
                    const g = new THREE.ExtrudeGeometry(s, { depth: SASH_D, bevelEnabled: false });
                    g.translate(0, 0, -SASH_D / 2);   // 原点を見込みの中心へ
                    return g;
                };

                const glassGeo = new THREE.BoxGeometry(w_sash - FRAME_W * 2, h_sash - FRAME_W * 2, GLASS_T);

                // 右が外、左が内（日本の引き違いの通常の建て方。参照モデルもこの順）
                const leaves = [
                    { x: w_asm / 2 - w_sash / 2,  z: offsetZ - SASH_INSET - SASH_D / 2 },        // 外障子（右）
                    { x: -w_asm / 2 + w_sash / 2, z: offsetZ - SASH_INSET - SASH_D * 1.5 },      // 内障子（左）
                ];
                for (const lf of leaves) {
                    const sashGeo = makeSashGeo();
                    const pos = new THREE.Vector3(lf.x, 0, lf.z);
                    const sashMesh = new THREE.Mesh(sashGeo, sashMatB);
                    sashMesh.position.copy(pos);
                    const sashLine = new THREE.LineSegments(new THREE.EdgesGeometry(sashGeo), edgeMat);
                    sashLine.position.copy(pos);
                    windowGroup.add(sashMesh, sashLine);

                    const glass = new THREE.Mesh(glassGeo, windowGlassMat);
                    glass.name = "window_glass";
                    glass.userData.isGlass = true;
                    glass.position.copy(pos);
                    windowGroup.add(glass);
                }

                windowGroup.rotation.y = rotY;
                windowGroup.translateX(p.offsetX); 

                // ▼▼▼ 修正: isGlass などの既存のuserDataを消さないようにマージする ▼▼▼
                windowGroup.traverse(child => {
                    if (child.isMesh || child.isLineSegments) {
                        child.userData = { ...child.userData, isDeco: true, type: 'window', dir: dir, id: b.id };
                    }
                });
                // ▲▲▲ 修正ここまで ▲▲▲

                group.add(windowGroup);
            }
        }
        return group;
    },

    /**
     * バルコニーの生成
     */
    buildBalconies: function(b, baseY, materials) {
        const group = new THREE.Group();
        const { roofMat, edgeMat } = materials; // ★ balcWallMat, balcGlassMat の受け取りを削除

        if (b.balconies) {
            const t_floor = 100; 
            const t_wall = 100;  

            for (let dir in b.balconies) {
                const type = b.balconies[dir];
                const p = b.balcParams && b.balcParams[dir] ? b.balcParams[dir] : { depth: 1000, h_handrail: 1100, h_side: 1100 };
                const d_total = p.depth;
                const d_floor = d_total - t_wall;
                const h_wall = p.h_handrail; 
                const h_side = p.h_side;     

                const balcGroup = new THREE.Group();
                balcGroup.position.set(b.x, baseY + 100, b.z);

                const w2 = b.w / 2;
                const d2 = b.d / 2;
                const parts = [];

                if (dir === 'pz') { 
                    parts.push({ mat: getCachedMaterial(b, 'balconyWall', balcWallMat), geo: new THREE.BoxGeometry(b.w, t_floor, d_total), pos: new THREE.Vector3(0, t_floor/2, d2 + d_total/2) }); 
                    parts.push({ mat: getCachedMaterial(b, 'balconyWall', balcWallMat), geo: new THREE.BoxGeometry(t_wall, h_side, d_total), pos: new THREE.Vector3(-w2 + t_wall/2, t_floor + h_side/2, d2 + d_total/2) }); 
                    parts.push({ mat: getCachedMaterial(b, 'balconyWall', balcWallMat), geo: new THREE.BoxGeometry(t_wall, h_side, d_total), pos: new THREE.Vector3(w2 - t_wall/2, t_floor + h_side/2, d2 + d_total/2) }); 
                } else if (dir === 'nz') { 
                    parts.push({ mat: getCachedMaterial(b, 'balconyWall', balcWallMat), geo: new THREE.BoxGeometry(b.w, t_floor, d_total), pos: new THREE.Vector3(0, t_floor/2, -d2 - d_total/2) }); 
                    parts.push({ mat: getCachedMaterial(b, 'balconyWall', balcWallMat), geo: new THREE.BoxGeometry(t_wall, h_side, d_total), pos: new THREE.Vector3(-w2 + t_wall/2, t_floor + h_side/2, -d2 - d_total/2) }); 
                    parts.push({ mat: getCachedMaterial(b, 'balconyWall', balcWallMat), geo: new THREE.BoxGeometry(t_wall, h_side, d_total), pos: new THREE.Vector3(w2 - t_wall/2, t_floor + h_side/2, -d2 - d_total/2) }); 
                } else if (dir === 'px') { 
                    parts.push({ mat: getCachedMaterial(b, 'balconyWall', balcWallMat), geo: new THREE.BoxGeometry(d_total, t_floor, b.d), pos: new THREE.Vector3(w2 + d_total/2, t_floor/2, 0) }); 
                    parts.push({ mat: getCachedMaterial(b, 'balconyWall', balcWallMat), geo: new THREE.BoxGeometry(d_total, h_side, t_wall), pos: new THREE.Vector3(w2 + d_total/2, t_floor + h_side/2, -d2 + t_wall/2) }); 
                    parts.push({ mat: getCachedMaterial(b, 'balconyWall', balcWallMat), geo: new THREE.BoxGeometry(d_total, h_side, t_wall), pos: new THREE.Vector3(w2 + d_total/2, t_floor + h_side/2, d2 - t_wall/2) }); 
                } else if (dir === 'nx') { 
                    parts.push({ mat: getCachedMaterial(b, 'balconyWall', balcWallMat), geo: new THREE.BoxGeometry(d_total, t_floor, b.d), pos: new THREE.Vector3(-w2 - d_total/2, t_floor/2, 0) }); 
                    parts.push({ mat: getCachedMaterial(b, 'balconyWall', balcWallMat), geo: new THREE.BoxGeometry(d_total, h_side, t_wall), pos: new THREE.Vector3(-w2 - d_total/2, t_floor + h_side/2, -d2 + t_wall/2) }); 
                    parts.push({ mat: getCachedMaterial(b, 'balconyWall', balcWallMat), geo: new THREE.BoxGeometry(d_total, h_side, t_wall), pos: new THREE.Vector3(-w2 - d_total/2, t_floor + h_side/2, d2 - t_wall/2) }); 
                }

                const L = (dir === 'pz' || dir === 'nz') ? b.w - t_wall * 2 : b.d - t_wall * 2;
                const frameW = 50; 

                const frameShape = new THREE.Shape();
                frameShape.moveTo(-L / 2, -20); frameShape.lineTo(L / 2, -20);
                frameShape.lineTo(L / 2, h_wall); frameShape.lineTo(-L / 2, h_wall);
                frameShape.lineTo(-L / 2, -20);

                if (type === 'glass') {
                    const N = Math.max(1, Math.round(L / 700));
                    const S = L / N;
                    for (let i = 0; i < N; i++) {
                        let left = (i === 0) ? (-L / 2 + frameW) : (-L / 2 + i * S + frameW / 2);
                        let right = (i + 1 === N) ? (L / 2 - frameW) : (-L / 2 + (i + 1) * S - frameW / 2);
                        
                        const hole = new THREE.Path();
                        hole.moveTo(left, frameW); hole.lineTo(right, frameW);
                        hole.lineTo(right, h_wall - frameW); hole.lineTo(left, h_wall - frameW);
                        hole.lineTo(left, frameW);
                        frameShape.holes.push(hole);

                        let gW = right - left, gH = h_wall - frameW * 2, gCx = (left + right) / 2;
                        const t_glass = 10;
                        let gPos = new THREE.Vector3(), gGeo = (dir === 'pz' || dir === 'nz') ? new THREE.BoxGeometry(gW, gH, t_glass) : new THREE.BoxGeometry(t_glass, gH, gW);
                        if (dir === 'pz') gPos.set(gCx, t_floor + h_wall / 2, d2 + d_floor + t_wall / 2);
                        else if (dir === 'nz') gPos.set(gCx, t_floor + h_wall / 2, -d2 - d_floor - t_wall / 2);
                        else if (dir === 'px') gPos.set(w2 + d_floor + t_wall / 2, t_floor + h_wall / 2, gCx);
                        else if (dir === 'nx') gPos.set(-w2 - d_floor - t_wall / 2, t_floor + h_wall / 2, gCx);
                        parts.push({ mat: balcGlassMat, geo: gGeo, pos: gPos });
                    }
                } else if (type === 'lattice') {
                    const N_pillars = Math.max(1, Math.round(L / 1100));
                    const S_pillar = L / N_pillars;
                    const botGap = 110;

                    for (let i = 0; i < N_pillars; i++) {
                        let cLeft = -L / 2 + i * S_pillar;
                        let cRight = -L / 2 + (i + 1) * S_pillar;
                        let pLeft = cLeft + (i === 0 ? frameW : frameW / 2);
                        let pRight = cRight - (i + 1 === N_pillars ? frameW : frameW / 2);
                        let innerW = pRight - pLeft;

                        const botHole = new THREE.Path();
                        botHole.moveTo(pLeft, -10); botHole.lineTo(pRight, -10);
                        botHole.lineTo(pRight, botGap); botHole.lineTo(pLeft, botGap);
                        botHole.lineTo(pLeft, -10);
                        frameShape.holes.push(botHole);

                        const max_gap = 110;
                        const picket_w = 50;
                        let n_pickets = Math.max(0, Math.ceil((innerW - max_gap) / (picket_w + max_gap)));
                        const actual_gap = (innerW - n_pickets * picket_w) / (n_pickets + 1);

                        for (let j = 0; j <= n_pickets; j++) {
                            let hLeft = pLeft + j * (actual_gap + picket_w);
                            let hRight = hLeft + actual_gap;
                            if (hRight > hLeft) {
                                const pHole = new THREE.Path();
                                pHole.moveTo(hLeft, botGap + 50); pHole.lineTo(hRight, botGap + 50);
                                pHole.lineTo(hRight, h_wall - 50); pHole.lineTo(hLeft, h_wall - 50);
                                pHole.lineTo(hLeft, botGap + 50);
                                frameShape.holes.push(pHole);
                            }
                        }
                    }
                }

                const frameDepth = 50; 
                const frameGeo = new THREE.ExtrudeGeometry(frameShape, { depth: frameDepth, bevelEnabled: false });
                frameGeo.translate(0, 0, -frameDepth / 2);
                
                let fPos = new THREE.Vector3();
                if (dir === 'pz') fPos.set(0, t_floor, d2 + d_floor + t_wall / 2);
                else if (dir === 'nz') { frameGeo.rotateY(Math.PI); fPos.set(0, t_floor, -d2 - d_floor - t_wall / 2); }
                else if (dir === 'px') { frameGeo.rotateY(Math.PI / 2); fPos.set(w2 + d_floor + t_wall / 2, t_floor, 0); }
                else if (dir === 'nx') { frameGeo.rotateY(-Math.PI / 2); fPos.set(-w2 - d_floor - t_wall / 2, t_floor, 0); }
                parts.push({ mat: roofMat, geo: frameGeo, pos: fPos });

                parts.forEach(part => {
                    const mesh = new THREE.Mesh(part.geo, part.mat);
                    mesh.position.copy(part.pos);
                    const edges = new THREE.EdgesGeometry(part.geo);
                    const line = new THREE.LineSegments(edges, edgeMat);
                    line.position.copy(part.pos);
                    balcGroup.add(mesh, line);
                });
                
                balcGroup.traverse(child => {
                    if (child.isMesh || child.isLineSegments) child.userData = { isDeco: true, type: 'balcony', dir: dir, id: b.id };
                });
                group.add(balcGroup);
            }
        }
        return group;
    },

    /**
     * つけ柱・付け梁の生成
     */
    buildPilasters: function(b, baseY, materials) {
        const group = new THREE.Group();
        const { edgeMat } = materials; // ★ woodMat の受け取りを削除

        if (b.pilasters) {
            for (let dir in b.pilasters) {
                const pillarGroup = new THREE.Group();
                pillarGroup.position.set(b.x, baseY, b.z); 

                const params = b.pilasterParams[dir] || { pitch: 1000 };
                const L = (dir === 'pz' || dir === 'nz') ? b.w : b.d;
                const pillarW = 100; 
                const pillarD = 50;  
                const beamH = 100;   
                const targetPitch = params.pitch;

                if (L < pillarW) continue;

                const currentBeamY = params.beamY !== undefined ? params.beamY : (b.h - beamH);
                
                // ■ 1. 付け梁 (Beam) の生成
                const beamGeo = (dir === 'pz' || dir === 'nz') 
                    ? new THREE.BoxGeometry(L, beamH, pillarD)
                    : new THREE.BoxGeometry(pillarD, beamH, L);
                
                let beamPos = new THREE.Vector3();
                let beamYCenter = currentBeamY + beamH / 2;

                if (dir === 'pz') beamPos.set(0, beamYCenter, b.d / 2 + pillarD / 2);
                else if (dir === 'nz') beamPos.set(0, beamYCenter, -b.d / 2 - pillarD / 2);
                else if (dir === 'px') beamPos.set(b.w / 2 + pillarD / 2, beamYCenter, 0);
                else if (dir === 'nx') beamPos.set(-b.w / 2 - pillarD / 2, beamYCenter, 0);

                const beamMesh = new THREE.Mesh(beamGeo, getCachedMaterial(b, 'pilaster', woodMat));
                beamMesh.position.copy(beamPos);
                const beamLine = new THREE.LineSegments(new THREE.EdgesGeometry(beamGeo), edgeMat);
                beamLine.position.copy(beamPos);
                pillarGroup.add(beamMesh, beamLine);

                // ■ 2. つけ柱 (Pilasters) の生成
                const spanDistance = L - pillarW; 
                const N_spans = Math.max(1, Math.round(spanDistance / targetPitch)); 
                const actualPitch = spanDistance / N_spans;
                const bottomOffset = (baseY === 0) ? 100 : 0;

                for (let i = 0; i <= N_spans; i++) {
                    if (params.visiblePillars && params.visiblePillars[i] === false) continue;
                    let cx = (-L / 2 + pillarW / 2) + i * actualPitch;

                    const segments = [
                        { bot: bottomOffset, top: currentBeamY },       
                        { bot: currentBeamY + beamH, top: b.h }         
                    ];

                    segments.forEach(seg => {
                        const segH = seg.top - seg.bot;
                        if (segH > 1) { 
                            const pGeo = new THREE.BoxGeometry(pillarW, segH, pillarD);
                            let pPos = new THREE.Vector3();
                            let cy = seg.bot + segH / 2;

                            if (dir === 'pz') {
                                pPos.set(cx, cy, b.d / 2 + pillarD / 2);
                            } else if (dir === 'nz') {
                                pPos.set(cx, cy, -b.d / 2 - pillarD / 2);
                            } else if (dir === 'px') {
                                pGeo.rotateY(Math.PI / 2); 
                                pPos.set(b.w / 2 + pillarD / 2, cy, cx);
                            } else if (dir === 'nx') {
                                pGeo.rotateY(Math.PI / 2); 
                                pPos.set(-b.w / 2 - pillarD / 2, cy, cx);
                            }

                            const pMesh = new THREE.Mesh(pGeo, getCachedMaterial(b, 'pilaster', woodMat));
                            pMesh.position.copy(pPos);
                            const pLine = new THREE.LineSegments(new THREE.EdgesGeometry(pGeo), edgeMat);
                            pLine.position.copy(pPos);
                            pillarGroup.add(pMesh, pLine);
                        }
                    });
                }

                pillarGroup.traverse(child => {
                    if (child.isMesh || child.isLineSegments) child.userData = { isDeco: true, type: 'pilaster', dir: dir, id: b.id };
                });
                group.add(pillarGroup);
            }
        }
        return group;
    },

    /**
     * 庇・下屋・水平庇の生成
     */
    buildVisorsAndSkirts: function(b, baseY, materials) {
        const group = new THREE.Group();
        // ★変更：軒裏(wallMat)とは別に、垂直に立ち上がる壁面（妻壁・側面壁の隙間塞ぎ）は
        // 最上階の壁面と同じマテリアル(gableWallMat)を使う
        const { roofMat, wallMat, edgeMat, gableWallMat } = materials;

        if (b.lowerRoof || (b.visors && b.visors.length > 0) || (b.flatVisors && b.flatVisors.length > 0)) {
            const e = 600; 
            const slope = 0.4; 
            const t = 150; 
            
            const skirtGroup = new THREE.Group();
            skirtGroup.position.set(b.x, baseY + b.h, b.z); 

            const w2 = b.w / 2; 
            const d2 = b.d / 2;

            // ==========================================
            // 1. 単独軒庇の生成 (visors)
            // ==========================================
            if (b.visors && b.visors.length > 0) {
                const backDist = 300; 
                
                const has_pz = b.visors.includes('pz'); 
                const has_nz = b.visors.includes('nz'); 
                const has_px = b.visors.includes('px'); 
                const has_nx = b.visors.includes('nx'); 

                const getK = (d) => (b.visorParams && b.visorParams[d]) ? b.visorParams[d].keraba : 300;
                const k_pz = getK('pz'); const k_nz = getK('nz'); 
                const k_px = getK('px'); const k_nx = getK('nx'); 

                const k_pz_L = has_nx ? 0 : k_pz; const k_pz_R = has_px ? 0 : k_pz; 
                const k_nz_L = has_px ? 0 : k_nz; const k_nz_R = has_nx ? 0 : k_nz; 
                const k_px_L = has_pz ? 0 : k_px; const k_px_R = has_nz ? 0 : k_px; 
                const k_nx_L = has_nz ? 0 : k_nx; const k_nx_R = has_pz ? 0 : k_nx; 

                const buildVisorFace = (dir, k_left, k_right, has_left_neighbor, has_right_neighbor) => {
                    const params = (b.visorParams && b.visorParams[dir]) ? b.visorParams[dir] : { eaves: 600, slope: 4 };
                    const e_dir = params.eaves;
                    const slope_dir = params.slope / 10;
                    const dropOuter = e_dir * slope_dir;
                    const dropInner = backDist * slope_dir;

                    const roofVerts = [], roofInds = [];
                    const wallVerts = [], wallInds = [];
                    let rIdx = 0, wIdx = 0;

                    const addRoofQuad = (p0, p1, p2, p3) => {
                        roofVerts.push(...p0, ...p1, ...p2, ...p3);
                        roofInds.push(rIdx, rIdx+1, rIdx+2, rIdx, rIdx+2, rIdx+3);
                        rIdx += 4;
                    };
                    const addWallTri = (p0, p1, p2) => {
                        wallVerts.push(...p0, ...p1, ...p2);
                        wallInds.push(wIdx, wIdx+1, wIdx+2);
                        wIdx += 3;
                    };

                    let pIT_L, pIT_R, pIB_L, pIB_R; 
                    let pOT_L, pOT_R, pOB_L, pOB_R; 
                    let pBT_L, pBT_R, pBB_L, pBB_R; 

                    if (dir === 'pz') {
                        pIT_L = [-w2-k_left, t, d2]; pIT_R = [w2+k_right, t, d2];
                        pIB_L = [-w2-k_left, 0, d2]; pIB_R = [w2+k_right, 0, d2];
                        const outL = has_left_neighbor ? -w2-e_dir : -w2-k_left;
                        const outR = has_right_neighbor ? w2+e_dir : w2+k_right;
                        pOT_L = [outL, -dropOuter+t, d2+e_dir]; pOT_R = [outR, -dropOuter+t, d2+e_dir];
                        pOB_L = [outL, -dropOuter, d2+e_dir];   pOB_R = [outR, -dropOuter, d2+e_dir];
                        const backL = has_left_neighbor ? -w2+backDist : -w2-k_left;
                        const backR = has_right_neighbor ? w2-backDist : w2+k_right;
                        pBT_L = [backL, -dropInner+t, d2-backDist]; pBT_R = [backR, -dropInner+t, d2-backDist];
                        pBB_L = [backL, -dropInner, d2-backDist];   pBB_R = [backR, -dropInner, d2-backDist];
                    } else if (dir === 'nz') {
                        pIT_L = [w2+k_left, t, -d2]; pIT_R = [-w2-k_right, t, -d2];
                        pIB_L = [w2+k_left, 0, -d2]; pIB_R = [-w2-k_right, 0, -d2];
                        const outL = has_left_neighbor ? w2+e_dir : w2+k_left;
                        const outR = has_right_neighbor ? -w2-e_dir : -w2-k_right;
                        pOT_L = [outL, -dropOuter+t, -d2-e_dir]; pOT_R = [outR, -dropOuter+t, -d2-e_dir];
                        pOB_L = [outL, -dropOuter, -d2-e_dir];   pOB_R = [outR, -dropOuter, -d2-e_dir];
                        const backL = has_left_neighbor ? w2-backDist : w2+k_left;
                        const backR = has_right_neighbor ? -w2+backDist : -w2-k_right;
                        pBT_L = [backL, -dropInner+t, -d2+backDist]; pBT_R = [backR, -dropInner+t, -d2+backDist];
                        pBB_L = [backL, -dropInner, -d2+backDist];   pBB_R = [backR, -dropInner, -d2+backDist];
                    } else if (dir === 'px') {
                        pIT_L = [w2, t, d2+k_left]; pIT_R = [w2, t, -d2-k_right];
                        pIB_L = [w2, 0, d2+k_left]; pIB_R = [w2, 0, -d2-k_right];
                        const outL = has_left_neighbor ? d2+e_dir : d2+k_left;
                        const outR = has_right_neighbor ? -d2-e_dir : -d2-k_right;
                        pOT_L = [w2+e_dir, -dropOuter+t, outL]; pOT_R = [w2+e_dir, -dropOuter+t, outR];
                        pOB_L = [w2+e_dir, -dropOuter, outL];   pOB_R = [w2+e_dir, -dropOuter, outR];
                        const backL = has_left_neighbor ? d2-backDist : d2+k_left;
                        const backR = has_right_neighbor ? -d2+backDist : -d2-k_right;
                        pBT_L = [w2-backDist, -dropInner+t, backL]; pBT_R = [w2-backDist, -dropInner+t, backR];
                        pBB_L = [w2-backDist, -dropInner, backL];   pBB_R = [w2-backDist, -dropInner, backR];
                    } else if (dir === 'nx') {
                        pIT_L = [-w2, t, -d2-k_left]; pIT_R = [-w2, t, d2+k_right];
                        pIB_L = [-w2, 0, -d2-k_left]; pIB_R = [-w2, 0, d2+k_right];
                        const outL = has_left_neighbor ? -d2-e_dir : -d2-k_left;
                        const outR = has_right_neighbor ? d2+e_dir : d2+k_right;
                        pOT_L = [-w2-e_dir, -dropOuter+t, outL]; pOT_R = [-w2-e_dir, -dropOuter+t, outR];
                        pOB_L = [-w2-e_dir, -dropOuter, outL];   pOB_R = [-w2-e_dir, -dropOuter, outR];
                        const backL = has_left_neighbor ? -d2+backDist : -d2-k_left;
                        const backR = has_right_neighbor ? d2-backDist : d2+k_right;
                        pBT_L = [-w2+backDist, -dropInner+t, backL]; pBT_R = [-w2+backDist, -dropInner+t, backR];
                        pBB_L = [-w2+backDist, -dropInner, backL];   pBB_R = [-w2+backDist, -dropInner, backR];
                    }

                    addRoofQuad(pIT_L, pIT_R, pOT_R, pOT_L); 
                    addRoofQuad(pIB_R, pIB_L, pOB_L, pOB_R); 
                    addRoofQuad(pOT_R, pOT_L, pOB_L, pOB_R); 

                    if (k_left > 0 || k_right > 0) {
                        addRoofQuad(pBT_L, pBT_R, pIT_R, pIT_L); 
                        addRoofQuad(pIB_R, pIB_L, pBB_L, pBB_R); 
                        addRoofQuad(pBT_R, pBT_L, pBB_L, pBB_R); 
                    } else {
                        addRoofQuad(pIT_L, pIT_R, pIB_R, pIB_L);
                    }

                    if (!has_left_neighbor) {
                        if (k_left > 0) addRoofQuad(pBT_L, pBB_L, pIB_L, pIT_L);
                        addRoofQuad(pIT_L, pIB_L, pOB_L, pOT_L); 
                    }
                    if (!has_right_neighbor) {
                        if (k_right > 0) addRoofQuad(pIT_R, pIB_R, pBB_R, pBT_R);
                        addRoofQuad(pOT_R, pOB_R, pIB_R, pIT_R); 
                    }

                    if (roofVerts.length > 0) {
                        const rGeo = new THREE.BufferGeometry();
                        rGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(roofVerts), 3));
                        rGeo.setIndex(roofInds);
                        rGeo.computeVertexNormals();
                        const rMesh = new THREE.Mesh(rGeo, roofMat);
                        rMesh.userData = { id: b.id, isDeco: true, type: 'visor', dir: dir };
                        skirtGroup.add(rMesh);
                        const rLine = new THREE.LineSegments(new THREE.EdgesGeometry(rGeo), edgeMat);
                        rLine.userData = { id: b.id, isDeco: true, type: 'visor', dir: dir };
                        skirtGroup.add(rLine);
                    }
                    if (wallVerts.length > 0) {
                        const wGeo = new THREE.BufferGeometry();
                        wGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(wallVerts), 3));
                        wGeo.setIndex(wallInds);
                        wGeo.computeVertexNormals();
                        const wMesh = new THREE.Mesh(wGeo, gableWallMat);
                        wMesh.userData = { id: b.id, isDeco: true, type: 'visor', dir: dir };
                        skirtGroup.add(wMesh);
                        const wLine = new THREE.LineSegments(new THREE.EdgesGeometry(wGeo), edgeMat);
                        wLine.userData = { id: b.id, isDeco: true, type: 'visor', dir: dir };
                        skirtGroup.add(wLine);
                    }
                };

                if (has_pz) buildVisorFace('pz', k_pz_L, k_pz_R, has_nx, has_px);
                if (has_nz) buildVisorFace('nz', k_nz_L, k_nz_R, has_px, has_nx);
                if (has_px) buildVisorFace('px', k_px_L, k_px_R, has_pz, has_nz);
                if (has_nx) buildVisorFace('nx', k_nx_L, k_nx_R, has_nz, has_pz);
            }

            // ==========================================
            // 2. 下屋の生成 (lowerRoof)
            // ==========================================
            if (b.lowerRoof) {
                const lr = b.lowerRoof;
                const max_out = Math.max(lr.out_nx, lr.out_px, lr.out_nz, lr.out_pz);
                if (max_out > 0) {
                    const e_lr = lr.eaves !== undefined ? lr.eaves : 600;
                    const slope_lr = lr.slope !== undefined ? lr.slope / 10 : 0.4;
                    const k_lr = lr.keraba !== undefined ? lr.keraba : 300;

                    const H_max = max_out * slope_lr; 
                    const H_out_eaves = e_lr * slope_lr;
                    const backDist = 300;       
                    const dropInner = backDist * slope_lr; 
                    
                    // ★修正：大屋根と同じ2層構造の厚み設定
                    const t_lower = 100; // 下層（白）の厚み
                    const t_upper = 100; // 上層（黒）の厚み
                    const t1 = t_lower;
                    const t2 = t_lower + t_upper;
                    
                    const type = lr.type || '平入り/寄棟';

                    if (type === '妻入り/切妻1' || type === '切妻2') {
                        // ==== 妻入り・切妻の描画ロジック ====
                        let isGableX = false;
                        let isGableZ = false;
                        const isCorner = (lr.out_nx > 0 || lr.out_px > 0) && (lr.out_nz > 0 || lr.out_pz > 0);
                        
                        if (type === '切妻2') {
                            isGableZ = true;
                        } else {
                            if (isCorner) isGableX = true;
                            else if (lr.out_nz > 0 || lr.out_pz > 0) isGableZ = true;
                            else isGableX = true;
                        }

                        const el = lr.eaves_l !== undefined ? lr.eaves_l : e_lr;
                        const er = lr.eaves_r !== undefined ? lr.eaves_r : e_lr;
                        const kl = lr.keraba_l !== undefined ? lr.keraba_l : k_lr;
                        const kr = lr.keraba_r !== undefined ? lr.keraba_r : k_lr;
                        const rOffset = lr.ridgeOffset || 0; 

                        let e_nx_val = 0, e_px_val = 0, e_nz_val = 0, e_pz_val = 0;
                        if (isGableX) { 
                            e_nz_val = el; e_pz_val = er;
                            e_nx_val = kl; e_px_val = kr;
                        } else {        
                            e_nx_val = el; e_px_val = er;
                            e_nz_val = kl; e_pz_val = kr;
                        }

                        const min_lowerX = -w2; const max_lowerX =  w2;
                        const min_lowerZ = -d2; const max_lowerZ =  d2;
                        const min_upperX = -w2 + lr.out_nx; const max_upperX =  w2 - lr.out_px;
                        const min_upperZ = -d2 + lr.out_nz; const max_upperZ =  d2 - lr.out_pz;

                        const minX = min_lowerX - e_nx_val;
                        const maxX = max_lowerX + e_px_val;
                        const minZ = min_lowerZ - e_nz_val;
                        const maxZ = max_lowerZ + e_pz_val;

                        const getRY = (x, z) => {
                            if (isGableX) {
                                const peakHeight = (d2 + Math.abs(rOffset)) * slope_lr;
                                const dist = z - rOffset;
                                if (rOffset >= d2 - 0.01 && dist > 0) return peakHeight + dist * slope_lr;
                                if (rOffset <= -d2 + 0.01 && dist < 0) return peakHeight + Math.abs(dist) * slope_lr;
                                return peakHeight - Math.abs(dist) * slope_lr;
                            }
                            if (isGableZ) {
                                const peakHeight = (w2 + Math.abs(rOffset)) * slope_lr;
                                const dist = x - rOffset;
                                if (rOffset >= w2 - 0.01 && dist > 0) return peakHeight + dist * slope_lr;
                                if (rOffset <= -w2 + 0.01 && dist < 0) return peakHeight + Math.abs(dist) * slope_lr;
                                return peakHeight - Math.abs(dist) * slope_lr;
                            }
                            return 0;
                        };

                        let xArr = [min_upperX, max_upperX, min_lowerX, max_lowerX, minX, maxX];
                        let zArr = [min_upperZ, max_upperZ, min_lowerZ, max_lowerZ, minZ, maxZ];
                        if (isGableX) zArr.push(rOffset); 
                        if (isGableZ) xArr.push(rOffset);

                        xArr = [...new Set(xArr)].sort((a,b)=>a-b);
                        zArr = [...new Set(zArr)].sort((a,b)=>a-b);

                        const hasCell = (cx, cz) => {
                            if (cx > min_upperX + 0.01 && cx < max_upperX - 0.01 && 
                                cz > min_upperZ + 0.01 && cz < max_upperZ - 0.01) return false;
                            
                            const in_px = lr.out_px > 0 && cx >= max_upperX - 0.01 && cx <= maxX + 0.01 && 
                                          cz >= min_lowerZ - e_nz_val - 0.01 && cz <= max_lowerZ + e_pz_val + 0.01;
                            const in_nx = lr.out_nx > 0 && cx <= min_upperX + 0.01 && cx >= minX - 0.01 && 
                                          cz >= min_lowerZ - e_nz_val - 0.01 && cz <= max_lowerZ + e_pz_val + 0.01;
                            const in_pz = lr.out_pz > 0 && cz >= max_upperZ - 0.01 && cz <= maxZ + 0.01 && 
                                          cx >= min_lowerX - e_nx_val - 0.01 && cx <= max_lowerX + e_px_val + 0.01;
                            const in_nz = lr.out_nz > 0 && cz <= min_upperZ + 0.01 && cz >= minZ - 0.01 && 
                                          cx >= min_lowerX - e_nx_val - 0.01 && cx <= max_lowerX + e_px_val + 0.01;

                            return in_px || in_nx || in_pz || in_nz;
                        };

                        // ★修正：下層と上層のメッシュデータを分離
                        const lowerVerts2 = [], lowerInds2 = [];
                        const upperVerts2 = [], upperInds2 = [];
                        const wallVerts2 = [], wallInds2 = [];
                        let lIdx2 = 0, uIdx2 = 0, wIdx2 = 0;

                        const addQuadLower2 = (p0, p1, p2, p3) => {
                            lowerVerts2.push(...p0, ...p1, ...p2, ...p3);
                            lowerInds2.push(lIdx2, lIdx2+1, lIdx2+2, lIdx2, lIdx2+2, lIdx2+3);
                            lIdx2 += 4;
                        };
                        const addQuadUpper2 = (p0, p1, p2, p3) => {
                            upperVerts2.push(...p0, ...p1, ...p2, ...p3);
                            upperInds2.push(uIdx2, uIdx2+1, uIdx2+2, uIdx2, uIdx2+2, uIdx2+3);
                            uIdx2 += 4;
                        };
                        const addTriWall2 = (p0, p1, p2) => {
                            wallVerts2.push(...p0, ...p1, ...p2);
                            wallInds2.push(wIdx2, wIdx2+1, wIdx2+2);
                            wIdx2 += 3;
                        };

                        // 1. 屋根面と小口の2層描画
                        for (let i = 0; i < xArr.length - 1; i++) {
                            for (let j = 0; j < zArr.length - 1; j++) {
                                const x0 = xArr[i], x1 = xArr[i+1];
                                const z0 = zArr[j], z1 = zArr[j+1];
                                const cx = (x0+x1)/2, cz = (z0+z1)/2;
                                if (!hasCell(cx, cz)) continue;

                                const y00 = getRY(x0, z0), y10 = getRY(x1, z0);
                                const y01 = getRY(x0, z1), y11 = getRY(x1, z1);
                                
                                // 上層（黒）の上面と、下層（白）の下面
                                addQuadUpper2([x1, y10+t2, z0], [x0, y00+t2, z0], [x0, y01+t2, z1], [x1, y11+t2, z1]);
                                addQuadLower2([x0, y00, z0], [x1, y10, z0], [x1, y11, z1], [x0, y01, z1]);

                                // 小口（側面）の2層描画
                                const drawSideFace = (px0, pz0, px1, pz1, nCX, nCZ) => {
                                    if (!hasCell(nCX, nCZ)) {
                                        const py0 = getRY(px0, pz0), py1 = getRY(px1, pz1);
                                        addQuadUpper2([px0, py0+t2, pz0], [px1, py1+t2, pz1], [px1, py1+t1, pz1], [px0, py0+t1, pz0]);
                                        addQuadLower2([px0, py0+t1, pz0], [px1, py1+t1, pz1], [px1, py1, pz1], [px0, py0, pz0]);
                                    }
                                };
                                drawSideFace(x1, z0, x0, z0, cx, z0 - 0.1);
                                drawSideFace(x0, z1, x1, z1, cx, z1 + 0.1);
                                drawSideFace(x0, z0, x0, z1, x0 - 0.1, cz);
                                drawSideFace(x1, z1, x1, z0, x1 + 0.1, cz);
                            }
                        }

                        // 2. 妻壁と側面壁（隙間塞ぎ）の描画
                        const drawTriWallSegment = (px0, pz0, px1, pz1) => {
                            const y0 = getRY(px0, pz0);
                            const y1 = getRY(px1, pz1);
                            if (y0 < 0.01 && y1 < 0.01) return;
                            const clampedY0 = Math.max(0, y0);
                            const clampedY1 = Math.max(0, y1);
                            addTriWall2([px0, 0, pz0], [px1, 0, pz1], [px1, clampedY1, pz1]);
                            addTriWall2([px0, 0, pz0], [px1, clampedY1, pz1], [px0, clampedY0, pz0]);
                        };
                        const safeDrawTriWall = (px0, pz0, px1, pz1, inCX, inCZ) => {
                            if (hasCell(inCX, inCZ)) drawTriWallSegment(px0, pz0, px1, pz1);
                        };

                        for (let j = 0; j < zArr.length - 1; j++) {
                            if (zArr[j] >= min_lowerZ - 0.01 && zArr[j+1] <= max_lowerZ + 0.01) {
                                const cz = (zArr[j] + zArr[j+1]) / 2;
                                safeDrawTriWall(min_lowerX, zArr[j], min_lowerX, zArr[j+1], min_lowerX + 0.1, cz);
                                safeDrawTriWall(max_lowerX, zArr[j+1], max_lowerX, zArr[j], max_lowerX - 0.1, cz);
                            }
                        }
                        for (let i = 0; i < xArr.length - 1; i++) {
                            if (xArr[i] >= min_lowerX - 0.01 && xArr[i+1] <= max_lowerX + 0.01) {
                                const cx = (xArr[i] + xArr[i+1]) / 2;
                                safeDrawTriWall(xArr[i+1], min_lowerZ, xArr[i], min_lowerZ, cx, min_lowerZ + 0.1);
                                safeDrawTriWall(xArr[i], max_lowerZ, xArr[i+1], max_lowerZ, cx, max_lowerZ - 0.1);
                            }
                        }

                        // 3. メッシュ登録（下層と上層をそれぞれ別マテリアルで登録）
                        if (lowerVerts2.length > 0) {
                            const lGeo = new THREE.BufferGeometry();
                            lGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(lowerVerts2), 3));
                            lGeo.setIndex(lowerInds2); lGeo.computeVertexNormals();
                            const lMesh = new THREE.Mesh(lGeo, wallMat);
                            lMesh.userData = { id: b.id, isDeco: true, type: 'lowerRoof' }; skirtGroup.add(lMesh);
                            const lLine = new THREE.LineSegments(new THREE.EdgesGeometry(lGeo), edgeMat);
                            lLine.userData = { id: b.id, isDeco: true, type: 'lowerRoof' }; skirtGroup.add(lLine);
                        }
                        if (upperVerts2.length > 0) {
                            const uGeo = new THREE.BufferGeometry();
                            uGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(upperVerts2), 3));
                            uGeo.setIndex(upperInds2); uGeo.computeVertexNormals();
                            const uMesh = new THREE.Mesh(uGeo, roofMat);
                            uMesh.userData = { id: b.id, isDeco: true, type: 'lowerRoof' }; skirtGroup.add(uMesh);
                            const uLine = new THREE.LineSegments(new THREE.EdgesGeometry(uGeo), edgeMat);
                            uLine.userData = { id: b.id, isDeco: true, type: 'lowerRoof' }; skirtGroup.add(uLine);
                        }
                        if (wallVerts2.length > 0) {
                            const wGeo = new THREE.BufferGeometry();
                            wGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(wallVerts2), 3));
                            wGeo.setIndex(wallInds2); wGeo.computeVertexNormals();
                            const wMesh = new THREE.Mesh(wGeo, gableWallMat);
                            wMesh.userData = { id: b.id, isDeco: true, type: 'lowerRoof' }; skirtGroup.add(wMesh);
                            const wLine = new THREE.LineSegments(new THREE.EdgesGeometry(wGeo), edgeMat);
                            wLine.userData = { id: b.id, isDeco: true, type: 'lowerRoof' }; skirtGroup.add(wLine);
                        }

                    } else {
                        // ==== 寄棟の2層分割描画ロジック ====
                        const e_nx = e_lr * (lr.out_nx / max_out);
                        const e_px = e_lr * (lr.out_px / max_out);
                        const e_nz = e_lr * (lr.out_nz / max_out);
                        const e_pz = e_lr * (lr.out_pz / max_out);

                        const x_wall_L = -w2; const x_wall_R = w2;
                        const z_wall_B = -d2; const z_wall_F = d2;
                        const x_in_L = x_wall_L + lr.out_nx; const x_in_R = x_wall_R - lr.out_px;
                        const z_in_B = z_wall_B + lr.out_nz; const z_in_F = z_wall_F - lr.out_pz;
                        const x_out_L = x_wall_L - e_nx; const x_out_R = x_wall_R + e_px;
                        const z_out_B = z_wall_B - e_nz; const z_out_F = z_wall_F + e_pz;

                        // ★修正：下層と上層のメッシュデータを分離
                        const lowerVerts = [], lowerInds = [];
                        const upperVerts = [], upperInds = [];
                        const wallVerts = [], wallInds = [];
                        let lIdx = 0, uIdx = 0, wIdx = 0;

                        const addLowerQuad = (p0, p1, p2, p3) => {
                            lowerVerts.push(...p0, ...p1, ...p2, ...p3);
                            lowerInds.push(lIdx, lIdx+1, lIdx+2, lIdx, lIdx+2, lIdx+3);
                            lIdx += 4;
                        };
                        const addUpperQuad = (p0, p1, p2, p3) => {
                            upperVerts.push(...p0, ...p1, ...p2, ...p3);
                            upperInds.push(uIdx, uIdx+1, uIdx+2, uIdx, uIdx+2, uIdx+3);
                            uIdx += 4;
                        };
                        const addWallTri = (p0, p1, p2) => {
                            wallVerts.push(...p0, ...p1, ...p2);
                            wallInds.push(wIdx, wIdx+1, wIdx+2);
                            wIdx += 3;
                        };

                        // ★修正：元の四角形を「上面(T)か下面(B)か」自動判定して2層に分割する魔法の関数
                        const addRoofQuad = (p0, p1, p2, p3) => {
                            const isTop = (p) => p[3] === 'T';
                            const allTop = isTop(p0) && isTop(p1) && isTop(p2) && isTop(p3);
                            const allBot = !isTop(p0) && !isTop(p1) && !isTop(p2) && !isTop(p3);

                            const makeUpper = p => isTop(p) ? [p[0], p[1]+t2, p[2]] : [p[0], p[1]+t1, p[2]];
                            const makeLower = p => isTop(p) ? [p[0], p[1]+t1, p[2]] : [p[0], p[1], p[2]];

                            // 下面(全てB)以外は上層を描画
                            if (!allBot) addUpperQuad(makeUpper(p0), makeUpper(p1), makeUpper(p2), makeUpper(p3));
                            // 上面(全てT)以外は下層を描画
                            if (!allTop) addLowerQuad(makeLower(p0), makeLower(p1), makeLower(p2), makeLower(p3));
                        };

                        if (lr.out_pz > 0) { 
                            let x_L_in = x_in_L, x_L_out = x_out_L;
                            let x_R_in = x_in_R, x_R_out = x_out_R;
                            if (lr.out_nx === 0) { x_L_in = x_wall_L - k_lr; x_L_out = x_wall_L - k_lr; }
                            if (lr.out_px === 0) { x_R_in = x_wall_R + k_lr; x_R_out = x_wall_R + k_lr; }
                            
                            const pIT_L = [x_L_in, H_max, z_in_F, 'T'], pIT_R = [x_R_in, H_max, z_in_F, 'T'];
                            const pIB_L = [x_L_in, H_max, z_in_F, 'B'],   pIB_R = [x_R_in, H_max, z_in_F, 'B'];
                            const pOT_L = [x_L_out, -H_out_eaves, z_out_F, 'T'], pOT_R = [x_R_out, -H_out_eaves, z_out_F, 'T'];
                            const pOB_L = [x_L_out, -H_out_eaves, z_out_F, 'B'],   pOB_R = [x_R_out, -H_out_eaves, z_out_F, 'B'];

                            addRoofQuad(pIT_L, pIT_R, pOT_R, pOT_L); 
                            addRoofQuad(pIB_R, pIB_L, pOB_L, pOB_R); 
                            addRoofQuad(pOT_R, pOT_L, pOB_L, pOB_R); 

                            if (lr.out_nx === 0) { 
                                if (k_lr > 0) {
                                    const pBT_L = [x_wall_L - k_lr, H_max-dropInner, z_in_F - backDist, 'T'];
                                    const pBT_R = [x_wall_L, H_max-dropInner, z_in_F - backDist, 'T'];
                                    const pBB_L = [x_wall_L - k_lr, H_max-dropInner, z_in_F - backDist, 'B'];
                                    const pBB_R = [x_wall_L, H_max-dropInner, z_in_F - backDist, 'B'];
                                    const piT_R = [x_wall_L, H_max, z_in_F, 'T'];
                                    const piB_R = [x_wall_L, H_max, z_in_F, 'B'];
                                    addRoofQuad(pBT_L, pBT_R, piT_R, pIT_L); 
                                    addRoofQuad(piB_R, pIB_L, pBB_L, pBB_R); 
                                    addRoofQuad(pBT_R, pBT_L, pBB_L, pBB_R); 
                                    addRoofQuad(pBT_L, pBB_L, pIB_L, pIT_L); 
                                }
                                addRoofQuad(pIT_L, pIB_L, pOB_L, pOT_L); 
                                addWallTri([x_wall_L, H_max, z_in_F], [x_wall_L, 0, z_in_F], [x_wall_L, 0, z_wall_F]);
                            }
                            if (lr.out_px === 0) { 
                                if (k_lr > 0) {
                                    const pBT_L = [x_wall_R, H_max-dropInner, z_in_F - backDist, 'T'];
                                    const pBT_R = [x_wall_R + k_lr, H_max-dropInner, z_in_F - backDist, 'T'];
                                    const pBB_L = [x_wall_R, H_max-dropInner, z_in_F - backDist, 'B'];
                                    const pBB_R = [x_wall_R + k_lr, H_max-dropInner, z_in_F - backDist, 'B'];
                                    const piT_L = [x_wall_R, H_max, z_in_F, 'T'];
                                    const piB_L = [x_wall_R, H_max, z_in_F, 'B'];
                                    addRoofQuad(pBT_L, pBT_R, pIT_R, piT_L);
                                    addRoofQuad(pIB_R, piB_L, pBB_L, pBB_R);
                                    addRoofQuad(pBT_R, pBT_L, pBB_L, pBB_R);
                                    addRoofQuad(pIT_R, pIB_R, pBB_R, pBT_R); 
                                }
                                addRoofQuad(pOT_R, pOB_R, pIB_R, pIT_R); 
                                addWallTri([x_wall_R, H_max, z_in_F], [x_wall_R, 0, z_wall_F], [x_wall_R, 0, z_in_F]);
                            }
                        }

                        if (lr.out_nz > 0) {
                            let x_inR = x_in_R, x_outR = x_out_R;
                            let x_inL = x_in_L, x_outL = x_out_L;
                            if (lr.out_px === 0) { x_inR = x_wall_R + k_lr; x_outR = x_wall_R + k_lr; }
                            if (lr.out_nx === 0) { x_inL = x_wall_L - k_lr; x_outL = x_wall_L - k_lr; }

                            const pIT_R = [x_inR, H_max, z_in_B, 'T'], pIT_L = [x_inL, H_max, z_in_B, 'T'];
                            const pIB_R = [x_inR, H_max, z_in_B, 'B'],   pIB_L = [x_inL, H_max, z_in_B, 'B'];
                            const pOT_R = [x_outR, -H_out_eaves, z_out_B, 'T'], pOT_L = [x_outL, -H_out_eaves, z_out_B, 'T'];
                            const pOB_R = [x_outR, -H_out_eaves, z_out_B, 'B'],   pOB_L = [x_outL, -H_out_eaves, z_out_B, 'B'];

                            addRoofQuad(pIT_R, pIT_L, pOT_L, pOT_R);
                            addRoofQuad(pIB_L, pIB_R, pOB_R, pOB_L);
                            addRoofQuad(pOT_L, pOT_R, pOB_R, pOB_L);

                            if (lr.out_px === 0) {
                                if (k_lr > 0) {
                                    const pBT_R = [x_wall_R + k_lr, H_max-dropInner, z_in_B + backDist, 'T'];
                                    const pBT_L = [x_wall_R, H_max-dropInner, z_in_B + backDist, 'T'];
                                    const pBB_R = [x_wall_R + k_lr, H_max-dropInner, z_in_B + backDist, 'B'];
                                    const pBB_L = [x_wall_R, H_max-dropInner, z_in_B + backDist, 'B'];
                                    const piT_L = [x_wall_R, H_max, z_in_B, 'T'];
                                    const piB_L = [x_wall_R, H_max, z_in_B, 'B'];
                                    addRoofQuad(pBT_R, pBT_L, piT_L, pIT_R);
                                    addRoofQuad(piB_L, pIB_R, pBB_R, pBB_L);
                                    addRoofQuad(pBT_L, pBT_R, pBB_R, pBB_L);
                                    addRoofQuad(pBT_R, pBB_R, pIB_R, pIT_R); 
                                }
                                addRoofQuad(pIT_R, pIB_R, pOB_R, pOT_R); 
                                addWallTri([x_wall_R, H_max, z_in_B], [x_wall_R, 0, z_in_B], [x_wall_R, 0, z_wall_B]);
                            }
                            if (lr.out_nx === 0) {
                                if (k_lr > 0) {
                                    const pBT_R = [x_wall_L, H_max-dropInner, z_in_B + backDist, 'T'];
                                    const pBT_L = [x_wall_L - k_lr, H_max-dropInner, z_in_B + backDist, 'T'];
                                    const pBB_R = [x_wall_L, H_max-dropInner, z_in_B + backDist, 'B'];
                                    const pBB_L = [x_wall_L - k_lr, H_max-dropInner, z_in_B + backDist, 'B'];
                                    const piT_R = [x_wall_L, H_max, z_in_B, 'T'];
                                    const piB_R = [x_wall_L, H_max, z_in_B, 'B'];
                                    addRoofQuad(pBT_R, pBT_L, pIT_L, piT_R);
                                    addRoofQuad(pIB_L, piB_R, pBB_R, pBB_L); 
                                    addRoofQuad(pBT_L, pBT_R, pBB_R, pBB_L);
                                    addRoofQuad(pIT_L, pIB_L, pBB_L, pBT_L); 
                                }
                                addRoofQuad(pOT_L, pOB_L, pIB_L, pIT_L); 
                                addWallTri([x_in_L, H_max, z_in_B], [x_wall_L, 0, z_wall_B], [x_in_L, 0, z_in_B]);
                            }
                        }

                        if (lr.out_px > 0) {
                            let z_inB = z_in_B, z_outB = z_out_B; 
                            let z_inF = z_in_F, z_outF = z_out_F; 
                            if (lr.out_nz === 0) { z_inB = z_wall_B - k_lr; z_outB = z_wall_B - k_lr; }
                            if (lr.out_pz === 0) { z_inF = z_wall_F + k_lr; z_outF = z_wall_F + k_lr; }

                            const pIT_B = [x_in_R, H_max, z_inB, 'T'], pIT_F = [x_in_R, H_max, z_inF, 'T'];
                            const pIB_B = [x_in_R, H_max, z_inB, 'B'],   pIB_F = [x_in_R, H_max, z_inF, 'B'];
                            const pOT_B = [x_out_R, -H_out_eaves, z_outB, 'T'], pOT_F = [x_out_R, -H_out_eaves, z_outF, 'T'];
                            const pOB_B = [x_out_R, -H_out_eaves, z_outB, 'B'],   pOB_F = [x_out_R, -H_out_eaves, z_outF, 'B'];

                            addRoofQuad(pIT_B, pIT_F, pOT_F, pOT_B);
                            addRoofQuad(pIB_F, pIB_B, pOB_B, pOB_F);
                            addRoofQuad(pOT_F, pOT_B, pOB_B, pOB_F);

                            if (lr.out_nz === 0) {
                                if (k_lr > 0) {
                                    const pBT_B = [x_in_R - backDist, H_max-dropInner, z_wall_B - k_lr, 'T'];
                                    const pBT_F = [x_in_R - backDist, H_max-dropInner, z_wall_B, 'T'];
                                    const pBB_B = [x_in_R - backDist, H_max-dropInner, z_wall_B - k_lr, 'B'];
                                    const pBB_F = [x_in_R - backDist, H_max-dropInner, z_wall_B, 'B'];
                                    const piT_F = [x_in_R, H_max, z_wall_B, 'T'];
                                    const piB_F = [x_in_R, H_max, z_wall_B, 'B'];
                                    addRoofQuad(pBT_B, pBT_F, piT_F, pIT_B);
                                    addRoofQuad(piB_F, pIB_B, pBB_B, pBB_F);
                                    addRoofQuad(pBT_F, pBT_B, pBB_B, pBB_F);
                                    addRoofQuad(pBT_B, pBB_B, pIB_B, pIT_B); 
                                }
                                addRoofQuad(pIT_B, pIB_B, pOB_B, pOT_B); 
                                addWallTri([x_in_R, H_max, z_wall_B], [x_wall_R, 0, z_wall_B], [x_in_R, 0, z_wall_B]);
                            }
                            if (lr.out_pz === 0) {
                                if (k_lr > 0) {
                                    const pBT_B = [x_in_R - backDist, H_max-dropInner, z_wall_F, 'T'];
                                    const pBT_F = [x_in_R - backDist, H_max-dropInner, z_wall_F + k_lr, 'T'];
                                    const pBB_B = [x_in_R - backDist, H_max-dropInner, z_wall_F, 'B'];
                                    const pBB_F = [x_in_R - backDist, H_max-dropInner, z_wall_F + k_lr, 'B'];
                                    const piT_B = [x_in_R, H_max, z_wall_F, 'T'];
                                    const piB_B = [x_in_R, H_max, z_wall_F, 'B'];
                                    addRoofQuad(pBT_B, pBT_F, pIT_F, piT_B);
                                    addRoofQuad(pIB_F, piB_B, pBB_B, pBB_F);
                                    addRoofQuad(pBT_F, pBT_B, pBB_B, pBB_F);
                                    addRoofQuad(pIT_F, pIB_F, pBB_F, pBT_F); 
                                }
                                addRoofQuad(pOT_F, pOB_F, pIB_F, pIT_F); 
                                addWallTri([x_in_R, H_max, z_wall_F], [x_in_R, 0, z_wall_F], [x_wall_R, 0, z_wall_F]);
                            }
                        }

                        if (lr.out_nx > 0) {
                            let z_inF = z_in_F, z_outF = z_out_F;
                            let z_inB = z_in_B, z_outB = z_out_B;
                            if (lr.out_pz === 0) { z_inF = z_wall_F + k_lr; z_outF = z_wall_F + k_lr; }
                            if (lr.out_nz === 0) { z_inB = z_wall_B - k_lr; z_outB = z_wall_B - k_lr; }

                            const pIT_F = [x_in_L, H_max, z_inF, 'T'], pIT_B = [x_in_L, H_max, z_inB, 'T'];
                            const pIB_F = [x_in_L, H_max, z_inF, 'B'],   pIB_B = [x_in_L, H_max, z_inB, 'B'];
                            const pOT_F = [x_out_L, -H_out_eaves, z_outF, 'T'], pOT_B = [x_out_L, -H_out_eaves, z_outB, 'T'];
                            const pOB_F = [x_out_L, -H_out_eaves, z_outF, 'B'],   pOB_B = [x_out_L, -H_out_eaves, z_outB, 'B'];

                            addRoofQuad(pIT_F, pIT_B, pOT_B, pOT_F);
                            addRoofQuad(pIB_B, pIB_F, pOB_F, pOB_B);
                            addRoofQuad(pOT_B, pOT_F, pOB_F, pOB_B);

                            if (lr.out_pz === 0) {
                                if (k_lr > 0) {
                                    const pBT_F = [x_in_L + backDist, H_max-dropInner, z_wall_F + k_lr, 'T'];
                                    const pBT_B = [x_in_L + backDist, H_max-dropInner, z_wall_F, 'T'];
                                    const pBB_F = [x_in_L + backDist, H_max-dropInner, z_wall_F + k_lr, 'B'];
                                    const pBB_B = [x_in_L + backDist, H_max-dropInner, z_wall_F, 'B'];
                                    const piT_B = [x_in_L, H_max, z_wall_F, 'T'];
                                    const piB_B = [x_in_L, H_max, z_wall_F, 'B'];
                                    addRoofQuad(pBT_F, pBT_B, piT_B, pIT_F);
                                    addRoofQuad(piB_B, pIB_F, pBB_F, pBB_B);
                                    addRoofQuad(pBT_B, pBT_F, pBB_F, pBB_B);
                                    addRoofQuad(pBT_F, pBB_F, pIB_F, pIT_F); 
                                }
                                addRoofQuad(pIT_F, pIB_F, pOB_F, pOT_F); 
                                addWallTri([x_in_L, H_max, z_wall_F], [x_wall_L, 0, z_wall_F], [x_in_L, 0, z_wall_F]);
                            }
                            if (lr.out_nz === 0) {
                                if (k_lr > 0) {
                                    const pBT_F = [x_in_L + backDist, H_max-dropInner, z_wall_B, 'T'];
                                    const pBT_B = [x_in_L + backDist, H_max-dropInner, z_wall_B - k_lr, 'T'];
                                    const pBB_F = [x_in_L + backDist, H_max-dropInner, z_wall_B, 'B'];
                                    const pBB_B = [x_in_L + backDist, Math.max(0, H_max-dropInner), z_wall_B - k_lr, 'B']; 
                                    const piT_F = [x_in_L, H_max, z_wall_B, 'T'];
                                    const piB_F = [x_in_L, H_max, z_wall_B, 'B'];
                                    addRoofQuad(pBT_F, pBT_B, pIT_B, piT_F);
                                    addRoofQuad(pIB_B, piB_F, pBB_F, pBB_B);
                                    addRoofQuad(pBT_B, pBT_F, pBB_F, pBB_B);
                                    addRoofQuad(pIT_B, pIB_B, pBB_B, pBT_B); 
                                }
                                addRoofQuad(pOT_B, pOB_B, pIB_B, pIT_B); 
                                addWallTri([x_in_L, H_max, z_wall_B], [x_in_L, 0, z_wall_B], [x_wall_L, 0, z_wall_B]);
                            }
                        }

                        if (lowerVerts.length > 0) {
                            const lGeo = new THREE.BufferGeometry();
                            lGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(lowerVerts), 3));
                            lGeo.setIndex(lowerInds); lGeo.computeVertexNormals();
                            const lMesh = new THREE.Mesh(lGeo, wallMat);
                            lMesh.userData = { id: b.id, isDeco: true, type: 'lowerRoof' }; skirtGroup.add(lMesh);
                            const lLine = new THREE.LineSegments(new THREE.EdgesGeometry(lGeo), edgeMat);
                            lLine.userData = { id: b.id, isDeco: true, type: 'lowerRoof' }; skirtGroup.add(lLine);
                        }
                        if (upperVerts.length > 0) {
                            const uGeo = new THREE.BufferGeometry();
                            uGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(upperVerts), 3));
                            uGeo.setIndex(upperInds); uGeo.computeVertexNormals();
                            const uMesh = new THREE.Mesh(uGeo, roofMat);
                            uMesh.userData = { id: b.id, isDeco: true, type: 'lowerRoof' }; skirtGroup.add(uMesh);
                            const uLine = new THREE.LineSegments(new THREE.EdgesGeometry(uGeo), edgeMat);
                            uLine.userData = { id: b.id, isDeco: true, type: 'lowerRoof' }; skirtGroup.add(uLine);
                        }
                        if (wallVerts.length > 0) {
                            const wGeo = new THREE.BufferGeometry();
                            wGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(wallVerts), 3));
                            wGeo.setIndex(wallInds); wGeo.computeVertexNormals();
                            const wMesh = new THREE.Mesh(wGeo, gableWallMat);
                            wMesh.userData = { id: b.id, isDeco: true, type: 'lowerRoof' }; skirtGroup.add(wMesh);
                            const wLine = new THREE.LineSegments(new THREE.EdgesGeometry(wGeo), edgeMat);
                            wLine.userData = { id: b.id, isDeco: true, type: 'lowerRoof' }; skirtGroup.add(wLine);
                        }
                    }    
                }
            }
        
            // ==========================================
            // 3. 水平庇の生成 (flatVisors)
            // ==========================================
            if (b.flatVisors && b.flatVisors.length > 0) {
                const t_flat = 100; 
                
                b.flatVisors.forEach(dir => {
                    const params = (b.flatVisorParams && b.flatVisorParams[dir]) ? b.flatVisorParams[dir] : { depth: 300, offsetY: 0, margin: 0 };
                    const e_flat = params.depth;     
                    const o_y = params.offsetY;      
                    const m_flat = params.margin;    
                    
                    const flat_w = Math.max(10, b.w - m_flat * 2);
                    const flat_d = Math.max(10, b.d - m_flat * 2);

                    let fGeo, fPos;
                    if (dir === 'pz') {
                        fGeo = new THREE.BoxGeometry(flat_w, t_flat, e_flat);
                        fPos = new THREE.Vector3(0, -t_flat/2 + o_y, b.d/2 + e_flat/2);
                    } else if (dir === 'nz') {
                        fGeo = new THREE.BoxGeometry(flat_w, t_flat, e_flat);
                        fPos = new THREE.Vector3(0, -t_flat/2 + o_y, -b.d/2 - e_flat/2);
                    } else if (dir === 'px') {
                        fGeo = new THREE.BoxGeometry(e_flat, t_flat, flat_d);
                        fPos = new THREE.Vector3(b.w/2 + e_flat/2, -t_flat/2 + o_y, 0);
                    } else if (dir === 'nx') {
                        fGeo = new THREE.BoxGeometry(e_flat, t_flat, flat_d);
                        fPos = new THREE.Vector3(-b.w/2 - e_flat/2, -t_flat/2 + o_y, 0);
                    }

                    if (fGeo && fPos) {
                        const fMesh = new THREE.Mesh(fGeo, wallMat);
                        fMesh.position.copy(fPos);
                        fMesh.userData = { id: b.id, isDeco: true, type: 'flatVisor', dir: dir }; 
                        
                        const fLine = new THREE.LineSegments(new THREE.EdgesGeometry(fGeo), edgeMat);
                        fLine.position.copy(fPos);
                        fLine.userData = { id: b.id, isDeco: true, type: 'flatVisor', dir: dir }; 
                        
                        skirtGroup.add(fMesh, fLine);
                    }
                });
            }

            group.add(skirtGroup);
        }
        return group;
    },

/**
     * 大屋根の生成
     */
    buildRoofs: function(b, baseY, buildingData, materials) {
        const group = new THREE.Group();
        // ★変更：軒裏(wallMat)とは別に、垂直に立ち上がる壁面（パラペット躯体・妻壁）は
        // 最上階の壁面と同じマテリアル(gableWallMat)を使う
        const { wallMat, roofMat, edgeMat, gableWallMat } = materials;

        if (b.roof) {
            const roofGroup = new THREE.Group();
            roofGroup.position.set(b.x, baseY + b.h, b.z); 
            
            const w = b.w; const d = b.d; 
            const t = 150; 

            const rParams = b.roof.params[b.roof.type];
            const slope = (rParams.slope !== undefined) ? rParams.slope / 10 : 0.4;
            
            let e_px = 0, e_nx = 0, e_pz = 0, e_nz = 0;

            if (b.roof.type === '切妻') {
                // 個別パラメータを取得（古いデータや未定義の場合は従来の値をフォールバック）
                const el = rParams.eaves_l !== undefined ? rParams.eaves_l : (rParams.eaves || 600);
                const er = rParams.eaves_r !== undefined ? rParams.eaves_r : (rParams.eaves || 600);
                const kl = rParams.keraba_l !== undefined ? rParams.keraba_l : (rParams.keraba || 300);
                const kr = rParams.keraba_r !== undefined ? rParams.keraba_r : (rParams.keraba || 300);

                if (rParams.rotate90) {
                    // 90度回転時：軒の出が前後（pz/nz）、ケラバが左右（nx/px）
                    e_px = kr;
                    e_nx = kl;
                    e_pz = el;
                    e_nz = er;
                } else {
                    // 通常時：軒の出が左右（nx/px）、ケラバが前後（pz/nz）
                    e_px = er;
                    e_nx = el;
                    e_pz = kl;
                    e_nz = kr;
                }
            } else if (b.roof.type === '寄棟') {
                e_px = rParams.eaves; e_nx = rParams.eaves;
                e_pz = rParams.eaves; e_nz = rParams.eaves;
            }

            // 隣接ブロックとの干渉回避ロジック
            buildingData.forEach(ob => {
                if (ob.id === b.id) return;
                if ((ob.y || 0) + ob.h > (b.y || 0) + b.h - 50) {
                    if (Math.max((b.z) - b.d/2, (ob.z) - ob.d/2) < Math.min((b.z) + b.d/2, (ob.z) + ob.d/2) - 1) {
                        if (ob.x > b.x) {
                            let gap = (ob.x - ob.w/2) - (b.x + b.w/2);
                            if (gap >= -10 && gap < e_px) e_px = Math.max(0, gap);
                        }
                        if (ob.x < b.x) {
                            let gap = (b.x - b.w/2) - (ob.x + ob.w/2);
                            if (gap >= -10 && gap < e_nx) e_nx = Math.max(0, gap);
                        }
                    }
                    if (Math.max((b.x) - b.w/2, (ob.x) - ob.w/2) < Math.min((b.x) + b.w/2, (ob.x) + ob.w/2) - 1) {
                        if (ob.z > b.z) {
                            let gap = (ob.z - ob.d/2) - (b.z + b.d/2);
                            if (gap >= -10 && gap < e_pz) e_pz = Math.max(0, gap);
                        }
                        if (ob.z < b.z) {
                            let gap = (b.z - b.d/2) - (ob.z + ob.d/2);
                            if (gap >= -10 && gap < e_nz) e_nz = Math.max(0, gap);
                        }
                    }
                }
            });

            if (b.roof.type === '寄棟') {
                let e_all = Math.min(e_px, e_nx, e_pz, e_nz);
                e_px = e_all; e_nx = e_all; e_pz = e_all; e_nz = e_all;
            }

            // --- パラペット修景 / 陸屋根 ---
            if (b.roof.type === 'パラペット修景' || b.roof.type === '陸屋根') {
                const pThick = 150; 
                const pHeight = rParams.pHeight;
                
                const outerShape = new THREE.Shape();
                outerShape.moveTo(-w/2, -d/2);
                outerShape.lineTo(w/2, -d/2);
                outerShape.lineTo(w/2, d/2);
                outerShape.lineTo(-w/2, d/2);
                outerShape.lineTo(-w/2, -d/2);
                
                const innerHole = new THREE.Path();
                innerHole.moveTo(-w/2 + pThick, -d/2 + pThick);
                innerHole.lineTo(-w/2 + pThick, d/2 - pThick);
                innerHole.lineTo(w/2 - pThick, d/2 - pThick);
                innerHole.lineTo(w/2 - pThick, -d/2 + pThick);
                innerHole.lineTo(-w/2 + pThick, -d/2 + pThick);
                
                outerShape.holes.push(innerHole);
                
                const pGeo = new THREE.ExtrudeGeometry(outerShape, { depth: pHeight, bevelEnabled: false });
                pGeo.rotateX(-Math.PI / 2);
                
                const pMesh = new THREE.Mesh(pGeo, gableWallMat);
                const pLine = new THREE.LineSegments(new THREE.EdgesGeometry(pGeo), edgeMat);
                roofGroup.add(pMesh, pLine);

                if (b.roof.type === 'パラペット修景') {
                    const e_out = rParams.out_px; 
                    const e_in_target = rParams.in_px; 
                    const max_in = Math.min(e_in_target, w/2, d/2); 
                    
                    // ★新規追加: 棟の位置の取得とクランプ
                    const ridge_target = rParams.ridge_dist !== undefined ? rParams.ridge_dist : max_in / 2;
                    const max_ridge = Math.min(ridge_target, max_in);
                    
                    const rSlope = rParams.slope / 10; 
                    const rThick = 150; 

                    // 基準となる下面（白層の下端）
                    const y_OB = pHeight - e_out * rSlope;  
                    const y_OM = y_OB + 100; // 白層の上面・黒層の下面
                    const y_OT = y_OM + 150; // 黒層の上面
                    
                    const y_PB = pHeight + max_ridge * rSlope; 
                    const y_PM = y_PB + 100;
                    const y_PT = y_PM + 150;

                    let end_dist = max_in - max_ridge;
                    let y_EB = y_PB - end_dist * rSlope; 
                    
                    // 床面(y=0)を突き抜ける場合のクリップ処理
                    if (y_EB < 0) {
                        y_EB = 0;
                        end_dist = y_PB / rSlope;
                    }
                    const y_EM = y_EB + 100;
                    const y_ET = y_EM + 150;

                    const x_out = w/2 + e_out;
                    const z_out = d/2 + e_out;
                    const x_peak = w/2 - max_ridge;
                    const z_peak = d/2 - max_ridge;
                    const x_end = x_peak - end_dist;
                    const z_end = z_peak - end_dist;
                    const x_wall = w/2;
                    const z_wall = d/2;

                    // 4つの角それぞれに 10の座標を定義
                    const pts = [];
                    const corners = [[1, 1], [-1, 1], [-1, -1], [1, -1]];
                    
                    for (let i = 0; i < 4; i++) {
                        const sx = corners[i][0], sz = corners[i][1];
                        pts.push(
                            [sx*x_out, y_OT, sz*z_out], [sx*x_out, y_OM, sz*z_out], [sx*x_out, y_OB, sz*z_out],
                            [sx*x_peak, y_PT, sz*z_peak], [sx*x_peak, y_PM, sz*z_peak], [sx*x_peak, y_PB, sz*z_peak],
                            [sx*x_end, y_ET, sz*z_end], [sx*x_end, y_EM, sz*z_end], [sx*x_end, y_EB, sz*z_end],
                            [sx*x_wall, y_OB, sz*z_wall] // 水平軒裏用の壁位置の点
                        );
                    }

                    // 屋根色(黒)用メッシュデータ
                    const rVerts = []; const rInds = []; let vIdx = 0;
                    // 壁色(白)用メッシュデータ
                    const wVerts = []; const wInds = []; let wIdx = 0;
                    // ★追加：崖（中庭の切り欠き部分の縦壁）専用メッシュデータ（最上階の壁面色を使う）
                    const cliffVerts = []; const cliffInds = []; let cliffIdx = 0;

                    const addQuad = (p0, p1, p2, p3) => {
                        rVerts.push(...p0, ...p1, ...p2, ...p3);
                        rInds.push(vIdx, vIdx+1, vIdx+2, vIdx, vIdx+2, vIdx+3); vIdx += 4;
                    };
                    const addWallQuad = (p0, p1, p2, p3) => {
                        wVerts.push(...p0, ...p1, ...p2, ...p3);
                        wInds.push(wIdx, wIdx+1, wIdx+2, wIdx, wIdx+2, wIdx+3); wIdx += 4;
                    };
                    const addCliffQuad = (p0, p1, p2, p3) => {
                        cliffVerts.push(...p0, ...p1, ...p2, ...p3);
                        cliffInds.push(cliffIdx, cliffIdx+1, cliffIdx+2, cliffIdx, cliffIdx+2, cliffIdx+3); cliffIdx += 4;
                    };

                    for (let i = 0; i < 4; i++) {
                        const next = (i + 1) % 4;
                        const i0 = i * 10; const n0 = next * 10;
                        
                        const pOT = pts[i0+0], pOM = pts[i0+1], pOB = pts[i0+2];
                        const pPT = pts[i0+3], pPM = pts[i0+4], pPB = pts[i0+5];
                        const pET = pts[i0+6], pEM = pts[i0+7], pEB = pts[i0+8];
                        const pWB = pts[i0+9];
                        
                        const nOT = pts[n0+0], nOM = pts[n0+1], nOB = pts[n0+2];
                        const nPT = pts[n0+3], nPM = pts[n0+4], nPB = pts[n0+5];
                        const nET = pts[n0+6], nEM = pts[n0+7], nEB = pts[n0+8];
                        const nWB = pts[n0+9];
                        
                        // ① 黒色（屋根）レイヤー
                        addQuad(pOT, nOT, nPT, pPT); // 上面
                        addQuad(pOM, pPM, nPM, nOM); // 下面
                        addQuad(pOM, pOT, nOT, nOM); // 外側小口
                        if (end_dist > 0.01) {
                            addQuad(pPT, nPT, nET, pET); // 内側上面
                            addQuad(pPM, pEM, nEM, nPM); // 内側下面
                        }
                        addQuad(pEM, nEM, nET, pET); // 内側小口
                        
                        // ② 白色（壁・下地）レイヤー
                        addWallQuad(pOM, nOM, nPM, pPM); // 上面 (黒の下面と重なる)
                        if (end_dist > 0.01) {
                            addWallQuad(pPM, nPM, nEM, pEM); // 内側上面
                        }
                        
                        // 下面 (フラグによる水平軒裏の分岐)
                        if (rParams.flatEaves) {
                            addWallQuad(pOB, pWB, nWB, nOB); // 外縁から壁まで水平
                            addWallQuad(pWB, pPB, nPB, nWB); // 壁から頂部までの裏面
                        } else {
                            addWallQuad(pOB, pPB, nPB, nOB); // 従来の斜め下面
                        }
                        if (end_dist > 0.01) {
                            addWallQuad(pPB, pEB, nEB, nPB); // 頂部から内端までの下面
                        }
                        
                        addWallQuad(pOB, pOM, nOM, nOB); // 外側小口
                        addWallQuad(pEB, nEB, nEM, pEM); // 内側小口
                        
                        // ③ 崖 (中庭の床まで塞ぐ) → 垂直な壁面なので最上階の壁面と同じ色にする
                        if (y_EB > 0.01) {
                            const pFloor = [pEB[0], 0, pEB[2]];
                            const nFloor = [nEB[0], 0, nEB[2]];
                            addCliffQuad(pFloor, nFloor, nEB, pEB);
                        }
                    }

                    // 屋根色メッシュの生成
                    const rGeo = new THREE.BufferGeometry();
                    rGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(rVerts), 3));
                    rGeo.setIndex(rInds);
                    rGeo.computeVertexNormals();

                    const rMesh = new THREE.Mesh(rGeo, roofMat);
                    const rLine = new THREE.LineSegments(new THREE.EdgesGeometry(rGeo), edgeMat);
                    roofGroup.add(rMesh, rLine);

                    // ★新規追加: 壁色（軒裏・小口）メッシュの生成
                    if (wVerts.length > 0) {
                        const wGeo = new THREE.BufferGeometry();
                        wGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(wVerts), 3));
                        wGeo.setIndex(wInds);
                        wGeo.computeVertexNormals();

                        const wMesh = new THREE.Mesh(wGeo, wallMat);
                        const wLine = new THREE.LineSegments(new THREE.EdgesGeometry(wGeo), edgeMat);
                        roofGroup.add(wMesh, wLine);
                    }

                    // ★追加：崖（中庭の切り欠き部分の縦壁）メッシュの生成（最上階の壁面と同じ色）
                    if (cliffVerts.length > 0) {
                        const cGeo = new THREE.BufferGeometry();
                        cGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(cliffVerts), 3));
                        cGeo.setIndex(cliffInds);
                        cGeo.computeVertexNormals();

                        const cMesh = new THREE.Mesh(cGeo, gableWallMat);
                        const cLine = new THREE.LineSegments(new THREE.EdgesGeometry(cGeo), edgeMat);
                        roofGroup.add(cMesh, cLine);
                    }
                }

            } else if (b.roof.type === '切妻' || b.roof.type === '寄棟') {
                
                let holeActive = false;
                let hx = 0, hz = 0, hw = 0, hd = 0;
                if (rParams.cutout && rParams.cutout.active) {
                    holeActive = true;
                    hx = -w/2 + rParams.cutout.x;
                    hz = -d/2 + rParams.cutout.z;
                    hw = rParams.cutout.w;
                    hd = rParams.cutout.d;
                }

                let getRoofY;
                
                if (b.roof.type === '切妻') {
                    const isRot = rParams.rotate90; 
                    const profW = isRot ? d : w; 
                    
                    // ★修正：%の計算を外し、mmとして直接扱うように変更
                    let rOffset = rParams.ridgeOffset || 0; 
                    let ridgeX = rOffset;
                    let spanL = (profW / 2) + ridgeX;
                    let spanR = (profW / 2) - ridgeX;
                    const ridgeH = Math.max(spanL, spanR) * slope;
                    
                    getRoofY = (x, z) => {
                        let pos = isRot ? z : x;
                        let dist = pos - ridgeX;
                        const maxOff = profW / 2;
                        // 片流れ屋根の判定もmmベース(maxOff)に変更
                        if (rOffset >= maxOff - 0.01 && dist > 0) return ridgeH + dist * slope;
                        if (rOffset <= -maxOff + 0.01 && dist < 0) return ridgeH + Math.abs(dist) * slope;
                        return ridgeH - Math.abs(dist) * slope;
                    };
                } else {
                    const maxH = Math.min(w, d) / 2 * slope;
                    getRoofY = (x, z) => {
                        const distX = w/2 - Math.abs(x);
                        const distZ = d/2 - Math.abs(z);
                        let h = Math.min(distX, distZ) * slope;
                        return Math.min(h, maxH);
                    };
                }

                const minX = -w/2 - e_nx; const maxX = w/2 + e_px;
                const minZ = -d/2 - e_nz; const maxZ = d/2 + e_pz;

                let xArr = []; let zArr = [];
                const addX = (v) => { const rv = Math.round(v * 100) / 100; if (!xArr.some(ex => Math.abs(ex - rv) < 0.1)) xArr.push(rv); };
                const addZ = (v) => { const rv = Math.round(v * 100) / 100; if (!zArr.some(ez => Math.abs(ez - rv) < 0.1)) zArr.push(rv); };

                // 1. 絶対にズラしてはいけない外枠・建物の壁・切り欠きの線を「最優先」で登録
                addX(minX); addX(maxX); addZ(minZ); addZ(maxZ);
                if (holeActive) { addX(hx); addX(hx + hw); addZ(hz); addZ(hz + hd); }
                addX(-w/2); addX(w/2); addZ(-d/2); addZ(d/2);

                // 2. 屋根の棟（折り目）の交点を登録
                if (b.roof.type === '切妻') {
                    // ★修正：こちらも%の計算式を外す
                    const ridgeXCoord = rParams.ridgeOffset || 0;
                    if (rParams.rotate90) addZ(ridgeXCoord); else addX(ridgeXCoord);
                } else {
                    const dw = w/2 - d/2;
                    const baseXs = [...xArr];
                    const baseZs = [...zArr];
                    
                    const maxAbsZ = Math.max(Math.abs(minZ), Math.abs(maxZ)) + 1.0;
                    const maxAbsX = Math.max(Math.abs(minX), Math.abs(maxX)) + 1.0;
                    
                    // ★最重要修正：すべてのX, Z座標に対して「対称な点」と「交差する点」を網羅的に追加する
                    // これにより、スライダーで切り欠きをどう動かしても、すべての棟ラインに頂点が必ず生成され、面が割れなくなります。
                    baseXs.forEach(x => {
                        const absX = Math.abs(x);
                        addX(absX); addX(-absX); // 左右対称を保証
                        const absZ = absX - dw;
                        if (absZ >= -0.1 && absZ <= maxAbsZ) { addZ(absZ); addZ(-absZ); }
                    });
                    
                    baseZs.forEach(z => {
                        const absZ = Math.abs(z);
                        addZ(absZ); addZ(-absZ); // 上下対称を保証
                        const absX = absZ + dw;
                        if (absX >= -0.1 && absX <= maxAbsX) { addX(absX); addX(-absX); }
                    });
                    
                    if (w > d) { addX(dw); addX(-dw); addZ(0); }
                    else { addZ(-dw); addZ(dw); addX(0); }
                }
// ★追加: 水平軒裏のための最小Y（軒先最下端）の計算
                const isFlatEaves = rParams.flatEaves === true;
                let minY_px = 0, minY_nx = 0, minY_pz = 0, minY_nz = 0, minY_all = 0;
                
                if (b.roof.type === '寄棟') {
                    minY_all = getRoofY(w/2 + e_px, 0);
                } else if (b.roof.type === '切妻') {
                    if (!rParams.rotate90) {
                        minY_px = getRoofY(w/2 + e_px, 0);
                        minY_nx = getRoofY(-w/2 - e_nx, 0);
                    } else {
                        minY_pz = getRoofY(0, d/2 + e_pz);
                        minY_nz = getRoofY(0, -d/2 - e_nz);
                    }
                }
                
                const getBottomY = (x, z, cx, cz) => {
                    if (!isFlatEaves) return getRoofY(x, z);
                    if (b.roof.type === '寄棟') {
                        if (Math.abs(cx) > w/2 + 0.01 || Math.abs(cz) > d/2 + 0.01) return minY_all;
                    } else if (b.roof.type === '切妻') {
                        if (!rParams.rotate90) {
                            if (cx > w/2 + 0.01) return minY_px;
                            if (cx < -w/2 - 0.01) return minY_nx;
                        } else {
                            if (cz > d/2 + 0.01) return minY_pz;
                            if (cz < -d/2 - 0.01) return minY_nz;
                        }
                    }
                    return getRoofY(x, z);
                };

                xArr.sort((a,b) => a - b);
                zArr.sort((a,b) => a - b);

                // --- ここから 2層構造の屋根メッシュ生成 ---
                const isInside = (v, minV, maxV) => (v >= minV - 0.05 && v <= maxV + 0.05);

                const t_lower = 150; // 下層（軒裏・破風）の厚み
                const t_upper = 150; // 上層（屋根葺き材）の厚み

                // 下層（白）の描画ルール
                const lowerParams = {
                    verts: [], inds: [], map: new Map(),
                    getTopY: (x, z) => getRoofY(x, z) + t_lower,
                    getBotY: (x, z, cx, cz) => getBottomY(x, z, cx, cz)
                };

                // 上層（黒）の描画ルール
                const upperParams = {
                    verts: [], inds: [], map: new Map(),
                    getTopY: (x, z) => getRoofY(x, z) + t_lower + t_upper,
                    getBotY: (x, z, cx, cz) => getRoofY(x, z) + t_lower 
                };

                const wallVerts = []; const wallInds = []; const wallMap = new Map();

                const getVertIdx = (x, y, z, arr, map) => {
                    const key = `${Math.round(x*100)}_${Math.round(y*100)}_${Math.round(z*100)}`;
                    if (map.has(key)) return map.get(key);
                    const idx = arr.length / 3;
                    arr.push(x, y, z);
                    map.set(key, idx);
                    return idx;
                };

                const addTri = (x0,y0,z0, x1,y1,z1, x2,y2,z2, verts, inds, map) => {
                    inds.push(
                        getVertIdx(x0,y0,z0, verts, map),
                        getVertIdx(x1,y1,z1, verts, map),
                        getVertIdx(x2,y2,z2, verts, map)
                    );
                };

                const addTriWall = (x0,y0,z0, x1,y1,z1, x2,y2,z2) => {
                    addTri(x0,y0,z0, x1,y1,z1, x2,y2,z2, wallVerts, wallInds, wallMap);
                };

                const addQuadLayer = (x0, z0, x1, z1, isTop, params) => {
                    const cx = (x0 + x1) / 2;
                    const cz = (z0 + z1) / 2;
                    
                    const h0 = isTop ? params.getTopY(x0, z0, cx, cz) : params.getBotY(x0, z0, cx, cz);
                    const h1 = isTop ? params.getTopY(x1, z0, cx, cz) : params.getBotY(x1, z0, cx, cz);
                    const h2 = isTop ? params.getTopY(x1, z1, cx, cz) : params.getBotY(x1, z1, cx, cz);
                    const h3 = isTop ? params.getTopY(x0, z1, cx, cz) : params.getBotY(x0, z1, cx, cz);
                    
                    const trueMidH = isTop ? params.getTopY(cx, cz, cx, cz) : params.getBotY(cx, cz, cx, cz);
                        
                    const err02 = Math.abs((h0+h2)/2 - trueMidH);
                    const err13 = Math.abs((h1+h3)/2 - trueMidH);
                    
                    if (isTop) {
                        if (err02 <= err13) { 
                            addTri(x0,h0,z0, x0,h3,z1, x1,h2,z1, params.verts, params.inds, params.map); 
                            addTri(x0,h0,z0, x1,h2,z1, x1,h1,z0, params.verts, params.inds, params.map); 
                        } else { 
                            addTri(x0,h0,z0, x0,h3,z1, x1,h1,z0, params.verts, params.inds, params.map); 
                            addTri(x1,h1,z0, x0,h3,z1, x1,h2,z1, params.verts, params.inds, params.map); 
                        }
                    } else {
                        if (err02 <= err13) { 
                            addTri(x0,h0,z0, x1,h2,z1, x0,h3,z1, params.verts, params.inds, params.map); 
                            addTri(x0,h0,z0, x1,h1,z0, x1,h2,z1, params.verts, params.inds, params.map); 
                        } else { 
                            addTri(x0,h0,z0, x1,h1,z0, x0,h3,z1, params.verts, params.inds, params.map); 
                            addTri(x1,h1,z0, x1,h2,z1, x0,h3,z1, params.verts, params.inds, params.map); 
                        }
                    }
                };

                const drawEdgeLayer = (x0, z0, x1, z1, params) => {
                    const cx = (x0 + x1) / 2;
                    const cz = (z0 + z1) / 2;
                    const t0 = params.getTopY(x0, z0, cx, cz);
                    const t1 = params.getTopY(x1, z1, cx, cz);
                    const b0 = params.getBotY(x0, z0, cx, cz);
                    const b1 = params.getBotY(x1, z1, cx, cz);
                    
                    addTri(x0,b0,z0, x1,b1,z1, x1,t1,z1, params.verts, params.inds, params.map);
                    addTri(x0,b0,z0, x1,t1,z1, x0,t0,z0, params.verts, params.inds, params.map);
                };

                // 各レイヤー（白・黒）を順番に構築する関数
                const processLayers = (params) => {
                    for (let i = 0; i < xArr.length - 1; i++) {
                        for (let j = 0; j < zArr.length - 1; j++) {
                            const x0 = xArr[i], x1 = xArr[i+1];
                            const z0 = zArr[j], z1 = zArr[j+1];
                            if (holeActive) {
                                const cx = (x0 + x1) / 2;
                                const cz = (z0 + z1) / 2;
                                if (cx > hx && cx < hx+hw && cz > hz && cz < hz+hd) continue;
                            }
                            addQuadLayer(x0, z0, x1, z1, true, params); 
                            addQuadLayer(x0, z0, x1, z1, false, params);
                        }
                    }

                    for(let i = xArr.length-1; i > 0; i--) {
                        const cx = (xArr[i] + xArr[i-1]) / 2;
                        if (holeActive && Math.abs(minZ - hz) < 0.1 && cx > hx && cx < hx+hw) continue;
                        drawEdgeLayer(xArr[i], minZ, xArr[i-1], minZ, params); 
                    }
                    for(let j = 0; j < zArr.length-1; j++) {
                        const cz = (zArr[j] + zArr[j+1]) / 2;
                        if (holeActive && Math.abs(minX - hx) < 0.1 && cz > hz && cz < hz+hd) continue;
                        drawEdgeLayer(minX, zArr[j], minX, zArr[j+1], params); 
                    }
                    for(let i = 0; i < xArr.length-1; i++) {
                        const cx = (xArr[i] + xArr[i+1]) / 2;
                        if (holeActive && Math.abs(maxZ - (hz+hd)) < 0.1 && cx > hx && cx < hx+hw) continue;
                        drawEdgeLayer(xArr[i], maxZ, xArr[i+1], maxZ, params); 
                    }
                    for(let j = zArr.length-1; j > 0; j--) {
                        const cz = (zArr[j] + zArr[j-1]) / 2;
                        if (holeActive && Math.abs(maxX - (hx+hw)) < 0.1 && cz > hz && cz < hz+hd) continue;
                        drawEdgeLayer(maxX, zArr[j], maxX, zArr[j-1], params); 
                    }

                    if (holeActive) {
                        if (hz > minZ) { for(let i=0; i<xArr.length-1; i++) if(isInside(xArr[i], hx, hx+hw) && isInside(xArr[i+1], hx, hx+hw)) drawEdgeLayer(xArr[i], hz, xArr[i+1], hz, params); }
                        if (hx+hw < maxX) { for(let j=0; j<zArr.length-1; j++) if(isInside(zArr[j], hz, hz+hd) && isInside(zArr[j+1], hz, hz+hd)) drawEdgeLayer(hx+hw, zArr[j], hx+hw, zArr[j+1], params); }
                        if (hz+hd < maxZ) { for(let i=xArr.length-1; i>0; i--) if(isInside(xArr[i-1], hx, hx+hw) && isInside(xArr[i], hx, hx+hw)) drawEdgeLayer(xArr[i], hz+hd, xArr[i-1], hz+hd, params); }
                        if (hx > minX) { for(let j=zArr.length-1; j>0; j--) if(isInside(zArr[j-1], hz, hz+hd) && isInside(zArr[j], hz, hz+hd)) drawEdgeLayer(hx, zArr[j], hx, zArr[j-1], params); }
                    }

                    if (isFlatEaves) {
                        const fillVerticalGap = (x0, z0, x1, z1, cx1, cz1, cx2, cz2) => {
                            const y1_0 = params.getBotY(x0, z0, cx1, cz1);
                            const y1_1 = params.getBotY(x1, z1, cx1, cz1);
                            const y2_0 = params.getBotY(x0, z0, cx2, cz2);
                            const y2_1 = params.getBotY(x1, z1, cx2, cz2);
                            
                            if (Math.abs(y1_0 - y2_0) > 1.0 || Math.abs(y1_1 - y2_1) > 1.0) {
                                addTri(x0, y1_0, z0, x1, y1_1, z1, x1, y2_1, z1, params.verts, params.inds, params.map);
                                addTri(x0, y1_0, z0, x1, y2_1, z1, x0, y2_0, z0, params.verts, params.inds, params.map);
                            }
                        };
                        for (let i = 1; i < xArr.length - 1; i++) {
                            const x = xArr[i];
                            for (let j = 0; j < zArr.length - 1; j++) {
                                const z0 = zArr[j], z1 = zArr[j+1];
                                const cx_L = x - 0.01, cx_R = x + 0.01, cz = (z0 + z1) / 2;
                                if (holeActive && cz > hz && cz < hz+hd) {
                                    if (cx_L > hx && cx_L < hx+hw) continue;
                                    if (cx_R > hx && cx_R < hx+hw) continue;
                                }
                                fillVerticalGap(x, z0, x, z1, cx_L, cz, cx_R, cz);
                            }
                        }
                        for (let j = 1; j < zArr.length - 1; j++) {
                            const z = zArr[j];
                            for (let i = 0; i < xArr.length - 1; i++) {
                                const x0 = xArr[i], x1 = xArr[i+1];
                                const cx = (x0 + x1) / 2, cz_B = z - 0.01, cz_F = z + 0.01;
                                if (holeActive && cx > hx && cx < hx+hw) {
                                    if (cz_B > hz && cz_B < hz+hd) continue;
                                    if (cz_F > hz && cz_F < hz+hd) continue;
                                }
                                fillVerticalGap(x0, z, x1, z, cx, cz_B, cx, cz_F);
                            }
                        }
                    }
                };

                // ★下層（白）と上層（黒）を順番に生成
                processLayers(lowerParams);
                processLayers(upperParams);

                // --- 1回だけ実行する壁面の描画 ---
                const drawGableSegment = (x0, z0, x1, z1) => {
                    const h0 = getRoofY(x0, z0);
                    const h1 = getRoofY(x1, z1);
                    if (h0 <= 0.01 && h1 <= 0.01) return; 
                    const y0 = Math.max(0, h0);
                    const y1 = Math.max(0, h1);
                    addTriWall(x0, 0, z0,  x1, 0, z1,  x1, y1, z1);
                    addTriWall(x0, 0, z0,  x1, y1, z1,  x0, y0, z0);
                };

                const processHoleWall = (x0, z0, x1, z1) => {
                    const cx = (x0 + x1) / 2;
                    const cz = (z0 + z1) / 2;
                    const b0 = getBottomY(x0, z0, cx, cz);
                    const b1 = getBottomY(x1, z1, cx, cz);
                    const y0 = Math.max(0, b0);
                    const y1 = Math.max(0, b1);
                    addTriWall(x0,0,z0, x1,0,z1, x1,y1,z1);
                    addTriWall(x0,0,z0, x1,y1,z1, x0,y0,z0);
                };

                if (b.roof.type === '切妻') {
                    // ★完全修正: 切妻・片流れの向きに関わらず、四方の壁すべてをスキャンして隙間を塞ぐ
                    
                    // X方向のループ (奥と手前の壁面)
                    for(let i = 0; i < xArr.length - 1; i++) {
                        const x0 = xArr[i], x1 = xArr[i+1];
                        if (x0 < -w/2 || x1 > w/2) continue; 
                        const cx = (x0 + x1) / 2;
                        if (!(holeActive && Math.abs(hz - (-d/2)) < 0.1 && cx > hx && cx < hx+hw)) drawGableSegment(x1, -d/2, x0, -d/2); 
                        if (!(holeActive && Math.abs(hz+hd - d/2) < 0.1 && cx > hx && cx < hx+hw)) drawGableSegment(x0, d/2, x1, d/2); 
                    }
                    
                    // Z方向のループ (左と右の壁面)
                    for(let j = 0; j < zArr.length - 1; j++) {
                        const z0 = zArr[j], z1 = zArr[j+1];
                        if (z0 < -d/2 || z1 > d/2) continue;
                        const cz = (z0 + z1) / 2;
                        if (!(holeActive && Math.abs(hx - (-w/2)) < 0.1 && cz > hz && cz < hz+hd)) drawGableSegment(-w/2, z0, -w/2, z1); 
                        if (!(holeActive && Math.abs(hx+hw - w/2) < 0.1 && cz > hz && cz < hz+hd)) drawGableSegment(w/2, z1, w/2, z0); 
                    }
                }

                if (holeActive) {
                    if (hz > minZ) { for(let i=0; i<xArr.length-1; i++) if(isInside(xArr[i], hx, hx+hw) && isInside(xArr[i+1], hx, hx+hw)) processHoleWall(xArr[i], hz, xArr[i+1], hz); }
                    if (hx+hw < maxX) { for(let j=0; j<zArr.length-1; j++) if(isInside(zArr[j], hz, hz+hd) && isInside(zArr[j+1], hz, hz+hd)) processHoleWall(hx+hw, zArr[j], hx+hw, zArr[j+1]); }
                    if (hz+hd < maxZ) { for(let i=xArr.length-1; i>0; i--) if(isInside(xArr[i-1], hx, hx+hw) && isInside(xArr[i], hx, hx+hw)) processHoleWall(xArr[i], hz+hd, xArr[i-1], hz+hd); }
                    if (hx > minX) { for(let j=zArr.length-1; j>0; j--) if(isInside(zArr[j-1], hz, hz+hd) && isInside(zArr[j], hz, hz+hd)) processHoleWall(hx, zArr[j], hx, zArr[j-1]); }
                }

                // --- 最後にそれぞれのメッシュを生成して結合 ---
                const createMesh = (verts, inds, mat) => {
                    if (verts.length === 0) return;
                    const geo = new THREE.BufferGeometry();
                    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(verts), 3));
                    geo.setIndex(inds);
                    geo.computeVertexNormals();
                    const mesh = new THREE.Mesh(geo, mat);
                    const line = new THREE.LineSegments(new THREE.EdgesGeometry(geo), edgeMat);
                    roofGroup.add(mesh, line);
                };

                // 下層（白）を生成
                createMesh(lowerParams.verts, lowerParams.inds, wallMat);
                // 上層（黒）を生成
                createMesh(upperParams.verts, upperParams.inds, roofMat);
                // 壁・妻壁部分（白）を生成
                createMesh(wallVerts, wallInds, gableWallMat);
            }
            
            // タグ付け (プッシュプルのための isRoof を付与)
            roofGroup.traverse(child => {
                if (child.isMesh) {
                    child.userData = { id: b.id, isRoof: true };
                }
            });
            group.add(roofGroup);
        }      
        return group;
    },
    // modelingEngine.js の一番下（return group; の直前など）に新しいメソッドとして追加
    buildSodeWalls: function(b, baseY, materials) {
        const group = new THREE.Group();
        const { wallMat, edgeMat } = materials;

        if (b.sodeWalls) {
            const t_sode = 100; // 厚み固定100mm

            for (let dir in b.sodeWalls) {
                const mode = b.sodeWalls[dir];
                const p = b.sodeParams[dir];
                if (!p) continue;

                const sodeGroup = new THREE.Group();
                sodeGroup.position.set(b.x, baseY, b.z);

                // 面の向きに応じた回転と壁面中心からのオフセット距離
                let rotY = 0, offsetZ = 0, faceWidth = 0;
                if (dir === 'pz') { rotY = 0;          offsetZ = b.d / 2; faceWidth = b.w; }
                else if (dir === 'nz') { rotY = Math.PI;     offsetZ = b.d / 2; faceWidth = b.w; }
                else if (dir === 'px') { rotY = Math.PI / 2; offsetZ = b.w / 2; faceWidth = b.d; }
                else if (dir === 'nx') { rotY = -Math.PI / 2;offsetZ = b.w / 2; faceWidth = b.d; }

                const addWallSegment = (isLeft) => {
                    const param = isLeft ? p.left : p.right;
                    const h_sode = Math.max(100, b.h - param.topGap);
                    const d_sode = param.depth;

                    const geo = new THREE.BoxGeometry(t_sode, h_sode, d_sode);
                    
                    // 左右に応じたX位置のオフセット（壁の内側に収まるように配置）
                    const directionSign = isLeft ? -1 : 1;
                    const posX = (faceWidth / 2 - t_sode / 2) * directionSign;
                    const posY = h_sode / 2;
                    const posZ = offsetZ + d_sode / 2;

                    const mesh = new THREE.Mesh(geo, wallMat);
                    mesh.position.set(posX, posY, posZ);
                    const line = new THREE.LineSegments(new THREE.EdgesGeometry(geo), edgeMat);
                    line.position.copy(mesh.position);

                    sodeGroup.add(mesh, line);
                };

                // モードに応じて左右を描画
                if (mode === 'both' || mode === 'left')  addWallSegment(true);
                if (mode === 'both' || mode === 'right') addWallSegment(false);

                sodeGroup.rotation.y = rotY;

                sodeGroup.traverse(child => {
                    if (child.isMesh || child.isLineSegments) {
                        child.userData = { isDeco: true, type: 'sodeWall', dir: dir, id: b.id };
                    }
                });

                group.add(sodeGroup);
            }
        }
        return group;
    },
    
    // ★追加：垂れ壁の生成処理
    buildTareWalls: function(b, baseY, materials) {
        const group = new THREE.Group();
        const { wallMat, edgeMat } = materials;

        if (b.tareWalls) {
            const t_tare = 100; // 厚み固定100mm

            for (let dir in b.tareWalls) {
                const p = b.tareParams[dir];
                if (!p) continue;

                const tareGroup = new THREE.Group();
                // 配置の起点は、対象ブロックの底面（baseY）
                tareGroup.position.set(b.x, baseY, b.z);

                // 面の向きに応じた回転と壁面中心からのオフセット距離
                let rotY = 0, offsetZ = 0, faceWidth = 0;
                if (dir === 'pz') { rotY = 0;          offsetZ = b.d / 2; faceWidth = b.w; }
                else if (dir === 'nz') { rotY = Math.PI;     offsetZ = b.d / 2; faceWidth = b.w; }
                else if (dir === 'px') { rotY = Math.PI / 2; offsetZ = b.w / 2; faceWidth = b.d; }
                else if (dir === 'nx') { rotY = -Math.PI / 2;offsetZ = b.w / 2; faceWidth = b.d; }

                const h_tare = p.height; // スライダーで指定された下がり幅
                const geo = new THREE.BoxGeometry(faceWidth, h_tare, t_tare);
                
                // Y位置: 底面（0）から下に向かって伸びるため -h_tare/2
                // Z位置: 壁の表面（offsetZ）から外側へ厚み分飛び出すように配置
                const posX = 0;
                const posY = -h_tare / 2;
                const posZ = offsetZ - t_tare / 2; // ★「+」から「-」に変更

                const mesh = new THREE.Mesh(geo, wallMat);
                mesh.position.set(posX, posY, posZ);
                const line = new THREE.LineSegments(new THREE.EdgesGeometry(geo), edgeMat);
                line.position.copy(mesh.position);

                tareGroup.add(mesh, line);
                tareGroup.rotation.y = rotY;

                tareGroup.traverse(child => {
                    if (child.isMesh || child.isLineSegments) {
                        child.userData = { isDeco: true, type: 'tareWall', dir: dir, id: b.id };
                    }
                });

                group.add(tareGroup);
            }
        }
        return group;
    }
    
};