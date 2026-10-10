import type { ReferenceFile } from '@shared/types'
import { mention, type useReferences } from '../references'
import { IconClose } from './icons'

/**
 * A project's reference files under a prompt box: click one to mention it in the prompt, hover for
 * the × that deletes it from .claude-references. Mentioned ones are bone white.
 */
export function ReferenceChips({ refs, text, disabled, onPick }: { refs: ReturnType<typeof useReferences>; text: string; disabled?: boolean; onPick: (r: ReferenceFile) => void }) {
  if (!refs.files.length && !refs.busy && !refs.error) return null
  return (
    <div className="references">
      {refs.files.map((r) => (
        <span key={r.name} className={`reference${text.includes(mention(r)) ? ' is-mentioned' : ''}`}>
          <button className="reference-name" title={`Mention ${r.path} in the prompt`} disabled={disabled} onClick={() => onPick(r)}>
            @{r.name}
          </button>
          <button className="reference-remove" title="Delete from .claude-references" disabled={disabled} onClick={() => refs.remove(r.name)}>
            <IconClose size={10} />
          </button>
        </span>
      ))}
      {refs.busy && <span className="reference-note">Adding to .claude-references…</span>}
      {refs.error && <span className="reference-note">{refs.error}</span>}
    </div>
  )
}
