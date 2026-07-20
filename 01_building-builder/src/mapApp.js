// mapApp.js
// 2D地図（Leaflet + 地理院地図）による配置場所選択モジュール

let map = null;
let marker = null;

/**
 * 2D地図モーダルを開く関数
 * @param {Object} initialLoc - 初期座標 {lat, lng}
 * @param {Function} onConfirm - 「3Dに配置」が押された時のコールバック(選択された座標を渡す)
 * @param {Function} onCancel - 「キャンセル」が押された時のコールバック
 */
export function openMapModal(initialLoc, onConfirm, onCancel) {
    const modalOverlay = document.getElementById('map-modal-overlay');
    modalOverlay.style.display = 'flex';

    // 地図がまだ初期化されていなければ作成
    if (!map) {
        map = L.map('map-container').setView([initialLoc.lat, initialLoc.lng], 16);

        // 地理院地図（淡色地図）の読み込み
        L.tileLayer('https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png', {
            attribution: "<a href='https://maps.gsi.go.jp/development/ichiran.html' target='_blank'>地理院タイル</a>",
            maxZoom: 18
        }).addTo(map);

        // クリックでマーカーを移動させるイベント
        map.on('click', function(e) {
            if (marker) {
                marker.setLatLng(e.latlng);
            } else {
                marker = L.marker(e.latlng).addTo(map);
            }
        });
    } else {
        // 既に地図がある場合は、表示サイズのリセットと視点移動を行う
        map.invalidateSize();
        map.setView([initialLoc.lat, initialLoc.lng], 16);
    }

    // 初期のピン（マーカー）を設置
    if (marker) {
        marker.setLatLng([initialLoc.lat, initialLoc.lng]);
    } else {
        marker = L.marker([initialLoc.lat, initialLoc.lng]).addTo(map);
    }

    // ボタンのイベントリスナーを設定（古いイベントが重複しないように一度削除してから登録）
    const btnConfirm = document.getElementById('btn-map-confirm');
    const btnCancel = document.getElementById('btn-map-cancel');

    btnConfirm.onclick = () => {
        const selectedLoc = marker.getLatLng();
        modalOverlay.style.display = 'none';
        onConfirm({ lat: selectedLoc.lat, lng: selectedLoc.lng });
    };

    btnCancel.onclick = () => {
        modalOverlay.style.display = 'none';
        if (onCancel) onCancel();
    };
}