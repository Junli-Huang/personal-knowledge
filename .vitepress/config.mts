import { defineConfig } from 'vitepress'
import { categories, collectArticles, groupArticles } from '../scripts/content-index.mjs'

const sidebar = Object.fromEntries(categories.map(category => {
  const items = [{ text: `${category.title}目录`, link: `/${category.dir}/` }]
  for (const [heading, articles] of groupArticles(collectArticles(category))) {
    items.push({
      text: heading,
      collapsed: false,
      items: articles.map(article => ({ text: article.title, link: article.link }))
    })
  }
  return [`/${category.dir}/`, items]
}))

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
      ...categories.map(category => ({ text: category.title, link: `/${category.dir}/` })),
      { text: 'GitHub', link: 'https://github.com/Junli-Huang/personal-knowledge' }
    ],
    sidebar,
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
