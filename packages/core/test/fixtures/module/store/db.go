package store

type DB struct{}

func (db *DB) Find(id string) string { return id }

func (db *DB) Save(name string) {}

func Name(v any) string { return "" }
