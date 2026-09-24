/**
 * DSH slot registration kept independent from the React implementation so
 * the plugin contract can be tested without loading the browser bundle.
 */
export interface MonashStudySlotContext {
  readonly slots: {
    inject(name: string, factory: () => () => void): () => void
    register(options: Record<string, unknown>, component: unknown): () => void
  }
}

export const inject = ['slots', 'layout', 'remote', 'locale'] as const

export function registerMonashStudySlots(
  ctx: MonashStudySlotContext,
  sidebarIcon: unknown,
  mainPage: unknown,
): () => void {
  const disposePanel = ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: 'monash-study',
    order: 15,
    label: 'Monash Study',
  }, sidebarIcon))
  const disposeMain = ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: 'monash-study',
  }, mainPage))
  return () => {
    disposeMain()
    disposePanel()
  }
}
