import { Component } from "react";
import type { ErrorInfo, ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("Uncaught renderer error:", error, info.componentStack);
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div className="flex h-screen flex-col items-center justify-center gap-4 bg-[#0f0f10] p-8">
          <div className="text-4xl">&#x1F61E;</div>
          <h1 className="text-lg font-medium text-white">Something went wrong</h1>
          <pre className="max-w-lg overflow-auto rounded-lg border border-[#26262c] bg-[#16161a] p-4 text-xs text-[#8b8b92]">
            {this.state.error.message}
          </pre>
          <button
            className="rounded-md bg-[#d97706] px-4 py-2 text-sm font-medium text-white hover:bg-[#b45309]"
            onClick={() => this.setState({ error: null })}
          >
            Try again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
