// ★追加：サブカメラ（決めた画角を1つ、置いて残す）
//
//   ★ 景観検討は「どの角度から見た絵で話すか」で結論が変わる。決めた画角を
//     残せることが本体で、小窓はその確認窓。
//   ★ 置き方は【いまの主画面をそのまま写し取る】ひとつだけ。カメラを空中で
//     つまんで向けるより、見えている絵を採るほうが速いし外さない。
//
//   ⚠️ 小窓は【同じキャンバスの隅にもう一度描く】。キャンバスをもう1枚
//     持つと WebGL の持ち物が二重になる。DOM の枠は「窓の形」を決めるだけで、
//     中身は WebGL がその場所へ直接描く。
//   ⚠️ 四角錐の目印は補助レイヤー（1）に置く。主画面だけがそのレイヤーを見る
//     ので、小窓の中に自分自身が写り込まない。
import * as THREE from 'three';

const HELPER_LAYER = 1;
/* ★ 操作の道具（つまみ・矢印・当たり枠）は、このレイヤーへ移す。
   主画面だけがこのレイヤーを見るので、小窓には道具が写らない。
   ⚠️ レイヤーを移したものは、当たり判定のレイキャスターからも外れる。
     掴めなくならないよう、掴む側は enableAll() しておくこと。 */
export const TOOL_LAYER = HELPER_LAYER;
export function markTool(obj) {
    if (obj) obj.traverse((o) => o.layers.set(HELPER_LAYER));
}
// 小窓の縦横比。3:2 でも 4:3 でもなく、資料に貼りやすい 16:9 にそろえる。
const ASPECT = 16 / 9;
// 四角錐の奥行き[mm]。長すぎると建物に刺さり、短すぎると向きが読めない。
const CONE_D = 1800;
// 人の目の高さ[mm]。
const EYE_H = 1500;
// ★ 画角の選択肢。数字だけでは何が変わるのか分からないので、
//   「どういうときに使うか」を必ず添える。
const LENSES = [
    [24, '広角', '広く写る。敷地の全景や、下がれない場所で。'],
    [35, '標準', '人が見た印象にいちばん近い。ふだんはこれ。'],
    [50, 'やや望遠', '狭く写る。建物の一部を切り取って見せたいとき。'],
];

let scene = null, camera = null, renderer = null, controls = null;
let requestRender = () => {};

// 置いてあるサブカメラ。1台だけ。{ pos:{x,y,z}, target:{x,y,z}, focal:mm }
let cam = null;
let helper = null;          // 四角錐のワイヤー
let subCamera = null;       // 小窓を描くためのカメラ
let panel = null;           // 小窓の枠（DOM）
let viewEl = null;          // 中身の場所を決める入れ物
let labelEl = null;         // 見出しの焦点距離
let collapsed = false;
let footEl = null;          // 足元のボタン欄（畳むときに触る）
let noteEl = null;          // いまの画角の説明
let lensBtns = {};          // 画角のボタン（選んでいるものを目立たせる）
let suppress = false;       // 画像コピー・書き出しのあいだだけ隠す
/* ★ 面の選択色は【材質そのもの】を差し替えて塗っている。物を消せば済む道具と
   違い、レイヤーでは隠せない。小窓を描くあいだだけ材質の色を素の色へ戻す。
   ⚠️ 選択色は建物みんなで使い回している1つの材質。色を戻したら必ず元に戻すこと。 */
let masks = [];             // [{ mat, color }]

/* 35mm 換算の焦点距離 → 画角。
   ⚠️ 横 36mm の枠で見たときの【横の画角】に合わせる。人が「35mm は
     このくらいの広さ」と思っている感覚は横で覚えているため。 */
function fovOf(focal, aspect) {
    const hfov = 2 * Math.atan(18 / focal);
    return THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(hfov / 2) / aspect));
}

const v = (o) => new THREE.Vector3(o.x, o.y, o.z);
const o = (p) => ({ x: p.x, y: p.y, z: p.z });

export const SubCam = {
    init(ctx) {
        scene = ctx.scene;
        camera = ctx.camera;
        renderer = ctx.renderer;
        controls = ctx.controls;
        requestRender = ctx.render || (() => {});
        // 主画面だけが補助レイヤーを見る。
        camera.layers.enable(HELPER_LAYER);
        subCamera = new THREE.PerspectiveCamera(45, ASPECT, 1, 1000000);
        buildPanel();
    },

    has() { return !!cam; },

    /* 小窓では素の色に見せたい材質を登録する（組み立てのたびに入れ直す）。 */
    clearMasks() { masks = []; },
    addMask(mat, colorHex) {
        if (mat && !masks.some((m) => m.mat === mat)) masks.push({ mat, color: colorHex });
    },

    /* いまの主画面を写し取る。置いていなければ新しく置く。 */
    capture() {
        const focal = cam ? cam.focal : 35;
        const t = controls ? controls.target : new THREE.Vector3();
        cam = { pos: o(camera.position), target: o(t), focal };
        applyToHelper();
        showPanel(true);
        requestRender();
    },

    /* 主画面を、サブカメラと同じ【位置・向き】へ移す。
       ★ 画角（写る広さ）は主画面のものを変えない。
         ⚠️ 変えると、小窓を押しただけで主画面の見え方が広がったり狭まったりして、
           何が起きたのか分からなくなる。触っているのはサブカメラのはずなのに
           主画面の性格が変わってしまう。位置と向きだけ合わせて、あとは
           いつもの見え方で微調整してもらう。 */
    toMain() {
        if (!cam || !controls) return;
        camera.position.copy(v(cam.pos));
        controls.target.copy(v(cam.target));
        controls.update();
        requestRender();
    },

    /* 人の目の高さ（1.5m）に降ろして水平を向く。 */
    eyeLevel() {
        if (!cam) return;
        const p = v(cam.pos), t = v(cam.target);
        p.y = EYE_H;
        t.y = EYE_H;
        // 水平に向けたとき、注視点が近すぎると首を振っただけになる。
        if (p.distanceTo(t) < 1000) {
            const d = new THREE.Vector3(t.x - p.x, 0, t.z - p.z);
            if (d.lengthSq() < 1) d.set(0, 0, -1);
            t.copy(p).add(d.normalize().multiplyScalar(10000));
        }
        cam.pos = o(p); cam.target = o(t);
        applyToHelper();
        requestRender();
    },

    setFocal(mm) {
        if (!cam) return;
        cam.focal = mm;
        applyToHelper();
        updateLabel();
        requestRender();
    },

    remove() {
        cam = null;
        clearHelper();
        showPanel(false);
        requestRender();
    },

    /* セーブ・ロード */
    serialize() { return cam ? { ...cam } : null; },
    restore(data) {
        cam = (data && data.pos && data.target)
            ? { pos: { ...data.pos }, target: { ...data.target }, focal: data.focal || 35 }
            : null;
        applyToHelper();
        showPanel(!!cam);
        requestRender();
    },

    /* ★ 画像コピー・GLB 書き出しのあいだだけ、小窓と四角錐を消す。
       ⚠️ 補助の道具が資料に写り込むと、それが建物の一部に見える。 */
    beginPlainRender() {
        suppress = true;
        if (helper) helper.visible = false;
        if (panel) panel.style.visibility = 'hidden';
    },
    endPlainRender() {
        suppress = false;
        if (helper) helper.visible = true;
        if (panel) panel.style.visibility = '';
    },

    /* 主画面を描いたあとに呼ぶ。小窓の中身を、同じキャンバスの隅へ描く。 */
    renderInto(rr, sc) {
        if (!cam || suppress || collapsed || !viewEl) return;
        const r = viewEl.getBoundingClientRect();
        if (r.width < 8 || r.height < 8) return;
        subCamera.position.copy(v(cam.pos));
        subCamera.up.set(0, 1, 0);
        subCamera.lookAt(v(cam.target));
        subCamera.aspect = r.width / r.height;
        subCamera.fov = fovOf(cam.focal, subCamera.aspect);
        subCamera.updateProjectionMatrix();

        // ⚠️ WebGL の座標は【左下が原点】。DOM は左上が原点なので上下を入れ替える。
        const x = r.left;
        const y = window.innerHeight - r.bottom;
        rr.setViewport(x, y, r.width, r.height);
        rr.setScissor(x, y, r.width, r.height);
        rr.setScissorTest(true);
        rr.setClearColor(0xeef1f4);
        rr.clear();
        // 選択色を素の色へ戻してから描く。
        const back = masks.map((m) => ({ m, hex: m.mat.color.getHex() }));
        for (const { m } of back) m.mat.color.setHex(m.color);
        rr.render(sc, subCamera);
        for (const { m, hex } of back) m.mat.color.setHex(hex);
        rr.setScissorTest(false);
        rr.setViewport(0, 0, window.innerWidth, window.innerHeight);
    },
};

/* ---------- 四角錐の目印 ---------- */

function clearHelper() {
    if (!helper) return;
    scene.remove(helper);
    helper.traverse((m) => { if (m.geometry) m.geometry.dispose(); });
    helper = null;
}

function applyToHelper() {
    clearHelper();
    if (!cam) return;
    const g = new THREE.Group();
    const vfov = THREE.MathUtils.degToRad(fovOf(cam.focal, ASPECT));
    const hh = Math.tan(vfov / 2) * CONE_D;
    const hw = hh * ASPECT;
    const pts = [
        [0, 0, 0], [hw, hh, -CONE_D], [-hw, hh, -CONE_D],
        [-hw, -hh, -CONE_D], [hw, -hh, -CONE_D],
    ].map((p) => new THREE.Vector3(...p));
    const seg = [];
    for (let i = 1; i <= 4; i++) { seg.push(pts[0], pts[i]); }          // 稜線
    seg.push(pts[1], pts[2], pts[2], pts[3], pts[3], pts[4], pts[4], pts[1]); // 枠
    // 上を示す三角。どちらが天か分かると、置き直しの判断が早い。
    const up = new THREE.Vector3(0, hh * 1.5, -CONE_D);
    seg.push(pts[2], up, up, pts[1]);
    const geo = new THREE.BufferGeometry().setFromPoints(seg);
    const line = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({
        color: 0x0f7fd4, depthTest: false, transparent: true, opacity: 0.9,
    }));
    line.renderOrder = 1200;
    g.add(line);
    g.traverse((m) => m.layers.set(HELPER_LAYER));
    g.position.copy(v(cam.pos));
    g.lookAt(v(cam.target));
    scene.add(g);
    helper = g;
    updateLabel();
}

/* ---------- 小窓（DOM） ---------- */

function buildPanel() {
    panel = document.createElement('div');
    panel.id = 'subcam-panel';
    // ⚠️ 真ん中（中身の場所）は【必ず透かす】。ここに背景を敷くと、その下に
    //   描いた小窓の絵が隠れて、ぼんやり暗いだけの板になる。
    //   背景は見出しと足元にだけ持たせ、真ん中は素通しにする。
    panel.style.cssText = 'position:fixed;left:24px;top:96px;z-index:900;display:none;'
        + 'width:328px;border-radius:14px;overflow:hidden;background:transparent;'
        + 'box-shadow:0 10px 30px rgba(0,0,0,.30);'
        + 'font:12px/1.4 system-ui,sans-serif;color:#eef1f4;user-select:none;';
    const GLASS = 'background:rgba(20,24,28,.82);backdrop-filter:blur(10px);'
        + '-webkit-backdrop-filter:blur(10px);';

    /* 見出し＝つまんで動かすところ */
    const head = document.createElement('div');
    head.style.cssText = 'display:flex;align-items:center;gap:8px;padding:8px 10px;'
        + 'cursor:grab;' + GLASS;
    head.innerHTML = '<span style="font-size:13px">🎥</span>'
        + '<span style="font-weight:700;letter-spacing:.02em">サブカメラ</span>';
    labelEl = document.createElement('span');
    labelEl.style.cssText = 'margin-left:auto;opacity:.7;font-variant-numeric:tabular-nums;';
    head.appendChild(labelEl);
    const fold = iconBtn('－', '畳む／開く', () => {
        collapsed = !collapsed;
        // ⚠️ 戻す先は空文字ではなく【元の並べ方】。空文字だと縦積みに化ける。
        viewEl.style.display = collapsed ? 'none' : 'block';
        footEl.style.display = collapsed ? 'none' : 'flex';
        fold.textContent = collapsed ? '＋' : '－';
        requestRender();
    });
    head.appendChild(fold);
    head.appendChild(iconBtn('✕', 'サブカメラを削除', () => SubCam.remove()));
    panel.appendChild(head);

    /* 中身の場所。ここは【空けておく】。WebGL がこの位置へ直接描く。 */
    viewEl = document.createElement('div');
    viewEl.style.cssText = 'position:relative;width:100%;aspect-ratio:16/9;cursor:pointer;'
        + 'background:transparent;box-shadow:0 0 0 1px rgba(255,255,255,.18) inset;';
    const over = document.createElement('div');
    over.style.cssText = 'position:absolute;inset:0;display:flex;align-items:flex-end;'
        + 'justify-content:center;padding-bottom:8px;opacity:0;transition:opacity .15s;'
        + 'background:linear-gradient(to top,rgba(0,0,0,.45),transparent 45%);';
    // ⚠️ 「画角へ」とは書かない。合わせるのは【位置と向きだけ】で、
    //   主画面の写る広さは変わらない。
    over.innerHTML = '<span style="font-size:11px;font-weight:700">'
        + 'クリックでこの位置・向きへ</span>';
    viewEl.title = 'このカメラと同じ位置・向きに主画面を移します'
        + '（主画面の画角は変わりません）。';
    viewEl.appendChild(over);
    viewEl.onpointerenter = () => { over.style.opacity = '1'; };
    viewEl.onpointerleave = () => { over.style.opacity = '0'; };
    viewEl.onclick = () => SubCam.toMain();
    panel.appendChild(viewEl);

    /* 足元。2段に分けて組む。
       ⚠️ 畳んで開いたときに崩れないよう、開くときは display を【flex に戻す】。
         空文字に戻すと縦積み（block）になって、ボタンが1つずつ改行される。 */
    const foot = document.createElement('div');
    foot.style.cssText = 'display:flex;flex-direction:column;gap:7px;padding:8px 10px;'
        + GLASS;

    const row1 = document.createElement('div');
    row1.style.cssText = 'display:flex;gap:6px;';
    row1.appendChild(textBtn('撮り直す', 'いまの主画面を、このサブカメラに入れ直します。',
        () => SubCam.capture(), true));
    row1.appendChild(textBtn('人の目', '高さ 1.5m に降ろして、水平を向きます。',
        () => SubCam.eyeLevel()));
    foot.appendChild(row1);

    const row2 = document.createElement('div');
    row2.style.cssText = 'display:flex;align-items:center;gap:6px;';
    const cap = document.createElement('span');
    cap.textContent = '画角';
    cap.title = '写真のレンズと同じ言い方。数字が小さいほど広く写ります。';
    cap.style.cssText = 'font-size:11px;opacity:.65;font-weight:700;';
    row2.appendChild(cap);
    const lens = document.createElement('div');
    lens.style.cssText = 'display:flex;gap:3px;margin-left:auto;';
    lensBtns = {};
    for (const [mm, name, why] of LENSES) {
        const b = textBtn(mm + 'mm', `${name}：${why}`, () => SubCam.setFocal(mm));
        lensBtns[mm] = b;
        lens.appendChild(b);
    }
    row2.appendChild(lens);
    foot.appendChild(row2);

    // いま選んでいる画角が、何のためのものかを1行で。
    noteEl = document.createElement('div');
    noteEl.style.cssText = 'font-size:10.5px;line-height:1.45;opacity:.72;';
    foot.appendChild(noteEl);

    panel.appendChild(foot);
    footEl = foot;

    document.body.appendChild(panel);
    dragBy(head);
}

function iconBtn(label, tip, fn) {
    const b = document.createElement('div');
    b.textContent = label;
    b.title = tip;
    b.style.cssText = 'width:20px;height:20px;display:flex;align-items:center;'
        + 'justify-content:center;border-radius:6px;cursor:pointer;opacity:.75;'
        + 'background:rgba(255,255,255,.08);font-size:11px;';
    b.onpointerdown = (e) => e.stopPropagation();
    b.onclick = fn;
    b.onpointerenter = () => { b.style.opacity = '1'; };
    b.onpointerleave = () => { b.style.opacity = '.75'; };
    return b;
}

function textBtn(label, tip, fn, primary) {
    const b = document.createElement('div');
    b.textContent = label;
    b.title = tip;
    b.style.cssText = 'padding:5px 9px;border-radius:7px;cursor:pointer;font-weight:700;'
        + 'font-size:11px;transition:background .12s;'
        + (primary ? 'background:#0f7fd4;color:#fff;'
            : 'background:rgba(255,255,255,.10);color:#eef1f4;');
    b.onclick = fn;
    b.onpointerenter = () => {
        b.style.background = (primary || b.dataset.on)
            ? '#1a8fe6' : 'rgba(255,255,255,.2)';
    };
    b.onpointerleave = () => {
        // ⚠️ 選んでいるボタンは、離しても青のまま。戻すと「いまどれか」が消える。
        b.style.background = (primary || b.dataset.on)
            ? '#0f7fd4' : 'rgba(255,255,255,.10)';
    };
    return b;
}

/* 見出しを掴んで小窓を動かす。画面の外へは出さない。 */
function dragBy(handle) {
    let d = null;
    handle.addEventListener('pointerdown', (e) => {
        d = { x: e.clientX, y: e.clientY, l: panel.offsetLeft, t: panel.offsetTop };
        handle.style.cursor = 'grabbing';
        handle.setPointerCapture(e.pointerId);
    });
    handle.addEventListener('pointermove', (e) => {
        if (!d) return;
        const w = panel.offsetWidth, h = panel.offsetHeight;
        const l = Math.max(4, Math.min(d.l + e.clientX - d.x, window.innerWidth - w - 4));
        const t = Math.max(4, Math.min(d.t + e.clientY - d.y, window.innerHeight - h - 4));
        panel.style.left = l + 'px';
        panel.style.top = t + 'px';
        requestRender();               // 中身も一緒に動かす
    });
    handle.addEventListener('pointerup', (e) => {
        d = null;
        handle.style.cursor = 'grab';
        try { handle.releasePointerCapture(e.pointerId); } catch (err) { /* 解放済み */ }
    });
}

function showPanel(v2) { if (panel) panel.style.display = v2 ? '' : 'none'; }

function updateLabel() {
    if (!cam) return;
    const row = LENSES.find((l) => l[0] === cam.focal);
    if (labelEl) labelEl.textContent = cam.focal + 'mm' + (row ? '・' + row[1] : '');
    if (noteEl) noteEl.textContent = row ? row[2] : '';
    for (const [mm, b] of Object.entries(lensBtns)) {
        const on = Number(mm) === cam.focal;
        b.dataset.on = on ? '1' : '';
        b.style.background = on ? '#0f7fd4' : 'rgba(255,255,255,.10)';
        b.style.color = '#eef1f4';
    }
}
