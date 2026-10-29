import { drizzle } from 'drizzle-orm/bun-sqlite';

export const db = drizzle('app.db');
