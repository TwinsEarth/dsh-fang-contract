// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang/dsh-Master contributors — see LICENSE.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  CONTRACT_VERSION, DEFAULT_TRANSPORT_ORDER, ERROR_CODES, METHODS, PROTOCOL, RELAY_LIMITS,
  createContractClient, createContractServer, createEnvelope, createFileTransport,
  createHttpTransport, createLegacyTransport, createLocalTransport, createRelayContractServer,
  createRelayStore, createResponse, createTransportRouter, helloPayload, negotiate, parseVersion,
  relayHandlers, startFileContractServer, validateEnvelope, validateRelayEvents,
} from '../src/index.js'

const server = () => createContractServer({
  role: 'mother', instanceId: 'srv-1',
  handlers: {
    [METHODS.FORK_SPAWN]: async (params) => ({ ok: true, forkId: `fork-${params?.title ?? 'x'}` }),
    [METHODS.DECISION_CREATE]: async (params) => ({ ok: true, ticket: { id: 'dec-1', ...params } }),
  },
})

test('contract: versions and transport order are stable', () => {
  assert.equal(CONTRACT_VERSION, '1.1.1')
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

// ── contract 1.1：回流（relay）────────────────────────────────────────────────

const relayMethods = [METHODS.RELAY_PUBLISH, METHODS.RELAY_STATUS]

test('relay: 1.0 peers keep working while relay methods are trimmed by negotiation', () => {
  const v11 = helloPayload({ role: 'mother', version: '1.1.0' })
  const same = negotiate(v11, v11)
  assert.equal(same.compatible, true)
  assert.deepEqual(relayMethods.filter((method) => same.methods.includes(method)), relayMethods)

  // 真实 1.0 对端：hello 里没有 relay 方法，公共 minor = 0 ⇒ 一律裁剪。
  const v10 = helloPayload({
    role: 'mother',
    version: '1.0.0',
    methods: Object.values(METHODS).filter((method) => !relayMethods.includes(method)),
    capabilities: ['sync', 'idempotent'],
  })
  const older = negotiate(v11, v10)
  assert.equal(older.compatible, true)
  assert.deepEqual(relayMethods.filter((method) => older.methods.includes(method)), [], 'relay must be trimmed for a 1.0 peer')
  assert.equal(older.version, '1.0.0')
  // 能力交集同样裁剪：1.0 对端不认识 event-relay
  assert.equal(older.capabilities.includes('event-relay'), false)
})

test('relay: validateRelayEvents accepts well-formed batches and rejects malformed ones by name', () => {
  const good = validateRelayEvents([{ id: 'e1', type: 'cost:event', at: 1, payload: { kind: 'ledger' } }])
  assert.equal(good.ok, true)
  assert.equal(good.accepted.length, 1)
  assert.equal(good.accepted[0].payload.kind, 'ledger')

  assert.equal(validateRelayEvents([]).ok, false)
  assert.equal(validateRelayEvents(null).ok, false)
  assert.deepEqual(validateRelayEvents([]).errors, ['events-empty'])

  const tooMany = Array.from({ length: RELAY_LIMITS.maxBatch + 1 }, (_, index) => ({ id: `e${index}`, type: 'cost:event' }))
  const overflow = validateRelayEvents(tooMany)
  assert.equal(overflow.ok, false)
  assert.match(overflow.errors.join(','), /events-too-many/u)

  const oversized = validateRelayEvents([{ id: 'e1', type: 'cost:event', payload: { blob: 'x'.repeat(200) } }], { maxEventBytes: 64 })
  assert.equal(oversized.ok, false)
  assert.equal(oversized.rejected[0].reason.startsWith('event-too-large'), true)

  // 坏条目不影响同批好条目，但必须逐条报出原因
  const mixed = validateRelayEvents([
    { id: 'ok-1', type: 'cost:event' },
    { id: '', type: 'cost:event' },
    { type: 'cost:event' },
    { id: 'dup', type: 'cost:event' },
    { id: 'dup', type: 'cost:event' },
  ])
  assert.equal(mixed.ok, true)
  assert.equal(mixed.accepted.length, 2)
  assert.deepEqual(mixed.rejected.map((item) => item.reason).sort(), ['duplicate-in-batch', 'id-required', 'id-required'])
})

test('relay: store is idempotent by event id and keeps a monotonic cursor', () => {
  const store = createRelayStore({ peerLabel: 'unit-peer', role: 'mother', instanceId: 'srv-relay', now: () => 7 })
  const first = store.publish({ batchId: 'b-1', events: [{ id: 'e1', type: 'cost:event', at: 1, payload: {} }, { id: 'e2', type: 'cost:degraded', at: 2, payload: {} }] })
  assert.equal(first.accepted, 2)
  assert.equal(first.duplicates, 0)
  assert.equal(first.cursor, 2)
  assert.equal(first.peer, 'unit-peer')

  // 同一批重投：幂等，不报错，游标不动
  const replay = store.publish({ batchId: 'b-1', events: [{ id: 'e1', type: 'cost:event' }, { id: 'e3', type: 'cost:substitution' }] })
  assert.equal(replay.accepted, 1)
  assert.equal(replay.duplicates, 1)
  assert.equal(replay.cursor, 3)

  const status = store.status()
  assert.equal(status.available, true)
  assert.equal(status.accepted, 3)
  assert.equal(status.duplicates, 1)
  assert.equal(status.rejected, 0)
  assert.equal(status.cursor, 3)
  assert.equal(status.peer, 'unit-peer')
  assert.equal(status.contractVersion, CONTRACT_VERSION)

  // 空批是协议错误，不是“成功但没做事”
  assert.throws(() => store.publish({ events: [] }), /relay-events-invalid|events-empty/u)
})

test('relay: relay server exposes the methods and the client facade publishes over the local transport', async () => {
  const { server: srv, store } = createRelayContractServer({ role: 'mother', instanceId: 'relay-srv', peerLabel: 'contract-server' })
  const hello = srv.hello()
  assert.ok(hello.methods.includes(METHODS.RELAY_PUBLISH))
  assert.ok(hello.methods.includes(METHODS.RELAY_STATUS))
  assert.ok(hello.capabilities.includes('event-relay'))

  const ctx = { get: (name) => (name === 'fangContract' ? srv : null) }
  const client = createContractClient({ ctx, instanceId: 'relay-client' })
  const negotiated = await client.hello()
  assert.equal(negotiated.ok, true)
  assert.ok(negotiated.negotiation.methods.includes(METHODS.RELAY_PUBLISH), 'relay is advertised after negotiation')

  const receipt = await client.publishRelay({ batchId: 'b-1', taskId: 'task_1', events: [{ id: 'e1', type: 'cost:event', at: 5, payload: { kind: 'ledger', savedTokens: 12 } }] })
  assert.equal(receipt.ok, true)
  assert.equal(receipt.transport, 'local')
  assert.equal(receipt.response.result.accepted, 1)
  assert.equal(receipt.response.result.peer, 'contract-server')

  const status = await client.relayStatus()
  assert.equal(status.ok, true)
  assert.equal(status.response.result.cursor, 1)
  assert.equal(store.describe().accepted, 1)
})

test('relay: a 1.0-style server without relay handlers answers unsupported-method honestly', async () => {
  const old = createContractServer({ role: 'mother', handlers: { [METHODS.FORK_LIST]: async () => [] } })
  const ctx = { get: (name) => (name === 'fangContract' ? old : null) }
  const client = createContractClient({ ctx })
  const negotiated = await client.hello()
  assert.equal(negotiated.ok, true)
  assert.equal(negotiated.negotiation.methods.includes(METHODS.RELAY_PUBLISH), false, 'relay is not offered by this peer')

  const attempt = await client.publishRelay({ events: [{ id: 'e1', type: 'cost:event' }] })
  assert.equal(attempt.ok, false, 'publishing to a peer without relay must fail loudly')
  assert.equal(attempt.code, ERROR_CODES.ALL_TRANSPORTS_FAILED)
  assert.equal(attempt.failures[0].code, ERROR_CODES.UNSUPPORTED_METHOD, 'the real reason is preserved per transport')
})

test('relay: replaying a batch reports zero rejected, never a negative count', () => {
  const store = createRelayStore({ peerLabel: 'x' })
  const events = [{ id: 'a', type: 'cost:event' }, { id: 'b', type: 'cost:event' }]
  const first = store.publish({ batchId: 'b', events })
  assert.equal(first.accepted, 2)
  assert.equal(first.duplicates, 0)
  assert.equal(first.rejected, 0)

  const second = store.publish({ batchId: 'b', events })
  assert.equal(second.accepted, 0)
  assert.equal(second.duplicates, 2)
  assert.equal(second.rejected, 0, 'replay must report 0 rejected, not a negative count')
  assert.equal(second.cursor, first.cursor, 'cursor must not advance on a replay')
  assert.equal(store.status().rejected, 0, 'store counters must stay non-negative')
  assert.equal(store.status().duplicates, 2)

  // 批内重复与已存在重复混在一起时，两个计数都不能互相污染
  const mixed = store.publish({ batchId: 'c', events: [{ id: 'a', type: 'cost:event' }, { id: 'c', type: 'cost:event' }, { id: 'c', type: 'cost:event' }, { id: '', type: 'cost:event' }] })
  assert.equal(mixed.accepted, 1)
  assert.equal(mixed.duplicates, 2)
  assert.equal(mixed.rejected, 1, 'only the malformed entry counts as rejected')
})

test('relay: relayHandlers rejects a store without publish/status', () => {
  assert.throws(() => relayHandlers(null), /requires a relay store/u)
  assert.throws(() => relayHandlers({ publish() {} }), /requires a relay store/u)
  const handlers = relayHandlers(createRelayStore({ peerLabel: 'x' }))
  assert.deepEqual(Object.keys(handlers).sort(), relayMethods.slice().sort())
})
