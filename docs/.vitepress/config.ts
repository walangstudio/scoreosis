import { posix } from 'node:path';
import { defineConfig } from 'vitepress';

const repo = 'https://github.com/walangstudio/scoreosis';

export default defineConfig({
  title: 'Scoreosis',
  description:
    'Verified leaderboards and achievements for games: the server replays every run before it ranks it.',
  base: '/scoreosis/',
  cleanUrls: true,
  lastUpdated: true,
  head: [['link', { rel: 'icon', type: 'image/svg+xml', href: '/scoreosis/medal.svg' }]],
  markdown: {
    config(md) {
      // Docs link to the repo with relative paths so they work on GitHub. On the site,
      // anything outside docs/ goes to GitHub.
      md.core.ruler.push('repo-links', (state) => {
        const page = posix.dirname(state.env.relativePath ?? '');
        for (const block of state.tokens) {
          for (const token of block.children ?? []) {
            const href = token.type === 'link_open' ? token.attrGet('href') : null;
            if (!href || /^([a-z]+:|#|\/)/i.test(href)) continue;
            const target = posix.normalize(posix.join('docs', page, href));
            if (!target.startsWith('docs/')) token.attrSet('href', `${repo}/tree/main/${target}`);
          }
        }
      });
    },
  },
  themeConfig: {
    logo: '/medal.svg',
    nav: [
      { text: 'Guide', link: '/guide/getting-started' },
      { text: 'Reference', link: '/API' },
      { text: 'Changelog', link: `${repo}/blob/main/CHANGELOG.md` },
    ],
    sidebar: [
      {
        text: 'Guide',
        items: [
          { text: 'Getting started', link: '/guide/getting-started' },
          { text: 'Deploy to Cloudflare', link: '/guide/cloudflare' },
          { text: 'Configuration', link: '/guide/configuration' },
          { text: 'Other hosting', link: '/guide/hosting' },
          { text: 'Adding a game', link: '/INTEGRATION' },
        ],
      },
      {
        text: 'Reference',
        items: [
          { text: 'API', link: '/API' },
          { text: 'Architecture', link: '/ARCHITECTURE' },
          { text: 'Security', link: '/SECURITY' },
          { text: 'Operations', link: '/OPERATIONS' },
        ],
      },
    ],
    socialLinks: [{ icon: 'github', link: repo }],
    editLink: { pattern: `${repo}/edit/main/docs/:path` },
    search: { provider: 'local' },
    footer: { message: 'MIT licensed', copyright: 'walangstudio' },
  },
});
