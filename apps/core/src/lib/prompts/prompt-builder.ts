/**
 * Prompt Builder
 *
 * Utility for building prompts with consistent formatting.
 * Handles section separators, headers, and lists automatically.
 */

export class PromptBuilder {
  private sections: string[] = []

  /**
   * Add a raw text section (no header).
   */
  text(content: string): this {
    if (content.trim()) {
      this.sections.push(content.trim())
    }
    return this
  }

  /**
   * Add a section with a markdown header.
   * @param title - Section title (## prefix added automatically)
   * @param content - Section content (multiple strings allowed)
   */
  section(title: string, ...content: string[]): this {
    if (content.some((c) => c.trim())) {
      this.sections.push(
        `## ${title}\n\n${content
          .map((c) => c.trim())
          .filter(Boolean)
          .join('\n\n')
          .trim()}`
      )
    }
    return this
  }

  /**
   * Add a subsection with a markdown header.
   * @param title - Subsection title (### prefix added automatically)
   * @param content - Subsection content
   */
  subsection(title: string, content: string): this {
    if (content.trim()) {
      this.sections.push(`### ${title}\n${content.trim()}`)
    }
    return this
  }

  /**
   * Add a section only if the condition is true.
   */
  sectionIf(condition: boolean, title: string, content: string): this {
    if (condition) {
      this.section(title, content)
    }
    return this
  }

  /**
   * Add a subsection only if the condition is true.
   */
  subsectionIf(condition: boolean, title: string, content: string): this {
    if (condition) {
      this.subsection(title, content)
    }
    return this
  }

  /**
   * Add text only if the condition is true.
   */
  textIf(condition: boolean, content: string): this {
    if (condition) {
      this.text(content)
    }
    return this
  }

  /**
   * Add a bullet list section.
   * @param title - Section title
   * @param items - List items (- prefix added automatically)
   */
  list(title: string, items: string[]): this {
    if (items.length > 0) {
      const listContent = items.map((item) => `- ${item}`).join('\n')
      this.section(title, listContent)
    }
    return this
  }

  /**
   * Add another PromptBuilder's content.
   */
  append(other: PromptBuilder): this {
    this.sections.push(...other.sections)
    return this
  }

  /**
   * Build the final prompt string.
   * Sections are joined with double newlines.
   */
  build(): string {
    return this.sections.join('\n\n')
  }

  /**
   * Returns true if no sections have been added.
   */
  isEmpty(): boolean {
    return this.sections.length === 0
  }
}

/**
 * Create a new PromptBuilder instance.
 */
export function prompt(): PromptBuilder {
  return new PromptBuilder()
}

/**
 * Replace all `{{key}}` placeholders in a template with values from a context map.
 * Unresolved placeholders are left as-is.
 *
 * Blank lines left by empty values are collapsed (no double-blank runs).
 */
export function interpolateTemplate(template: string, context: Record<string, string>): string {
  const result = template.replace(/\{\{([^}]+)\}\}/g, (match, key) => {
    const value = context[key.trim()]
    return value !== undefined ? value : match
  })
  // Collapse runs of 3+ newlines into 2 (single blank line)
  return result.replace(/\n{3,}/g, '\n\n')
}
