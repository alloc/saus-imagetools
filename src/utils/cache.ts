import fs from 'fs'
import { applyTransforms } from 'imagetools-core'
import path from 'path'
import sharp, { Sharp } from 'sharp'

export interface ImageCache {
  read(imageId: string): Promise<Sharp | undefined>
  write(imageId: string, image: Sharp): Promise<void>
}

/**
 * Cache transformed images on disk.
 */
export function makeLocalImageCache(
  root: string,
  cacheDir = 'node_modules/.images'
) {
  cacheDir = path.resolve(root, cacheDir)
  fs.mkdirSync(cacheDir, { recursive: true })

  return {
    async read(imageId: string) {
      let image: Sharp | undefined
      try {
        image = sharp(fs.readFileSync(path.join(cacheDir, imageId)))
        // Ensure metadata is attached.
        await applyTransforms([], image)
      } catch {}

      return image
    },
    async write(imageId: string, image: Sharp) {
      const imageData = await image.toBuffer()
      fs.writeFileSync(path.join(cacheDir, imageId), imageData)
    },
  }
}
