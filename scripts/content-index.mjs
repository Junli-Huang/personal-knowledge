import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

export const categories = [
  { dir: 'programming', title: '编程技术', description: '整理 C++、网络编程、算法和工程实践中的问题与实验。' },
  { dir: 'game-development', title: '游戏开发', description: '记录玩法设计、系统机制、原型实验和开发过程中的可复用经验。' },
  { dir: 'creative-writing', title: '创作研究', description: '整理写作技巧、叙事结构与世界观研究。' },
  { dir: 'learning', title: '学习笔记', description: '记录数学、语言、绘画及跨领域学习。' },
  { dir: 'ideas', title: '想法与探索', description: '保存尚在形成中的灵感、假设与研究。' },
  { dir: 'life', title: '生活研究', description: '记录适合公开分享的日常经验与资料。' }
]

const root = resolve(process.cwd())
const directoryLabels = { cpp: 'C++' }

export function collectArticles(category) {
  const base = resolve(root, category.dir)
  const articles = []

  function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      const absolute = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (!entry.name.startsWith('.')) walk(absolute)
        continue
      }
      if (!entry.isFile() || !entry.name.endsWith('.md') || ['README.md', 'index.md'].includes(entry.name)) continue
      const source = readFileSync(absolute, 'utf8')
      const frontmatter = source.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/)
      const meta = frontmatter?.[1] ?? ''
      // draft 只控制网站索引，不提供隐私保护：本仓库本身为 Public。
      if (/^status:\s*['"]?draft['"]?\s*$/m.test(meta)) continue
      const title = meta.match(/^title:\s*(.+?)\s*$/m)?.[1]?.trim().replace(/^['"]|['"]$/g, '')
        ?? source.match(/^#\s+(.+)$/m)?.[1]?.trim()
        ?? entry.name.slice(0, -3)
      const createdRaw = meta.match(/^created:\s*(.+?)\s*$/m)?.[1]?.trim().replace(/^['"]|['"]$/g, '') ?? ''
      // ISO 8601 日期或时间；未提供有效日期的旧文章排在最后。
      const created = /^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(createdRaw)
        ? Date.parse(createdRaw)
        : NaN
      const createdAt = Number.isFinite(created) ? created : -Infinity
      const slug = relative(base, absolute).split(sep).join('/').replace(/\.md$/, '')
      const folder = slug.includes('/') ? slug.slice(0, slug.lastIndexOf('/')) : ''
      articles.push({ title, link: `/${category.dir}/${slug}`, folder, createdAt })
    }
  }

  walk(base)
  return articles.sort((a, b) => a.folder.localeCompare(b.folder, 'en') || b.createdAt - a.createdAt || a.link.localeCompare(b.link, 'en'))
}

export function groupArticles(articles) {
  const groups = new Map()
  for (const article of articles) {
    const heading = article.folder
      ? article.folder.split('/').map(part => directoryLabels[part] ?? part).join(' / ')
      : '其他'
    if (!groups.has(heading)) groups.set(heading, [])
    groups.get(heading).push(article)
  }
  return groups
}

export function generateCategoryPages() {
  for (const category of categories) {
    const groups = groupArticles(collectArticles(category))
    const lines = [
      '<!-- 此页面由 scripts/content-index.mjs 自动生成；不要手工维护文章链接。 -->',
      `# ${category.title}`,
      '',
      category.description,
      ''
    ]
    if (!groups.size) lines.push('暂无文章。', '')
    for (const [heading, articles] of groups) {
      lines.push(`## ${heading}`, '')
      for (const article of articles) {
        // VitePress cleanUrls：链接不带 .md；在构建时由站点路由解析。
        lines.push(`- [${article.title}](${article.link})`)
      }
      lines.push('')
    }
    writeFileSync(resolve(root, category.dir, 'index.md'), lines.join('\n'), 'utf8')
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  generateCategoryPages()
}
