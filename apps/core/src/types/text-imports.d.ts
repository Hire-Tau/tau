// Ambient declarations for Bun's `with { type: 'text' }` import attribute, which
// inlines a file's contents as a string at build time. tsc doesn't know the
// shape of a `.sh` module import on its own, so declare it here.
declare module '*.sh' {
  const content: string
  export default content
}
