import assert from 'node:assert/strict'
import { test } from 'node:test'
import { loadProfiles, ProfileError, parseProfile, resolveProfile } from '../src/index.ts'

const profilesDir = new URL('../../../profiles', import.meta.url).pathname

test('the shipped profiles are valid, and chi extends net-http', async () => {
  const profiles = await loadProfiles(profilesDir)
  const chi = profiles.find((p) => p.name === 'chi' && p.kind === 'application')
  assert.ok(chi)
  const resolved = resolveProfile(chi, profiles)
  assert.deepEqual(resolved.sources, ['net-http/application', 'chi/application'])
  assert.equal(resolved.request, 'net/http#Request')
  assert.equal(resolved.routers.length, 2)
  assert.ok(resolved.reads.some((r) => 'call' in r && r.call.endsWith('#URLParam')))
})

test('a profile that breaks the schema is refused, with where', async () => {
  const broken =
    'name: x\nkind: application\nlanguage: go\ndetect: {}\nreads: [{ read: headers, chain: Header }]\n'
  await assert.rejects(parseProfile(broken, 'x.yaml'), (error: unknown) => {
    assert.ok(error instanceof ProfileError)
    assert.match(error.message, /^x\.yaml: /)
    assert.match(error.message, /\/detect/)
    assert.match(error.message, /\/reads\/0\/read/)
    return true
  })
})

test('an unknown or circular extends is refused', async () => {
  const a = await parseProfile(
    'name: a\nkind: application\nlanguage: go\ndetect: { import: [x] }\nextends: [b]\n',
    'a',
  )
  const b = await parseProfile(
    'name: b\nkind: application\nlanguage: go\ndetect: { import: [x] }\nextends: [a]\n',
    'b',
  )
  assert.throws(() => resolveProfile(a, [a]), /extends unknown profile b/)
  assert.throws(() => resolveProfile(a, [a, b]), /extends itself/)
})
