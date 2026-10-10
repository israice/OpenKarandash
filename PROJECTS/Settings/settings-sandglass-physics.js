// Физика песочных часов (Rapier): статичные коллайдеры, посев зёрен, симуляция.
import * as THREE from 'three';
import * as RAPIER_NS from '@dimforge/rapier3d-simd-compat';
import {
    H, THROAT_H, NECK_R, CAP_R, GRAIN_R, GRAINS_N, BANDS,
    WBANDS, SEGS, WALL_T,
    Y_HOLD_MULT, HOLD_R_MULT, FEED_Y_MULT, FEED_R_MULT,
    DT, V_MAX, SLEEP_SP2, REL_CAP,
} from './settings-sandglass-constants.js';
import { profileR } from './settings-sandglass-geometry.js';

const RAPIER = RAPIER_NS.default ?? RAPIER_NS;

export const Y_HOLD = THROAT_H + GRAIN_R * Y_HOLD_MULT;
export const HOLD_R2 = (NECK_R * HOLD_R_MULT) ** 2;
export const FEED_Y = THROAT_H + GRAIN_R * FEED_Y_MULT;
export const FEED_R2 = (NECK_R * FEED_R_MULT) ** 2;

export function buildStaticColliders(world) {
    const fixed = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
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

export function seedPositions(count) {
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

export function freeze(state, i) {
    state.bodies[i].setBodyType(RAPIER.RigidBodyType.Fixed, false);
    state.frozen[i] = 1;
    state.frozenList.push(i);
}
export function unfreeze(state, i, wake) {
    state.bodies[i].setBodyType(RAPIER.RigidBodyType.Dynamic, wake);
    state.frozen[i] = 0;
}

export function freezePass(state) {
    const { N, frozen, released, posCache } = state;
    for (let i = 0; i < N; i++) {
        if (frozen[i] || released[i]) continue;
        const yo = posCache[i * 3 + 1];
        if (yo > Y_HOLD) continue;
        const x = posCache[i * 3], z = posCache[i * 3 + 2];
        if (x * x + z * z < HOLD_R2) freeze(state, i);
    }
}

export function dropThroughNeck(state, i, burstIdx) {
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

export function wakeFeedZone(state) {
    const { N, frozen, released, posCache } = state;
    for (let i = 0; i < N; i++) {
        if (frozen[i] || released[i]) continue;
        const yo = posCache[i * 3 + 1];
        if (yo < 0) continue;
        const x = posCache[i * 3], z = posCache[i * 3 + 2];
        if (yo < FEED_Y || x * x + z * z < FEED_R2) state.bodies[i].wakeUp();
    }
}

export function meterStep(state, p) {
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
export function postStep(state, force = false) {
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

export function settleTick(state, gap) {
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

export function buildSand(world, grainMesh) {
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