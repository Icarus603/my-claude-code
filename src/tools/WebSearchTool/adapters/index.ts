/**
 * Search adapter factory — always uses Bing for maximum provider compatibility.
 * The API adapter (Anthropic server-side search) is available as an alternative
 * via WEB_SEARCH_ADAPTER=api env var for Anthropic-first deployments.
 */

import { BingSearchAdapter } from './bingAdapter.js'
import { ApiSearchAdapter } from './apiAdapter.js'
import type { WebSearchAdapter } from './types.js'

export type { SearchResult, SearchOptions, SearchProgress, WebSearchAdapter } from './types.js'

let cachedAdapter: WebSearchAdapter | null = null

export function createAdapter(): WebSearchAdapter {
  if (cachedAdapter) return cachedAdapter

  // Env override: WEB_SEARCH_ADAPTER=api|bing forces specific backend
  const envAdapter = process.env.WEB_SEARCH_ADAPTER
  if (envAdapter === 'api') {
    cachedAdapter = new ApiSearchAdapter()
    return cachedAdapter
  }

  // Default: Bing adapter works across all providers (Anthropic, Bedrock, Vertex, OpenAI)
  cachedAdapter = new BingSearchAdapter()
  return cachedAdapter
}
