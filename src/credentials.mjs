/**
 * Resolve credentials for 1tempo / Sarashina API.
 *
 * Precedence order (aligned with dsh-credentials-local):
 *   1. `ctx.credentials.resolve(ref)` if Cordis credentials service is available.
 *   2. `process.env[refName]` (inherited environment).
 *   3. `$DSH_HOME/.credentials.yaml` or `~/.dsh/.credentials.yaml`.
 *
 * Security discipline (RULE.md 第15条):
 *   Never leak, print, or log credential values.
 */

import { existsSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

/** Default credentials file location. */
export function defaultCredentialsPath() {
  const dshHome = process.env.DSH_HOME
  if (typeof dshHome === 'string' && dshHome.trim().length > 0) {
    return path.join(dshHome.trim(), '.credentials.yaml')
  }
  return path.join(os.homedir(), '.dsh', '.credentials.yaml')
}

/**
 * Extract one secret value for refName from YAML content without external dependencies.
 * Handles both flat key-value and nested `refs:` blocks, quoted and unquoted values.
 *
 * @param {string} text
 * @param {string} refName
 * @returns {string | undefined}
 */
export function parseCredentialFromYaml(text, refName) {
  if (typeof text !== 'string' || typeof refName !== 'string') return undefined
  const lines = text.split(/\r?\n/u)
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const colonIndex = trimmed.indexOf(':')
    if (colonIndex === -1) continue
    const key = trimmed.slice(0, colonIndex).trim()
    if (key !== refName) continue
    let val = trimmed.slice(colonIndex + 1).trim()
    if (!val) continue
    // Handle inline comments for unquoted values
    if (val.startsWith('"') && val.endsWith('"') && val.length >= 2) {
      val = val.slice(1, -1)
    } else if (val.startsWith("'") && val.endsWith("'") && val.length >= 2) {
      val = val.slice(1, -1)
    } else {
      const commentIdx = val.indexOf('#')
      if (commentIdx !== -1) {
        val = val.slice(0, commentIdx).trim()
      }
    }
    return val.length > 0 ? val : undefined
  }
  return undefined
}

/**
 * Read a credential directly from the credentials YAML file.
 *
 * @param {string} refName
 * @param {string} [customPath]
 * @returns {string | undefined}
 */
export function readCredentialsYaml(refName, customPath) {
  const filePath = customPath ?? defaultCredentialsPath()
  try {
    if (!existsSync(filePath)) return undefined
    const text = readFileSync(filePath, 'utf8')
    return parseCredentialFromYaml(text, refName)
  } catch {
    return undefined
  }
}

/**
 * Resolve an API key by reference name.
 *
 * @param {import('@deepseek-ai/cordis').Context | undefined} ctx
 * @param {string} [refName='SARASHINA_API_KEY']
 * @returns {Promise<string | undefined>}
 */
export async function resolveApiKey(ctx, refName = 'SARASHINA_API_KEY') {
  // 1. Check Cordis credentials service
  if (ctx && typeof ctx.get === 'function') {
    try {
      const credService = ctx.get('credentials', false)
      if (credService && typeof credService.resolve === 'function') {
        const resolved = await credService.resolve(refName)
        if (resolved?.value && typeof resolved.value === 'string' && resolved.value.trim().length > 0) {
          return resolved.value.trim()
        }
      }
    } catch {
      // Degrade to environment and file read
    }
  }

  // 2. Check process.env
  const envVal = process.env[refName]
  if (typeof envVal === 'string' && envVal.trim().length > 0) {
    return envVal.trim()
  }

  // 3. Check credentials file (~/.dsh/.credentials.yaml)
  const fileVal = readCredentialsYaml(refName)
  if (typeof fileVal === 'string' && fileVal.trim().length > 0) {
    return fileVal.trim()
  }

  return undefined
}
