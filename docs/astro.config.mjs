// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import mermaid from 'astro-mermaid';

// https://astro.build/config
export default defineConfig({
	integrations: [
		// Must come before Starlight to handle ```mermaid blocks.
		mermaid({ autoTheme: true }),
		starlight({
			title: 'Esper',
			logo: { src: './src/assets/logo.svg' },
			customCss: ['./src/styles/custom.css'],
			social: [{ icon: 'github', label: 'GitHub', href: 'https://github.com/JoshuaMart/Esper' }],
			sidebar: [
				{
					label: 'Overview',
					items: ['how-it-works', 'decisions', 'roadmap', 'sources'],
				},
				{ label: 'Reference', items: [
						'reference/command-line',
						'reference/graph',
						'reference/profiles',
						'reference/mcp',
						'reference/notes',
					], },
			],
		}),
	],
});
