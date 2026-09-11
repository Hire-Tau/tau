import { createInterface } from 'readline/promises'
import type { Prompter } from './options'

/** Interactive prompter on the controlling terminal (stderr keeps stdout clean for --json). */
export function terminalPrompter(): Prompter {
  const ask = async (question: string): Promise<string> => {
    const rl = createInterface({ input: process.stdin, output: process.stderr })
    try {
      return (await rl.question(question)).trim()
    } finally {
      rl.close()
    }
  }
  return {
    async select(question, choices) {
      process.stderr.write(`\n${question}\n`)
      choices.forEach((c, i) => process.stderr.write(`  ${i + 1}) ${c.label}\n`))
      for (;;) {
        const answer = await ask(`Choose [1-${choices.length}]: `)
        const idx = Number(answer) - 1
        if (Number.isInteger(idx) && choices[idx]) return choices[idx].value
        const byValue = choices.find((c) => c.value === answer)
        if (byValue) return byValue.value
      }
    },
    async confirm(question) {
      const answer = await ask(`${question} [Y/n] `)
      return answer === '' || /^y(es)?$/i.test(answer)
    },
  }
}
