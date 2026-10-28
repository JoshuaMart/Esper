package main

import (
	"net/http"

	"example.com/app/mw"
	"example.com/app/routes"
	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
)

func main() {
	r := chi.NewRouter()
	r.Use(middleware.RealIP, mw.Logger)

	api := chi.NewRouter()
	api.Use(mw.RequireUser(true))
	users := routes.NewUsers()
	users.RegisterRoutes(api)
	r.Mount("/api", api)

	r.Route("/admin", func(r chi.Router) {
		r.Use(mw.RequireAdmin)
		r.Get("/", adminHome)
		r.With(mw.Audit).Delete("/users/{id:[0-9]+}", routes.DeleteUser)
	})
	r.Group(func(r chi.Router) {
		r.Get("/health", http.HandlerFunc(health))
	})
	r.Mount("/static", http.FileServer(http.Dir("public")))

	http.ListenAndServe(":8080", r)
}

func adminHome(w http.ResponseWriter, r *http.Request) {}

func health(w http.ResponseWriter, r *http.Request) {}
