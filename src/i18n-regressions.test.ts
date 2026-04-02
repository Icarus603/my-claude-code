import { describe, expect, test } from 'bun:test'
import { getSelectMemoriesSystemPrompt } from './memdir/findRelevantMemories.js'
import {
  calculateTokenWarningState,
  getAutoCompactThreshold,
} from './services/compact/autoCompact.js'
import {
  buildCompactStreamingSystemPrompt,
} from './services/compact/compact.js'
import {
  getCompactPrompt,
  getPartialCompactPrompt,
} from './services/compact/prompt.js'
import { roughTokenCountEstimation } from './services/tokenEstimation.js'

describe('i18n regressions', () => {
  test('rough token estimation treats Chinese text as denser than ASCII text', () => {
    expect(roughTokenCountEstimation('你好世界')).toBe(4)
    expect(roughTokenCountEstimation('hello world')).toBe(3)
  })

  test('compact prompt carries explicit response language requirement', () => {
    const prompt = getCompactPrompt(undefined, 'Traditional Chinese')

    expect(prompt).toContain('Language Requirement:')
    expect(prompt).toContain(
      'Write the summary entirely in Traditional Chinese.',
    )
  })

  test('partial compact prompt also carries explicit response language requirement', () => {
    const prompt = getPartialCompactPrompt(
      'Focus on recent work',
      'from',
      '繁體中文',
    )

    expect(prompt).toContain('Additional Instructions:\nFocus on recent work')
    expect(prompt).toContain('Write the summary entirely in 繁體中文.')
  })

  test('compact fallback system prompt preserves response language', () => {
    const systemPrompt = buildCompactStreamingSystemPrompt('繁體中文')

    expect(systemPrompt).toHaveLength(2)
    expect(systemPrompt[1]).toContain('Always write the summary in 繁體中文.')
  })

  test('memory selector prompt explicitly instructs cross-language matching', () => {
    const prompt = getSelectMemoriesSystemPrompt('Traditional Chinese')

    expect(prompt).toContain("The user's preferred language is Traditional Chinese.")
    expect(prompt).toContain('Match memories by semantic meaning across languages')
  })

  test('Chinese-heavy content reaches auto-compact threshold sooner than ASCII content', () => {
    const originalWindow = process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW
    process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = '40000'

    try {
      const model = 'claude-sonnet-4-6'
      const threshold = getAutoCompactThreshold(model)

      const englishTokens = roughTokenCountEstimation('a'.repeat(8000))
      const chineseTokens = roughTokenCountEstimation('你'.repeat(8000))

      expect(threshold).toBe(7000)
      expect(englishTokens).toBe(2000)
      expect(chineseTokens).toBe(8000)

      expect(
        calculateTokenWarningState(englishTokens, model)
          .isAboveAutoCompactThreshold,
      ).toBe(false)
      expect(
        calculateTokenWarningState(chineseTokens, model)
          .isAboveAutoCompactThreshold,
      ).toBe(true)
    } finally {
      if (originalWindow === undefined) {
        delete process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW
      } else {
        process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = originalWindow
      }
    }
  })
})
