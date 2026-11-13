import { Service, type Context } from '@deepseek-ai/cordis'

declare module '@deepseek-ai/cordis' {
  interface Context {
    greeter: GreeterService
  }
}

export class GreeterService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'greeter')
  }

  greet(who: string): string {
    return `Hello, ${who}!`
  }
}

export const name = 'greeter'

export function apply(ctx: Context): void {
  ctx.plugin(GreeterService)
}
