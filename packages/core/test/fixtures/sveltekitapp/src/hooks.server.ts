import type { Handle } from '@sveltejs/kit/hooks';
import { sequence } from '@sveltejs/kit/hooks';
import { auth } from '#lib/server/auth.ts';

const session: Handle = async ({ event, resolve }) => {
	const found = await auth.api.getSession({ headers: event.request.headers });
	event.locals.user = found?.user ?? null;
	if (!event.locals.user && event.url.pathname.startsWith('/api/')) {
		return new Response('Unauthorized', { status: 401 });
	}
	return resolve(event);
};

const logger: Handle = async ({ event, resolve }) => {
	console.log(event.request.method, event.getClientAddress());
	return resolve(event);
};

export const handle = sequence(session, logger);
