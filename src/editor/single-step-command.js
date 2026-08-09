import { Transform } from '../core/transform.js';
import { Name } from './components.js';
import { EDITOR_PATCH_ACTION, editorAffects } from './session.js';

function selectionFrom(context) {
  const values = context?.selection;
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error('请先选择至少一个实体');
  }
  const selection = [...new Set(values)];
  if (selection.some((id) => !Number.isSafeInteger(id) || id < 1)) {
    throw new TypeError('selection must contain positive stable entity ids');
  }
  return selection.sort((a, b) => a - b);
}

function patches(selection, field, value) {
  return selection.map((entityId) => ({ entityId, values: { [field]: value } }));
}

export async function interpretEditorSingleStep({ instruction, context }) {
  const selection = selectionFrom(context);
  const text = instruction.trim();
  const position = text.match(/^(?:把)?(?:选中(?:物体|实体)?(?:的)?)?\s*([xyz])\s*(?:位置|坐标)?\s*(?:设为|设置为|改为|移动到)\s*(-?(?:\d+(?:\.\d+)?|\.\d+))\s*$/i);
  if (position) {
    const field = position[1].toLowerCase();
    return {
      actionId: EDITOR_PATCH_ACTION,
      params: {
        componentId: Transform.id,
        patches: patches(selection, field, Number(position[2])),
      },
    };
  }

  const rename = text.match(/^(?:把)?(?:选中(?:物体|实体)?)?\s*(?:重命名为|名称(?:设为|设置为|改为))\s*(.+?)\s*$/);
  if (rename?.[1]) {
    return {
      actionId: EDITOR_PATCH_ACTION,
      params: {
        componentId: Name.id,
        patches: patches(selection, 'value', rename[1]),
      },
    };
  }

  throw new Error('当前单步适配器支持设置 X / Y / Z 位置或重命名');
}

export function authorizeEditorSingleStep({ action, context }) {
  if (action?.id !== EDITOR_PATCH_ACTION) return false;
  const selection = selectionFrom(context);
  const input = action.params;
  if (!input || !Array.isArray(input.patches) || input.patches.length !== selection.length) return false;
  const patchIds = input.patches.map((patch) => patch.entityId).sort((a, b) => a - b);
  if (patchIds.some((id, index) => id !== selection[index])) return false;
  const allowedFields = input.componentId === Transform.id
    ? new Set(['x', 'y', 'z'])
    : input.componentId === Name.id
      ? new Set(['value'])
      : null;
  if (!allowedFields) return false;
  if (input.patches.some((patch) => {
    const fields = Object.keys(patch.values ?? {});
    return fields.length !== 1 || !allowedFields.has(fields[0]);
  })) return false;
  return editorAffects(input);
}
