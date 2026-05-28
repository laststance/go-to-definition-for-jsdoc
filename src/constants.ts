export const MAX_DEFINITION_RESULTS = 20

export const MAX_SOURCE_SCAN_FILES = 2000

export const MIN_SOURCE_SCAN_FILES = 1

export const SOURCE_FILE_GLOB = '**/*.{ts,tsx,js,jsx}'

export const DEFAULT_IGNORED_WORKSPACE_GLOB = '**/{node_modules,dist,out,build,coverage,.next,.turbo,.git}/**'

export const SUPPORTED_SOURCE_FILE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx'] as const

export const IGNORED_WORKSPACE_DIRECTORY_NAMES = [
  'node_modules',
  'dist',
  'out',
  'build',
  'coverage',
  '.next',
  '.turbo',
  '.git',
] as const
