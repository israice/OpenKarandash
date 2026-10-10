// Геометрия и материалы песочных часов (Three.js).
import * as THREE from 'three';
import {
    H, BULB_R, NECK_R, CAP_R, WAIST_Y, GRAINS_N,
} from './settings-sandglass-constants.js';

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
        const y = 0.6 + ((yTop - 0.6) * (i + 0.5)) / steps;
        const r = profileR(y);
        v += Math.PI * r * r * ((yTop - 0.6) / steps);
    }
    const perGrain = (v * 0.62) / count;
    const r = Math.cbrt(perGrain / ((4 / 3) * Math.PI));
    return Math.max(0.3, Math.min(0.62, r));
}
export const GRAIN_R = grainRadiusFor(GRAINS_N);

const lathePts = [new THREE.Vector2(0.15, -H)];
for (let i = 0; i <= 72; i++) {
    const y = -H + (2 * H * i) / 72;
    lathePts.push(new THREE.Vector2(profileR(Math.abs(y)) + 0.12, y));
}
lathePts.push(new THREE.Vector2(0.15, H));
export const glassGeo = new THREE.LatheGeometry(lathePts, 56);
export const glassMat = new THREE.MeshPhysicalMaterial({
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
export const cheapGlassMat = new THREE.MeshPhysicalMaterial({
    transparent: true, opacity: 0.16, roughness: 0.08, metalness: 0,
    depthWrite: false, envMapIntensity: 1.1,
});

export const woodMat = new THREE.MeshStandardMaterial({ color: 0x5c3a22, roughness: 0.62, metalness: 0.05 });
export const woodDark = new THREE.MeshStandardMaterial({ color: 0x472c18, roughness: 0.7, metalness: 0.05 });
export const capGeo = new THREE.CylinderGeometry(BULB_R + 2.2, BULB_R + 2.2, 1.5, 40);
export const lipGeo = new THREE.TorusGeometry(BULB_R + 2.2, 0.28, 10, 48);

export const grainGeo = new THREE.IcosahedronGeometry(GRAIN_R, 0);
export const grainMat = new THREE.MeshStandardMaterial({ roughness: 0.95, metalness: 0, flatShading: true, envMapIntensity: 0.45 });

let sharedEnvTexture = null;
export function envTexture(renderer) {
    if (sharedEnvTexture) return sharedEnvTexture;
    const pmrem = new THREE.PMREMGenerator(renderer);
    const envScene = new THREE.RoomEnvironment();
    sharedEnvTexture = pmrem.fromScene(envScene, 0.04).texture;
    pmrem.dispose();
    envScene.dispose();
    return sharedEnvTexture;
}

export { profileR, grainRadiusFor };