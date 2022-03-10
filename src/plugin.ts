import createDebug from 'debug'
import fs from 'fs'
import {
  applyTransforms,
  builtinOutputFormats,
  builtins as builtinTransforms,
  extractEntries,
  generateTransforms,
  getMetadata,
  resolveConfigs,
} from 'imagetools-core'
import isImage from 'is-image'
import { green } from 'kleur/colors'
import path from 'path'
import { Plugin, vite } from 'saus'
import { md5Hex } from 'saus/core'
import sharp, { Sharp } from 'sharp'

const debug = createDebug('saus:imagetools')
const noop = () => undefined

type Headers = Record<string, string | string[]>
type Awaitable<T> = T | PromiseLike<T>
type ImageLoader = (
  uri: string,
  params: URLSearchParams
) => Awaitable<Buffer | null | undefined>

export interface Options {
  /**
   * Control how images are loaded into memory.
   *
   * By default, they are loaded from `publicDir` (if possible), else
   * the URI is resolved to an absolute path (relative to project root).
   *
   * If this `load` hook returns null or undefined, the default loading
   * strategy is used. If no image is found, a 404 response will likely
   * occur, unless another plugin handles the request.
   */
  load?: ImageLoader
  /** @default "node_modules/.images" */
  cacheDir?: string | false
  /** @default false */
  removeExifData?:
    | boolean
    | ((uri: string, params: URLSearchParams) => Awaitable<boolean>)
  /** Customize the response headers during development. */
  devHeaders?:
    | Headers
    | ((uri: string, params: URLSearchParams) => Awaitable<Headers>)
}

/**
 * Convert images to WebP format.
 *
 * Images imported by JS modules are converted by default.  \
 * Add the `copyPublicDir` plugin to convert images in `public` directory as well.
 */
export function imageTools(options: Options = {}): Plugin {
  let loadImage = options.load || noop
  let cacheDir: string | false

  return {
    name: '@saus/imagetools',
    enforce: 'pre',
    configureServer(server) {
      cacheDir =
        options.cacheDir !== false &&
        path.resolve(
          server.config.root,
          options.cacheDir || 'node_modules/.images'
        )

      if (cacheDir) {
        fs.mkdirSync(cacheDir, { recursive: true })
      }

      server.middlewares.use(async (req, res, next) => {
        const [uri, query] = req.url!.split(/\?(.+)$/)
        if (!isImage(uri) || !query) {
          return next()
        }

        const uriExtension = path.extname(uri)
        const params = new URLSearchParams(query)
        if (!params.has('format')) {
          params.set('format', uriExtension.slice(1))
        }

        // Sort the search params to keep the URI hash stable.
        params.sort()

        const [imageConfig] = resolveConfigs(
          extractEntries(params),
          builtinOutputFormats
        )
        if (!imageConfig) {
          return next()
        }

        const imageId =
          path.basename(uri, uriExtension) +
          '.' +
          md5Hex(uri + '?' + params.toString()).slice(0, 8) +
          '.' +
          params.get('format')

        let image: Sharp | undefined
        if (cacheDir)
          try {
            image = sharp(fs.readFileSync(path.join(cacheDir, imageId)))
            // Ensure metadata is attached.
            await applyTransforms([], image)
          } catch {}

        if (!image) {
          let imageData = await loadImage(uri, params)
          if (!imageData) {
            imageData = readImage(server.config, uri)
            if (!imageData) {
              return next()
            }
          }

          image = sharp(imageData)

          const removeExifData =
            typeof options.removeExifData == 'function'
              ? await options.removeExifData(uri, params)
              : options.removeExifData || false

          const { transforms } = generateTransforms(
            imageConfig,
            builtinTransforms
          )

          const result = await applyTransforms(
            transforms,
            image,
            removeExifData
          )

          image = result.image

          if (cacheDir) {
            imageData = await image.toBuffer()
            if (imageData) {
              fs.writeFileSync(path.join(cacheDir, imageId), imageData)
              debug(
                'Saved %s (%O kb) in image cache',
                green(imageId),
                (imageData.length / 1024).toFixed(2)
              )
            }
          }
        }

        const headers =
          typeof options.devHeaders == 'function'
            ? await options.devHeaders(uri, params)
            : options.devHeaders

        res.writeHead(200, {
          'Content-Type': `image/${getMetadata(image, 'format')}`,
          'Cache-Control': `max-age=360000`,
          ...headers,
        })

        image.pipe(res, { end: true })
      })
    },
  }
}

function readImage(config: vite.ResolvedConfig, uri: string) {
  if (config.publicDir) {
    const publicDir = path.resolve(config.root, config.publicDir)
    const publicFile = path.join(publicDir, uri)
    try {
      return fs.readFileSync(publicFile)
    } catch {}
  }

  const srcFile = path.join(config.root, uri)
  try {
    return fs.readFileSync(srcFile)
  } catch {}
}
