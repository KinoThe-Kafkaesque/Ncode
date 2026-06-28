import type { Command } from '../../commands.js'

const goal = {
  type: 'local-jsx',
  name: 'goal',
  description:
    'Set or manage a persistent autonomous objective (goal mode)',
  immediate: true,
  argumentHint: '<objective> | show | pause | resume | drop | budget <n|none>',
  load: () => import('./goal.js'),
} satisfies Command

export default goal
