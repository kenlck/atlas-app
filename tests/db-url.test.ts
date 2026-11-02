import net from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { testDatabaseUrl } from './db-url'

const savedTest = process.env.TEST_DATABASE_URL
const savedDatabase = process.env.DATABASE_URL

afterEach(() => {
  if (savedTest === undefined) delete process.env.TEST_DATABASE_URL
  else process.env.TEST_DATABASE_URL = savedTest
  if (savedDatabase === undefined) delete process.env.DATABASE_URL
  else process.env.DATABASE_URL = savedDatabase
})

describe('testDatabaseUrl', () => {
  it('refuses a remote TEST_DATABASE_URL and does not connect', () => {
    let connects = 0
    const proto = net.Socket.prototype as unknown as {
      connect: (...args: unknown[]) => unknown
    }
    const original = proto.connect
    proto.connect = function (this: unknown, ...args: unknown[]) {
      connects += 1
      return original.apply(this, args)
    }
    try {
      process.env.TEST_DATABASE_URL = 'postgres://u:p@db.example.com:5432/x'
      delete process.env.DATABASE_URL
      let message = ''
      expect(() => {
        try {
          testDatabaseUrl()
        } catch (error) {
          message = error instanceof Error ? error.message : ''
          throw error
        }
      }).toThrow(/TEST_DATABASE_URL/)
      expect(message).not.toContain('example.com')
      expect(message).not.toContain('postgres://')
      expect(connects).toBe(0)
    } finally {
      proto.connect = original
    }
  })

  it('refuses a remote DATABASE_URL by name', () => {
    delete process.env.TEST_DATABASE_URL
    process.env.DATABASE_URL = 'postgres://u:p@db.example.com:5432/x'
    let message = ''
    expect(() => {
      try {
        testDatabaseUrl()
      } catch (error) {
        message = error instanceof Error ? error.message : ''
        throw error
      }
    }).toThrow(/DATABASE_URL/)
    expect(message).not.toContain('TEST_DATABASE_URL')
    expect(message).not.toContain('example.com')
    expect(message).not.toContain('postgres://')
  })

  it('accepts a local TEST_DATABASE_URL', () => {
    process.env.TEST_DATABASE_URL = 'postgres://atlas:atlas@127.0.0.1:5432/atlas_test'
    expect(new URL(testDatabaseUrl()).hostname).toBe('127.0.0.1')
  })

  it('refuses a comma multi-host URL and does not connect', () => {
    expectRefuse('postgres://u:p@db.example.com,@localhost/x')
  })

  it('refuses a second @ before a local host and does not connect', () => {
    expectRefuse('postgres://u:p@db.example.com:5432,x@127.0.0.1:5432/x')
  })

  it('refuses a percent-encoded comma and does not connect', () => {
    expectRefuse('postgres://u:p@db.example.com%2C127.0.0.1/x')
  })

  it('accepts an IPv6 loopback URL', () => {
    process.env.TEST_DATABASE_URL = 'postgres://u:p@[::1]:5432/x'
    delete process.env.DATABASE_URL
    const host = decodeURIComponent(new URL(testDatabaseUrl()).hostname)
      .replace(/^\[|\]$/g, '')
      .toLowerCase()
    expect(host).toBe('::1')
  })

  it('accepts a percent-encoded localhost', () => {
    process.env.TEST_DATABASE_URL = 'postgres://u:p@%6c%6f%63%61%6c%68%6f%73%74/db'
    delete process.env.DATABASE_URL
    const host = decodeURIComponent(new URL(testDatabaseUrl()).hostname).toLowerCase()
    expect(host).toBe('localhost')
  })
})

function expectRefuse(url: string) {
  let connects = 0
  const proto = net.Socket.prototype as unknown as {
    connect: (...args: unknown[]) => unknown
  }
  const original = proto.connect
  proto.connect = function (this: unknown, ...args: unknown[]) {
    connects += 1
    return original.apply(this, args)
  }
  try {
    process.env.TEST_DATABASE_URL = url
    delete process.env.DATABASE_URL
    let message = ''
    expect(() => {
      try {
        testDatabaseUrl()
      } catch (error) {
        message = error instanceof Error ? error.message : ''
        throw error
      }
    }).toThrow(/TEST_DATABASE_URL/)
    expect(message).not.toContain('example.com')
    expect(message).not.toContain('postgres://')
    expect(message).not.toContain('localhost')
    expect(connects).toBe(0)
  } finally {
    proto.connect = original
  }
}
