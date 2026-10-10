// Сборка Three.js сцены для песочных часов.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { glassGeo, glassMat, cheapGlassMat, woodMat, woodDark, capGeo, lipGeo, grainGeo, grainMat, envTexture, GRAINS_N } from './settings-sandglass-geometry.js';

export function buildThreeScene(canvas, w, h) {
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
        cap.position.y = s * (15.5 + 0.75);
        scene.add(cap);
        const lip = new THREE.Mesh(lipGeo, woodDark);
        lip.rotation.x = Math.PI / 2;
        lip.position.y = s * (15.5 + 1.55);
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