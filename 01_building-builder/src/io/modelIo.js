// ★追加：外で作った 3D モデル（glb / gltf / obj / stl）の取り込み。
//   ★ ここで取り込んだものは【置くだけ】。形は変えられない。変えたければ
//     元のソフトで直して入れ直す。中途半端に触れると、元のデータとの
//     食い違いが分からなくなる。
//   ⚠️ ファイルの中身は、そのまま建物データ（JSON）に持たせる。持たせないと、
//     セーブして開き直したときにモデルだけ消える。
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
// ★追加：圧縮された glb を開くための解凍係。
//   ⚠️ glb は【圧縮されていることのほうが多い】。素の GLTFLoader だけでは
//     「拡張 KHR_draco_mesh_compression に対応していない」で止まる。
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { AppState } from '../appState.js';

// 取り込めるファイル。
export const MODEL_ACCEPT = '.glb,.gltf,.obj,.stl';
// これより大きいファイルは、セーブした JSON も相応に大きくなるので断りを入れる。
const HEAVY_MB = 10;

/* base64 ⇄ ArrayBuffer。長いデータでも一度に渡さない（引数が多すぎると落ちる）。 */
function toBase64(buf) {
    const u8 = new Uint8Array(buf);
    let s = '';
    for (let i = 0; i < u8.length; i += 0x8000) {
        s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    }
    return btoa(s);
}
function fromBase64(b64) {
    const bin = atob(b64);
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return u8.buffer;
}

/* glb / gltf の読み手。圧縮されていても開けるよう、解凍係を付けておく。
   ⚠️ Draco の解凍係は【別ファイル】（public/draco/）。three を更新したときは
     node_modules/three/examples/jsm/libs/draco/gltf/ から入れ直すこと。 */
let dracoLoader = null;
function makeGltfLoader() {
    const loader = new GLTFLoader();
    if (!dracoLoader) {
        dracoLoader = new DRACOLoader();
        dracoLoader.setDecoderPath(`${import.meta.env.BASE_URL}draco/`);
    }
    loader.setDRACOLoader(dracoLoader);
    // gltfpack などで詰めたもの（EXT_meshopt_compression）も開けるようにする。
    loader.setMeshoptDecoder(MeshoptDecoder);
    return loader;
}

/* 読み込んだものを、そのまま入れ物（Group）に入れて返す。
   ⚠️ 中身の向き・位置・大きさには【絶対に触らない】。glb は、いちばん外側の
     節そのものが位置や大きさを持っていることがある（書き出したソフトの都合で
     100分の1にしてある、原点をずらしてある、など）。それを上書きすると、
     その分だけモデルがずれる・大きさが変わる。置き方はこの入れ物のほうで決める。 */
function wrapModel(o) {
    const g = new THREE.Group();
    g.add(o);
    return g;
}

/* ファイルの中身を Object3D にする。読めなければ null。 */
async function parseModel(fmt, buf) {
    if (fmt === 'glb' || fmt === 'gltf') {
        const loader = makeGltfLoader();
        const src = (fmt === 'gltf') ? new TextDecoder().decode(buf) : buf;
        const gltf = await loader.parseAsync(src, '');
        return wrapModel(gltf.scene);
    }
    if (fmt === 'obj') {
        return wrapModel(new OBJLoader().parse(new TextDecoder().decode(buf)));
    }
    if (fmt === 'stl') {
        const geo = new STLLoader().parse(buf);
        geo.computeVertexNormals();
        // ★ STL は色を持たない。ほかの取り込みと見分けがつくよう、少し明るい灰。
        return wrapModel(
            new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ color: 0xc8ccd0 })));
    }
    return null;
}

/* 組み上がったモデルの控え。id → Object3D。
   ⚠️ JSON から開き直したときは、ここが空のまま。そのときは【読めるまで
     箱で代用】し、読めた合図で描き直す。 */
const cache = new Map();
const pending = new Set();

/* この階（モデル）の中身。まだ読めていなければ null を返し、
   読み終わったら onReady() を呼ぶ（呼ばれたら描き直すこと）。 */
export function modelObject(b, onReady) {
    const hit = cache.get(b.id);
    if (hit) return hit;
    if (!b.data || pending.has(b.id)) return null;
    pending.add(b.id);
    parseModel(b.fmt, fromBase64(b.data)).then((o) => {
        pending.delete(b.id);
        if (!o) return;
        fitObject(o, b.fit);
        cache.set(b.id, o);
        if (onReady) onReady();
    }).catch((e) => {
        pending.delete(b.id);
        console.warn('モデルを読めませんでした', e);
    });
    return null;
}

/* 取り込んだときに決めた「置き方」を当てる。
   ⚠️ 取り込み時と同じ数字を使うこと。開き直すたびに測り直すと、
     セーブした位置と少しずつずれる。 */
function fitObject(o, fit) {
    o.scale.setScalar(fit.sc);
    o.position.set(fit.dx, fit.dy, fit.dz);
}

/* まだ読み込みの途中にあるモデルの数。
   ⚠️ 書き出しの前に必ず見ること。読めていないモデルは【代用の箱】で描いて
     いるので、待たずに書き出すと、その箱がそのままファイルに入る。 */
export function modelsPending() { return pending.size; }

/* もう使わないモデルの控えを捨てる（消したとき）。 */
export function dropModel(id) { cache.delete(id); }

/* 全消去のときに、控えもまとめて捨てる。 */
export function dropAllModels() { cache.clear(); }

/* モデルの大きさの読み替え（m と mm を取り違えたとき）。 */
export function rescaleModel(b, k) {
    b.fit = { sc: b.fit.sc * k, dx: b.fit.dx * k, dy: b.fit.dy * k, dz: b.fit.dz * k };
    b.w = Math.max(1, Math.round(b.w * k));
    b.d = Math.max(1, Math.round(b.d * k));
    b.h = Math.max(1, Math.round(b.h * k));
    const o = cache.get(b.id);
    if (o) fitObject(o, b.fit);
}

/* いま置いてあるものの【右隣】。取り込んだモデルが既存の建物に重ならないように。 */
function freeSpotX(w) {
    let x1 = -Infinity;
    for (const b of AppState.buildingData) x1 = Math.max(x1, b.x + b.w / 2);
    if (!Number.isFinite(x1)) return 0;
    return x1 + w / 2 + 1000;
}

/* ボタンから呼ぶ。取り込めたら onDone(block)。 */
export function askModelImport(onDone) {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = MODEL_ACCEPT;
    inp.style.display = 'none';
    document.body.appendChild(inp);
    inp.addEventListener('change', async () => {
        const file = inp.files && inp.files[0];
        inp.remove();
        if (!file) return;
        const fmt = (file.name.split('.').pop() || '').toLowerCase();
        if (!['glb', 'gltf', 'obj', 'stl'].includes(fmt)) {
            alert('取り込めるのは glb / gltf / obj / stl です。');
            return;
        }
        const buf = await file.arrayBuffer();
        let obj = null;
        try {
            obj = await parseModel(fmt, buf);
        } catch (e) {
            console.warn(e);
            alert('ファイルを読めませんでした。\n'
                + '.gltf は別ファイル（.bin や画像）を伴うことがあります。'
                + '1つにまとまった .glb で書き出し直すと確実です。\n'
                + '（Draco・Meshopt で圧縮された glb は開けます。'
                + 'KTX2 で圧縮された画像を持つものは、まだ開けません。）');
            return;
        }
        if (!obj) { alert('ファイルを読めませんでした。'); return; }

        // ★ 大きさの単位をそろえる。01 の中身は【mm】。
        //   ⚠️ glTF は m、CAD 由来の stl/obj は mm のことが多い。取り違えると
        //     1000 倍ずれて、建物が消えたように見える。いちばん長い辺で見分ける。
        obj.updateMatrixWorld(true);
        const box = new THREE.Box3().setFromObject(obj);
        const size = new THREE.Vector3(); box.getSize(size);
        const c = new THREE.Vector3(); box.getCenter(c);
        const maxLen = Math.max(size.x, size.y, size.z);
        if (!(maxLen > 0)) { alert('中身が空のファイルのようです。'); return; }
        const sc = (maxLen < 50) ? 1000 : 1;     // 50 未満なら m とみなす

        // 底面の中心が原点に来るように置く。01 の階と同じ置き方。
        const fit = { sc, dx: -c.x * sc, dy: -box.min.y * sc, dz: -c.z * sc };
        const w = Math.max(1, Math.round(size.x * sc));
        const d = Math.max(1, Math.round(size.z * sc));
        const h = Math.max(1, Math.round(size.y * sc));

        const mb = file.size / 1024 / 1024;
        if (mb > HEAVY_MB && !confirm(
            `このファイルは ${mb.toFixed(1)} MB あります。\n`
            + 'セーブした JSON にもそのまま入るので、ファイルが大きくなります。\n'
            + '取り込みますか？')) return;

        const id = 'm' + Date.now().toString();
        fitObject(obj, fit);
        cache.set(id, obj);
        const block = {
            id, rootBuildingId: id,
            kind: 'model',                 // ★ 置くだけ。面も修景も屋根も持たない
            x: freeSpotX(w), y: 0, z: 0, w, d, h,
            name: file.name, fmt,
            fit,
            data: toBase64(buf),
        };
        AppState.buildingData.push(block);
        AppState.selectedId = id;
        AppState.selectedFaceDir = null;
        AppState.selectedPart = null;
        if (onDone) onDone(block);
    });
    inp.click();
}
