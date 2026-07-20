// ms_ui_manager.js
import { allHues, munsellTreeCache, getMunsellHexSafe, loadError } from './ms_color_space.js';
import { neutralHexLut } from './ms_color_data.js';

let onColorSelectedCallback = null;
let onTextureSelectedCallback = null;
export let currentHueIndex = 0;

// UIマネージャーの初期化（3D側からコールバックを受け取る）
export function initUIManager(callbacks) {
    // ★ 追加：初期化時に1回だけ、スライダーを「リセットされない親枠（col-palette）」に移動させる
    const wheelEl = document.getElementById('col-wheel');
    const colPalette = document.getElementById('col-palette');
    if (wheelEl && colPalette) {
        colPalette.appendChild(wheelEl);
        
        // ★ 新規追加：色相スライダーのドラッグ中ロック機構（案B）
        // マウスダウンでロックON、画面のどこかでマウスアップしたらロック解除
        wheelEl.addEventListener('pointerdown', () => {
            wheelEl.classList.add('is-dragging');
        });
        window.addEventListener('pointerup', () => {
            wheelEl.classList.remove('is-dragging');
        });
    }

    // ★追加：メッセージボックスもパレットの基準コンテナ内に移植する
    const hoverBox = document.getElementById('hover-message-box');
    if (hoverBox && colPalette) {
        colPalette.appendChild(hoverBox);
    }

    onColorSelectedCallback = callbacks.onColorChange;
    onTextureSelectedCallback = callbacks.onTextureChange;
    
    setupWheelEvents();
    setupManualInputEvents();
    setupPresetEvents();
    setupTextureEvents();
    
    generateHTMLPalette(currentHueIndex);
}

// UIの文字情報（HEX, RGBなど）だけを更新する関数
export function updateUIInfo(munsellStr, hexColor) {
    // ★ テキスト表示(info-munsell)は廃止されたため削除
    document.getElementById('info-hex').textContent = hexColor;
    
    if (hexColor && hexColor.length === 7) {
        const r = parseInt(hexColor.slice(1, 3), 16);
        const g = parseInt(hexColor.slice(3, 5), 16);
        const b = parseInt(hexColor.slice(5, 7), 16);
        document.getElementById('info-rgb').textContent = `rgb(${r}, ${g}, ${b})`;
    } else {
        document.getElementById('info-rgb').textContent = "-";
    }

    document.getElementById('selected-color-box').style.backgroundColor = hexColor !== "-" ? hexColor : "transparent";
    
    if (munsellStr.startsWith('N ')) {
        const v = munsellStr.split(' ')[1];
        const currentHueStr = allHues[currentHueIndex];
        const hMatch = currentHueStr.match(/^([0-9.]+)([a-zA-Z]+)$/);
        if (hMatch) {
            document.getElementById('in-h-val').value = hMatch[1];
            document.getElementById('in-h-type').value = hMatch[2];
        }
        document.getElementById('in-v').value = v;
        document.getElementById('in-c').value = '0';
    } else if (munsellStr !== "キューブから取得" && munsellStr !== "-") {
        const match = munsellStr.match(/^([0-9.]+)([a-zA-Z]+)\s+([0-9.]+)\/([0-9.]+)$/);
        if (match) {
            document.getElementById('in-h-val').value = match[1];
            document.getElementById('in-h-type').value = match[2];
            document.getElementById('in-v').value = match[3];
            document.getElementById('in-c').value = match[4];
        }
    }
}

// 外部（3Dモデルのクリック時など）からダイヤルの角度を強制的に回す関数
export function setHueWheel(hueIndex) {
    currentHueIndex = hueIndex;
    document.getElementById('wheel-knob-container').style.transform = `rotate(${hueIndex * 9}deg)`;
    generateHTMLPalette(hueIndex);
}

// 内部で色が選ばれた時の共通アクション
function handleColorSelection(munsellStr, hexColor) {
    updateUIInfo(munsellStr, hexColor);
    if (onColorSelectedCallback) onColorSelectedCallback(hexColor);
}

function addHoverMessageEvent(chip, munsellVal) {
    const hoverMessageBox = document.getElementById('hover-message-box');
    chip.addEventListener('mouseenter', () => {
        hoverMessageBox.textContent = `${munsellVal} で着色できます`;
        hoverMessageBox.style.opacity = '1';
        hoverMessageBox.style.visibility = 'visible';
    });
    chip.addEventListener('mouseleave', () => {
        hoverMessageBox.style.opacity = '0';
        hoverMessageBox.style.visibility = 'hidden';
    });
}

function generateHTMLPalette(hueIndex) {
    if (loadError) return;
    const paletteContainer = document.getElementById('palette-container');
    paletteContainer.innerHTML = '';
    const hueStr = allHues[hueIndex];
    document.getElementById('hue-display').textContent = hueStr;

    const STEP = 26; // チップ20px + 隙間6px

    // ★「Value（明度）」の縦書き表示位置を補正
    const vTitle = document.createElement('div');
    vTitle.className = 'axis-title vertical-title'; vTitle.textContent = 'Value（明度）';
    vTitle.style.left = `-110px`; /* 数字ラベルのさらに左にきれいに並ぶようマージンを調整 */
    vTitle.style.bottom = `${4.0 * STEP}px`; 
    paletteContainer.appendChild(vTitle);

    for (let v = 1; v <= 9; v++) {
        const label = document.createElement('div');
        label.className = 'axis-label'; label.textContent = v; label.style.left = `-24px`; label.style.bottom = `${(v - 1) * STEP}px`; 
        paletteContainer.appendChild(label);
    }

    // ★「Chroma（彩度）」のタイトル位置を上方に退避させ、数字(10や12)との被りを解消
    const cTitle = document.createElement('div');
    cTitle.className = 'axis-title'; cTitle.textContent = 'Chroma（彩度）'; 
    cTitle.style.left = `${STEP}px`; 
    cTitle.style.bottom = `${9.5 * STEP + 10}`; /* グリッド最上段からさらに10px上に配置 */
    paletteContainer.appendChild(cTitle);

    const nLabel = document.createElement('div');
    nLabel.className = 'axis-label'; nLabel.textContent = 'N'; nLabel.style.left = `0px`; nLabel.style.bottom = `${9 * STEP}px`;
    paletteContainer.appendChild(nLabel);

    for (let c = 1; c <= 14; c++) {
        const label = document.createElement('div');
        label.className = 'axis-label'; label.textContent = c; label.style.left = `${c * STEP}px`; label.style.bottom = `${9 * STEP}px`;
        paletteContainer.appendChild(label);
    }

    for (let v = 1; v <= 9; v++) {
        const hexColor = neutralHexLut[v];
        const chip = document.createElement('div');
        chip.className = 'color-chip'; chip.style.backgroundColor = hexColor;
        chip.style.left = `0px`; chip.style.bottom = `${(v - 1) * STEP}px`;
        const munsellVal = `N ${v}`; chip.title = munsellVal;

        chip.addEventListener('pointerdown', (e) => { e.stopPropagation(); handleColorSelection(munsellVal, hexColor); });
        addHoverMessageEvent(chip, munsellVal);
        paletteContainer.appendChild(chip);
    }

    const hueData = munsellTreeCache[hueStr];
    if (hueData) {
        for (const vStr in hueData) {
            const v = parseInt(vStr);
            for (const cStr in hueData[v]) {
                const c = parseInt(cStr);
                if(c > 14) continue; 
                const hexColor = hueData[v][c];
                const chip = document.createElement('div');
                chip.className = 'color-chip'; chip.style.backgroundColor = hexColor;
                chip.style.left = `${c * STEP}px`; chip.style.bottom = `${(v - 1) * STEP}px`;
                const munsellVal = `${hueStr} ${v}/${c}`; chip.title = munsellVal;

                chip.addEventListener('pointerdown', (e) => { e.stopPropagation(); handleColorSelection(munsellVal, hexColor); });
                addHoverMessageEvent(chip, munsellVal);
                paletteContainer.appendChild(chip);
            }
        }
    }
}

function setupWheelEvents() {
    const wheelEl = document.getElementById('col-wheel'); 
    const wheelContainer = document.getElementById('wheel-container'); // ★大スライダー本体を取得
    const wheelKnobContainer = document.getElementById('wheel-knob-container');
    let isDraggingWheel = false;

    function updateWheelByMouse(e) {
        // ★変更：角度計算の中心を「大スライダー本体」の見た目の中心座標にする（直接操作化）
        const rect = wheelContainer.getBoundingClientRect();
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        let angleRad = Math.atan2(e.clientY - cy, e.clientX - cx);
        let angleDeg = angleRad * (180 / Math.PI) + 90;
        if (angleDeg < 0) angleDeg += 360;
        
        let step = Math.round(angleDeg / 9);
        if (step >= 40) step = 0;
        
        wheelKnobContainer.style.transform = `rotate(${step * 9}deg)`;
        if (currentHueIndex !== step) {
            currentHueIndex = step;
            generateHTMLPalette(step);
        }
    }

    // ★変更：イベントリスナーを wheelContainer ではなく wheelEl(センサー枠) に紐付ける
    wheelEl.addEventListener('pointerdown', (e) => { isDraggingWheel = true; updateWheelByMouse(e); });
    window.addEventListener('pointermove', (e) => { if (isDraggingWheel) { updateWheelByMouse(e); e.preventDefault(); } });
    window.addEventListener('pointerup', () => { isDraggingWheel = false; });
}

function setupManualInputEvents() {
    const hTypeSelect = document.getElementById('in-h-type');
    
    function applyManualInput() {
        const hVal = document.getElementById('in-h-val').value;
        const hType = hTypeSelect.value;
        const vVal = document.getElementById('in-v').value;
        const cVal = document.getElementById('in-c').value;

        if (hVal !== '' && vVal !== '' && cVal !== '') {
            const munsellStr = `${hVal}${hType} ${vVal}/${cVal}`;
            try {
                const hexColor = getMunsellHexSafe(munsellStr);
                if (hexColor) handleColorSelection(munsellStr, hexColor);
            } catch (e) {}
        }
    }

    hTypeSelect.addEventListener('wheel', (e) => {
        e.preventDefault(); 
        const options = Array.from(hTypeSelect.options);
        let currentIndex = hTypeSelect.selectedIndex;
        if (e.deltaY > 0) currentIndex = (currentIndex + 1) % options.length;
        else if (e.deltaY < 0) currentIndex = (currentIndex - 1 + options.length) % options.length;
        hTypeSelect.selectedIndex = currentIndex;
        applyManualInput(); 
    });

   ['in-h-val', 'in-h-type', 'in-v', 'in-c'].forEach(id => {
        document.getElementById(id).addEventListener('input', applyManualInput);
    });

    // ★追加：色相数値・明度・彩度の「バーチャルスライダー（ドラッグ入力）」機構
    ['in-h-val', 'in-v', 'in-c'].forEach(id => {
        const inputEl = document.getElementById(id);
        let startX = 0;
        let startVal = 0;
        let isDragging = false;

        inputEl.addEventListener('pointerdown', (e) => {
            isDragging = true;
            startX = e.clientX;
            // 現在の数値を基準値として記憶（空欄なら0）
            startVal = parseFloat(inputEl.value) || 0;
            // マウスをキャプチャし、ドラッグ中に画面外へはみ出してもイベントを逃さないようにする
            inputEl.setPointerCapture(e.pointerId);
        });

        inputEl.addEventListener('pointermove', (e) => {
            if (!isDragging) return;
            
            const deltaX = e.clientX - startX;
            // ★感度設定：マウスを5px動かすたびに「0.1」変化させる（プロツール基準の快適な速度）
            let deltaVal = Math.round(deltaX / 5) * 0.1;
            let newVal = startVal + deltaVal;
            
            // 各入力欄の min / max の限界を超えないようにクランプ（安全ガード）
            const min = parseFloat(inputEl.getAttribute('min'));
            const max = parseFloat(inputEl.getAttribute('max'));
            if (!isNaN(min)) newVal = Math.max(min, newVal);
            if (!isNaN(max)) newVal = Math.min(max, newVal);
            
            // 数値が実際に変化した時だけ画面と3Dモデルを更新する
            const formattedVal = newVal.toFixed(1);
            if (inputEl.value !== formattedVal) {
                inputEl.value = formattedVal;
                applyManualInput();
            }
        });

        // マウスを離したらドラッグ状態とキャプチャを解除
        inputEl.addEventListener('pointerup', (e) => {
            isDragging = false;
            inputEl.releasePointerCapture(e.pointerId);
        });
    });

    // ★追加：色相タイプ（R, YR...）のバーチャルスライダー（ドラッグ入力）機構
    let hStartX = 0;
    let hStartIdx = 0;
    let isHDragging = false;

    hTypeSelect.addEventListener('pointerdown', (e) => {
        isHDragging = true;
        hStartX = e.clientX;
        hStartIdx = hTypeSelect.selectedIndex;
        hTypeSelect.setPointerCapture(e.pointerId);
        // ドラッグ開始時にOS標準のプルダウンメニューが開いてしまうのを防ぐ
        e.preventDefault(); 
    });

    hTypeSelect.addEventListener('pointermove', (e) => {
        if (!isHDragging) return;
        const deltaX = e.clientX - hStartX;
        
        // ★感度設定：20px動くごとに1インデックス（隣の色相）へシフトさせる
        let step = Math.floor(deltaX / 20);
        
        // 現在のインデックスからステップ分を足し、マイナスになったらループして最後尾(RP)に戻す
        let newIdx = (hStartIdx + step) % hTypeSelect.options.length;
        if (newIdx < 0) newIdx += hTypeSelect.options.length; 
        
        if (hTypeSelect.selectedIndex !== newIdx) {
            hTypeSelect.selectedIndex = newIdx;
            applyManualInput(); // 画面と3Dモデルに即座に同期
        }
    });

    hTypeSelect.addEventListener('pointerup', (e) => {
        isHDragging = false;
        hTypeSelect.releasePointerCapture(e.pointerId);
        
        // ドラッグせずにただクリックしただけ（移動距離が3px未満）なら、本来のプルダウンメニューを明示的に開く
        const deltaX = Math.abs(e.clientX - hStartX);
        if (deltaX < 3 && typeof hTypeSelect.showPicker === 'function') {
            try {
                hTypeSelect.showPicker();
            } catch (err) {}
        }
    });
}

function setupPresetEvents() {
    const presetSelect = document.getElementById('preset-select');
    function applyPreset() {
        const munsellStr = presetSelect.value;
        if (!munsellStr) return; 
        const hexColor = getMunsellHexSafe(munsellStr);
        if (hexColor) handleColorSelection(munsellStr, hexColor);
    }
    presetSelect.addEventListener('change', applyPreset);
    presetSelect.addEventListener('wheel', (e) => {
        e.preventDefault();
        const options = Array.from(presetSelect.options);
        let currentIndex = presetSelect.selectedIndex;
        if (e.deltaY > 0) currentIndex = (currentIndex + 1) % options.length;
        else if (e.deltaY < 0) currentIndex = (currentIndex - 1 + options.length) % options.length;
        presetSelect.selectedIndex = currentIndex;
        applyPreset();
    });
}

function setupTextureEvents() {
    document.getElementById('texture-select').addEventListener('change', (e) => {
        if (onTextureSelectedCallback) onTextureSelectedCallback(e.target.value);
    });
}