// A submit tried with something missing or wrong: once the form has drawn its
// field messages, bring the first marked field into view and put the cursor
// there, so the desk sees exactly what to fix instead of a dead button.
export function revealFirstInvalid(root: ParentNode = document): void {
  window.requestAnimationFrame(() => {
    // A field marked invalid, or a choice's message (`data-invalid`) where there is no single field.
    const field = root.querySelector<HTMLElement>('[aria-invalid="true"], [data-invalid="true"]')
    if (!field) return
    field.scrollIntoView({ behavior: 'smooth', block: 'center' })
    // A marked group (a field's wrapper) hands the cursor to its first control.
    const control = field.matches('input, select, textarea, button') ? field : (field.querySelector<HTMLElement>('input, select, textarea, button') ?? field)
    control.focus({ preventScroll: true })
  })
}
