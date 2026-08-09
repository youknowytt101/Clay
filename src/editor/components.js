import { defineComponent } from '../core/ecs.js';

export const Name = defineComponent({
  id: 'core.name',
  version: 1,
  schema: {
    value: {
      type: 'string',
      default: 'Entity',
      description: 'Display name shown in editor views.',
    },
  },
});

export const EditorTag = defineComponent({
  id: 'editor.tag',
  version: 1,
  schema: {
    category: {
      type: 'enum',
      default: 'prop',
      values: ['structure', 'prop', 'marker'],
      description: 'Editor category used for filtering and visual identity.',
    },
    locked: {
      type: 'boolean',
      default: false,
      description: 'Prevents accidental viewport manipulation.',
    },
  },
});
