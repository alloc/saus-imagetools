# @saus/imagetools

## Usage

```ts
import { serveImages } from '@saus/imagetools'
import { route } from 'saus'

route('/images/*').get(serveImages())
```
