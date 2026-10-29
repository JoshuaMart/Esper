import { redirect } from '@sveltejs/kit';
import { shared } from './shared.ts';
import type { Actions, PageServerLoad } from './$types';

// A user already signed in goes home: a check that a user is there, not that one is missing.
export const load: PageServerLoad = ({ locals }) => {
	if (locals.user) redirect(303, '/');
};

const own = {
	default: async ({ request }) => ({ email: (await request.formData()).get('email') }),
} satisfies Actions;

export const actions = { ...shared, ...own };
