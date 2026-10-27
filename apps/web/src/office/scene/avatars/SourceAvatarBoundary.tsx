import { Component, type ReactNode } from 'react';

/**
 * A local source model that fails to load or parse falls back to the procedural character
 * instead of ending the whole scene. Remount with a new `key` to retry.
 */
export class SourceAvatarBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  override render() { return this.state.failed ? this.props.fallback : this.props.children; }
}
