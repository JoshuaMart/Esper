import { exec } from 'node:child_process'
import { Hono } from 'hono'
import { basicAuth } from 'hono/basic-auth'
import { audit, limiter } from '@/middleware'
import users from '@/users'

const app = new Hono()

app.use('*', audit)
app.get('/health', (c) => c.text('ok'))
app.use('/admin/*', basicAuth({ username: 'admin', password: 'secret' }))
app.route('/users', users)
// Registered after the users routes: it guards none of them.
app.use('/users/*', limiter)

const admin = app.basePath('/admin')
admin.get('/stats', (c) => c.json({ range: c.req.query('range') }))
admin.post('/run', async (c) => {
  const { command } = await c.req.json()
  exec(command)
  return c.text('started')
})

export default app
