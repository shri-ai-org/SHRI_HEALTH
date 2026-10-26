/** Build-time settings read through `import.meta.env`. */
interface ImportMetaEnv {
  /** A download of the running commit's source, stamped by CI (Q31, D76, D87). */
  readonly VITE_SOURCE_CODE_URL?: string
}
