import type { Command } from '../../commands.js'

const buddy = {
  type: 'local',
  name: 'buddy',
  description: 'Pet your companion',
  supportsNonInteractive: false,
  load: () => import('./buddy.js'),
} satisfies Command

export default buddy
