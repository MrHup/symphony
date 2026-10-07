// Monaco, bundled locally (no CDN). Only the editor features and the syntax tokenizers are loaded,
// not the TypeScript/JSON language services, so read-only diffs never show error squiggles and
// the base editor worker is the only worker needed.
import * as monaco from 'monaco-editor/editor/editor.api'
import 'monaco-editor/features/register.all'
import 'monaco-editor/languages/definitions/register.all'
import EditorWorker from 'monaco-editor/editor/editor.worker?worker'
import { loader } from '@monaco-editor/react'

self.MonacoEnvironment = { getWorker: () => new EditorWorker() }
loader.config({ monaco })

// Monochrome syntax; the diff tints are the only color, kept muted and well below the signal.
monaco.editor.defineTheme('symphony', {
  base: 'vs-dark',
  inherit: true,
  rules: [
    { token: '', foreground: 'D9D5CC' },
    { token: 'comment', foreground: '6E6B64', fontStyle: 'italic' },
    { token: 'keyword', foreground: 'F2EEE6', fontStyle: 'bold' },
    { token: 'string', foreground: 'ADA99F' },
    { token: 'number', foreground: 'C8C4BA' },
    { token: 'type', foreground: 'E9E5DC' },
    { token: 'delimiter', foreground: '8D8A82' },
    { token: 'tag', foreground: 'E9E5DC' },
    { token: 'attribute.name', foreground: 'B7B3AA' },
    { token: 'keyword.md', foreground: 'F2EEE6', fontStyle: 'bold' },
    { token: 'strong', fontStyle: 'bold' },
    { token: 'emphasis', fontStyle: 'italic' }
  ],
  colors: {
    'editor.background': '#131312',
    'editor.foreground': '#D9D5CC',
    'editorLineNumber.foreground': '#4A4844',
    'editorLineNumber.activeForeground': '#8D8A82',
    'editor.lineHighlightBackground': '#1A1A18',
    'editor.lineHighlightBorder': '#00000000',
    'editor.selectionBackground': '#3B3A36',
    'editor.inactiveSelectionBackground': '#2A2926',
    'editorCursor.foreground': '#E9E5DC',
    'editorIndentGuide.background1': '#222220',
    'editorIndentGuide.activeBackground1': '#3B3A36',
    'editorWhitespace.foreground': '#2A2926',
    'editorGutter.background': '#131312',
    'editorWidget.background': '#1A1A18',
    'editorWidget.border': '#3B3A36',
    'input.background': '#0E0E0D',
    'focusBorder': '#5E5C56',
    'scrollbarSlider.background': '#3B3A3666',
    'scrollbarSlider.hoverBackground': '#3B3A36AA',
    'scrollbarSlider.activeBackground': '#5E5C56AA',
    'diffEditor.insertedTextBackground': '#7E9C7033',
    'diffEditor.removedTextBackground': '#B0685E33',
    'diffEditor.insertedLineBackground': '#7E9C701C',
    'diffEditor.removedLineBackground': '#B0685E1C',
    'diffEditorGutter.insertedLineBackground': '#7E9C7026',
    'diffEditorGutter.removedLineBackground': '#B0685E26',
    'diffEditorOverview.insertedForeground': '#7E9C7066',
    'diffEditorOverview.removedForeground': '#B0685E66',
    'diffEditor.diagonalFill': '#2A292655',
    'diffEditor.unchangedRegionBackground': '#171716',
    'diffEditor.unchangedRegionForeground': '#8D8A82',
    'diffEditor.unchangedCodeBackground': '#17171600',
    'diffEditor.border': '#2A2926',
    'editorOverviewRuler.border': '#00000000',
    // Bracket pair colors are forced to the text grey: the diff editor does not always honour the
    // bracketPairColorization option, and colored brackets would break the one-color rule.
    'editorBracketHighlight.foreground1': '#D9D5CC',
    'editorBracketHighlight.foreground2': '#D9D5CC',
    'editorBracketHighlight.foreground3': '#D9D5CC',
    'editorBracketHighlight.foreground4': '#D9D5CC',
    'editorBracketHighlight.foreground5': '#D9D5CC',
    'editorBracketHighlight.foreground6': '#D9D5CC',
    'editorBracketHighlight.unexpectedBracket.foreground': '#D9D5CC',
    'editorBracketMatch.background': '#00000000',
    'editorBracketMatch.border': '#00000000'
  }
})

export function languageFor(path: string): string {
  const name = path.split(/[\\/]/).pop()?.toLowerCase() ?? ''
  const ext = name.includes('.') ? `.${name.split('.').pop()}` : ''
  if (ext === '.json' || ext === '.jsonc') return 'javascript'
  for (const lang of monaco.languages.getLanguages()) {
    if (lang.filenames?.some((f) => f.toLowerCase() === name)) return lang.id
    if (ext && lang.extensions?.includes(ext)) return lang.id
  }
  return 'plaintext'
}

export const editorFont = {
  fontFamily: "'IBM Plex Mono', ui-monospace, 'Cascadia Mono', Menlo, monospace",
  fontSize: 12.5,
  lineHeight: 20
}
