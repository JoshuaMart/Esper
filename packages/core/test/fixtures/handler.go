package api

import (
	"net/http"

	"github.com/go-chi/chi/v5"
)

func Routes() http.Handler {
	r := chi.NewRouter()
	r.Get("/users/{id}", getUser)
	return r
}

func getUser(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	w.Write([]byte(id))
}
