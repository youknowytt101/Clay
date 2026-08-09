import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { Transform } from '../core/transform.js';
import { EditorTag, Name } from './components.js';
import { transformPatchesFromWorldDelta } from './session.js';

const FIELD_LABELS = Object.freeze({
  x: '位置 X', y: '位置 Y', z: '位置 Z',
  qx: '旋转 X', qy: '旋转 Y', qz: '旋转 Z', qw: '旋转 W',
  sx: '缩放 X', sy: '缩放 Y', sz: '缩放 Z',
  parent: '父实体', value: '名称', category: '分类', locked: '锁定',
});

const COMPONENT_LABELS = Object.freeze({
  'core.name': '基本信息',
  'core.transform': '变换',
  'editor.tag': '编辑器',
});

function entityById(world, id) {
  return world.query().map((entity) => entity).find((entity) => entity.id === id) ?? null;
}

function entityName(entity) {
  return entity?.has(Name) ? entity.get(Name).value : `实体 ${entity?.id ?? '-'}`;
}

function setButtonPressed(buttons, value) {
  for (const button of buttons) button.setAttribute('aria-pressed', String(button.dataset.mode === value));
}

function numericStep(schema) {
  return schema.unit === 'm' ? '0.1' : '0.01';
}

export function createEditorWorkbench({
  session,
  bridge,
  scene,
  camera,
  renderer,
  viewport,
  outlineMount,
  inspectorMount,
  selectionRect,
  statusMount,
  undoButton,
  modeButtons,
} = {}) {
  if (!session || !bridge || !scene || !camera || !renderer) throw new TypeError('editor workbench dependencies are required');

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.screenSpacePanning = true;
  controls.minDistance = 3;
  controls.maxDistance = 80;
  controls.maxPolarAngle = Math.PI * 0.49;

  const gizmo = new TransformControls(camera, renderer.domElement);
  const gizmoHelper = gizmo.getHelper();
  scene.add(gizmoHelper);
  gizmo.setSize(0.82);
  let gizmoMode = 'translate';
  gizmo.setMode(gizmoMode);

  const pivot = new THREE.Object3D();
  pivot.name = 'Clay selection pivot';
  scene.add(pivot);
  let draggingGizmo = false;
  let gizmoStart = null;
  let outlineRows = [];
  let rangeAnchor = null;
  let marquee = null;
  let feedbackTimer = null;

  function setFeedback(message, tone = 'neutral') {
    statusMount.textContent = message;
    statusMount.dataset.tone = tone;
    clearTimeout(feedbackTimer);
    feedbackTimer = setTimeout(() => updateStatus(), 2200);
  }

  function updateStatus() {
    const selected = session.selection.length;
    statusMount.dataset.tone = 'neutral';
    statusMount.textContent = selected
      ? `${selected} 个实体 · ${session.revision.slice(0, 14)}`
      : `未选择 · ${session.revision.slice(0, 14)}`;
    undoButton.disabled = !session.canUndo;
  }

  function selectedEntities() {
    return session.selection.map((id) => entityById(session.world, id)).filter(Boolean);
  }

  function updateHighlights() {
    const ids = new Set(session.selection);
    for (const entity of session.world.query(Transform)) {
      const object = bridge.getObject(entity);
      if (!object) continue;
      object.traverse((child) => {
        if (!child.material?.emissive) return;
        child.material.emissive.setHex(ids.has(entity.id) ? 0x243f54 : 0x000000);
        child.material.emissiveIntensity = ids.has(entity.id) ? 0.85 : 1;
      });
    }
  }

  function updateGizmo() {
    if (draggingGizmo) return;
    const entities = selectedEntities().filter((entity) => entity.has(Transform));
    const movable = entities.filter((entity) =>
      bridge.getObject(entity) && (!entity.has(EditorTag) || !entity.get(EditorTag).locked)
    );
    if (movable.length === 0) {
      gizmo.detach();
      gizmoHelper.visible = false;
      return;
    }
    const center = new THREE.Vector3();
    for (const entity of movable) {
      const object = bridge.getObject(entity);
      if (object) center.add(new THREE.Vector3().setFromMatrixPosition(object.matrix));
    }
    center.multiplyScalar(1 / movable.length);
    pivot.position.copy(center);
    pivot.quaternion.identity();
    pivot.scale.set(1, 1, 1);
    pivot.updateMatrix();
    pivot.updateMatrixWorld(true);
    gizmo.attach(pivot);
    gizmoHelper.visible = true;
  }

  function renderOutline() {
    outlineMount.replaceChildren();
    const world = session.world;
    const entities = world.query().map((entity) => entity);
    const children = new Map([[null, []]]);
    for (const entity of entities) {
      const parent = entity.has(Transform) ? entity.get(Transform).parent : null;
      const key = parent?.alive ? parent.id : null;
      if (!children.has(key)) children.set(key, []);
      children.get(key).push(entity);
    }
    for (const list of children.values()) list.sort((a, b) => entityName(a).localeCompare(entityName(b), 'zh-CN', { numeric: true }));
    outlineRows = [];
    const selected = new Set(session.selection);

    function append(entity, depth) {
      outlineRows.push(entity.id);
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'entity-row';
      row.dataset.entityId = String(entity.id);
      row.setAttribute('role', 'treeitem');
      row.setAttribute('aria-pressed', String(selected.has(entity.id)));
      row.style.setProperty('--depth', depth);
      const childCount = children.get(entity.id)?.length ?? 0;
      row.innerHTML = `<span class="entity-caret">${childCount ? '⌄' : ''}</span><span class="entity-dot"></span><span class="entity-label"></span><span class="entity-id">#${entity.id}</span>`;
      row.querySelector('.entity-label').textContent = entityName(entity);
      row.addEventListener('click', (event) => {
        if (event.shiftKey && rangeAnchor !== null) {
          const a = outlineRows.indexOf(rangeAnchor);
          const b = outlineRows.indexOf(entity.id);
          session.setSelection(outlineRows.slice(Math.min(a, b), Math.max(a, b) + 1), { mode: event.ctrlKey || event.metaKey ? 'add' : 'replace' });
        } else {
          session.setSelection([entity.id], { mode: event.ctrlKey || event.metaKey ? 'toggle' : 'replace' });
        }
        rangeAnchor = entity.id;
      });
      row.addEventListener('dblclick', () => focusSelection([entity.id]));
      outlineMount.append(row);
      for (const child of children.get(entity.id) ?? []) append(child, depth + 1);
    }
    for (const root of children.get(null) ?? []) append(root, 0);
  }

  function inputForField(component, field, ids) {
    const { schema } = field;
    let input;
    if (schema.type === 'boolean') {
      input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = field.mixed ? false : field.value;
      input.indeterminate = field.mixed;
    } else if (schema.type === 'enum') {
      input = document.createElement('select');
      if (field.mixed) input.append(new Option('多种值', ''));
      for (const value of schema.values) input.append(new Option(String(value), String(value)));
      input.value = field.mixed ? '' : String(field.value);
    } else if (schema.type === 'entity') {
      input = document.createElement('select');
      input.append(new Option('无', ''));
      for (const entity of session.world.query(Transform)) {
        if (!ids.includes(entity.id)) input.append(new Option(entityName(entity), String(entity.id)));
      }
      input.value = field.mixed || field.value === null ? '' : String(field.value.id);
    } else {
      input = document.createElement('input');
      input.type = schema.type === 'number' ? 'number' : 'text';
      if (schema.type === 'number') {
        input.step = numericStep(schema);
        if (schema.min !== undefined) input.min = String(schema.min);
        if (schema.max !== undefined) input.max = String(schema.max);
      }
      input.placeholder = field.mixed ? '多种值' : '';
      input.value = field.mixed ? '' : String(field.value);
    }
    input.className = 'field-input';
    input.dataset.field = field.name;
    input.setAttribute('aria-label', FIELD_LABELS[field.name] ?? field.name);
    if (schema.description) input.title = schema.description;
    input.addEventListener('change', async () => {
      let value;
      if (schema.type === 'boolean') value = input.checked;
      else if (schema.type === 'number') value = Number(input.value);
      else if (schema.type === 'entity') value = input.value ? Number(input.value) : null;
      else value = input.value;
      const currentComparable = schema.type === 'entity' ? field.value?.id ?? null : field.value;
      if (!field.mixed && Object.is(currentComparable, value)) {
        renderInspector();
        return;
      }
      input.disabled = true;
      try {
        await session.patchComponent(component.id, ids.map((entityId) => ({ entityId, values: { [field.name]: value } })));
        setFeedback('已通过 Action 提交', 'success');
      } catch (error) {
        setFeedback(error.message, 'error');
        renderInspector();
      } finally {
        input.disabled = false;
      }
    });
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        input.dispatchEvent(new Event('change', { bubbles: true }));
        input.blur();
      }
      if (event.key === 'Escape') renderInspector();
    });
    return input;
  }

  function renderInspector() {
    inspectorMount.replaceChildren();
    const details = session.describeSelection();
    if (details.count === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.innerHTML = '<strong>未选择实体</strong><span>从大纲或视口选择一个对象</span>';
      inspectorMount.append(empty);
      return;
    }
    const heading = document.createElement('div');
    heading.className = 'selection-heading';
    const headingTitle = document.createElement('strong');
    headingTitle.textContent = details.count === 1
      ? entityName(entityById(session.world, details.ids[0]))
      : `${details.count} 个实体`;
    const headingIds = document.createElement('span');
    headingIds.textContent = details.ids.map((id) => `#${id}`).join(', ');
    heading.append(headingTitle, headingIds);
    inspectorMount.append(heading);

    for (const component of details.components) {
      const section = document.createElement('section');
      section.className = 'component-section';
      const title = document.createElement('h3');
      title.textContent = COMPONENT_LABELS[component.id] ?? component.id;
      section.append(title);
      for (const field of component.fields) {
        if (field.schema.transient) continue;
        const row = document.createElement('label');
        row.className = 'field-row';
        const label = document.createElement('span');
        label.className = 'field-label';
        label.textContent = FIELD_LABELS[field.name] ?? field.name;
        if (field.schema.unit) label.dataset.unit = field.schema.unit;
        row.append(label, inputForField(component, field, details.ids));
        section.append(row);
      }
      inspectorMount.append(section);
    }
  }

  function focusSelection(ids = session.selection) {
    const box = new THREE.Box3();
    let found = false;
    for (const id of ids) {
      const object = bridge.getObject(id);
      if (!object) continue;
      box.expandByObject(object);
      found = true;
    }
    if (!found) return;
    const center = box.getCenter(new THREE.Vector3());
    const size = Math.max(box.getSize(new THREE.Vector3()).length(), 1);
    controls.target.copy(center);
    camera.position.copy(center).add(new THREE.Vector3(size * 1.2, size * 0.85, size * 1.2));
    controls.update();
  }

  function screenPoint(object) {
    const point = new THREE.Vector3().setFromMatrixPosition(object.matrix).project(camera);
    const rect = renderer.domElement.getBoundingClientRect();
    return {
      x: rect.left + (point.x + 1) * 0.5 * rect.width,
      y: rect.top + (1 - point.y) * 0.5 * rect.height,
      visible: point.z >= -1 && point.z <= 1,
    };
  }

  function finishMarquee(event) {
    if (!marquee) return;
    const dx = event.clientX - marquee.x;
    const dy = event.clientY - marquee.y;
    selectionRect.hidden = true;
    if (Math.hypot(dx, dy) < 5) {
      const pointer = new THREE.Vector2();
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
      const raycaster = new THREE.Raycaster();
      raycaster.setFromCamera(pointer, camera);
      const hit = bridge.pick(raycaster.ray.origin, raycaster.ray.direction, { maxDistance: 500 });
      if (hit) session.setSelection([hit.entity.id], { mode: event.shiftKey || event.ctrlKey || event.metaKey ? 'toggle' : 'replace' });
      else if (!(event.shiftKey || event.ctrlKey || event.metaKey)) session.clearSelection();
    } else {
      const left = Math.min(marquee.x, event.clientX);
      const right = Math.max(marquee.x, event.clientX);
      const top = Math.min(marquee.y, event.clientY);
      const bottom = Math.max(marquee.y, event.clientY);
      const hits = [];
      for (const entity of session.world.query(Transform)) {
        const point = screenPoint(bridge.getObject(entity));
        if (point.visible && point.x >= left && point.x <= right && point.y >= top && point.y <= bottom) hits.push(entity.id);
      }
      session.setSelection(hits, { mode: event.shiftKey ? 'add' : 'replace' });
    }
    marquee = null;
  }

  renderer.domElement.addEventListener('pointerdown', (event) => {
    if (draggingGizmo || event.button !== 0 || event.altKey) return;
    marquee = { x: event.clientX, y: event.clientY };
    selectionRect.hidden = false;
    selectionRect.style.left = `${event.clientX}px`;
    selectionRect.style.top = `${event.clientY}px`;
    selectionRect.style.width = '0px';
    selectionRect.style.height = '0px';
  });
  addEventListener('pointermove', (event) => {
    if (!marquee) return;
    selectionRect.style.left = `${Math.min(marquee.x, event.clientX)}px`;
    selectionRect.style.top = `${Math.min(marquee.y, event.clientY)}px`;
    selectionRect.style.width = `${Math.abs(event.clientX - marquee.x)}px`;
    selectionRect.style.height = `${Math.abs(event.clientY - marquee.y)}px`;
  });
  addEventListener('pointerup', finishMarquee);

  gizmo.addEventListener('dragging-changed', (event) => {
    draggingGizmo = event.value;
    controls.enabled = !event.value;
    if (event.value) {
      marquee = null;
      selectionRect.hidden = true;
      const matrices = new Map();
      for (const entity of selectedEntities()) {
        const object = bridge.getObject(entity);
        if (object) matrices.set(entity.id, object.matrix.clone());
      }
      pivot.updateMatrix();
      gizmoStart = { pivot: pivot.matrix.clone(), matrices };
    } else if (gizmoStart) {
      pivot.updateMatrix();
      const delta = pivot.matrix.clone().multiply(gizmoStart.pivot.clone().invert());
      const patches = transformPatchesFromWorldDelta(session.world, session.selection, delta);
      gizmoStart = null;
      if (patches.length) session.patchComponent(Transform.id, patches)
        .then(() => setFeedback('变换已提交', 'success'))
        .catch((error) => setFeedback(error.message, 'error'));
      else {
        bridge.sync();
        updateGizmo();
      }
    }
  });

  gizmo.addEventListener('objectChange', () => {
    if (!gizmoStart) return;
    pivot.updateMatrix();
    const delta = pivot.matrix.clone().multiply(gizmoStart.pivot.clone().invert());
    for (const [id, matrix] of gizmoStart.matrices) {
      const object = bridge.getObject(id);
      if (!object) continue;
      object.matrix.copy(delta).multiply(matrix);
      object.matrixWorldNeedsUpdate = true;
    }
  });

  for (const button of modeButtons) {
    button.addEventListener('click', () => {
      gizmoMode = button.dataset.mode;
      gizmo.setMode(gizmoMode);
      setButtonPressed(modeButtons, gizmoMode);
    });
  }
  setButtonPressed(modeButtons, gizmoMode);

  undoButton.addEventListener('click', async () => {
    try {
      await session.undo();
      setFeedback('已撤销', 'success');
    } catch (error) {
      setFeedback(error.message, 'error');
    }
  });

  addEventListener('keydown', (event) => {
    if (event.target instanceof HTMLElement
      && event.target.matches('input, select, textarea, [contenteditable="true"]')) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      undoButton.click();
    }
    if (event.key.toLowerCase() === 'f') focusSelection();
    if (event.key.toLowerCase() === 'w') modeButtons.find((button) => button.dataset.mode === 'translate')?.click();
    if (event.key.toLowerCase() === 'e') modeButtons.find((button) => button.dataset.mode === 'rotate')?.click();
    if (event.key.toLowerCase() === 'r') modeButtons.find((button) => button.dataset.mode === 'scale')?.click();
  });

  session.subscribe(() => {
    renderOutline();
    renderInspector();
    updateHighlights();
    updateGizmo();
    updateStatus();
  });

  function resize() {
    const rect = viewport.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    camera.aspect = rect.width / rect.height;
    camera.updateProjectionMatrix();
    renderer.setSize(rect.width, rect.height, false);
  }

  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(viewport);
  renderOutline();
  renderInspector();
  updateHighlights();
  updateGizmo();
  updateStatus();
  resize();

  return Object.freeze({
    controls,
    gizmo,
    update() {
      controls.update();
      updateHighlights();
    },
    focusSelection,
    destroy() {
      resizeObserver.disconnect();
      controls.dispose();
      gizmo.dispose();
      scene.remove(gizmoHelper, pivot);
      clearTimeout(feedbackTimer);
    },
  });
}
