// SHRI_HEALTH: fix-webm-duration is not installed (video visits are not in the demo, D108).
// Vite and TypeScript alias the package here, so src/shri/telehealth/AfterVisit.tsx stays unchanged.
// TODO: decide on video visits (a vendor that signs a BAA) before reusing the recorder.
export default function fixWebmDuration(blob: Blob, _duration?: number, _options?: unknown): Promise<Blob> {
  return Promise.resolve(blob)
}
