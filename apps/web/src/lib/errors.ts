import { QfApiError } from "@quantaflow/core";

/** A sentence a person can act on, from whatever a request threw. */
export function errorMessage(error: unknown): string {
  if (error instanceof QfApiError) {
    if (error.status === 409) return error.message;
    if (error.status === 0 || error.status >= 500) {
      return `The daemon could not finish the request: ${error.message}`;
    }
    return error.message;
  }
  if (error instanceof TypeError) return "The daemon is not reachable. Check that it is running.";
  if (error instanceof Error) return error.message;
  return "Something went wrong.";
}
