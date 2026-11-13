import type { Context } from '@deepseek-ai/cordis'
import type {} from './greeter.ts'

export const name = 'consumer'
export const inject = ['greeter']

export function apply(ctx: Context): void {
  console.log(ctx.greeter.greet('world'))
}
