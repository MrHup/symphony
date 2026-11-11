# Images

Images makes images with Google's Gemini image models: from prompts, from reference images, or both,
one image per prompt. It can also make **cut-outs** and **icons** (the background removed, the subject
framed to fill the image) and show them as **die-cut stickers**, and download everything at once as a
zip.

## Prepare

- **A Gemini API key** on the machine that makes the images (this PC, or a remote machine). Get one at
  [aistudio.google.com/apikey](https://aistudio.google.com/apikey). Images are billed to that Google
  account, not to your Claude subscription.
- Nothing else: no Python, no SDK. Symphony calls the Gemini API directly.

The key is set in the panel. If `GEMINI_API_KEY` (or `GOOGLE_API_KEY`) is set in the environment
Symphony starts in, that key is used and the panel says so; a key saved in the panel takes its place.
Gemini checks a key before it is saved. It is kept on that machine, encrypted by the system keychain
(DPAPI on Windows, Keychain on macOS; on a headless machine, in its data folder, readable by your user
only), and it is never shown again or sent to another machine. The panel shows only its last four
characters.

## Use

1. Click the tools button in the dock and pick **Images**.
2. Pick the machine that makes the images. Without a key there, the panel asks for one first.
3. Write prompts, one per line: each line makes one image. Optionally:
   - a **style**, added to every prompt. On its own, without prompts, it is the prompt for one image.
   - **reference images** (up to 6): **Add reference images…**, or paste or drop them on the form.
     **Match their style** makes new images in their style; **Use them as input** lets the prompt work
     on them ("put this logo on a mug", "make this photo look like winter").
4. Pick what to make:
   - **Image**: kept as generated, at the aspect ratio you pick.
   - **Cut-out**: one subject on white, made transparent and framed to fill the image.
   - **Icon**: a square cut-out, in a flat vector style unless references or a style say otherwise.
5. Pick the model and the output size, then **Generate** (Ctrl/⌘+Enter). The form shows about what the
   batch costs. Up to four images are made at once per machine; the rest wait their turn. Closing the
   panel does not stop them.

Then, under the form:

- Click an image to see it over the whole window (← → between images, click for actual size).
- Edit an image's prompt and press Enter (or ↻) to make it again with the same settings.
- **Die-cut sticker** shows cut-outs and icons with a white border that follows their outline, and
  downloads them that way. No new images are made.
- The size menu sets the long edge of downloads (Full size keeps the generated size).
- ↓ downloads one image; **Download all** saves `images.zip`, one file per image, named after its
  prompt. Symphony asks where to save.
- The bin deletes an image (click it twice); **Clear** deletes all of them.

The panel lists the images of every machine. Each is stored on the machine that made it, in
Symphony's data folder under `tools/images/`, with the reference images it was made from, so it can be
made again later.

## Models

| Model | ID | Sizes | Price per image |
|---|---|---|---|
| Flash Lite | `gemini-3.1-flash-lite-image` | 1K | $0.034 |
| Flash | `gemini-3.1-flash-image` | 512 px, 1K, 2K, 4K | $0.045, $0.067, $0.101, $0.151 |
| Nano Banana 2.1 | `gemini-nano-banana-2.1` | 1K, 2K, 4K | $0.034, $0.050, $0.113 |
| Pro | `gemini-3-pro-image` | 1K, 2K, 4K | $0.134, $0.134, $0.24 |

Prices are from the Gemini API pricing page (paid tier) in October 2026; the cost shown in the form
uses them, so check the page if they change. Flash at 512 px is the cheapest way to make icons that
end up at 256 px or smaller.

## How it works

- **Prompt** (`gemini.ts`): reference images and fixed instructions first, then the style, then the
  prompt line. Shared content stays at the front of every request, so implicit caching applies if
  these models ever support it. Cut-outs and icons ask for one centered subject on pure white, drawn
  as large as possible, with light gray instead of white for white parts (white is removed
  afterwards).
- **Request**: `generateContent` with an image response, the aspect ratio and the size. Rate limits
  (429) and server errors are tried three times in all, with a pause between attempts.
- **Cut-out** (`imaging.ts`, run in a worker in the window): near-white pixels become transparent,
  enclosed gaps included. Edge pixels, which blend the subject's color with white, take the nearest
  solid color, with alpha for how much of it they hold, so there are no white halos. The subject is
  cropped and scaled to fill the generated size, with a 0.8% margin (2 px at 256).
- **Die-cut sticker**: a white border traced around the outer silhouette, with interior gaps filled,
  4.5% of the subject's longest side wide. Both versions are made once per image, so switching is
  instant.
- This is the Icon Generator's processing, ported from numpy/scipy to TypeScript.

## Limits

- Nothing is made again on its own after Symphony restarts: unfinished images show as stopped, and
  you choose which to make again, since each one costs money.
- An image larger than about 24 MB cannot be shown from a remote machine (it has to cross the link in
  one message). Generated images are far smaller.
- Gemini can refuse a prompt; the image then shows why ("No image returned (SAFETY)" and similar).
- Cut-outs remove white, so a subject on another background, or one that is mostly white, does not
  cut out well. The prompt asks for white backgrounds for that reason.
