interface BuildInfo {
  version: string
  commit: string
  buildDate: string
}

let generatedBuildInfo: BuildInfo

try {
  generatedBuildInfo = (await import('./build-info.generated')).generatedBuildInfo
} catch {
  generatedBuildInfo = {
    version: 'dev',
    commit: 'dev',
    buildDate: 'dev',
  }
}

export const buildInfo = generatedBuildInfo
