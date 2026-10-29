import { json } from '@sveltejs/kit';
import { clientOf } from '#lib/server/address.js';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = (event) => {
	const { path } = event.params;
	return json({ path, from: clientOf(event), q: event.url.searchParams.get('q') });
};

const upload: RequestHandler = async ({ request }) => json(await request.json());

export { upload as POST };

export const fallback: RequestHandler = ({ request }) =>
	new Response(`${request.method} not allowed`, { status: 405 });
