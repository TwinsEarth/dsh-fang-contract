// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang/dsh-Master contributors — see LICENSE.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  CONTRACT_VERSION, DEFAULT_TRANSPORT_ORDER, ERROR_CODES, METHODS, PROTOCOL,
  createContractClient, createContractServer, createEnvelope, createFileTransport,
  createHttpTransport, createLegacyTransport, createLocalTransport, createResponse,
  createTransportRouter, helloPayload, negotiate, parseVersion, startFileContractServer, validateEnvelope,
} from '../src/index.js'

const server = () => createContractServer({
  role: 'mother', instanceId: 'srv-1',
  handlers: {
    [METHODS.FORK_SPAWN]: async (params) => ({ ok: true, forkId: `fork-${params?.title ?? 'x'}` }),
    [METHODS.DECISION_CREATE]: async (params) => ({ ok: true, ticket: { id: 'dec-1', ...params } }),
  },
})

test('contract: versions and transport order are stable', () => {
  assert.equal(CONTRACT_VERSION, '1.0.0')
  assert.deepEqual([...DEFAULT_TRANSPORT_ORDER], ['local', 'http', 'file', 'legacy'])
  assert.deepEqual(parseVersion('1.2.3'), { major: 1, minor: 2, patch: 3, text: '1.2.3' })
  assert.equal(parseVersion('nope'), null)
})

test('contract: envelope validation and hello negotiation', () => {
  const env = createEnvelope({ method: METHODS.FORK_SPAWN, params: { title: 't' } })
  assert.equal(validateEnvelope(env).ok, true)
  assert.equal(validateEnvelope({ ...env, protocolVersion: 99 }).ok, false)
  assert.equal(createResponse({ id: env.id, result: { ok: true } }).ok, true)

  const local = helloPayload({ role: 'essence', methods: [METHODS.HELLO, METHODS.FORK_SPAWN] })
  const remote = helloPayload({ role: 'mother', methods: [METHODS.HELLO, METHODS.FORK_SPAWN, METHODS.DECISION_CREATE] })
  const negotiation = negotiate(local, remote)
  assert.equal(negotiation.ok, true)
  assert.equal(negotiation.compatible, true)
  assert.deepEqual(negotiation.methods.sort(), [METHODS.HELLO, METHODS.FORK_SPAWN].sort())
  assert.equal(negotiation.fallback, null)

  const tooNew = negotiate(local, helloPayload({ version: '2.0.0' }))
  assert.equal(tooNew.compatible, false)
  assert.equal(tooNew.reason, 'remote-too-new')
  assert.equal(tooNew.fallback, 'legacy')

  const tooOld = negotiate(local, helloPayload({ version: '0.9.0' }))
  assert.equal(tooOld.fallback, 'legacy')
})

test('contract: server dispatches methods, unknown methods and handler errors are envelopes', async () => {
  const srv = server()
  assert.equal(srv.hello().protocol, PROTOCOL)
  assert.ok(srv.hello().methods.includes(METHODS.FORK_SPAWN))

  const ok = await srv.invoke(createEnvelope({ method: METHODS.FORK_SPAWN, params: { title: 'bridge' } }))
  assert.equal(ok.ok, true)
  assert.equal(ok.result.forkId, 'fork-bridge')

  const unknown = await srv.invoke(createEnvelope({ method: 'nope.method' }))
  assert.equal(unknown.ok, false)
  assert.equal(unknown.error.code, ERROR_CODES.UNSUPPORTED_METHOD)

  const throwing = createContractServer({ handlers: { [METHODS.FORK_SPAWN]: async () => { throw new Error('boom') } } })
  const failed = await throwing.invoke(createEnvelope({ method: METHODS.FORK_SPAWN }))
  assert.equal(failed.ok, false)
  assert.equal(failed.error.code, ERROR_CODES.HANDLER_THREW)
  assert.match(failed.error.message, /boom/)
})

test('contract: local transport invokes the fangContract service', async () => {
  const srv = server()
  const ctx = { get: (name) => (name === 'fangContract' ? srv : null) }
  const local = createLocalTransport({ ctx })
  assert.equal(local.available(), true)
  const hello = await local.hello()
  assert.equal(hello.protocol, PROTOCOL)
  const response = await local.invoke(METHODS.DECISION_CREATE, { title: 'q' })
  assert.equal(response.ok, true)
  assert.equal(response.result.ticket.id, 'dec-1')
})

test('contract: router falls back local → http; business errors do not fall back', async () => {
  const calls = []
  const makeTransport = (name, behavior) => ({
    name, kind: name, available: () => true,
    async hello() { return helloPayload({ instanceId: name }) },
    async invoke(method, params) {
      calls.push(`${name}:${method}`)
      return behavior(method, params)
    },
  })
  const localFail = makeTransport('local', () => { throw Object.assign(new Error('local down'), { code: ERROR_CODES.TRANSPORT_UNAVAILABLE }) })
  const httpOk = makeTransport('http', () => createResponse({ result: { via: 'http' } }))
  const router = createTransportRouter({ transports: [localFail, httpOk], order: ['local', 'http'] })
  const out = await router.invoke(METHODS.HEALTH, null)
  assert.equal(out.ok, true)
  assert.equal(out.transport, 'http')
  assert.equal(out.response.result.via, 'http')
  assert.equal(calls.includes('local:' + METHODS.HEALTH), true, 'local tried first')
  assert.equal(calls.includes('http:' + METHODS.HEALTH), true)

  const businessError = makeTransport('local', () => createResponse({ error: { code: 'ticket-invalid', message: 'bad ticket' } }))
  const never = makeTransport('http', () => { throw new Error('should not be called') })
  const router2 = createTransportRouter({ transports: [businessError, never], order: ['local', 'http'] })
  const rejected = await router2.invoke(METHODS.FORK_SPAWN, {})
  assert.equal(rejected.ok, false)
  assert.equal(rejected.error.code, 'ticket-invalid')
  assert.equal(rejected.transport, 'local')
})

test('contract: unsupported method and incompatible hello fall through to legacy', async () => {
  const legacy = createLegacyTransport({
    ctx: { get: (name) => (name === 'fangForker' ? { async spawn(params) { return { ok: true, forkId: 'legacy-fork' } } } : null) },
  })
  assert.equal(legacy.available(), true)
  assert.equal((await legacy.hello()).contractVersion, '0.9.0')
  const response = await legacy.invoke(METHODS.FORK_SPAWN, { title: 'x' })
  assert.equal(response.result.forkId, 'legacy-fork')

  const unreachable = { name: 'local', kind: 'local', available: () => true, async hello() { throw new Error('no service') }, async invoke() { throw new Error('no service') } }
  const router = createTransportRouter({ transports: [unreachable, legacy], order: ['local', 'legacy'] })
  const hello = await router.hello()
  assert.equal(hello.ok, true)
  assert.equal(hello.fallback, 'legacy')
  assert.equal(hello.negotiation.compatible, false)
})

test('contract: file outbox transport roundtrip with the file server', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fang-contract-'))
  const srv = server()
  const fileServer = startFileContractServer({ dir, server: srv, pollMs: 25 })
  try {
    const transport = createFileTransport({ dir, pollMs: 25, timeoutMs: 5000 })
    assert.equal(transport.available(), true)
    const hello = await transport.hello()
    assert.equal(hello.protocol, PROTOCOL)
    const response = await transport.invoke(METHODS.FORK_SPAWN, { title: 'file' })
    assert.equal(response.ok, true)
    assert.equal(response.result.forkId, 'fork-file')
  } finally {
    fileServer.stop()
    await new Promise((resolve) => setTimeout(resolve, 120))
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('contract: http transport speaks the standard hello/invoke endpoints', async () => {
  const srv = server()
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, init })
    const body = JSON.parse(String(init.body))
    if (String(url).endsWith('/hello')) {
      return { ok: true, status: 200, async text() { return JSON.stringify(srv.hello()) } }
    }
    const response = await srv.invoke(body)
    return { ok: true, status: 200, async text() { return JSON.stringify(response) } }
  }
  const transport = createHttpTransport({ baseUrl: 'http://mother:60457/', token: 'tok', fetchImpl })
  const hello = await transport.hello()
  assert.equal(hello.protocol, PROTOCOL)
  const response = await transport.invoke(METHODS.DECISION_CREATE, { title: 'q' })
  assert.equal(response.ok, true)
  assert.equal(calls[0].url, 'http://mother:60457/fang/api/contract/hello')
  assert.equal(calls[1].url, 'http://mother:60457/fang/api/contract/invoke')
  assert.equal(calls[1].init.headers.authorization, 'Bearer tok')
})

test('contract: client facade auto-degrades to legacy when no contract endpoint exists', async () => {
  const ctx = {
    get: (name) => (name === 'fangForker' ? { async spawn(params) { return { ok: true, forkId: 'legacy-client' } } } : null),
  }
  const client = createContractClient({ ctx, config: { order: ['local', 'legacy'] } })
  assert.deepEqual(client.transports().map((t) => t.name), ['legacy'])
  const hello = await client.hello()
  assert.equal(hello.ok, true)
  assert.equal(hello.fallback, 'legacy')
  const spawned = await client.spawnFork({ title: 'via-legacy' })
  assert.equal(spawned.ok, true)
  assert.equal(spawned.response.result.forkId, 'legacy-client')
})
