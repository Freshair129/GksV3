/**
 * Markdown chunker — splits a markdown doc into chunks suitable for embedding.
 *
 * Contract from BLUEPRINT--memory §layers.vector.stores.atomic.chunk_strategy:
 *   by: "heading + max_tokens", max_tokens: 512, overlap: 64
 *
 * Strategy:
 *   1. Strip frontmatter (keep it aside as metadata).
 *   2. Split on ATX/Setext headings into "sections" — each carries its heading
 *      path (e.g. ["Introduction", "Why?"]).
 *   3. Each section is split into token-budget windows with `overlap` tokens of
 *      carry-over, so a chunk never ends mid-sentence (best effort).
 *
 * Token counting: we use a word/punct-ish heuristic (~0.75 * Claude tokens) to
 * avoid a tokenizer dependency. Accurate enough for chunk sizing; exact budget
 * accounting lives elsewhere (the LLM client).
 */

export interface Chunk {
  text: string
  heading: string
  headingPath: string[]
  start: number
  end: number
  tokenCount: number
}

export interface ChunkOptions {
  maxTokens?: number
  overlap?: number
  /** If true, strip frontmatter (--- ... ---) before chunking. Default true. */
  stripFrontmatter?: boolean
}

export interface ChunkedDoc {
  frontmatter: string | null
  chunks: Chunk[]
}

export function chunkMarkdown(source: string, opts: ChunkOptions = {}): ChunkedDoc {
  const maxTokens = opts.maxTokens ?? 512
  const overlap = opts.overlap ?? 64
  const strip = opts.stripFrontmatter ?? true

  let text = source
  let frontmatter: string | null = null
  if (strip) {
    const stripped = stripFrontmatter(source)
    frontmatter = stripped.frontmatter
    text = stripped.body
  }

  const sections = splitByHeadings(text)
  const chunks: Chunk[] = []
  for (const section of sections) {
    const sectionChunks = chunkSection(section, { maxTokens, overlap })
    for (const c of sectionChunks) chunks.push(c)
  }

  return { frontmatter, chunks }
}

function stripFrontmatter(source: string): { frontmatter: string | null; body: string } {
  if (!source.startsWith('---')) return { frontmatter: null, body: source }
  const end = source.indexOf('\n---', 3)
  if (end === -1) return { frontmatter: null, body: source }
  const fm = source.slice(3, end).trim()
  const body = source.slice(end + 4).replace(/^\s*\n/, '')
  return { frontmatter: fm, body }
}

interface Section {
  headingPath: string[]
  heading: string
  body: string
  start: number
  end: number
}

function splitByHeadings(text: string): Section[] {
  const lines = text.split('\n')
  const sections: Section[] = []
  const path: Array<{ level: number; title: string }> = []

  let currentStart = 0
  let currentLines: string[] = []
  let currentHeading = ''
  let currentPath: string[] = []
  let offset = 0

  function flush(endOffset: number) {
    if (currentLines.length === 0) return
    const body = currentLines.join('\n').trim()
    if (body.length === 0) return
    sections.push({
      headingPath: [...currentPath],
      heading: currentHeading,
      body,
      start: currentStart,
      end: endOffset,
    })
  }

  for (const line of lines) {
    const atx = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line)
    if (atx) {
      // End the previous section at this offset.
      flush(offset)
      const level = atx[1]!.length
      const title = atx[2]!.trim()
      // Pop stack to the right level.
      while (path.length > 0 && path[path.length - 1]!.level >= level) path.pop()
      path.push({ level, title })
      currentHeading = title
      currentPath = path.map((p) => p.title)
      currentLines = []
      currentStart = offset
    } else {
      currentLines.push(line)
    }
    offset += line.length + 1 // +1 for the newline we lost
  }
  flush(offset)

  // Handle the case of a prelude (content before any heading).
  if (sections.length === 0 || sections[0]!.start > 0) {
    // Nothing — prelude is already captured above by the flush-on-empty-path
    // branch (the first flush happens when we see the first heading).
  }

  return sections
}

function chunkSection(
  section: Section,
  opts: { maxTokens: number; overlap: number },
): Chunk[] {
  const heading = section.heading
  const prefix = section.headingPath.length > 0
    ? `# ${section.headingPath.join(' > ')}\n\n`
    : ''
  const fullText = prefix + section.body
  const tokens = estimateTokens(fullText)
  if (tokens <= opts.maxTokens) {
    return [
      {
        text: fullText,
        heading,
        headingPath: section.headingPath,
        start: section.start,
        end: section.end,
        tokenCount: tokens,
      },
    ]
  }

  // Paragraph-granularity windowing with overlap.
  const paragraphs = splitParagraphs(section.body)
  const chunks: Chunk[] = []
  let window: string[] = []
  let windowTokens = 0
  const headingTokens = estimateTokens(prefix)

  for (let i = 0; i < paragraphs.length; i++) {
    const p = paragraphs[i]!
    const pTokens = estimateTokens(p)

    if (windowTokens + pTokens + headingTokens > opts.maxTokens && window.length > 0) {
      chunks.push({
        text: prefix + window.join('\n\n'),
        heading,
        headingPath: section.headingPath,
        start: section.start,
        end: section.end,
        tokenCount: windowTokens + headingTokens,
      })
      // Overlap: keep last few paragraphs so the next chunk has context.
      window = tailParagraphs(window, opts.overlap)
      windowTokens = window.reduce((a, x) => a + estimateTokens(x), 0)
    }

    window.push(p)
    windowTokens += pTokens
  }

  if (window.length > 0) {
    chunks.push({
      text: prefix + window.join('\n\n'),
      heading,
      headingPath: section.headingPath,
      start: section.start,
      end: section.end,
      tokenCount: windowTokens + headingTokens,
    })
  }

  return chunks
}

function splitParagraphs(text: string): string[] {
  return text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
}

function tailParagraphs(window: string[], overlapTokens: number): string[] {
  if (overlapTokens <= 0 || window.length === 0) return []
  const out: string[] = []
  let acc = 0
  for (let i = window.length - 1; i >= 0; i--) {
    const p = window[i]!
    const t = estimateTokens(p)
    if (acc + t > overlapTokens && out.length > 0) break
    out.unshift(p)
    acc += t
  }
  return out
}

/**
 * Rough token estimate — counts "words" (alphanum runs) + punctuation.
 * Empirically ~1.3× the true word count, which lines up reasonably well with
 * Claude's tokenizer on English prose without a runtime dep. Good enough for
 * chunk sizing; not for billing.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0
  const matches = text.match(/\S+/g)
  return matches ? Math.ceil(matches.length * 1.3) : 0
}
