import type { LocalCommandCall } from '../../types/command.js'
import { getCompanion } from '../../buddy/companion.js'
import { generateShortWordSlug } from '../../utils/words.js'
import { updateSettingsForSource } from '../../utils/settings/settings.js'

function titleCaseSlug(slug: string): string {
  return slug
    .split('-')
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

function hatchCompanion() {
  const now = Date.now()
  return {
    name: titleCaseSlug(generateShortWordSlug()),
    personality: 'playful, curious, and a little chaotic',
    hatchedAt: now,
  }
}

export const call: LocalCommandCall = async (_args, context) => {
  let companion = getCompanion()

  if (!companion) {
    const stored = hatchCompanion()
    updateSettingsForSource('userSettings', { companion: stored })
    companion = getCompanion()

    if (!companion) {
      return {
        type: 'text',
        value: 'Could not hatch your companion.',
      }
    }
  }

  context.setAppState(prev => ({
    ...prev,
    companionPetAt: Date.now(),
  }))

  return {
    type: 'text',
    value: `You pet ${companion.name}.`,
  }
}
