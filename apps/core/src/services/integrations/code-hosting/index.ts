import { githubCodeHostingAdapter } from '../github/code-hosting'
import { CodeHostingRegistry } from './registry'

// Provider composition belongs here, not in the workflow executor or event router.
export const codeHostingRegistry = new CodeHostingRegistry([githubCodeHostingAdapter])
