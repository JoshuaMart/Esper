import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ cookies }) => ({ theme: cookies.get('theme') });
