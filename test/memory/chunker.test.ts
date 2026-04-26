import { describe, it, expect } from 'vitest'
import { chunkMarkdown, estimateTokens } from '../../src/memory/vector/chunker.js'

describe('estimateTokens', () => {
  it('returns 0 for empty', () => {
    expect(estimateTokens('')).toBe(0)
  })
  it('scales roughly linearly with word count', () => {
    const small = estimateTokens('one two three')
    const big = estimateTokens('one two three four five six seven eight nine ten')
    expect(big).toBeGreaterThan(small)
  })
})

describe('chunkMarkdown', () => {
  it('strips frontmatter and keeps it aside', () => {
    const src = '---\nid: X\n---\n\n# Title\n\nBody.'
    const { frontmatter, chunks } = chunkMarkdown(src)
    expect(frontmatter).toContain('id: X')
    expect(chunks.length).toBeGreaterThan(0)
    expect(chunks.some((c) => c.text.includes('Body'))).toBe(true)
  })

  it('splits by ATX headings and records a headingPath', () => {
    const src = `# Top\n\nintro text.\n\n## A\n\npara a.\n\n## B\n\npara b.`
    const { chunks } = chunkMarkdown(src, { maxTokens: 512 })
    const headings = chunks.map((c) => c.heading)
    expect(headings).toContain('Top')
    expect(headings).toContain('A')
    expect(headings).toContain('B')
    const aChunk = chunks.find((c) => c.heading === 'A')!
    expect(aChunk.headingPath).toEqual(['Top', 'A'])
  })

  it('respects maxTokens and produces overlap', () => {
    // Build a long section with several paragraphs.
    const para = (n: number) =>
      Array.from({ length: 20 }, (_, i) => `word${n}-${i}`).join(' ')
    const src =
      `# Big\n\n` + Array.from({ length: 10 }, (_, i) => para(i)).join('\n\n')
    const { chunks } = chunkMarkdown(src, { maxTokens: 60, overlap: 20 })
    expect(chunks.length).toBeGreaterThan(1)
    for (const c of chunks) {
      expect(c.tokenCount).toBeLessThanOrEqual(80) // maxTokens + heading slack
    }
    // Consecutive chunks should share some paragraph text (overlap window).
    const [a, b] = chunks
    if (a && b) {
      const lastParaA = a.text.split('\n\n').slice(-1)[0] ?? ''
      expect(b.text).toContain(lastParaA.slice(0, 20))
    }
  })

  it('keeps short sections as a single chunk with heading prefix', () => {
    const src = `# Title\n\nshort body.`
    const { chunks } = chunkMarkdown(src, { maxTokens: 512 })
    expect(chunks).toHaveLength(1)
    expect(chunks[0]!.text).toMatch(/^# Title/)
    expect(chunks[0]!.text).toContain('short body')
  })

  it('handles heading nesting correctly', () => {
    const src = `# H1\n\na.\n\n## H2\n\nb.\n\n### H3\n\nc.\n\n## H2b\n\nd.`
    const { chunks } = chunkMarkdown(src)
    const h3 = chunks.find((c) => c.heading === 'H3')!
    expect(h3.headingPath).toEqual(['H1', 'H2', 'H3'])
    const h2b = chunks.find((c) => c.heading === 'H2b')!
    expect(h2b.headingPath).toEqual(['H1', 'H2b']) // H3 popped, H2 replaced by H2b
  })
})
