// ★追加：ツールバーの「取り込み／書き出し」ボタンの中身。
//   ★ 入口を1つにまとめる。DXF・3Dモデル・GLB書き出しは、どれも
//     「外のファイルとやりとりする」という同じ用事なので、
//     ボタンを別々に並べると、その3つが並びの中で迷子になる。
//   ⚠️ ここは【入口の一覧】だけ。実際の読み書きは呼び出し先に任せる。

let panel = null;

function close() {
    if (!panel) return;
    panel.remove();
    panel = null;
    document.removeEventListener('pointerdown', onOutside, true);
}

function onOutside(e) {
    if (panel && !panel.contains(e.target)) close();
}

/* 見出し（灰色の小さな字）。 */
function head(text) {
    const el = document.createElement('div');
    el.style.cssText = 'font-size:11px;font-weight:700;color:#98a1ad;'
        + 'letter-spacing:.06em;padding:2px 2px 4px;';
    el.textContent = text;
    return el;
}

/* 1行のボタン。太字の題と、その下に小さな説明。
   ★ 入りは青、出は赤。色そのもので「取り込みなのか書き出しなのか」が
     分かるようにする（アイコンの矢印の色ともそろえている）。 */
function item(title, note, onClick, out) {
    const el = document.createElement('div');
    el.className = out ? 'float-btn danger' : 'float-btn';
    el.style.cssText = 'text-align:left;padding:7px 10px;font-weight:700;';
    el.innerHTML = `<div>${title}</div>`
        + `<div style="font-size:10.5px;font-weight:400;opacity:.85;margin-top:1px">${note}</div>`;
    el.onclick = () => { close(); onClick(); };
    return el;
}

/* ボタンの上に開く。acts は { dxf, model, glbBuilding, glbAll }。 */
export function openIoMenu(btn, acts) {
    if (panel) { close(); return; }
    panel = document.createElement('div');
    panel.style.cssText = 'position:absolute;z-index:100001;display:flex;'
        + 'flex-direction:column;gap:4px;min-width:236px;'
        + 'background:rgba(255,255,255,.97);border:1px solid #ccc;border-radius:8px;'
        + 'padding:8px;box-shadow:0 6px 18px rgba(0,0,0,.22);'
        + 'font:12px/1.4 system-ui,sans-serif;';

    panel.appendChild(head('⤓ 取り込む'));
    panel.appendChild(item('DXF の平面図', '通り芯と壁芯から階を起こす',
        acts.dxf));
    panel.appendChild(item('3D モデル', 'glb / gltf / obj / stl を置く（動かせます）',
        acts.model));

    const sep = document.createElement('div');
    sep.style.cssText = 'height:1px;background:#e3e7ec;margin:4px 0 2px;';
    panel.appendChild(sep);

    panel.appendChild(head('⤒ 書き出す'));
    panel.appendChild(item('GLB（建物のみ）', '取り込んだモデルも一緒に出ます',
        acts.glbBuilding, true));
    panel.appendChild(item('GLB（建物＋外構）', '芝生・囲い・樹木まで含める',
        acts.glbAll, true));

    const sep2 = document.createElement('div');
    sep2.style.cssText = 'height:1px;background:#e3e7ec;margin:4px 0 2px;';
    panel.appendChild(sep2);

    panel.appendChild(head('⧉ コピー'));
    panel.appendChild(item('画面を画像でコピー',
        'PowerPoint などにそのまま貼れます（絵）', acts.copyImage, true));

    // ★ 3D のまま貼る道はブラウザからは無いので、そのことを書いておく。
    //   ⚠️ 書いておかないと「コピーしたのに3Dで貼れない」と何度も試すことになる。
    const tip = document.createElement('div');
    tip.style.cssText = 'font-size:10.5px;color:#8a929c;line-height:1.5;padding:2px 3px 0;';
    tip.innerHTML = '3D のまま貼るには、GLB で書き出してから<br>'
        + 'PowerPoint の「挿入 ▸ 3D モデル ▸ このデバイス」で読ませます。<br>'
        + '（3D のままの貼り付け・ドラッグは、ブラウザからはできません）';
    panel.appendChild(tip);

    document.body.appendChild(panel);
    // ボタンの真上に。画面からはみ出さないよう左右だけ寄せる。
    const r = btn.getBoundingClientRect();
    const w = panel.offsetWidth, h = panel.offsetHeight;
    let left = r.left + r.width / 2 - w / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
    panel.style.left = left + 'px';
    panel.style.top = Math.max(8, r.top - h - 8) + 'px';

    // ⚠️ すぐ閉じないよう、次の押下から外側判定を始める。
    setTimeout(() => document.addEventListener('pointerdown', onOutside, true), 0);
}

export function closeIoMenu() { close(); }
