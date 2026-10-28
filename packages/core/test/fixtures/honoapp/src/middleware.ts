import type { Context, Next } from 'hono'

const seen = new Map<string, number>()

export async function audit(c: Context, next: Next) {
  seen.set(c.req.path, Date.now())
  c.set('user', c.req.header('X-User'))
  await next()
}

export const limiter = async (c: Context, next: Next) => {
  if (seen.size > 1000) return c.text('slow down', 429)
  await next()
}

export const guards = {
  owner: () => async (c: Context, next: Next) => {
    if (c.req.header('X-User') !== c.req.param('id')) {
      return c.text('forbidden', 403)
    }
    await next()
  },
}
