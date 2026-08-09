/**
 * 浏览器入口 —— M0-b 的验收面：three 与 Rapier 都从 npm 加载，不再走 CDN importmap。
 * 渲染桥在这里是最薄的一层：读玩法状态，写 three 对象。**呈现只读消费**（goals.md §4.5）。
 */
import * as THREE from 'three';
import { initPhysics, World, TICK_DT } from './sim/world.js';

const hud = document.getElementById('hud');

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x14161a);
scene.add(new THREE.HemisphereLight(0xbfd4ff, 0x20242c, 2.2));
const sun = new THREE.DirectionalLight(0xffffff, 1.6);
sun.position.set(6, 12, 8);
scene.add(sun);

const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.1, 200);
camera.position.set(9, 7, 11);
camera.lookAt(0, 1, 0);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
document.body.appendChild(renderer.domElement);

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

const rapier = await initPhysics();
const world = new World(rapier);
world.addGround();

const boxGeo = new THREE.BoxGeometry(1, 1, 1);
const boxMat = new THREE.MeshStandardMaterial({ color: 0x7aa2f7, roughness: 0.6 });
const meshes = [];
for (let i = 0; i < 4; i++) {
  for (let j = 0; j < 4; j++) {
    world.addBox(i * 1.05 - 1.6, 4 + j * 0.3, j * 1.05 - 1.6);
    const m = new THREE.Mesh(boxGeo, boxMat);
    scene.add(m);
    meshes.push(m);
  }
}

const ground = new THREE.Mesh(
  new THREE.BoxGeometry(40, 1, 40),
  new THREE.MeshStandardMaterial({ color: 0x2a2f3a, roughness: 0.95 })
);
ground.position.y = -0.5;
scene.add(ground);

// 玩法跑在固定步长上，呈现跑在帧上，两者分离（goals.md §4.5）。
let acc = 0, last = performance.now() / 1000, events = 0;

function frame() {
  const now = performance.now() / 1000;
  acc += Math.min(now - last, 0.25);
  last = now;

  while (acc >= TICK_DT) {
    events += world.step().length;
    acc -= TICK_DT;
  }

  for (let i = 0; i < meshes.length; i++) {
    const t = world.bodies[i].translation(), r = world.bodies[i].rotation();
    meshes[i].position.set(t.x, t.y, t.z);
    meshes[i].quaternion.set(r.x, r.y, r.z, r.w);
  }

  renderer.render(scene, camera);
  hud.textContent =
    `Clay · 工具链自检\n` +
    `three   ${THREE.REVISION}\n` +
    `rapier  ${world.bodies.length} 刚体\n` +
    `tick    ${world.tick}\n` +
    `事件    ${events}`;
  requestAnimationFrame(frame);
}
frame();
