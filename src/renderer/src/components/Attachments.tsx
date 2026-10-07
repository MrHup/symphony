import type { ImageInput } from '@shared/types'
import { IconClose } from './icons'

/** Thumbnails of pasted images above a prompt box; each can be removed before sending. */
export function Attachments({ images, onRemove }: { images: ImageInput[]; onRemove: (index: number) => void }) {
  if (!images.length) return null
  return (
    <div className="attachments">
      {images.map((img, i) => (
        <div key={i} className="attachment">
          <img src={img.thumb} alt={`Pasted image ${i + 1}`} />
          <button className="attachment-remove" title="Remove image" onClick={() => onRemove(i)}>
            <IconClose size={10} />
          </button>
        </div>
      ))}
    </div>
  )
}
