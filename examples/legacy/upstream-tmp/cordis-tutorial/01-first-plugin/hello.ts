import type { Context } from '@deepseek-ai/cordis'

export const name = 'hello'

export function apply(_ctx: Context): void {
  console.log('hello from my first plugin')
}
