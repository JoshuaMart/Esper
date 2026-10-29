import { command, getRequestEvent, query } from '$app/server';
import { db } from '#lib/server/db.ts';

export const getTodos = query(async () => {
	const { locals } = getRequestEvent();
	return db.select().from(locals.user.id);
});

export const addTodo = command(async (text: string) => {
	const event = getRequestEvent();
	await db.insert({ text, by: event.cookies.get('session') });
});
