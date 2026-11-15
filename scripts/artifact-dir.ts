import { join } from 'node:path'

export function artifactDirs(repoRoot: string, sha: string) {
  const configured = process.env.ARTIFACTS_DIR || process.env.ATLAS_ARTIFACTS_DIR
  if (configured) return [configured]
  return [join(repoRoot, 'artifacts', sha), '/opt/cursor/artifacts']
}
