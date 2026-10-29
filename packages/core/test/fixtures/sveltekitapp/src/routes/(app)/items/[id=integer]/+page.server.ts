import { error, fail } from '@sveltejs/kit';
import { db } from '#lib/server/db.ts';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params, locals }) => {
	if (!locals.user) error(401);
	return { item: await db.select().from(params.id) };
};

export const actions = {
	default: async ({ request, locals }) => {
		if (!locals.user) return fail(401);
		const data = await request.formData();
		await db.insert(data.get('name'));
	},
	async rename({ request, params, locals }) {
		if (!locals.user) return fail(401);
		const { name } = Object.fromEntries(await request.formData());
		await db.update(params.id).set({ name });
	},
	remove: async ({ params }) => {
		await db.delete(params.id);
	},
} satisfies Actions;
