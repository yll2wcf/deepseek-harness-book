import type { Context } from '@deepseek-ai/cordis'

export const name = 'needs-timer'
export const inject = ['timer']

export function apply(_ctx: Context): void {
  console.log('needs-timer loaded')
}
