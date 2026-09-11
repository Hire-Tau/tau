import { Command, Option } from 'commander'

/** Keep root --version from swallowing a subcommand's version argument. */
export function configureGlobalOptionScope(program: Command) {
  program.enablePositionalOptions()
  const visit = (command: Command) => {
    // Positional root options are no longer inherited after the command name.
    // Preserve the CLI's existing global flags in either position.
    if (!command.options.some((option) => option.long === '--json'))
      command.addOption(new Option('--json', 'Output in JSON format').hideHelp())
    if (!command.options.some((option) => option.long === '--quiet'))
      command.addOption(new Option('--quiet', 'Minimal output').hideHelp())
    if (!command.options.some((option) => option.long === '--backend'))
      command.addOption(new Option('--backend <label>', 'Use a labeled auth backend').hideHelp())
    for (const child of command.commands) visit(child)
  }
  for (const child of program.commands) visit(child)
}
