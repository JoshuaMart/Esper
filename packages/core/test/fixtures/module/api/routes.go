package api

import (
	"net/http"

	"example.com/shop/store"
	"github.com/go-chi/chi/v5"
)

type Server struct {
	db *store.DB
}

// Routes mounts the API.
func (s *Server) Routes() http.Handler {
	r := chi.NewRouter()
	r.Get("/items/{id}", s.getItem)
	r.Post("/items", func(w http.ResponseWriter, r *http.Request) {
		s.db.Save(r.FormValue("name"))
	})
	return r
}

func (s *Server) getItem(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	item := s.db.Find(id)
	writeJSON(w, item)
}

func writeJSON(w http.ResponseWriter, v any) {
	_ = len(store.Name(v))
}

func init() {}

func init() {}
