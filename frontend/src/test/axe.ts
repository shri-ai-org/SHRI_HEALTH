import axe from 'axe-core'

/**
 * Runs axe on the rendered document and returns the violations. Colour contrast is skipped here
 * because jsdom does not compute styles; tokens.test.ts checks contrast from the token values.
 */
export async function axeViolations(root: Element = document.body): Promise<string[]> {
  const result = await axe.run(root, {
    runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] },
    rules: { 'color-contrast': { enabled: false } },
  })
  return result.violations.map((v) => `${v.id}: ${v.help} (${v.nodes.length})`)
}
