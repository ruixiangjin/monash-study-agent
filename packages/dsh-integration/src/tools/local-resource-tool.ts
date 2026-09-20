import type { ResourceFilter, ResourceText } from '@monash-study/shared-types'

/** Local catalogue operations that can later be registered as DSH tools. */
export interface LocalResourceTool {
  list(filter?: ResourceFilter): Promise<readonly string[]>
  read(resourceId: string): Promise<ResourceText>
}
