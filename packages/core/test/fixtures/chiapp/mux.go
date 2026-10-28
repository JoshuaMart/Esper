package main

import "net/http"

func plain() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /items/{id}", func(w http.ResponseWriter, r *http.Request) {
		_ = r.PathValue("id")
	})
	mux.Handle("/files/", http.FileServer(http.Dir(".")))
	http.HandleFunc("/ping", health)
}
