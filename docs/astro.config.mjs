// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import mermaid from 'astro-mermaid';

// https://astro.build/config
export default defineConfig({
	integrations: [
		// Doit précéder Starlight pour traiter les blocs ```mermaid.
		mermaid({ autoTheme: true }),
		starlight({
			title: 'Esper',
			logo: { src: './src/assets/logo.svg' },
			customCss: ['./src/styles/custom.css'],
			defaultLocale: 'root',
			locales: { root: { label: 'Français', lang: 'fr' } },
			social: [{ icon: 'github', label: 'GitHub', href: 'https://github.com/JoshuaMart/Esper' }],
			sidebar: [
				{
					label: "Vue d'ensemble",
					items: [],
				},
			],
		}),
	],
});
