/**
 * M1-f 浏览器自检：Rapier 写玩法 Transform，渲染桥只读投影到 Three.js。
 * 编辑器外壳与 gizmo 属于 M1-h；这里验证的是同一底层通道。
 */
import * as THREE from 'three';
import { createWorld } from './core/ecs.js';
import { createGridSpatialIndex } from './core/spatial-index.js';
import { Transform } from './core/transform.js';
import { createRenderBridge } from './render/bridge.js';
import { initPhysics, World as PhysicsWorld, TICK_DT } from './sim/world.js';

const hud = document.getElementById('hud');
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x15171b);
scene.add(new THREE.HemisphereLight(0xdce8ff, 0x25282d, 2.3));
const sun = new THREE.DirectionalLight(0xffffff, 1.8);
sun.position.set(7, 12, 6);
scene.add(sun);

const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.1, 200);
camera.position.set(10, 8, 12);
camera.lookAt(0, 1.5, 0);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
document.body.appendChild(renderer.domElement);

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

const rapier = await initPhysics();
const physics = new PhysicsWorld(rapier);
physics.addGround();
const world = createWorld();
const entities = [];
const palette = [0x6ea8fe, 0x69c28b, 0xe5b95c, 0xd98291];
const boxGeometry = new THREE.BoxGeometry(1, 1, 1);
const spatialIndex = createGridSpatialIndex({ cellSize: 2 });

for (let x = 0; x < 4; x++) {
  for (let z = 0; z < 4; z++) {
    const px = x * 1.08 - 1.62;
    const py = 4 + z * 0.32;
    const pz = z * 1.08 - 1.62;
    physics.addBox(px, py, pz);
    entities.push(world.spawn(Transform({ x: px, y: py, z: pz })));
  }
}

const bridge = createRenderBridge({
  world,
  scene,
  spatialIndex,
  createObject: (entity) => {
    const material = new THREE.MeshStandardMaterial({
      color: palette[(entity.id - 1) % palette.length],
      roughness: 0.55,
      metalness: 0.05,
    });
    const mesh = new THREE.Mesh(boxGeometry, material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    return mesh;
  },
  disposeObject: (object) => object.material?.dispose(),
  boundsForEntity: () => ({
    min: { x: -0.5, y: -0.5, z: -0.5 },
    max: { x: 0.5, y: 0.5, z: 0.5 },
  }),
});
bridge.sync();

const ground = new THREE.Mesh(
  new THREE.BoxGeometry(40, 1, 40),
  new THREE.MeshStandardMaterial({ color: 0x34383f, roughness: 0.95 })
);
ground.position.y = -0.5;
ground.receiveShadow = true;
scene.add(ground);

let selectedEntity = null;
const raycaster = new THREE.Raycaster();
renderer.domElement.addEventListener('pointerdown', (event) => {
  const rect = renderer.domElement.getBoundingClientRect();
  const pointer = new THREE.Vector2(
    ((event.clientX - rect.left) / rect.width) * 2 - 1,
    -((event.clientY - rect.top) / rect.height) * 2 + 1
  );
  raycaster.setFromCamera(pointer, camera);
  const hit = bridge.pick(raycaster.ray.origin, raycaster.ray.direction, { maxDistance: 200 });
  if (selectedEntity) bridge.getObject(selectedEntity)?.material.emissive.setHex(0x000000);
  selectedEntity = hit?.entity ?? null;
  if (selectedEntity) bridge.getObject(selectedEntity).material.emissive.setHex(0x26364d);
});

let accumulator = 0;
let last = performance.now() / 1000;
let events = 0;

function frame() {
  const now = performance.now() / 1000;
  accumulator += Math.min(now - last, 0.25);
  last = now;

  while (accumulator >= TICK_DT) {
    events += physics.step().length;
    for (let index = 0; index < entities.length; index++) {
      const body = physics.bodies[index];
      const position = body.translation();
      const rotation = body.rotation();
      entities[index].set(Transform, {
        x: position.x,
        y: position.y,
        z: position.z,
        qx: rotation.x,
        qy: rotation.y,
        qz: rotation.z,
        qw: rotation.w,
      });
    }
    accumulator -= TICK_DT;
  }

  bridge.sync();
  renderer.render(scene, camera);
  hud.textContent =
    `Clay · M1-f ECS 渲染桥\n` +
    `实体    ${entities.length}\n` +
    `投影    ${spatialIndex.size}\n` +
    `选中    ${selectedEntity?.id ?? '-'}\n` +
    `tick    ${physics.tick}\n` +
    `事件    ${events}`;
  requestAnimationFrame(frame);
}
frame();

addEventListener('beforeunload', () => {
  bridge.destroy();
  world.destroy();
  physics.free();
});
