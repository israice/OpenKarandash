// Точка входа песочных часов: инициализация, монтирование, MutationObserver.
import * as RAPIER_NS from '@dimforge/rapier3d-simd-compat';
import { ROOT_SELECTOR, CANVAS_SELECTOR } from './settings-sandglass-constants.js';
import { buildThreeScene } from './settings-sandglass-three.js';
import { buildStaticColliders, buildSand } from './settings-sandglass-physics.js';
import { loopStep } from './settings-sandglass-loop.js';

const RAPIER = RAPIER_NS.default ?? RAPIER_NS;

const views = new Map();

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
        frozen: new Uint8Array(2000),
        released: new Uint8Array(2000),
        slowFrames: new Uint8Array(2000),
        frozenList: [],
        releasedCount: 0, topStart: 0,
        settleSteps: 0, acc: 0, lastT: 0, fps: 60,
        lowFpsMs: 0, degraded: false,
        raf: 0,
    };

    try {
        await RAPIER.init();
        const world = new RAPIER.World({ x: 0, y: -75, z: 0 });
        world.timestep = 1 / 120;
        buildStaticColliders(world);
        const sand = buildSand(world, state.grainMesh);
        state.world = world;
        Object.assign(state, sand);
        const { postStep } = await import('./settings-sandglass-physics.js');
        postStep(state, true);
        state.phase = 'settling';
        views.set(canvas, state);
        state.raf = requestAnimationFrame((t) => loopStep(state, t));
    } catch (err) {
        console.warn('[settings-sandglass] физика не завелась:', err);
    }
}

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

scanAdded(document.body);
new MutationObserver((records) => {
    for (const r of records) {
        for (const n of r.addedNodes) scanAdded(n);
        for (const n of r.removedNodes) scanRemoved(n);
    }
}).observe(document.body, { childList: true, subtree: true });

export { mount, unmount, boot };