import etag from 'etag'
import {
  applyTransforms,
  builtinOutputFormats,
  builtins as builtinTransforms,
  extractEntries,
  generateTransforms,
  getMetadata,
  resolveConfigs,
  TransformFactory,
} from 'imagetools-core'
import isImage from 'is-image'
import path from 'path'
import { Endpoint, md5Hex } from 'saus/core'
import { Headers } from 'saus/http'
import sharp, { Sharp } from 'sharp'
import { ImageCache } from './utils/cache'

type Awaitable<T> = T | PromiseLike<T>

export type ImageLoader<Params extends {} = {}> = (
  req: Endpoint.Request<Params>
) => Awaitable<Buffer | null | undefined>

export interface ServeOptions<Params extends {} = {}> {
  load: ImageLoader<Params>
  cache?: ImageCache
  allow?:
    | { [searchParam: string]: (string | null)[] }
    | AllowRequestHook<Params>
  headers?: (req: Endpoint.Request<Params>) => Awaitable<Headers>
  transforms?: TransformFactory[]
  removeExifData?:
    | ((req: Endpoint.Request<Params>) => Awaitable<boolean>)
    | boolean
}

type AllowRequestHook<Params extends {}> = (
  req: Endpoint.Request<Params>
) => Awaitable<boolean>

export function serveImages<Params extends {}>(
  options: ServeOptions<Params>
): Endpoint.Function<Params> {
  const factories = builtinTransforms.concat(options.transforms || [])

  let { allow, load, cache } = options
  if (allow && typeof allow !== 'function') {
    const allowedParams = allow
    allow = req => {
      for (const [name, value] of req.searchParams.entries()) {
        if (!allowedParams[name] || !allowedParams[name].includes(value)) {
          return false
        }
      }
      for (const name in allowedParams) {
        if (
          !allowedParams[name].includes(null) &&
          !req.searchParams.has(name)
        ) {
          return false
        }
      }
      return true
    }
  }

  return async req => {
    if (!isImage(req.path)) {
      return
    }
    const reqExtension = path.extname(req.path)
    if (!req.searchParams.has('format')) {
      req.searchParams.set('format', reqExtension.slice(1))
    }
    if (allow && !(allow as AllowRequestHook<Params>)(req)) {
      return
    }

    // Sort the search params to ensure a stable hash.
    req.searchParams.sort()

    const [imageConfig] = resolveConfigs(
      extractEntries(req.searchParams),
      builtinOutputFormats
    )

    const imageId =
      path.basename(req.path, reqExtension) +
      '.' +
      md5Hex(req.toString()).slice(0, 8) +
      '.' +
      req.searchParams.get('format')

    let image: Sharp

    const cachedImage = await cache?.read(imageId)
    if (cachedImage) {
      image = cachedImage
    } else {
      const imageData = await load(req)
      if (!imageData) return

      image = sharp(imageData)

      if (imageConfig) {
        const removeExifData =
          typeof options.removeExifData == 'function'
            ? await options.removeExifData(req)
            : options.removeExifData || false

        const { transforms } = generateTransforms(imageConfig, factories)
        image = (await applyTransforms(transforms, image, removeExifData)).image
      } else {
        // Ensure metadata is attached.
        await applyTransforms([], image)
      }

      cache?.write(imageId, image)
    }

    const imageBuffer = await image.toBuffer()
    const etagHeader = etag(imageBuffer, { weak: true })
    if (req.headers['if-none-match'] == etagHeader) {
      return req.respondWith(304)
    }

    const headers = {
      'Content-Type': `image/${getMetadata(image, 'format')}`,
      'Cache-Control': `max-age=360000`,
      ETag: etagHeader,
    }
    if (options.headers) {
      Object.assign(headers, await options.headers(req))
    }
    req.respondWith(200, headers, {
      buffer: imageBuffer,
    })
  }
}
