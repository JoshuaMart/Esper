import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ url }) => ({ month: url.searchParams.get('m') });
