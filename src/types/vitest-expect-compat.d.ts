import "@vitest/expect";

declare module "@vitest/expect" {
  export interface ExpectPollOptions {
    interval?: number;
    timeout?: number;
    message?: string;
  }
}
