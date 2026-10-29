import type { PageLoad } from './$types';

export const load: PageLoad = ({ data, url }) => ({ ...data, tab: url.searchParams.get('tab') });
