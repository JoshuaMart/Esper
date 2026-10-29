export const shared = {
	forgot: async ({ request }) => ({ sent: (await request.formData()).get('email') }),
};
