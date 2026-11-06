import { Component, type ReactNode } from "react";
import { errorMessage } from "../lib/errors";

interface State {
  error: unknown;
}

/** Last-resort boundary: a render bug shows what broke and a reload, never a blank page. */
export class Crash extends Component<{ children: ReactNode }, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: unknown): State {
    return { error };
  }

  override render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="flex h-full items-center justify-center bg-canvas p-6">
        <div className="max-w-md text-sm">
          <h1 className="text-base font-semibold text-ink">The QuantaFlow UI hit a bug</h1>
          <p className="mt-2 text-ink-muted">
            Your agents keep running in the daemon. Reloading the page reconnects to them.
          </p>
          <pre className="mt-3 overflow-x-auto rounded-md bg-sunken p-3 font-mono text-xs text-stop">
            {errorMessage(this.state.error)}
          </pre>
          <button
            type="button"
            onClick={() => location.reload()}
            className="mt-4 rounded-md bg-ink px-3 py-1.5 font-semibold text-canvas"
          >
            Reload
          </button>
        </div>
      </div>
    );
  }
}
