// Rive animations. The runtime (vendor/rive, loaded by index.html as the global `rive`) fetches its
// WebAssembly from there too, so the recipe works without a network.
rive.RuntimeLoader.setWasmUrl(new URL('../vendor/rive/rive.wasm', import.meta.url).href)
rive.RuntimeLoader.setWasmFallbackUrl(null)

/**
 * Plays a .riv file on a canvas, sized to it: riveAnimation(canvas, 'assets/hero.riv', { stateMachines: 'Main' }).
 * Returns the Rive instance (state machine inputs: instance.stateMachineInputs('Main')). Call cleanup() when the view goes.
 */
export function riveAnimation(canvas, src, options = {}) {
  const instance = new rive.Rive({
    canvas,
    src,
    autoplay: true,
    layout: new rive.Layout({ fit: rive.Fit.Contain }),
    ...options,
    onLoad: (e) => {
      instance.resizeDrawingSurfaceToCanvas()
      options.onLoad?.(e)
    }
  })
  return instance
}
