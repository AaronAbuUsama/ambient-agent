import type { AppConfig } from "./config";
import { createAmbientLifecycle, type Ambient } from "./lifecycle";
import { createAppResources } from "./resources";

/**
 * The sole production composition root.
 *
 * Opens every durable resource and hides concrete infrastructure behind the
 * Ambient lifecycle facade.
 */
export async function createAmbient(config: AppConfig): Promise<Ambient> {
  const resources = await createAppResources(config);
  return createAmbientLifecycle(resources);
}
