import type { ResourceFilter, ResourceText } from '../../../shared-types/src/resource.js'

/** Local catalogue operations that can later be registered as DSH tools. */
export interface LocalResourceTool {
  list(filter?: ResourceFilter): Promise<readonly string[]>
  read(resourceId: string): Promise<ResourceText>
}
