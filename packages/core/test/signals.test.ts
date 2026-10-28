import assert from 'node:assert/strict'
import { test } from 'node:test'
import { type Graph, indexGo, loadProfiles, resolveProfile } from '../src/index.ts'

const source = `package main

import (
	"database/sql"
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
)

type User struct{ Name string }

type Server struct {
	db        *sql.DB
	onRequest func(*http.Request)
}

var cache = map[string]string{}

var settings *User

func current() *User {
	if settings != nil {
		return settings
	}
	settings = &User{}
	return settings
}

func (s *Server) routes() http.Handler {
	r := chi.NewRouter()
	r.Use(identify)
	r.With(auth).Get("/users/{id}", s.get)
	r.With(auth).Post("/users", s.create)
	r.Get("/users/{id}/export", s.export)
	r.With(middleware.BasicAuth("admin", nil)).Delete("/cache", s.flush)
	return r
}

func auth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") == "" {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func identify(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		r.Header.Set("X-User", "anonymous")
		next.ServeHTTP(w, r)
	})
}

func (s *Server) get(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	row := s.db.QueryRow("SELECT name FROM users WHERE id = " + id)
	_ = row
	s.onRequest(r)
}

func (s *Server) create(w http.ResponseWriter, r *http.Request) {
	var u User
	json.NewDecoder(r.Body).Decode(&u)
	s.db.Exec("INSERT INTO users (name) VALUES (?)", u.Name)
}

func (s *Server) export(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	cache[id] = "exported"
}

func (s *Server) flush(w http.ResponseWriter, r *http.Request) { _ = current() }
`

async function index(): Promise<Graph> {
  const profiles = await loadProfiles(new URL('../../../profiles', import.meta.url).pathname)
  const chi = profiles.find((p) => p.name === 'chi' && p.kind === 'application')
  assert.ok(chi)
  const { graph } = await indexGo([{ path: 'main.go', source }], {
    module: 'example.com/app',
    profile: resolveProfile(chi, profiles),
  })
  return graph
}

const signals = (graph: Graph, ref: string) =>
  [
    ...new Set(
      graph.facts.filter((f) => f.node === ref && f.kind === 'signal').map((f) => f.value),
    ),
  ].sort()

test('a handler that builds a query from a request value reaches a sink with a request key', async () => {
  const graph = await index()
  assert.deepEqual(signals(graph, 'route:GET /users/{id}'), [
    'callback-passed',
    'data-read',
    'request-key',
    'retained-mutation',
    'short-circuit',
    'sink-reachable',
  ])
  const sink = graph.facts.find((f) => f.node === 'main.go#Server.get' && f.kind === 'sink')
  assert.equal(sink?.value, 'sql')
})

test('a decoded body stored as is is a mass assignment, and a literal query is no sink', async () => {
  const graph = await index()
  assert.deepEqual(signals(graph, 'route:POST /users'), [
    'data-write',
    'mass-assignment',
    'retained-mutation',
    'short-circuit',
  ])
})

test('a route without the guard its siblings have is divergent', async () => {
  const graph = await index()
  assert.deepEqual(signals(graph, 'route:GET /users/{id}/export'), [
    'divergent-guard',
    'live-state',
    'retained-mutation',
  ])
  const divergent = graph.facts.find(
    (f) => f.node === 'route:GET /users/{id}/export' && f.value === 'divergent-guard',
  )
  assert.deepEqual(divergent?.data, { missing: ['auth'], siblings: 3 })
})

test('a guard a profile names is a guard fact of its kind', async () => {
  const graph = await index()
  const guards = graph.facts.filter((f) => f.node === 'route:DELETE /cache' && f.kind === 'guard')
  assert.deepEqual(
    guards.map((g) => g.value),
    ['authn'],
  )
})

test('a lazily created singleton is not live state', async () => {
  const graph = await index()
  assert.ok(!graph.facts.some((f) => f.node === 'main.go#current' && f.value === 'live-state'))
  assert.ok(!signals(graph, 'route:DELETE /cache').includes('live-state'))
})

test('the same middleware written two ways is one guard', async () => {
  const profiles = await loadProfiles(new URL('../../../profiles', import.meta.url).pathname)
  const chi = profiles.find((p) => p.name === 'chi' && p.kind === 'application')
  assert.ok(chi)
  const code = source.replace(
    'r.With(auth).Post("/users", s.create)',
    'r.With((auth)).Post("/users", s.create)',
  )
  const { graph } = await indexGo([{ path: 'main.go', source: code }], {
    module: 'example.com/app',
    profile: resolveProfile(chi, profiles),
  })
  assert.ok(!signals(graph, 'route:POST /users').includes('divergent-guard'))
  assert.ok(!signals(graph, 'route:GET /users/{id}').includes('divergent-guard'))
  assert.ok(signals(graph, 'route:GET /users/{id}/export').includes('divergent-guard'))
})
