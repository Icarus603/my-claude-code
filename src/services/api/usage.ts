import axios from 'axios'
import { getOauthConfig } from '../../constants/oauth.js'
import {
  getClaudeAIOAuthTokens,
  getCodexOAuthTokens,
  hasProfileScope,
  isClaudeAISubscriber,
  isCodexSubscriber,
  saveCodexOAuthTokens,
} from '../../utils/auth.js'
import { getAPIProvider } from '../../utils/model/providers.js'
import { getAuthHeaders } from '../../utils/http.js'
import { getClaudeCodeUserAgent } from '../../utils/userAgent.js'
import { isOAuthTokenExpired } from '../oauth/client.js'
import { refreshCodexToken } from '../oauth/codex-client.js'

export type RateLimit = {
  utilization: number | null // a percentage from 0 to 100
  resets_at: string | null // ISO 8601 timestamp
}

export type ExtraUsage = {
  is_enabled: boolean
  monthly_limit: number | null
  used_credits: number | null
  utilization: number | null
}

export type Utilization = {
  five_hour?: RateLimit | null
  seven_day?: RateLimit | null
  seven_day_oauth_apps?: RateLimit | null
  seven_day_opus?: RateLimit | null
  seven_day_sonnet?: RateLimit | null
  extra_usage?: ExtraUsage | null
  plan_type?: string | null
  credits_balance?: string | null
}

type CodexUsageWindow = {
  used_percent?: number | null
  reset_at?: number | null
}

type CodexRateLimitDetails = {
  primary_window?: CodexUsageWindow | null
  secondary_window?: CodexUsageWindow | null
}

type CodexUsageResponse = {
  plan_type?: string | null
  rate_limit?: CodexRateLimitDetails | null
  additional_rate_limits?:
    | Array<{
        limit_name?: string | null
        metered_feature?: string | null
        rate_limit?: CodexRateLimitDetails | null
      }>
    | null
  credits?: {
    has_credits?: boolean | null
    unlimited?: boolean | null
    balance?: string | null
  } | null
}

const DEFAULT_CODEX_BASE_URL = 'https://chatgpt.com'

type CodexPathStyle = 'chatgpt' | 'codex'

function normalizeCodexBaseUrl(baseUrl: string): string {
  let normalized = baseUrl.replace(/\/+$/, '')
  if (
    (normalized.startsWith('https://chatgpt.com') ||
      normalized.startsWith('https://chat.openai.com')) &&
    !normalized.includes('/backend-api')
  ) {
    normalized = `${normalized}/backend-api`
  }
  return normalized
}

function getCodexPathStyle(baseUrl: string): CodexPathStyle {
  return baseUrl.includes('/backend-api') ? 'chatgpt' : 'codex'
}

function getCodexUsageUrl(baseUrl: string): string {
  const normalizedBaseUrl = normalizeCodexBaseUrl(baseUrl)
  return getCodexPathStyle(normalizedBaseUrl) === 'chatgpt'
    ? `${normalizedBaseUrl}/wham/usage`
    : `${normalizedBaseUrl}/api/codex/usage`
}

function unixSecondsToIsoString(value: number | null | undefined): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null
  }
  return new Date(value * 1000).toISOString()
}

function mapCodexRateLimitWindow(
  window:
    | {
        used_percent?: number | null
        reset_at?: number | null
      }
    | null
    | undefined,
): RateLimit | null {
  if (!window) {
    return null
  }

  return {
    utilization:
      typeof window.used_percent === 'number' ? window.used_percent : null,
    resets_at: unixSecondsToIsoString(window.reset_at),
  }
}

function mapCodexUsageToUtilization(data: CodexUsageResponse): Utilization {
  return {
    five_hour: mapCodexRateLimitWindow(data.rate_limit?.primary_window),
    seven_day: mapCodexRateLimitWindow(data.rate_limit?.secondary_window),
    plan_type: data.plan_type ?? null,
    credits_balance: data.credits?.balance ?? null,
  }
}

async function fetchCodexUtilization(): Promise<Utilization | null> {
  const tokens = getCodexOAuthTokens()
  if (!tokens?.accessToken) {
    return {}
  }

  let accessToken = tokens.accessToken
  let accountId = tokens.accountId

  if (isOAuthTokenExpired(tokens.expiresAt)) {
    const refreshed = await refreshCodexToken(tokens.refreshToken)
    saveCodexOAuthTokens(refreshed)
    accessToken = refreshed.accessToken
    accountId = refreshed.accountId
  }

  const headers: Record<string, string> = {
    Accept: 'application/json',
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
    'User-Agent': getClaudeCodeUserAgent(),
  }

  if (accountId) {
    headers['ChatGPT-Account-Id'] = accountId
  }

  const usageUrl = getCodexUsageUrl(DEFAULT_CODEX_BASE_URL)

  const request = async () =>
    axios.get<CodexUsageResponse>(usageUrl, {
      headers,
      timeout: 5000,
    })

  try {
    const response = await request()
    return mapCodexUsageToUtilization(response.data)
  } catch (error) {
    if (!axios.isAxiosError(error)) {
      throw error
    }
    if (error.response?.status !== 401 && error.response?.status !== 403) {
      throw error
    }

    const refreshed = await refreshCodexToken(tokens.refreshToken)
    saveCodexOAuthTokens(refreshed)

    const retryHeaders = {
      ...headers,
      Authorization: `Bearer ${refreshed.accessToken}`,
      'ChatGPT-Account-Id': refreshed.accountId,
    }

    const response = await axios.get<CodexUsageResponse>(usageUrl, {
      headers: retryHeaders,
      timeout: 5000,
    })

    return mapCodexUsageToUtilization(response.data)
  }
}

export async function fetchUtilization(): Promise<Utilization | null> {
  if (isCodexSubscriber()) {
    return fetchCodexUtilization()
  }

  if (!isClaudeAISubscriber() || !hasProfileScope()) {
    return {}
  }

  // Skip API call if OAuth token is expired to avoid 401 errors
  const tokens = getClaudeAIOAuthTokens()
  if (tokens && isOAuthTokenExpired(tokens.expiresAt)) {
    return null
  }

  const authResult = getAuthHeaders()
  if (authResult.error) {
    throw new Error(`Auth error: ${authResult.error}`)
  }

  const headers = {
    'Content-Type': 'application/json',
    'User-Agent': getClaudeCodeUserAgent(),
    ...authResult.headers,
  }

  const url = `${getOauthConfig().BASE_API_URL}/api/oauth/usage`

  const response = await axios.get<Utilization>(url, {
    headers,
    timeout: 5000, // 5 second timeout
  })

  return response.data
}

/**
 * Fetches utilization data for all authenticated providers.
 * Returns separate data for Claude AI and Codex when both are logged in.
 */
export async function fetchAllProvidersUtilization(): Promise<{
  claude: Utilization | null
  codex: Utilization | null
}> {
  const result: {
    claude: Utilization | null
    codex: Utilization | null
  } = {
    claude: null,
    codex: null,
  }

  // Fetch Codex utilization if subscribed
  if (isCodexSubscriber()) {
    try {
      result.codex = await fetchCodexUtilization()
    } catch (err) {
      console.error('[usage] Failed to fetch Codex utilization:', err)
    }
  }

  // Fetch Claude AI utilization if subscribed
  if (isClaudeAISubscriber() && hasProfileScope()) {
    try {
      // Skip API call if OAuth token is expired
      const tokens = getClaudeAIOAuthTokens()
      if (tokens && !isOAuthTokenExpired(tokens.expiresAt)) {
        const authResult = getAuthHeaders()
        if (!authResult.error) {
          const headers = {
            'Content-Type': 'application/json',
            'User-Agent': getClaudeCodeUserAgent(),
            ...authResult.headers,
          }
          const url = `${getOauthConfig().BASE_API_URL}/api/oauth/usage`
          const response = await axios.get<Utilization>(url, {
            headers,
            timeout: 5000,
          })
          result.claude = response.data
        }
      }
    } catch (err) {
      console.error('[usage] Failed to fetch Claude utilization:', err)
    }
  }

  return result
}
