import type { Reroute } from '@sveltejs/kit';

export const reroute: Reroute = ({ url }) => {
	if (url.pathname.startsWith('/old/')) return url.pathname.slice(4);
};
