import test from 'node:test'
import assert from 'node:assert/strict'

import { matchesSchema, parseStructured } from '../lib/run.js'

const objectSchema = {
  type: 'object',
  required: ['status'],
  properties: {
    status: { type: 'string', enum: ['ok', 'failed'] },
    count: { type: 'integer' },
    tags: { type: 'array', items: { type: 'string' } },
  },
}

test('parseStructured accepts a value that satisfies type / required / enum / items', () => {
  const text = '{"status":"ok","count":3,"tags":["a","b"]}'
  assert.deepEqual(parseStructured(text, objectSchema), { status: 'ok', count: 3, tags: ['a', 'b'] })
})

test('parseStructured rejects a missing required key', () => {
  assert.equal(parseStructured('{"count":1}', objectSchema), undefined)
})

test('parseStructured rejects an enum mismatch nested in properties', () => {
  assert.equal(parseStructured('{"status":"maybe"}', objectSchema), undefined)
})

test('parseStructured rejects a wrong item type inside an array', () => {
  assert.equal(parseStructured('{"status":"ok","tags":["a",2]}', objectSchema), undefined)
})

test('parseStructured rejects a wrong scalar type', () => {
  assert.equal(parseStructured('{"status":"ok","count":"three"}', objectSchema), undefined)
  assert.equal(parseStructured('{"status":"ok","count":3.5}', objectSchema), undefined)
})

test('parseStructured strips a fenced code block and parses inside it', () => {
  assert.deepEqual(parseStructured('```json\n{"status":"failed"}\n```', objectSchema), { status: 'failed' })
})

test('parseStructured keeps working without a schema and on non-JSON text', () => {
  assert.deepEqual(parseStructured('{"anything":1}', undefined), { anything: 1 })
  assert.equal(parseStructured('not json', objectSchema), undefined)
  assert.equal(parseStructured(undefined, objectSchema), undefined)
})

test('matchesSchema accepts a keyword it does not model instead of rejecting the value', () => {
  assert.equal(matchesSchema({ a: 1 }, { type: 'object', additionalProperties: false }), true)
  assert.equal(matchesSchema(1, { type: 'number', minimum: 0 }), true)
})

test('matchesSchema supports a type list and nested objects', () => {
  const schema = {
    type: 'object',
    required: ['meta'],
    properties: { meta: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } },
  }
  assert.equal(matchesSchema({ meta: { id: 'x' } }, schema), true)
  assert.equal(matchesSchema({ meta: { id: 7 } }, schema), false)
  assert.equal(matchesSchema({ meta: {} }, schema), false)
  assert.equal(matchesSchema('text', { type: ['string', 'null'] }), true)
  assert.equal(matchesSchema(null, { type: ['string', 'null'] }), true)
  assert.equal(matchesSchema(5, { type: ['string', 'null'] }), false)
})
