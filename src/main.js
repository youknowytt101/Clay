/**
 * M1-h/i editor vertical slice: ECS editing plus one provider-neutral AI Action preview.
 * Every persistent edit goes through the same Action transaction channel used by AI.
 */
import * as THREE from 'three';
import './editor/editor.css';
import { createSingleStepAssistant } from './ai/single-step.js';
import { createActionEngine, createActionRegistry } from './core/actions.js';
import { createChunkPolicy } from './core/chunks.js';
import { createWorld } from './core/ecs.js';
import { PHYSICS_RUNTIME_REQUIREMENT } from './core/runtime-versions.js';
import { createRuntimeRegistry } from './core/serialization.js';
import { createGridSpatialIndex } from './core/spatial-index.js';
import { Transform } from './core/transform.js';
import { EditorTag, Name } from './editor/components.js';
import { createEditorPatchAction, createEditorSession, EDITOR_PATCH_ACTION } from './editor/session.js';
import { authorizeEditorSingleStep, interpretEditorSingleStep } from './editor/single-step-command.js';
import { createEditorWorkbench } from './editor/workbench.js';
import { createRenderBridge } from './render/bridge.js';
import { createChunkStreamer, createTransformChunkResolver } from './render/chunk-streamer.js';

const viewport = document.getElementById('viewport');
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x171a1e);
scene.fog = new THREE.Fog(0x171a1e, 30, 75);

const camera = new THREE.PerspectiveCamera(48, 1, 0.1, 250);
camera.position.set(12, 9, 14);
camera.lookAt(0, 1.5, 0);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
viewport.append(renderer.domElement);

// 占位值，不是实测结论。U-024 的取值要等 M2-3 的 RTS 骨架给出真实负载后，
// 按「确定性 + 内存 + 卡顿」三项基准定。M1-g 交付的是机制（可配 + S1–S3 有测试），不是这两个数。
const streamingPolicy = Object.freeze({ chunkSize: 16, loadRadius: 1 });
const chunkPolicy = createChunkPolicy({ size: streamingPolicy.chunkSize });
const chunkForEntity = createTransformChunkResolver(chunkPolicy);

scene.add(new THREE.HemisphereLight(0xd7e5f1, 0x33373b, 2.1));
const sun = new THREE.DirectionalLight(0xfff3dc, 2.5);
sun.position.set(12, 18, 10);
sun.castShadow = true;
sun.shadow.mapSize.set(1024, 1024);
sun.shadow.camera.left = -18;
sun.shadow.camera.right = 18;
sun.shadow.camera.top = 18;
sun.shadow.camera.bottom = -18;
scene.add(sun);

const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(80, 80),
  new THREE.MeshStandardMaterial({ color: 0x30363a, roughness: 0.94, metalness: 0.02 })
);
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);
scene.add(new THREE.GridHelper(80, 80, 0x566167, 0x3c4449));

const world = createWorld();
world.spawn(
  Name({ value: '中央平台' }),
  EditorTag({ category: 'structure' }),
  Transform({ x: 0, y: 0.35, z: 0, sx: 5.5, sy: 0.7, sz: 5.5 })
);
const tower = world.spawn(
  Name({ value: '信标塔' }),
  EditorTag({ category: 'structure' }),
  Transform({ x: 0, y: 2.45, z: 0, sx: 1.2, sy: 3.5, sz: 1.2 })
);
world.spawn(Name({ value: '塔顶标记' }), EditorTag({ category: 'marker' }), Transform({ y: 0.72, sx: 1.5, sy: 0.22, sz: 1.5, parent: tower }));

const positions = [
  [-4.2, 0.55, -3.5], [-1.8, 0.55, -4.2], [2.2, 0.55, -4.1], [4.3, 0.55, -2.5],
  [-4.4, 0.55, 1.2], [-2.9, 0.55, 3.8], [2.7, 0.55, 3.7], [4.4, 0.55, 1.5],
];
for (const [index, position] of positions.entries()) {
  world.spawn(
    Name({ value: `场景物体 ${String(index + 1).padStart(2, '0')}` }),
    EditorTag({ category: 'prop' }),
    Transform({ x: position[0], y: position[1], z: position[2] })
  );
}

const registry = createActionRegistry().register(createEditorPatchAction());
const runtimeRegistry = createRuntimeRegistry().register(
  PHYSICS_RUNTIME_REQUIREMENT.id,
  PHYSICS_RUNTIME_REQUIREMENT.version,
  { name: 'rapier-adapter-placeholder' }
);
const engine = await createActionEngine({
  registry,
  world,
  runtimes: [PHYSICS_RUNTIME_REQUIREMENT],
  runtimeRegistry,
  chunkForEntity,
});

const geometry = new THREE.BoxGeometry(1, 1, 1);
const palette = Object.freeze({ structure: 0x698997, prop: 0x9c8c69, marker: 0xa96661 });
const spatialIndex = createGridSpatialIndex({ cellSize: 3 });
const bridge = createRenderBridge({
  world: engine.world,
  scene,
  spatialIndex,
  createObject: (entity) => {
    const category = entity.has(EditorTag) ? entity.get(EditorTag).category : 'prop';
    const mesh = new THREE.Mesh(
      geometry,
      new THREE.MeshStandardMaterial({ color: palette[category], roughness: 0.62, metalness: 0.08 })
    );
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    return mesh;
  },
  disposeObject: (object) => object.material?.dispose(),
  boundsForEntity: () => ({ min: { x: -0.5, y: -0.5, z: -0.5 }, max: { x: 0.5, y: 0.5, z: 0.5 } }),
});
const streamer = createChunkStreamer({ bridge, policy: chunkPolicy });
streamer.transitionAround({ x: 0, y: 0, z: 0 }, { radius: streamingPolicy.loadRadius });

const session = createEditorSession({ engine, bridge });
function syncAppearance() {
  for (const entity of engine.world.query(EditorTag, Transform)) {
    const material = bridge.getObject(entity)?.material;
    if (material) material.color.setHex(palette[entity.get(EditorTag).category]);
  }
}
session.subscribe(syncAppearance);
const assistant = createSingleStepAssistant({
  engine,
  registry,
  allowedActions: [EDITOR_PATCH_ACTION],
  interpret: interpretEditorSingleStep,
  authorize: (input) => authorizeEditorSingleStep({ ...input, world: engine.world }),
});
const workbench = createEditorWorkbench({
  session,
  bridge,
  scene,
  camera,
  renderer,
  viewport,
  outlineMount: document.getElementById('outline'),
  inspectorMount: document.getElementById('inspector'),
  selectionRect: document.getElementById('selection-rect'),
  statusMount: document.getElementById('editor-status'),
  undoButton: document.getElementById('undo'),
  modeButtons: [...document.querySelectorAll('.mode-button')],
});

const chunkStatus = document.getElementById('chunk-status');
let activeChunkSignature = '';
function syncStreaming() {
  const desired = chunkPolicy.idsAroundPoint(workbench.controls.target, { radius: streamingPolicy.loadRadius });
  const signature = desired.join('|');
  if (signature === activeChunkSignature) return;
  const receipt = streamer.transition(desired);
  activeChunkSignature = signature;
  chunkStatus.textContent = `${receipt.afterChunks.length} 块`;
}
workbench.controls.addEventListener('change', syncStreaming);
syncStreaming();

const aiForm = document.getElementById('ai-command-form');
const aiInput = document.getElementById('ai-instruction');
const aiSubmit = document.getElementById('ai-preview');
const aiPanel = document.getElementById('ai-preview-panel');
const aiInstruction = document.getElementById('ai-preview-instruction');
const aiMeta = document.getElementById('ai-preview-meta');
const aiDiff = document.getElementById('ai-preview-diff');
const aiConfirm = document.getElementById('ai-confirm');
const aiAbort = document.getElementById('ai-abort');
let aiSequence = 0;
let activeProposal = null;

function concise(value) {
  if (value === null) return '无';
  if (typeof value === 'string') return `“${value}”`;
  return JSON.stringify(value);
}

function diffLabel(change) {
  const parts = change.path.split('/');
  const entity = parts[2] ? `#${parts[2]}` : '工程';
  const field = parts.at(-1);
  return `${entity} · ${field}: ${concise(change.before)} → ${concise(change.after)}`;
}

function setAiControls({ busy = false, pending = false } = {}) {
  aiInput.disabled = busy || pending;
  aiSubmit.disabled = busy || pending;
  aiConfirm.disabled = busy || !pending;
  aiAbort.disabled = busy || !pending;
}

function showProposal(proposal) {
  const actionReceipt = proposal.receipt.actions[0];
  aiPanel.hidden = false;
  aiPanel.dataset.phase = proposal.phase;
  aiInstruction.textContent = proposal.instruction;
  aiMeta.textContent = `1 个 Action · ${actionReceipt.diff.length} 项变更 · ${proposal.phase === 'committed' ? '已提交' : '待确认'}`;
  aiDiff.replaceChildren(...actionReceipt.diff.slice(0, 8).map((change) => {
    const item = document.createElement('li');
    item.textContent = diffLabel(change);
    return item;
  }));
}

function showAiError(error) {
  const status = document.getElementById('editor-status');
  status.dataset.tone = 'error';
  status.textContent = error.message;
}

aiForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const instruction = aiInput.value.trim();
  if (!instruction) return;
  setAiControls({ busy: true });
  try {
    activeProposal = await assistant.propose({
      requestId: `editor-ai-${++aiSequence}`,
      instruction,
      context: { selection: session.selection },
    });
    if (activeProposal.phase !== 'awaiting-confirmation') {
      throw new Error(activeProposal.receipt.failure?.message ?? '无法生成候选变更');
    }
    showProposal(activeProposal);
    setAiControls({ pending: true });
  } catch (error) {
    activeProposal = null;
    showAiError(error);
    setAiControls();
  }
});

aiConfirm.addEventListener('click', async () => {
  if (!activeProposal) return;
  setAiControls({ busy: true });
  try {
    await assistant.confirm(activeProposal);
    bridge.setWorld(engine.world);
    bridge.sync();
    session.setSelection(session.selection);
    syncAppearance();
    showProposal(activeProposal);
    aiInput.value = '';
    activeProposal = null;
    setAiControls();
    aiInput.focus();
  } catch (error) {
    showAiError(error);
    setAiControls({ pending: true });
  }
});

aiAbort.addEventListener('click', async () => {
  if (!activeProposal) return;
  setAiControls({ busy: true });
  try {
    await assistant.abort(activeProposal);
    activeProposal = null;
    aiPanel.hidden = true;
    setAiControls();
    aiInput.focus();
  } catch (error) {
    showAiError(error);
    setAiControls({ pending: true });
  }
});

document.getElementById('entity-count').textContent = `${engine.world.query().length} 项`;
document.getElementById('outline-search').addEventListener('input', (event) => {
  const query = event.currentTarget.value.trim().toLocaleLowerCase('zh-CN');
  for (const row of document.querySelectorAll('.entity-row')) {
    row.hidden = query !== '' && !row.textContent.toLocaleLowerCase('zh-CN').includes(query);
  }
});

let animationFrame;
function frame() {
  workbench.update();
  renderer.render(scene, camera);
  animationFrame = requestAnimationFrame(frame);
}
frame();

addEventListener('beforeunload', () => {
  cancelAnimationFrame(animationFrame);
  workbench.controls.removeEventListener('change', syncStreaming);
  workbench.destroy();
  bridge.destroy();
  engine.destroy();
  geometry.dispose();
  ground.geometry.dispose();
  ground.material.dispose();
  renderer.dispose();
});
