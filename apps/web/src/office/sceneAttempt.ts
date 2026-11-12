import { lazy, type ComponentType } from 'react';

/** React caches rejected lazy imports. Only an explicit Retry creates a new attempt. */
export function createSceneAttempt<Props extends object>(load: () => Promise<{ default: ComponentType<Props> }>) {
  return lazy(load);
}
