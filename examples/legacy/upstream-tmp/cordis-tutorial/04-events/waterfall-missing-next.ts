import type { Context } from '@deepseek-ai/cordis'

declare module '@deepseek-ai/cordis' {
  interface Events {
    'demo/broken'(input: string, next: () => Promise<string>): Promise<string>
  }
}

export const name = 'waterfall-missing-next'

export function apply(ctx: Context): void {
  ctx.on('demo/broken', async (input, _next) => {
    console.log(`observer saw: ${input}`)
    return input
  })

  ctx.on('demo/broken', async (_input, next) => {
    console.log('downstream listener ran')
    return next()
  })

  void (async () => {
    const result = await ctx.waterfall('demo/broken', 'hello', async () => {
      console.log('default behavior ran')
      return 'default result'
    })
    console.log(`final result: ${result}`)
  })()
}
