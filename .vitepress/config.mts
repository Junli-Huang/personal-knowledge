import { defineConfig } from 'vitepress'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'

const contentRoot = resolve(process.cwd(), 'programming')

function collectProgrammingArticles(dir: string): { text: string; link: string }[] {
  return readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name, 'en'))
    .flatMap(entry => {
      const absolute = join(dir, entry.name)
      if (entry.isDirectory()) {
        return collectProgrammingArticles(absolute)
      }
      if (!entry.isFile() || !entry.name.endsWith('.md') || ['README.md', 'index.md'].includes(entry.name)) {
        return []
      }
      const source = readFileSync(absolute, 'utf8')
      const frontmatter = source.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/)
      const title = frontmatter?.[1].match(/^title:\s*(.+)\s*$/m)?.[1]?.trim()
        ?? source.match(/^#\s+(.+)$/m)?.[1]?.trim()
        ?? entry.name.replace(/\.md$/, '')
      const articlePath = relative(contentRoot, absolute).split(sep).join('/').replace(/\.md$/, '')
      return [{ text: title, link: '/programming/' + articlePath }]
    })
}


export default defineConfig({
  lang: 'zh-CN',
  title: 'Personal Knowledge',
  description: '编程、游戏开发、创作与持续学习的个人知识库',
  base: '/personal-knowledge/',
  cleanUrls: true,
  lastUpdated: true,
  ignoreDeadLinks: true,
  themeConfig: {
    siteTitle: 'Personal Knowledge',
    nav: [
      { text: '首页', link: '/' },
      { text: '编程技术', link: '/programming/' },
      { text: '游戏开发', link: '/game-development/' },
      { text: '创作研究', link: '/creative-writing/' },
      { text: '学习笔记', link: '/learning/' },
      { text: 'GitHub', link: 'https://github.com/Junli-Huang/personal-knowledge' }
    ],
    sidebar: [
      {
        text: '编程技术',
        items: [
          { text: '编程技术目录', link: '/programming/' },
          ...collectProgrammingArticles(contentRoot)
        ]
      },
      { text: '其他知识分类', items: [
        { text: '游戏开发', link: '/game-development/' },
        { text: '创作研究', link: '/creative-writing/' },
        { text: '学习笔记', link: '/learning/' },
        { text: '想法与探索', link: '/ideas/' },
        { text: '生活研究', link: '/life/' }
      ] }
    ],
    search: { provider: 'local' },
    socialLinks: [{ icon: 'github', link: 'https://github.com/Junli-Huang/personal-knowledge' }],
    footer: { message: '持续积累，持续修订。', copyright: '© 2026 Personal Knowledge' },
    editLink: { pattern: 'https://github.com/Junli-Huang/personal-knowledge/edit/main/:path', text: '在 GitHub 上编辑' },
    outline: { label: '本页目录', level: [2, 3] },
    lastUpdated: { text: '最近更新' },
    docFooter: { prev: '上一篇', next: '下一篇' },
    returnToTopLabel: '返回顶部',
    darkModeSwitchLabel: '主题',
    sidebarMenuLabel: '目录'
  }
})
