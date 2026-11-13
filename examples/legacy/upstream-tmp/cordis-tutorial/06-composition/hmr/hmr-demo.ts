import type { Context } from '@deepseek-ai/cordis'

export const name = 'hmr-demo'

const VERSION = 'v1'

export function apply(ctx: Context): void {
  console.log(`hmr demo ${VERSION} loaded`)
  ctx.effect(() => () => {
    console.log(`hmr demo ${VERSION} cleaned`)
  })
}
