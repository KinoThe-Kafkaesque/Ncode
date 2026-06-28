import type { Command } from '../../commands.js'

const autoresearch = {
  type: 'local-jsx',
  name: 'autoresearch',
  description:
    'Toggle the autonomous autoresearch experiment loop, or pass a goal / off / clear',
  immediate: true,
  argumentHint: '<goal> | off | clear [--keep-tree|--reset-tree]',
  load: () => import('./autoresearch.js'),
} satisfies Command

export default autoresearch
