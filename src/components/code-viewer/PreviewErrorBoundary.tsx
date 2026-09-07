import { Component, type ComponentType, type ReactNode } from "react";

export interface PreviewErrorBoundaryFallbackProps {
  error: Error;
}

interface PreviewErrorBoundaryProps {
  children: ReactNode;
  fallback: ComponentType<PreviewErrorBoundaryFallbackProps>;
  resetKey?: unknown;
}

interface PreviewErrorBoundaryState {
  error: Error | null;
}

/** Keeps render-time preview failures inside the workspace surface. */
export class PreviewErrorBoundary extends Component<
  PreviewErrorBoundaryProps,
  PreviewErrorBoundaryState
> {
  state: PreviewErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: unknown): PreviewErrorBoundaryState {
    return {
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }

  componentDidUpdate(previousProps: PreviewErrorBoundaryProps) {
    if (
      this.state.error &&
      !Object.is(previousProps.resetKey, this.props.resetKey)
    ) {
      this.setState({ error: null });
    }
  }

  render() {
    if (this.state.error) {
      const Fallback = this.props.fallback;
      return <Fallback error={this.state.error} />;
    }
    return this.props.children;
  }
}
