import DOMPurify from 'dompurify'
import { marked } from 'marked'
import { memo, useMemo } from 'react'

marked.setOptions({ gfm: true, breaks: false })

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  const html = useMemo(() => DOMPurify.sanitize(marked.parse(text, { async: false }) as string), [text])
  return (
    <div
      className="md"
      dangerouslySetInnerHTML={{ __html: html }}
      onClick={(e) => {
        // Links open in the system browser (the main process routes window.open there).
        const a = (e.target as Element).closest('a')
        if (a?.href) {
          e.preventDefault()
          window.open(a.href)
        }
      }}
    />
  )
})
