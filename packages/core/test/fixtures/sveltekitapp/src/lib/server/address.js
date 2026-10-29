/**
 * The client's address, as the request event gives it.
 * @param {import('@sveltejs/kit').RequestEvent} event
 * @returns {string}
 */
export function clientOf(event) {
	return event.getClientAddress();
}
