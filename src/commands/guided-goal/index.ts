import type { Command } from '../../commands.js'

const guidedGoal = {
  type: 'local-jsx',
  name: 'guided-goal',
  description:
    'Define a persistent goal interactively via a short guided interview',
  immediate: true,
  argumentHint: '[rough idea]',
  load: () => import('./guided-goal.js'),
} satisfies Command

export default guidedGoal
