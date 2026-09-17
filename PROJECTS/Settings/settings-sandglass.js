// 3D-рендер песочных часов вкладки Settings → Sandglass.
//
// Полноценный перенос из https://github.com/khanmjk/Hourglass_Fable5: честная
// физика на Rapier (WASM), 2000 отдельных песчинок, та же механика «заглушки»
// в горлышке (freeze-plug) — песок не сыплется сам по себе, а выпускается
// счётчиком порциями. Используется -compat сборка Rapier: WASM в ней вшит в
// сам .mjs base64-строкой, поэтому не нужно отдельно отдавать .wasm с верным
// MIME — обоснование новой зависимости: только так получается «точь-в-точь
// как в примере», а не плоская имитация на одном three.js.
//
// Отличия от оригинала (осознанно, под маленький виджет в модалке настроек,
// а не полноэкранное демо):
// — нет своего таймера старт/пауза/переворот, кнопок, звука, пульта минут —
//   часы всегда «текут» в одну сторону и привязаны к настоящей доле прошедшего
//   времени счётчика settings.js из data-elapsed на .sandglass (контракт между
//   файлами, см. renderSandglassSand там) — это сознательный выбор пользователя
//   проекта: честная привязка к реальному времени, а не ускоренная имитация.
// — OrbitControls оставлены как в оригинале (вращение зажатой мышью/тачем),
//   но enableZoom/enablePan выключены — иначе колесо мыши над маленьким
//   виджетом внутри модалки будет красть скролл страницы, а pan сдвигает
//   камеру мимо часов на таком масштабе без всякой пользы.
// — нет деревянного стола/подставки — при 96×96 px он съедал бы весь кадр.
//
// Модуль ничего не знает о settings.js: тот пишет data-elapsed, здесь она
// читается каждый кадр. Модуль сам находит существующий <canvas class="hourglass">
// внутри .sandglass (разметка — settings.js) и сам следит за его появлением
// через MutationObserver, как flow-minion.js следит за нодами Flow — поломка
// здесь не гасит вкладку Settings целиком (DOCS/decisions/014).
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import * as RAPIER_NS from '@dimforge/rapier3d-simd-compat';
const RAPIER = RAPIER_NS.default ?? RAPIER_NS;

const ROOT_SELECTOR = '.sandglass';
const CANVAS_SELECTOR = 'canvas.hourglass';

/* ---------- геометрия и физика колбы — тот же алгоритм, что в оригинале,
   числа уменьшены под компактный виджет ---------- */
const G = 75;
const H = 15.5;
const BULB_R = 10.5;
const NECK_R = 1.3;
const CAP_R = 5.2;
const WAIST_Y = 0.62 * H;
const THROAT_H = 0.6;

const GRAINS_N = 2000;
const PACKING = 0.62;
const DT = 1 / 120;
const MAX_STEPS = 3;
const V_MAX = 60;
const SLEEP_SP2 = 0.25;
const REL_CAP = 60;
const BANDS = 12;

function profileR(u) {
    const smooth = (t) => t * t * (3 - 2 * t);
    if (u <= WAIST_Y) return NECK_R + (BULB_R - NECK_R) * smooth(u / WAIST_Y);
    const t = Math.min(1, (u - WAIST_Y) / (H - WAIST_Y));
    return BULB_R + (CAP_R - BULB_R) * smooth(t);
}

function grainRadiusFor(count) {
    const yTop = H * 0.78;
    let v = 0;
    const steps = 240;
    for (let i = 0; i < steps; i++) {
        const y = THROAT_H + ((yTop - THROAT_H) * (i + 0.5)) / steps;
        const r = profileR(y);
        v += Math.PI * r * r * ((yTop - THROAT_H) / steps);
    }
    const perGrain = (v * PACKING) / count;
    const r = Math.cbrt(perGrain / ((4 / 3) * Math.PI));
    return Math.max(0.3, Math.min(0.62, r));
}
const GRAIN_R = grainRadiusFor(GRAINS_N);

const Y_HOLD = THROAT_H + GRAIN_R * 1.4;
const HOLD_R2 = (NECK_R * 1.9) ** 2;
const FEED_Y = THROAT_H + GRAIN_R * 9;
const FEED_R2 = (NECK_R * 2.2) ** 2;

/* ---------- общая геометрия/материалы — одни на все экземпляры (в проекте
   он практически всегда один — окно настроек единственное) ---------- */
const lathePts = [new THREE.Vector2(0.15, -H)];
for (let i = 0; i <= 72; i++) {
    const y = -H + (2 * H * i) / 72;
    lathePts.push(new THREE.Vector2(profileR(Math.abs(y)) + 0.12, y));
}
lathePts.push(new THREE.Vector2(0.15, H));
const glassGeo = new THREE.LatheGeometry(lathePts, 56);
const glassMat = new THREE.MeshPhysicalMaterial({
    transmission: 1,
    thickness: 0.9,
    roughness: 0.05,
    ior: 1.45,
    clearcoat: 0.4,
    clearcoatRoughness: 0.2,
    attenuationColor: new THREE.Color(0xeaf4f8),
    attenuationDistance: 140,
    specularIntensity: 0.6,
    envMapIntensity: 0.5,
});
const cheapGlassMat = new THREE.MeshPhysicalMaterial({
    transparent: true, opacity: 0.16, roughness: 0.08, metalness: 0,
    depthWrite: false, envMapIntensity: 1.1,
});

const woodMat = new THREE.MeshStandardMaterial({ color: 0x5c3a22, roughness: 0.62, metalness: 0.05 });
const woodDark = new THREE.MeshStandardMaterial({ color: 0x472c18, roughness: 0.7, metalness: 0.05 });
const capGeo = new THREE.CylinderGeometry(BULB_R + 2.2, BULB_R + 2.2, 1.5, 40);
const lipGeo = new THREE.TorusGeometry(BULB_R + 2.2, 0.28, 10, 48);

const grainGeo = new THREE.IcosahedronGeometry(GRAIN_R, 0);
const grainMat = new THREE.MeshStandardMaterial({ roughness: 0.95, metalness: 0, flatShading: true, envMapIntensity: 0.45 });

let sharedEnvTexture = null;
function envTexture(renderer) {
    if (sharedEnvTexture) return sharedEnvTexture;
    const pmrem = new THREE.PMREMGenerator(renderer);
    const envScene = new RoomEnvironment();
    sharedEnvTexture = pmrem.fromScene(envScene, 0.04).texture;
    pmrem.dispose();
    envScene.dispose();
    return sharedEnvTexture;
}

/* ---------- статичные стены — кольца выпуклых кубоидов вдоль профиля колбы
   (сплошные, песок не пробивает их давлением кучи в отличие от сетки
   нулевой толщины) ---------- */
function buildStaticColliders(world) {
    const fixed = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    const WBANDS = 30, SEGS = 26, WALL_T = 0.9;
    const q = new THREE.Quaternion(), basis = new THREE.Matrix4();
    const xA = new THREE.Vector3(), yA = new THREE.Vector3(), zA = new THREE.Vector3();
    for (let b = 0; b < WBANDS; b++) {
        const y0 = -H + (2 * H * b) / WBANDS, y1 = -H + (2 * H * (b + 1)) / WBANDS;
        const r0 = profileR(Math.abs(y0)), r1 = profileR(Math.abs(y1));
        const ym = (y0 + y1) / 2, rm = (r0 + r1) / 2;
        const dr = r1 - r0, dy = y1 - y0;
        const L = Math.hypot(dr, dy);
        const nu = dy / L, ny = -dr / L;
        const cu = rm + nu * (WALL_T / 2), cy = ym + ny * (WALL_T / 2);
        const chord = (2 * Math.PI * Math.max(cu, 0.4)) / SEGS;
        for (let s = 0; s < SEGS; s++) {
            const a = (s / SEGS) * Math.PI * 2;
            const ca = Math.cos(a), sa = Math.sin(a);
            yA.set((dr / L) * ca, dy / L, (dr / L) * sa);
            xA.set(-sa, 0, ca);
            zA.crossVectors(xA, yA).normalize();
            basis.makeBasis(xA, yA, zA);
            q.setFromRotationMatrix(basis);
            world.createCollider(
                RAPIER.ColliderDesc.cuboid(chord * 0.62, L / 2 + 0.12, WALL_T / 2)
                    .setTranslation(cu * ca, cy, cu * sa)
                    .setRotation({ x: q.x, y: q.y, z: q.z, w: q.w })
                    .setFriction(0.55).setRestitution(0.02),
                fixed,
            );
        }
    }
    for (const s of [-1, 1]) {
        world.createCollider(
            RAPIER.ColliderDesc.cylinder(0.5, CAP_R + 1.2)
                .setTranslation(0, s * (H + 0.48), 0)
                .setFriction(0.55),
            fixed,
        );
    }
}

// плотная посадка зёрен кольцами — куча уже в осевшей плотности, почти без
// переходного «оседания» после старта
function seedPositions(count) {
    const out = [];
    const jit = () => (Math.random() - 0.5) * GRAIN_R * 0.6;
    const spacing = GRAIN_R * 1.96;
    for (let y = THROAT_H + GRAIN_R; y < H - 1.2 && out.length < count; y += GRAIN_R * 1.75) {
        const rMax = profileR(Math.abs(y)) - GRAIN_R - 0.15;
        if (rMax <= 0) continue;
        out.push([jit() * 0.4, y, jit() * 0.4]);
        const a0 = y * 3.7;
        for (let rr = spacing; rr <= rMax && out.length < count; rr += spacing) {
            const n = Math.max(3, Math.floor((Math.PI * 2 * rr) / spacing));
            for (let k = 0; k < n && out.length < count; k++) {
                const a = a0 + (k / n) * Math.PI * 2;
                out.push([Math.cos(a) * rr + jit(), y + jit() * 0.4, Math.sin(a) * rr + jit()]);
            }
        }
    }
    return out;
}

/* ---------- вся физика/рендер одного экземпляра держится в одном объекте
   state, чтобы не разводить десяток замыканий — методы просто читают и
   пишут его поля ---------- */
function freeze(state, i) {
    state.bodies[i].setBodyType(RAPIER.RigidBodyType.Fixed, false);
    state.frozen[i] = 1;
    state.frozenList.push(i);
}
function unfreeze(state, i, wake) {
    state.bodies[i].setBodyType(RAPIER.RigidBodyType.Dynamic, wake);
    state.frozen[i] = 0;
}

function freezePass(state) {
    const { N, frozen, released, posCache } = state;
    for (let i = 0; i < N; i++) {
        if (frozen[i] || released[i]) continue;
        const yo = posCache[i * 3 + 1];
        if (yo > Y_HOLD) continue;
        const x = posCache[i * 3], z = posCache[i * 3 + 2];
        if (x * x + z * z < HOLD_R2) freeze(state, i);
    }
}

function dropThroughNeck(state, i, burstIdx) {
    const band = burstIdx % BANDS;
    const a = Math.random() * Math.PI * 2;
    const rr = Math.random() * NECK_R * 0.4;
    if (state.frozen[i]) unfreeze(state, i, true);
    state.bodies[i].setTranslation({
        x: Math.cos(a) * rr,
        y: -(THROAT_H + GRAIN_R * 1.6 + band * GRAIN_R * 2.2),
        z: Math.sin(a) * rr,
    }, true);
    state.bodies[i].setLinvel({ x: (Math.random() - 0.5) * 1.5, y: -3, z: (Math.random() - 0.5) * 1.5 }, true);
    state.bodies[i].setAngvel({ x: 0, y: 0, z: 0 }, false);
    state.released[i] = 1;
    state.releasedCount++;
}

function wakeFeedZone(state) {
    const { N, frozen, released, posCache } = state;
    for (let i = 0; i < N; i++) {
        if (frozen[i] || released[i]) continue;
        const yo = posCache[i * 3 + 1];
        if (yo < 0) continue;
        const x = posCache[i * 3], z = posCache[i * 3 + 2];
        if (yo < FEED_Y || x * x + z * z < FEED_R2) state.bodies[i].wakeUp();
    }
}

// метровка: по доле p (0..1, из data-elapsed) должно быть выпущено
// round(topStart·p) зёрен — сперва из заглушки (её конец — самые нижние),
// иначе из самых нижних непущенных
function meterStep(state, p) {
    const target = Math.round(state.topStart * Math.min(1, Math.max(0, p)));
    let need = Math.min(REL_CAP, target - state.releasedCount);
    let releasedNow = 0;
    if (need <= 0) return;
    while (need > 0 && state.frozenList.length) {
        const i = state.frozenList.pop();
        if (state.released[i] || !state.frozen[i]) continue;
        dropThroughNeck(state, i, releasedNow);
        need--; releasedNow++;
    }
    if (need > 0) {
        const cands = [];
        for (let i = 0; i < state.N; i++) if (!state.released[i]) cands.push(i);
        cands.sort((a, b) => state.posCache[a * 3 + 1] - state.posCache[b * 3 + 1]);
        for (let k = 0; k < cands.length && need > 0; k++) {
            dropThroughNeck(state, cands[k], releasedNow);
            need--; releasedNow++;
        }
    }
    if (releasedNow > 0) wakeFeedZone(state);
}

const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _v = new THREE.Vector3(), _s = new THREE.Vector3(1, 1, 1);
function postStep(state, force = false) {
    const { N, frozen, bodies, posCache, slowFrames, grainMesh } = state;
    let dirty = false;
    const maxSq = V_MAX * V_MAX;
    for (let i = 0; i < N; i++) {
        const b = bodies[i];
        if (!force && (frozen[i] || b.isSleeping())) continue;
        const t = b.translation(), r = b.rotation();
        posCache[i * 3] = t.x; posCache[i * 3 + 1] = t.y; posCache[i * 3 + 2] = t.z;
        if (!frozen[i]) {
            const v = b.linvel();
            const sq = v.x * v.x + v.y * v.y + v.z * v.z;
            if (sq > maxSq) {
                const s = V_MAX / Math.sqrt(sq);
                b.setLinvel({ x: v.x * s, y: v.y * s, z: v.z * s }, true);
                slowFrames[i] = 0;
            } else if (!force && sq < SLEEP_SP2 && state.phase !== 'settling') {
                if (++slowFrames[i] >= 4) { b.sleep(); slowFrames[i] = 0; }
            } else {
                slowFrames[i] = 0;
            }
            const rxz = Math.hypot(t.x, t.z);
            if (rxz > profileR(Math.min(Math.abs(t.y), H)) + GRAIN_R * 2 || Math.abs(t.y) > H + 1.5) {
                const yc = THREE.MathUtils.clamp(t.y, -H + 1, H - 1);
                const rSafe = Math.max(0.1, profileR(Math.abs(yc)) * 0.5);
                const sc = rxz > 1e-4 ? rSafe / rxz : 0;
                b.setTranslation({ x: t.x * sc, y: yc, z: t.z * sc }, true);
                b.setLinvel({ x: 0, y: 0, z: 0 }, true);
            }
        }
        _v.set(t.x, t.y, t.z);
        _q.set(r.x, r.y, r.z, r.w);
        _m.compose(_v, _q, _s);
        grainMesh.setMatrixAt(i, _m);
        dirty = true;
    }
    if (dirty) grainMesh.instanceMatrix.needsUpdate = true;
}

function settleTick(state, gap) {
    const n = Math.max(10, Math.min(160, Math.round(gap / DT) + 4));
    for (let k = 0; k < n; k++) {
        state.world.step();
        state.settleSteps++;
        if (state.settleSteps % 7 === 0) { postStep(state); freezePass(state); }
    }
    postStep(state); freezePass(state);
    if (state.settleSteps < 180) return;
    let maxV = 0;
    for (let i = 0; i < state.N; i++) {
        if (state.frozen[i] || state.bodies[i].isSleeping()) continue;
        const v = state.bodies[i].linvel();
        maxV = Math.max(maxV, v.x * v.x + v.y * v.y + v.z * v.z);
    }
    if (maxV < 0.6 || state.settleSteps > 900) {
        state.phase = 'ready';
        state.releasedCount = 0;
        state.topStart = state.N;
        postStep(state, true);
    }
}

function loopStep(state, now) {
    state.raf = requestAnimationFrame((t) => loopStep(state, t));
    // не считаем физику, пока часы не видны (вкладка модалки скрыта, модалка
    // закрыта, окно свёрнуто) — экономим чужой CPU-бюджет; meterStep()
    // догонит цель за счёт REL_CAP при возврате
    if (document.hidden || !state.canvas.offsetParent) { state.lastT = 0; return; }

    const gap = state.lastT ? (now - state.lastT) / 1000 : 0.016;
    const dtReal = Math.min(0.05, gap);
    state.lastT = now;
    state.fps = state.fps * 0.95 + (1 / Math.max(1e-3, dtReal)) * 0.05;

    if (state.phase === 'settling') {
        settleTick(state, gap);
    } else if (state.phase === 'ready') {
        state.acc += dtReal;
        let steps = 0;
        while (state.acc >= DT && steps < MAX_STEPS) { state.world.step(); state.acc -= DT; steps++; }
        if (state.acc > DT) state.acc = 0;
        postStep(state);
        freezePass(state);
        const p = parseFloat(state.container.dataset.elapsed || '0') || 0;
        meterStep(state, p);
    }

    if (state.phase === 'ready' && state.fps < 42) state.lowFpsMs += dtReal * 1000; else state.lowFpsMs = 0;
    if (state.lowFpsMs > 4000 && !state.degraded) {
        state.degraded = true;
        state.glassMesh.material = cheapGlassMat;
        state.renderer.setPixelRatio(1);
    }

    state.controls.update();
    state.renderer.render(state.scene, state.camera);
}

function buildThreeScene(canvas, w, h) {
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.setSize(w, h, false);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;

    const scene = new THREE.Scene();
    scene.background = null;
    scene.environment = envTexture(renderer);

    const camera = new THREE.PerspectiveCamera(38, w / h, 0.5, 300);
    camera.position.set(9, 5, 54);
    camera.lookAt(0, 0, 0);

    // вращение зажатой мышью/тачем — как в оригинале, но без зума/пана (см.
    // комментарий в шапке файла): виджет мал, эти два режима только мешают
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.set(0, 0, 0);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.autoRotate = false;
    controls.enableZoom = false;
    controls.enablePan = false;
    controls.update();

    scene.add(new THREE.HemisphereLight(0x8899bb, 0x21160a, 0.55));
    const key = new THREE.DirectionalLight(0xfff2dd, 2.6);
    key.position.set(24, 40, 30);
    scene.add(key);
    const rim = new THREE.PointLight(0xd9a95c, 1400, 0, 2);
    rim.position.set(-18, 14, -18);
    scene.add(rim);

    const glassMesh = new THREE.Mesh(glassGeo, glassMat);
    scene.add(glassMesh);

    for (const s of [-1, 1]) {
        const cap = new THREE.Mesh(capGeo, woodMat);
        cap.position.y = s * (H + 0.75);
        scene.add(cap);
        const lip = new THREE.Mesh(lipGeo, woodDark);
        lip.rotation.x = Math.PI / 2;
        lip.position.y = s * (H + 1.55);
        scene.add(lip);
    }

    const grainMesh = new THREE.InstancedMesh(grainGeo, grainMat, GRAINS_N);
    grainMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    grainMesh.frustumCulled = false;
    {
        const palette = [0xe8c074, 0xdca85a, 0xf0d089, 0xcf9a4c, 0xe3b366, 0xf5dca0];
        const c = new THREE.Color(), hsl = {};
        for (let i = 0; i < GRAINS_N; i++) {
            c.setHex(palette[(Math.random() * palette.length) | 0]);
            c.getHSL(hsl);
            c.setHSL(hsl.h, hsl.s + (Math.random() - 0.5) * 0.05, hsl.l + (Math.random() - 0.5) * 0.09);
            grainMesh.setColorAt(i, c);
        }
        grainMesh.instanceColor.needsUpdate = true;
    }
    scene.add(grainMesh);

    return { renderer, scene, camera, controls, glassMesh, grainMesh };
}

function buildSand(world, grainMesh) {
    const pts = seedPositions(GRAINS_N);
    const N = pts.length;
    const bodies = [];
    const posCache = new Float32Array(GRAINS_N * 3);
    for (let i = 0; i < N; i++) {
        const [x, y, z] = pts[i];
        const body = world.createRigidBody(
            RAPIER.RigidBodyDesc.dynamic().setTranslation(x, y, z)
                .setLinearDamping(0.3).setAngularDamping(0.8)
                .setSoftCcdPrediction(GRAIN_R * 4),
        );
        world.createCollider(
            RAPIER.ColliderDesc.ball(GRAIN_R).setFriction(0.55).setRestitution(0).setDensity(1.4),
            body,
        );
        bodies.push(body);
        posCache[i * 3] = x; posCache[i * 3 + 1] = y; posCache[i * 3 + 2] = z;
    }
    grainMesh.count = N;
    return { N, bodies, posCache };
}

async function boot(container, canvas) {
    const w = canvas.width || 96;
    const h = canvas.height || 96;
    const three = buildThreeScene(canvas, w, h);

    const state = {
        container, canvas,
        ...three,
        phase: 'boot',
        world: null,
        N: 0, bodies: [], posCache: null,
        frozen: new Uint8Array(GRAINS_N),
        released: new Uint8Array(GRAINS_N),
        slowFrames: new Uint8Array(GRAINS_N),
        frozenList: [],
        releasedCount: 0, topStart: 0,
        settleSteps: 0, acc: 0, lastT: 0, fps: 60,
        lowFpsMs: 0, degraded: false,
        raf: 0,
    };

    try {
        await RAPIER.init();
        const world = new RAPIER.World({ x: 0, y: -G, z: 0 });
        world.timestep = DT;
        buildStaticColliders(world);
        const sand = buildSand(world, state.grainMesh);
        state.world = world;
        Object.assign(state, sand);
        postStep(state, true);
        state.phase = 'settling';
        views.set(canvas, state);
        state.raf = requestAnimationFrame((t) => loopStep(state, t));
    } catch (err) {
        // тихий фолбэк: пустая прозрачная сцена вместо часов — счётчик рядом
        // всё равно работает, поломка здесь не должна гасить вкладку Settings
        console.warn('[settings-sandglass] физика не завелась:', err);
    }
}

const views = new Map(); // canvas -> state, для unmount

function mount(container) {
    const canvas = container.querySelector(CANVAS_SELECTOR);
    if (!canvas || canvas.dataset.mounted) return;
    canvas.dataset.mounted = '1';
    boot(container, canvas);
}

function unmount(canvas) {
    const state = views.get(canvas);
    if (!state) return;
    views.delete(canvas);
    cancelAnimationFrame(state.raf);
    state.controls.dispose();
    state.renderer.dispose();
    state.world?.free();
}

function scanAdded(root) {
    if (root.nodeType !== 1) return;
    if (root.matches(ROOT_SELECTOR)) mount(root);
    for (const node of root.querySelectorAll(ROOT_SELECTOR)) mount(node);
}

function scanRemoved(root) {
    if (root.nodeType !== 1) return;
    if (root.matches(CANVAS_SELECTOR)) unmount(root);
    for (const canvas of root.querySelectorAll(CANVAS_SELECTOR)) unmount(canvas);
}

// .sandglass уже мог появиться до загрузки этого модуля — подхватываем и его
scanAdded(document.body);
new MutationObserver((records) => {
    for (const r of records) {
        for (const n of r.addedNodes) scanAdded(n);
        for (const n of r.removedNodes) scanRemoved(n);
    }
}).observe(document.body, { childList: true, subtree: true });
