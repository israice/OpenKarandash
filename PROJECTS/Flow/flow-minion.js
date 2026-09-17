// Вращающийся 3D-персонаж внутри личной ноды QA на канвасе Flow.
//
// Перенос мини-рендера «досье» из island-sim (DossierModel.tsx): своя сцена
// three.js на маленьком канвасе, модель медленно крутится вокруг оси Y, видна
// со всех сторон. Здесь он стоит первым в шапке ноды QA, слева от заголовка.
//
// Модуль ничего не знает о flow.js: ноды клонируются из шаблонов
// #flowNodeQaTemplate/#flowNodeBackendTemplate, поэтому он просто следит за
// появлением `.flow-node--qa`/`.flow-node--backend` на странице
// (MutationObserver) и сам вставляет канвас в шапку. Так его правка не трогает
// граф, а поломка не гасит вкладку целиком (DOCS/decisions/014).
//
// Модель `assets/traveler.glb` — та же, что у жителей острова в island-sim:
// статичная (без скелета и клипов), конверсия из OBJ, поэтому вместо
// SkeletonUtils.clone и AnimationMixer достаточно обычного clone и поворота.
// Голый специфер `three` разрешает importmap в SYSTEM/index.html: адресные
// модули GLTFLoader из node_modules импортируют three именно так (DOCS/decisions/027).
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const MODEL_URL = 'PROJECTS/Flow/assets/traveler.glb';
// размер канваса в CSS-пикселях; сам буфер крупнее на devicePixelRatio
const W = 56;
const H = 72;
// скорость вращения, рад/с — как в досье island-sim (полный оборот ~8 с)
const SPIN = 0.8;
const CANVAS_CLASS = 'flow-node__minion';

let gltfPromise = null;
function loadModel() {
    if (!gltfPromise) {
        gltfPromise = new GLTFLoader().loadAsync(MODEL_URL).then((gltf) => {
            // материалы после obj2gltf нередко зеркальные (metalness = 1) — на тёмной
            // карточке такой персонаж чёрный. Приводим к матовому освещаемому виду,
            // как делает litMaterial в island-sim
            gltf.scene.traverse((obj) => {
                if (!obj.isMesh) return;
                const list = Array.isArray(obj.material) ? obj.material : [obj.material];
                for (const m of list) {
                    if ('metalness' in m) m.metalness = 0;
                    if ('roughness' in m) m.roughness = Math.max(m.roughness ?? 0, 0.85);
                }
            });
            return gltf;
        });
    }
    return gltfPromise;
}

// все живые вьюшки: один общий rAF-цикл вместо цикла на каждую ноду
const views = new Map(); // canvas -> { renderer, scene, camera, model }
const clock = new THREE.Clock();
let frame = 0;

function tick() {
    frame = requestAnimationFrame(tick);
    const dt = Math.min(clock.getDelta(), 0.05);
    for (const [canvas, view] of views) {
        // нода спрятана (другая вкладка или другой пункт меню Flow) — не рисуем,
        // но угол докручиваем, чтобы при возврате персонаж не «прыгал»
        view.model.rotation.y += dt * SPIN;
        if (document.hidden || !canvas.offsetParent) continue;
        view.renderer.render(view.scene, view.camera);
    }
}

function mount(node) {
    const header = node.querySelector('.flow-node__header');
    if (!header || header.querySelector(`.${CANVAS_CLASS}`)) return;

    const canvas = document.createElement('canvas');
    canvas.className = CANVAS_CLASS;
    canvas.width = W;
    canvas.height = H;
    canvas.setAttribute('aria-hidden', 'true');
    // первым в строке шапки, слева от заголовка (иконки-аватара у ноды QA нет)
    header.insertBefore(canvas, header.firstChild);

    loadModel().then((gltf) => {
        // пока модель грузилась, ноду могли убрать с канваса
        if (!canvas.isConnected) return;

        const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
        renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
        renderer.setSize(W, H, false);

        const scene = new THREE.Scene();
        // ракурс и свет — из DossierModel.tsx island-sim
        const camera = new THREE.PerspectiveCamera(32, W / H, 0.05, 10);
        camera.position.set(0, 0.5, 2.0);
        camera.lookAt(0, 0.45, 0);
        scene.add(new THREE.HemisphereLight(0xeaf4ff, 0x707060, 1.4));
        const key = new THREE.DirectionalLight(0xfff2df, 2.4);
        key.position.set(1.5, 2, 2);
        scene.add(key);

        // исходник traveler в разы крупнее прочих моделей (в island-sim scale 0.19):
        // вместо ручного коэффициента вписываем модель в единичный рост и ставим
        // ногами на y = 0 — так же поведёт себя любая другая модель на замену
        const model = gltf.scene.clone(true);
        const box = new THREE.Box3().setFromObject(model);
        const size = box.getSize(new THREE.Vector3());
        const k = 1 / Math.max(size.y, 1e-6);
        model.scale.setScalar(k);
        const center = box.getCenter(new THREE.Vector3());
        // вращается вокруг своей вертикальной оси, а не вокруг угла сцены
        model.position.set(-center.x * k, -box.min.y * k, -center.z * k);
        const pivot = new THREE.Group();
        pivot.add(model);
        scene.add(pivot);

        views.set(canvas, { renderer, scene, camera, model: pivot });
        if (!frame) tick();
    }).catch((err) => {
        console.warn('[flow-minion] модель не загрузилась:', err);
        canvas.remove();
    });
}

function unmount(canvas) {
    const view = views.get(canvas);
    if (!view) return;
    views.delete(canvas);
    view.renderer.dispose();
    if (!views.size) {
        cancelAnimationFrame(frame);
        frame = 0;
    }
}

// личных нод с этим персонажем уже несколько (QA и Backend developer) —
// один селектор на обе, чтобы новый профиль с той же карточкой не требовал
// правки этого файла
const PERSONAL_ROOT_SELECTOR = '.flow-node--qa, .flow-node--backend, .flow-node--profile';

function scanAdded(root) {
    if (root.nodeType !== 1) return;
    if (root.matches(PERSONAL_ROOT_SELECTOR)) mount(root);
    for (const node of root.querySelectorAll(PERSONAL_ROOT_SELECTOR)) mount(node);
}

function scanRemoved(root) {
    if (root.nodeType !== 1) return;
    if (root.matches(`.${CANVAS_CLASS}`)) unmount(root);
    for (const canvas of root.querySelectorAll(`.${CANVAS_CLASS}`)) unmount(canvas);
}

// ноды QA/Backend уже могли появиться до загрузки модуля — подхватываем и их
scanAdded(document.body);
new MutationObserver((records) => {
    for (const r of records) {
        for (const n of r.addedNodes) scanAdded(n);
        for (const n of r.removedNodes) scanRemoved(n);
    }
}).observe(document.body, { childList: true, subtree: true });
