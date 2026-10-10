// Анимационный цикл песочных часов.
import {
    DT, MAX_STEPS,
} from './settings-sandglass-constants.js';
import { postStep, freezePass, settleTick, meterStep } from './settings-sandglass-physics.js';
import { cheapGlassMat } from './settings-sandglass-geometry.js';

export function loopStep(state, now) {
    state.raf = requestAnimationFrame((t) => loopStep(state, t));
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