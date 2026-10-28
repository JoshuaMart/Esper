package mw

import "net/http"

func Logger(next http.Handler) http.Handler { return next }

func RequireUser(strict bool) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			token := r.Header.Get("Authorization")
			_ = token
			next.ServeHTTP(w, r)
		})
	}
}

func RequireAdmin(next http.Handler) http.Handler { return next }

func Audit(next http.Handler) http.Handler { return next }
