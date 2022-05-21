import fs from 'fs'
import path from 'path'

export function readImage(uri: string, rootDir: string, publicDir?: string) {
  if (publicDir) {
    const publicFile = path.resolve(rootDir, publicDir, uri)
    try {
      return fs.readFileSync(publicFile)
    } catch {}
  }

  const srcFile = path.join(rootDir, uri)
  try {
    return fs.readFileSync(srcFile)
  } catch {}
}
