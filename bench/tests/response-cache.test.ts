import { describe, expect, it } from 'vitest'
import { Hono } from '../../hono'
import { responseCache } from '.'

describe('responseCache (bench grade)', () => {
  it('serves the same body on a repeated GET (cache hit)', async () => {
    let calls = 0
    const app = new Hono()
    app.use('/api/*', responseCache())
    app.get('/api/data', (c) => {
      calls++
      return c.text(`v${calls}`)
    })

    const a = await (await app.request('/api/data')).text()
    const b = await (await app.request('/api/data')).text()
    expect(a).toBe(b)
    // handler ran once; second call served from cache
    expect(calls).toBe(1)
  })

  it('does not collide across different URLs', async () => {
    const app = new Hono()
    app.use('/api/*', responseCache())
    app.get('/api/a', (c) => c.text('A'))
    app.get('/api/b', (c) => c.text('B'))

    expect(await (await app.request('/api/a')).text()).toBe('A')
    expect(await (await app.request('/api/b')).text()).toBe('B')
    expect(await (await app.request('/api/a')).text()).toBe('A')
  })

  it('re-fetches after ttlMs elapses', async () => {
    let calls = 0
    const app = new Hono()
    app.use('/api/*', responseCache({ ttlMs: 20 }))
    app.get('/api/x', (c) => {
      calls++
      return c.text(`t${calls}`)
    })

    const before = await (await app.request('/api/x')).text()
    await new Promise((r) => setTimeout(r, 50))
    const after = await (await app.request('/api/x')).text()
    expect(before).not.toBe(after)
    expect(calls).toBe(2)
  })
})
