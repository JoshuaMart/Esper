import assert from 'node:assert/strict'
import { test } from 'node:test'
import { indexGo, loadProfiles, resolveProfile } from '../src/index.ts'

const source = `package fw

import "net/http"

var forwarded = http.CanonicalHeaderKey("X-Forwarded-For")

const realIP = "X-Real-IP"

// RealIP trusts forwarding headers.
func RealIP(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if ip := clientIP(r); ip != "" {
			r.RemoteAddr = ip
		}
		next.ServeHTTP(w, r)
	})
}

func clientIP(r *http.Request) string {
	if ip := r.Header.Get(realIP); ip != "" {
		return ip
	}
	return r.Header.Get(forwarded)
}

type Mux struct{}

func (m *Mux) route(w http.ResponseWriter, r *http.Request) {
	_ = r.URL.Path
}

// Version reads nothing from a request.
func Version() string { return "1" }
`

test('a framework is indexed by its request surface, and names the headers it reads', async () => {
  const profiles = await loadProfiles(new URL('../../../profiles', import.meta.url).pathname)
  const chi = profiles.find((p) => p.name === 'chi' && p.kind === 'framework')
  assert.ok(chi)
  const profile = { ...resolveProfile(chi, profiles), detect: {} }
  const { graph } = await indexGo([{ path: 'fw.go', source }], {
    module: 'example.com/fw',
    profile,
  })

  const entries = graph.nodes.filter((n) => n.kind === 'entry').map((n) => n.ref)
  assert.deepEqual(entries.sort(), ['entry:fw.go#Mux.route', 'entry:fw.go#RealIP'])

  const facts = (kind: string) =>
    [
      ...new Set(
        graph.facts
          .filter((f) => f.node === 'entry:fw.go#RealIP' && f.kind === kind)
          .map((f) => f.value),
      ),
    ].sort()
  assert.deepEqual(facts('read'), ['header.X-Forwarded-For', 'header.X-Real-IP'])
  assert.deepEqual(facts('signal'), ['retained-mutation'])
})
