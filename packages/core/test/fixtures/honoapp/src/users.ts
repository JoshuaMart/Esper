import { createRoute, OpenAPIHono } from '@hono/zod-openapi'
import { db, users as table } from '@app/db'
import { eq } from 'drizzle-orm'
import { csrf } from 'hono/csrf'
import { guards } from './middleware'

const path = '/{id}'

const getUser = createRoute({
  method: 'get',
  path,
  middleware: [guards.owner()] as const,
  responses: {},
})

const users = new OpenAPIHono()
  .openapi(getUser, async (c) => {
    const { id } = c.req.valid('param')
    return c.json(await db.select().from(table).where(eq(table.id, id)))
  })
  .post('/', csrf(), async (c) => {
    const body = await c.req.json()
    await db.insert(table).values(body)
    return c.json(body)
  })
  .get('/:id/avatar', (c) => c.redirect(c.req.query('next') ?? '/'))

export default users
