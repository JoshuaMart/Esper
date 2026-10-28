package routes

import (
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"
)

type Users struct{}

func NewUsers() *Users { return &Users{} }

func (u *Users) RegisterRoutes(router chi.Router) {
	r := chi.NewRouter()
	r.Get("/", u.list)
	r.Get("/{id}", u.get)
	r.Post("/", u.create)
	router.Mount("/users", r)
}

func (u *Users) list(w http.ResponseWriter, r *http.Request) {
	page := r.URL.Query().Get("page")
	_ = page
}

func (u *Users) get(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	load(id)
}

func (u *Users) create(w http.ResponseWriter, r *http.Request) {
	var body map[string]any
	json.NewDecoder(r.Body).Decode(&body)
}

func load(id string) {}

func DeleteUser(w http.ResponseWriter, r *http.Request) {}
