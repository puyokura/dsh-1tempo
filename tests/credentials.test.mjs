import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

import {
  parseCredentialFromYaml,
  readCredentialsYaml,
  resolveApiKey,
  defaultCredentialsPath,
} from '../src/credentials.mjs'

test('parseCredentialFromYaml extracts unquoted and quoted values', () => {
  const yaml = `
version: 1
refs:
  SARASHINA_API_KEY: raw-secret-key-123
  QUOTED_DOUBLE: "secret-double"
  QUOTED_SINGLE: 'secret-single'
  WITH_COMMENT: secret-with-comment # this is a comment
`
  assert.equal(parseCredentialFromYaml(yaml, 'SARASHINA_API_KEY'), 'raw-secret-key-123')
  assert.equal(parseCredentialFromYaml(yaml, 'QUOTED_DOUBLE'), 'secret-double')
  assert.equal(parseCredentialFromYaml(yaml, 'QUOTED_SINGLE'), 'secret-single')
  assert.equal(parseCredentialFromYaml(yaml, 'WITH_COMMENT'), 'secret-with-comment')
  assert.equal(parseCredentialFromYaml(yaml, 'NONEXISTENT'), undefined)
  assert.equal(parseCredentialFromYaml(undefined, 'SARASHINA_API_KEY'), undefined)
})

test('readCredentialsYaml returns undefined for non-existent file', () => {
  const nonexistent = path.join(os.tmpdir(), `nonexistent-${Date.now()}.yaml`)
  assert.equal(readCredentialsYaml('SARASHINA_API_KEY', nonexistent), undefined)
})

test('readCredentialsYaml reads key from a valid file', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), '1tempo-test-cred-'))
  const tmpFile = path.join(tmpDir, '.credentials.yaml')
  try {
    fs.writeFileSync(tmpFile, 'version: 1\nrefs:\n  SARASHINA_API_KEY: test-key-file\n', 'utf8')
    assert.equal(readCredentialsYaml('SARASHINA_API_KEY', tmpFile), 'test-key-file')
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('resolveApiKey prioritizes ctx.credentials over environment and file', async () => {
  const prevEnv = process.env.SARASHINA_API_KEY
  process.env.SARASHINA_API_KEY = 'env-key'
  try {
    const mockCtx = {
      get(name) {
        if (name === 'credentials') {
          return {
            async resolve(ref) {
              if (ref === 'SARASHINA_API_KEY') return { value: 'service-key', source: 'cordis' }
              return undefined
            },
          }
        }
        return undefined
      },
    }
    const resolved = await resolveApiKey(mockCtx, 'SARASHINA_API_KEY')
    assert.equal(resolved, 'service-key')
  } finally {
    if (prevEnv === undefined) delete process.env.SARASHINA_API_KEY
    else process.env.SARASHINA_API_KEY = prevEnv
  }
})

test('resolveApiKey falls back to process.env when ctx is empty', async () => {
  const prevEnv = process.env.SARASHINA_API_KEY
  process.env.SARASHINA_API_KEY = 'env-fallback-key'
  try {
    const resolved = await resolveApiKey(undefined, 'SARASHINA_API_KEY')
    assert.equal(resolved, 'env-fallback-key')
  } finally {
    if (prevEnv === undefined) delete process.env.SARASHINA_API_KEY
    else process.env.SARASHINA_API_KEY = prevEnv
  }
})

test('resolveApiKey returns undefined when no credentials source has the key', async () => {
  const prevEnv = process.env.NONEXISTENT_KEY_TEST
  delete process.env.NONEXISTENT_KEY_TEST
  try {
    const resolved = await resolveApiKey(undefined, 'NONEXISTENT_KEY_TEST')
    assert.equal(resolved, undefined)
  } finally {
    if (prevEnv !== undefined) process.env.NONEXISTENT_KEY_TEST = prevEnv
  }
})
